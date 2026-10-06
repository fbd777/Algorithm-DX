// 子任务题（B1/B2、C1/C2…）把「用时」量歪了多少 —— 全区间体检。
//
// 起因：2000 档 Div.1 那 447 条里，中位耗时只有 13~23 分钟，其中一场
// （contest 2219 的 B2）中位 **1.42 分钟**。查下去发现那 447 条**全部**是
// 子任务题的第二个（B2 / C2）。
//
// 原因在 core.mjs 的题序重建里：
//   「归属时间 = 上一题 AC → 本题 AC」是**按 standings 里的题目顺序**走的，
//   而 CF 把一道难题拆成 X1 / X2 两个独立题号。于是 X2 的用时是
//   「解出 X1 之后再解 X2 的增量」，**不含解 X1 的那段时间**；
//   更要命的是解完 X1 顺手把 X2 一起交掉的人，增量是几十秒。
//
// 这不是「算错了」—— 增量口径本身就是读数（core.mjs 的头注释写明了）。
// 但如果**某些档位的样本大量来自 X2**，那这些档位的 T97 与别的档位就不同量纲。
// 本脚本只量化这件事，不改口径。
//
// ⚠️ **2026-09-18 之后这份读数要分两层看**：
//   1. `SLOT_CHECK.md` 查出这些 `X1/X2` 根本不是「同一道题拆两半」，而是
//      `(Easy Version)` / `(Hard Version)` 成对的**两道定数不同的题**（落差中位 +400 分）；
//   2. `core.mjs` 因此改成「同一题位共用起点」——`X2` 的用时变成「冷启动 → 解出 X2」的整段，
//      `X1` 的记录原样保留。`samples.json` 已按新口径重算。
//
// 所以：**现在的 `samples.json` 里「X2 行」已经是修复后的读数**。重跑本脚本，
// 下面表 1/表 5 的「剔除 X2 后位移」应该比历史读数小一个量级 —— 那正是修复生效的证据，
// 不是脚本坏了。修复前的逐档对照（legacy / dropEasy / cold 三变体）在 `SUBTASK_MERGE.md`。
import fs from 'node:fs/promises';
import { bandRows, binEstimate, quantile } from './core.mjs';

const root = 'results/cf-study';
const out = [];
const p = (s) => out.push(s);
const min1 = (s) => (Number.isFinite(s) ? (s / 60).toFixed(2) : '—');
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const samples = JSON.parse(await fs.readFile('data/cf-study/processed/samples.json', 'utf8'));

const listDir = 'data/cf-study/raw/contest.list';
const contestInfo = new Map();
for (const file of await fs.readdir(listDir)) {
  const payload = JSON.parse(await fs.readFile(`${listDir}/${file}`, 'utf8'));
  for (const c of payload.result ?? []) {
    if (c.type === 'IOI') continue;
    contestInfo.set(c.id, { name: c.name, duration: c.durationSeconds });
  }
}
function divisionOf(name) {
  if (!name) return 'unknown';
  if (/Div\.?\s*1\s*\+\s*Div\.?\s*2/i.test(name)) return 'Div1+2';
  if (/Div\.?\s*1/i.test(name)) return 'Div1';
  if (/Div\.?\s*2/i.test(name)) return 'Div2';
  if (/Div\.?\s*3/i.test(name)) return 'Div3';
  if (/Div\.?\s*4/i.test(name)) return 'Div4';
  if (/Educational/i.test(name)) return 'Educational';
  if (/Global Round|CodeTON|Good Bye|Hello|Kotlin|April Fools/i.test(name)) return 'Special';
  return 'Other';
}
// 题号 -> {letter, gen}：gen=1 是 A/B/C…，gen>=2 是子任务的第 gen 个（B2 的 gen=2）。
function parseIndex(problem) {
  const m = /^([A-Z]+)(\d*)$/.exec(String(problem));
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return { letter: m[1], letterN: n, gen: m[2] ? Number(m[2]) : 1, pos: n };
}
for (const row of samples) {
  const info = contestInfo.get(row.contestId);
  row.__division = divisionOf(info?.name);
  row.__name = info?.name ?? '(未知比赛)';
  const pi = parseIndex(row.problem);
  row.__gen = pi ? pi.gen : null;
  row.__pos = pi ? pi.pos : null;
}
// 同一场比赛里，该题是否有更小的同字母题号（B2 → B1）。
const siblings = new Map();
for (const row of samples) {
  const key = `${row.contestId}/${row.problem}`;
  if (!siblings.has(key)) siblings.set(key, parseIndex(row.problem));
}

const BAND = 100;
const MIN_PRIOR = 10;
const band = (q) => bandRows(samples, q, BAND, MIN_PRIOR);
const unweighted = (rows) => quantile(rows.map((r) => ({ ...r, weight: 1 })), 0.5);
const pcts = (rows, ps) => ps.map((x) => min1(quantile(rows.map((r) => ({ ...r, weight: 1 })), x)));

p('# 子任务题（X2）对「用时」口径的污染面');
p('');
p('> 生成：`node scripts/cf-study/subtask-probe.mjs`。');
p('> 口径：`bandRows` + 生产筛选（题目 Rating 恰好等于该档、赛前 Rating ±100、赛前 rated ≥ 10 场）。');
p('');
p('**⚠️ 读这份报告前先看这里。** `X1/X2` 是 `(Easy Version)` / `(Hard Version)` 成对的**两道题**');
p('（定数落差中位 +400 分，见 `SLOT_CHECK.md`），`core.mjs` 已于 2026-09-18 改成');
p('「同一题位共用起点」，所以**现在的 `samples.json` 已经是修复后的读数**。');
p('下面表 1/表 5 的「剔除 X2 后位移」因此比历史读数小一个量级 —— 那是修复生效的证据，不是脚本坏了。');
p('修复前的逐档对照（legacy 增量 / dropEasy 丢 easy / cold 现行）在 `SUBTASK_MERGE.md`。');
p('');

p('## 表 1 · 全区间：子任务题的占比');
p('');
p('`X2+` = 题号带数字且 ≥ 2（B2、C2、D2…）。**历史口径**下这类题的归属用时是「解出 X1 之后到解出 X2');
p('的增量」；现行口径下它是「同一题位起点 → 解出该子任务」的整段。所以「两者之差」这一列现在衡量的是');
p('**两道题的难度差**（X2 本来就比 X1 难，中位落差 +400 分），不再是口径缺陷。');
p('');
p('中位数一律只用**解出的样本**（`event=1`），与生产的 successP50 同口径；');
p('把删失行混进来算中位数是另一个量（它们的 time 是「比赛结束 − 上一题 AC」），这里不混。');
p('');
p('| Rating | 样本 | X2+ 样本 | X2+ 占比 | X2+ 比赛 | X2+ 中位 | 非子任务样本 | 非子任务中位 | 两者之差 |');
p('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const q of [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100]) {
  const rows = band(q);
  const solved = rows.filter((r) => r.event);
  const sub = solved.filter((r) => (r.__gen ?? 1) >= 2);
  const plain = solved.filter((r) => (r.__gen ?? 1) === 1);
  const ms = sub.length ? unweighted(sub) : null;
  const mp = plain.length ? unweighted(plain) : null;
  p(`| ${q} | ${rows.length} | ${sub.length} | ${pct(sub.length / rows.length)} | ${new Set(sub.map((r) => r.contestId)).size} | ${min1(ms)} | ${plain.length} | ${min1(mp)} | ${ms !== null && mp !== null ? `**${((ms - mp) / 60).toFixed(2)}**` : '—'} |`);
}
p('');

p('## 表 2 · X2+ 样本内部的分布');
p('');
p('中位数可能看着正常，但左尾（P5–P30）才是「解完 X1 顺手把 X2 一起交掉」的那批人：');
p('');
p('| Rating | X2+ 样本 | P5 | P10 | P20 | P30 | P50 | P70 | P90 | < 2 分钟的条数 | < 2 分钟占比 |');
p('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const q of [1600, 1700, 1800, 1900, 2000, 2100]) {
  const sub = band(q).filter((r) => (r.__gen ?? 1) >= 2 && r.event);
  if (sub.length < 20) { p(`| ${q} | ${sub.length} | — | — | — | — | — | — | — | — | 样本不足 |`); continue; }
  const ps = pcts(sub, [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9]);
  const fast = sub.filter((r) => r.time < 120).length;
  p(`| ${q} | ${sub.length} | ${ps.join(' | ')} | ${fast} | ${pct(fast / sub.length)} |`);
}
p('');

p('## 表 3 · 2000 档 Div.1：逐场逐题拆到底');
p('');
p('每格给 P10 / P30 / P50 / P90（分钟）与「< 2 分钟」的条数。');
p('（历史读数里这一格是 447 条、中位 13~23 分钟、`< 2 分钟` 一大片 —— 那正是 X2 增量口径的产物。）');
p('');
p('| contestId | 比赛名 | 题号 | 题序 | 条数 | P10 | P30 | P50 | P90 | < 2 分钟 | 解出率 |');
p('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
{
  const rows = band(2000).filter((r) => r.__division === 'Div1');
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.contestId}/${r.problem}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const [, rs] of [...byKey].sort((a, b) => b[1].length - a[1].length)) {
    const solved = rs.filter((r) => r.event);
    const ps = solved.length >= 5 ? pcts(solved, [0.1, 0.3, 0.5, 0.9]) : ['—', '—', '—', '—'];
    const fast = solved.filter((r) => r.time < 120).length;
    const r0 = rs[0];
    p(`| ${r0.contestId} | ${r0.__name} | ${r0.problem} | ${r0.__pos} | ${rs.length} | ${ps.join(' | ')} | ${fast} | ${pct(solved.length / rs.length)} |`);
  }
}
p('');

p('## 表 4 · 全区间：每档有多少「< 2 分钟就切掉」的样本');
p('');
p('**历史读数**里「一分钟解掉一道 2000 分的题」是 X2 增量口径的产物；现行口径下这个量应当接近 0。');
p('保留这张表是为了盯住回归：如果它又随档位抬头，说明题位重建逻辑被改坏了。');
p('');
p('| Rating | 解出样本 | < 1 分钟 | < 2 分钟 | < 5 分钟 | X2+ 占解出 | 去掉 X2+ 后中位 | 全部中位 |');
p('|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const q of [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100]) {
  const rows = band(q).filter((r) => r.event);
  const f1 = rows.filter((r) => r.time < 60);
  const f2 = rows.filter((r) => r.time < 120);
  const f5 = rows.filter((r) => r.time < 300);
  const x2 = rows.filter((r) => (r.__gen ?? 1) >= 2);
  const noX2 = rows.filter((r) => (r.__gen ?? 1) === 1);
  p(`| ${q} | ${rows.length} | ${f1.length} | ${f2.length} | ${f5.length} | ${pct(x2.length / rows.length)} | ${min1(unweighted(noX2))} | ${min1(unweighted(rows))} |`);
}
p('');

p('## 表 5 · 现状 vs「剔除 X2+」（回归哨兵）');
p('');
p('左列是现在上线的那一个估计量（`binEstimate` 的 `successP50Seconds`，高斯加权），');
p('右列是**同一套筛选 + 同一套加权**、只是把 X2+ 行剔掉之后重算的。');
p('现行口径下两列应当接近 —— 剩下的差只来自「X2 本来就比 X1 难」这一点真实难度差。');
p('**历史读数**里右列明显高于左列（2000 档差 3.48 分钟），那个差才是口径缺陷。');
p('');
p('| Rating | 现状 T97 | 剔除 X2+ 后 | 位移 | 剔除后独立比赛 | 剔除后样本 | 现状样本 |');
p('|---:|---:|---:|---:|---:|---:|---:|');
for (const q of [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100]) {
  const rows = band(q);
  const noX2 = rows.filter((r) => (r.__gen ?? 1) === 1);
  const now = binEstimate(rows).summary;
  const fixed = binEstimate(noX2).summary;
  const d = now.successP50Seconds !== null && fixed.successP50Seconds !== null
    ? (now.successP50Seconds - fixed.successP50Seconds) / 60 : null;
  p(`| ${q} | ${min1(now.successP50Seconds)} | ${min1(fixed.successP50Seconds)} | ${d === null ? '—' : `**${d.toFixed(2)}**`} | ${fixed.contests} | ${fixed.samples} | ${now.samples} |`);
}
p('');

p('## 怎么读');
p('');
p('- 表 1 看「某些档位是不是几乎全由 X2 组成」—— 若是，这些档与别的档不同量纲。');
p('- 表 2 的 P5–P30 是「顺手一起交掉」那批人的位置；中位数会被他们拉低多少，看 P50 与 P30 的差。');
p('- 表 3 是 2000 档 Div.1 的直接答案：B2 那一格的中位数就是几十秒级。');
p('- 表 4 给出可选的补救方向（把 X2+ 从估计里剔掉，或改用「从 0 计时」），但**本脚本不改口径**。');
p('');

await fs.writeFile(`${root}/SUBTASK_PROBE.md`, out.join('\n'), 'utf8');
process.stdout.write(`wrote ${root}/SUBTASK_PROBE.md (${out.length} lines)\n`);
