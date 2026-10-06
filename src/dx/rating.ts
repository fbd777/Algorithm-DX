/**
 * Codeforces → maimai DX Rating 的换算 —— **唯一实现**。
 *
 * 规则出处：docs/cf-maimai-study.md「用时 → 单题 rating」一节，2026-09-18 由 Ryan 确认。
 * 形态照搬 maimai DX 的单谱面 rating：
 *
 *     maimai: 单谱面 Rating = 定数 × (达成率 / 100) × 评级系数(达成率)
 *
 * 关键在那层**评级系数** —— 它是按档位查表的常数（SSS+ 22.4、S 20.0、AAA 16.8 …），
 * 不是常数倍。这里把它的**比例**整条搬过来，归一到「97% = 1.000」，因为 T97 的定义
 * 就是「完成度 97% 所需的用时」：
 *
 *     A = 完成度，%；它是 t/T97 的**连续函数** —— 用时 ≤ T97 走 TOP_TIME_RATIOS 的六个
 *     锚定节点之间线性插值（比首节点还快就沿独立尾段趋近 101%），更慢时才回到
 *     ln(用时/T97) = a*d + b*d²，d = 97 - A
 *     factor(A) = A × 评级系数(A) / (97 × 20.0)
 *     单题 rating = (题目 Rating / 50) × factor(A)
 *     总 Rating  = 各格单题 rating 之和（旧题 35 + 新题 15）
 *
 * 于是：
 *
 *     用时 = T97       → A = 97    → factor 1.000 → 1400 的题得 28.0（S）
 *     用时 = 0.646×T97 → A = 100.5 → factor 1.257 → 1400 的题得 35.2（SSS+，拿满）
 *
 * **「97 对应 题目 Rating ÷ 50」是锚点，不是满分。** 满分在 100.5%（SSS+），比锚点高
 * 1.257 倍而不是 1.036 倍 —— 其中有三层：达成率本身、系数从 20.0 涨到 22.4 的那一段，
 * 以及 `TOP_FACTOR_GAIN` 这一层放大（见该常量的注释）。
 * S 到 SSS+ 六档的**用时门槛**不按 maimai 的分数档位折算，由 `TOP_TIME_RATIOS` 给出。
 *
 * 取榜规则（b35 + b15，与 maimai 的 Best35 / Best15 同形）：
 *
 *     旧题区 = **出题日期**早于本年度 1 月 1 日的题，取单题 rating 最高的 35 道
 *     新题区 = **出题日期**在本年度 1 月 1 日及以后的题，取单题 rating 最高的 15 道
 *
 * 分板看的是题目的**出题日期**（它所属比赛的开始时间），**不是 AC 时间**：
 * 2026 年切掉一道 2013 年的题，它仍然属于旧题区。查不到出题日期的题按旧题处理。
 * 出题日期不在提交载荷里，由 `contests` 表提供（见 `db/migrations/006-contest.sql`）。
 *
 * 三点刻意的选择，都可以在这里一处改掉：
 *  1. 系数表是**阶梯**（档内常数），于是每一处 rank 门槛上都会跳一下。最大的是 97.00%
 *     那道（AAA 的 0.814 → S 的 1.000，+19%）；S 以上另有四道小台阶（98 / 99 / 99.5 / 100），
 *     各约 1.5%–2.5%。用时分段线把门槛钉死在 0.939 / 0.846 / 0.797 / 0.732 × T97 上，
 *     所以这四道台阶都有明确的时间坐标，而不是笼统的「A 的 99.0% 与 100.0% 处」。
 *     这是 maimai 的原样。maimai 另有几个宽度 0.0001 的临界特例
 *     （100.4999 → 22.2、99.9999 → 21.4、96.9999 → 17.6、79.9999 → 12.8），折算到本地
 *     的输入精度（用时按整秒填）窗口只有几毫秒、不可达，因此未收录。
 *  2. A < 50 不计分 —— 这条是**本项目的取舍**，不是 maimai 的规则。
 *     新慢速曲线下该门槛非常遥远，不能再用它约束不合理的耗时输入。
 *  3. **完成度连续趋近理论极限 101%**：比 SSS+ 门槛还快时使用独立尾段
 *     A = 101 - 0.5 × (t/T97) / 0.646（2026-09-22）。正用时在数学上始终小于 101，
 *     不再把所有 ≤0.56×T97 的成绩截成 101%。评分仍按 100.5 封顶，
 *     所以本次尾段调整不影响单题 Rating、Rank 或 B50 排序。
 *
 * 本模块是纯函数，不碰数据库、不碰网络，好测也好复用。
 */
import { DX_CURVE } from './curve.ts';
import type { ContestTimelineRow, DxBoard, DxCurve, DxEntry, DxPending, DxScore, DxSlot } from './types.ts';

/** 完成度显示上限。 */
export const ACHIEVEMENT_DISPLAY_MAX = 101;
/**
 * 完成度显示到小数点后几位。maimai 的达成率本来就印 4 位（100.5000%），这里跟着用 4 位。
 *
 * 这不是装饰：完成度是 `t/T97` 的**连续函数**（节点间线性插值、比 SSS+ 还快沿尾段趋近 101），
 * 真实位数本来就多；截到 1 位会把「快一点和快很多不一样」这件事又抹平掉。
 * 前端 `public/dx.js` 里 `toFixed()` 的位数与它同步，改一处就要改另一处。
 */
export const ACHIEVEMENT_DISPLAY_DECIMALS = 4;
/** 参与评分的完成度上限。 */
export const ACHIEVEMENT_RATING_MAX = 100.5;
/** 低于这个完成度不计分。 */
export const ACHIEVEMENT_RATING_MIN = 50;
/** T97 的定义：用时 = T97 时完成度就是 97%。 */
export const T97_ACHIEVEMENT = 97;
/** 单题 rating 的分母：50 格全满时总分等于各格定数之和。 */
export const PROBLEM_RATING_DIVISOR = 50;
/** 旧题格数（上 7×5）。 */
export const OLD_SLOTS = 35;
/** 本年度新题格数（下 3×5）。 */
export const NEW_SLOTS = 15;
/**
 * 计榜平台。目前只有 Codeforces：它的题目 Rating 是官方给的数字，可以直接充当难度锚点
 * （对应 maimai 的「定数」那一层）。洛谷只提供等级码（0–4），要凑出锚点得先做一套人为
 * 映射，那是另一个决定，不在本轮。
 */
export const DX_PLATFORM = 'codeforces';

/**
 * Rank 门槛，抄自文档第 26 行；顺序必须从高到低。
 *
 * 导出是为了让「各难度拿各评级的用时」这类**展示**也走同一张表 ——
 * 门槛只能在这里改，别处不许再抄一份数字（`docs` 与界面都从这里取）。
 */
export const RANK_LADDER: readonly (readonly [string, number])[] = [
  ['SSS+', 100.5], ['SSS', 100], ['SS+', 99.5], ['SS', 99], ['S+', 98], ['S', 97],
  ['AAA', 94], ['AA', 90], ['A', 80], ['BBB', 75], ['BB', 70], ['B', 60], ['C', 50],
];

/** 对外展示的六档（S 及以上），从高到低。由 `RANK_LADDER` 派生，不另抄数字。 */
export const DISPLAY_RANKS: readonly (readonly [string, number])[] = RANK_LADDER.filter(
  ([, floor]) => floor >= T97_ACHIEVEMENT,
);

/**
 * S 及以上六档的用时门槛，写成「用时 ÷ T97」。
 *
 * 这一列**不是**从 maimai 的分数档位折算来的。折算的结果是 0.965 / 0.970 / 0.975 /
 * 0.980 / 0.990 / 1.000：六档一共只用掉 3.5% 的时间余量，在 800 档上相邻两档只差 **6 秒**，
 * 标签等于没有信息量。根因是把 maimai 的**分数**档位（高手挤在 1% 以内，0.5% 一档有意义）
 * 原样搬到了「用时的倒数」上，而用时是散开的（800 档 P10/P50/P90 = 397 / 1216 / 3619 秒）。
 *
 * 改成按**等效选手 Rating** 锚定（2026-09-18 定，推导与数据见 `results/cf-study/PLAYER_ANCHOR.md`）：
 *
 *     t_rank(q) = 中位用时( 题目 Rating = q ｜ 选手赛前 Rating ≈ q × 系数因子 )
 *
 * 本项目里 `总 Rating = 各格单题 rating 之和（50 格）`，所以「单题 rating × 50」就是等效 CF
 * Rating；S 档（系数因子 1.000）的参照选手正好是 rating ≈ q 的人 —— **这正是 T97 原本的
 * 定义**。这条规则没有另起炉灶，只是把同一个锚点沿系数因子往上推。
 *
 * 四个灵敏度配置（参照半径 ±75/±100/±150 × σ 50/75/100）下这六个数都稳在 ±0.015 内。
 *
 * **2026-09-18 二次重锚（K = 1.6 之后）**：`TOP_FACTOR_GAIN` 把 S 以上的系数因子整体抬高了，
 * 于是每一档的参照选手都变得更强（SSS+ 从 1.160q 变成 1.257q），中位用时随之变短 ——
 * 六个数从 0.755/0.822/0.872/0.905/0.963 收紧到 **0.646/0.732/0.797/0.846/0.939**。
 * 这是**自洽的而不是变难了**：SSS+ 现在的含义是「等效 Rating ≈ 1.257 × 题目 Rating」，
 * 比旧口径的 1.160q 高，理所当然要用更快的用时才够得着。S 档（1.000）不受影响，仍是 T97。
 * ⚠️ 改 `TOP_FACTOR_GAIN` 之后**必须重跑** `anchor-by-player-rating.mjs` 并重填这六个数；
 * 反过来只改这六个数而不改 K，会让「档位」与「它宣称的等效 Rating」对不上。
 *
 * 只覆盖 S 及以上：再往下（AAA / AA）参照选手跌到题目 Rating 的 81% / 71%，超出采集窗口
 * 且样本只剩几十条，比值已经不稳（1200 档 AAA 与 AA 甚至反序）。S 以下使用独立的设计曲线。
 */
const TOP_TIME_RATIOS: readonly (readonly [string, number])[] = [
  ['SSS+', 0.646], ['SSS', 0.732], ['SS+', 0.797], ['SS', 0.846], ['S+', 0.939], ['S', 1.000],
];

/** S 以下的设计曲线：ln(t/T97) = a*d + b*d²，d = 97 - A。 */
export const SLOW_DECAY_LINEAR = Math.log(1 / TOP_TIME_RATIOS.find(([rank]) => rank === 'SSS')![1]) / 3;
/** 正二次项保证每下降相同百分点，所需时间倍率严格增加。 */
export const SLOW_DECAY_QUADRATIC = 0.01;

/**
 * `TOP_TIME_RATIOS` 的 (用时比, 完成度) 节点，用时比升序、完成度降序。
 *
 * 这六个**节点**是「已知点」，不是「全部取值」：完成度按 `achievementFromSeconds` 在节点之间
 * **连续插值**算出，所以 0.98 × T97 这种落在两节点之间的用时拿到的是一段线性映射上的中间值，
 * 不是什么门槛值。节点上的完成度一律回 `RANK_LADDER` 取（那六个数来自 maimai 的系数表），
 * 不在这里再抄一遍 —— 两边对不上就直接抛。
 */
const TOP_KNOTS: readonly (readonly [number, number])[] = TOP_TIME_RATIOS.map(([rank, ratio]) => {
  const row = RANK_LADDER.find(([name]) => name === rank);
  if (!row) throw new Error(`RANK_LADDER 里没有 ${rank}，TOP_TIME_RATIOS 与它不同步`);
  return [ratio, row[1]] as const;
});
if (TOP_KNOTS.length < 2) throw new Error('TOP_KNOTS 至少要有两个节点才能定义斜率');

/** 用时趋近 0 时的理论极限；正用时在数学上达不到它。 */
export const ACHIEVEMENT_COMPUTED_MAX = ACHIEVEMENT_DISPLAY_MAX;

/**
 * maimai DX 的「达成率 → 评级系数」阶梯表，**从高到低**排列。
 *
 * 出处：萌娘百科 maimai DX 词条与 gekichumai 的 DXRating 计算器（文档第 28 行引的就是后者），
 * 两处数值一致。取法是「找出 ≤ A 的最大门槛，用这一行的系数」，所以档内是常数 ——
 * 它是阶梯而不是插值曲线，档位交界处会跳。
 *
 * 表里保留 50 以下的行，是为了让「A < 50 不计分」保持成本项目自己的一条规则、而不是
 * 悄悄藏进表里；改 `ACHIEVEMENT_RATING_MIN` 就能放开。
 */
const SCORE_COEFFICIENTS: readonly (readonly [number, number])[] = [
  [100.5, 22.4], // SSS+
  [100, 21.6], // SSS
  [99.5, 21.1], // SS+
  [99, 20.8], // SS
  [98, 20.3], // S+
  [97, 20.0], // S ← 锚点。factor 的分母就是「这一档 × 97」
  [94, 16.8], // AAA
  [90, 15.2], // AA
  [80, 13.6], // A
  [75, 12.0], // BBB
  [70, 11.2], // BB
  [60, 9.6], // B
  [50, 8.0], // C
  [40, 6.4], // D
  [30, 4.8],
  [20, 3.2],
  [10, 1.6],
  [0, 0],
];

/** 97%（S）处的评级系数，也就是 factor 的归一化基准。 */
export const COEFFICIENT_AT_T97 = 20.0;

/**
 * 97% → 100.5% 这段台阶的**放大倍数** K。改这一个数就能整体调「练稳了值多少分」。
 *
 *     factor(A) = A × 系数(A) ÷ (97 × 20)                    当 A ≤ 97（不动）
 *     factor(A) = 1 + (上面那个值 − 1) × K                    当 97 < A ≤ 100.5
 *
 * A = 97 处两端都是 1.000，天然接上；段内 98 / 99 / 99.5 / 100 / 100.5 的**相对比例一字不改**
 * —— 变的是整段的幅度，不是形状。所以 maimai 那道「越接近满分回报越陡」的悬崖被完整保留，
 * 只是被拉高了。K = 1.00 就是 maimai 原样。
 *
 * **K = 1.60 是怎么来的**（推导与对照表见 `results/cf-study/MAIMAI_SCALE.md`）：
 *  1. Ryan 定的语义：**97% = 刚好这题的水平（50% 把握）**，**100% = 几乎稳定切**。
 *  2. 「稳定切」的实测值：5,171,771 个 (选手, 题) 对上，90% 解出率对应 Rating 差 **+217**，
 *     且这个差**不随题目难度变**（各难度区间的 50% 点一致，见 `SOLVE_RATE_PROBE.md`）。
 *  3. 他不要求按难度做差异化系数，于是取一个**确定的系数**：在加权平均难度 E[Q] = 1197 上
 *     折算，(1197 + 217) ÷ 1197 = **1.1813**，即 100% 处的 factor。
 *  4. maimai 原样在 100% 处是 1.1134，所以 K = (1.1813 − 1) ÷ (1.1134 − 1) = **1.599 ≈ 1.60**。
 *
 * **已知的代价（不是 bug，是乘性这个形状自带的）**：K 乘的是题目 Rating，所以同一个完成度
 * 在不同难度上换到的**绝对分差**不同 —— 1200 的题 @100% 等效 +218、2000 的题等效 +363，
 * 而实测说两处都该是 +217。要让它们一样，得把形状换成**加性** `(题目 Rating + Δ(A)) ÷ 50`
 * （Δ(100%) = 217）。那是另一处改动，等 Ryan 定。
 */
export const TOP_FACTOR_GAIN = 1.6;

/** 查完成度落在哪一档，返回该档系数。 */
export function coefficientFromAchievement(achievement: number): number {
  for (const [floor, coefficient] of SCORE_COEFFICIENTS) {
    if (achievement >= floor) return coefficient;
  }
  return 0;
}

/** Rank 门槛查表，顺序从高到低。 */
export function rankOf(achievement: number): string {
  for (const [name, floor] of RANK_LADDER) if (achievement >= floor) return name;
  return 'D';
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 解析模型直接求 T97；旧网格模型档间线性插值。
 * 超出启用范围时夹取端点并标记 extrapolated；实际拟合输入范围由 calibrationMinQ/MaxQ 说明。
 */
export function lookupT97(
  problemRating: number,
  curve: DxCurve = DX_CURVE,
): { seconds: number; extrapolated: 'below' | 'above' | null } {
  const points = curve.points;
  if (!points.length) throw new Error('T97 曲线为空');
  const first = points[0];
  const last = points[points.length - 1];
  if (problemRating <= first[0]) {
    return { seconds: first[1], extrapolated: problemRating < first[0] ? 'below' : null };
  }
  if (problemRating >= last[0]) {
    return { seconds: last[1], extrapolated: problemRating > last[0] ? 'above' : null };
  }
  if (curve.formula) {
    const f = curve.formula;
    const delta = problemRating - f.originQ;
    return { seconds: 60 * (f.baselineMinutes + f.slopeMinutesPerRating * delta -
      f.gainMinutes * Math.expm1(-delta / f.scaleRating)), extrapolated: null };
  }
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= problemRating) lo = mid;
    else hi = mid;
  }
  const [q0, s0] = points[lo];
  const [q1, s1] = points[hi];
  const t = (problemRating - q0) / (q1 - q0);
  return { seconds: s0 + (s1 - s0) * t, extrapolated: null };
}

/**
 * 完成用时 → 完成度 —— **连续函数，没有台阶**。
 *
 * 用时 ≤ T97（S 及以上）在 `TOP_KNOTS` 的六个锚定节点之间**线性插值**：踩到某个节点时
 * 完成度正好等于那一档的下限（S+ 恰好 98、SSS+ 恰好 100.5），落在节点之间就按比例取值 ——
 * S（1.000 × T97 ↔ 97%）与 S+（0.939 × T97 ↔ 98%）之间的 0.98 × T97 拿到的是 **97.33%**，
 * 而不是 97 或 98 —— 所以它显示时要留住小数（见 `ACHIEVEMENT_DISPLAY_DECIMALS`）。
 *
 * 比 SSS+ 门槛还快时走独立尾段 A = 101 - 0.5 × r / 0.646，
 * 与 100.5% 连续衔接，用时趋近 0 时才趋近 101%。评分仍在 100.5% 封顶。
 *
 * 用时 > T97（S 以下）解 ln(t/T97) = a*d + b*d²，d = 97 - A；结果最低为 0。
 * a 参考 100→97 的时间比，b=0.01 是设计参数，非实测分位点。
 * 两条在用时 = T97 处接上（都是 97），整条随用时单调不增。
 */
export function achievementFromSeconds(seconds: number, t97Seconds: number): number {
  if (!(seconds > 0) || !Number.isFinite(seconds)) throw new RangeError('完成用时必须是有限正数');
  if (!(t97Seconds > 0) || !Number.isFinite(t97Seconds)) throw new RangeError('T97 必须是有限正数');
  const ratio = seconds / t97Seconds;
  const [topRatio, topAchievement] = TOP_KNOTS[0];
  if (ratio < topRatio) {
    return ACHIEVEMENT_COMPUTED_MAX -
      (ACHIEVEMENT_COMPUTED_MAX - topAchievement) * (ratio / topRatio);
  }
  if (ratio >= 1) {
    // 用有理化的正根避免 T97 附近相减丢失精度；对有限输入的比值溢出也保持有限结果。
    const logRatio = Number.isFinite(ratio) ? Math.log(ratio) : Math.log(seconds) - Math.log(t97Seconds);
    const drop = 2 * logRatio / (SLOW_DECAY_LINEAR +
      Math.sqrt(SLOW_DECAY_LINEAR ** 2 + 4 * SLOW_DECAY_QUADRATIC * logRatio));
    return Math.max(0, T97_ACHIEVEMENT - drop);
  }
  for (let i = 0; i + 1 < TOP_KNOTS.length; i += 1) {
    const [loRatio, loAchievement] = TOP_KNOTS[i];
    const [hiRatio, hiAchievement] = TOP_KNOTS[i + 1];
    if (ratio <= hiRatio) {
      const share = (ratio - loRatio) / (hiRatio - loRatio);
      return loAchievement + (hiAchievement - loAchievement) * share;
    }
  }
  throw new Error('TOP_KNOTS 没有覆盖这个用时比，节点表不完整');
}

/**
 * 完成度 → 用时比（用时 ÷ T97），`achievementFromSeconds` 的精确逆。
 *
 * 用时 = T97 时是 1.000（S 的锚点）；SSS+（100.5%）要压到 0.646 × T97 以内；
 * 100.5% 以上反算独立尾段；101% 返回理论边界 0，超过 101% 没有对应用时。
 * S 以下（完成度 < 97）用 r = exp(a*d + b*d²)，d = 97 - A。
 */
export function timeRatioFromAchievement(achievement: number): number {
  if (!(achievement > 0)) throw new RangeError('完成度必须是正数');
  if (achievement > ACHIEVEMENT_COMPUTED_MAX) throw new RangeError('完成度不能超过理论极限 101%');
  const [topRatio, topAchievement] = TOP_KNOTS[0];
  if (achievement > topAchievement) {
    return topRatio * (ACHIEVEMENT_COMPUTED_MAX - achievement) /
      (ACHIEVEMENT_COMPUTED_MAX - topAchievement);
  }
  if (achievement <= T97_ACHIEVEMENT) {
    const drop = T97_ACHIEVEMENT - achievement;
    return Math.exp(SLOW_DECAY_LINEAR * drop + SLOW_DECAY_QUADRATIC * drop ** 2);
  }
  for (let i = 0; i + 1 < TOP_KNOTS.length; i += 1) {
    const [loRatio, loAchievement] = TOP_KNOTS[i];
    const [hiRatio, hiAchievement] = TOP_KNOTS[i + 1];
    if (achievement >= hiAchievement) {
      const share = (loAchievement - achievement) / (loAchievement - hiAchievement);
      return loRatio + (hiRatio - loRatio) * share;
    }
  }
  throw new Error('TOP_KNOTS 没有覆盖这个完成度，节点表不完整');
}

/**
 * 完成度 → 完成用时，`achievementFromSeconds` 的精确逆。
 *
 * 用于展示与文档出表，不参与评分（评分永远走 `achievementFromSeconds` 那个方向）。
 */
export function secondsForAchievement(
  problemRating: number,
  achievement: number,
  curve: DxCurve = DX_CURVE,
): { seconds: number; extrapolated: 'below' | 'above' | null } {
  if (!(achievement > 0)) throw new RangeError('目标完成度必须是正数');
  const { seconds: t97Seconds, extrapolated } = lookupT97(problemRating, curve);
  return { seconds: timeRatioFromAchievement(achievement) * t97Seconds, extrapolated };
}

/**
 * 完成度 → 系数因子。
 *
 *     factor(A) = A × 评级系数(A) / (97 × 20.0)                  A ≤ 97
 *     factor(A) = 1 + (上面那个值 − 1) × TOP_FACTOR_GAIN          97 < A ≤ 100.5
 *
 * 所以「用时 = T97」时 factor 恰好是 1.000（单题 rating = 题目 Rating ÷ 50），
 * 而满分在 100.5%（SSS+）处取到 1 + (100.5 × 22.4 / 1940 − 1) × 1.6 = 1.257。
 * 97% 以下（AAA 及以下）**不受 K 影响**，仍按 `A × 系数 ÷ 1940`，与 maimai 原样一致。
 */
export function factorFromAchievement(achievement: number): number {
  if (achievement < ACHIEVEMENT_RATING_MIN) return 0;
  const capped = Math.min(achievement, ACHIEVEMENT_RATING_MAX);
  const maimai =
    (capped * coefficientFromAchievement(capped)) / (T97_ACHIEVEMENT * COEFFICIENT_AT_T97);
  // 97% 是锚点：K 只作用在它「以上」的那一截，所以两端在这里都是 1.000，天然接上。
  return capped > T97_ACHIEVEMENT ? 1 + (maimai - 1) * TOP_FACTOR_GAIN : maimai;
}

/**
 * 算一道题的单题 rating。缺少题目 Rating 或没填用时都返回 null —— 这两种题不进榜。
 */
export function scoreProblem(
  entry: DxEntry,
  curve: DxCurve = DX_CURVE,
  achievementForTime: typeof achievementFromSeconds = achievementFromSeconds,
): DxScore | null {
  if (entry.problemRating === null || entry.recordedSeconds === null) return null;
  const { seconds: t97Seconds, extrapolated } = lookupT97(entry.problemRating, curve);
  const achievement = achievementForTime(entry.recordedSeconds, t97Seconds);
  const factor = factorFromAchievement(achievement);
  return {
    t97Seconds,
    extrapolated,
    achievement,
    achievementShown: Math.min(achievement, ACHIEVEMENT_DISPLAY_MAX),
    rank: rankOf(achievement),
    rating: round1((entry.problemRating / PROBLEM_RATING_DIVISOR) * factor),
    factor,
  };
}

/** 同分优先实际完成度；完成度相同则用时更短在前，最后以定数和题号稳定排序。 */
function byRatingThenAchievement(a: { entry: DxEntry; score: DxScore }, b: { entry: DxEntry; score: DxScore }): number {
  return (
    b.score.rating - a.score.rating ||
    b.score.achievement - a.score.achievement ||
    (a.entry.recordedSeconds ?? Infinity) - (b.entry.recordedSeconds ?? Infinity) ||
    (b.entry.problemRating ?? 0) - (a.entry.problemRating ?? 0) ||
    a.entry.problemId.localeCompare(b.entry.problemId)
  );
}

const padSlots = (list: readonly { entry: DxEntry; score: DxScore }[], size: number): DxSlot[] =>
  Array.from({ length: size }, (_, i) => ({
    position: i + 1,
    entry: list[i]?.entry ?? null,
    score: list[i]?.score ?? null,
  }));

/**
 * 生成整张 DX 榜。
 *
 * @param entries 该用户所有 AC 的 CF 题（含没填用时的，会被 `scoreProblem` 过滤掉）
 * @param currentYearStart 本年度起点（epoch 秒，本地时区的 1 月 1 日 0 点）
 *
 * 分板看的是**出题日期**（`releasedAt`，即比赛开始时间），不是 AC 时间 ——
 * 2026 年切掉一道 2013 年的题（例如 339:A，Codeforces Round 197），它属于旧题区 b35；
 * 只有本年度新办的比赛里的题才进 b15。查不到出题日期的题**按旧题处理**：
 * 旧题区有 35 格、且是「默认归属」，比把一道 2013 年的题塞进 b15 更不容易误导。
 *
 * 总分是**各格已取整到 1 位小数的单题 rating 之和** —— 这样才能和界面上显示的数字对得上。
 */
export function buildBoard(
  entries: readonly DxEntry[],
  currentYearStart: number,
  curve: DxCurve = DX_CURVE,
  achievementForTime: typeof achievementFromSeconds = achievementFromSeconds,
): DxBoard {
  const scored: { entry: DxEntry; score: DxScore }[] = [];
  for (const entry of entries) {
    const score = scoreProblem(entry, curve, achievementForTime);
    if (score) scored.push({ entry, score });
  }
  const isCurrent = (e: DxEntry): boolean => e.releasedAt !== null && e.releasedAt >= currentYearStart;
  const seen=new Set<string>();
  const distinct=scored.sort(byRatingThenAchievement).filter(x=>{const key=x.entry.platform+':'+(x.entry.canonicalProblemId??x.entry.problemId);if(seen.has(key))return false;seen.add(key);return true;});
  const old = distinct.filter((x) => !isCurrent(x.entry)).slice(0, OLD_SLOTS);
  const current = distinct.filter((x) => isCurrent(x.entry)).slice(0, NEW_SLOTS);
  const oldSlots = padSlots(old, OLD_SLOTS);
  const currentSlots = padSlots(current, NEW_SLOTS);
  const rating = [...oldSlots, ...currentSlots].reduce((sum, slot) => sum + (slot.score?.rating ?? 0), 0);
  return {
    total: old.length + current.length,
    old: oldSlots,
    current: currentSlots,
    oldCount: old.length,
    currentCount: current.length,
    rating: round1(rating),
  };
}

/**
 * 生成「待填写用时」清单。
 *
 * 三条规则：
 *  1. 只收**还没填用时**的题。未评定（`problemRating === null`，CF 还没公布评级）的题
 *     **照收**：用时是手填的、与评级无关，现在就能填；评级一旦由同步回填，
 *     `buildBoard` 下一次读取就会把它计分进榜 —— 不需要任何人再动它。
 *     两者在清单里靠「未评定」标记区分，缺多少评级由 `counts.missingRating` 另行报数。
 *  2. 排序按 **AC 时间倒序** —— 刚切掉的题就是要马上去填的那一道。
 *     同一秒 AC 的用题号兜底，保证顺序稳定可复现。
 *  3. `isCurrent` 按**出题日期**判（与 `buildBoard` 同一口径），供列表标注「新题 / 旧题」。
 */
export function buildPending(entries: readonly DxEntry[], currentYearStart: number): DxPending[] {
  const pending: DxPending[] = [];
  for (const entry of entries) {
    if (entry.recordedSeconds !== null) continue;
    pending.push({
      problemId: entry.problemId,
      problemTitle: entry.problemTitle,
      problemUrl: entry.problemUrl,
      problemRating: entry.problemRating,
      releasedAt: entry.releasedAt,
      solvedAt: entry.solvedAt,
      isCurrent: entry.releasedAt !== null && entry.releasedAt >= currentYearStart,
      // 比赛自动计时由 api 层用 computeContestAutoSeconds 的结果覆盖；
      // 这里先置 null，保证没算（或算不出）时字段存在且诚实。
      autoSeconds: null,
    });
  }
  return pending.sort((a, b) => b.solvedAt - a.solvedAt || a.problemId.localeCompare(b.problemId));
}

/**
 * 「比赛自动计时」：从比赛窗口内的提交时间轴算每题的纯耗时（口径 B）。
 *
 * 规则（2026-09-21 Ryan 确认）：把一场比赛里切掉的题**按被切的时间顺序排列**，
 * 逐题自动计算 —— 第 k 题纯耗时 = 自己窗口内最早 AC − 上一道切掉的题的最早 AC，
 * 第一道减开赛。**不按题号顺序**：跳题（A→C→B）也成立，B 的纯耗时就是
 * 「切完 C 之后到切掉 B」的那段时间。
 *
 * 唯一的守卫：两道 AC 之间**穿插了别的题的提交**（比如切完 A 后 WA 了几发 B 才切 C，
 * 而 B 最终没在这场里切掉）时，那段减法区间掺了别题的时间 —— 该题不给自动值，
 * 宁缺毋滥。同一道题自己的 WA 提交在区间里不算穿插：那本来就是做它的时间。
 *
 * 纯函数，不碰数据库；原料由 `listContestTimeline`（queries.ts）提供。
 */
export function computeContestAutoSeconds(rows: readonly ContestTimelineRow[]): Map<string, number> {
  // 按比赛分组：problemId 冒号前的前缀就是比赛 id（CF 形态如 `2259:A`）。
  const byContest = new Map<string, ContestTimelineRow[]>();
  for (const row of rows) {
    const colon = row.problemId.indexOf(':');
    const key = colon > 0 ? row.problemId.slice(0, colon) : row.problemId;
    let list = byContest.get(key);
    if (!list) byContest.set(key, (list = []));
    list.push(row);
  }

  const result = new Map<string, number>();
  for (const list of byContest.values()) {
    const start = list[0].contestStart;
    // 窗口内每题的最早 AC（同一题多次 AC 只算第一次；WA 不算切掉）。
    const firstAc = new Map<string, number>();
    for (const row of list) {
      if (row.status !== 'AC') continue;
      const prev = firstAc.get(row.problemId);
      if (prev === undefined || row.submittedAt < prev) firstAc.set(row.problemId, row.submittedAt);
    }
    // 按被切的时间顺序排列 —— 这是口径 B 的排序依据，与题号顺序无关。
    const solved = [...firstAc.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

    let boundary = start; // 减法的左端：上一道切掉的时刻，第一道是开赛。
    for (const [problemId, ac] of solved) {
      // 守卫：区间 (boundary, ac) 内只能有**当前这题**的提交。
      // 等于 boundary 的那条是上一题的 AC 本身（或开赛时刻），不在区间内。
      const interleaved = list.some(
        (row) => row.submittedAt > boundary && row.submittedAt < ac && row.problemId !== problemId,
      );
      const seconds = ac - boundary;
      if (!interleaved && seconds >= 1) result.set(problemId, seconds);
      // 无论给不给值，下一题的左端都是这道题的 AC —— 时间轴往前走。
      boundary = ac;
    }
  }
  return result;
}

/**
 * 「各难度 × 各评级需要多快」的对照表。
 *
 * 存在理由：b50 的每个格子里原本都印着一道 `T97 xx:xx`，但那不是用户填的数，
 * 五十个格子重复五十遍只会挤掉真正要看的信息。所以把它收进一个按钮后面，
 * 想对照时再打开 —— 表本身仍然随时可查，只是不再占格子。
 *
 * **表由这里现算，不落库也不硬编码在前端**：曲线一换（`npm run study:export-dx`）
 * 或六档门槛一重锚，这张表必须跟着变。口径只有这一处。
 *
 * 与 `scripts/rank-time-table.ts` 的表 1 / 表 3 同源（那个脚本还多出「卡掉多少人」的
 * 占比表，需要读 `quantiles.csv`，不适合塞进前端，所以留在线下）。
 */
export interface RankTimeTable {
  /** 参考题目 Rating。只影响「单题 rating」那一列的举例数值，factor 本身与难度无关。 */
  referenceQ: number;
  /** 表头：S 及以上六档，从高到低。 */
  ranks: { rank: string; achievement: number }[];
  /** 每 100 分一档；`seconds` 与 `ranks` 同序。 */
  rows: { q: number; t97Seconds: number; seconds: number[]; windowSeconds: number }[];
  /** 评级 → 用时比 / factor / 单题 rating。与难度无关，所以只出一列。 */
  ladder: { rank: string; achievement: number; ratio: number; factor: number; rating: number }[];
}

export function buildRankTimeTable(curve: DxCurve = DX_CURVE, referenceQ = 1400, step = 100): RankTimeTable {
  const ranks = DISPLAY_RANKS.map(([rank, achievement]) => ({ rank, achievement }));
  const rows: RankTimeTable['rows'] = [];
  // 端点对齐到 step 的整数倍，免得最后一档因为曲线端点不是整百而静默失踪。
  const from = Math.ceil(curve.fitMinQ / step) * step;
  for (let q = from; q <= curve.fitMaxQ; q += step) {
    const seconds = ranks.map((r) => secondsForAchievement(q, r.achievement, curve).seconds);
    // 窗口 = S 减 SSS+：六个等级合起来只吃掉这么多时间余量，这个差值就是它的可读性指标。
    rows.push({ q, t97Seconds: lookupT97(q, curve).seconds, seconds, windowSeconds: seconds[seconds.length - 1] - seconds[0] });
  }
  const ladder = RANK_LADDER.filter(([, a]) => a >= ACHIEVEMENT_RATING_MIN).map(([rank, achievement]) => ({
    rank,
    achievement,
    ratio: timeRatioFromAchievement(achievement),
    factor: factorFromAchievement(achievement),
    rating: (referenceQ / PROBLEM_RATING_DIVISOR) * factorFromAchievement(achievement),
  }));
  return { referenceQ, ranks, rows, ladder };
}

/** 曲线自身的元信息，用于在界面上标明「这条曲线是哪次实验的、能不能信」。 */
export function curveInfo(curve: DxCurve = DX_CURVE): {
  generatedAt: string;
  sourceFile: string;
  sourceSha256: string;
  model: string;
  fitMinQ: number;
  fitMaxQ: number;
  calibrationMinQ: number;
  calibrationMaxQ: number;
  productionReady: boolean;
  productionReadyBasis: string;
} {
  return {
    generatedAt: curve.generatedAt,
    sourceFile: curve.sourceFile,
    sourceSha256: curve.sourceSha256,
    model: curve.model,
    fitMinQ: curve.fitMinQ,
    fitMaxQ: curve.fitMaxQ,
    calibrationMinQ: curve.calibrationMinQ ?? curve.fitMinQ,
    calibrationMaxQ: curve.calibrationMaxQ ?? curve.fitMaxQ,
    productionReady: curve.productionReady,
    productionReadyBasis: curve.productionReadyBasis,
  };
}
