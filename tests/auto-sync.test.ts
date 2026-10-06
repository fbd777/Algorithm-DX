import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncController } from '../public/auto-sync.js';
import { SyncJobRunner } from '../src/server/sync-job.ts';

function fixture() {
  let status = { revision: 'a', job: null as any };
  let posts = 0, refreshes = 0;
  const messages: string[] = [];
  const check = createSyncController({
    request: async (_path: string, options?: any) => {
      if (options?.method === 'POST') { ++posts; status.job = { running: true }; }
      return { ...status };
    },
    refresh: async () => { ++refreshes; },
    notice: (text: string) => messages.push(text),
  });
  return { check, messages, get posts() { return posts; }, get refreshes() { return refreshes; },
    status: (revision: string, job: any) => { status = { revision, job }; } };
}

test('page starts once; completion refreshes once without triggering another sync', async () => {
  const f = fixture(); await f.check(true); assert.equal(f.posts, 1);
  await f.check(); assert.equal(f.refreshes, 1);
  f.status('b', { running: false, results: [] });
  await f.check(); await f.check();
  assert.equal(f.refreshes, 2); assert.equal(f.posts, 1);
});

test('navigation follows existing job instead of creating another', async () => {
  const f = fixture(); f.status('a', { running: true });
  await f.check(true); assert.equal(f.posts, 0);
  f.status('b', { running: false, results: [{ status: 'failed' }] });
  await f.check(); assert.equal(f.refreshes, 2);
  assert.match(f.messages.at(-1)!, /部分平台/);
});

test('idle tabs see completion even when next job is already running', async () => {
  const f = fixture(); await f.check();
  f.status('b', { running: true }); await f.check();
  assert.equal(f.refreshes, 2); assert.equal(f.posts, 0);
});

test('lost POST response does not repeatedly start new jobs', async () => {
  let posts = 0;
  const check = createSyncController({ request: async (_: string, options?: any) => {
    if (options) { ++posts; throw Error('offline'); }
    return { revision: 'a', job: null };
  }, refresh: async () => {} });
  await check(true); await check(); await check(); assert.equal(posts, 1);
});

test('failed refresh retries same revision without losing the update', async () => {
  let attempts = 0;
  const check = createSyncController({ request: async () => ({ revision: 'a', job: null }),
    refresh: async () => { if (++attempts === 1) throw Error('offline'); } });
  await check(); await check(); await check(); assert.equal(attempts, 2);
});

test('overlapping page checks are serialized', async () => {
  const f = fixture(); await Promise.all([f.check(true), f.check(true), f.check()]);
  assert.equal(f.posts, 1); assert.equal(f.refreshes, 1);
});

test('server revision changes on completion including errors and differs after restart', () => {
  const runner = new SyncJobRunner(() => { throw Error('test failure'); }, 'unused');
  const before = runner.revision();
  const job = runner.start({ accountId: null, mode: 'recent', force: false });
  assert.equal(job.running, false); assert.notEqual(runner.revision(), before);
  const other = new SyncJobRunner(() => { throw Error('unused'); }, 'unused');
  assert.notEqual(other.revision(), runner.revision());
});
