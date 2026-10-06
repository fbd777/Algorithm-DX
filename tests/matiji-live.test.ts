import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { HttpClient } from '../src/fetchers/http.ts';
import { MatijiLiveFetcher, normalizeMatijiLive } from '../src/fetchers/matiji-live.ts';
import { createFactory, credentialPlatforms, platforms, validateAccount } from '../src/fetchers/registry.ts';
import { SyncService } from '../src/sync/service.ts';
import { handleApi, WRITE_ROUTES } from '../src/server/api.ts';
import { resolveMatijiIdentity } from '../src/fetchers/matiji-identity.ts';

test('Matiji accepts login nickname, blank and own URL without guessing other identities', async () => {
  const db = openDatabase(':memory:');
  try {
    let calls = 0;
    const http = new HttpClient(db, async () => {
      calls++;
      return Response.json({ error_no: '0', data: { id: 123, nickname: 'Ryan' } });
    }, async () => {});
    for (const input of ['Ryan', '', 'https://www.matiji.net/exam/personalcenter/homepage'])
      assert.deepEqual(await resolveMatijiIdentity(input, http, 'session=test'), { handle: '123', displayName: 'Ryan' });
    await assert.rejects(resolveMatijiIdentity('SomeoneElse', http, 'session=test'), /不一致.*未绑定/);
    await assert.rejects(resolveMatijiIdentity('Ryan', http), /粘贴一次 Cookie/);
    for (const input of ['456', 'https://www.matiji.net/exam/other-homepage/456'])
      assert.deepEqual(await resolveMatijiIdentity(input, http), { handle: '456', displayName: null });
    await assert.rejects(resolveMatijiIdentity('https://evil.test/exam/other-homepage/456', http, 'session=test'), /码蹄集个人主页/);
    assert.equal(calls, 4);
  } finally { db.close(); }
});

test('binding a Matiji nickname reuses stored login and persists the numeric identity', async t => {
  const db = openDatabase(':memory:');
  const previous = process.env.ALGORITHM_DX_COOKIE_MATIJI;
  process.env.ALGORITHM_DX_COOKIE_MATIJI = 'session=test';
  try {
    const repo = new Repository(db), userId = repo.createUser('self');
    t.mock.method(MatijiLiveFetcher.prototype, 'currentAccount', async function() {
      return { handle: '123', displayName: 'Ryan' };
    });
    const ctx: any = { db, envFile: 'missing-identity-test.env', openWrite: () => db };
    const bind = (handle: string) => handleApi(ctx, { method: 'POST', pathname: '/api/accounts', params: new URLSearchParams(), body: { userId, platform: 'matiji', handle, probe: false } });
    assert.equal((await bind('Wrong')).status, 400);
    assert.equal(db.prepare('SELECT count(*) n FROM accounts').get()!.n, 0);
    const result = await bind('Ryan');
    assert.equal(result.status, 201);
    assert.equal((result.body as any).handle, '123');
    assert.equal(repo.findAccount('matiji', '123')!.display_name, 'Ryan');
    assert.equal((await bind('')).status, 200);
    assert.equal(db.prepare('SELECT count(*) n FROM accounts').get()!.n, 1);
    assert.ok(!JSON.stringify(result).includes('session=test'));
  } finally {
    if (previous === undefined) delete process.env.ALGORITHM_DX_COOKIE_MATIJI;
    else process.env.ALGORITHM_DX_COOKIE_MATIJI = previous;
    db.close();
  }
});

// Constructed from the official UI's consumed fields, not a captured login response.
const row = (id: number, extra = {}) => ({ submissionId: id, userId: '123', problemId: 42,
  ojProblemEntity: { problemName: 'test', ojNumber: 'MT0042' }, submitTime: 1750000000000,
  judgeResult: 'Accepted', ojLanguage: { languageName: 'C++' }, usedTime: 0, usedMemory: 32, ...extra });

test('Matiji identity reads official login identity and only exposes ID and nickname', async () => {
  const db = openDatabase(':memory:');
  try {
    const f = new MatijiLiveFetcher(new HttpClient(db, async (url, init) => {
      assert.equal(String(url), 'https://www.matiji.net/exam-back/api/queryUserInfo.do');
      assert.equal(init!.method, 'POST');
      return Response.json({ error_no: '0', data: { id: '123', nickname: 'Ryan', phone: 'private', token: 'private' } });
    }, async () => {}), 'session=test');
    assert.deepEqual(await f.currentAccount(), { handle: '123', displayName: 'Ryan' });
    const denied = new MatijiLiveFetcher(new HttpClient(db, async () => Response.json({ error_no: '2' }), async () => {}), 'session=old');
    await assert.rejects(denied.currentAccount(), /登录已失效/);
    await assert.rejects(new MatijiLiveFetcher(f.http).currentAccount(), /请先/);
  } finally { db.close(); }
});

test('identity lookup is POST-only, validates credentials and does not bind an account', async t => {
  const db = openDatabase(':memory:');
  try {
    let calls = 0;
    t.mock.method(MatijiLiveFetcher.prototype, 'currentAccount', async function() { calls++; return { handle: '123', displayName: 'Ryan' }; });
    const ctx: any = { db, envFile: 'missing-identity-test.env', openWrite: () => db };
    const pathname = '/api/accounts/matiji/identity';
    assert.ok(WRITE_ROUTES.has(pathname));
    assert.equal((await handleApi(ctx, { method: 'GET', pathname, params: new URLSearchParams() })).status, 404);
    const ok = await handleApi(ctx, { method: 'POST', pathname, params: new URLSearchParams(), body: { cookie: 'session=test' } });
    assert.deepEqual(ok.body, { handle: '123', displayName: 'Ryan' });
    assert.equal((await handleApi(ctx, { method: 'POST', pathname, params: new URLSearchParams(), body: { cookie: 'bad\nvalue' } })).status, 400);
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM accounts').get()!.n, 0);
  } finally { db.close(); }
});

test('Matiji pages by target user with shared Cookie and resumes a frozen date window', async () => {
  const db = openDatabase(':memory:');
  try {
    const requests: URLSearchParams[] = [];
    const http = new HttpClient(db, async (url, init) => {
      assert.match(String(url), /queryOtherUserBrushOjProblemLog/);
      assert.equal(new Headers(init!.headers).get('cookie'), 'session=test');
      const p = new URLSearchParams(String(init!.body)); requests.push(p);
      assert.equal(p.get('userId'), '123');
      const start = Number(p.get('start')), limit = Number(p.get('limit'));
      return Response.json({ error_no: '0', data: { total: 53, datas: Array.from({ length: Math.min(limit, 53-start) }, (_, i) => row(start+i+1)) } });
    }, async () => {});
    const fetcher = new MatijiLiveFetcher(http, 'session=test');
    const first = await fetcher.fetch_batch('123', { mode: 'backfill', maxPages: 1 });
    assert.equal(first.submissions.length, 50); assert.equal(first.complete, false);
    const next = await fetcher.fetch_batch('123', { mode: 'backfill', cursor: first.nextCursor });
    assert.equal(next.submissions.length, 3); assert.equal(next.complete, true); assert.equal(next.nextCursor, null);
    assert.equal(requests[1].get('start'), '50'); assert.equal(requests[0].get('endDate'), requests[1].get('endDate'));
    await assert.rejects(fetcher.fetch_batch('456', { mode: 'backfill', cursor: first.nextCursor }), /格式变化/);
    const recent = await fetcher.fetch_batch('123', { limit: 2 });
    assert.equal(recent.submissions.length, 2); assert.equal(recent.complete, false);
  } finally { db.close(); }
});

test('Matiji rejects login walls, malformed lists, wrong identities and repeated pages', async () => {
  const db = openDatabase(':memory:');
  try {
    for (const [body, code] of [
      [{ error_no: '2', data: 'secret must not leak' }, 'AUTH_REQUIRED'],
      [{ error_no: '7', data: 'secret must not leak' }, 'API_ERROR'],
      [{ error_no: 0, data: { total: 1, datas: [] } }, 'SCHEMA_CHANGED'],
      [{ error_no: 0, data: { total: 1, datas: [row(1, { userId: '456' })] } }, 'ACCOUNT_MISMATCH'],
      [{ error_no: 0, data: { total: 2, datas: [row(1)] } }, 'PAGINATION_STALLED'],
    ] as const) {
      const f = new MatijiLiveFetcher(new HttpClient(db, async () => Response.json(body), async () => {}), 'session=test');
      await assert.rejects(f.fetch_batch('123'), (error: any) => error.code === code && !error.message.includes('secret'));
    }
  } finally { db.close(); }
});

test('Matiji normalization retains zero resource use and rejects invented IDs or invalid dates', () => {
  const normalized = normalizeMatijiLive(row(1), '123');
  assert.equal(normalized.status, 'AC'); assert.equal(normalized.execution_time, 0); assert.equal(normalized.memory, 32768);
  assert.equal(normalized.submitted_at, 1750000000);
  assert.equal(normalizeMatijiLive(row(2, { submitTime: '2025-06-16 08:00:00', judgeResult: 'Time Limit Exceed' }), '123').status, 'TLE');
  assert.throws(() => normalizeMatijiLive(row(1, { submissionId: undefined }), '123'));
  assert.throws(() => normalizeMatijiLive(row(1, { submitTime: null }), '123'));
});

test('Matiji failure cannot commit earlier pages; cancellation is propagated', async () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), user = repo.createUser('test'), id = repo.addAccount(user, 'matiji', '123');
    let calls = 0;
    const http = new HttpClient(db, async () => Response.json(++calls === 1 ? { error_no: 0, data: { total: 51, datas: Array.from({ length: 50 }, (_, i) => row(i+1)) } } : { error_no: 2 }), async () => {});
    const env = { ALGORITHM_DX_COOKIE_MATIJI: 'session=test' };
    const result = await new SyncService(db, createFactory(db, env, http), env).sync(id, { mode: 'backfill' });
    assert.equal(result[0].status, 'failed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions').get()!.n, 0);
    assert.equal(db.prepare('SELECT history_cursor FROM sync_state').get()!.history_cursor, null);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new MatijiLiveFetcher(http, 'session=test').fetch_batch('123', { signal: controller.signal }), { name: 'AbortError' });
  } finally { db.close(); }
});

test('Unsupported platform is unavailable for new binding and old accounts are skipped without fetching', async () => {
  assert.ok(!(platforms as readonly string[]).includes('retired-test-platform'));
  assert.deepEqual(credentialPlatforms, ['luogu', 'matiji', 'leetcode-cn']);
  assert.throws(() => validateAccount('retired-test-platform', '123'));
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), user = repo.createUser('test'), id = repo.addAccount(user, 'retired-test-platform', '123');
    const result = await new SyncService(db, () => { throw Error('must not fetch'); }, {}).sync(id);
    assert.equal(result[0].status, 'skipped'); assert.match(result[0].message, /已停止支持/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get()!.n, 0);
  } finally { db.close(); }
});
