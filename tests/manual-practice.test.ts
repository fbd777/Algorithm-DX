import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { recordPractice, listPractice, editPractice, voidPractice } from '../src/dx/practice.ts';
import { submission } from '../src/fetchers/common.ts';
import { handleApi } from '../src/server/api.ts';
import { unbindAccount } from '../src/account-admin.ts';
import { getToday } from '../src/server/today.ts';

test('manual records work without accounts, retain optional metadata and support edit/void', async () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), user = repo.createUser('me', true);
    const ctx = { db, dbPath: ':memory:', platforms: ['codeforces'], envFile: 'unused', openWrite: () => db, syncJobs: {} as any };
    const body = { userId: user, platform: '自定义平台', problemId: 'A', seconds: 120,
      outcome: 'ac', practiceKind: 'first', timingSource: 'manual', attemptedAt: null,
      manual: true, title: '自定义题目', difficulty: null, requestId: 'manual-test-001' };
    const post = (value: any) => handleApi(ctx, { method: 'POST', pathname: '/api/dx/attempts', params: new URLSearchParams(), body: value });
    assert.equal((await post(body)).status, 201);
    assert.equal((await post(body)).status, 200);
    assert.equal((await post({ ...body, title: '不同题名' })).status, 400);
    const rows = listPractice(db, user);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].problem_title, '自定义题目');
    assert.equal(rows[0].problem_rating, null);
    editPractice(db, user, rows[0].id, 0, { seconds: 90, outcome: 'ac', practiceKind: 'repeat', attemptedAt: 100 });
    assert.equal(listPractice(db, user)[0].seconds, 90);
    const history = await handleApi(ctx, { method: 'GET', pathname: '/api/dx/attempts', params: new URLSearchParams({ user: String(user) }) });
    assert.equal((history.body as any).rows[0].score, null);
    voidPractice(db, user, rows[0].id, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM problem_times').get()!.n, 0);
    assert.equal((await post({ ...body, requestId: 'manual-test-002', difficulty: -1 })).status, 400);
    assert.equal((await post({ ...body, requestId: 'manual-test-003', userId: repo.createUser('other') })).status, 400);
    assert.equal((await post({ ...body, requestId: 'manual-test-004', difficulty: 1600 })).status, 201);
    assert.equal(listPractice(db, user)[0].problem_rating, 1600);
  } finally { db.close(); }
});

test('existing non-CF submissions can receive time without bypassing AC validation', () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db), user = repo.createUser('me', true);
    const account = repo.addAccount(user, 'atcoder', 'tester');
    repo.saveSubmissions(account, [submission('atcoder', { submission_id: '1', problem_id: 'abc_a', problem_title: 'A', status: 'AC', submitted_at: 100 })]);
    const input = { userId: user, platform: 'atcoder', problemId: 'abc_a', seconds: 65,
      outcome: 'ac' as const, practiceKind: 'unknown' as const, timingSource: 'manual' as const, attemptedAt: 100 };
    recordPractice(db, input);
    assert.equal(listPractice(db, user)[0].seconds, 65);
    const today = getToday(db, { platforms: [], userId: user, scope: 'me', status: 'all', q: null, since: null, until: null, tzOffsetMinutes: 0 }, 200);
    assert.equal(today.cards[0].seconds, 65);
    assert.equal(today.cards[0].score, null);
    assert.throws(() => recordPractice(db, { ...input, problemId: 'missing' }), /同步/);
    assert.throws(() => recordPractice(db, { ...input, timingSource: 'contest_estimate' }), /Codeforces/);
    recordPractice(db, { ...input, seconds: 90, manual: true });
    unbindAccount(db, account);
    assert.equal(listPractice(db, user).length, 1);
    assert.equal(listPractice(db, user)[0].seconds, 90);
    assert.equal(db.prepare('SELECT seconds FROM problem_times WHERE user_id=?').get(user)!.seconds, 90);
  } finally { db.close(); }
});
