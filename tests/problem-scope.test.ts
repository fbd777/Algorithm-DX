/**
 * 题目数量口径与 score 的回归测试。
 *
 * 这一组盯的是两个具体的、真实发生过的口径问题（2026-09-17）：
 * 1. 洛谷的比赛内编号（`T…`）与同名练习编号（`B…`）是同一道题，按 problem_id 聚合会算两遍。
 *    约定：不计入题目数量口径，但提交明细与提交条数照常保留。
 * 2. 洛谷 status=14（未满分）只看状态码无法区分部分分，score 必须存下来。
 *    同时，**平台不给分数时必须留 NULL，不能用 0 冒充零分**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import {
  DEFAULT_TZ_OFFSET_MINUTES,
  getMeta,
  getStats,
  listProblemSubmissions,
  listProblems,
  type Filters,
} from '../src/server/queries.ts';
import { submission } from '../src/fetchers/common.ts';
import { platforms } from '../src/fetchers/registry.ts';

const filters: Filters = {
  platforms: [],
  userId: null,
  // 关注标记生效后，没写 scope 会让 SQL 里拼进 undefined。这里显式走「我 + 关注的人」。
  scope: 'all',
  status: 'all',
  q: null,
  since: null,
  until: null,
  tzOffsetMinutes: DEFAULT_TZ_OFFSET_MINUTES,
};

/** 同一道语言月赛题在记录列表里会出现两次：比赛内编号 T… 与练习编号 B…，题名完全相同。 */
const CONTEST_TITLE = '[语言月赛 202604] 古希腊掌管节奏的神 II';

function seed() {
  const db = openDatabase(':memory:');
  const repo = new Repository(db);
  const user = repo.createUser('Ryan', true);
  const luogu = repo.addAccount(user, 'luogu', '1000001');
  repo.saveSubmissions(luogu, [
    submission('luogu', { submission_id: '1', problem_id: 'T752681', problem_title: CONTEST_TITLE, status: 'AC', raw_status: '12', score: 100, submitted_at: 1000 }),
    submission('luogu', { submission_id: '2', problem_id: 'B4521', problem_title: CONTEST_TITLE, status: 'AC', raw_status: '12', score: 100, submitted_at: 2000 }),
    submission('luogu', { submission_id: '3', problem_id: 'P1028', problem_title: '数的计算', status: 'OTHER', raw_status: '14', score: 25, submitted_at: 3000 }),
    submission('luogu', { submission_id: '4', problem_id: 'P2089', problem_title: '烤鸡', status: 'AC', raw_status: '12', score: 100, submitted_at: 4000 }),
  ]);
  const cf = repo.addAccount(user, 'codeforces', 'T_Ryan');
  // Codeforces 不提供分数：score 必须留 NULL，不能被填成 0。
  repo.saveSubmissions(cf, [
    submission('codeforces', { submission_id: '100', problem_id: '4:A', problem_title: 'Watermelon', status: 'AC', submitted_at: 5000 }),
  ]);
  return db;
}

test('contest-scoped Luogu ids stay in the feed but out of every problem count', () => {
  const db = seed();
  try {
    const stats = getStats(db, filters);
    // 提交条数一条不少：那次比赛提交确实发生过。
    assert.equal(stats.submissions, 5);
    // 但题目数量口径里没有 T752681 —— attempted 是 B4521 / P1028 / P2089 / 4:A。
    assert.equal(stats.attempted, 4);
    assert.equal(stats.solved, 3);
    assert.deepEqual(stats.contest_only, { submissions: 1, problems: 1, solved: 1 });
    // P1028 拿了 25 分但没 AC，必须能被认出来 —— 这正是加 score 的原因。
    assert.equal(stats.partial_credit, 1);

    const luoguStat = stats.by_platform.find((p) => p.platform === 'luogu')!;
    assert.equal(luoguStat.submissions, 4, 'per-platform submissions must still include the contest one');
    assert.equal(luoguStat.attempted, 3);
    assert.equal(luoguStat.solved, 2);

    const page = listProblems(db, filters, 50, 0);
    // 动态（题目卡片）里两个编号都在：Ryan 要求「可以在动态显示」。
    assert.equal(page.total, 5);
    const contestCard = page.items.find((i) => i.problem_id === 'T752681')!;
    const practiceCard = page.items.find((i) => i.problem_id === 'B4521')!;
    assert.equal(contestCard.contest_scoped, true);
    assert.equal(practiceCard.contest_scoped, false);
    // 两个编号各自成卡、互不合并 —— 合并是 Ryan 明确不要的做法。
    assert.equal(contestCard.problem_title, practiceCard.problem_title);

    const meta = getMeta(db, ':memory:', platforms);
    const luoguAccount = meta.accounts.find((a) => a.platform === 'luogu')!;
    assert.equal(luoguAccount.stored_submissions, 4);
    assert.equal(luoguAccount.stored_solved, 2);
    assert.equal(luoguAccount.stored_contest_problems, 1);
    assert.equal(meta.problems.attempted, 4);
    assert.equal(meta.problems.solved, 3);
  } finally {
    db.close();
  }
});

test('取消关注的人不进主视图，但数据一条不少；点名他时仍然看得到', () => {
  const db = seed();
  try {
    const repo = new Repository(db);
    // 建了但**不关注**的人：这正是「关注」这层标记存在的理由 ——
    // 想临时不看某人，切标记就行，不必删掉他（删会连带删掉他所有提交）。
    const stranger = repo.createUser('路人', false, false);
    const account = repo.addAccount(stranger, 'codeforces', 'nobody');
    repo.saveSubmissions(account, [
      submission('codeforces', { submission_id: '900', problem_id: '1:A', problem_title: 'Theatre Square', status: 'AC', submitted_at: 6000 }),
    ]);

    // seed 里 Ryan 本人有 5 条；路人那一条不该混进来。
    assert.equal(getStats(db, { ...filters, scope: 'all' }).submissions, 5);
    assert.equal(getStats(db, { ...filters, scope: 'me' }).submissions, 5);
    // 但数据**没有被删** —— 「不关注」只影响可见性，不影响存储。
    assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions').get()!.n, 6);
    // 点名他的时候仍然看得到：范围档是「默认看谁」，不是硬过滤。
    assert.equal(getStats(db, { ...filters, userId: stranger }).submissions, 1);
    // 总览数字跟着范围走，否则会出现「列表里没有、总数却算进去了」。
    assert.equal(getMeta(db, ':memory:', platforms, 'all').problems.attempted, 4);
  } finally {
    db.close();
  }
});

test('score round-trips, and a platform that offers no score keeps NULL instead of 0', () => {
  const db = seed();
  try {
    const row = db.prepare('SELECT score FROM submissions WHERE submission_id=?').get('3') as { score: number | null };
    assert.equal(row.score, 25);
    assert.equal((db.prepare('SELECT score FROM submissions WHERE submission_id=?').get('100') as { score: number | null }).score, null);

    const timeline = listProblemSubmissions(db, filters, 'luogu', 'P1028');
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].score, 25);
    assert.equal(timeline[0].raw_status, '14', 'raw status must survive alongside the score');

    const cards = listProblems(db, filters, 50, 0);
    const partial = cards.items.find((i) => i.problem_id === 'P1028')!;
    assert.equal(partial.best_score, 25);
    assert.equal(partial.latest_score, 25);
    const cfCard = cards.items.find((i) => i.platform === 'codeforces')!;
    assert.equal(cfCard.best_score, null, 'a platform without scores must not report 0');

    // upsert 也要带上 score，否则重新同步一次分数就丢了。
    const account = (db.prepare("SELECT id FROM accounts WHERE platform='luogu'").get() as { id: number }).id;
    new Repository(db).saveSubmissions(account, [
      submission('luogu', { submission_id: '3', problem_id: 'P1028', problem_title: '数的计算', status: 'OTHER', raw_status: '14', score: 60, submitted_at: 3000 }),
    ]);
    assert.equal((db.prepare('SELECT score FROM submissions WHERE submission_id=?').get('3') as { score: number | null }).score, 60);
  } finally {
    db.close();
  }
});

test('contest-scoped matching is Luogu-only, so other platforms keep every problem', () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db);
    const user = repo.createUser('Ryan', true);
    // 别的平台也有以 T 开头的题号（例如 AtCoder 的 abc 系列没有，但假设某站有 T1）。
    // 规则里带 platform='luogu' 条件，这里确认它真的没有误伤。
    const atcoder = repo.addAccount(user, 'atcoder', 'T_Ryan');
    repo.saveSubmissions(atcoder, [
      submission('atcoder', { submission_id: '1', problem_id: 'T1', problem_title: 'T 开头的非洛谷题', status: 'AC', submitted_at: 1000 }),
    ]);
    const stats = getStats(db, filters);
    assert.equal(stats.attempted, 1);
    assert.equal(stats.solved, 1);
    assert.equal(stats.contest_only.problems, 0);
  } finally {
    db.close();
  }
});

test('CF 题的最快用时只认比赛窗口内的 AC：practice 不算、时长缺失不算、范围内取最快的人', () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db);
    const me = repo.createUser('Ryan', true);
    const friend = repo.createUser('好友'); // 默认已关注 → scope=all 时在范围内
    const meCf = repo.addAccount(me, 'codeforces', 'T_Ryan');
    const frCf = repo.addAccount(friend, 'codeforces', 'friend_cf');
    repo.saveProblemReleases('codeforces', [
      { contestId: 2263, name: 'Rated Round', startTime: 10_000, durationSeconds: 9_000 },
      { contestId: 2264, name: 'No Duration Round', startTime: 50_000, durationSeconds: null },
    ]);
    // Ryan 开赛 6:55 切掉 2263:A；三天后又用 practice 重做 —— 不能覆盖窗口内的成绩。
    repo.saveSubmissions(meCf, [
      submission('codeforces', { submission_id: 'a1', problem_id: '2263:A', problem_title: 'Fresh A', status: 'AC', submitted_at: 10_415 }),
      submission('codeforces', { submission_id: 'a2', problem_id: '2263:A', problem_title: 'Fresh A', status: 'AC', submitted_at: 10_000 + 3 * 86400 }),
      // 2264 没有时长数据：窗口右端未知，宁可不算也不猜。
      submission('codeforces', { submission_id: 'c1', problem_id: '2264:A', problem_title: 'NoDur A', status: 'AC', submitted_at: 50_600 }),
    ]);
    // 好友窗口内更慢（15 分钟）→ 最快用时还是 Ryan 的 6:55。
    repo.saveSubmissions(frCf, [
      submission('codeforces', { submission_id: 'b1', problem_id: '2263:A', problem_title: 'Fresh A', status: 'AC', submitted_at: 10_900 }),
    ]);

    const page = listProblems(db, { ...filters, scope: 'all' }, 50, 0);
    const a = page.items.find((i) => i.problem_id === '2263:A')!;
    assert.equal(a.fastest_solve_seconds, 415);
    assert.equal(a.fastest_user, 'Ryan');
    const noDur = page.items.find((i) => i.problem_id === '2264:A')!;
    assert.equal(noDur.fastest_solve_seconds, null, 'duration 缺失时不算最快用时');

    // 只看自己时结果一样（范围内只有他）；好友单看时最快变成他的 15 分钟。
    const onlyMe = listProblems(db, { ...filters, scope: 'me' }, 50, 0).items.find((i) => i.problem_id === '2263:A')!;
    assert.equal(onlyMe.fastest_solve_seconds, 415);
    const onlyFriend = listProblems(db, { ...filters, userId: friend }, 50, 0).items.find((i) => i.problem_id === '2263:A')!;
    assert.equal(onlyFriend.fastest_solve_seconds, 900);
    assert.equal(onlyFriend.fastest_user, '好友');
  } finally {
    db.close();
  }
});
