import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase, Repository } from '../src/db/database.ts';
import { parseDashboardArgs } from '../src/server/options.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

test('dashboard config validates environment and permits CLI overrides and spaced paths', () => {
  assert.deepEqual(parseDashboardArgs([], { ALGORITHM_DX_DB_PATH: 'my data/test.sqlite', ALGORITHM_DX_DASHBOARD_PORT: '8900' }),
    { dbPath: 'my data/test.sqlite', port: 8900, open: false });
  assert.deepEqual(parseDashboardArgs(['--port', '9000', '--db', 'other data/db.sqlite', '--open'], { ALGORITHM_DX_DASHBOARD_PORT: 'bad' }),
    { dbPath: 'other data/db.sqlite', port: 9000, open: true });
  for (const port of ['NaN', '0', '-1', '65536', '1.5']) assert.throws(() => parseDashboardArgs([], { ALGORITHM_DX_DASHBOARD_PORT: port }));
  assert.throws(() => parseDashboardArgs(['--db'], {}));
  assert.throws(() => parseDashboardArgs(['--port'], {}));
});

test('diagnostics work outside checkout with self ID other than 1 and never mutate database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dx portability '));
  try {
    const path = join(dir, 'custom database.sqlite');
    const db = openDatabase(path);
    const repo = new Repository(db);
    repo.createUser('other');
    const self = repo.createUser('self', true);
    assert.notEqual(self, 1);
    db.close();
    writeFileSync(join(dir, '.env'), 'ALGORITHM_DX_DB_PATH="custom database.sqlite"\n');
    const before = readFileSync(path);
    const env = { ...process.env };
    delete env.ALGORITHM_DX_DB_PATH;
    const probeUrl = pathToFileURL(join(root, 'scripts/probe-context.mjs')).href;
    const selected = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { openProbe } from ${JSON.stringify(probeUrl)};
       import assert from 'node:assert/strict';
       const { db, userId } = openProbe([]);
       assert.equal(userId, ${self});
       assert.throws(() => db.exec("UPDATE users SET name = 'changed'"), /readonly/);
       db.close();`], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(selected.status, 0, selected.stderr);
    for (const script of ['probe-contest-auto-time.mjs', 'probe-contest-window-debug.mjs', 'probe-duration-coverage.mjs', 'smoke-contest-auto.mjs']) {
      const result = spawnSync(process.execPath, [join(root, 'scripts', script)], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const explicit = spawnSync(process.execPath, [join(root, 'scripts/probe-duration-coverage.mjs'), '--db', path, '--user', '1'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(explicit.status, 0, explicit.stderr);
    for (const script of ['cf-request-benchmark.ts', 'benchmark-timer-ui.ts']) {
      const result = spawnSync(process.execPath, [join(root, 'scripts', script)], { cwd: dir, env, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /所选用户没有/);
    }
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixture refuses to overwrite a custom database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dx fixture '));
  try {
    const path = join(dir, 'existing.sqlite');
    writeFileSync(path, 'keep my data');
    const result = spawnSync(process.execPath, [join(root, 'scripts/dashboard-fixture.ts'), '--db', path], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(path, 'utf8'), 'keep my data');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
