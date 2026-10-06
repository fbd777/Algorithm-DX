// 「稳定做出」应该拿多少分 —— 把「完成度 → 等效 CF Rating」从**常数倍率**改成
// **Elo 绝对分差**。
//
// 起因（Ryan 2026-09-18）：
//   「我的意思是相对时间换算 rating 的系数可以改，比如让 1200 100.5 吃到 1600/50 的分」
//   「如果设定是 定数 ≈ R 的题上稳定拿 S 那就更不对了，因为定数 ≈ R 的选手做这道题
//     只有 50% 的能做出来（根据 cf 的定义），所以仍然有更改余地」
//   「保留 97% 仍然是刚好这题的水平，100% 再找一个稳定做出这题的水平的单题 rating
//     换算系数」
//
// 他说得对，而且现在的口径里有一处**内部不自洽**：
//   同样的完成度（例如 SSS+），在 1200 的题上隐含「75% 概率解出」，
//   在 2000 的题上隐含「86% 概率解出」—— 因为 factor 是**倍率**，而概率差是**绝对量**。
//
// 本脚本只做算术，不改任何生产口径。
import fs from 'node:fs/promises';

const root = 'results/cf-study';
const out = [];
const p = (s) => out.push(s);
const r1 = (x) => Math.round(x * 10) / 10;

// ---- 现状：照抄 src/dx/rating.ts，不 import（脚本要能独立跑） --------------------
const T97_ACHIEVEMENT = 97;
const COEFFICIENT_AT_T97 = 20.0;
const PROBLEM_RATING_DIVISOR = 50;
const ACHIEVEMENT_RATING_MAX = 100.5;
const SCORE_COEFFICIENTS = [
  [100.5, 22.4], [100, 21.6], [99.5, 21.1], [99, 20.8], [98, 20.3], [97, 20.0],
  [94, 16.8], [90, 15.2], [80, 13.6], [75, 12.0], [70, 11.2], [60, 9.6], [50, 8.0],
];
const coefficientFromAchievement = (a) => {
  for (const [floor, c] of SCORE_COEFFICIENTS) if (a >= floor) return c;
  return 0;
};
const factorNow = (a) => {
  if (a < 50) return 0;
  const capped = Math.min(a, ACHIEVEMENT_RATING_MAX);
  return (capped * coefficientFromAchievement(capped)) / (T97_ACHIEVEMENT * COEFFICIENT_AT_T97);
};
const scoreNow = (q, a) => r1((q / PROBLEM_RATING_DIVISOR) * factorNow(a));

// ---- CF 的 Elo 尺度：400 分 = 概率差 10 倍 ------------------------------------
// P(solve) = 1 / (1 + 10^((b − θ)/400))  ⇒  θ = b + 400 · log10(P / (1 − P))
// 题目 Rating 的官方定义就是「该 Rating 的选手 50% 概率解出」⇒ P = 0.5 时 θ = b。
const LOGIT_SCALE = 400;
const deltaFromP = (P) => LOGIT_SCALE * Math.log10(P / (1 - P));
const pFromDelta = (D) => 1 / (1 + 10 ** (-D / LOGIT_SCALE));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ---- 新方案：等效 rating = 题目 rating + Δ(完成度) -----------------------------
// Δ(97) = 0（保持「97% = 刚好这题的水平」），Δ(100) = Δ_stable，中间线性。
// 完成度 > 100 沿同一斜率继续（100.5% = 1.1667 × Δ_stable）。
// 完成度 < 97 一个字都不动（仍旧走 maimai 系数表），所以 97 处那道 +19% 的
// 台阶还在，没有新增不连续。
const deltaAt = (a, stable) => (a < T97_ACHIEVEMENT ? 0 : stable * (Math.min(a, ACHIEVEMENT_RATING_MAX) - T97_ACHIEVEMENT) / 3);
const equivalentNew = (q, a, stable) => q * (a < T97_ACHIEVEMENT ? factorNow(a) : 1) + deltaAt(a, stable);
const scoreNew = (q, a, stable) => r1(equivalentNew(q, a, stable) / PROBLEM_RATING_DIVISOR);

const RATED = [1200, 1400, 1600, 1800, 2000];
const STABLE_CANDIDATES = [
  { key: 'P=0.90', P: 0.9 },
  { key: 'P=10/11（你的直觉）', P: 10 / 11 },
  { key: 'P=0.95', P: 0.95 },
].map((x) => ({ ...x, delta: deltaFromP(x.P) }));

// ---- 实测校准：读 `solve-rate-probe.mjs` 的产出（那条口径的唯一出处在该脚本里） -------
let calibration = null;
try {
  calibration = JSON.parse(await fs.readFile(`${root}/solve-rate-calibration.json`, 'utf8'));
} catch { /* 没跑过解出率探针就没有这一节 */ }
const measuredDelta = (t) => calibration?.crossover?.find((x) => Math.abs(x.target - t) < 1e-9)?.delta ?? null;


p('# 「稳定做出」该拿多少分 —— 把换算锚回 CF 的概率定义');
p('');
p('> 生成：`node scripts/cf-study/stable-anchor.mjs`。现状那一列与 `src/dx/rating.ts` 逐字一致。');
p('> **本脚本只做算术，不改任何生产口径。**');
p('');

p('## 结论（先给答案）');
p('');
p('1. **你的质疑成立：现在同样的完成度在不同难度上说的不是同一件事。** `factor` 是**倍率**，');
p('   于是同样叫 SSS+，在 1200 的题上隐含「75% 概率解出」，在 2000 的题上隐含「86%」（表 5）。');
p('   ⚠️ 你已经选了「用确定的系数、不做难度差异化」—— 那是**用简洁换自洽**，代价是把表 5 那 11 个百分点留着。');
p('   本报告两条路都给：**表 9 是常数倍率（你的方案）**，表 3/4 是绝对分差（更自洽的那个）。');
p('2. **改法只有一处**：`factor` 在 97% 以上不再是 maimai 原样，而是按 `1 + (factor_maimai − 1) × K` 缩放；');
p('   Δ(97%) 仍然是 0（保持你的要求：97% 仍是「刚好能做出来」那一档 = 难度 ÷ 50），100% 处 = X，中间照 maimai 的段内比例。');
p('3. **你举的「1200 → 1600」有两种对齐方式，差 100 分**（表 2）：');
p('   按 100% 对齐 → X = 1.333（P = 90.9%）；按 100.5% 对齐 → X = 1.236。');
p('4. **实测校准（表 8）**：CF 官方 standings 里 517 万个 (选手, 题) 对直接数出来的解出率曲线说，');
p('   「稳定（90% 解出）」的 Δ 实测只有约 217（Elo 理论值 382）—— 表 9 的三个 X 就是这么来的。');
p('5. **连带影响**：S 以上五档的参照选手 = 「题目 Rating × 新的系数因子」，所以 `TOP_TIME_RATIOS`');
p('   的六个数值要跟着重锚（`anchor-by-player-rating.mjs`）；**T97 曲线本身不用动**（S 档锚点没变）。');
p('');

// ---- 表 1 -------------------------------------------------------------------
p('## 表 1 · 「稳定」对应多少分（Elo / CF 官方定义）');
p('');
p('CF 的尺度是 Elo：**400 分 = 胜负比 10 倍**，概率用 logistic 表示');
p('`P(解出) = 1 ÷ (1 + 10^((题目Rating − 选手Rating)/400))`。');
p('题目 Rating 的官方定义是「该 Rating 的选手有 **50%** 概率解出」，也就是下表 P = 50% 那一行；');
p('所以**「稳定做出」的等效 Rating 一定大于题目 Rating**，超出的量就是 Δ。');
p('');
p('| 解出概率 P | 需要的能力差 Δ = 选手 Rating − 题目 Rating | 「稳定」吗 |');
p('|---:|---:|---|');
for (const P of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 10 / 11, 0.95, 0.98, 0.99]) {
  const d = deltaFromP(P);
  const tag = P === 0.5 ? '← **CF 题目 Rating 的定义点**（不是「稳定」）'
    : Math.abs(P - 10 / 11) < 1e-9 ? '← **你的直觉**（1200 的题 → 1600）'
      : P >= 0.9 ? '常规意义的「稳定」'
        : '';
  p(`| ${pct(P)} | ${d.toFixed(1)} | ${tag} |`);
}
p('');
p('读法：**「能做出这道题」是 50%，「稳定做出这道题」是 90% 上下 —— 两者相差约 380 分。**');
p('现行口径把 97% 完成度（= 稳定做出）的等效 Rating 定在**刚好等于题目 Rating**（factor 1.000），');
p('等于把「稳定」当成「一半概率」，这就是你指出的那个毛病。');
p('');

// ---- 表 2 -------------------------------------------------------------------
p('## 表 2 · 反解你的目标值');
p('');
p('| 你的说法 | 需要的 Δ | 对应概率 | 若把这个概率定为「稳定」，则 |');
p('|---|---:|---:|---|');
{
  const cases = [
    { label: '1200 的题在 **100%** 拿 1600/50', q: 1200, a: 100, target: 1600 },
    { label: '1200 的题在 **100.5%** 拿 1600/50', q: 1200, a: 100.5, target: 1600 },
    { label: '1200 的题在 100% 拿 1500/50', q: 1200, a: 100, target: 1500 },
  ];
  for (const c of cases) {
    const needE = c.target;
    const needDeltaAtA = needE - c.q;
    const stable = needDeltaAtA * 3 / (Math.min(c.a, ACHIEVEMENT_RATING_MAX) - T97_ACHIEVEMENT);
    const P = pFromDelta(stable);
    p(`| ${c.label} | ${needDeltaAtA} | **${pct(P)}** | Δ(100%) = ${stable.toFixed(0)} 分 |`);
  }
}
p('');
p('所以「1200 → 1600」这个目标，按 100% 对齐就是 **P = 90.9%**（Δ = 400），');
p('按 100.5% 对齐就是 **P = 87.8%**（Δ = 343 → 100.5% 处 400）。两者都落在常规的「稳定」区间里。');
p('');

// ---- 表 3 -------------------------------------------------------------------
p('## 表 3 · 三个候选「稳定」定义下的对照（单题 rating）');
p('');
p('现状列 = `(题目 Rating ÷ 50) × factor(完成度)`；新方案列 = `(题目 Rating + Δ) ÷ 50`。');
p('');
p('| 题目 Rating | 完成度 | 现状 | 新 P=0.90 | 新 P=10/11 | 新 P=0.95 | 现状的隐含概率 |');
p('|---:|---:|---:|---:|---:|---:|---:|');
for (const q of RATED) {
  for (const a of [100, 100.5]) {
    const now = scoreNow(q, a);
    const implied = pFromDelta(q * factorNow(a) - q);
    const cells = STABLE_CANDIDATES.map((s) => scoreNew(q, a, s.delta).toFixed(1)).join(' | ');
    p(`| ${q} | ${a}% | ${now.toFixed(1)} | ${cells} | ${pct(implied)} |`);
  }
}
p('');
p('（同一题目 Rating 下的 100% 与 100.5% 两行相邻，方便看 SSS 与 SSS+ 的间距。）');
p('');

// ---- 表 4 -------------------------------------------------------------------
p('## 表 4 · 完整曲线对照：现状 vs 新方案（Δ(100%) = 400）');
p('');
p('取 Δ_stable = 400（P = 90.9%）这一档，逐完成度看单题 rating。');
p('');
p('| 完成度 | Δ | 1200 现状 → 新 | 1400 现状 → 新 | 1600 现状 → 新 | 1800 现状 → 新 | 2000 现状 → 新 |');
p('|---:|---:|---:|---:|---:|---:|---:|');
for (const a of [97, 98, 99, 99.5, 100, 100.5]) {
  const d = deltaAt(a, 400);
  const cells = RATED.map((q) => `${scoreNow(q, a).toFixed(1)} → **${scoreNew(q, a, 400).toFixed(1)}**`).join(' | ');
  p(`| ${a}% | ${d === 0 ? '0' : `+${d.toFixed(0)}`} | ${cells} |`);
}
p('');
p('要点：**97% 那一行两端完全相等**（Δ = 0），改动只发生在 97% 以上；');
p('而且增量是**绝对分差**，所以低难题的相对涨幅更大（1200 涨 +33%，2000 涨 +20%），');
p('这正好对应你说的「练习小题的稳定程度也有了更大的意义」。');
p('');

// ---- 表 5 -------------------------------------------------------------------
p('## 表 5 · 现行口径的内部不自洽（这张是「为什么必须改成绝对量」）');
p('');
p('把现状的 `factor` 反解成隐含的解出概率 —— 同样的完成度，在不同难度上说的不是同一件事：');
p('');
p('| 完成度 | factor | 1200 的题 | 1400 的题 | 1600 的题 | 2000 的题 | 隐含概率的极差 |');
p('|---:|---:|---:|---:|---:|---:|---:|');
for (const a of [97, 98, 99, 100, 100.5]) {
  const f = factorNow(a);
  const cells = [1200, 1400, 1600, 2000]
    .map((q) => `${pct(pFromDelta(q * f - q))}`).join(' | ');
  const ps = [1200, 1400, 1600, 2000].map((q) => pFromDelta(q * f - q));
  p(`| ${a}% | ${f.toFixed(4)} | ${cells} | ${((Math.max(...ps) - Math.min(...ps)) * 100).toFixed(1)} 个百分点 |`);
}
p('');
p('**1200 的题在 SSS+ 上只说「75%」，2000 的题在同一个 SSS+ 上说「86%」。**');
p('如果「完成度」要表示能力，那它对每道题必须说同一件事 —— 这就是要把倍率换成绝对分差的理由。');
p('');

// ---- 表 6 -------------------------------------------------------------------
p('## 表 6 · 改用绝对量之后，总分是什么');
p('');
p('新方案下单题 rating = `(题目 Rating + Δ) ÷ 50`，而总分 = 50 格之和，');
p('所以：');
p('');
p('> **DX Rating = 你最佳 50 道题的「等效 CF Rating」的平均值。**');
p('');
p('现在的总分是 `Σ (题目 Rating ÷ 50) × factor` —— 换成绝对量之后，同一句话仍然成立，');
p('但每一项的含义从「题目 Rating 的一个倍数」变成了「这位选手在这道题上的**等效 CF Rating**」，');
p('于是 **DX Rating 与 CF Rating 同尺度、可以直接比较**。');
p('');
p('| 题目 Rating（全 50 格都是它） | 全 S（97%，Δ=0） | 全 SSS（100%，Δ=400） | 全 SSS+（100.5%，Δ=467） |');
p('|---:|---:|---:|---:|');
for (const q of RATED) {
  p(`| ${q} | ${(50 * scoreNew(q, 97, 400)).toFixed(0)} | ${(50 * scoreNew(q, 100, 400)).toFixed(0)} | ${(50 * scoreNew(q, 100.5, 400)).toFixed(0)} |`);
}
p('');
p(`读法：全 1200 的题稳拿 SSS+ → **${(50 * scoreNew(1200, 100.5, 400)).toFixed(0)}**；`);
p(`全 2000 的题稳拿 SSS+ → **${(50 * scoreNew(2000, 100.5, 400)).toFixed(0)}**。`);
p('**从低难题刷分仍然上不去**，但「同一道题做得更稳」现在真的换得到分。');
p('注意**选题结构不变**：同一个完成度下，单题 rating 仍是题目 Rating 的单调增函数，');
p('所以 b35 / b15 挑的还是同一批题，只是分数整体抬高。');
p('');

// ---- 表 7 -------------------------------------------------------------------
p('## 表 7 · 如果坚持用「常数倍率」会怎样');
p('');
p(`把 factor 的顶从 1.1604 抬到 1.3333（让 1200 的题在 100.5% 拿到 1600/50）——`);
p('这是「改系数表」那条路，改动更小，但**倍率是错的形状**：');
p('');
p('| 方案 | 1200 的题在 100.5% | 隐含 P | 2000 的题在 100.5% | 隐含 P | 两者隐含概率之差 |');
p('|---|---:|---:|---:|---:|---:|');
{
  const fNew = 1600 / 1200; // = 1.3333
  const ps = [1200, 2000].map((q) => pFromDelta(q * fNew - q));
  p(`| 常数倍率 1.3333 | ${(1200 * fNew / 50).toFixed(1)} | ${pct(ps[0])} | ${(2000 * fNew / 50).toFixed(1)} | ${pct(ps[1])} | **${((ps[1] - ps[0]) * 100).toFixed(1)}** |`);
  const d = 400;
  p(`| 绝对分差 Δ=400 | ${((1200 + d) / 50).toFixed(1)} | ${pct(pFromDelta(d))} | ${((2000 + d) / 50).toFixed(1)} | ${pct(pFromDelta(d))} | **0.0** |`);
  p('');
  p(`常数倍率下，2000 的题在 SSS+ 上隐含 **${pct(ps[1])}** 而 1200 只有 **${pct(ps[0])}** —— `);
  p(`**${((ps[1] - ps[0]) * 100).toFixed(1)} 个百分点**的差；绝对分差下两者都是 **${pct(pFromDelta(d))}**。`);
}
p('**同一个完成度必须在每道题上表示同一件事**，所以推荐绝对量。');
p('');

// ---- 表 8：实测校准 -----------------------------------------------------------
p('## 表 8 · 实测校准：用 CF 官方解出率反推「稳定」该加多少分');
p('');
if (!calibration) {
  p('（这一节需要先跑 `node scripts/cf-study/solve-rate-probe.mjs` 生成 `solve-rate-calibration.json`。）');
} else {
  p(`\`solve-rate-probe.mjs\` 把 ${calibration.contests} 场比赛的 ${calibration.pairs.toLocaleString('en-US')} 个 (选手, 题) 对`);
  p('按 Δ = 赛前 Rating − 题目 Rating 分桶，**直接数解出率**（分母是全体参赛者）。');
  p('这是能从 CF 官方数据里拿到的最接近「把握有多大」的东西。');
  p('');
  p('| 目标解出率 | 实测 Δ | Elo 预测 Δ（400 分 = 10 倍） | 差 |');
  p('|---:|---:|---:|---:|');
  for (const row of calibration.crossover) {
    const pred = LOGIT_SCALE * Math.log10(row.target / (1 - row.target));
    p(`| ${pct(row.target)} | ${row.delta === null ? '样本不足' : `**${row.delta.toFixed(0)}**`} | ${pred.toFixed(0)} | ${row.delta === null ? '—' : `${(row.delta - pred).toFixed(0)}`} |`);
  }
  p('');
  p('三条读数：');
  p('');
  p('1. **实测 50% 点不在 Δ = 0，而在 Δ ≈ −100**，也就是「Rating 正好等于题目 Rating 的人」解出率约 **66%**；');
  p('   这不改结论（97% 仍然是「能做出来」那一档），但说明**实测口径下 CF 的题目 Rating 偏高约 100 分**。');
  p(`2. **实测「稳定（90%）」= Δ ≈ ${measuredDelta(0.9)?.toFixed(0)}**，Elo 理论值是 382 —— 实测曲线略平。`);
  p('   所以「稳定」的 Δ 落在 **217（实测）到 382（Elo）** 之间都讲得通。');
  p('3. 各难度区间的 50% 点一致（`SOLVE_RATE_PROBE.md` 表 3：−97 … −83），**可以放心用统一的系数**。');
}
p('');

// ---- 表 9：Ryan 的三段方案 ------------------------------------------------------
// 0–97 原样；97–100.5 的**段内比例完全照 maimai**（98:99:100:100.5 的相对增量不动），
// 整段缩放到「100% 处 = X」。97 处 factor 仍是 1.000，接口连续。
const FACTOR_MAIMAI_100 = factorNow(100);
const FACTOR_MAIMAI_1005 = factorNow(100.5);
const K_OF = (X) => (X - 1) / (FACTOR_MAIMAI_100 - 1);
const factorThree = (a, X) => {
  if (a < 50) return 0;
  if (a < T97_ACHIEVEMENT) return factorNow(a);
  return 1 + (factorNow(Math.min(a, ACHIEVEMENT_RATING_MAX)) - 1) * K_OF(X);
};
const scoreThree = (q, a, X) => r1((q / PROBLEM_RATING_DIVISOR) * factorThree(a, X));
// 「绝对分差」折成「常数倍率」的平均值：对 800–2100 每 100 一档取 Δ/q 的算术平均
const AVG_QS = [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100];
const X_FROM_DELTA = (delta) => 1 + AVG_QS.reduce((s, q) => s + delta / q, 0) / AVG_QS.length;

const X_MEASURED = X_FROM_DELTA(measuredDelta(0.9) ?? 217); // 实测 90% 解出率的平均倍率
const X_FOR_1005 = 1 + (1600 / 1200 - 1) / (FACTOR_MAIMAI_1005 - 1) * (FACTOR_MAIMAI_100 - 1); // 1200 的题在 100.5% 拿 1600/50
const X_FOR_100 = 1600 / 1200; // 1200 的题在 100% 拿 1600/50

p('## 表 9 · 三段方案：0–97 原样 / 97–100.5 按 maimai 的段内比例缩放');
p('');
p('这就是你说的那套结构，写成一行：');
p('');
p('```');
p('0    ≤ A <  97  : factor(A) = 现状（maimai 系数表，一个字不动）');
p('97   ≤ A ≤ 100.5: factor(A) = 1 + (factor_maimai(A) − 1) × K        ← 段内比例照 maimai');
p('                  K = (X − 1) ÷ (factor_maimai(100) − 1)');
p('```');
p('');
p(`$A = 97$ 处两端都是 **1.000**，天然接上；段内 98 : 99 : 100 : 100.5 的**相对增量比例完全没变**，`);
p('变的只有整段的**幅度**。所以「找映射」这件事被压缩成**一个数 $X$**（100% 处的折算系数）。');
p('');
p('| 候选 | Δ(100%) 的含义 | X | 1200 的题在 100% | 1200 在 100.5% | 1400 在 100% | 2000 在 100% |');
p('|---|---|---:|---:|---:|---:|---:|');
{
  const cands = [
    { X: X_MEASURED, d: measuredDelta(0.9), tag: '**实测**：90% 解出率（`SOLVE_RATE_PROBE.md`）' },
    { X: X_FOR_1005, d: null, tag: '**你的原话**：1200 的题在 100.5% 恰好拿到 1600/50' },
    { X: X_FOR_100, d: null, tag: 'Elo 理论 / 1200 的题在 **100%** 拿 1600/50' },
  ];
  for (const c of cands) {
    p(`| ${c.tag} | ${c.d === null ? '—' : `+${c.d.toFixed(0)}`} | **${c.X.toFixed(3)}** | ${scoreThree(1200, 100, c.X).toFixed(1)} | ${scoreThree(1200, 100.5, c.X).toFixed(1)} | ${scoreThree(1400, 100, c.X).toFixed(1)} | ${scoreThree(2000, 100, c.X).toFixed(1)} |`);
  }
}
p('');
p(`（同一个 $X$ 在 1200 的题上对应 Δ ≈ ${(X_MEASURED - 1).toFixed(3)} × 1200 ≈ ${((X_MEASURED - 1) * 1200).toFixed(0)} 分，`);
p(`在 2000 的题上 ≈ ${((X_MEASURED - 1) * 2000).toFixed(0)} 分 —— 这是**常数倍率**的固有性质：`);
p('难度越高，同一个倍率换到的分差越大。你选了「不做难度差异化」，那这就是它的代价。）');
p('');

p('### 表 9a · 三个 X 下 factor 的形状（与现状逐点对照）');
p('');
p('| 完成度 | 现状 factor | ' + [X_MEASURED, X_FOR_1005, X_FOR_100].map((x) => `X=${x.toFixed(3)}`).join(' | ') + ' |');
p('|---:|---:|' + [X_MEASURED, X_FOR_1005, X_FOR_100].map(() => '---:|').join(''));
for (const a of [90, 94, 97, 98, 99, 100, 100.5]) {
  const cells = [X_MEASURED, X_FOR_1005, X_FOR_100].map((x) => factorThree(a, x).toFixed(4)).join(' | ');
  const tag = a === 97 ? ' ← 接点，两端相同' : a === 100 ? ' ← 定义为 X' : '';
  p(`| ${a}%${tag} | ${factorNow(a).toFixed(4)} | ${cells} |`);
}
p('');
p('0–97 那三行（90 / 94 / 97）三个 X 完全相同 —— 那段一个字没动。');
p(`100.5% 处：现状 ${FACTOR_MAIMAI_1005.toFixed(4)} → X=${X_MEASURED.toFixed(3)} 时 ${factorThree(100.5, X_MEASURED).toFixed(4)}，`);
p(`X=${X_FOR_1005.toFixed(3)} 时 ${factorThree(100.5, X_FOR_1005).toFixed(4)}，X=${X_FOR_100.toFixed(3)} 时 ${factorThree(100.5, X_FOR_100).toFixed(4)}。`);
p('');

p('### 表 9b · 同一个 X 下，各完成度的单题 rating');
p('');
p(`取 X = ${X_MEASURED.toFixed(3)}（实测那一档）` + '，`单题 rating = (题目 Rating ÷ 50) × factor`。');
p('');
p('| 完成度 | 1200 的题 | 1400 的题 | 1600 的题 | 1800 的题 | 2000 的题 |');
p('|---:|---:|---:|---:|---:|---:|');
for (const a of [97, 98, 99, 100, 100.5]) {
  const cells = RATED.map((q) => scoreThree(q, a, X_MEASURED).toFixed(1)).join(' | ');
  p(`| ${a}% | ${cells} |`);
}
p('');
p('对照现状（`SCORE_CEILING.md` 表 A）：97% 一样，100.5% 由 27.8 / 32.5 / 37.1 / 41.8 / 46.4 变成 ' +
  RATED.map((q) => scoreThree(q, 100.5, X_MEASURED).toFixed(1)).join(' / ') + '。');
p('');

p('## 怎么读');
p('');
p('- 表 1/2：Elo 的**理论值** —— 「稳定」约 +380 分（P = 90%）；你的直觉 +400 分（P = 90.9%）。');
p('- 表 5：现行口径的问题所在（同一个完成度在不同难度上说不同的话）—— 这是「常数倍率」的固有代价。');
p('- 表 6/7：换成**绝对分差**会得到什么，以及常数倍率在高难题上偏多少。');
p('- **表 8 是实测校准**：CF 官方数据说「稳定（90% 解出）」的 Δ 只有约 217，不是理论上的 382。');
p('- **表 9 是你提的三段方案**：9a 看 factor 形状（97 处接点两端相同），9b 看分数。落地只要一个参数 X。');
p('- 要你拍板的是两件事：');
p('  **① 走哪条路** —— 常数倍率（表 9，改动小、就是你描述的那种）还是绝对分差（表 3/4，物理上更自洽）；');
p('  **② 若走表 9，X 取多少** —— 1.163（实测）/ 1.236（你的原话）/ 1.333（Elo 理论）。');
p('- 定了之后要动：`factorFromAchievement`（走表 9 的话只多一个 X 常数）、');
p('  `TOP_TIME_RATIOS` 的六档参照选手（系数因子数值跟着 X 更新，重跑 `anchor-by-player-rating.mjs`）、');
p('  以及 `docs` / 界面上的说明。**T97 曲线不用重跑。**');
p('');

await fs.writeFile(`${root}/STABLE_ANCHOR.md`, out.join('\n'), 'utf8');
process.stdout.write(`wrote ${root}/STABLE_ANCHOR.md (${out.length} lines)\n`);
