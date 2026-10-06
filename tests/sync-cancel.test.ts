import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { SyncJobRunner } from '../src/server/sync-job.ts';
import { SyncService } from '../src/sync/service.ts';
import { HttpClient } from '../src/fetchers/http.ts';
import { BaseFetcher } from '../src/fetchers/base.ts';
import { openDatabase, Repository } from '../src/db/database.ts';
import { createSyncController } from '../public/auto-sync.js';
import { WRITE_ROUTES } from '../src/server/api.ts';
import { LuoguFetcher } from '../src/fetchers/luogu.ts';

test('backfill aborts recent work and waits for cleanup; stale cancel cannot stop replacement', async t => {
  const db = openDatabase(':memory:');
  const events: string[] = [];
  t.mock.method(SyncService.prototype, 'sync', async (_id, options) => {
    events.push(options.mode);
    await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    await setImmediate();
    events.push('released');
    options.signal.throwIfAborted();
  });
  try {
    const runner = new SyncJobRunner(() => db, 'unused');
    const recent = runner.start({ accountId: null, mode: 'recent', force: false });
    const backfill = runner.start({ accountId: null, mode: 'backfill', force: false });
    assert.deepEqual(events, ['recent']);
    runner.cancel(recent.id);
    assert.equal(backfill.cancelling, undefined);
    await setImmediate(); await setImmediate();
    assert.deepEqual(events, ['recent', 'released', 'backfill']);
    assert.equal(recent.cancelled, true);
    assert.throws(() => runner.start({ accountId: null, mode: 'recent', force: false }), /ALREADY_RUNNING/);
    runner.cancel(backfill.id);
    await setImmediate(); await setImmediate();
    assert.equal(backfill.cancelled, true);
    assert.throws(() => runner.start({ accountId: null, mode: 'recent', force: false, automatic: true }), /AUTO_COOLDOWN/);
    assert.ok(WRITE_ROUTES.has('/api/sync/cancel'));
  } finally { db.close(); }
});

test('cancel interrupts HTTP without retry and releases sync lease without recording a failure', async () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare("INSERT INTO users(name) VALUES ('test')").run();
    const account = new Repository(db).addAccount(1, 'codeforces', 'tourist');
    const controller = new AbortController();
    let calls = 0, ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const http = new HttpClient(db, async (_url, init) => {
      calls++; ready();
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    }, undefined, controller.signal);
    class Fetcher extends BaseFetcher {
      platform = 'codeforces';
      async fetch_recent_submissions() { await http.text('https://example.test/data'); return []; }
    }
    const task = new SyncService(db, () => new Fetcher()).sync(account, { signal: controller.signal });
    await started; controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT * FROM sync_lock').get(), undefined);
    assert.equal(db.prepare('SELECT status FROM sync_runs').get()!.status, 'interrupted');
    assert.equal(db.prepare('SELECT last_error FROM sync_state').get()!.last_error, null);
  } finally { db.close(); }
});

test('page reload cooldown prevents automatic POST', async () => {
  let posts = 0;
  const check = createSyncController({ request: async (_path, options) => {
    if (options) posts++;
    return { revision: 'a', job: null, nextAutoAt: Date.now() + 60_000 };
  }, refresh: async () => {} });
  await check(true); await check(true);
  assert.equal(posts, 0);
});

test('cancellation also interrupts a reserved rate-limit wait before any request', async () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO request_slots VALUES (?,?)').run('https://example.test', Date.now() + 60_000);
    const controller = new AbortController();
    let calls = 0;
    const http = new HttpClient(db, async () => { calls++; return new Response('ok'); }, undefined, controller.signal);
    const task = http.text('https://example.test/data');
    controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally { db.close(); }
});

test('Luogu recent updates stop after the overlap window but backfill keeps paging', async () => {
  const db = openDatabase(':memory:');
  try {
    let calls = 0;
    const http = new HttpClient(db, async () => {
      calls++;
      return Response.json({ currentData: { records: { count: 200, perPage: 20, result: [{ id: calls, submitTime: 100, status: 12, problem: { pid: 'P1000', name: 'test' } }] } } });
    }, async () => {});
    const fetcher = new LuoguFetcher(http, 'test');
    const recent = await fetcher.fetch_batch('123', { since: 200, maxPages: 3 });
    assert.equal(calls, 1); assert.equal(recent.complete, false);
    assert.equal(recent.submissions.length, 1);
    await fetcher.fetch_batch('123', { mode: 'backfill', since: 200, maxPages: 3 });
    assert.equal(calls, 4);
  } finally { db.close(); }
});
