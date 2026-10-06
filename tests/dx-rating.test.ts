import test from 'node:test';
import assert from 'node:assert/strict';
import { DX_CURVE } from '../src/dx/curve.ts';
import {
  ACHIEVEMENT_COMPUTED_MAX,
  ACHIEVEMENT_DISPLAY_DECIMALS,
  ACHIEVEMENT_DISPLAY_MAX,
  ACHIEVEMENT_RATING_MAX,
  ACHIEVEMENT_RATING_MIN,
  COEFFICIENT_AT_T97,
  DISPLAY_RANKS,
  DX_PLATFORM,
  NEW_SLOTS,
  OLD_SLOTS,
  PROBLEM_RATING_DIVISOR,
  RANK_LADDER,
  T97_ACHIEVEMENT,
  TOP_FACTOR_GAIN,
  achievementFromSeconds,
  buildBoard,
  buildPending,
  buildRankTimeTable,
  coefficientFromAchievement,
  computeContestAutoSeconds,
  curveInfo,
  factorFromAchievement,
  lookupT97,
  rankOf,
  scoreProblem,
  secondsForAchievement,
  timeRatioFromAchievement,
} from '../src/dx/rating.ts';
import { DxTimeError, clearProblemTime, setProblemTime } from '../src/dx-admin.ts';
import { SCHEMA_VERSION, openDatabase, Repository } from '../src/db/database.ts';
import { listContestTimeline, listDxEntries } from '../src/server/queries.ts';
import type { ContestTimelineRow, DxEntry } from '../src/dx/types.ts';

/**
 * 造一道题；默认值让它天然可计分（定数 1000、用时正好 T97）。
 *
 * `releasedAt` 默认 0（1970 年出的题），也就是**旧题区** —— 与 `currentYearStart` 取正数的
 * 测试放在一起，不写 `releasedAt` 就等于声明「这是旧题」，这比默认成新题安全。
 */
function entry(overrides: Partial<DxEntry> = {}): DxEntry {
  return {
    platform: DX_PLATFORM,
    problemId: '1:A',
    problemTitle: 'Test',
    problemUrl: null,
    problemRating: 1000,
    releasedAt: 0,
    solvedAt: 0,
    recordedSeconds: lookupT97(1000).seconds,
    ...overrides,
  };
}

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test('导出的 T97 曲线单调、端点与步长符合约定', () => {
  const points = DX_CURVE.points;
  assert.ok(points.length > 1);
  assert.equal(points[0][0], DX_CURVE.fitMinQ);
  assert.equal(points.at(-1)[0], DX_CURVE.fitMaxQ);
  for (let i = 1; i < points.length; i++) {
    assert.equal(points[i][0] - points[i - 1][0], 25, `第 ${i} 个网格点步长不对`);
    assert.ok(points[i][1] >= points[i - 1][1] - 1e-9, `网格 ${points[i][0]} 处不单调`);
    assert.ok(points[i][1] > 0);
  }
  assert.equal(curveInfo().sourceFile, 'results/cf-study/t97_monotone.csv');
});

test('T97 查表：网格点取原值、档间线性插值、范围外夹取并标记外推', () => {
  const [q0, s0] = DX_CURVE.points[0];
  const [q1, s1] = DX_CURVE.points[1];
  const last = DX_CURVE.points.at(-1)!;

  assert.equal(lookupT97(q0).seconds, s0);
  assert.equal(lookupT97(q0).extrapolated, null);

  const mid = lookupT97((q0 + q1) / 2);
  assert.ok(close(mid.seconds, (s0 + s1) / 2));
  assert.equal(mid.extrapolated, null);

  assert.equal(lookupT97(q0 - 500).seconds, s0);
  assert.equal(lookupT97(q0 - 500).extrapolated, 'below');
  assert.equal(lookupT97(last[0] + 500).seconds, last[1]);
  assert.equal(lookupT97(last[0] + 500).extrapolated, 'above');
  // 正好落在端点上不算外推，否则 800 和 2100 两档会被标成「外推」。
  assert.equal(lookupT97(last[0]).extrapolated, null);
});

test('用时等于 T97 时完成度 97、单题 rating 等于定数 ÷ 50', () => {
  const t97 = lookupT97(1400).seconds;
  const score = scoreProblem(entry({ problemRating: 1400, recordedSeconds: t97 }))!;
  assert.equal(score.achievement, T97_ACHIEVEMENT);
  assert.equal(score.rank, 'S');
  // 97.00% 正好落在系数台阶上，所以这里要容差：浮点误差方向不确定，而两侧差 16%。
  assert.ok(close(score.factor, 1, 1e-9), `系数因子应为 1，实际 ${score.factor}`);
  // 文档里的锚点：1400 题、97% 时单题贡献 28。
  assert.equal(score.rating, 1400 / PROBLEM_RATING_DIVISOR);
  assert.equal(score.rating, 28);
});

test('完成度 → 用时：S 就是 T97，六档门槛由等效选手 Rating 锚定', () => {
  const q = 1400;
  const t97 = lookupT97(q).seconds;

  // 锚点必须闭合：目标完成度 97 换算出来的用时就是 T97 本身。
  assert.equal(secondsForAchievement(q, T97_ACHIEVEMENT).seconds, t97);
  assert.equal(secondsForAchievement(q, T97_ACHIEVEMENT).extrapolated, null);

  // 往返：任意目标完成度 → 用时 → 完成度，应当回到原值。
  for (const achievement of [50, 60, 80, 90, 94, 97, 98, 99, 99.5, 100, 100.5, 100.75, 100.9, 100.99, 100.9999]) {
    const { seconds } = secondsForAchievement(q, achievement);
    assert.ok(
      close(achievementFromSeconds(seconds, t97), achievement),
      `${achievement}% 往返不一致`,
    );
  }

  // 评级越高允许的用时越短（`DISPLAY_RANKS` 从高到低，所以用时应当递增）。
  const times = DISPLAY_RANKS.map(([, floor]) => secondsForAchievement(q, floor).seconds);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] > times[i - 1], '评级下降时允许的用时应当变长');
  }

  // 六档的用时比是**要上线的口径**（等效选手 Rating 锚定，推导见 PLAYER_ANCHOR.md），
  // 与 `DISPLAY_RANKS` 同序：SSS+ 0.646 / SSS 0.732 / SS+ 0.797 / SS 0.846 / S+ 0.939 / S 1.000。
  // 这六个数由 `anchor-by-player-rating.mjs` 实测锚出，改 `TOP_FACTOR_GAIN` 后必须重跑重填。
  // 改 `TOP_TIME_RATIOS` 必须先来改这里 —— 之前那版是从 maimai 分数档位折算的
  // 0.965…1.000，六档窗口只有 3.5%，在 800 档上相邻两档只差 6 秒，已经被这条路取代。
  const expected = [0.646, 0.732, 0.797, 0.846, 0.939, 1];
  const ratios = DISPLAY_RANKS.map(([, floor]) => timeRatioFromAchievement(floor));
  for (const [i, want] of expected.entries()) {
    assert.ok(close(ratios[i], want, 1e-12), `${DISPLAY_RANKS[i][0]} 的用时比应为 ${want}，实际 ${ratios[i]}`);
  }
  const window = (times[times.length - 1] - times[0]) / times[times.length - 1];
  assert.ok(close(window, 1 - expected[0], 1e-12), `六档窗口应约 ${((1 - expected[0]) * 100).toFixed(1)}%`);

  // S 以下改为逐渐放缓的曲线，反算必须与正算一致。
  assert.equal(timeRatioFromAchievement(T97_ACHIEVEMENT), 1);
  assert.ok(close(timeRatioFromAchievement(94), 1.4947736116191397, 1e-12));
  assert.ok(close(achievementFromSeconds(timeRatioFromAchievement(ACHIEVEMENT_RATING_MIN), 1), ACHIEVEMENT_RATING_MIN));
  // 完成度是 t/T97 的**连续函数**：落在两个节点之间就按比例取值，不是「超过门槛就变成门槛值」。
  // S（1.000 ↔ 97）与 S+（0.939 ↔ 98）之间的 0.98 处应当是 97.33，而不是 97 或 98。
  assert.ok(
    close(achievementFromSeconds(0.98, 1), 97 + (1 - 0.98) / (1 - 0.939), 1e-12),
    '节点之间必须是线性插值，不能塌到门槛值上',
  );
  // 独立尾段继续区分快慢；101% 仅对应理论边界，用时为 0。
  assert.equal(timeRatioFromAchievement(ACHIEVEMENT_RATING_MAX), expected[0]);
  assert.ok(timeRatioFromAchievement(100.9) < expected[0]);
  assert.equal(ACHIEVEMENT_COMPUTED_MAX, 101);
  assert.equal(timeRatioFromAchievement(101), 0);
  assert.equal(secondsForAchievement(q, 101).seconds, 0);
  for (const invalid of [101.0001, 103, Infinity, NaN, 0, -1]) {
    assert.throws(() => timeRatioFromAchievement(invalid), RangeError);
    assert.throws(() => secondsForAchievement(q, invalid), RangeError);
  }
  assert.throws(() => achievementFromSeconds(0, t97), RangeError);
  assert.ok(close(achievementFromSeconds(1, 1e9), ACHIEVEMENT_COMPUTED_MAX, 1e-6));

  // 包含整个新尾段，整条换算必须随用时单调不增。
  let previous = Infinity;
  for (let ratio = 0.0025; ratio <= 2; ratio += 0.0025) {
    const achievement = achievementFromSeconds(ratio, 1);
    assert.ok(achievement <= previous + 1e-12, `完成度必须随用时单调不增，在 r=${ratio.toFixed(4)} 处破坏`);
    previous = achievement;
  }

  assert.throws(() => secondsForAchievement(q, 0), RangeError);
  // 范围外不抛错，与 `lookupT97` 一致，改为标记外推。
  assert.equal(secondsForAchievement(50, 97).extrapolated, 'below');
  assert.equal(secondsForAchievement(9999, 97).extrapolated, 'above');
});

test('SSS+ 尾段消除 101% 堆积，连续衔接且保持满分 Rating', () => {
  const cases = [[0.646, 100.5], [0.56, 100.56656346749226], [0.323, 100.75], [0.1292, 100.9], [0.01292, 100.99]];
  for (const [ratio, want] of cases) {
    assert.ok(close(achievementFromSeconds(ratio, 1), want, 1e-10));
  }
  for (const ratio of [0.646 - 1e-9, 0.646, 0.646 + 1e-9]) {
    assert.ok(close(achievementFromSeconds(ratio, 1), 100.5, 1e-7), 'SSS+ 接点不能跳变');
  }
  // 全部生产难度下，最快合法输入 1 秒也不应被四位小数舍入成 101%。
  for (const [q, t97] of DX_CURVE.points) {
    const fastest = scoreProblem(entry({ problemRating: q, recordedSeconds: 1 }))!;
    assert.ok(Number(fastest.achievementShown.toFixed(ACHIEVEMENT_DISPLAY_DECIMALS)) < 101);
    let previous = 100.5;
    for (const ratio of [0.56, 0.323, 0.1292, 0.01292]) {
      const score = scoreProblem(entry({ problemRating: q, recordedSeconds: t97 * ratio }))!;
      assert.ok(score.achievementShown > previous && score.achievementShown < 101);
      assert.equal(score.rating, fastest.rating, '尾段不改变满分贡献');
      assert.equal(score.rank, 'SSS+');
      previous = score.achievementShown;
    }
  }
});

test('展示用的六档由 RANK_LADDER 派生，不另抄一份门槛', () => {
  assert.deepEqual(
    DISPLAY_RANKS.map(([rank, floor]) => [rank, floor]),
    [['SSS+', 100.5], ['SSS', 100], ['SS+', 99.5], ['SS', 99], ['S+', 98], ['S', 97]],
  );
  // 顺序必须从高到低，且每一档都真的在总表里（防止两处各改一半）。
  assert.equal(DISPLAY_RANKS[0][1], ACHIEVEMENT_RATING_MAX);
  assert.equal(DISPLAY_RANKS[DISPLAY_RANKS.length - 1][1], T97_ACHIEVEMENT);
  for (let i = 1; i < DISPLAY_RANKS.length; i += 1) {
    assert.ok(DISPLAY_RANKS[i][1] < DISPLAY_RANKS[i - 1][1], '展示档位必须从高到低');
  }
  for (const [rank, floor] of DISPLAY_RANKS) {
    assert.ok(
      RANK_LADDER.some(([name, f]) => name === rank && f === floor),
      `${rank} 不在 RANK_LADDER 里`,
    );
  }
});

test('系数因子照 maimai 单曲 rating 的比例：97% 归一为 1、SSS+ 才是拿满 1.257', () => {
  const at = factorFromAchievement;

  // 锚点：用时 = T97 → 1.000。满分**不在**这里，这是最容易写错的一处。
  assert.ok(close(at(T97_ACHIEVEMENT), 1));
  assert.equal(coefficientFromAchievement(T97_ACHIEVEMENT), COEFFICIENT_AT_T97);

  // 满分在 100.5%（SSS+）。maimai 原样是 100.5 × 22.4 / (97 × 20.0) = 1.16041，
  // 再过一层 TOP_FACTOR_GAIN：1 + (1.16041 − 1) × 1.6 = 1.25666。
  // 这个数**钉死在这里** —— 它决定了整套评分的上限，改 K 时必须连它一起改。
  assert.ok(close(at(ACHIEVEMENT_RATING_MAX), 1.256659793814433, 1e-12));
  assert.ok(close(at(9999), at(ACHIEVEMENT_RATING_MAX), 1e-12), '超出上限按 100.5 计');

  // 中间各档按 maimai 的系数表走（档内常数，所以是阶梯不是曲线）。
  const cases: [number, number][] = [
    [100, 21.6], [99.5, 21.1], [99, 20.8], [98, 20.3], [96.9999, 16.8],
    [90, 15.2], [80, 13.6], [75, 12], [70, 11.2], [60, 9.6], [50, 8],
  ];
  for (const [achievement, coefficient] of cases) {
    assert.equal(coefficientFromAchievement(achievement), coefficient, `${achievement}% 的评级系数不对`);
    // 97% 以下不受 TOP_FACTOR_GAIN 影响（maimai 原样），97% 以上整段按 K 放大。
    const maimai = (achievement * coefficient) / (T97_ACHIEVEMENT * COEFFICIENT_AT_T97);
    const want =
      achievement > T97_ACHIEVEMENT ? 1 + (maimai - 1) * TOP_FACTOR_GAIN : maimai;
    assert.ok(close(at(achievement), want, 1e-12), `${achievement}% 的系数因子不对`);
  }

  // 97.00% 那里是一道台阶：差 0.0001 个百分点，因子从 0.840 跳到 1.000。这是 maimai 的原样。
  assert.ok(close(at(96.9999), (96.9999 * 16.8) / 1940, 1e-12));
  assert.ok(at(97) / at(96.9999) > 1.19, 'S 档的台阶应当明显');

  // 单调不降：Rank 更高绝不会拿到更低的单题 rating，所以取榜不受台阶影响。
  let previous = -1;
  for (let achievement = ACHIEVEMENT_RATING_MIN; achievement <= 101; achievement += 0.05) {
    const factor = at(achievement);
    assert.ok(factor >= previous - 1e-12, `${achievement.toFixed(2)}% 处系数因子回退了`);
    previous = factor;
  }
});

test('TOP_FACTOR_GAIN 只放大幅度、不动形状：97% 以下原样，段内比例照 maimai', () => {
  const at = factorFromAchievement;
  const maimai = (a: number): number =>
    (a * coefficientFromAchievement(a)) / (T97_ACHIEVEMENT * COEFFICIENT_AT_T97);

  // K 的语义（Ryan 2026-09-18 定）：97% = 刚好这题的水平，100% = 几乎稳定切。
  // 实测「稳定切」= 90% 解出率 = Rating 差 +217（SOLVE_RATE_PROBE.md），且不随题目难度变。
  // 他不要求按难度做差异化系数，于是折算到加权平均难度 E[Q] = 1196.95 上取一个确定的系数。
  const meanDifficulty = 1196.95;
  const impliedDelta = meanDifficulty * (at(100) - 1);
  assert.ok(Math.abs(impliedDelta - 217) < 1, `100% 处隐含的 Rating 差应为 217，实际 ${impliedDelta}`);

  // 97% 及以下一个字没动 —— K 只放大「97% 以上」那一截，锚点两端都是 1.000。
  for (const a of [50, 60, 80, 90, 94, 96.9999, T97_ACHIEVEMENT]) {
    assert.ok(close(at(a), maimai(a), 1e-12), `${a}% 不该受 K 影响`);
  }

  // 「照 maimai 的悬崖比例变换」这句话的可测形式：97→100 与 100→100.5 两段增量之比，
  // 放大前后必须一致。变了就说明动的是形状而不是幅度 —— 那不是这次要的改动。
  const ratioBefore = (maimai(100) - 1) / (maimai(ACHIEVEMENT_RATING_MAX) - maimai(100));
  const ratioAfter = (at(100) - 1) / (at(ACHIEVEMENT_RATING_MAX) - at(100));
  assert.ok(
    close(ratioBefore, ratioAfter, 1e-9),
    `两段增量的比例变了：${ratioBefore} → ${ratioAfter}`,
  );
});

test('慢速段满足两倍与四倍目标；低于 50% 不计分，评分时完成度封顶 100.5', () => {
  const t97 = lookupT97(1400).seconds;
  assert.ok(close(achievementFromSeconds(t97 * 1.5, t97), 93.97874388012035));
  assert.ok(close(achievementFromSeconds(t97 * 2, t97), 92.38375830159872));
  assert.ok(close(achievementFromSeconds(t97 * 4, t97), 89.32848535994844));
  assert.ok(close(achievementFromSeconds(75 * 60, t97), 92.56997501260965));

  assert.ok(scoreProblem(entry({ problemRating: 1400, recordedSeconds: t97 * 2 }))!.rating > 0);
  assert.equal(scoreProblem(entry({ problemRating: 1400, recordedSeconds: secondsForAchievement(1400, 49).seconds }))!.rating, 0);
  assert.equal(factorFromAchievement(ACHIEVEMENT_RATING_MIN - 0.01), 0);
  // A < 50 不计分是本项目的取舍，不是 maimai 的规则 —— 台阶就在这里。
  assert.ok(close(factorFromAchievement(ACHIEVEMENT_RATING_MIN), (50 * 8) / 1940, 1e-12));
  // 1400 的题：T97 用时拿 28.0（锚点，K 在这里不起作用）；拿满 35.2 要压到 0.646 × T97 以内。
  assert.equal(scoreProblem(entry({ problemRating: 1400, recordedSeconds: t97 }))!.rating, 28);
  assert.equal(
    scoreProblem(
      entry({ problemRating: 1400, recordedSeconds: t97 * timeRatioFromAchievement(ACHIEVEMENT_RATING_MAX) }),
    )!.rating,
    35.2,
  );

  // 0.9 × T97 在旧口径下早就封顶（那时也是 32.5），现在只到 S+ / 29.3，离拿满 35.2 还差
  // 一截 —— 这就是这轮要修的「快慢一个样」。写成显式断言，免得哪天被改回去。
  const fast = scoreProblem(entry({ problemRating: 1400, recordedSeconds: t97 * 0.9 }))!;
  assert.equal(fast.rank, 'S+');
  assert.equal(fast.rating, 29.3);

  // 1 秒用时的完成度仍小于 101%；评分按 100.5 封顶，单题贡献仍为 35.2。
  const absurd = scoreProblem(entry({ problemRating: 1400, recordedSeconds: 1 }))!;
  assert.equal(absurd.rating, 35.2);
  assert.ok(close(absurd.achievement, ACHIEVEMENT_COMPUTED_MAX, 0.01));
  assert.equal(absurd.achievementShown, absurd.achievement);
  assert.ok(absurd.achievementShown < ACHIEVEMENT_DISPLAY_MAX);
  // 评分时的封顶仍在，接近理论极限也只按 100.5 取系数。
  assert.equal(
    factorFromAchievement(ACHIEVEMENT_COMPUTED_MAX),
    factorFromAchievement(ACHIEVEMENT_RATING_MAX),
  );
});

test('每降三个百分点的倍率严格增大，慢速段连续、单调且正反算闭合', () => {
  let previousRatio = timeRatioFromAchievement(97) / timeRatioFromAchievement(100);
  for (let a = 97; a >= 4; a -= 3) {
    const ratio = timeRatioFromAchievement(a - 3) / timeRatioFromAchievement(a);
    assert.ok(ratio > previousRatio, `${a}→${a - 3} 的时间倍率没有增加`);
    previousRatio = ratio;
  }
  for (const [, t97] of DX_CURVE.points) {
    const twice = achievementFromSeconds(t97 * 2, t97);
    assert.ok(twice >= 92 && twice <= 95);
    assert.ok(achievementFromSeconds(t97 * 4, t97) > 80);
    for (const a of [0.001, 1, 20, 50, 80, 88, 91, 94, 96.9999, 97]) {
      assert.ok(close(achievementFromSeconds(t97 * timeRatioFromAchievement(a), t97), a));
    }
    for (const ratio of [1 - 1e-10, 1, 1 + 1e-10]) {
      assert.ok(close(achievementFromSeconds(t97 * ratio, t97), 97, 1e-7));
    }
  }
  let previous = 97;
  for (let exponent = 0; exponent <= 310; exponent++) {
    const value = achievementFromSeconds(Math.exp(exponent), 1);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= previous);
    previous = value;
  }
  assert.equal(previous, 0);
  assert.equal(achievementFromSeconds(Number.MAX_VALUE, Number.MIN_VALUE), 0);
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => achievementFromSeconds(invalid, 1), RangeError);
    assert.throws(() => achievementFromSeconds(1, invalid), RangeError);
  }
});

test('展示的完成度要留得住小数：它是连续插值算出来的，不是门槛值', () => {
  const t97 = lookupT97(1400).seconds;
  const at = (ratio: number): number =>
    scoreProblem(entry({ problemRating: 1400, recordedSeconds: t97 * ratio }))!.achievementShown;

  // 0.98 × T97 落在 S（1.000 ↔ 97）与 S+（0.939 ↔ 98）之间，插值出的是 97.33… 这种数，
  // 不是 97 也不是 98 —— 截成整数就等于把「连续」这件事扔掉了。
  assert.ok(!Number.isInteger(at(0.98)), `0.98 × T97 的完成度不该是整数，实际 ${at(0.98)}`);

  // 截到 ACHIEVEMENT_DISPLAY_DECIMALS 位之后，相邻用时仍然分得开 —— 否则显示精度不够。
  assert.notEqual(
    at(0.98).toFixed(ACHIEVEMENT_DISPLAY_DECIMALS),
    at(0.97).toFixed(ACHIEVEMENT_DISPLAY_DECIMALS),
    '两位小数不够：0.97 与 0.98 的用时会显示成同一个完成度',
  );
});

test('参考表：覆盖整个拟合范围，S 列就是 T97，且越高档要求越快', () => {
  const table = buildRankTimeTable();
  const info = curveInfo();

  // 端点对齐到 100 的倍数 —— 否则最后一档会静默失踪（曲线端点不是整百时最容易踩到）。
  assert.equal(table.rows[0].q, Math.ceil(info.fitMinQ / 100) * 100);
  assert.ok(table.rows[table.rows.length - 1].q <= info.fitMaxQ);
  assert.ok(table.rows.length >= 10, `档位太少：${table.rows.length}`);
  for (let i = 1; i < table.rows.length; i += 1) {
    assert.equal(table.rows[i].q - table.rows[i - 1].q, 100);
  }

  // 六档从高到低，与 DISPLAY_RANKS 同序 —— 前端按 position 取值，顺序错了表就整体反了。
  assert.deepEqual(
    table.ranks.map((r) => r.rank),
    DISPLAY_RANKS.map(([rank]) => rank),
  );

  for (const row of table.rows) {
    // 最重要的一条不变式：S 那一列必须等于 T97 本身。表被挪进弹窗之后，
    // 格子里的 T97 没了，这张表就是它唯一的去处 —— 对不上就说明门槛被改坏了。
    const sIndex = table.ranks.length - 1;
    assert.ok(
      Math.abs(row.seconds[sIndex] - row.t97Seconds) < 1e-6,
      `${row.q} 档的 S 列 ${row.seconds[sIndex]} 不等于 T97 ${row.t97Seconds}`,
    );
    assert.ok(Math.abs(row.t97Seconds - lookupT97(row.q).seconds) < 1e-6);
    // 越高档要求越快，所以秒数从 SSS+ 到 S 递增；窗口为正。
    for (let i = 1; i < row.seconds.length; i += 1) {
      assert.ok(row.seconds[i] > row.seconds[i - 1], `${row.q} 档第 ${i} 列没有比前一档慢`);
    }
    assert.ok(row.windowSeconds > 0);
  }

  // ladder：与难度无关，且不出现「不计分」以下的档位。
  for (const row of table.ladder) {
    assert.ok(row.achievement >= ACHIEVEMENT_RATING_MIN);
    assert.ok(Math.abs(row.factor - factorFromAchievement(row.achievement)) < 1e-12);
  }
  // 参考题换一个，只有「单题 rating」那一列按比例变，factor 不动。
  const other = buildRankTimeTable(DX_CURVE, 2000);
  assert.equal(other.referenceQ, 2000);
  assert.equal(other.ladder[0].factor, table.ladder[0].factor);
  assert.ok(other.ladder[0].rating > table.ladder[0].rating);
});

test('缺题目 Rating 或没填用时都不进榜', () => {
  assert.equal(scoreProblem(entry({ problemRating: null })), null);
  assert.equal(scoreProblem(entry({ recordedSeconds: null })), null);

  const board = buildBoard([entry({ problemRating: null }), entry({ recordedSeconds: null })], 0);
  assert.equal(board.total, 0);
  assert.equal(board.rating, 0);
  // 格子数固定，空档补 null —— 这是「缺题不补满」，不是用假数据凑数。
  assert.equal(board.old.length, OLD_SLOTS);
  assert.equal(board.current.length, NEW_SLOTS);
  assert.ok(board.old.every((slot) => slot.entry === null && slot.score === null));
  // 位次是连续的 1..N
  assert.deepEqual(board.old.map((s) => s.position), [...Array(OLD_SLOTS).keys()].map((i) => i + 1));
});

test('Rank 门槛与文档一致', () => {
  const expected: [number, string][] = [
    [0, 'D'], [49.99, 'D'], [50, 'C'], [60, 'B'], [70, 'BB'], [75, 'BBB'], [80, 'A'],
    [90, 'AA'], [94, 'AAA'], [97, 'S'], [98, 'S+'], [99, 'SS'], [99.5, 'SS+'], [100, 'SSS'], [100.5, 'SSS+'], [500, 'SSS+'],
  ];
  for (const [value, rank] of expected) assert.equal(rankOf(value), rank, `${value} 的 Rank 应为 ${rank}`);
});

test('b35 / b15 按**出题日期**分板：AC 时间在分板的哪一边都无所谓', () => {
  const since = 1_700_000_000;
  const rows: DxEntry[] = [];
  // 老题故意在分界之后 AC，新题故意在分界之前 AC —— 如果实现里还在用 solvedAt，
  // 这个测试立刻会翻。
  for (let i = 0; i < 40; i++) {
    const q = 800 + i * 20;
    rows.push(
      entry({
        problemId: `old${i}`,
        problemRating: q,
        releasedAt: since - 86400,
        solvedAt: since + 86400,
        recordedSeconds: lookupT97(q).seconds,
      }),
    );
  }
  for (let i = 0; i < 20; i++) {
    const q = 800 + i * 20;
    rows.push(
      entry({
        problemId: `new${i}`,
        problemRating: q,
        releasedAt: since + 86400,
        solvedAt: since - 86400,
        recordedSeconds: lookupT97(q).seconds,
      }),
    );
  }
  const board = buildBoard(rows, since);

  assert.equal(board.oldCount, OLD_SLOTS);
  assert.equal(board.currentCount, NEW_SLOTS);
  assert.equal(board.total, OLD_SLOTS + NEW_SLOTS);
  // 都按 T97 填，所以单题 rating 随定数递增，取到的是最难的 35 / 15 道。
  assert.equal(board.old[0].entry!.problemId, 'old39');
  assert.equal(board.old.at(-1)!.entry!.problemId, 'old5');
  assert.equal(board.current[0].entry!.problemId, 'new19');
  assert.equal(board.current.at(-1)!.entry!.problemId, 'new5');

  // 总分必须等于界面上那 50 个数字相加 —— 对不上的话读表的人第一眼就会不信。
  const sum = [...board.old, ...board.current].reduce((n, slot) => n + (slot.score?.rating ?? 0), 0);
  assert.ok(close(sum, board.rating));

  // 出题日期正好落在起点上的算出题日期当天的题（左闭）。
  const boundary = buildBoard([entry({ problemId: 'bx', releasedAt: since })], since);
  assert.equal(boundary.currentCount, 1);
  assert.equal(boundary.oldCount, 0);
});

test('本年度 AC 的老题仍进旧题区；缺出题日期按旧题处理', () => {
  const since = 1_767_225_600;
  const board = buildBoard(
    [
      // 2026 年 6 月切掉、但题是 2013 年出的（339:A，Codeforces Round 197）→ 旧题。
      entry({ problemId: '339:A', releasedAt: since - 10 * 86400, solvedAt: since + 100 * 86400 }),
      // 2025 年就 AC 了、但题是 2026 年出的（补做当年新题）→ 新题。
      entry({ problemId: '2000:A', releasedAt: since + 86400, solvedAt: since - 100 * 86400 }),
      // 查不到出题日期（例如 gym，不在 contest.list 里）→ 旧题。
      entry({ problemId: '100000:A', problemRating: 900, releasedAt: null, solvedAt: since + 200 * 86400 }),
    ],
    since,
  );

  assert.equal(board.oldCount, 2);
  assert.equal(board.currentCount, 1);
  assert.equal(board.total, 3);
  assert.deepEqual(board.old.slice(0, 2).map((s) => s.entry!.problemId), ['339:A', '100000:A']);
  assert.equal(board.current[0].entry!.problemId, '2000:A');

  // 待填写清单里的「新题 / 旧题」标注必须与分板同一口径，否则填完会「跳区」。
  // 清单按 AC 时间倒序，所以按题号取用，不假设顺序。
  const pending = buildPending(
    [
      entry({ problemId: '339:A', releasedAt: since - 10 * 86400, recordedSeconds: null }),
      entry({ problemId: '2000:A', releasedAt: since + 86400, recordedSeconds: null }),
      entry({ problemId: '100000:A', releasedAt: null, recordedSeconds: null }),
    ],
    since,
  );
  const byId = new Map(pending.map((p) => [p.problemId, p]));
  assert.equal(byId.get('339:A')!.isCurrent, false, '本年度 AC 的老题仍是旧题');
  assert.equal(byId.get('2000:A')!.isCurrent, true, '去年 AC 的当年新题仍是新题');
  assert.equal(byId.get('100000:A')!.isCurrent, false, '没有出题日期时按旧题算');
  assert.equal(byId.get('339:A')!.releasedAt, since - 10 * 86400);
  assert.equal(byId.get('2000:A')!.releasedAt, since + 86400);
  assert.equal(byId.get('100000:A')!.releasedAt, null);
});

test('待填写清单：收所有没填用时的题（含未评定），按 AC 时间倒序（最近切掉的在最上面）', () => {
  const since = 1_700_000_000;
  const rows: DxEntry[] = [
    entry({ problemId: 'e:A', solvedAt: since - 300, releasedAt: 0, recordedSeconds: null }),
    entry({ problemId: 'd:A', solvedAt: since - 200, releasedAt: since - 1, recordedSeconds: null }),
    entry({ problemId: 'c:A', solvedAt: since + 100, releasedAt: since + 5, recordedSeconds: null }),
    entry({ problemId: 'b:A', solvedAt: since + 50, releasedAt: since, recordedSeconds: null }),
    entry({ problemId: 'a:A', solvedAt: since + 200, releasedAt: since + 10, recordedSeconds: null }),
    // 已填用时的不收；未评定（CF 还没公布 Rating）的**照收** —— 现在就能填用时，
    // 评级公布后由同步回填，届时 buildBoard 下一次读取自动把它计分进榜。
    entry({ problemId: 'zfilled:A', solvedAt: since + 900, recordedSeconds: 600 }),
    entry({ problemId: 'znorating:A', solvedAt: since + 950, problemRating: null, recordedSeconds: null }),
  ];
  const pending = buildPending(rows, since);
  assert.deepEqual(
    pending.map((p) => p.problemId),
    ['znorating:A', 'a:A', 'c:A', 'b:A', 'd:A', 'e:A'],
  );
  // isCurrent 看的是出题日期，不是上面那个排序用的 AC 时间。
  assert.deepEqual(
    pending.map((p) => p.isCurrent),
    [false, true, true, true, false, false],
  );
  // 未评定的行带着 null 进清单，界面据此标「未评定」；其余行一定是数字。
  assert.equal(pending[0].problemRating, null);
  assert.ok(pending.slice(1).every((p) => typeof p.problemRating === 'number'));

  // 同一秒 AC 的题用题号兜底 —— 否则每次刷新列表顺序都在跳。
  const tie = buildPending(
    [
      entry({ problemId: 'z:A', solvedAt: since, recordedSeconds: null }),
      entry({ problemId: 'a:A', solvedAt: since, recordedSeconds: null }),
    ],
    since,
  );
  assert.deepEqual(
    tie.map((p) => p.problemId),
    ['a:A', 'z:A'],
  );
});

/** 造一条比赛窗口内的提交时间轴行。contest 形如 `2259`，problem 形如 `A`。 */
function timeline(contest: string, problem: string, offsetSeconds: number, status = 'AC'): ContestTimelineRow {
  const start = 1_800_000_000;
  return {
    problemId: `${contest}:${problem}`,
    submittedAt: start + offsetSeconds,
    status,
    contestStart: start,
    contestDuration: 8100,
  };
}

test('比赛自动计时：按被切的时间顺序逐题相减，首题减开赛（口径 B）', () => {
  const rows = [
    timeline('2259', 'A', 600),
    timeline('2259', 'B', 1200),
    timeline('2259', 'C', 3000),
  ];
  const auto = computeContestAutoSeconds(rows);
  assert.equal(auto.get('2259:A'), 600);
  assert.equal(auto.get('2259:B'), 600);
  assert.equal(auto.get('2259:C'), 1800);
});

test('比赛自动计时：跳题不按题号顺序，按 AC 时间序照样算（A→C→B）', () => {
  const rows = [
    timeline('2260', 'A', 600),
    timeline('2260', 'C', 1500),
    timeline('2260', 'B', 2700),
  ];
  const auto = computeContestAutoSeconds(rows);
  // B 的纯耗时 = 切完 C 之后到切掉 B —— 题号顺序无关紧要。
  assert.equal(auto.get('2260:A'), 600);
  assert.equal(auto.get('2260:C'), 900);
  assert.equal(auto.get('2260:B'), 1200);
});

test('比赛自动计时：两道 AC 之间穿插别的题的提交（如 WA）时，减法掺了别题时间，不给值', () => {
  const rows = [
    timeline('2261', 'A', 600),
    // 切完 A 后先 WA 了两发 B，才切 C —— C 的区间里掺了 B 的时间。
    timeline('2261', 'B', 800, 'WA'),
    timeline('2261', 'B', 900, 'WA'),
    timeline('2261', 'C', 1500),
  ];
  const auto = computeContestAutoSeconds(rows);
  assert.equal(auto.get('2261:A'), 600);
  assert.equal(auto.has('2261:C'), false);
  // B 没在这场里切掉，本来就不该出现在结果里。
  assert.equal(auto.has('2261:B'), false);
  // 但穿插只影响它自己的区间：如果 B 后来也切掉了，B 从 C 的 AC 起算，不受影响。
  const rows2 = [
    ...rows,
    timeline('2261', 'B', 2200),
    timeline('2261', 'D', 3000),
  ];
  const auto2 = computeContestAutoSeconds(rows2);
  assert.equal(auto2.has('2261:C'), false); // C 的区间仍然掺了 B 的 WA。
  assert.equal(auto2.get('2261:B'), 2200 - 1500); // B = 切完 C 之后。
  assert.equal(auto2.get('2261:D'), 800); // D 从 B 的 AC 起算。
});

test('比赛自动计时：同一题的 WA 是做它的时间，不算穿插；多次 AC 只算第一次', () => {
  const rows = [
    timeline('2262', 'A', 600),
    timeline('2262', 'B', 900, 'WA'),
    timeline('2262', 'B', 1200, 'WA'),
    timeline('2262', 'B', 1500), // AC —— B 的「切掉时刻」取它，不是后面的重复 AC。
    timeline('2262', 'B', 2000), // 重复 AC：还是一次提交，落在 C 的区间里就拦下 C。
    timeline('2262', 'C', 2400),
  ];
  const auto = computeContestAutoSeconds(rows);
  assert.equal(auto.get('2262:A'), 600);
  assert.equal(auto.get('2262:B'), 900); // 含两发 WA，都是做 B 的时间。
  // C 的区间 (1500, 2400) 里有 B 的重复 AC —— 那也是在别题上花的时间，守卫照拦。
  assert.equal(auto.has('2262:C'), false);
  // 没有那发重复 AC 的话，C 就是干净的 2400 - 1500。
  const clean = computeContestAutoSeconds(rows.filter((r) => r.submittedAt !== 2000 + 1_800_000_000));
  assert.equal(clean.get('2262:C'), 900);
});

test('比赛自动计时：同秒切两道（减出 0 秒）不给值；多场比赛互不干扰', () => {
  const rows = [
    timeline('2263', 'A', 600),
    timeline('2263', 'B', 600), // 与 A 同秒 AC —— 0 秒没有意义（MIN_SECONDS=1），不给。
    timeline('2263', 'C', 1200),
    timeline('9999', 'A', 300), // 另一场比赛，各算各的。
  ];
  const auto = computeContestAutoSeconds(rows);
  assert.equal(auto.has('2263:B'), false);
  assert.equal(auto.get('2263:A'), 600);
  assert.equal(auto.get('2263:C'), 600); // C 从 B 的 AC（=A 的 AC）起算。
  assert.equal(auto.get('9999:A'), 300);
});

test('listContestTimeline：只取窗口内的提交，duration 缺失的比赛一行都不收', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO users(name,is_self) VALUES(?,1)').run('t');
    db.prepare('INSERT INTO accounts(id,user_id,platform,handle,handle_key) VALUES(1,1,?,?,?)').run(
      'codeforces',
      'h',
      'h',
    );
    const start = 1_800_000_000;
    const insContest = (id: number, duration: number | null) =>
      db
        .prepare('INSERT INTO contests(platform,contest_id,name,start_time,duration_seconds) VALUES(?,?,?,?,?)')
        .run('codeforces', id, `c${id}`, start, duration);
    insContest(2264, 8100); // 有时长。
    insContest(2265, null); // duration 缺失 → 整场不收。
    const ins = (sid: number, problemId: string, at: number, status: string) =>
      db
        .prepare(
          'INSERT INTO submissions(id,account_id,platform,submission_id,problem_id,problem_title,status,submitted_at)' +
            ' VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(sid, 1, 'codeforces', String(sid), problemId, 'T', status, at);
    ins(1, '2264:A', start + 600, 'AC'); // 窗口内。
    ins(2, '2264:B', start + 8100, 'AC'); // 恰好开赛 + 时长 —— 右端开区间，窗口外。
    ins(3, '2264:C', start - 10, 'AC'); // 开赛前（不可能但守边界），窗口外。
    ins(4, '2265:A', start + 600, 'AC'); // duration 缺失的比赛。
    ins(5, '2264:A', start + 700, 'AC'); // 同题第二次 AC，取第一次。

    const rows = listContestTimeline(db, 1, 'codeforces');
    // 时间轴保留窗口内的**全部**提交（两条 2264:A）—— 穿插守卫需要看见每一发，
    // 去重是 computeContestAutoSeconds 的事（多次 AC 只算第一次）。
    assert.deepEqual(
      rows.map((r) => r.problemId),
      ['2264:A', '2264:A'],
    );
    assert.equal(rows[0].contestDuration, 8100);
    // 第一次 AC 在 600：自动计时 = 600，不是 700。
    assert.equal(computeContestAutoSeconds(rows).get('2264:A'), 600);
  } finally {
    db.close();
  }
});

test('同分排序稳定：先单题 rating，再实际完成度，完全相同用题号兜底', () => {
  // since 取 1，让 solvedAt=0 的样本落在旧题区（起点是左闭的，用 0 会被判成新题）。
  const since = 1;
  // 定数 1700 的题跑到完成度 95.1%（AAA 档、系数 16.8）：34 × 0.8235 = 28.0006，
  // 与「1400 用 T97」的 28.0 在取整后同分 —— 于是更高完成度的 1400 题应排在前面。
  const t1400 = lookupT97(1400).seconds;
  const same = buildBoard(
    [
      entry({ problemId: 'b:A', problemRating: 1700, recordedSeconds: secondsForAchievement(1700, 95.1).seconds }),
      entry({ problemId: 'a:A', problemRating: 1400, recordedSeconds: t1400 }),
    ],
    since,
  );
  assert.equal(same.old[0].score!.rating, same.old[1].score!.rating);
  assert.equal(same.old[0].score!.rating, 28);
  assert.deepEqual(same.old.slice(0, 2).map((s) => s.entry!.problemId), ['a:A', 'b:A']);

  // 完全相同的输入必须给出完全相同的名次（缓存/重算都不该让榜跳动）。
  const tie = buildBoard([entry({ problemId: 'z:A' }), entry({ problemId: 'a:A' })], since);
  assert.deepEqual(tie.old.slice(0, 2).map((s) => s.entry!.problemId), ['a:A', 'z:A']);
});

test('schema v6 建出 problem_times，seconds 有正数约束', () => {
  const db = openDatabase(':memory:');
  try {
    // 不断言具体版本号：它等于迁移条数，写死就每加一次迁移都要改一遍。
    // 这条测试真正守的是「建库后 user_version 与代码声明一致」。
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
    const columns = db.prepare("PRAGMA table_info('problem_times')").all().map((row) => row.name);
    assert.deepEqual(columns, ['id', 'user_id', 'platform', 'problem_id', 'seconds', 'created_at', 'updated_at']);
    db.prepare('INSERT INTO users(name,is_self) VALUES(?,1)').run('t');
    assert.throws(() =>
      db.prepare('INSERT INTO problem_times(user_id,platform,problem_id,seconds) VALUES(1,?,?,0)').run('codeforces', '4:A'),
    );
  } finally {
    db.close();
  }
});

test('schema v6：contests 存出题日期，重复抓取只覆盖不重复插入', () => {
  const db = openDatabase(':memory:');
  try {
    assert.deepEqual(
      db.prepare("PRAGMA table_info('contests')").all().map((row) => row.name),
      // v8 的 duration_seconds 由 ALTER TABLE 追加，永远在列清单**末尾**。
      ['platform', 'contest_id', 'name', 'start_time', 'fetched_at', 'duration_seconds'],
    );

    const repo = new Repository(db);
    repo.saveProblemReleases('codeforces', [{ contestId: 339, name: 'Codeforces Round 197 (Div. 2)', startTime: 1377531000 }]);
    // 第二次连同一场带两个：同名同 id 的那行必须被覆盖（刷新 fetched_at），而不是再插一行。
    // duration 是 v8 新增：没提供时必须保持 NULL（不猜），提供时必须存进去。
    repo.saveProblemReleases('codeforces', [
      { contestId: 339, name: 'Codeforces Round 197 (Div. 2)', startTime: 1377531000, durationSeconds: 7200 },
      { contestId: 2261, name: 'Codeforces Round (Div. 1 + Div. 2)', startTime: 1792247700, durationSeconds: null },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM contests').get()!.c, 2);

    // 主键是 (platform, contest_id)：同一个 id 在另一个平台是另一行。
    repo.saveProblemReleases('luogu', [{ contestId: 339, name: 'x', startTime: 1, durationSeconds: null }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM contests').get()!.c, 3);
    assert.equal(
      db.prepare('SELECT start_time FROM contests WHERE platform=? AND contest_id=?').get('codeforces', 339)!.start_time,
      1377531000,
    );
    const durations = (db
      .prepare('SELECT contest_id, duration_seconds FROM contests WHERE platform=? ORDER BY contest_id')
      .all('codeforces') as { contest_id: number; duration_seconds: number | null }[])
      .map((r) => ({ contest_id: r.contest_id, duration_seconds: r.duration_seconds }));
    assert.deepEqual(durations, [
      { contest_id: 339, duration_seconds: 7200 },
      { contest_id: 2261, duration_seconds: null },
    ]);
  } finally {
    db.close();
  }
});

test('填写用时必须先有 AC 记录；写入覆盖、可清除、随用户级联删除', () => {
  const db = openDatabase(':memory:');
  try {
    const userId = Number(db.prepare('INSERT INTO users(name,is_self) VALUES(?,1)').run('t').lastInsertRowid);
    const accountId = Number(
      db.prepare('INSERT INTO accounts(user_id,platform,handle,handle_key) VALUES(?,?,?,?)').run(userId, 'codeforces', 'h', 'h').lastInsertRowid,
    );
    const add = db.prepare(
      `INSERT INTO submissions(account_id,platform,submission_id,problem_id,problem_title,status,submitted_at,difficulty)
       VALUES(?,?,?,?,?,?,?,?)`,
    );
    add.run(accountId, 'codeforces', 's1', '4:A', 'Watermelon', 'AC', 2000, 800);
    add.run(accountId, 'codeforces', 's2', '4:A', 'Watermelon', 'AC', 1000, 800);
    add.run(accountId, 'codeforces', 's3', '1:A', 'Theatre Square', 'WA', 500, 800);

    const rows = listDxEntries(db, userId, 'codeforces');
    assert.equal(rows.length, 1, '只有 AC 的题进清单');
    assert.equal(rows[0].solvedAt, 1000, 'solvedAt 取最早的 AC 时间');
    assert.equal(rows[0].problemRating, 800);

    // 出题日期按 problem_id 前缀（`4:A` → 4）从 contests 联出来。还没抓过比赛列表时是 null，
    // 不是 0 —— 0 会被读成「1970 年出的题」，那是编出来的事实。
    assert.equal(rows[0].releasedAt, null);
    db.prepare('INSERT INTO contests(platform,contest_id,name,start_time) VALUES(?,?,?,?)').run(
      'codeforces', 4, 'Codeforces Round 4', 1290000000,
    );
    assert.equal(listDxEntries(db, userId, 'codeforces')[0].releasedAt, 1290000000);
    // 题号里没有冒号时前缀取不到数字，联不上任何比赛 → null，而不是砸在 SQL 上。
    add.run(accountId, 'codeforces', 's4', 'NOID', 'Odd problem', 'AC', 3000, 800);
    assert.equal(listDxEntries(db, userId, 'codeforces').find((r) => r.problemId === 'NOID')!.releasedAt, null);

    const code = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (error) {
        return error instanceof DxTimeError ? error.code : 'OTHER';
      }
    };
    assert.equal(code(() => setProblemTime(db, { userId, platform: 'codeforces', problemId: '1:A', seconds: 600 })), 'PROBLEM_NOT_SOLVED');
    assert.equal(code(() => setProblemTime(db, { userId, platform: 'codeforces', problemId: '4:A', seconds: 0 })), 'TIME_INVALID');
    assert.equal(code(() => setProblemTime(db, { userId, platform: 'codeforces', problemId: '4:A', seconds: 3600 * 25 })), 'TIME_INVALID');
    assert.equal(code(() => setProblemTime(db, { userId, platform: 'luogu', problemId: '4:A', seconds: 600 })), 'PLATFORM_UNSUPPORTED');
    assert.equal(code(() => setProblemTime(db, { userId: 999, platform: 'codeforces', problemId: '4:A', seconds: 600 })), 'USER_NOT_FOUND');

    assert.equal(setProblemTime(db, { userId, platform: 'codeforces', problemId: '4:A', seconds: 600 }).created, true);
    assert.equal(setProblemTime(db, { userId, platform: 'codeforces', problemId: '4:A', seconds: 900 }).created, false);
    const d = (id: string) => listDxEntries(db, userId, 'codeforces').find((r) => r.problemId === id)!;
    assert.equal(d('4:A').recordedSeconds, 900);

    assert.equal(clearProblemTime(db, { userId, platform: 'codeforces', problemId: '4:A' }).cleared, true);
    assert.equal(clearProblemTime(db, { userId, platform: 'codeforces', problemId: '4:A' }).cleared, false);

    // 删用户要连带清掉用时，否则会留下指向不存在用户的孤儿行。
    setProblemTime(db, { userId, platform: 'codeforces', problemId: '4:A', seconds: 600 });
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM problem_times').get()!.c, 0);
  } finally {
    db.close();
  }
});


test('B35/B15 同分时使用未四舍五入的完成度，封顶后更快的成绩优先进入榜位', () => {
  const since = 1;
  for (const [releasedAt, size, section] of [[0, OLD_SLOTS, 'old'], [1, NEW_SLOTS, 'current']] as const) {
    const rows = Array.from({ length: size }, (_, i) => entry({
      problemId: 'a:' + i, releasedAt, recordedSeconds: 100,
    }));
    // 两条极快成绩的显示完成度取四位小数后相同，但原始完成度不同。
    rows.push(entry({ problemId: 'z:slow', releasedAt, recordedSeconds: 1.001 }));
    rows.push(entry({ problemId: 'zz:fast', releasedAt, recordedSeconds: 1 }));
    const board = buildBoard(rows, since);
    const slots = board[section];
    assert.equal(slots[0].entry!.problemId, 'zz:fast');
    assert.equal(slots[1].entry!.problemId, 'z:slow');
    assert.equal(slots[0].score!.rating, slots[1].score!.rating);
    assert.equal(slots[0].score!.achievementShown.toFixed(4), slots[1].score!.achievementShown.toFixed(4));
    assert.ok(slots[0].score!.achievement > slots[1].score!.achievement);
    assert.equal(slots.length, size);
    assert.deepEqual(buildBoard([...rows].reverse(), since)[section], slots);
  }
});
