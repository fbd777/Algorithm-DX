/**
 * 出「各难度 × 各评级的用时」表，并回答「这套时间要求合不合理」。
 *
 * 表 1（用时）：全部走 `src/dx/rating.ts` 的 `secondsForAchievement()` —— 口径唯一出处，
 *   这里不重写公式。S 及以上六档的门槛由「等效选手 Rating」锚定（见 PLAYER_ANCHOR.md），
 *   S 以下走 ln(用时/T97) = a*d + b*d²，d = 97 - 完成度。
 *
 * 表 2（占比）：拿同一批门槛去切 `results/cf-study/quantiles.csv` 里**成功者用时的分位数**，
 *   算「用时不超过该门槛的 AC 者占多少」。它回答的是「这个时间要求卡掉多少人」，
 *   样本是**同档题目里所有成功 AC 的人**（不是全体参赛者，也不代表某个人的水平）。
 *
 * 表 3（评级本身）：评级 → 用时倍数 → factor → 单题 rating，与难度无关，
 *   用来看「六个等级之间到底差多少分」。
 *
 * 表 4（连续性）：把「用时比 → 完成度」在锚定节点**与节点之间**都取点列出来，
 *   用来核对完成度确实是连续插值出来的，而不是「过线就取门槛值」。
 *
 * 用法：node scripts/rank-time-table.ts
 * 产出：results/cf-study/RANK_TIMES.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACHIEVEMENT_DISPLAY_MAX,
  ACHIEVEMENT_RATING_MIN,
  DISPLAY_RANKS,
  PROBLEM_RATING_DIVISOR,
  RANK_LADDER,
  T97_ACHIEVEMENT,
  achievementFromSeconds,
  curveInfo,
  factorFromAchievement,
  lookupT97,
  rankOf,
  secondsForAchievement,
  timeRatioFromAchievement,
} from '../src/dx/rating.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUANTILES = join(ROOT, 'results', 'cf-study', 'quantiles.csv');
const OUT = join(ROOT, 'results', 'cf-study', 'RANK_TIMES.md');
/** 表 3 举例用的题目 Rating。factor 与难度无关，换个数只是换算系数不同。 */
const REFERENCE_Q = 1400;

/** 分位数列 → 累计比例。只取带权的（不带权的 `…Unweighted…` 是同一批数的对照）。 */
const QUANTILE_COLUMNS: readonly (readonly [string, number])[] = [
  ['successP10Seconds', 0.1],
  ['successP20Seconds', 0.2],
  ['successP30Seconds', 0.3],
  ['successP50Seconds', 0.5],
  ['successP70Seconds', 0.7],
  ['successP80Seconds', 0.8],
  ['successP90Seconds', 0.9],
  ['successP95Seconds', 0.95],
];

type Row = Record<string, string>;

function readCsv(path: string): Row[] {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Row = {};
    header.forEach((name, i) => {
      row[name] = cells[i] ?? '';
    });
    return row;
  });
}

/** `M:SS`；超过一小时才带上小时段。 */
function clock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * 「用时 ≤ seconds 的成功者占多少」。
 *
 * 用分位数网格做分段线性插值 —— 它是 CDF 的稀疏采样，档内线性是唯一不引入额外假设的读法。
 * 门槛落在 P10 以下或 P95 以上时只能给边界值，用 `clamped` 标出来，不假装精确。
 */
function shareWithin(band: Row, seconds: number): { share: number; clamped: 'below' | 'above' | null } | null {
  const knots: [number, number][] = [];
  for (const [column, p] of QUANTILE_COLUMNS) {
    const value = Number(band[column]);
    if (Number.isFinite(value) && value > 0) knots.push([value, p]);
  }
  if (knots.length < 2) return null;
  if (seconds <= knots[0][0]) return { share: knots[0][1], clamped: 'below' };
  const last = knots[knots.length - 1];
  if (seconds >= last[0]) return { share: last[1], clamped: 'above' };
  for (let i = 1; i < knots.length; i += 1) {
    const [t1, p1] = knots[i];
    if (seconds <= t1) {
      const [t0, p0] = knots[i - 1];
      return { share: p0 + ((p1 - p0) * (seconds - t0)) / (t1 - t0), clamped: null };
    }
  }
  return { share: last[1], clamped: 'above' };
}

const bands = new Map<number, Row>();
for (const row of readCsv(QUANTILES)) {
  if (row.kind === 'empirical') bands.set(Number(row.q), row);
}

const info = curveInfo();
const grid: number[] = [];
for (let q = info.fitMinQ; q <= info.fitMaxQ; q += 100) grid.push(q);

/** 每档：T97、六档门槛的秒数与在成功者里的累计占比、不计分门槛。 */
const rows = grid.map((q) => {
  const band = bands.get(q);
  const ranks = DISPLAY_RANKS.map(([rank, floor]) => {
    const seconds = secondsForAchievement(q, floor).seconds;
    return { rank, floor, seconds, share: band ? shareWithin(band, seconds) : null };
  });
  const noScoreSeconds = secondsForAchievement(q, ACHIEVEMENT_RATING_MIN).seconds;
  return {
    q,
    t97: lookupT97(q).seconds,
    ranks,
    noScoreSeconds,
    noScoreShare: band ? shareWithin(band, noScoreSeconds) : null,
    samples: band ? Number(band.samples) : 0,
  };
});

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/**
 * 六档跨度（百分点）= S 的累计占比 − SSS+ 的累计占比。
 * `DISPLAY_RANKS` 从高到低，所以 `ranks` 首位是 SSS+、末位是 S —— 在函数里取，避免调用处写错顺序。
 */
const spanOf = (ranks: readonly { share: { share: number } | null }[]): number => {
  const top = ranks[0]?.share;
  const bottom = ranks[ranks.length - 1]?.share;
  return top && bottom ? (bottom.share - top.share) * 100 : NaN;
};

const lines: string[] = [];
lines.push('# 各难度拿 S ~ SSS+ 的用时');
lines.push('');
lines.push('> 生成：`node scripts/rank-time-table.ts`');
lines.push(
  `> 源：\`${info.sourceFile}\`（T97 曲线，导出 ${info.generatedAt}，SHA256 \`${info.sourceSha256.slice(0, 12)}…\`）`,
);
lines.push('> 用时口径：`src/dx/rating.ts` 的 `secondsForAchievement()` —— S 及以上六档由「等效选手 Rating」锚定（见 [PLAYER_ANCHOR.md](PLAYER_ANCHOR.md)），S 以下是设计曲线 ln(用时/T97) = a*d + b*d²，d = 97 - 完成度。');
lines.push(`> ⚠️ 曲线 \`productionReady: ${info.productionReady}\`，下表是探索性估计，不是实测点。`);
lines.push('');
lines.push('## 1. 各评级需要的用时');
lines.push('');
lines.push('| 题目 Rating | ' + DISPLAY_RANKS.map(([rank, floor]) => `${rank} ${floor}%`).join(' | ') + ' | S→SSS+ 窗口 |');
lines.push('|---:|' + DISPLAY_RANKS.map(() => '---:').join('|') + '|---:|');
for (const row of rows) {
  const cells = row.ranks.map((r) => clock(r.seconds));
  const window = row.ranks[row.ranks.length - 1].seconds - row.ranks[0].seconds;
  lines.push(`| ${row.q} | ${cells.join(' | ')} | ${clock(window)} |`);
}
lines.push('');
lines.push('「S」这一列就是 T97 本身（用时 = T97 → 完成度正好 97%），所以它同时是曲线的读数。');
lines.push('');
lines.push('## 2. 这些门槛在成功者里卡掉多少人');
lines.push('');
lines.push('| 题目 Rating | 样本 | ' + DISPLAY_RANKS.map(([rank]) => `≤ ${rank}`).join(' | ') + ' | 六档跨度 | 不计分 |');
lines.push('|---:|---:|' + DISPLAY_RANKS.map(() => '---:').join('|') + '|---:|---:|');
for (const row of rows) {
  const cells = row.ranks.map((r) => r.share
    ? `${r.share.clamped === 'below' ? '≤' : r.share.clamped === 'above' ? '≥' : ''}${pct(r.share.share)}` : '—');
  const span = spanOf(row.ranks);
  const noScore = row.noScoreShare ? 1 - row.noScoreShare.share : NaN;
  const noScoreLabel = row.noScoreShare
    ? `${row.noScoreShare.clamped === 'above' ? '≤' : row.noScoreShare.clamped === 'below' ? '≥' : ''}${pct(noScore)}` : '—';
  lines.push(
    `| ${row.q} | ${row.samples.toLocaleString('en-US')} | ${cells.join(' | ')} | ${span.toFixed(1)} pp | ${noScoreLabel} |`,
  );
}
lines.push('');
lines.push('## 3. 评级本身（与难度无关）');
lines.push('');
lines.push(`| 评级 | 完成度 | 用时 / T97 | factor | 单题 rating（${REFERENCE_Q} 的题） |`);
lines.push('|---:|---:|---:|---:|---:|');
for (const [rank, floor] of RANK_LADDER) {
  if (floor < ACHIEVEMENT_RATING_MIN) continue;
  const ratio = timeRatioFromAchievement(floor);
  const factor = factorFromAchievement(floor);
  const rating = (REFERENCE_Q / PROBLEM_RATING_DIVISOR) * factor;
  lines.push(`| ${rank} | ${floor}% | ${ratio.toFixed(3)} | ${factor.toFixed(3)} | ${rating.toFixed(1)} |`);
}
lines.push('');
lines.push('## 4. 完成度是连续的（可核对表）');
lines.push('');
lines.push(
  `下表全部由 \`achievementFromSeconds()\` 算出，题目取 ${REFERENCE_Q} 的题。**刻意混入锚定节点与节点之间的取点** ——`,
);
lines.push(
  '「锚定节点」那一列标出六档门槛。节点间线性插值；快于 0.646 倍时完成度逐渐趋近 101%；慢于基准时，每下降相同的百分点需要更大的时间倍率。2 倍约 92.38%，4 倍约 89.33%。',
);
lines.push('');
lines.push('| 用时 ÷ T97 | 用时 | 完成度 | 显示值 | Rank | 锚定节点 | factor | 单题 rating |');
lines.push('|---:|---:|---:|---:|---|---:|---:|---:|');
{
  const t97 = lookupT97(REFERENCE_Q).seconds;
  const nodeRatios = DISPLAY_RANKS.map(([, floor]) => timeRatioFromAchievement(floor));
  // 节点与节点之间的取点都是刻意的：0.98 落在 S 与 S+ 之间，0.93 落在 SS 与 S+ 之间，
  // 0.60 / 0.50 落在 SSS+ 门槛之外（用来证明这里不再封顶）。
  const samples = [0.5, 0.6, 0.646, 0.7, 0.732, 0.797, 0.846, 0.9, 0.939, 0.98, 1, 1.05, 1.1, 1.2, 1.3, 1.5, 2, 3, 4, 6, 8];
  for (const ratio of samples) {
    const seconds = ratio * t97;
    const achievement = achievementFromSeconds(seconds, t97);
    const factor = factorFromAchievement(achievement);
    const node = nodeRatios.some((r) => Math.abs(r - ratio) < 1e-9);
    lines.push(
      `| ${ratio.toFixed(3)} | ${clock(seconds)} | ${achievement.toFixed(2)}% | ${Math.min(achievement, ACHIEVEMENT_DISPLAY_MAX).toFixed(2)}% | ${rankOf(achievement)} | ${node ? '**是**' : '—'} | ${factor.toFixed(3)} | ${((REFERENCE_Q / PROBLEM_RATING_DIVISOR) * factor).toFixed(1)} |`,
    );
  }
}
lines.push('');
lines.push('## 5. 怎么读');
lines.push('');
lines.push(
  '- **占比的分母是「同档题目里成功 AC 的人」**，不是全体参赛者，也不是某个人的水平。它回答「这个门槛卡在人群的哪个位置」。',
);
lines.push('- **「六档跨度」是关键读数**：S 到 SSS+ 六个等级合起来只区分了成功者中的这么多个百分点；跨度越小，中间的标签越不传递信息。');
lines.push(
  `- **「不计分」= 用时超过 T97 的 ${timeRatioFromAchievement(ACHIEVEMENT_RATING_MIN).toExponential(3)} 倍**（完成度跌破 ${ACHIEVEMENT_RATING_MIN}%）。新曲线下这是理论门槛，不能作为实际用时输入的约束；该零分规则是项目取舍。`,
);
lines.push(
  '- 占比来自 `results/cf-study/quantiles.csv` 的分位数网格（P10/P20/P30/P50/P70/P80/P90/P95）线性插值，档间不引入额外假设；门槛越过 P10/P95 时只能给边界值。',
);
lines.push('- T97 曲线本身是「成功者中位耗时」估计量，所以「S」在人群里的位置天然落在 50% 附近，这一点不是巧合。');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');

const spans = rows.map((r) => spanOf(r.ranks));
console.log(`已写出 ${OUT}`);
console.log(`行数 ${rows.length}（${grid[0]}–${grid[grid.length - 1]} 步长 100）`);
console.log(`六档跨度 ${Math.min(...spans).toFixed(1)}–${Math.max(...spans).toFixed(1)} pp`);
console.log('不计分比例见表：超出 P10/P95 的数值只报告边界，不是实测比例。');
