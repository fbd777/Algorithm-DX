import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../src/db/database.ts';
import { prepareDatabaseForStartup } from '../src/db/startup.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALGORITHM_DX_')));
const silent = () => {};

function fixture(version: number) {
  const dir = mkdtempSync(join(tmpdir(), 'dx-upgrade-'));
  const path = join(dir, "练习 user's.sqlite");
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.exec(readFileSync(join(root, 'src/db/schema.sql'), 'utf8'));
  const migrations = readdirSync(join(root, 'src/db/migrations')).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of migrations) {
    if (Number(name.slice(0, 3)) <= version) db.exec(readFileSync(join(root, 'src/db/migrations', name), 'utf8'));
  }
  db.exec(`INSERT INTO users(id,name,is_self) VALUES(1,'旧用户',1);
    INSERT INTO accounts(id,user_id,platform,handle,handle_key) VALUES(1,1,'codeforces','fixture','fixture');
    INSERT INTO submissions(account_id,platform,submission_id,problem_id,problem_title,status,submitted_at)
      VALUES(1,'codeforces','123','4:A','Old problem','AC',1700000700);
    INSERT INTO problem_times(user_id,platform,problem_id,seconds,created_at,updated_at)
      VALUES(1,'codeforces','4:A',700,1700000000,1700000700);`);
  if (version >= 10) {
    db.exec(`INSERT INTO practice_attempts(id,user_id,platform,problem_id,seconds,outcome,practice_kind,timing_source,attempted_at,recorded_at,request_id)
      VALUES(101,1,'codeforces','4:A',700,'ac','first','manual',1700000700,1700000700,'old-time-1'),
      (102,1,'codeforces','1:A',86400,'unfinished','unknown','legacy',NULL,1700000800,'old-time-2');`);
  }
  if (version >= 17) {
    db.exec(`INSERT INTO practice_timers(id,user_id,account_id,handle_key,problem_id,practice_kind,started_at,ended_at,status,attempt_id,submission_id,settlement_json)
      VALUES('old-timer',1,1,'fixture','4:A','first',1700000000,1700000700,'completed',101,'123','{"seconds":700}');
      INSERT INTO archived_problem_times(account_id,platform,problem_id,seconds,created_at,updated_at)
      VALUES(1,'codeforces','3:A',1200,1700000000,1700000700);`);
  }
  if (version >= 18) {
    db.exec(`INSERT INTO dan_sessions(id,user_id,tier,kind,stage_count,limit_seconds,min_rating,max_rating,status,started_at)
      VALUES('old-run',1,'beginner','challenge',4,3600,800,1100,'cleared',1700000000);
      INSERT INTO dan_stages(id,session_id,stage_index,problem_id,difficulty,drawn_at,timer_id,outcome,seconds)
      VALUES(1,'old-run',1,'4:A',800,1700000000,'old-timer','cleared',700);`);
  }
  return { dir, path, db };
}

function snapshot(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return tables.map(({ name }) => ({
    name: String(name),
    columns: db.prepare(`PRAGMA table_info("${name}")`).all().map(row => String(row.name)),
    rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  }));
}

function assertPreserved(db: DatabaseSync, before: ReturnType<typeof snapshot>) {
  for (const { name, columns, rows } of before) {
    assert.deepEqual(db.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM "${name}" ORDER BY rowid`).all(), rows, name);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
}

function backups(dir: string) {
  const folder = join(dir, 'backups');
  return existsSync(folder) ? readdirSync(folder).map(name => join(folder, name)) : [];
}

for (const version of [5, 9, 17, 20, 21]) {
  test(`startup upgrades v${version}, preserves old records and snapshots committed WAL data`, () => {
    const f = fixture(version);
    try {
      const before = snapshot(f.db);
      assert.ok(existsSync(f.path + '-wal'), 'keep the original connection open so the snapshot must include WAL');
      prepareDatabaseForStartup(f.path, silent);
      assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
      assertPreserved(f.db, before);
      if (version < 10) {
        const attempt = f.db.prepare('SELECT * FROM practice_attempts').get()!;
        assert.equal(attempt.seconds, 700);
        assert.equal(attempt.timing_source, 'legacy');
        assert.equal(attempt.attempted_at, null);
      } else {
        assert.equal(f.db.prepare('SELECT attempt_id FROM practice_timers').get()!.attempt_id, 101);
      }
      const saved = backups(f.dir);
      assert.equal(saved.length, 1);
      const backup = new DatabaseSync(saved[0], { readOnly: true });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, version);
        assertPreserved(backup, before);
      } finally { backup.close(); }
      prepareDatabaseForStartup(f.path, silent);
      assert.deepEqual(backups(f.dir), saved, 'restarting must not create redundant migration backups');
      assertPreserved(f.db, before);
    } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('backup failure prevents migration and preserves the old version and data', () => {
  const f = fixture(17);
  try {
    const before = snapshot(f.db);
    writeFileSync(join(f.dir, 'backups'), 'blocked');
    assert.throws(() => prepareDatabaseForStartup(f.path, silent), /未完成升级前备份，未执行迁移/);
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 17);
    assertPreserved(f.db, before);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a later migration failure rolls back earlier steps and leaves a usable backup', () => {
  const f = fixture(18);
  try {
    // A partially modified legacy schema lets v19 run, then makes v20 fail.
    f.db.exec('ALTER TABLE dan_sessions ADD COLUMN tags_json TEXT');
    const before = snapshot(f.db);
    assert.throws(() => prepareDatabaseForStartup(f.path, silent), /本次迁移未提交/);
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 18);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM pragma_table_info('dan_stages') WHERE name='limit_seconds'").get()!.n, 0);
    assert.deepEqual(snapshot(f.db), before);
    const saved = backups(f.dir);
    assert.equal(saved.length, 1);
    const backup = new DatabaseSync(saved[0], { readOnly: true });
    try { assertPreserved(backup, before); }
    finally { backup.close(); }
  } finally { f.db.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a newer database is rejected without changing the file or creating a backup', () => {
  const f = fixture(17);
  f.db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  f.db.close();
  try {
    const before = readFileSync(f.path);
    assert.throws(() => prepareDatabaseForStartup(f.path, silent), /请使用更新的软件包/);
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(backups(f.dir), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an existing database at the current version is not rewritten or backed up', () => {
  const f = fixture(21);
  f.db.close();
  try {
    prepareDatabaseForStartup(f.path, silent);
    const before = readFileSync(f.path);
    const saved = backups(f.dir);
    prepareDatabaseForStartup(f.path, silent);
    assert.deepEqual(readFileSync(f.path), before);
    assert.deepEqual(backups(f.dir), saved);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('concurrent launchers recheck the version under the write lock and migrate only once', async () => {
  const f = fixture(17);
  f.db.close();
  try {
    const run = async () => {
      const child = spawn(process.execPath, [join(root, 'scripts/start-local.mjs'), '--init-only', '--db', f.path],
        { cwd: f.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', chunk => { log += chunk; });
      child.stderr.on('data', chunk => { log += chunk; });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, log);
    };
    const results = await Promise.allSettled([run(), run()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    assert.equal(backups(f.dir).length, 1);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
      assert.equal(db.prepare('SELECT seconds FROM problem_times').get()!.seconds, 700);
      assert.equal(db.prepare('SELECT attempt_id FROM practice_timers').get()!.attempt_id, 101);
    } finally { db.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('downloaded ZIP launcher resolves .env from its own directory and migrates before serving', async () => {
  const f = fixture(17);
  const before = snapshot(f.db);
  f.db.close();
  try {
    const project = join(f.dir, '新版 project');
    mkdirSync(join(project, 'scripts'), { recursive: true });
    cpSync(join(root, 'src'), join(project, 'src'), { recursive: true });
    cpSync(join(root, 'public'), join(project, 'public'), { recursive: true });
    cpSync(join(root, 'extensions'), join(project, 'extensions'), { recursive: true });
    cpSync(join(root, 'package.json'), join(project, 'package.json'));
    cpSync(join(root, 'scripts/start-local.mjs'), join(project, 'scripts/start-local.mjs'));
    const dataDir = join(project, 'local data');
    mkdirSync(dataDir);
    const path = join(dataDir, 'practice.sqlite');
    cpSync(f.path, path);
    writeFileSync(join(project, '.env'), 'ALGORITHM_DX_DB_PATH="local data/practice.sqlite"\n');
    await assertServerStarts(join(project, 'scripts/start-local.mjs'), f.dir, []);
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION); assertPreserved(db, before); }
    finally { db.close(); }
    assert.equal(backups(dataDir).length, 1);
    assert.equal(existsSync(join(project, 'data/algorithm-dx.sqlite')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('direct dashboard entry also upgrades before serving', async () => {
  const f = fixture(17);
  f.db.close();
  try {
    await assertServerStarts(join(root, 'src/server/server.ts'), f.dir, ['--db', f.path]);
    assert.equal(backups(f.dir).length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('launcher exits before serving when backup fails or the database is too new', () => {
  const f = fixture(17);
  f.db.close();
  try {
    writeFileSync(join(f.dir, 'backups'), 'blocked');
    const args = [join(root, 'scripts/start-local.mjs'), '--db', f.path];
    const failed = spawnSync(process.execPath, args, { cwd: f.dir, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /已停止启动/);
    assert.doesNotMatch(failed.stdout, /http:\/\/127/);
    const db = new DatabaseSync(f.path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 17);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
    } finally { db.close(); }
    const newer = spawnSync(process.execPath, args, { cwd: f.dir, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(newer.status, 1, newer.stderr);
    assert.match(newer.stderr, /请使用更新的软件包/);
    assert.doesNotMatch(newer.stdout, /http:\/\/127/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

async function assertServerStarts(entry: string, cwd: string, args: string[]) {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, [entry, ...args, '--port', String(port)],
    { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch { /* wait for the local server */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, log);
    assert.match(log, /数据库已升级/);
  } finally { child.kill(); await exited; }
}
