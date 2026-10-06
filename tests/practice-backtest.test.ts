import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, Repository } from '../src/db/database.ts';
import { submission } from '../src/fetchers/common.ts';
import { listPractice, recordPractice, editPractice, voidPractice, type PracticeInput } from '../src/dx/practice.ts';
import { clearProblemTime } from '../src/dx-admin.ts';
import { replaceAccount, unbindAccount } from '../src/account-admin.ts';
import { listDxEntries } from '../src/server/queries.ts';
import { achievementForVersion, aggregateBoards, compareBoards, localBacktestReport, mergeLocalReports } from '../src/dx/backtest.ts';
import { lookupT97 } from '../src/dx/rating.ts';
import { handleApi, WRITE_ROUTES } from '../src/server/api.ts';
import type { DxEntry } from '../src/dx/types.ts';

function fixture() {
  const db = openDatabase(':memory:');
  const repo = new Repository(db);
  const user = repo.createUser('PRIVATE NAME', true);
  const account = repo.addAccount(user, 'codeforces', 'PRIVATE_HANDLE');
  repo.saveSubmissions(account, [
    submission('codeforces', { submission_id: '1', problem_id: '1:A', status: 'AC', submitted_at: 1000, difficulty: 1200 }),
    submission('codeforces', { submission_id: '2', problem_id: '1:B', status: 'WA', submitted_at: 1100, difficulty: 1200 }),
  ]);
  repo.saveProblemReleases('codeforces', [{ contestId: 1, name: 'Private contest', startTime: 500, durationSeconds: 1000 }]);
  const input: PracticeInput = { userId: user, platform: 'codeforces', problemId: '1:A', seconds: 600,
    outcome: 'ac', practiceKind: 'first', timingSource: 'manual', attemptedAt: 1000 };
  const ctx = { db, dbPath: ':memory:', platforms: ['codeforces'], envFile: 'unused', openWrite: () => db, syncJobs: {} as any };
  return { db, repo, user, account, input, ctx };
}

test('history scores each attempt independently and explains unscored records', async () => {
  const { db, user, input, ctx } = fixture();
  try {
    const fast = recordPractice(db, input);
    const slow = recordPractice(db, { ...input, seconds: 1200 });
    recordPractice(db, { ...input, practiceKind: 'assisted' });
    recordPractice(db, { ...input, outcome: 'unfinished' });
    const invalid = recordPractice(db, { ...input, seconds: 300 });
    voidPractice(db, user, invalid.id);
    const result = await handleApi(ctx, { method: 'GET', pathname: '/api/dx/attempts', params: new URLSearchParams({ user: String(user) }) });
    assert.equal(result.status, 200);
    const rows = (result.body as any).rows;
    assert.ok(rows.find((r: any) => r.id === fast.id).score.achievementShown > rows.find((r: any) => r.id === slow.id).score.achievementShown);
    for (const row of rows.filter((r: any) => r.id !== fast.id && r.id !== slow.id)) {
      assert.equal(row.score, null);
      assert.ok(row.scoreReason);
    }
  } finally { db.close(); }
});

test('editing preserves record identity, recomputes best and rejects stale or invalid changes', () => {
  const { db, user, input } = fixture();
  try {
    const first = recordPractice(db, input);
    recordPractice(db, { ...input, seconds: 900 });
    editPractice(db, user, first.id, 0, { ...input, seconds: 1200, attemptedAt: null });
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 900);
    const row = listPractice(db, user).find(r => r.id === first.id)!;
    assert.equal(row.revision, 1); assert.equal(row.attempted_at, null); assert.ok(row.edited_at);
    assert.equal(listPractice(db, user).length, 2);
    assert.throws(() => editPractice(db, user, first.id, 0, input), /已被修改/);
    assert.throws(() => voidPractice(db, user, first.id, 0), /已被修改/);
    assert.throws(() => editPractice(db, user + 1, first.id, 1, input), /不存在/);
    assert.throws(() => editPractice(db, user, first.id, 1, { ...input, seconds: 0 }));
    editPractice(db, user, first.id, 1, { ...input, seconds: 30, outcome: 'unfinished' });
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 900);
    editPractice(db, user, first.id, 2, { ...input, seconds: 30 });
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 30);
    voidPractice(db, user, first.id, 3);
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 900);
    assert.throws(() => editPractice(db, user, first.id, 3, input), /作废/);
  } finally { db.close(); }
});

test('edit API validates changes and marks estimated records as manual corrections', async () => {
  const { db, user, input, ctx } = fixture();
  try {
    const first = recordPractice(db, { ...input, seconds: 500, timingSource: 'contest_estimate', practiceKind: 'unknown' });
    assert.ok(WRITE_ROUTES.has('/api/dx/attempts/edit'));
    const body = { userId: user, id: first.id, revision: 0, seconds: 600, outcome: 'ac', practiceKind: 'first', attemptedAt: null };
    const result = await handleApi(ctx, { method: 'POST', pathname: '/api/dx/attempts/edit', params: new URLSearchParams(), body });
    assert.equal(result.status, 200);
    assert.equal(listPractice(db, user)[0].timing_source, 'manual');
    assert.equal(listPractice(db, user)[0].revision, 1);
    const invalid = await handleApi(ctx, { method: 'POST', pathname: '/api/dx/attempts/edit', params: new URLSearchParams(), body: { ...body, revision: 1, outcome: 'invalid' } });
    assert.equal(invalid.status, 400);
    const unchanged = editPractice(db, user, first.id, 1, { ...input, attemptedAt: null });
    assert.equal(unchanged.updated, false);
  } finally { db.close(); }
});

test('v9 migration preserves selected times, marks provenance unknown and does not invent attempt dates', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dx-practice-migration-')), 'test.sqlite');
  const before = new DatabaseSync(file);
  for (const name of ['../src/db/schema.sql', ...['002-sync', '003-account-profile', '004-score', '005-problem-time',
    '006-contest', '007-follow', '008-contest-duration', '009-account-archive'].map(n => `../src/db/migrations/${n}.sql`)])
    before.exec(readFileSync(new URL(name, import.meta.url), 'utf8'));
  before.exec("INSERT INTO users(id,name) VALUES(1,'legacy'); INSERT INTO problem_times(user_id,platform,problem_id,seconds,updated_at) VALUES(1,'codeforces','1:A',700,12345)");
  before.close();
  let db = openDatabase(file);
  try {
    const row = db.prepare('SELECT * FROM practice_attempts').get()!;
    assert.equal(row.seconds, 700); assert.equal(row.timing_source, 'legacy'); assert.equal(row.practice_kind, 'unknown');
    assert.equal(row.attempted_at, null); assert.equal(row.recorded_at, 12345);
    assert.equal(db.prepare('SELECT seconds FROM problem_times').get()!.seconds, 700);
  } finally { db.close(); }
  db = openDatabase(file);
  try { assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_attempts').get()!.n, 1); } finally { db.close(); }
});

test('append preserves slower/failed/assisted attempts, best score excludes assistance, void recomputes and retry is idempotent', () => {
  const { db, user, input } = fixture();
  try {
    const a = recordPractice(db, { ...input, requestId: 'request-001' });
    assert.equal(recordPractice(db, { ...input, requestId: 'request-001' }).id, a.id);
    assert.throws(() => recordPractice(db, { ...input, seconds: 1, requestId: 'request-001' }));
    recordPractice(db, { ...input, seconds: 900, practiceKind: 'repeat' });
    const fast = recordPractice(db, { ...input, seconds: 300, practiceKind: 'repeat' });
    recordPractice(db, { ...input, seconds: 1, practiceKind: 'assisted' });
    recordPractice(db, { ...input, problemId: '1:B', seconds: 1200, outcome: 'unfinished' });
    assert.equal(listPractice(db, user).length, 5);
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 300);
    voidPractice(db, user, fast.id);
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 600);
    const before = listPractice(db, user).length;
    assert.throws(() => recordPractice(db, { ...input, problemId: '1:B' }));
    assert.throws(() => recordPractice(db, { ...input, problemId: 'missing' }));
    assert.throws(() => recordPractice(db, { ...input, seconds: 0 }));
    assert.throws(() => recordPractice(db, { ...input, attemptedAt: Math.floor(Date.now() / 1000) + 86400 }));
    assert.equal(listPractice(db, user).length, before);
    clearProblemTime(db, input);
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, null);
    assert.equal(listPractice(db, user).length, before, 'clear never deletes history');
  } finally { db.close(); }
});

test('contest provenance is server-verified and repeated auto-fill cannot duplicate a contest result', () => {
  const { db, user, input } = fixture();
  try {
    const contest = { ...input, timingSource: 'contest_estimate' as const, practiceKind: 'unknown' as const, seconds: 500, attemptedAt: null };
    const first = recordPractice(db, contest);
    assert.equal(recordPractice(db, contest).id, first.id);
    assert.equal(listPractice(db, user)[0].attempted_at, 1000);
    assert.throws(() => recordPractice(db, { ...contest, seconds: 499 }));
    assert.throws(() => recordPractice(db, { ...contest, practiceKind: 'first' }));
    assert.equal(listPractice(db, user).length, 1);
  } finally { db.close(); }
});

test('replacement isolates attempt history even after the new identity solves the same problem', () => {
  const { db, repo, user, account, input } = fixture();
  try {
    recordPractice(db, input);
    const newAccount = replaceAccount(db, account, 'new-identity').id;
    repo.saveSubmissions(newAccount, [submission('codeforces', { submission_id: 'new', problem_id: '1:A', status: 'AC', submitted_at: 1500, difficulty: 1200 })]);
    assert.equal(listPractice(db, user).length, 0);
    recordPractice(db, { ...input, seconds: 900 });
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 900);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_attempts WHERE archived_at IS NOT NULL').get()!.n, 1);
  } finally { db.close(); }
});

function entry(id: string, release: number, seconds = 100, q: number | null = 1200): DxEntry {
  return { platform: 'codeforces', problemId: id, problemTitle: 'PRIVATE TITLE', problemUrl: 'https://private.invalid',
    problemRating: q, releasedAt: release, solvedAt: release + 1, recordedSeconds: seconds };
}

test('unbind archives orphaned attempts so a future binding cannot inherit them', () => {
  const { db, repo, user, account, input } = fixture();
  try {
    recordPractice(db, input);
    unbindAccount(db, account);
    const next = repo.addAccount(user, 'codeforces', 'next');
    repo.saveSubmissions(next, [submission('codeforces', { submission_id: 'next', problem_id: '1:A', status: 'AC', difficulty: 1200, submitted_at: 2000 })]);
    assert.equal(listPractice(db, user).length, 0);
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, null);
  } finally { db.close(); }
});

test('a second account with only WA cannot preserve the replaced identity’s AC attempts', () => {
  const { db, repo, user, account, input } = fixture();
  try {
    recordPractice(db, input);
    const other = repo.addAccount(user, 'codeforces', 'wa-only');
    repo.saveSubmissions(other, [submission('codeforces', { submission_id: 'wa', problem_id: '1:A', status: 'WA', submitted_at: 1800 })]);
    replaceAccount(db, account, 'new');
    repo.saveSubmissions(other, [submission('codeforces', { submission_id: 'ac', problem_id: '1:A', status: 'AC', difficulty: 1200, submitted_at: 2000 })]);
    recordPractice(db, { ...input, seconds: 900 });
    assert.equal(listPractice(db, user).length, 1);
    assert.equal(listDxEntries(db, user, 'codeforces')[0].recordedSeconds, 900);
  } finally { db.close(); }
});

test('backtest deduplicates by problem, enforces fit/year boundaries, separates incomplete boards and weights people equally', () => {
  const rows = [...Array.from({ length: 36 }, (_, i) => entry(`old:${i}`, 10)), ...Array.from({ length: 16 }, (_, i) => entry(`new:${i}`, 100))];
  const b = compareBoards([...rows, entry('old:0', 10, 1), entry('future', 200), entry('unrated', 10, 100, null), entry('extrapolated', 10, 1, 3000)], 100, 200);
  assert.equal(b.fullBoard, true); assert.equal(b.eligibleProblems, 52); assert.equal(b.oldCount, 35); assert.equal(b.newCount, 15);
  assert.deepEqual(b.excluded, { missingRating: 1, missingTime: 0, outsideFit: 1, futureRelease: 1, duplicate: 1 });
  assert.equal(b.variants[0].shareAt101, 1); assert.equal(b.variants[1].shareAt101, 0);
  assert.equal(b.variants[0].rating, b.variants[1].rating);
  const small = compareBoards([entry('slow', 10, 4000)], 100, 200);
  assert.equal(small.fullBoard, false);
  const aggregate = aggregateBoards([b, small]);
  assert.equal(aggregate.variants[0].meanPlayerShareAt101, 0.5, 'not weighted 50:1 by cards');
  assert.equal(aggregateBoards([compareBoards([], 100, 200)]).variants[0].meanPlayerShareAt101, null);
});

test('backtest keeps historic slow scoring and selects each version’s best problems independently', () => {
  assert.equal(achievementForVersion(2, 1, 'linear-clipped-v1'), 48.5);
  assert.equal(achievementForVersion(2, 1, 'bounded-tail-v2'), 48.5);
  assert.ok(Math.abs(achievementForVersion(2, 1, 'gentle-decay-v3') - 92.38375830159872) < 1e-9);
  // 34 sure winners and two candidates for the last old slot. New scoring promotes the slow 2000.
  const winners = Array.from({ length: 34 }, (_, i) => entry(`winner:${i}`, 10, 1, 2400));
  const fastLow = entry('fast-low', 10, 1, 800);
  const slowHigh = entry('slow-high', 10, 2 * lookupT97(2000).seconds, 2000);
  const result = compareBoards([...winners, fastLow, slowHigh], 100, 200);
  const old = result.variants.find(v => v.version === 'bounded-tail-v2')!;
  const current = result.variants.find(v => v.version === 'gentle-decay-v3')!;
  assert.equal(old.count, 35);
  assert.equal(current.count, 35);
  assert.equal(old.counts[0], 0);
  assert.equal(current.counts[0], 1);
  assert.ok(current.rating > old.rating);
});

test('summary excludes identity and separates undated, assisted and unfinished observations; merger rejects incompatible/malformed input', () => {
  const { db, user, input } = fixture();
  try {
    recordPractice(db, input);
    recordPractice(db, { ...input, attemptedAt: null, practiceKind: 'unknown' });
    recordPractice(db, { ...input, practiceKind: 'assisted', seconds: 1 });
    for (let i = 0; i < 25; i++) recordPractice(db, { ...input, problemId: '1:B', outcome: 'unfinished', seconds: 600 });
    const report = localBacktestReport(listDxEntries(db, user, 'codeforces'), listPractice(db, user), 2026, 100, 2000);
    assert.equal(report.coverage.attempts, 28); assert.equal(report.coverage.unknownAttemptDate, 1);
    assert.equal(report.coverage.outcomes.unfinished, 25);
    assert.equal(report.independentManual.eligibleProblems, 1);
    assert.equal(report.checkpoints.length, 1); assert.equal(report.checkpoints[0].board.eligibleProblems, 1);
    const json = JSON.stringify(report);
    for (const secret of ['PRIVATE NAME', 'PRIVATE_HANDLE', '1:A', '1:B', 'user_id', 'problem_id', 'attempted_at', 'recorded_at']) assert.ok(!json.includes(secret), secret);
    const merged = mergeLocalReports([report, { ...report, malicious: 'PRIVATE NAME' }]);
    assert.equal(merged.reports, 2); assert.ok(!JSON.stringify(merged).includes('PRIVATE NAME'));
    assert.throws(() => mergeLocalReports([report, { ...report, year: 2025 }]));
    const malformed = structuredClone(report); malformed.currentBest.variants[0].counts[0] = 500;
    assert.throws(() => mergeLocalReports([malformed]));
  } finally { db.close(); }
});

test('practice API validates ownership and supports paginated history plus read-only summary', async () => {
  const { db, user, input, ctx } = fixture();
  const call = (method: string, pathname: string, body?: unknown, params = new URLSearchParams({ user: String(user), year: '2026' })) => handleApi(ctx, { method, pathname, body, params });
  try {
    assert.ok(WRITE_ROUTES.has('/api/dx/attempts')); assert.ok(WRITE_ROUTES.has('/api/dx/attempts/void'));
    const first = await call('POST', '/api/dx/attempts', { ...input, requestId: 'api-request-1' });
    assert.equal(first.status, 201);
    assert.equal((await call('POST', '/api/dx/attempts', { ...input, requestId: 'api-request-1' })).status, 200);
    assert.equal((await call('POST', '/api/dx/attempts/void', { userId: user + 99, id: (first.body as any).id })).status, 400);
    const rows = (await call('GET', '/api/dx/attempts')).body as any;
    assert.equal(rows.rows.length, 1); assert.equal(rows.total, 1);
    ctx.openWrite = () => { throw new Error('read route attempted write'); };
    assert.equal((await call('GET', '/api/dx/backtest')).status, 200);
    const attachment = await call('GET', '/api/dx/backtest', undefined, new URLSearchParams({ user: String(user), year: '2026', download: '1' }));
    assert.equal(attachment.downloadName, 'algorithm-dx-backtest-2026.json');
    assert.equal((await call('GET', '/api/dx/backtest', undefined, new URLSearchParams({ user: '999' }))).status, 400);
  } finally { db.close(); }
});
