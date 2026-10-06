// 「单题 rating 的上限是不是太保守」—— 把上限、斜率、分数三件事分开算。
//
// Ryan 的启发：「100.5 按道理应该能吃更多分，比如 1600 的选手能把 1200 稳 SSS+ 之类」，
// 并推测「上限太保守 → 时间区间过小」。
//
// 这是两个独立的假设，必须分开验：
//   (A) **分数尺度**：把评分用的完成度上限从 100.5% 往上抬，单题 rating 会涨多少？
//       —— 这是纯算术，`factorFromAchievement` 一行就能算清。
//   (B) **区分度**：T97 曲线对 Rating 的斜率本来有多大？「1700–2000 画平」到底损失了多少？
//       —— 这是曲线读数，与上限无关。
//   把两者混在一起会得出「抬高上限就能换来区分度」的错觉。本脚本分开出表。
import fs from 'node:fs/promises';

const root = 'results/cf-study';
const out = [];
const p = (s) => out.push(s);

// ---- 曲线：读生产链自己产出的 t97_monotone.csv，不在本脚本里重跑拟合 ----------------
const csv = await fs.readFile(`${root}/t97_monotone.csv`, 'utf8');
const lines = csv.trim().split(/\r?\n/);
const header = lines.shift().split(',');
const rows = lines.map((l) => Object.fromEntries(header.map((k, i) => [k, l.split(',')[i]])));
const monotone = new Map(rows.filter((r) => r.model === 'success').map((r) => [Number(r.q), Number(r.monotoneSeconds)]));
const rawSmooth = new Map(rows.filter((r) => r.model === 'success').map((r) => [Number(r.q), Number(r.rawSeconds)]));

// ---- 换算：与 src/dx/rating.ts 完全同一条公式（照抄常数，不 import，脚本要能独立跑）----
const T97_ACHIEVEMENT = 97;
const COEFFICIENT_AT_T97 = 20.0;
const PROBLEM_RATING_DIVISOR = 50;
const SCORE_COEFFICIENTS = [
  [100.5, 22.4], [100, 21.6], [99.5, 21.1], [99, 20.8], [98, 20.3], [97, 20.0],
  [94, 16.8], [90, 15.2], [80, 13.6], [75, 12.0], [70, 11.2], [60, 9.6], [50, 8.0],
];
const coefficientFromAchievement = (a) => {
  for (const [floor, c] of SCORE_COEFFICIENTS) if (a >= floor) return c;
  return 0;
};
const factorWithCap = (a, cap) => {
  if (a < 50) return 0;
  const capped = Math.min(a, cap);
  return (capped * coefficientFromAchievement(capped)) / (T97_ACHIEVEMENT * COEFFICIENT_AT_T97);
};
const scoreOf = (q, a, cap) => Math.round((q / PROBLEM_RATING_DIVISOR) * factorWithCap(a, cap) * 10) / 10;

p('# 评分上限与区分度：两件事分开算');
p('');
p('> 生成：`node scripts/cf-study/scoring-probe.mjs`。换算公式与 `src/dx/rating.ts` 逐字一致。');
p('');

// ---- A. 上限的算术 ----------------------------------------------------------
p('## 表 A · 抬高评分上限会涨多少分（纯算术）');
p('');
p('`factor(A) = A × 系数(A) / (97 × 20)`。系数是 maimai 的阶梯表，**顶格就是 22.4**，');
p('所以「抬高上限」= 允许 `A` 这一项继续长，而系数锁在 22.4。');
p('');
const heads = [97, 98, 99, 99.5, 100, 100.5, 101, 103, 105, 106.134];
p(`| 完成度 | 系数 | factor | 1200 的题 | 1400 的题 | 1600 的题 | 1800 的题 | 2000 的题 |`);
p('|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const a of heads) {
  const f = factorWithCap(a, a); // 不封顶，看 factor 能长到哪
  const cell = (q) => scoreOf(q, a, a).toFixed(1);
  const tag = a === 100.5 ? '（现行评分上限）' : a > 100.5 ? '（现行被截掉的部分）' : '';
  p(`| ${a}%${tag} | ${coefficientFromAchievement(a)} | ${f.toFixed(4)} | ${cell(1200)} | ${cell(1400)} | ${cell(1600)} | ${cell(1800)} | ${cell(2000)} |`);
}
p('');
p('现行口径下 factor 的顶是 `factor(100.5) = 1.1605`；把上限抬到 106.134%（完成度的可算上限）');
p(`是 ${factorWithCap(106.134, 106.134).toFixed(4)}，相对现行上限 +${((factorWithCap(106.134, 106.134) / factorWithCap(100.5, 100.5) - 1) * 100).toFixed(2)}%。`);
p('代价：所有高分题一起涨（是**平移**，不是拉开），而且 100.5% 不再是「拿满」——');
p('`RANK_LADDER` 的顶与 `SCORE_COEFFICIENTS` 的顶都指着 100.5，两处都得一起改，否则界面显示与评分不一致。');
p('');

p('## 表 B · 「1600 的选手靠 1200 的题能拿多少分」');
p('');
p('50 格全部填满、每格都是同一 Rating 的题、全部拿到某一档 —— 这是**上限中的上限**。');
p('');
p('| 每题定数 | 全 S(97%) | 全 SSS+(100.5%) | 全 SSS+ 且上限抬到 106.134% | 要到 1600 分需要 | ');
p('|---:|---:|---:|---:|---:|');
for (const q of [1200, 1300, 1400, 1500, 1600]) {
  const s = scoreOf(q, 97, 100.5) * 50;
  const sss = scoreOf(q, 100.5, 100.5) * 50;
  const sss2 = scoreOf(q, 106.134, 106.134) * 50;
  const need = 1600 / (50 * (q / PROBLEM_RATING_DIVISOR)); // 需要的 factor
  p(`| ${q} | ${s.toFixed(1)} | ${sss.toFixed(1)} | ${sss2.toFixed(1)} | factor ${need.toFixed(3)}（≈ 完成度 ${(need * 1940 / 22.4).toFixed(1)}%） |`);
}
p('');
p('读法：**就算 50 格全是 1200 的题且全部 SSS+，总分也只有 ' +
  `${(scoreOf(1200, 100.5, 100.5) * 50).toFixed(1)}，够不到 1600**。把上限抬到可算上限 106.134% 也只有 ` +
  `${(scoreOf(1200, 106.134, 106.134) * 50).toFixed(1)}。`);
p('所以「1600 的选手把 1200 的题稳拿 SSS+」在设计上就**不应该**够到 1600 —— ');
p('要让总分等于 R，需要在**定数 ≈ R** 的题上稳定拿到 S（这是 T97 的锚点定义），');
p('靠低 400 分的题刷分，1.16 倍的上限补不上这 400 分的缺口。');
p('');

// ---- B. 区分度：曲线斜率 ------------------------------------------------------
p('## 表 C · T97 曲线对 Rating 的斜率（回答「时间区间过小」的根因）');
p('');
p('这是**曲线自己的性质**，与评分上限无关。`rawSeconds` 是平滑后（带宽 125）的读数，');
p('`monotoneSeconds` 是保序回归后的上线值。');
p('');
p('| Rating | 平滑读数 | 逐档差 | 每 Rating 差 | 保序读数 | 保序逐档差 |');
p('|---:|---:|---:|---:|---:|---:|');
const qs = [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100];
for (let i = 0; i < qs.length; i += 1) {
  const q = qs[i];
  const sm = rawSmooth.get(q);
  const mo = monotone.get(q);
  const dSm = i ? sm - rawSmooth.get(qs[i - 1]) : null;
  const dMo = i ? mo - monotone.get(qs[i - 1]) : null;
  p(`| ${q} | ${(sm / 60).toFixed(2)} | ${dSm === null ? '—' : (dSm / 60).toFixed(2)} | ${dSm === null ? '—' : (dSm / 100).toFixed(2)} 秒 | ${(mo / 60).toFixed(2)} | ${dMo === null ? '—' : (dMo / 60).toFixed(2)} |`);
}
{
  const span = monotone.get(2100) - monotone.get(800);
  const perRating = span / 1300;
  p('');
  p(`整条曲线 800 → 2100 涨 ${(span / 60).toFixed(2)} 分钟 = ${span.toFixed(0)} 秒，`);
  p(`平均斜率 **${perRating.toFixed(2)} 秒 / Rating**。`);
  p('');
  p('但平均斜率不是重点，**重点是斜率自己在塌**：');
  p('');
  p('| 区段 | 每 Rating 差 |');
  p('|---|---:|');
  p('| 800 → 1000 | 2.8 – 3.4 秒 |');
  p('| 1000 → 1200 | 1.3 – 2.1 秒 |');
  p('| 1200 → 1400 | 0.35 – 0.70 秒 |');
  p('| **1400 → 1600** | **0.13 – 0.48 秒** ← 比 1700–2000 还平 |');
  p('| 1600 → 1700 | 0.77 秒 |');
  p('| **1700 → 1800** | **0.03 秒** |');
  p('| 1800 → 1900 | −0.64 秒 |');
  p('| 1900 → 2000 | −0.09 秒 |');
  p('| 2000 → 2100 | 1.66 秒 |');
  p('');
  p('**所以「1700–2000 被画平」不是异常**：它落在了整条曲线本来就已经摊平的一段里 ——');
  p('1400–1600 那两档比它更平（0.13 / 0.35 秒每 Rating），只是没人注意，因为那两档是上升的。');
  p('曲线整体是一条**饱和型**（先陡后平）的形状：低档位每 100 分涨 3–5 分钟，');
  p('1400 之后每 100 分只涨十几秒到一分钟。');
  p('');
  p('要弄清这是「难度辨别力饱和」还是「口径造成的假象」，得看别的东西 ——');
  p('本轮查出的**子任务题污染**（`SUBTASK_PROBE.md`：2000 档 3.48 分钟）就是其中一条，');
  p('它正好落在高档位、方向朝下。但 1400–1600 的平坦不来自子任务题（那两档 X2 占比 4.9% 且方向朝上）。');
}
p('');

p('## 表 D · 分数的主要区分度来自哪里');
p('');
p('`单题 rating = (题目 Rating ÷ 50) × factor`。同一个 factor 下，定数差 100 就是 ' +
  `${(100 / 50).toFixed(1)} 分的差距；而 factor 从 S(1.000) 到 SSS+(1.160) 的全程只有 16%。`);
p('');
p('| 项 | 数值 | 相对幅度 |');
p('|---|---:|---:|');
p(`| 定数 1200 → 2000（同一个 factor） | ${(1200 / 50).toFixed(1)} → ${(2000 / 50).toFixed(1)} 分 | +67% |`);
p(`| factor S → SSS+（同一个定数） | 1.000 → 1.160 | +16% |`);
p(`| factor 完成度 97% → 50%（计分下限） | 1.000 → ${factorWithCap(50, 100.5).toFixed(3)} | ${((factorWithCap(50, 100.5) - 1) * 100).toFixed(0)}% |`);
p('');
p('所以「时间」这一维本来就只值 ±16%，题目定数那一维才是主项。');
p('想让时间更重要，得改的是 factor 的**形状**（例如整体放大 S 以上的级差），');
p('但那条公式是从 maimai 的系数表来的，动它就不再是「maimai 的比例」了 —— 这是个产品决定。');
p('');

p('## 怎么读');
p('');
p('- 表 A/B 回答「抬上限能换来什么」：只能整体抬高，且抬到完成度的可算上限也只 +5.6%，换不来区分度。');
p('- 表 C 回答「时间区间为什么这么小」：因为 T97 对 Rating 的斜率本身是饱和型的，');
p('  1400 之后就在 0.1–0.8 秒 / Rating 之间，1700–2000 的平块是这条曲线的一部分，不是异常。');
p('- 表 D 说明分数的区分度主要来自题目定数，不是用时。');
p('- 本脚本只做算术与读数，不改任何生产口径。');
p('');

await fs.writeFile(`${root}/SCORE_CEILING.md`, out.join('\n'), 'utf8');
process.stdout.write(`wrote ${root}/SCORE_CEILING.md (${out.length} lines)\n`);
