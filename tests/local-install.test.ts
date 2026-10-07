import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALGORITHM_DX_')));

test('downloaded project starts from another cwd, creates self once and preserves existing database', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dx-install-'));
  try {
    const project = join(temp, '中文 project');
    mkdirSync(join(project, 'scripts'), { recursive: true });
    cpSync(join(root, 'src'), join(project, 'src'), { recursive: true });
    cpSync(join(root, 'public'), join(project, 'public'), { recursive: true });
    cpSync(join(root, 'extensions'), join(project, 'extensions'), { recursive: true });
    cpSync(join(root, 'package.json'), join(project, 'package.json'));
    cpSync(join(root, 'scripts/start-local.mjs'), join(project, 'scripts/start-local.mjs'));
    writeFileSync(join(project, '.env'), 'ALGORITHM_DX_DB_PATH="local data/practice.sqlite"\n');
    const launch = (...args: string[]) => spawnSync(process.execPath, [join(project, 'scripts/start-local.mjs'), ...args], { cwd: temp, env, encoding: 'utf8' });
    const first = launch('--init-only');
    assert.equal(first.status, 0, first.stderr);
    const path = join(project, 'local data/practice.sqlite');
    const db = new DatabaseSync(path);
    assert.deepEqual({ ...db.prepare('SELECT name, is_self FROM users').get() }, { name: '我', is_self: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 0);
    db.exec("UPDATE users SET name = 'My name'");
    db.close();
    const before = readFileSync(path);
    assert.equal(launch('--init-only').status, 0);
    assert.deepEqual(readFileSync(path), before);
    const other = join(temp, 'custom.sqlite');
    assert.equal(launch('--init-only', '--db', other).status, 0);
    assert.ok(readFileSync(other).length > 0);
    assert.notEqual(launch('--init-only', '--port', 'invalid').status, 0);
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const child = spawn(process.execPath, [join(project, 'scripts/start-local.mjs'), '--port', String(port)], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    const exited = once(child, 'exit');
    try {
      let ready = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { ready = true; break; }
        } catch { /* wait for the local listener */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, log);
    } finally { child.kill(); await exited; }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('Windows shortcut points at downloaded directory, supports custom names and refuses collisions', { skip: process.platform !== 'win32' }, () => {
  // CI may expose TEMP through an 8.3 alias; PowerShell expands script paths.
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'dx-shortcut-')));
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  try {
    const desktop = join(temp, '桌面 with spaces');
    mkdirSync(desktop);
    const project = join(temp, '项目 with spaces');
    mkdirSync(join(project, 'scripts'), { recursive: true });
    mkdirSync(join(project, 'public'));
    for (const file of ['dashboard.cmd', 'scripts/create-desktop-shortcut.ps1', 'public/algorithm-dx-mark.ico']) {
      cpSync(join(root, file), join(project, file));
    }
    const run = (name = 'Algorithm DX') => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(project, 'scripts/create-desktop-shortcut.ps1'), '-DesktopDirectory', desktop, '-ShortcutName', name], { encoding: 'utf8', windowsHide: true });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(run().status, 0);
    assert.equal(run('Algorithm DX Test').status, 0);
    assert.equal(run('项目支持').status, 0);
    assert.notEqual(run('../escape').status, 0);
    const shortcut = join(desktop, 'Algorithm DX.lnk');
    // Check the persisted Unicode strings without WScript.Shell's ANSI conversion.
    const bytes = readFileSync(shortcut);
    for (const value of [project, join(project, 'public/algorithm-dx-mark.ico')]) {
      assert.ok(bytes.includes(Buffer.from(value, 'utf16le')), `Shortcut must preserve ${value}`);
    }
    // Construct an unrelated ASCII-path link independently, then put it at the
    // destination to verify collision handling leaves the existing bytes intact.
    const unrelated = join(temp, 'other.lnk');
    const inspect = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `. ${quote(join(project, 'scripts/create-desktop-shortcut.ps1'))} -DesktopDirectory ${quote(desktop)}; $saved = [AlgorithmDXShortcut]::Read(${quote(shortcut)}); if ($saved[0] -ne ${quote(join(project, 'dashboard.cmd'))} -or $saved[1] -ne ${quote(project)} -or $saved[2] -ne '') { exit 1 }; $s = New-Object -ComObject WScript.Shell; $l = $s.CreateShortcut(${quote(unrelated)}); $l.TargetPath = ${quote(join(temp, 'other.cmd'))}; $l.Save()`], { encoding: 'utf8', windowsHide: true });
    assert.equal(inspect.status, 0, inspect.stderr);
    cpSync(unrelated, shortcut);
    const before = readFileSync(shortcut);
    assert.notEqual(run().status, 0);
    assert.deepEqual(readFileSync(shortcut), before);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
