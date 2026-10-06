// 2000 档的 Div.1 那一格为什么只有 13 分钟 —— 把它拆到底。
//
// Ryan 的两条质疑：
//   1. 「2000 分左右做 2000 分的题，耗时不该都差不多吗？Div.1 只有 13 分钟，
//      是不是不小心纳入了别 Rating 的选手？」
//   2. 「尤其收集一下 Div.1 里的数据，对高难度区间可能会有帮助。」
//
// 这两条要分开回答，因为它们是相反的诉求：第一条怀疑 Div.1 混进了坏样本，
// 第二条希望多用 Div.1。本脚本的立场是**先看数据再站队**，所以逐层打印：
//   (a) 主口径的窗口过滤到底有没有生效（|赛前 Rating − q| ≤ 100、priorRated ≥ 10）；
//   (b) 2000 档 Div.1 那批样本在比赛里的**题序角色**（A 题还是 E 题）；
//   (c) 同一赛制内部，题序固定之后读数还差多少 —— 差得多说明是角色问题，不是选手问题；
//   (d) Div.1 对 1600–2100 各档的贡献量（样本、独立比赛数）。
//
// 口径与 plateau-cause.mjs 一致：bandRows + binEstimate，绝不另写一份筛选逻辑。
import fs from 'node:fs/promises';
import { bandRows, binEstimate, quantile } from './core.mjs';

const root = 'results/cf-study';
const out = [];
const pushed = (s) => { out.push(s); };
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const min1 = (s) => (Number.isFinite(s) ? (s / 60).toFixed(2) : '—');

const samples = JSON.parse(await fs.readFile('data/cf-study/processed/samples.json', 'utf8'));

// 比赛名与时长来自研究自己缓存的 contest.list —— 和 plateau-cause.mjs 同一份来源。
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
const posOf = (problem) => {
  const m = /^([A-Z]+)/.exec(String(problem));
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};
for (const row of samples) {
  const info = contestInfo.get(row.contestId);
  row.__division = divisionOf(info?.name);
  row.__pos = posOf(row.problem);
  row.__name = info?.name ?? '(未知比赛)';
}

const BAND = 100;
const MIN_PRIOR = 10;
const band = (q) => bandRows(samples, q, BAND, MIN_PRIOR);

// 加权中位（同 binEstimate 的 successP50 口径：bandRows 已经挂好高斯权重）。
const wmedian = (rows) => {
  if (!rows.length) return null;
  const s = [...rows].sort((a, b) => a.time - b.time);
  const total = s.reduce((n, r) => n + (r.weight ?? 1), 0);
  let sum = 0;
  for (const r of s) { sum += r.weight ?? 1; if (sum >= 0.5 * total) return r.time; }
  return s.at(-1).time;
};
const unweighted = (rows) => quantile(rows.map((r) => ({ ...r, weight: 1 })), 0.5);
const dist = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (p) => v[Math.floor((v.length - 1) * p)];
  return { min: at(0), p25: at(0.25), median: at(0.5), p75: at(0.75), max: at(1) };
};

pushed('# 2000 档 Div.1 的 13 分钟：逐层拆解');
pushed('');
pushed('> 生成：`node scripts/cf-study/div1-role.mjs`。口径 = 生产估计量本身（`bandRows` + `binEstimate`）：');
pushed('> 题目 Rating **恰好等于**该档、选手赛前 Rating 在 ±100 内、已证实赛前 rated ≥ 10 场。');
pushed('');

// ---- 1. 窗口过滤自检 ---------------------------------------------------------
pushed('## 表 1 · 窗口过滤自检（回答「是不是混进了别的 Rating 选手」）');
pushed('');
pushed('这是 `bandRows` 的筛选条件本身，不是另算的：`r.q === q` 是**严格相等**，');
pushed('`|oldRating − q| ≤ 100` 是硬过滤。下表的「越界」列统计的是「按 1-位小数的 Rating 落在窗口外」的条数。');
pushed('');
pushed('| Rating | 样本 | 题目 Rating 唯一值 | 越界条数 | 选手赛前 Rating 最小 | p25 | 中位 | p75 | 最大 |');
pushed('|---:|---:|---|---:|---:|---:|---:|---:|---:|');
for (const q of [1700, 1800, 1900, 2000, 2100]) {
  const rows = band(q);
  const qs = [...new Set(rows.map((r) => r.q))];
  const outside = rows.filter((r) => Math.abs(r.oldRating - q) > BAND).length;
  const d = dist(rows.map((r) => r.oldRating));
  pushed(`| ${q} | ${rows.length} | ${qs.join(',')} | **${outside}** | ${d.min} | ${d.p25} | ${d.median} | ${d.p75} | ${d.max} |`);
}
pushed('');

// ---- 2. 2000 档各赛制画像 ---------------------------------------------------
pushed('## 表 2 · 2000 档按赛制切开');
pushed('');
pushed('「题序」=(A,B,C…) 的位置分布。「占该赛制」= 该赛制在 2000 档全部样本里的占比。');
pushed('');
pushed('| 赛制 | 样本 | 占该档 | 比赛 | 独立问题 | 选手 | 题序分布（位置×条数） | 中位耗时(未加权) | 中位耗时(加权) | KM 中位 | 解出率 |');
pushed('|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|');
{
  const rows = band(2000);
  const byDiv = new Map();
  for (const r of rows) {
    if (!byDiv.has(r.__division)) byDiv.set(r.__division, []);
    byDiv.get(r.__division).push(r);
  }
  const ordered = [...byDiv].sort((a, b) => b[1].length - a[1].length);
  for (const [div, rs] of ordered) {
    const posCount = new Map();
    for (const r of rs) posCount.set(r.__pos, (posCount.get(r.__pos) ?? 0) + 1);
    const posStr = [...posCount].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}题×${n}`).join('，');
    const km = binEstimate(rs).survival.median;
    const solvedRate = rs.filter((r) => r.event).length / rs.length;
    pushed(`| ${div} | ${rs.length} | ${pct(rs.length / rows.length)} | ${new Set(rs.map((r) => r.contestId)).size} | ${new Set(rs.map((r) => r.contestId + '/' + r.problem)).size} | ${new Set(rs.map((r) => r.handle)).size} | ${posStr} | ${min1(unweighted(rs))} | ${min1(wmedian(rs))} | ${min1(km)} | ${pct(solvedRate)} |`);
  }
  pushed(`| **合计** | ${rows.length} | 100% | ${new Set(rows.map((r) => r.contestId)).size} | ${new Set(rows.map((r) => r.contestId + '/' + r.problem)).size} | ${new Set(rows.map((r) => r.handle)).size} | — | ${min1(unweighted(rows))} | ${min1(wmedian(rows))} | ${min1(binEstimate(rows).survival.median)} | ${pct(rows.filter((r) => r.event).length / rows.length)} |`);
}
pushed('');

// ---- 3. 题序固定的对照 ------------------------------------------------------
pushed('## 表 3 · 固定题序后还剩多少差（回答「是角色问题还是选手问题」）');
pushed('');
pushed('如果 Div.1 的 2000 分题是 A 题、Div.2 的 2000 分题是最后一题，那两者本就不是同一种题，');
pushed('聚合中位数被谁主导取决于构成。**同一行内**比较才有意义。');
pushed('');
pushed('| 题序位置 | Div2 样本 | Div2 中位 | Div1+2 样本 | Div1+2 中位 | Div1 样本 | Div1 中位 |');
pushed('|---:|---:|---:|---:|---:|---:|---:|');
{
  const rows = band(2000);
  for (const p of [1, 2, 3, 4, 5]) {
    const pick = (div) => rows.filter((r) => r.__division === div && r.__pos === p);
    const cells = [];
    for (const div of ['Div2', 'Div1+2', 'Div1']) {
      const rs = pick(div);
      cells.push(rs.length, rs.length >= 30 ? min1(unweighted(rs)) : '样本不足');
    }
    if (cells.some((_, i) => i % 2 === 0 && cells[i] >= 30)) pushed(`| 第 ${p} 题 | ${cells.join(' | ')} |`);
  }
}
pushed('');
pushed('各格的样本条数（含样本 <30 的格，便于看稀疏程度）：');
pushed('');
pushed('| 题序位置 | Div2 | Div3 | Div1+2 | Div1 | Special | Other |');
pushed('|---:|---:|---:|---:|---:|---:|---:|');
{
  const rows = band(2000);
  for (const p of [1, 2, 3, 4, 5]) {
    const cells = ['Div2', 'Div3', 'Div1+2', 'Div1', 'Special', 'Other']
      .map((div) => rows.filter((r) => r.__division === div && r.__pos === p).length);
    pushed(`| 第 ${p} 题 | ${cells.join(' | ')} |`);
  }
}
pushed('');

// ---- 4. Div.1 那批题的逐场清单 ----------------------------------------------
pushed('## 表 4 · 2000 档 Div.1 的逐场清单');
pushed('');
pushed('看这批题到底来自什么比赛、在比赛里排第几 —— 「13 分钟」到底是不是 A 题的正常速度。');
pushed('');
pushed('| contestId | 比赛名 | 该场条数 | 题号 | 题序 | 中位耗时 | 加权中位 | 解出率 | 比赛时长 |');
pushed('|---:|---|---:|---|---:|---:|---:|---:|---:|');
{
  const rows = band(2000).filter((r) => r.__division === 'Div1');
  const byContest = new Map();
  for (const r of rows) {
    if (!byContest.has(r.contestId)) byContest.set(r.contestId, []);
    byContest.get(r.contestId).push(r);
  }
  for (const [id, rs] of [...byContest].sort((a, b) => b[1].length - a[1].length)) {
    const problems = [...new Set(rs.map((r) => r.problem))].sort().join('/');
    const pos = [...new Set(rs.map((r) => r.__pos))].sort().join('/');
    const dur = rs[0].__duration;
    pushed(`| ${id} | ${rs[0].__name} | ${rs.length} | ${problems} | ${pos} | ${min1(unweighted(rs))} | ${min1(wmedian(rs))} | ${pct(rs.filter((r) => r.event).length / rs.length)} | ${dur ? `${Math.round(dur / 60)} 分钟` : '—'} |`);
  }
}
pushed('');

// ---- 5. Div.1 对高档位的贡献 ------------------------------------------------
pushed('## 表 5 · Div.1 对 1600–2100 各档的贡献（回答「能不能多用 Div.1」）');
pushed('');
pushed('「换成 Div.2 读数」是同档位内只用 Div.2 的样本算出的中位数 —— 两列差得越大，');
pushed('说明这一档的高低主要由赛制构成决定，而不是题目难度。');
pushed('');
pushed('| Rating | 全部样本 | Div1 样本 | Div1 占比 | Div1 比赛 | Div1 中位 | Div2 中位 | Div1 − Div2 | 全部中位 |');
pushed('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const q of [1600, 1700, 1800, 1900, 2000, 2100]) {
  const rows = band(q);
  const d1 = rows.filter((r) => r.__division === 'Div1');
  const d2 = rows.filter((r) => r.__division === 'Div2');
  const m1 = d1.length >= 30 ? unweighted(d1) : null;
  const m2 = d2.length >= 30 ? unweighted(d2) : null;
  pushed(`| ${q} | ${rows.length} | ${d1.length} | ${pct(d1.length / rows.length)} | ${new Set(d1.map((r) => r.contestId)).size} | ${min1(m1)} | ${min1(m2)} | ${m1 !== null && m2 !== null ? `**${((m1 - m2) / 60).toFixed(2)}**` : '—'} | ${min1(unweighted(rows))} |`);
}
pushed('');

// ---- 6. 高档位的「解出者」画像 ----------------------------------------------
pushed('## 表 6 · 2000 档切开的分布（不只中位数）');
pushed('');
pushed('中位数掩盖了双峰。把 Div.1 与 Div.2 的成功者耗时按分位数列出来：');
pushed('');
pushed('| 赛制 | 样本 | P10 | P20 | P30 | P50 | P70 | P80 | P90 | P95 |');
pushed('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
{
  const rows = band(2000);
  for (const div of ['Div2', 'Div1+2', 'Div1', 'Special']) {
    const rs = rows.filter((r) => r.__division === div && r.event);
    if (rs.length < 30) continue;
    const qs = [0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95].map((p) => min1(quantile(rs.map((r) => ({ ...r, weight: 1 })), p)));
    pushed(`| ${div} | ${rs.length} | ${qs.join(' | ')} |`);
  }
}
pushed('');

pushed('## 怎么读');
pushed('');
pushed('- 表 1 若「越界条数」为 0，Ryan 的第一条怀疑（混进了别 Rating 的选手）就不成立。');
pushed('- 表 2 / 表 3 决定第二条：若 Div.1 的 2000 分题几乎全是第 1 题，那它和 Div.2 的 2000 分题');
pushed('  不是同一种东西，「13 分钟」是角色读数的正常结果，不是算错。');
pushed('- 表 5 回答「多用 Div.1 行不行」：Div1 − Div2 这一列就是池化的代价。');
pushed('- 全部是描述性证据；不做检验的显著性结论。');
pushed('');

await fs.writeFile(`${root}/DIV1_ROLE.md`, out.join('\n'), 'utf8');
process.stdout.write(out.join('\n'));
