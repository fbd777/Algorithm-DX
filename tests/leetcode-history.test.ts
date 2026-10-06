import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { HttpClient } from '../src/fetchers/http.ts';
import { LeetCodeFetcher } from '../src/fetchers/leetcode.ts';
import { createFactory, missingPrerequisite } from '../src/fetchers/registry.ts';
import { SyncService } from '../src/sync/service.ts';
import { redactSecrets } from '../src/credentials.ts';
import { handleApi } from '../src/server/api.ts';

const cookie = 'LEETCODE_SESSION=test-secret; csrftoken=test-csrf';
const question = (slug: string) => ({ titleSlug: slug, title: slug, translatedTitle: '' });
const row = (id: number, statusDisplay = 'Wrong Answer') => ({ id, statusDisplay, timestamp: 1700000000 + id, lang: 'cpp' });

test('China history resumes discovery and per-question pagination, keeps failed attempts and deduplicates in SQLite', async () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), user = repo.createUser('me', true), id = repo.addAccount(user, 'leetcode-cn', 'tester');
    const requests: any[] = [];
    const http = new HttpClient(db, async (url, init) => {
      assert.equal(String(url), 'https://leetcode.cn/graphql/');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('cookie'), cookie); assert.equal(headers.get('x-csrftoken'), 'test-csrf');
      const { query, variables: v } = JSON.parse(String(init?.body));
      assert.ok(!/\bcode\b|submissionDetail/.test(query));
      if (query.includes('userStatus')) return Response.json({ data: { userStatus: { isSignedIn: true, userSlug: 'tester' } } });
      requests.push(v);
      if (v.filters) return Response.json({ data: { userProgressQuestionList: {
        totalNum: v.filters.questionStatus === 'SOLVED' ? 2 : 1,
        questions: v.filters.questionStatus === 'SOLVED' ? [question(v.filters.skip ? 'second' : 'first')] : [question('failed-only')],
      } } });
      assert.equal(v.status, undefined); assert.equal(v.lang, undefined);
      if (v.questionSlug === 'first') {
        if (v.offset === 0) return Response.json({ data: { submissionList: { hasNext: true, lastKey: 'next-page', submissions: [row(3, 'Accepted')] } } });
        assert.equal(v.lastKey, 'next-page');
        return Response.json({ data: { submissionList: { hasNext: false, lastKey: null, submissions: [row(3, 'Accepted'), row(2)] } } });
      }
      return Response.json({ data: { submissionList: { hasNext: false, lastKey: null, submissions: [row(v.questionSlug === 'second' ? 4 : 1, 'Time Limit Exceeded')] } } });
    }, async () => {});
    const env = { ALGORITHM_DX_COOKIE_LEETCODE_CN: cookie };
    const service = new SyncService(db, createFactory(db, env, http), env);
    for (let i = 0; i < 7; i++) {
      const [result] = await service.sync(id, { mode: 'backfill', maxPages: 1, limit: 1 });
      assert.equal(result.status, 'success', result.message);
      const state = db.prepare('SELECT * FROM sync_state WHERE account_id=?').get(id)!;
      assert.equal(state.history_complete, i === 6 ? 1 : 0);
      assert.equal(state.history_cursor === null, i === 6);
    }
    const saved = db.prepare('SELECT submission_id,status FROM submissions ORDER BY submission_id').all();
    assert.deepEqual(saved.map(s => [s.submission_id, s.status]), [['1', 'TLE'], ['2', 'WA'], ['3', 'AC'], ['4', 'TLE']]);
    assert.equal(requests.length, 7);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM response_cache').get()!.n, 0);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM sync_state').all()).includes('test-secret'));
    // A changed credential cannot reuse an authenticated cached batch.
    const wrong = new HttpClient(db, async () => Response.json({ data: { userStatus: { isSignedIn: true, userSlug: 'other' } } }), async () => {});
    const [failed] = await new SyncService(db, createFactory(db, env, wrong), env).sync(id, { mode: 'backfill', force: true });
    assert.equal(failed.status, 'failed'); assert.match(failed.message, /不一致/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions').get()!.n, 4);
  } finally { db.close(); }
});

test('missing credentials only skip history; public recent synchronization remains available', async () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), id = repo.addAccount(repo.createUser('me', true), 'leetcode-cn', 'tester');
    const account = { id, platform: 'leetcode-cn' };
    assert.equal(missingPrerequisite({}, account), null);
    assert.equal(missingPrerequisite({}, account, 'backfill')?.variable, 'ALGORITHM_DX_COOKIE_LEETCODE_CN');
    const meta = await handleApi({ db, dbPath: ':memory:', envFile: 'missing-leetcode-test.env', platforms: ['leetcode-cn'], openWrite: () => db } as any,
      { method: 'GET', pathname: '/api/meta', params: new URLSearchParams() });
    assert.equal((meta.body as any).accounts[0].prerequisite, null);
    assert.equal((meta.body as any).accounts[0].historyPrerequisite.variable, 'ALGORITHM_DX_COOKIE_LEETCODE_CN');
    const [result] = await new SyncService(db, () => { throw Error('must not fetch'); }, {}).sync(id, { mode: 'backfill' });
    assert.equal(result.status, 'skipped');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get()!.n, 0);
  } finally { db.close(); }
});

test('history rejects expired and mismatched identities before reading submissions', async () => {
  const db = openDatabase(':memory:');
  try {
    for (const identity of [{ isSignedIn: false }, { isSignedIn: true, userSlug: 'other' }]) {
      let calls = 0;
      const http = new HttpClient(db, async () => { calls++; return Response.json({ data: { userStatus: identity } }); }, async () => {});
      await assert.rejects(new LeetCodeFetcher(http, true, cookie).fetch_batch('tester', { mode: 'backfill' }), /登录已失效|不一致/);
      assert.equal(calls, 1);
    }
  } finally { db.close(); }
});

test('malformed, stalled or rejected pages never advance the persisted cursor', async () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), id = repo.addAccount(repo.createUser('me', true), 'leetcode-cn', 'tester');
    const cursor = JSON.stringify({ version: 1, handle: 'tester', phase: 2, skip: 0, questions: [{ slug: 'first', title: 'First' }], index: 0, offset: 1, lastKey: 'x', previousIds: ['1'] });
    db.prepare('INSERT INTO sync_state(account_id,history_cursor) VALUES (?,?)').run(id, cursor);
    for (const page of [
      { data: { submissionList: { hasNext: true, submissions: [] } } },
      { data: { submissionList: { hasNext: true, submissions: [row(1)] } } },
      { errors: [{ message: 'private error' }] },
    ]) {
      const http = new HttpClient(db, async (_url, init) => Response.json(String(init?.body).includes('userStatus') ? { data: { userStatus: { isSignedIn: true, userSlug: 'tester' } } } : page), async () => {});
      const env = { ALGORITHM_DX_COOKIE_LEETCODE_CN: cookie };
      const [result] = await new SyncService(db, createFactory(db, env, http), env).sync(id, { mode: 'backfill' });
      assert.equal(result.status, 'failed');
      const state = db.prepare('SELECT * FROM sync_state WHERE account_id=?').get(id)!;
      assert.equal(state.history_cursor, cursor); assert.equal(state.history_complete, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions').get()!.n, 0);
    }
    const http = new HttpClient(db, async () => { throw Error('must not fetch'); }, async () => {});
    await assert.rejects(new LeetCodeFetcher(http, true, cookie).fetch_batch('tester', { mode: 'backfill', cursor: 'bad' }), /游标无效/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new LeetCodeFetcher(http, true, cookie).fetch_batch('tester', { mode: 'backfill', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(redactSecrets('LEETCODE_SESSION=secret; csrftoken=csrf; cf_clearance=clear'), 'LEETCODE_SESSION=[redacted]; csrftoken=[redacted]; cf_clearance=[redacted]');
  } finally { db.close(); }
});
