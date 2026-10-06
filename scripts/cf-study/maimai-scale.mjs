/**
 * maimai 的单曲 rating 表在说什么 —— 系数到底随不随难度变。
 *
 * 输入是 Ryan 2026-09-18 提供的舞萌DX 单曲 RA 表（定数 12.0–15.0）。
 * 本脚本只做算术与结构验证，**不改任何生产口径**。
 *
 * 要回答的四件事：
 *   1. 那张表的公式是什么？（→ 定数 × 达成率 ÷ 100 × 系数）
 *   2. 系数随不随难度变？（→ 不变，变的是定数）
 *   3. 于是「参照 maimai 做难度差异化」在 CF 这边对应什么？（→ 现行结构已经是）
 *   4. 97% 以上那段要放大多少（K）？两种「差异化」形状（乘性 / 加性）各给什么数字？
 */
import fs from 'node:fs/promises';

const root = 'results/cf-study';
const out = [];
const p = (s) => out.push(s);
const f2 = (x) => x.toFixed(2);
const f3 = (x) => x.toFixed(3);
const f4 = (x) => x.toFixed(4);

/** maimai 官方「达成率 → 评级系数」阶梯，只留 S 及以上（与 src/dx/rating.ts 同源）。 */
const COEF = [
  ['SSS+', 100.5, 22.4],
  ['SSS', 100, 21.6],
  ['SS+', 99.5, 21.1],
  ['SS', 99, 20.8],
  ['S+', 98, 20.3],
  ['S', 97, 20.0],
];
const COEF_AT_T97 = 20.0;
const T97 = 97;
const DIVISOR = 50;

const coefAt = (A) => COEF.find(([, floor]) => A >= floor)?.[2] ?? null;
/** maimai 原表：单曲 RA = 定数 × (达成率 ÷ 100) × 系数(达成率) */
const maimaiRa = (level, A) => ((level * A) / 100) * coefAt(A);
/** 本项目现行：单题 rating = (题目 Rating ÷ 50) × factor(A)，且 factor(97) = 1.000 */
const factorAt = (A) => (A * coefAt(A)) / (T97 * COEF_AT_T97);
/** 表 9 的常数倍率方案：97 以上整段放大 K 倍，段内比例照 maimai。 */
const kFromX = (X) => (X - 1) / (factorAt(100) - 1);
const xFromK = (K) => 1 + (factorAt(100) - 1) * K;
const scaledFactor = (A, K) => 1 + (factorAt(A) - 1) * K;
/** Elo：P(解出) = 1 ÷ (1 + 10^(−Δ/400)) */
const prob = (delta) => 1 / (1 + 10 ** (-delta / 400));

/**
 * 图上目视读到的数字（只有这两行的六档标了达成率，能一一对上）。
 * 读图有 ±1 的误差，所以断言只要求 |差| ≤ 1。
 */
const OBSERVED = [
  { level: 15.0, A: 100.5, rank: 'SSS+', shown: 337 },
  { level: 15.0, A: 100.0, rank: 'SSS', shown: 324 },
  { level: 15.0, A: 99.0, rank: 'SS', shown: 309 },
  { level: 15.0, A: 98.0, rank: 'S+', shown: 298 },
  { level: 15.0, A: 97.0, rank: 'S', shown: 291 },
  { level: 12.0, A: 100.5, rank: 'SSS+', shown: 270 },
  { level: 12.0, A: 100.0, rank: 'SSS', shown: 259 },
  { level: 12.0, A: 99.0, rank: 'SS', shown: 247 },
  { level: 12.0, A: 98.0, rank: 'S+', shown: 239 },
  { level: 12.0, A: 97.0, rank: 'S', shown: 233 },
];

p('# maimai 的单曲 rating 表在说什么 —— 系数到底随不随难度变');
p('');
p('> 生成：`node scripts/cf-study/maimai-scale.mjs`。输入是 2026-09-18 提供的舞萌DX 单曲 RA 表。');
p('> **本脚本只做算术，不改任何生产口径。**');
p('');

p('## 结论（先给答案）');
p('');
p('1. **那张表的公式是 `单曲 RA = 定数 × (达成率 ÷ 100) × 系数(达成率)`** —— 表 1 用 15.0 与 12.0');
p('   两行的十个数验证通过，`|公式值 − 图上值| ≤ 0.68`（差只来自取整）。');
p('2. **系数不随难度变。** 15.0 行 ÷ 12.0 行在每个档位上都恰好等于 15 ÷ 12 = **1.2500**（表 2）。');
p('   表里的「难度差异化」**全部由定数这一个因子承担**，达成率只负责选系数。');
p('   所以这张表是「系数与难度无关」的**正面证据**，不是反证。');
p('3. **本项目的现行结构已经是它的逐字归一化**（表 3）：');
p('   `factor(A) = A × 系数(A) ÷ (97 × 20)`，把 97% 那一档压成 1.000。「同一完成度下题目 Rating');
p('   越高分越高」在两边同构：maimai 靠定数、我们靠题目 Rating。**难度那一层不用再加。**');
p('4. **要动的只有 97% 以上那段的幅度**，而它有两种方向相反的形状（表 4/6）：');
p('');
p('   | 形状 | 公式 | 「小题练稳」的相对收益 | 实测支撑 |');
p('   |---|---|---|---|');
p('   | **乘性**（maimai / 现行结构） | `(Q ÷ 50) × factor(A)` | 与高难题**相同** | ❌ 隐含 Δ ∝ Q，实测说 Δ 与难度无关 |');
p('   | **加性**（绝对分差） | `(Q + Δ(A)) ÷ 50` | 低难题**更受益** | ✅ 各难度区间 50% 点一致（`SOLVE_RATE_PROBE.md`） |');
p('');
p('   注意：**「改系数倍率」和「抬完成度上限」是同一类操作（都是乘性平移）**，');
p('   而「让练习小题更有意义」这个诉求只有加性给得到。');
p('5. 若走乘性，参数只有一个：**K = 把 maimai 那段放大多少倍**（表 5）。K = 1.00 就是原样。');
p('');

p('## 表 1 · 公式验证：`单曲 RA = 定数 × (达成率 ÷ 100) × 系数(达成率)`');
p('');
p('| 定数 | 档位 | 达成率 | 系数 | 公式值 | 图上值 | 差 |');
p('|---:|---|---:|---:|---:|---:|---:|');
for (const o of OBSERVED) {
  const v = maimaiRa(o.level, o.A);
  p(`| ${o.level.toFixed(1)} | ${o.rank} | ${o.A.toFixed(1)}% | ${coefAt(o.A).toFixed(1)} | ${f2(v)} | ${o.shown} | ${(v - o.shown).toFixed(2)} |`);
}
p('');
const bad = OBSERVED.filter((o) => Math.abs(maimaiRa(o.level, o.A) - o.shown) > 1);
if (bad.length) throw new Error(`公式对不上的行：${bad.map((o) => `${o.level}/${o.rank}`).join(', ')}`);
p('十个数全部对上，最大偏差 0.68（337.68 → 337 的截断）。**这张表没有别的机关。**');
p('');

p('## 表 2 · 系数不随难度变：两行的比值恒等于定数之比');
p('');
p('| 档位 | 达成率 | 系数 | 定数 15.0 的 RA | 定数 12.0 的 RA | 比值 | 15 ÷ 12 |');
p('|---|---:|---:|---:|---:|---:|---:|');
let ratioOk = true;
for (const [rank, A, coef] of COEF) {
  const hi = maimaiRa(15.0, A);
  const lo = maimaiRa(12.0, A);
  const r = hi / lo;
  if (Math.abs(r - 1.25) > 1e-9) ratioOk = false;
  p(`| ${rank} | ${A.toFixed(1)}% | ${coef.toFixed(1)} | ${f2(hi)} | ${f2(lo)} | ${f4(r)} | ${f4(15 / 12)} |`);
}
if (!ratioOk) throw new Error('比值不再是常数 —— 系数与难度有关的假设需要重新检查');
p('');
p('六个档位的比值全是 **1.2500**。定数涨 25%，每个档位的 RA 都涨 25% —— 系数一格没变。');
p('');

p('## 表 3 · maimai 的三段 vs 本项目的 factor');
p('');
p('| 档位 | 达成率 | 系数 | 系数 ÷ 20 | 本项目 factor | 两者之比（= A ÷ 97） |');
p('|---|---:|---:|---:|---:|---:|');
for (const [rank, A, coef] of COEF) {
  const f = factorAt(A);
  p(`| ${rank} | ${A.toFixed(1)}% | ${coef.toFixed(1)} | ${f4(coef / COEF_AT_T97)} | ${f4(f)} | ${f4(f / (coef / COEF_AT_T97))} |`);
}
p('');
p('比值那一列恒等于 `A ÷ 97`，因为 `factor(A) = (系数 ÷ 20) × (A ÷ 97)`。');
p('**我们和 maimai 只差一层达成率的线性因子，系数的形状原样搬过来了。**');
p('');
p('| 段 | 起系数 | 止系数 | 段内倍数 | 备注 |');
p('|---|---:|---:|---:|---|');
p(`| 0 → 97% | 0 | ${COEF_AT_T97.toFixed(1)} | — | AAA 及以下不锚定，仍按 97 ÷ A |`);
p(`| 97% → 100% | 20.0 | 21.6 | ×${f4(21.6 / 20.0)} | S → SSS（3 个百分点） |`);
p(`| 100% → 100.5% | 21.6 | 22.4 | ×${f4(22.4 / 21.6)} | SSS → SSS+（**0.5 个百分点**） |`);
p('');
p('最后那一段只占 0.5 个百分点的达成率，系数却涨了 3.70% —— 比 97→100 那段（每百分点 2.67%）陡。');
p('maimai 的设计是「越接近满分，回报越陡」，这一点系数表原样继承了。');
p('');

p('## 表 4 · 「难度差异化」的两种形状（方向相反）');
p('');
p('| 题目 Rating | 乘性：现状 97% | 乘性 100.5% | 加性 Δ=217 @100.5% | 加性 Δ=400 @100.5% |');
p('|---:|---:|---:|---:|---:|');
for (const q of [1200, 1400, 1600, 1800, 2000]) {
  p(`| ${q} | ${f2((q / DIVISOR) * factorAt(97))} | ${f2((q / DIVISOR) * factorAt(100.5))} | ${f2((q + 217) / DIVISOR)} | ${f2((q + 400) / DIVISOR)} |`);
}
p('');
p('两者在 100.5% 处的**增量形状**完全不同：');
p('');
p('| 形状 | 1200 的题 | 2000 的题 | 相对增幅 1200 | 相对增幅 2000 |');
p('|---|---:|---:|---:|---:|');
{
  const base1200 = (1200 / DIVISOR) * factorAt(97);
  const base2000 = (2000 / DIVISOR) * factorAt(97);
  const rows = [
    ['乘性 现状（K=1）', (1200 / DIVISOR) * factorAt(100.5), (2000 / DIVISOR) * factorAt(100.5)],
    ['乘性 K=1.49（实测）', (1200 / DIVISOR) * scaledFactor(100.5, 1.49), (2000 / DIVISOR) * scaledFactor(100.5, 1.49)],
    ['加性 Δ=217（实测）', (1200 + 217) / DIVISOR, (2000 + 217) / DIVISOR],
    ['加性 Δ=400（Elo）', (1200 + 400) / DIVISOR, (2000 + 400) / DIVISOR],
  ];
  for (const [name, a, b] of rows) {
    p(`| ${name} | ${f2(a)} | ${f2(b)} | +${(((a / base1200) - 1) * 100).toFixed(1)}% | +${(((b / base2000) - 1) * 100).toFixed(1)}% |`);
  }
}
p('');
p('**要点**：乘性下两个难度涨得**一样多**（K = 1.49 时两行都是 +23.9%）—— 所以「把小题练稳」');
p('不比「把大难题练稳」更划算。加性下低难题涨得多（Δ = 400 时 1200 涨 +33.3%、2000 只涨 +20.0%），');
p('**这才是「练习小题的稳定程度更有意义」**。');
p('');

p('## 表 5 · 乘性方案：只有一个参数 K（放大幅度）');
p('');
p('```');
p('0    <= A <  97  : factor(A) = 现状（maimai 系数表，一个字不动）');
p('97   <= A <= 100.5: factor(A) = 1 + (factor_maimai(A) - 1) * K');
p('```');
p('');
p('`A = 97` 处两端都是 1.000，天然接上；段内 98 : 99 : 100 : 100.5 的**相对增量比例照 maimai 没变**，');
p('变的只有整段的幅度。**K = 1.00 就是 maimai 原样。**');
p('');
const KS = [
  [1.0, 'maimai 原样（一个字不改）'],
  [1.49, '实测：90% 解出率的加权最优（表 8）'],
  [2.08, '原话：1200 的题在 100.5% 恰好拿到 1600 ÷ 50'],
  [2.94, 'Elo 理论：Δ = 400（P = 90.9%）'],
];
p('| K | 含义 | X = factor(100%) | 1200@100% | 1200@100.5% | 2000@100% | 2000@100.5% | 2000 处隐含 Δ |');
p('|---:|---|---:|---:|---:|---:|---:|---:|');
for (const [K, label] of KS) {
  const X = xFromK(K);
  p(`| **${K.toFixed(2)}** | ${label} | ${f4(X)} | ${f2((1200 / DIVISOR) * scaledFactor(100, K))} | ${f2((1200 / DIVISOR) * scaledFactor(100.5, K))} | ${f2((2000 / DIVISOR) * scaledFactor(100, K))} | ${f2((2000 / DIVISOR) * scaledFactor(100.5, K))} | +${(2000 * (scaledFactor(100.5, K) - 1)).toFixed(0)} |`);
}
p('');
p('同一个 K 在高难题上换到的**绝对分差**更大（因为 factor 乘的是 Q）：K = 1.49 时 1200 的题 +203 分、');
p('2000 的题 +338 分，隐含解出率 76% vs 87% —— **同一个完成度在两个难度上说的不是同一件事**。');
p('');

p('## 表 6 · factor 的完整形状（现状 vs 四个 K）');
p('');
p('| 完成度 | 现状 factor（K=1） | K=1.49 | K=2.08 | K=2.94 | 段内增量占比 |');
p('|---:|---:|---:|---:|---:|---:|');
const span = factorAt(100.5) - 1;
for (const A of [97, 98, 99, 99.5, 100, 100.5]) {
  const share = (factorAt(A) - 1) / span;
  const cells = KS.map(([K]) => f4(scaledFactor(A, K)));
  const shareCell = A === 97 ? '（接点，两端相同）' : `${(share * 100).toFixed(1)}%`;
  p(`| ${A.toFixed(1)}% | ${f4(factorAt(A))} | ${cells[1]} | ${cells[2]} | ${cells[3]} | ${shareCell} |`);
}
p('');
p('最后那一列**不随 K 变** —— 这就是「段内比例照 maimai」的意思。');
p('注意它与 maimai 系数口径（(21.6 − 20) ÷ (22.4 − 20) = 66.7%）不完全相同：');
p('`factor` 多乘了一层 `A ÷ 97`，所以 100% 处的占比是 **70.7%** 而不是 66.7%。');
p('这一层来自「97% 是锚点所以 factor 必须是 1.000」这个约定，不是新加的规则。');
p('');

p('## 表 7 · 两条路 vs 实测校准');
p('');
p('`solve-rate-probe.mjs` 数的 5,171,771 个 (选手, 题) 对给出：解出率 50% 在 Δ ≈ −103、90% 在 Δ ≈ +217。');
p('用这两点反推「100% 完成度（= 稳定）」在两条路上各自的 Δ：');
p('');
p('| 方案 | 1200 的题隐含 Δ | 2000 的题隐含 Δ | 是否与「Δ 不随难度变」相容 |');
p('|---|---:|---:|---|');
{
  const rows = [
    ['乘性 K=1.49', 1200 * (scaledFactor(100, 1.49) - 1), 2000 * (scaledFactor(100, 1.49) - 1)],
    ['乘性 K=2.08', 1200 * (scaledFactor(100, 2.08) - 1), 2000 * (scaledFactor(100, 2.08) - 1)],
    ['加性 Δ=217', 217, 217],
  ];
  for (const [name, d1, d2] of rows) {
    const ok = Math.abs(d1 - d2) < 1 ? '✅' : `❌ 差 ${Math.abs(d2 - d1).toFixed(0)} 分`;
    p(`| ${name} | +${d1.toFixed(0)} | +${d2.toFixed(0)} | ${ok} |`);
  }
}
p('');
p('实测那一列（`SOLVE_RATE_PROBE.md` 表 3）说**各难度区间的 50% 点几乎一致**（−97 … −83），');
p('也就是「解出率只取决于 Δ，不取决于题目本身的难度」。这句话的直接推论就是**加性**。');
p('乘性如果要成立，必须假设「难题上的稳定比简单题上的稳定值更多的分」—— 实测不支持这一点。');
p('');

p('## 表 8 · K 该取多少 —— 按样本分布加权的最优值');
p('');
p('K 是一个**常数**，但它乘的是题目 Rating，所以在每个难度上换到的绝对分差不同：');
p('`Δ(Q) = (factor_maimai(100) − 1) × K × Q`。要让这个 Δ 在**全体样本上**最接近实测的');
p('「稳定分差」，就是按样本量加权的最小二乘：');
p('');
p('```');
p('K*(Δ) = Δ × E[Q] / ( (factor_maimai(100) - 1) × E[Q^2] )');
p('```');
p('');
{
  const csv = await fs.readFile(`${root}/t97_raw.csv`, 'utf8');
  const lines = csv.trim().split('\n');
  const head = lines[0].split(',');
  const iQ = head.indexOf('q');
  const iW = head.indexOf('effectiveSamples');
  const iKind = head.indexOf('kind');
  const iBand = head.indexOf('band');
  let sw = 0;
  let swq = 0;
  let swq2 = 0;
  let qs = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c[iKind] !== 'empirical') continue;
    if (iBand >= 0 && c[iBand] !== '100') continue;
    const q = Number(c[iQ]);
    const w = Number(c[iW]);
    if (!Number.isFinite(q) || !Number.isFinite(w) || w <= 0) continue;
    sw += w;
    swq += w * q;
    swq2 += w * q * q;
    qs += 1;
  }
  const eq = swq / sw;
  const eq2 = swq2 / sw;
  const slope = factorAt(100) - 1;
  const kStar = (delta) => (delta * eq) / (slope * eq2);
  p('| 项 | 值 |');
  p('|---|---:|');
  p(`| 档位数 | ${qs} |`);
  p(`| Σ 有效样本 | ${sw.toLocaleString('en-US', { maximumFractionDigits: 0 })} |`);
  p(`| E[Q]（加权均值难度） | ${f2(eq)} |`);
  p(`| E[Q²]（加权二阶矩） | ${eq2.toLocaleString('en-US', { maximumFractionDigits: 0 })} |`);
  p(`| (factor_maimai(100) − 1) | ${f4(slope)} |`);
  p('');
  p('代入不同的「稳定」定义（实测值来自 `SOLVE_RATE_PROBE.md`，Elo 理论值仅供参考）：');
  p('');
  p('| 「稳定」的定义 | Δ(100%) | 最优 K | 对应 X | 1200 的题 @100% | 2000 的题 @100% |');
  p('|---|---:|---:|---:|---:|---:|');
  const DEFS = [
    ['实测 90% 解出率', 217],
    ['Elo 理论 90.9% / Δ = 400', 400],
    ['更严的「稳定」：95% 解出（Elo 尺度外推）', 511],
  ];
  for (const [label, delta] of DEFS) {
    const K = kStar(delta);
    const X = xFromK(K);
    p(`| ${label} | +${delta} | **${f2(K)}** | ${f4(X)} | ${f2((1200 / DIVISOR) * scaledFactor(100, K))} | ${f2((2000 / DIVISOR) * scaledFactor(100, K))} |`);
  }
  p('');
  {
    const KUser = 2.08;
    const dUser = slope * KUser * eq;
    p(`你原话那一档（1200 的题在 100.5% 恰好拿到 1600 ÷ 50）对应 K = ${KUser.toFixed(2)}，`);
    p(`它在**加权平均难度**上换到的绝对分差是 **+${dUser.toFixed(0)} 分**，隐含解出率 **${(prob(dUser) * 100).toFixed(1)}%** ——`);
    p('比实测的 90% 更宽松。所以它不是「实测校准的结果」，而是一个**你定的目标**：');
    p(`只要接受「稳定 ≈ ${(prob(dUser) * 100).toFixed(0)}% 解出」，这个 K 就自洽。`);
  }
  p('');
  p('**读法**：K 由「你认为稳定是多少解出率」决定，样本分布只影响它在各难度上的加权。');
  {
    const Ks = kStar(217);
    p(`实测那一档（Δ = 217）给出的加权最优 K 是 **${f2(Ks)}**（对应 X = ${f4(xFromK(Ks))}）——`);
    p(`比 maimai 原样（K = 1、X = 1.1134）大 **${((Ks - 1) * 100).toFixed(0)}%**。`);
    p(`也就是：要把 SSS 处的 factor 从 1.1134 抬到 ${f4(xFromK(Ks))} 就够（1200 的题 ${f2((1200 / DIVISOR) * factorAt(100))} → ${f2((1200 / DIVISOR) * scaledFactor(100, Ks))}，`);
    p(`2000 的题 ${f2((2000 / DIVISOR) * factorAt(100))} → ${f2((2000 / DIVISOR) * scaledFactor(100, Ks))}），**不需要抬到 1.236 或 1.333**。`);
  }
  p('**但要提醒**：这条「够用」的结论是**在乘性这个形状下**说的。实测真正否定的是乘性本身（表 7），');
  p('而不是它的幅度。形状改对了，幅度的问题会自动消失。');
}
p('');

p('## 怎么读');
p('');
p('- **表 1/2 是这轮新加的证据**：那张表 = `定数 × 达成率 ÷ 100 × 系数`，系数与难度无关。');
p('  所以「参照 maimai 做难度差异化」**不需要在系数上再加一层** —— 现行结构已经同构。');
p('- 表 3：系数形状原样搬来，只多一层 `A ÷ 97`。三段比例（97–100 涨 8%、100–100.5 涨 3.7%）未动。');
p('- 表 4/7：难点在于「差异化」有两种相反的含义。**乘性 = maimai 的形状，加性 = 实测的形状。**');
p('  若你的诉求是「练小题的稳定更值钱」，那只有加性给得到（乘性下两个难度涨幅相同）。');
p('- 表 5/6：走乘性的话，改动面就是**一个数 K**。97% 锚点、T97 曲线、0–97 段全都不动。');
p('- 定了之后还要动两处（不在本脚本内）：`TOP_TIME_RATIOS` 的六档参照选手要按新的系数因子');
p('  重跑 `anchor-by-player-rating.mjs`；`docs` 与界面说明同步。**T97 曲线不用重跑。**');
p('');

await fs.writeFile(`${root}/MAIMAI_SCALE.md`, out.join('\n'), 'utf8');
process.stdout.write(`wrote ${root}/MAIMAI_SCALE.md (${out.length} lines)\n`);
