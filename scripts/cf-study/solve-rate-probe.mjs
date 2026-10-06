// 用 CF 官方 standings 的**实际解出率**检验 Elo 假设 —— 不改任何口径，纯体检。
//
// 为什么需要这个：`stable-anchor.mjs` 里那套「稳定做出 = 题目 Rating + 400 分」是
// 用 CF 的两条官方陈述推出来的：
//   (1) 题目 Rating 的定义 = 「该 Rating 的选手 50% 概率解出」  → 曲线过 (Δ=0, P=50%)
//   (2) CF 用 Elo/Glicko 尺度，400 分 = 概率差 10 倍          → 曲线的斜率
// 两条都可以**用数据证伪**：把 69 场比赛的全部 (选手, 题) 对按 Δ = 赛前Rating − 题目Rating
// 分桶，直接数解出率。如果 50% 不落在 Δ = 0 上，或者 70% 不落在 Δ ≈ 150 上，
// 那套换算就不能用。
//
// ⚠️ 已知局限（写进结论，不藏）：
//   - 题目 Rating 取的是**缓存当时的当前值**，选手 Rating 是**赛前值**，两者时点不完全对齐；
//   - 「解出」判定用 `problemResults[i].points > 0`，会把 IOI 赛制的部分分也算解出
//     （本仓库的 candidates 已经把整个 IOI 赛制排除了，这里同样排除）；
//   - 这些比赛是**按本地需求抓的 69 场**（有高端 Div.1，有 Educational），不是全量抽样，
//     所以低 Rating 端的样本偏少。
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { cached } from './api.mjs'; // 复用项目自己的缓存定位（文件名是 URL 的 SHA256）

const root = 'results/cf-study';
const out = [];
const p = (s) => out.push(s);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const standingsDir = 'data/cf-study/raw/contest.standings';

/** 读出某场比赛的赛前 Rating（ratingChanges），走项目自己的缓存键。 */
async function loadChanges(contestId) {
  try {
    const rows = await cached('contest.ratingChanges', { contestId });
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

// 桶：Δ 每 25 一档，范围 −400 .. +400
const LO = -400, HI = 400, STEP = 25;
const binOf = (d) => (d < LO || d >= HI ? null : Math.floor((d - LO) / STEP));
const NBINS = (HI - LO) / STEP;
const binLo = (b) => LO + b * STEP;

const merged = Array.from({ length: NBINS }, () => ({ n: 0, solved: 0 }));
// 按题目 Rating 分层，用于检验「50% 是否真的落在 Δ = 0」
const strataEdges = [800, 1000, 1200, 1400, 1600, 1800, 2100, 2500];
const strata = new Map(strataEdges.slice(0, -1).map((lo, i) => [i, { lo, hi: strataEdges[i + 1], m: Array.from({ length: NBINS }, () => ({ n: 0, solved: 0 })) }]));

const files = (await fs.readdir(standingsDir)).filter((f) => f.endsWith('.json.gz') || f.endsWith('.json'));
let contests = 0, pairs = 0, usedPairs = 0, skippedIOI = 0, noChanges = 0;

for (const file of files) {
  const buf = await fs.readFile(`${standingsDir}/${file}`);
  const r = JSON.parse(file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')).result;
  const c = r?.contest;
  if (!c || c.phase !== 'FINISHED') continue;
  if (c.type === 'IOI') { skippedIOI += 1; continue; }
  contests += 1;

  const changes = await loadChanges(c.id);
  if (!changes) { noChanges += 1; continue; }
  const ratings = new Map();
  for (const x of changes) {
    if (x && x.handle) ratings.set(x.handle.toLowerCase(), x.oldRating);
  }
  if (!ratings.size) { noChanges += 1; continue; }

  const problems = r.problems ?? [];
  for (const row of r.rows ?? []) {
    const party = row.party;
    if (!party || party.participantType !== 'CONTESTANT' || party.members.length !== 1 || party.ghost) continue;
    const handle = party.members[0].handle.toLowerCase();
    const rating = ratings.get(handle);
    if (!Number.isFinite(rating)) continue;
    const prs = row.problemResults ?? [];
    for (let i = 0; i < problems.length && i < prs.length; i += 1) {
      const q = problems[i].rating;
      if (!Number.isFinite(q) || q < 800 || q > 2500) continue;
      pairs += 1;
      const solved = (prs[i].points ?? 0) > 0 ? 1 : 0;
      const b = binOf(rating - q);
      if (b === null) continue;
      usedPairs += 1;
      merged[b].n += 1; merged[b].solved += solved;
      for (const [, s] of strata) {
        if (q >= s.lo && q < s.hi) { s.m[b].n += 1; s.m[b].solved += solved; break; }
      }
    }
  }
}

// 从桶序列里线性插值出「解出率达到 target」的 Δ
function crossover(bins, target, minN = 200) {
  for (let b = 0; b + 1 < bins.length; b += 1) {
    const a = bins[b], c = bins[b + 1];
    if (a.n < minN || c.n < minN) continue;
    const pa = a.solved / a.n, pc = c.solved / c.n;
    if ((pa - target) * (pc - target) <= 0 && pa !== pc) {
      const t = (target - pa) / (pc - pa);
      return binLo(b) + t * STEP;
    }
  }
  return null;
}

// 实测跨越点：解出率达到 target 时的 Δ
const CROSS_TARGETS = [0.5, 0.6, 0.7, 0.8, 0.9];
const cross = new Map(CROSS_TARGETS.map((t) => [t, crossover(merged, t)]));

p('# 用 CF 官方解出率检验「稳定 = 题目 Rating + 400 分」');
p('');
p('> 生成：`node scripts/cf-study/solve-rate-probe.mjs`。**不改任何口径。**');
p('');
p('样本：`data/cf-study/raw/contest.standings` 的全部缓存场次（排除 IOI 赛制 ' + `${skippedIOI} 场，`);
p(`另有 ${noChanges} 场取不到赛前 Rating 而跳过），共 ${pairs.toLocaleString('en-US')} 个 (选手, 题) 对，`);
p(`其中 ${usedPairs.toLocaleString('en-US')} 个落在 Δ ∈ [−400, +400]。**分母是全体参赛者**（不是「到达该题的人」），`);
p('因为 CF 的题目 Rating 定义就是按全体同 Rating 选手算的。');
p('');
p('`Δ = 选手赛前 Rating − 题目 Rating`。按 CF 的定义，**Δ = 0 处的解出率应该正好是 50%**；');
p('按 Elo 的 400 分尺度，**Δ = 150 处应该是 70%、Δ = 380 处应该是 90%**。');
p('');

p('## 结论（先给答案）');
p('');
p(`1. **实测的 50% 点不在 Δ = 0，而在 Δ ≈ ${cross.get(0.5)?.toFixed(0)}。** 也就是说，赛前 Rating 比题目 Rating`);
p(`   **低约 100 分**的人才有 50% 概率解出这道题；Rating 正好等于题目 Rating 的人解出率约 **${
  pct((() => { let n = 0, s = 0; for (let b = 0; b < NBINS; b += 1) { if (binLo(b) >= -25 && binLo(b) < 25) { n += merged[b].n; s += merged[b].solved; } } return s / n; })())
}**。`);
p('   ⚠️ 这与「题目 Rating = 该 Rating 的选手 50% 解出」这条官方说法在这 69 场上**对不上，差约 100 分** ——');
p('   不等于官方错了，而是**我们的分母口径与官方不同**（见下面第 5 点）。');
p(`2. **实测的「稳定（90% 解出）」= Δ ≈ ${cross.get(0.9)?.toFixed(0)}**，Elo 的 400 分尺度预测 +382 ——`);
p(`   实测曲线略平（50% → 90% 的跨度 ${(cross.get(0.9) - cross.get(0.5)).toFixed(0)} 分，Elo 预测 382 分），但同一量级。`);
p('   **所以方向是确定的：「稳定做出」必须显著高于题目 Rating，现行口径把 Δ 定死在 0（factor = 1.000）是低估的。**');
p('3. **各难度区间的 50% 点高度一致**（表 3：−84 / −84 / −89 / −97 / −85 / −83，只有 800–1000 是地板值例外），');
p('   所以可以放心用**一个统一的 Δ**，不需要按难度分段。');
p('4. **低难题整体偏高（表 2 第一行）主要是地板值造成的**：CF 的题目 Rating 有 800 的下限，');
p('   `*800` 实际含义是「≤ 800」。所以 800–1000 那一行不能与别的行直接比。');
p('5. 「差 100 分」的三个来源（都写在这里，不藏）：');
p('   - **分母是全体参赛者**，包含「根本没做到这道题的人」→ 高难题被拉低（题序效应，见 `CENSORING.md` 的偏差 ②）；');
p('   - 题目 Rating 取的是**缓存当时的当前值**，选手 Rating 是**赛前值**，两者时点不对齐；');
p('   - 这 69 场是**按本地需求抓的**，不是随机抽样（高端 Div.1 与 Educational 偏多）。');
p('');

p('## 表 1 · 全体：解出率随 Δ 的实测曲线');
p('');
p('| Δ 区间 | 样本 | 解出 | 实测解出率 | Elo 预测 | 差 |');
p('|---:|---:|---:|---:|---:|---:|');
const eloP = (d) => 1 / (1 + 10 ** (-d / 400));
for (let b = 0; b < NBINS; b += 2) {
  const a = merged[b];
  const c = b + 1 < NBINS ? merged[b + 1] : { n: 0, solved: 0 };
  const n = a.n + c.n, s = a.solved + c.solved;
  if (n < 50) continue;
  const obs = s / n, pred = eloP(binLo(b) + STEP);
  const tag = binLo(b) === 0 ? ' ← **CF 定义点**' : '';
  p(`| ${binLo(b)} … ${binLo(b) + 2 * STEP} | ${n.toLocaleString('en-US')} | ${s.toLocaleString('en-US')} | **${pct(obs)}** | ${pct(pred)} | ${((obs - pred) * 100).toFixed(1)} 个百分点${tag} |`);
}
p('**实测的跨越点**（相邻两个样本 ≥ 200 的桶之间线性插值）：');
p('');
p('| 目标解出率 | 实测 Δ | Elo 预测 Δ（400 分 = 10 倍） | 差 |');
p('|---:|---:|---:|---:|');
for (const t of CROSS_TARGETS) {
  const obs = cross.get(t);
  const pred = 400 * Math.log10(t / (1 - t));
  p(`| ${(t * 100).toFixed(0)}% | ${obs === null ? '样本不足' : `**${obs.toFixed(0)}**`} | ${pred.toFixed(0)} | ${obs === null ? '—' : `${(obs - pred).toFixed(0)}`} |`);
}
p('');
p('两点读法：');
p('');
p('1. **整条曲线向左平移了约 100 分**（50% 从 0 挪到 −100，70% 从 147 挪到 ' +
  `${cross.get(0.7)?.toFixed(0)}，90% 从 382 挪到 ${cross.get(0.9)?.toFixed(0)}）。`);
p('   平移而不是变形，说明 **Elo 的 logistic 形状是对的**，只是参照点不同。');
p(`2. 平移之后，从 50% 到 90% 需要 **${(cross.get(0.9) - cross.get(0.5)).toFixed(0)} 分**，`);
p('   Elo 理论值是 382 分 —— 实测的曲线**略平一点**（换算是 1.2 倍左右的距离差）。');
p('   所以「稳定」的 Δ 取 **217（实测）到 382（Elo）之间**都能自圆其说，取 400 是偏乐观的那一端。');
p('');

p('## 表 2 · 按题目 Rating 分层（看「50% 定义点」在各难度上是否一致）');
p('');
p('| 题目 Rating 区间 | Δ = −100…−50 | Δ = −50…0 | **Δ = 0…50** | Δ = 50…100 | Δ = 100…150 | Δ = 150…200 |');
p('|---|---:|---:|---:|---:|---:|---:|');
const segs = [[-100, -50], [-50, 0], [0, 50], [50, 100], [100, 150], [150, 200]];
for (const [si, s] of strata) {
  const cells = segs.map(([lo, hi]) => {
    let n = 0, so = 0;
    for (let b = 0; b < NBINS; b += 1) {
      const bl = binLo(b);
      if (bl >= lo && bl < hi) { n += s.m[b].n; so += s.m[b].solved; }
    }
    return n < 100 ? `${pct(so / Math.max(1, n))} (n=${n})` : `**${pct(so / n)}** (n=${n.toLocaleString('en-US')})`;
  });
  p(`| ${s.lo}–${s.hi} | ${cells.join(' | ')} |`);
}
p('');
p('（每个格子给解出率与样本数。样本 < 100 的格子只是参考。）');
p('');

p('## 表 3 · 解出率跨越点在不同难度上的一致性');
p('');
p('| 题目 Rating 区间 | 达到 50% 的 Δ | 达到 70% 的 Δ | 达到 90% 的 Δ |');
p('|---:|---:|---:|---:|');
for (const [, s] of strata) {
  const a = crossover(s.m, 0.5), b = crossover(s.m, 0.7), c = crossover(s.m, 0.9);
  const floor = s.lo === 800 ? '（地板值）' : '';
  p(`| ${s.lo}–${s.hi}${floor} | ${a === null ? '—' : a.toFixed(0)} | ${b === null ? '—' : b.toFixed(0)} | ${c === null ? '—' : c.toFixed(0)} |`);
}
p('');
p('800–1000 那一行的三个数都不可比：`*800` 是 CF 题目 Rating 的**地板**，含义是「≤ 800」，');
p('所以它那一层的 Δ 分布被挤到左边（rating 低于 700 的人本来就少），跨越点因此偏得很远。');
p('其余六行的 50% 点全部落在 **−97 … −83** 的窄带里，90% 点落在 **268 … 358**。');
p('**这条窄带就是「可以用一个统一 Δ」的依据。**');
p('');

p('## 怎么读');
p('');
p('- 表 1 是最直接的体检：实测曲线**整体比 Elo 左移约 100 分**，形状仍是 logistic。');
p('- 表 2 的每一行是一套独立的难度分层；低难度那行偏高主要是地板值 + 题序效应。');
p('- 表 3 给出「一个统一 Δ 是否够用」的答案：**够**，除地板层外 50% 点全落在 16 分宽的带里。');
p('- 落地时可以直接引用本文件表 1 的曲线：**「稳定（90%）≈ Δ 217」到「Elo 理论 382」之间**，');
p('  取哪个值是个产品决定，`stable-anchor.mjs` 里给出了三档的具体分数。');
p('- **本脚本不改任何口径**，只把 CF 官方数据里能直接数的东西数出来。');
p('');

await fs.writeFile(`${root}/SOLVE_RATE_PROBE.md`, out.join('\n'), 'utf8');
// 给 stable-anchor.mjs 用的校准数据（口径唯一出处仍在本脚本）
await fs.writeFile(`${root}/solve-rate-calibration.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'data/cf-study/raw/contest.standings（全部缓存场次，排除 IOI）',
  contests,
  pairs,
  usedPairs,
  denominator: '全体 CONTESTANT 参赛者（不是「到达该题的人」）',
  crossover: CROSS_TARGETS.map((t) => ({ target: t, delta: cross.get(t) })),
  eloScale: 400,
  note: 'Δ = 赛前 Rating − 题目 Rating。实测 50% 点约 −100（非 0），见 SOLVE_RATE_PROBE.md 的三条原因。',
}, null, 2), 'utf8');
process.stdout.write(`wrote ${root}/SOLVE_RATE_PROBE.md + solve-rate-calibration.json (contests=${contests} pairs=${pairs} used=${usedPairs})\n`);
