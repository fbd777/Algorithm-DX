// Replay cached official contest responses. Never fetches, uploads, or changes the production curve.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cached } from './api.mjs';
import { candidates } from './core.mjs';
import { ALGORITHMS, ACHIEVEMENT_BINS, BACKTEST_SCHEMA, compareBoards, modelMetadata } from '../../src/dx/backtest.ts';

const options = { year: new Date().getUTCFullYear(), minContests: 10, limit: Infinity,
  manifest: 'data/cf-study/manifest.json', out: 'results/cf-study/b50-backtest.json' };
for (const arg of process.argv.slice(2)) {
  if (arg === '--help') {
    console.log('npm run study:backtest -- --year=2026 --min-contests=10 --limit=5 --out=results/cf-study/b50-backtest.json\n只读取 data/cf-study/raw 的缓存；缺缓存时失败，请先运行现有采集流程。--limit 仅用于冒烟检查。');
    process.exit(0);
  }
  const match = /^--(year|min-contests|limit|manifest|out)=(.+)$/.exec(arg);
  if (!match) throw new Error(`未知参数：${arg}`);
  const key = match[1] === 'min-contests' ? 'minContests' : match[1];
  options[key] = ['year', 'minContests', 'limit'].includes(key) ? Number(match[2]) : match[2];
}
if (!Number.isInteger(options.year) || options.year < 2000 || options.year > 3000
  || !Number.isInteger(options.minContests) || options.minContests < 1
  || (options.limit !== Infinity && (!Number.isInteger(options.limit) || options.limit < 1))) throw new Error('数值参数无效');
const since = Date.UTC(options.year, 0, 1) / 1000, until = Date.UTC(options.year + 1, 0, 1) / 1000;
const manifestBytes = await fs.readFile(options.manifest);
const manifest = JSON.parse(manifestBytes);
const contests = [...new Map(manifest.contests.map(c => [c.id, c])).values()].sort((a, b) => a.id - b.id).slice(0, options.limit);
const players = new Map();
const coverage = { requestedContests: contests.length, processedContests: 0, afterYearContests: 0,
  solvedRecords: 0, censoredRecords: 0, participants: 0, excludedByContestCount: 0 };
let earliest = Infinity, latest = 0;
for (const [index, contest] of contests.entries()) {
  const params = { contestId: String(contest.id) };
  // Deliberately use cached(), not api(): missing evidence must never silently trigger collection.
  const standings = await cached('contest.standings', params);
  if (standings.contest.startTimeSeconds >= until) { coverage.afterYearContests++; continue; }
  const changes = await cached('contest.ratingChanges', params);
  const submissions = await cached('contest.status', params);
  // The T97 samples file is restricted to |player rating - problem rating| <= 150.
  // Reconstruct without that window or a player's easy, fast B50 candidates would be missing.
  const records = candidates(standings, changes, submissions, Infinity);
  for (const r of records) {
    if (r.startTime + r.start + r.time >= until) continue;
    let player = players.get(r.handle);
    if (!player) players.set(r.handle, player = { entries: [], contests: new Set(), latest: 0, rating: r.oldRating });
    player.contests.add(r.contestId);
    if (r.startTime > player.latest) { player.latest = r.startTime; player.rating = r.oldRating; }
    if (!r.event) { coverage.censoredRecords++; continue; }
    coverage.solvedRecords++;
    player.entries.push({ platform: 'codeforces', problemId: `${r.contestId}:${r.problem}`, problemTitle: '', problemUrl: null,
      problemRating: r.q, releasedAt: r.startTime, solvedAt: r.startTime + r.start + r.time, recordedSeconds: r.time });
  }
  coverage.processedContests++;
  earliest = Math.min(earliest, standings.contest.startTimeSeconds);
  latest = Math.max(latest, standings.contest.startTimeSeconds);
  console.log(`回放 ${index + 1}/${contests.length} 场；累计 ${players.size} 位选手`);
}

const groups = new Map();
function accumulate(key, board) {
  let group = groups.get(key);
  if (!group) groups.set(key, group = { group: key, participants: 0, fullBoards: 0,
    variants: ALGORITHMS.map(version => ({ version, participantsWithScores: 0, meanPlayerShare100To101: 0,
      meanPlayerShareAt101: 0, slotCounts: ACHIEVEMENT_BINS.map(() => 0) })) });
  group.participants++;
  group.fullBoards += Number(board.fullBoard);
  board.variants.forEach((row, i) => {
    if (!row.count) return;
    const target = group.variants[i];
    target.participantsWithScores++;
    target.meanPlayerShare100To101 += row.share100To101;
    target.meanPlayerShareAt101 += row.shareAt101;
    row.counts.forEach((n, j) => target.slotCounts[j] += n);
  });
}
for (const [handle, player] of players) {
  if (player.contests.size < options.minContests) { coverage.excludedByContestCount++; continue; }
  const split = createHash('sha256').update(handle).digest()[0] % 5 === 0 ? 'holdout' : 'development';
  const ratingBand = `${Math.floor(player.rating / 400) * 400}-${Math.floor(player.rating / 400) * 400 + 399}`;
  const board = compareBoards(player.entries, since, until);
  const status = board.fullBoard ? 'full' : 'incomplete';
  accumulate(`${split}/all/${status}`, board);
  accumulate(`${split}/rating-${ratingBand}/${status}`, board);
  const activity = board.eligibleProblems < 50 ? 'under50' : board.eligibleProblems < 100 ? '50-99' : board.eligibleProblems < 200 ? '100-199' : '200plus';
  accumulate(`${split}/problems-${activity}/${status}`, board);
  const ordered = player.entries.sort((a, b) => a.solvedAt - b.solvedAt);
  for (const n of [25, 50, 100, 200]) if (ordered.length >= n) {
    const checkpoint = compareBoards(ordered.slice(0, n), since, until);
    accumulate(`${split}/first-${n}-observed-solves/${checkpoint.fullBoard ? 'full' : 'incomplete'}`, checkpoint);
  }
}
coverage.participants = players.size;
for (const group of groups.values()) for (const row of group.variants) {
  row.meanPlayerShare100To101 = row.participantsWithScores ? row.meanPlayerShare100To101 / row.participantsWithScores : null;
  row.meanPlayerShareAt101 = row.participantsWithScores ? row.meanPlayerShareAt101 / row.participantsWithScores : null;
}
const report = { schema: BACKTEST_SCHEMA, kind: 'public-contest-summary', year: options.year, models: modelMetadata(), bins: ACHIEVEMENT_BINS,
  source: { manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), contestIds: contests.map(c => c.id),
    firstContestYear: Number.isFinite(earliest) ? new Date(earliest * 1000).getUTCFullYear() : null,
    lastContestYear: latest ? new Date(latest * 1000).getUTCFullYear() : null, calendar: 'UTC', minObservedContests: options.minContests },
  limitations: ['Cached selected contests are not a representative population sample or a complete player history.',
    'No rating-distance window; original ordered-progression and shared-subtask-start filters still apply.',
    'Contest intervals estimate elapsed time; they are not measured practice time. Censored records never score.',
    'Difficulty uses cached official values. Only the production fit range participates.',
    'Full B35/B15 is coverage, not proof of sufficient training. Incomplete boards are reported separately.',
    'Development/holdout groups are assigned by player hash; T97 itself was fitted using study contests, so this is not independent curve validation.',
    'Checkpoint cohorts differ in coverage. Differences do not establish a causal training effect.'],
  coverage, groups: [...groups.values()].sort((a, b) => a.group.localeCompare(b.group)) };
await fs.mkdir(path.dirname(options.out), { recursive: true });
await fs.writeFile(options.out, JSON.stringify(report, null, 2) + '\n');
console.log(`已写入 ${options.out}；${coverage.processedContests} 场，${groups.size} 组。没有修改生产参数。`);
