// 诊断 1700–2050 的平块：这四个档位的 T97 经验点乱跳（2000 档 34.18 分钟明显最低），
// 单调约束只能把它们压成一条平线。问题是 —— 这个跳是**信号**还是**少数几场比赛带出来的**？
//
// 做法：把每档的样本按比赛拆开，用三种加权方式各算一次中位用时：
//   rows    —— 现在的口径：所有样本行混在一起，按选手 Rating 的高斯权重加权。
//              一个来了很多人的大场会按人数占权。
//   contest —— 每场比赛先各自算中位数，再对比赛取中位数。每场等权。
//   sqrt    —— 每场比赛的权重是 √(该场样本数)，介于两者之间。
//
// 如果三种口径给出同样的 1700→2000 下降，那这个下降就是这批数据里的形状（选择偏差也好、
// 真实也好），保序回归压平它只是把「不可分辨」写实；如果只有 rows 口径下降，
// 说明是大场带偏，换口径就能让曲线自己恢复区分度。
//
// 用法：node scripts/cf-study/plateau-check.mjs
import fs from 'node:fs/promises';
import { GAUSS_SIGMA, MAIN_BAND, MAIN_MIN_PRIOR } from './core.mjs';

const GRID = [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100];

const samples = JSON.parse(await fs.readFile('data/cf-study/processed/samples.json', 'utf8'));
console.log(`样本 ${samples.length.toLocaleString('en-US')} 行`);

/** 加权中位数。 */
function wmedian(items) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.t - b.t);
  const total = sorted.reduce((n, r) => n + r.w, 0);
  if (!(total > 0)) return null;
  let sum = 0;
  for (const r of sorted) {
    sum += r.w;
    if (sum >= total / 2) return r.t;
  }
  return sorted[sorted.length - 1].t;
}

const rows = [];
for (const q of GRID) {
  const band = samples.filter(
    (r) => r.q === q && Math.abs(r.oldRating - q) <= MAIN_BAND && r.priorRated >= MAIN_MIN_PRIOR && r.event,
  );
  if (!band.length) continue;
  const byContest = new Map();
  for (const r of band) {
    let list = byContest.get(r.contestId);
    if (!list) byContest.set(r.contestId, (list = []));
    list.push({ t: r.time, w: Math.exp(-((r.oldRating - q) ** 2) / (2 * GAUSS_SIGMA ** 2)) });
  }
  const perContest = [...byContest.entries()]
    .map(([contestId, list]) => ({ contestId, n: list.length, median: wmedian(list) }))
    .sort((a, b) => b.n - a.n);

  const allRows = [...byContest.values()].flat();
  const rowsMedian = wmedian(allRows);
  const contestMedian = wmedian(perContest.map((c) => ({ t: c.median, w: 1 })));
  const sqrtMedian = wmedian(perContest.map((c) => ({ t: c.median, w: Math.sqrt(c.n) })));

  // 最大的一场占该档多少样本 —— 这个数高就说明该档的读数由少数几场决定。
  const top = perContest[0];
  const share = top ? top.n / band.length : null;

  rows.push({
    q,
    samples: band.length,
    contests: perContest.length,
    rowsMedian,
    contestMedian,
    sqrtMedian,
    topContestId: top?.contestId ?? null,
    topShare: share,
    topMedian: top?.median ?? null,
    topN: top?.n ?? 0,
  });
}

const min = (s) => (s === null ? '—' : (s / 60).toFixed(2));
const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`);

const lines = [];
lines.push('# 1700–2050 平块的成因诊断');
lines.push('');
lines.push(`> 生成：\`node scripts/cf-study/plateau-check.mjs\`；口径：题目 Rating 恰好等于该档、选手赛前 Rating ±${MAIN_BAND}、已证实赛前 rated ≥ ${MAIN_MIN_PRIOR} 场、当场切出。`);
lines.push('');
lines.push('三种加权方式，单位分钟：');
lines.push('');
lines.push('- **rows**：现在的口径 —— 全部样本行混在一起，选手 Rating 的高斯权重（σ=' + GAUSS_SIGMA + '）。');
lines.push('- **contest**：每场先各算中位数，再对**比赛**取中位数。每场等权。');
lines.push('- **sqrt**：每场权重 √(该场样本数)。');
lines.push('');
lines.push('| Rating | 样本 | 独立比赛 | rows | contest | sqrt | 最大一场占比 | 最大一场的比赛 id |');
lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  lines.push(
    `| ${r.q} | ${r.samples.toLocaleString('en-US')} | ${r.contests} | ${min(r.rowsMedian)} | ${min(r.contestMedian)} | ${min(r.sqrtMedian)} | ${pct(r.topShare)} | ${r.topContestId} |`,
  );
}
lines.push('');
lines.push('逐档的比赛构成见 [PLATEAU_CONTESTS.md](PLATEAU_CONTESTS.md)。');
lines.push('');
await fs.writeFile('results/cf-study/PLATEAU_CHECK.md', lines.join('\n'));

console.log('\n| Rating | 样本 | 场次 | rows | contest | sqrt | 最大一场占比 |');
for (const r of rows) {
  console.log(
    `| ${r.q} | ${r.samples} | ${r.contests} | ${min(r.rowsMedian)} | ${min(r.contestMedian)} | ${min(r.sqrtMedian)} | ${pct(r.topShare)} |`,
  );
}

// 详细列出每档前 6 场的样本数与中位数，方便判断是不是被少数几场决定。
const detail = rows.map((r) => {
  const band = samples.filter(
    (x) => x.q === r.q && Math.abs(x.oldRating - r.q) <= MAIN_BAND && x.priorRated >= MAIN_MIN_PRIOR && x.event,
  );
  const byContest = new Map();
  for (const x of band) {
    let list = byContest.get(x.contestId);
    if (!list) byContest.set(x.contestId, (list = []));
    list.push({ t: x.time, w: Math.exp(-((x.oldRating - r.q) ** 2) / (2 * GAUSS_SIGMA ** 2)) });
  }
  const per = [...byContest.entries()]
    .map(([contestId, list]) => ({ contestId, n: list.length, median: wmedian(list) }))
    .sort((a, b) => b.n - a.n);
  return { q: r.q, per: per.slice(0, 6), total: per.length };
});
const detailLines = ['# 各档比赛构成（前 6 场）', ''];
for (const d of detail) {
  detailLines.push(`## ${d.q}（共 ${d.total} 场）`, '');
  detailLines.push('| 比赛 id | 样本 | 中位用时（分钟） |');
  detailLines.push('|---:|---:|---:|');
  for (const c of d.per) detailLines.push(`| ${c.contestId} | ${c.n} | ${min(c.median)} |`);
  detailLines.push('');
}
await fs.writeFile('results/cf-study/PLATEAU_CONTESTS.md', detailLines.join('\n'));
console.log('\n已写出 PLATEAU_CHECK.md 与 PLATEAU_CONTESTS.md');
