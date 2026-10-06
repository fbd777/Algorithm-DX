// 用「等效选手 Rating」锚定 DX 六档门槛。
//
// 规则（Ryan 2026-09-18 定）：本项目里 `总 Rating = 各格单题 rating 之和（50 格）`，
// 所以「单题 rating × 50」可以读作**等效 CF Rating** —— 拿得出这份单题贡献的选手，
// 水平大致就在这个 Rating 上。于是每一档的门槛时间是：
//
//     t_rank(q) = 中位用时( 题目 Rating = q ｜ 选手赛前 Rating ≈ q × F_rank )
//
// F 是 maimai 的系数因子（S 1.000、S+ 1.025、SS 1.061、SS+ 1.082、SSS 1.113、SSS+ 1.160）。
// **S 档的参照选手正好是「Rating ≈ q」，这就是现有 T97 的定义** —— 所以这条规则没有另起
// 炉灶，只是把同一个锚点沿系数因子往上推，让六档之间的间隔由「选手水平」「用时」这个真实
// 关系决定，而不是由 maimai 分数空间的 0.5% 档位决定（那样折到时间上只有几秒一档）。
//
// 为什么必须放宽构建窗口：`candidates()` 只保留 |选手 Rating − 题目 Rating| ≤ 150 的行，
// 而最高一档要 q 上方 16%（q=2100 时是 +336）。这里用 500 重跑一遍 **离线**（原始响应
// 全在 data/cf-study/raw，不需要联网），一边跑一边聚合，不落盘大样本文件。
//
// 用法：node scripts/cf-study/anchor-by-player-rating.mjs
// 产出：results/cf-study/player-anchor.csv、PLAYER_ANCHOR.md
import fs from 'node:fs/promises';
import { candidates, attachHistory, GAUSS_SIGMA, MAIN_MIN_PRIOR } from './core.mjs';
// 系数因子的唯一出处。改了 src/dx/rating.ts 的 TOP_FACTOR_GAIN 就必须重跑本脚本。
import { factorFromAchievement } from '../../src/dx/rating.ts';
import { cached } from './api.mjs';
import { openLedger } from './ledger-store.mjs';

const root = 'data/cf-study';
const outDir = 'results/cf-study';
/** 允许的 |选手 Rating − 题目 Rating|。500 覆盖 1.16×2100 = 2436 加上 ±100 的参照窗口。 */
const WINDOW = Number(process.env.ANCHOR_WINDOW ?? 500);
/** 参照选手的取值窗口半径。与主口径的 ±100 同源，便于和 T97 的定义对齐。 */
const REF_RADIUS = Number(process.env.ANCHOR_RADIUS ?? 100);
/** Gaussian 衰减的 σ。默认与主口径同值 75。 */
const SIGMA = Number(process.env.ANCHOR_SIGMA ?? GAUSS_SIGMA);
/** 输出后缀：跑灵敏度时用它区分文件，不覆盖主结果。 */
const SUFFIX = process.env.ANCHOR_SUFFIX ?? '';
/**
 * 系数因子 F —— **直接从 `src/dx/rating.ts` 取**，不在脚本里再抄一份。
 *
 * 口径的唯一出处是 `factorFromAchievement()`：97% 以下照 maimai 原样，97% 以上整段按
 * `TOP_FACTOR_GAIN` 放大（K = 1.6 的来历见该常量的注释与 `MAIMAI_SCALE.md`）。
 * 所以**改 K 之后本脚本必须重跑** —— 参照选手是「rating ≈ q × F」的那群人，F 变了门槛就变了。
 *
 * 从 SSS+ 一路列到 AA —— 再往下的档位（A/BBB/…）对应的参照选手要比题目低 40% 以上，
 * 落到 ±500 的采集窗口外了，本批数据锚不到，所以不列。
 */
const LADDER = [
  ['SSS+', factorFromAchievement(100.5)],
  ['SSS', factorFromAchievement(100)],
  ['SS+', factorFromAchievement(99.5)],
  ['SS', factorFromAchievement(99)],
  ['S+', factorFromAchievement(98)],
  ['S', factorFromAchievement(97)],
  ['AAA', factorFromAchievement(94)],
  ['AA', factorFromAchievement(90)],
];
const GRID_MIN = 800;
const GRID_MAX = 2100;

const read = (method, params = {}) => cached(method, params);

/** 加权中位数：按用时排序后累加权重，跨过一半就取该点。 */
function weightedMedian(items) {
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

function weightedMean(items) {
  if (!items.length) return null;
  const total = items.reduce((n, r) => n + r.w, 0);
  if (!(total > 0)) return null;
  return items.reduce((n, r) => n + r.t * r.w, 0) / total;
}

/** 有效样本量 (Σw)² / Σw²：Gaussian 权重下的等效条数，稀疏时该值会明显小于原始条数。 */
function effectiveN(items) {
  const s1 = items.reduce((n, r) => n + r.w, 0);
  const s2 = items.reduce((n, r) => n + r.w ** 2, 0);
  return s2 > 0 ? s1 ** 2 / s2 : 0;
}

const manifest = JSON.parse(await fs.readFile(`${root}/manifest.json`, 'utf8'));
const store = openLedger(`${root}/processed/history-ledger.sqlite`);
const historyFor = store.historyFor;
const exactHandles = JSON.parse(await fs.readFile(`${root}/runs/first-batch/processed/selected-handles.json`, 'utf8'));
const exact = new Map();
for (const handle of exactHandles) {
  try {
    exact.set(handle, await read('user.rating', { handle }));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

// q → 选手 Rating 桶（25 分一桶）→ 用时数组。桶粒度取 25 是为了让 Gaussian 权重
// 在 REF_RADIUS 内有足够多的落点；最终读数仍由加权中位数给出，不受桶边界影响太多。
const cells = new Map();
/** 主口径子集（|Δ| ≤ 100）：给「门槛卡在人群哪个位置」用，与 quantiles.csv 同一批人。 */
const mainWindow = new Map();
let scanned = 0;
let skipped = 0;
let missingPrior = 0;

for (const c of manifest.contests) {
  const params = { contestId: String(c.id) };
  let standings;
  let changes;
  let status;
  try {
    standings = await read('contest.standings', params);
    changes = await read('contest.ratingChanges', params);
    status = await read('contest.status', params);
  } catch (e) {
    if (e.code === 'ENOENT') {
      skipped += 1;
      continue;
    }
    throw e;
  }
  for (const row of candidates(standings, changes, status, WINDOW)) {
    if (row.q < GRID_MIN || row.q > GRID_MAX) continue;
    const source = exact.get(row.handle) ?? historyFor(row.handle);
    const attached = attachHistory(row, source);
    if (!attached) {
      missingPrior += 1;
      continue;
    }
    scanned += 1;
    if (attached.priorRated < MAIN_MIN_PRIOR) continue;
    if (!attached.event) continue; // 只统计真正切出来的人
    const bucket = Math.floor(attached.oldRating / 25) * 25;
    let byBucket = cells.get(attached.q);
    if (!byBucket) cells.set(attached.q, (byBucket = new Map()));
    let list = byBucket.get(bucket);
    if (!list) byBucket.set(bucket, (list = []));
    list.push({ r: attached.oldRating, t: attached.time });
    if (Math.abs(attached.oldRating - attached.q) <= REF_RADIUS) {
      let main = mainWindow.get(attached.q);
      if (!main) mainWindow.set(attached.q, (main = []));
      main.push(attached.time);
    }
  }
}

console.log(`扫描 ${manifest.contests.length} 场，缺缓存 ${skipped}，样本行 ${scanned.toLocaleString('en-US')}，历史对不上 ${missingPrior}`);

/**
 * 围绕 target 取参照选手的用时，权重按到 target 的距离做高斯衰减（σ 与主口径同值 75）。
 * 只保留 |选手 Rating − target| ≤ REF_RADIUS 的落点 —— 超出这个半径的参照对象与
 * 「rating ≈ target 的选手」已经不是同一群人了。
 */
function sampleAt(q, target) {
  const byBucket = cells.get(q);
  if (!byBucket) return [];
  const items = [];
  const lo = Math.floor((target - REF_RADIUS) / 25) * 25;
  for (let bucket = lo; bucket <= target + REF_RADIUS; bucket += 25) {
    const list = byBucket.get(bucket);
    if (!list) continue;
    for (const row of list) {
      const d = row.r - target;
      if (Math.abs(d) > REF_RADIUS) continue;
      items.push({ t: row.t, w: Math.exp(-(d ** 2) / (2 * SIGMA ** 2)) });
    }
  }
  return items;
}

/** 「用时 ≤ 门槛」在主口径子集（±100、≥10 场 rated、已切出）里的占比。 */
function shareWithin(q, seconds) {
  const times = mainWindow.get(q);
  if (!times || !times.length) return null;
  return times.filter((t) => t <= seconds).length / times.length;
}

const t97Table = new Map();
for (const line of (await fs.readFile(`${outDir}/t97_table.csv`, 'utf8')).trim().split(/\r?\n/).slice(1)) {
  const cellsRow = line.split(',');
  t97Table.set(Number(cellsRow[0]), Number(cellsRow[1]));
}

const grid = [];
for (let q = GRID_MIN; q <= GRID_MAX; q += 100) grid.push(q);

const results = grid.map((q) => {
  const ranks = LADDER.map(([rank, factor]) => {
    const target = q * factor;
    const items = sampleAt(q, target);
    const median = weightedMedian(items);
    return {
      rank,
      factor,
      target,
      raw: items.length,
      effN: effectiveN(items),
      median,
      mean: weightedMean(items),
      share: median === null ? null : shareWithin(q, median),
    };
  });
  const base = ranks.find((r) => r.rank === 'S');
  for (const r of ranks) r.ratio = r.median !== null && base.median ? r.median / base.median : null;
  return { q, t97: t97Table.get(q) ?? null, ranks, mainN: (mainWindow.get(q) ?? []).length };
});

/**
 * 跨档位的合并阶梯：取每档比值在 14 个档位上的**中位数**。
 * 用中位数而不是均值，是因为 1900/2100 这类小样本档位的比值会离群
 * （1900 的 SSS+ 比值 0.844，明显高于其余档位），均值会被它带偏。
 */
const pooled = LADDER.map(([rank, factor], i) => {
  const ratios = results.map((row) => row.ranks[i].ratio).filter((x) => x !== null).sort((a, b) => a - b);
  const nEff = results.map((row) => row.ranks[i].effN).sort((a, b) => a - b);
  const mid =
    ratios.length % 2
      ? ratios[(ratios.length - 1) / 2]
      : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
  return { rank, factor, ratio: mid, min: ratios[0], max: ratios[ratios.length - 1], medianN: nEff[Math.floor(nEff.length / 2)] };
});

await fs.writeFile(
  `${outDir}/player-anchor-ratios${SUFFIX}.csv`,
  [
    'rank,factor,pooledRatio,minRatio,maxRatio',
    ...pooled.map((r) => [r.rank, r.factor.toFixed(4), r.ratio.toFixed(4), r.min.toFixed(4), r.max.toFixed(4)].join(',')),
  ].join('\n') + '\n',
);

const csv = [
  'q,rank,factor,targetRating,rawSamples,effectiveSamples,medianSeconds,meanSeconds,ratioToBase,shareAtThreshold',
  ...results.flatMap((row) =>
    row.ranks.map((r) =>
      [
        row.q,
        r.rank,
        r.factor.toFixed(4),
        Math.round(r.target),
        r.raw,
        r.effN.toFixed(1),
        r.median === null ? '' : Math.round(r.median),
        r.mean === null ? '' : Math.round(r.mean),
        r.ratio === null ? '' : r.ratio.toFixed(4),
        r.share === null ? '' : r.share.toFixed(4),
      ].join(','),
    ),
  ),
].join('\n');
await fs.writeFile(`${outDir}/player-anchor${SUFFIX}.csv`, `${csv}\n`);

const clock = (s) => (s === null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const ranks = LADDER.map(([rank]) => rank);
const lines = [];
lines.push('# 用「等效选手 Rating」锚定的六档门槛');
lines.push('');
lines.push('> 生成：`node scripts/cf-study/anchor-by-player-rating.mjs`（离线，读 `data/cf-study/raw`，窗口 ±' + WINDOW + '）');lines.push('');
lines.push('规则：`t_rank(q) = 中位用时(题目 Rating = q ｜ 选手赛前 Rating ≈ q × F_rank)`。');
lines.push('`F` 是 maimai 的系数因子；**S 档（F = 1.000）的参照选手正好是 rating ≈ q 的人，也就是 T97 原本的定义**。');
lines.push('参照窗口 ±' + REF_RADIUS + '，权重按到 target 的距离做高斯衰减（σ = ' + SIGMA + '）。');
lines.push('');
lines.push('## 表 0. 合并阶梯（14 个档位的中位比值）');
lines.push('');
lines.push('| 评级 | 系数因子 F | 用时 / 基准（S） | 各档位范围 | 中位有效样本量 | 折算到 T97 的窗口 |');
lines.push('|---|---:|---:|---|---:|---:|');
for (const p of pooled) {
  lines.push(
    `| ${p.rank} | ${p.factor.toFixed(3)} | **${p.ratio.toFixed(3)}** | ${p.min.toFixed(3)} – ${p.max.toFixed(3)} | ${Math.round(p.medianN).toLocaleString('en-US')} | ${((1 - p.ratio) * 100).toFixed(1)}% |`,
  );
}
lines.push('');
lines.push('**S 以上六档（SSS+ ~ S）是这批数据撑得住的读数**：有效样本量都在万级，14 个档位的比值范围也窄。');
lines.push('⚠️ AAA / AA 只能算参考：它们的参照选手比题目低 19% / 29%，落到 ±' + WINDOW + ' 采集窗口的更外侧，');
lines.push('1800 以上的 AA 只剩几十条（2000 档 n = 39、2100 档直接为空），比值已经不稳（1200 档 AAA 1.192 / AA 1.150 就是反的）。');
lines.push('再往下的档位（A/BBB/…）参照选手要低 40% 以上，本批数据锚不到，因此没有列。');
lines.push('「折算到 T97 的窗口」是该档相对 S 快了多少 —— 现行方案这一列从 S+ 到 SSS+ 分别是 1.0 / 2.0 / 2.5 / 3.0 / 3.5%，所以六档挤在半个百分点量级的用时里。');
lines.push('');
lines.push('## 表 1. 各档门槛用时');
lines.push('');
lines.push(`| 题目 Rating | T97（曲线，分钟） | ${ranks.join(' | ')} |`);
lines.push('|---:|---:|' + ranks.map(() => '---:').join('|') + '|');
for (const row of results) {
  lines.push(`| ${row.q} | ${row.t97 === null ? '—' : row.t97.toFixed(2)} | ${row.ranks.map((r) => clock(r.median)).join(' | ')} |`);
}
lines.push('');
lines.push('## 表 2. 门槛 ÷ 基准（S）—— 六档的实际间隔');
lines.push('');
lines.push(`| 题目 Rating | ${ranks.join(' | ')} | S→SSS+ 跨度 |`);
lines.push('|---:|' + ranks.map(() => '---:').join('|') + '|---:|');
for (const row of results) {
  const top = row.ranks[0].ratio;
  const bottom = row.ranks[row.ranks.length - 1].ratio;
  lines.push(
    `| ${row.q} | ${row.ranks.map((r) => (r.ratio === null ? '—' : r.ratio.toFixed(3))).join(' | ')} | ${top === null || bottom === null ? '—' : ((bottom - top) * 100).toFixed(1) + '%'} |`,
  );
}
lines.push('');
lines.push('## 表 3. 参照对象的样本量与门槛在人群里的位置');
lines.push('');
lines.push(`| 题目 Rating | ${ranks.map((r) => `${r} n`).join(' | ')} | ${ranks.map((r) => `${r} ≤`).join(' | ')} |`);
lines.push('|---:|' + ranks.map(() => '---:').join('|') + '|' + ranks.map(() => '---:').join('|') + '|');
for (const row of results) {
  lines.push(
    `| ${row.q} | ${row.ranks.map((r) => Math.round(r.effN)).join(' | ')} | ${row.ranks.map((r) => pct(r.share)).join(' | ')} |`,
  );
}
lines.push('');
lines.push('`n` 是高斯加权下的有效样本量（(Σw)²/Σw²）。`≤` 是「用时不超过该档门槛的解题者占比」，');
lines.push(`分母是主口径子集（题目 Rating 恰好等于该档、选手赛前 Rating 在 ±${REF_RADIUS} 内、已证实赛前 rated ≥ ${MAIN_MIN_PRIOR} 场、且当场切出），与 quantiles.csv 同一批人。`);
lines.push('');
await fs.writeFile(`${outDir}/PLAYER_ANCHOR${SUFFIX}.md`, lines.join('\n'));

console.log(`已写出 ${outDir}/player-anchor${SUFFIX}.csv 与 PLAYER_ANCHOR${SUFFIX}.md`);
console.log('合并阶梯：' + pooled.map((p) => `${p.rank}=${p.ratio.toFixed(3)}`).join(' '));
for (const row of results) {
  console.log(
    row.q,
    row.ranks.map((r) => `${r.rank}=${clock(r.median)}(×${r.ratio === null ? '?' : r.ratio.toFixed(3)},n=${Math.round(r.effN)})`).join(' '),
  );
}
store.close();
