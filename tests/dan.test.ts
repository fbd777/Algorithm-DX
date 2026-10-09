import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { submission } from '../src/fetchers/common.ts';
import { reconcileTimers, startTimer } from '../src/dx/timer.ts';
import { listPractice } from '../src/dx/practice.ts';
import { scoreProblem } from '../src/dx/rating.ts';
import { listDxEntries } from '../src/server/queries.ts';
import { handleApi, WRITE_ROUTES } from '../src/server/api.ts';
import { PROBLEM_RATINGS_CACHE_KEY } from '../src/fetchers/codeforces-sync.ts';
import {
  DAILY_TIER,
  DAN_RANDOM_TIERS,
  DAN_SESSION_TTL_SECONDS,
  DAN_STAGES,
  DAN_TIERS,
  DanError,
  abandonDanSession,
  activeDanSession,
  advanceDanSessions,
  claimDanStage,
  claimableDanStage,
  createDanSession,
  danDateKey,
  danExcludedProblems,
  danHistory,
  danLimitForRating,
  danProblemId,
  danSessionView,
  danTier,
  dailyDanCandidate,
  drawDanCandidate,
  drawNextDanStage,
  selectableDanTier,
} from '../src/dx/dan.ts';

function setup() {
  const db = openDatabase(':memory:'), repo = new Repository(db);
  const user = repo.createUser('我', true), account = repo.addAccount(user, 'codeforces', 'fixture');
  return { db, repo, user, account };
}

/** `count` 道同 rating 的题，contestId 从 `from` 起递增。 */
function at(rating: number, count: number, from: number) {
  return Array.from({ length: count }, (_, i) => ({ contestId: from + i, index: 'A', rating }));
}

const ANY: ReadonlySet<string> = new Set();

/** 按下发口径取视图：不限 active，结算之后也能看（结算完成时 activeDanSession 会返回 null）。 */
function viewOf(s: ReturnType<typeof setup>, sessionId: string) {
  const row = s.db.prepare('SELECT * FROM dan_sessions WHERE id=?').get(sessionId) as Parameters<typeof danSessionView>[1];
  return danSessionView(s.db, row);
}

/** 起计时器 + 锁题（不 AC）：模拟「点了开始做题，但还没做出来」。 */
function beginStage(s: ReturnType<typeof setup>, sessionId: string, now: number, timerId: string) {
  const stage = claimableDanStage(s.db, sessionId)!;
  startTimer(s.db, { userId: s.user, problemId: stage.problem_id, practiceKind: 'unknown', requestId: timerId }, now);
  claimDanStage(s.db, { sessionId, timerId, now });
  return stage;
}

/** 走完一道：起计时器 → 锁题 → 在 CF 上 AC → 同步结算。 */
function playStage(s: ReturnType<typeof setup>, sessionId: string, now: number, seconds: number, seq: string) {
  const stage = beginStage(s, sessionId, now, `dan-timer-${seq}`);
  s.repo.saveSubmissions(s.account, [submission('codeforces', {
    submission_id: `dan-sub-${seq}`, problem_id: stage.problem_id, problem_title: '段位認定',
    status: 'AC', submitted_at: now + seconds, difficulty: stage.difficulty,
  })]);
  reconcileTimers(s.db, s.account, now + seconds);
  return stage;
}

test('四个档位区间互不重叠、覆盖 800-2600，且单题限时随难度递增', () => {
  const sorted = [...DAN_TIERS].sort((a, b) => a.minRating - b.minRating);
  assert.equal(sorted[0].minRating, 800);
  assert.equal(sorted[sorted.length - 1].maxRating, 2600);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].minRating > sorted[i - 1].maxRating,
      `档位区间重叠：${sorted[i - 1].key} 与 ${sorted[i].key}`);
    assert.ok(sorted[i].limitSeconds > sorted[i - 1].limitSeconds, '越难的档位限时应当更长');
  }
});

test('抽题总是落在档位区间内', () => {
  const tier = DAN_TIERS.find((row) => row.key === 'advanced')!;
  const pool = [...at(1000, 20, 1), ...at(1800, 20, 100), ...at(3000, 20, 200)];
  for (let i = 0; i < 300; i += 1) {
    const picked = drawDanCandidate(pool, { minRating: tier.minRating, maxRating: tier.maxRating, exclude: ANY })!;
    assert.ok(picked.rating >= tier.minRating && picked.rating <= tier.maxRating, `抽到区间外的题：${picked.rating}`);
  }
});

test('抽题先均匀选 rating 值，再在桶内选 —— 与桶的大小无关', () => {
  const options = { minRating: 800, maxRating: 1100, exclude: ANY };
  // 999 道 800 分 + 1 道 1100 分。按「题目」均匀抽的话，这里几乎永远是 800。
  const skew = [...at(800, 999, 1), { contestId: 5000, index: 'A', rating: 1100 }];
  // 随机序列：先选最后一个 rating 桶（1100），再选桶内第 0 道。
  const seq = [1, 0];
  let cursor = 0;
  const rng = () => seq[cursor++];
  assert.equal(drawDanCandidate(skew, options, rng)!.rating, 1100);
  // 同一题库上把桶撑平，同一个随机序列仍选到 1100 —— 结果只由「选哪个桶」决定。
  cursor = 0;
  assert.equal(drawDanCandidate([{ contestId: 6000, index: 'A', rating: 800 }, { contestId: 6001, index: 'A', rating: 1100 }], options, rng)!.rating, 1100);
  cursor = 0;
  assert.equal(drawDanCandidate(skew, options, () => 0)!.rating, 800);
});

test('大随机段位：按题目均匀，难度分布就是题库的真实分布', () => {
  // 999 道 800 分 + 1 道 1100 分。小随机会把两个 rating 抽成五五开，
  // 大随机按题目均匀，所以 800 占 99.9% —— 这才是「不保证难度分布」。
  const skew = [...at(800, 999, 1), { contestId: 5000, index: 'A', rating: 1100 }];
  const options = { minRating: 800, maxRating: 2600, exclude: ANY, draw: 'problem' as const };

  let hits = 0;
  for (let i = 0; i < 2000; i += 1) if (drawDanCandidate(skew, options)!.rating === 800) hits += 1;
  const share = hits / 2000;
  assert.ok(share > 0.97, `800 分的占比应当约 99.9%，实际 ${(share * 100).toFixed(1)}%`);

  // 对照：同一题库上两个 rating 桶大小相等时，大随机变成五五开 —— 它只认题目数。
  let small = 0;
  const even = [...at(800, 500, 1), ...at(1100, 500, 5000)];
  for (let i = 0; i < 600; i += 1) if (drawDanCandidate(even, options)!.rating === 800) small += 1;
  assert.ok(Math.abs(small / 600 - 0.5) < 0.1, `桶大小相同时应接近五五开，实际 ${(small / 600 * 100).toFixed(1)}%`);

  // 同一个随机序列，两种分布选出的不是同一道 —— 证明分支真的分开了。
  // rating 均匀：先选桶（第 2 个 = 1100），再选桶内第 0 道。那个桶只有 1 道题，
  // 按题目均匀时它在 1000 道里排最后，用同一个种子根本抽不到。
  let cursor = 0;
  const seq = () => [1, 0][cursor++] ?? 0;
  assert.equal(drawDanCandidate(skew, { ...options, draw: 'rating' }, seq)!.rating, 1100,
    'rating 均匀：1100 那个桶再小也有一半机会');
  assert.equal(drawDanCandidate(skew, options, () => 1)!.rating, 800,
    '题目均匀：第 2 道仍然是 800');
});

test('随机段位：不分段覆盖 800-2600，逐题限时按当题难度', () => {
  for (const tier of DAN_RANDOM_TIERS) {
    assert.equal(tier.minRating, 800);
    assert.equal(tier.maxRating, 2600);
    assert.equal(tier.perStageLimit, true, '随机段位必须逐题限时，一个统一限时对两头都不公平');
    assert.equal(selectableDanTier(tier.key), tier, '随机段位要能当档位选');
    assert.equal(danTier(tier.key), tier);
  }
  assert.deepEqual(DAN_RANDOM_TIERS.map((tier) => tier.draw), ['rating', 'problem'],
    '小随机按 rating 均匀，大随机按题目均匀');
  // 区间取四个难度档的并集，且确实横跨全部四档。
  assert.equal(Math.min(...DAN_TIERS.map((tier) => tier.minRating)), 800);
  assert.equal(Math.max(...DAN_TIERS.map((tier) => tier.maxRating)), 2600);
  for (const tier of DAN_TIERS) {
    assert.ok(tier.maxRating >= 800 && tier.minRating <= 2600, `${tier.key} 应当落在并集里`);
  }

  // 限时按当题难度落到对应档位，且随难度单调不减。
  const limits = [800, 1000, 1100, 1200, 1500, 1600, 2000, 2100, 2600].map(danLimitForRating);
  assert.deepEqual(limits, [1800, 1800, 1800, 2400, 2400, 3000, 3000, 3600, 3600]);
  for (let i = 1; i < limits.length; i += 1) assert.ok(limits[i] >= limits[i - 1]);
});

test('随机段位落库：每道的限时随抽到的难度定，并进结算快照', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'challenge', tierKey: 'small_random', now: t0 });
    const session = activeDanSession(s.db, s.user)!;
    assert.equal(session.stage_count, DAN_STAGES, '随机段位也是 4 道');
    assert.equal(session.min_rating, 800);
    assert.equal(session.max_rating, 2600);

    // 池子里放了四个不同难度的题各一道，四道抽完必然覆盖四种限时。
    const pool = [{ contestId: 1, index: 'A', rating: 800 }, { contestId: 2, index: 'A', rating: 1300 },
      { contestId: 3, index: 'A', rating: 1800 }, { contestId: 4, index: 'A', rating: 2400 }];
    const rows = s.db.prepare('SELECT difficulty,limit_seconds FROM dan_stages WHERE session_id=? ORDER BY stage_index');
    for (let i = 1; i <= DAN_STAGES; i += 1) {
      drawNextDanStage(s.db, { sessionId: 's1', pool, now: t0, dateKey: '2026-10-09' });
      playStage(s, 's1', t0 + i * 10000, 300, String(i));
    }
    const stages = rows.all('s1') as unknown as { difficulty: number; limit_seconds: number }[];
    assert.equal(stages.length, DAN_STAGES);
    for (const stage of stages) {
      assert.equal(stage.limit_seconds, danLimitForRating(stage.difficulty),
        `难度 ${stage.difficulty} 的限时应当是当题难度对应的那一档`);
    }
    assert.ok(new Set(stages.map((stage) => stage.limit_seconds)).size > 1, '随机段位四道不会都是同一个限时');

    const view = viewOf(s, 's1');
    assert.equal(view.perStageLimit, true);
    assert.equal(view.draw, 'rating');
    for (const stage of view.stages) assert.equal(stage.limitSeconds, danLimitForRating(stage.difficulty));

    const settlement = JSON.parse((s.db.prepare('SELECT settlement_json FROM dan_sessions WHERE id=?').get('s1') as { settlement_json: string }).settlement_json);
    for (const stage of settlement.stages) assert.equal(stage.limitSeconds, danLimitForRating(stage.difficulty));
  } finally { s.db.close(); }
});

test('019 之前的旧行没有 limit_seconds，结算时沿用 session 的统一限时', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    // 手工插一行 limit_seconds 为 NULL 的记录，模拟 018 时期抽出来的「上级」档。
    s.db.prepare(`INSERT INTO dan_sessions
      (id,user_id,tier,kind,stage_count,limit_seconds,min_rating,max_rating,status,started_at)
      VALUES('old',?,'advanced','single',1,3000,1600,2000,'active',?)`).run(s.user, t0);
    s.db.prepare(`INSERT INTO dan_stages(session_id,stage_index,problem_id,difficulty,drawn_at)
      VALUES('old',1,'1900:A',1900,?)`).run(t0);
    const view = viewOf(s, 'old');
    assert.equal(view.stages[0].limitSeconds, 3000, 'NULL 时回退到 session.limit_seconds');
    assert.equal(view.perStageLimit, false);

    beginStage(s, 'old', t0, 'dan-timer-old');
    // 3000 秒内不算超时，3001 秒算 —— 证明用的确实是回退值。
    advanceDanSessions(s.db, t0 + 3000);
    assert.equal(activeDanSession(s.db, s.user)!.status, 'active');
    advanceDanSessions(s.db, t0 + 3001);
    assert.equal(activeDanSession(s.db, s.user), null);
    assert.equal(danHistory(s.db, s.user)[0].status, 'failed');
  } finally { s.db.close(); }
});

test('随机段位：逐题限时按当题难度，不是按 session 的统一限时', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'challenge', tierKey: 'small_random', now: t0 });
    // 只放一道 800 分的题：限时应当是 1800 秒（初级档），而不是 3600。
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(800, 5, 1), now: t0, dateKey: '2026-10-09' });
    const stage = beginStage(s, 's1', t0, 'dan-timer-r1');
    assert.equal(stage.difficulty, 800);
    assert.equal(viewOf(s, 's1').stages[0].limitSeconds, 1800);
    advanceDanSessions(s.db, t0 + 1800);
    assert.equal(activeDanSession(s.db, s.user)!.status, 'active', '1800 秒内不应判负');
    advanceDanSessions(s.db, t0 + 1801);
    assert.equal(activeDanSession(s.db, s.user), null, '过了 1800 秒就超时（若误用 3600 就不会结束）');
    assert.equal(danHistory(s.db, s.user)[0].stages[0].outcome, 'timeout');
  } finally { s.db.close(); }
});

test('抽题的 rating 分布接近均匀，而不是跟着题库的题目数走', () => {
  const pool = [...at(800, 999, 1), ...at(1100, 999, 5000)];
  const rounds = 600;
  const counts = new Map<number, number>();
  for (let i = 0; i < rounds; i += 1) {
    const picked = drawDanCandidate(pool, { minRating: 800, maxRating: 1100, exclude: ANY })!;
    counts.set(picked.rating, (counts.get(picked.rating) ?? 0) + 1);
  }
  assert.equal(counts.size, 2, '两个 rating 桶都应被抽到');
  const share = (counts.get(800) ?? 0) / rounds;
  assert.ok(share > 0.4 && share < 0.6, `800 分占比应在 40%~60%，实际 ${(share * 100).toFixed(1)}%`);
});

test('已提交过的题不再抽到，且题号大小写不敏感', () => {
  const s = setup();
  try {
    // codeforces.ts 拼 problem_id 时不做大小写归一，这里刻意存小写。
    s.repo.saveSubmissions(s.account, [submission('codeforces', {
      submission_id: 'dan-wa-1', problem_id: '2259:a', problem_title: '见过但没做出来',
      status: 'WA', submitted_at: 100, difficulty: 1600,
    })]);
    const exclude = danExcludedProblems(s.db, s.user);
    assert.ok(exclude.has('2259:A'), '小写存储的题号也要能排除掉大写抽出结果');
    assert.equal(drawDanCandidate([{ contestId: 2259, index: 'a', rating: 1600 }],
      { minRating: 1600, maxRating: 1600, exclude }, () => 0), null);
  } finally { s.db.close(); }
});

test('每日一题可复现：同一天同一用户抽到同一道', () => {
  const pool = at(1500, 40, 1);
  const options = { minRating: DAILY_TIER.minRating, maxRating: DAILY_TIER.maxRating, exclude: ANY };
  const first = danProblemId(dailyDanCandidate(pool, options, 'daily:2026-10-09:1')!);
  const again = danProblemId(dailyDanCandidate(pool, options, 'daily:2026-10-09:1')!);
  assert.equal(first, again);
  const others = ['daily:2026-10-10:1', 'daily:2026-10-09:2', 'daily:2026-10-11:7']
    .map((seed) => danProblemId(dailyDanCandidate(pool, options, seed)!));
  assert.ok(others.some((id) => id !== first), '换一天或换个人应当抽到不同的题');
});

test('danDateKey 按给定时区换算日期', () => {
  const epoch = Date.parse('2026-10-08T16:30:00Z') / 1000;
  assert.equal(danDateKey(epoch, 480), '2026-10-09');
  assert.equal(danDateKey(epoch, 0), '2026-10-08');
});

test('口径 A：「开始做题」之前，下发数据里没有题号、题名与链接', () => {
  const s = setup();
  try {
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'challenge', tierKey: 'advanced', now: 1_000_000 });
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(1800, 20, 1), now: 1_000_000, dateKey: '2026-10-09' });
    const stage = danSessionView(s.db, activeDanSession(s.db, s.user)!).stages[0];
    assert.equal(stage.difficulty, 1800, '难度分数是允许下发的');
    assert.equal(stage.problemId, null);
    assert.equal(stage.problemUrl, null);
    assert.equal(stage.claimed, false);
    const json = JSON.stringify(danSessionView(s.db, activeDanSession(s.db, s.user)!));
    assert.ok(!json.includes('codeforces.com'), `下发数据里出现了链接：${json}`);
    assert.ok(!/\d{1,7}:[A-Za-z]\d*/.test(json), `下发数据里出现了题号：${json}`);
  } finally { s.db.close(); }
});

test('口径 A：claim 之后才下发题号与链接', () => {
  const s = setup();
  try {
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'single', tierKey: 'beginner', now: 1_000_000 });
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(1000, 5, 1), now: 1_000_000, dateKey: '2026-10-09' });
    const drawn = beginStage(s, 's1', 1_000_000, 'dan-timer-a1');
    const stage = danSessionView(s.db, activeDanSession(s.db, s.user)!).stages[0];
    assert.equal(stage.claimed, true);
    assert.equal(stage.problemId, drawn.problem_id);
    assert.equal(stage.problemUrl, `https://codeforces.com/contest/${drawn.problem_id.split(':')[0]}/problem/A`);
    assert.equal(stage.deadlineAt, 1_000_000 + 1800, '限时从 claim 起算');
  } finally { s.db.close(); }
});

test('段位認定四道全部通关才算通过，总分是各道的单题 rating 之和', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'challenge', tierKey: 'advanced', now: t0 });
    const pool = at(1800, 30, 1);
    let total = 0;
    const drawnIds: string[] = [];
    for (let i = 1; i <= DAN_STAGES; i += 1) {
      drawNextDanStage(s.db, { sessionId: 's1', pool, now: t0, dateKey: '2026-10-09' });
      const stage = playStage(s, 's1', t0 + i * 10000, 600 + i * 60, String(i));
      drawnIds.push(stage.problem_id);
      const row = viewOf(s, 's1').stages.find((entry) => entry.index === i)!;
      assert.equal(row.outcome, 'cleared');
      assert.equal(row.seconds, 600 + i * 60);
      assert.ok(row.rating! > 0);
      total += row.rating!;
    }
    assert.equal(new Set(drawnIds).size, DAN_STAGES, '同一轮内不应抽到重复的题');

    const session = danHistory(s.db, s.user)[0];
    assert.equal(session.status, 'cleared');
    assert.equal(session.stages.length, DAN_STAGES);
    assert.equal(session.totalRating, Math.round(total * 10) / 10);
    assert.ok(session.finishedAt);
    for (const stage of session.stages) assert.ok(stage.problemId, '结算后记录里应当能看到题号');

    // 规则随本轮冻结，之后调档位/限时不会改写旧记录。
    const settlement = JSON.parse((s.db.prepare('SELECT settlement_json FROM dan_sessions WHERE id=?').get('s1') as { settlement_json: string }).settlement_json);
    assert.equal(settlement.stageCount, DAN_STAGES);
    assert.equal(settlement.limitSeconds, 3000);
    assert.equal(settlement.totalRating, session.totalRating);
    assert.equal(settlement.stages.length, DAN_STAGES);
    // 逐题限时也进快照 —— 随机段位每题不同，历史要能按当时的规则解释。
    for (const stage of settlement.stages) assert.equal(stage.limitSeconds, 3000, '上级档统一 3000 秒');
    assert.equal(settlement.selfReported, true, '必须标明这是自测，不是防作弊');
  } finally { s.db.close(); }
});

test('单题超时：那一轮判为失败并结束，进行中的计时器被释放', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'single', tierKey: 'beginner', now: t0 });
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(1000, 5, 1), now: t0, dateKey: '2026-10-09' });
    beginStage(s, 's1', t0, 'dan-timer-t1');

    advanceDanSessions(s.db, t0 + 1799);
    assert.equal(activeDanSession(s.db, s.user)!.status, 'active', '限时内不应判负');

    advanceDanSessions(s.db, t0 + 1801);
    assert.equal(activeDanSession(s.db, s.user), null);
    const session = danHistory(s.db, s.user)[0];
    assert.equal(session.status, 'failed');
    assert.equal(session.stages[0].outcome, 'timeout');
    assert.equal(session.totalRating, null);
    const running = s.db.prepare("SELECT COUNT(*) AS n FROM practice_timers WHERE status='running'").get() as { n: number };
    assert.equal(running.n, 0, '超时必须释放计时器，否则用户再也起不了新的计时');
  } finally { s.db.close(); }
});

test('放弃一轮：判为 abandoned，进行中的计时器被释放', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'challenge', tierKey: 'expert', now: t0 });
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(2300, 5, 1), now: t0, dateKey: '2026-10-09' });
    beginStage(s, 's1', t0, 'dan-timer-x1');
    abandonDanSession(s.db, { sessionId: 's1', userId: s.user, now: t0 + 60 });
    assert.equal(activeDanSession(s.db, s.user), null);
    const session = danHistory(s.db, s.user)[0];
    assert.equal(session.status, 'abandoned');
    assert.equal(session.stages[0].outcome, 'interrupted');
    const running = s.db.prepare("SELECT COUNT(*) AS n FROM practice_timers WHERE status='running'").get() as { n: number };
    assert.equal(running.n, 0);
  } finally { s.db.close(); }
});

test('抽了不点也会到期作废，不会把唯一的活动轮次永久占住', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'challenge', tierKey: 'beginner', now: t0 });
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(1000, 5, 1), now: t0, dateKey: '2026-10-09' });
    advanceDanSessions(s.db, t0 + DAN_SESSION_TTL_SECONDS - 1);
    assert.ok(activeDanSession(s.db, s.user), '未到期不应作废');
    advanceDanSessions(s.db, t0 + DAN_SESSION_TTL_SECONDS + 1);
    assert.equal(activeDanSession(s.db, s.user), null);
    assert.equal(danHistory(s.db, s.user)[0].status, 'abandoned');
  } finally { s.db.close(); }
});

test('一个用户同时只能有一轮进行中的认定（应用层与数据库层各一道）', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'challenge', tierKey: 'advanced', now: t0 });
    assert.throws(
      () => createDanSession(s.db, { id: 's2', userId: s.user, kind: 'single', tierKey: 'beginner', now: t0 }),
      (error: unknown) => error instanceof DanError && error.code === 'SESSION_ACTIVE',
    );
    // 绕开应用层直接插第二条，唯一索引也要拦住。
    assert.throws(() => s.db.prepare(`INSERT INTO dan_sessions
      (id,user_id,tier,kind,stage_count,limit_seconds,min_rating,max_rating,status,started_at)
      VALUES('s3',?,'beginner','single',1,1800,800,1100,'active',?)`).run(s.user, t0));
  } finally { s.db.close(); }
});

test('区间里没有没做过的题时明确报错，不静默抽区间外的题', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'single', tierKey: 'beginner', now: t0 });
    assert.throws(
      () => drawNextDanStage(s.db, { sessionId: 's1', pool: [], now: t0, dateKey: '2026-10-09' }),
      (error: unknown) => error instanceof DanError && error.code === 'POOL_EMPTY',
    );
    // 唯一的候选已经被做过 → 同样报错。
    s.repo.saveSubmissions(s.account, [submission('codeforces', {
      submission_id: 'dan-seen-1', problem_id: '1:A', problem_title: '做过',
      status: 'AC', submitted_at: 100, difficulty: 1000,
    })]);
    assert.throws(
      () => drawNextDanStage(s.db, { sessionId: 's1', pool: at(1000, 1, 1), now: t0, dateKey: '2026-10-09' }),
      (error: unknown) => error instanceof DanError && error.code === 'POOL_EMPTY',
    );
  } finally { s.db.close(); }
});

test('每日一题的 session 抽到的就是当天的确定性结果', () => {
  const s = setup();
  try {
    const t0 = 1_000_000, pool = at(1500, 40, 1);
    createDanSession(s.db, { id: 'd1', userId: s.user, kind: 'daily', tierKey: 'daily', now: t0 });
    const session = activeDanSession(s.db, s.user)!;
    assert.equal(session.tier, DAILY_TIER.key);
    assert.equal(session.stage_count, 1);
    const drawn = drawNextDanStage(s.db, { sessionId: 'd1', pool, now: t0, dateKey: '2026-10-09' })!;
    const expected = dailyDanCandidate(pool,
      { minRating: DAILY_TIER.minRating, maxRating: DAILY_TIER.maxRating, exclude: ANY }, `daily:2026-10-09:${s.user}`)!;
    assert.equal(drawn.problem_id, danProblemId(expected));
  } finally { s.db.close(); }
});

test('不认识的档位直接报错，不会抽到区间外的题', () => {
  const s = setup();
  try {
    assert.throws(
      () => createDanSession(s.db, { id: 's1', userId: s.user, kind: 'single', tierKey: 'mythic', now: 1_000_000 }),
      (error: unknown) => error instanceof DanError && error.code === 'TIER_UNKNOWN',
    );
    // daily 是内部模式，不能被当成可选档位传进来。
    assert.throws(
      () => createDanSession(s.db, { id: 's2', userId: s.user, kind: 'single', tierKey: 'daily', now: 1_000_000 }),
      (error: unknown) => error instanceof DanError && error.code === 'TIER_UNKNOWN',
    );
  } finally { s.db.close(); }
});

test('挑战的成绩同时进入普通练习记录与 B50 计分（段位認定不是另一套计分）', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'single', tierKey: 'advanced', now: t0 });
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(1800, 5, 1), now: t0, dateKey: '2026-10-09' });
    const stage = playStage(s, 's1', t0, 900, 'p1');

    // `timing_source` 存进库的只有 legacy/manual/contest_estimate；'timer' 是
    // listPractice 按 practice_timers.attempt_id 反查出来的派生值（practice.ts:154）。
    const attempt = listPractice(s.db, s.user).find((row) => row.problem_id === stage.problem_id)!;
    assert.equal(attempt.seconds, 900);
    assert.equal(attempt.outcome, 'ac');
    assert.equal(attempt.timing_source, 'timer');

    // 同一个用时进入 B50 的原料，且用同一个 scoreProblem 得到同一个分数。
    const entry = listDxEntries(s.db, s.user, 'codeforces').find((row) => row.problemId === stage.problem_id)!;
    assert.equal(entry.recordedSeconds, 900);
    assert.equal(scoreProblem(entry).rating, viewOf(s, 's1').stages[0].rating);

    // 结算页要用的字段：B50 对比（来自 practice_timers.settlement_json，不是另算一套）、
    // 判定计数、题目名 —— 这样单题结算才能和普通计时结算显示同一个 DX RATING 与增量。
    const view = viewOf(s, 's1').stages[0]!;
    const comparison = view.comparison!;
    assert.ok(comparison, '结算后必须带上 reconcileTimers 冻结的 B50 对比');
    assert.equal(comparison.ratingDelta, Math.round((comparison.ratingAfter - comparison.ratingBefore) * 10) / 10);
    assert.equal(view.verdicts.AC, 1);
    assert.equal(view.waCount, 0);
    assert.equal(view.practiceKind, 'unknown');
    assert.ok(view.title, '结算卡要显示题目名');
  } finally { s.db.close(); }
});

test('未开始的那道不下发题目名，也不带结算数据（口径 A 覆盖到新字段）', () => {
  const s = setup();
  try {
    const t0 = 1_000_000;
    createDanSession(s.db, { id: 's1', userId: s.user, kind: 'single', tierKey: 'advanced', now: t0 });
    drawNextDanStage(s.db, { sessionId: 's1', pool: at(1800, 5, 1), now: t0, dateKey: '2026-10-09' });
    const stage = viewOf(s, 's1').stages[0]!;
    assert.equal(stage.problemId, null);
    assert.equal(stage.problemUrl, null);
    assert.equal(stage.title, null);
    assert.equal(stage.comparison, null);
    assert.deepEqual(stage.verdicts, {});
  } finally { s.db.close(); }
});

test('五个抽题接口都登记在 WRITE_ROUTES 里（写端点清单是安全边界的一部分）', () => {
  for (const path of ['/api/dan/start', '/api/dan/claim', '/api/dan/settle', '/api/dan/next', '/api/dan/abandon']) {
    assert.ok(WRITE_ROUTES.has(path), `${path} 必须登记为写端点`);
  }
  assert.ok(!WRITE_ROUTES.has('/api/dan'), 'GET /api/dan 是只读端点，不应登记为写端点');
});

test('API：settle 只结算不抽题，抽下一道必须由 next 触发（结算页才停得住）', async () => {
  const s = setup();
  try {
    s.db.prepare('INSERT INTO fetch_cache(cache_key,payload,expires_at) VALUES(?,?,unixepoch()+3600)')
      .run(PROBLEM_RATINGS_CACHE_KEY, JSON.stringify(at(1800, 40, 1)));
    const ctx = { db: s.db, dbPath: ':memory:', platforms: ['codeforces'], envFile: 'unused',
      openWrite: () => s.db, syncJobs: { checkTimer: () => {}, timerCheckState: () => null } as never };
    const call = (method: string, pathname: string, params: Record<string, string> = {}, body?: unknown) =>
      handleApi(ctx, { method, pathname, params: new URLSearchParams(params), body });

    const started = await call('POST', '/api/dan/start', {}, { userId: s.user, kind: 'challenge', tier: 'advanced', tz: 480 });
    const sessionId = (started.body as { session: { id: string } }).session.id;
    const claimed = (await call('POST', '/api/dan/claim', {}, { userId: s.user, sessionId })).body as
      { problemId: string; timerId: string; serverNow: number; difficulty: number };

    // 计时器往前挪 600 秒，并在「现在」交掉这道题（reconcileTimers 要求 submitted_at 严格晚于起点、且不晚于 now）。
    s.db.prepare('UPDATE practice_timers SET started_at = started_at - 600 WHERE id = ?').run(claimed.timerId);
    s.repo.saveSubmissions(s.account, [submission('codeforces', {
      submission_id: 'settle-sub-1', problem_id: claimed.problemId, problem_title: '段位認定',
      status: 'AC', submitted_at: claimed.serverNow, difficulty: claimed.difficulty,
    })]);

    // settle：出成绩、就停在结算上，不抽下一道。
    const settled = (await call('POST', '/api/dan/settle', {}, { userId: s.user, tz: 480 })).body as
      { session: { stages: { outcome: string | null; seconds: number | null; claimed: boolean }[] } };
    assert.equal(settled.session.stages.length, 1, 'settle 不得顺手把下一道抽出来');
    assert.equal(settled.session.stages[0].outcome, 'cleared');
    assert.equal(settled.session.stages[0].seconds, 600);

    // next：用户点了「抽选下一题」才抽，而且新抽的那道依旧不下发题号。
    const next = (await call('POST', '/api/dan/next', {}, { userId: s.user, tz: 480 })).body as
      { session: { stages: { claimed: boolean; problemId: string | null }[] } };
    assert.equal(next.session.stages.length, 2, 'next 才抽下一道');
    assert.equal(next.session.stages[1].claimed, false);
    assert.equal(next.session.stages[1].problemId, null);
  } finally { s.db.close(); }
});

test('API：抽题前不下发链接，claim 才下发，重复 claim 幂等', async () => {
  const s = setup();
  try {
    // 预置题库缓存：这样 fetch_problem_ratings 直接命中缓存，测试不打网络。
    s.db.prepare('INSERT INTO fetch_cache(cache_key,payload,expires_at) VALUES(?,?,unixepoch()+3600)')
      .run(PROBLEM_RATINGS_CACHE_KEY, JSON.stringify(at(1800, 40, 1)));
    const ctx = { db: s.db, dbPath: ':memory:', platforms: ['codeforces'], envFile: 'unused',
      openWrite: () => s.db, syncJobs: { checkTimer: () => {}, timerCheckState: () => null } as never };
    const call = (method: string, pathname: string, params: Record<string, string> = {}, body?: unknown) =>
      handleApi(ctx, { method, pathname, params: new URLSearchParams(params), body });

    // 1) 面板：题库就绪；每日一题只给难度
    const panel = (await call('GET', '/api/dan', { user: String(s.user), tz: '480' })).body as Record<string, never>;
    assert.equal(panel.poolReady, true);
    assert.equal(panel.poolSize, 40);
    assert.equal(typeof (panel.daily as { difficulty: number }).difficulty, 'number');
    assert.ok(!JSON.stringify(panel).includes('codeforces.com'), '面板不得下发链接');

    // 2) 抽题：只给难度
    const started = await call('POST', '/api/dan/start', {}, { userId: s.user, kind: 'challenge', tier: 'advanced', tz: 480 });
    assert.equal(started.status, 200);
    const startBody = started.body as { session: { id: string; stages: { problemId: null }[] }; stage: { index: number; difficulty: number } };
    assert.equal(startBody.stage.index, 1);
    assert.equal(startBody.stage.difficulty, 1800);
    assert.equal(startBody.session.stages[0].problemId, null);
    assert.ok(!JSON.stringify(started.body).includes('codeforces.com'), '抽题响应不得含链接');

    // 3) 开始做题：链接唯一的出口
    const sessionId = startBody.session.id;
    const claim = await call('POST', '/api/dan/claim', {}, { userId: s.user, sessionId });
    assert.equal(claim.status, 200);
    const claimBody = claim.body as { url: string; difficulty: number; deadlineAt: number; serverNow: number; timerId: string };
    assert.match(claimBody.url, /^https:\/\/codeforces\.com\/contest\/\d+\/problem\/[A-Z]\d*$/);
    assert.equal(claimBody.difficulty, 1800);
    assert.equal(claimBody.deadlineAt, claimBody.serverNow + 3000, '上级档限时 3000 秒');

    // 4) 重复点击幂等：同一条计时、同一个链接，不会起第二个计时器
    const again = await call('POST', '/api/dan/claim', {}, { userId: s.user, sessionId });
    assert.equal(again.status, 200);
    assert.equal((again.body as { url: string }).url, claimBody.url);
    assert.equal((again.body as { timerId: string }).timerId, claimBody.timerId);
    const timers = s.db.prepare('SELECT COUNT(*) AS n FROM practice_timers').get() as { n: number };
    assert.equal(timers.n, 1);

    // 5) 上一轮没结束就开新一轮：状态冲突（409），前端据此提示先完成或放弃
    const conflict = await call('POST', '/api/dan/start', {}, { userId: s.user, kind: 'single', tier: 'beginner' });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { code: string }).code, 'SESSION_ACTIVE');

    // 6) 放弃
    const abandoned = await call('POST', '/api/dan/abandon', {}, { userId: s.user, sessionId });
    assert.equal(abandoned.status, 200);
    assert.equal((abandoned.body as { abandoned: boolean }).abandoned, true);
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM practice_timers WHERE status='running'").get() as { n: number }).n, 0);
  } finally { s.db.close(); }
});

test('API：claim 之后视图才揭示题号与链接（刷新页面不会提前泄露）', async () => {
  const s = setup();
  try {
    s.db.prepare('INSERT INTO fetch_cache(cache_key,payload,expires_at) VALUES(?,?,unixepoch()+3600)')
      .run(PROBLEM_RATINGS_CACHE_KEY, JSON.stringify(at(1000, 20, 1)));
    const ctx = { db: s.db, dbPath: ':memory:', platforms: ['codeforces'], envFile: 'unused',
      openWrite: () => s.db, syncJobs: { checkTimer: () => {}, timerCheckState: () => null } as never };
    const call = (method: string, pathname: string, params: Record<string, string> = {}, body?: unknown) =>
      handleApi(ctx, { method, pathname, params: new URLSearchParams(params), body });

    await call('POST', '/api/dan/start', {}, { userId: s.user, kind: 'single', tier: 'beginner', tz: 480 });
    let panel = (await call('GET', '/api/dan', { user: String(s.user), tz: '480' })).body as { active: { id: string; stages: { problemId: null }[] } };
    assert.equal(panel.active.stages[0].problemId, null);

    await call('POST', '/api/dan/claim', {}, { userId: s.user, sessionId: panel.active.id });
    panel = (await call('GET', '/api/dan', { user: String(s.user), tz: '480' })).body as typeof panel;
    assert.ok(panel.active.stages[0].problemId, 'claim 之后才揭示题号');
  } finally { s.db.close(); }
});