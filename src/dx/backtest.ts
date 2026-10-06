/** Offline evaluation shared by the public study and voluntary local exports. No network or database writes. */
import { DX_CURVE } from './curve.ts';
import { achievementFromSeconds, buildBoard, SLOW_DECAY_LINEAR, SLOW_DECAY_QUADRATIC, TOP_FACTOR_GAIN } from './rating.ts';
import type { DxEntry } from './types.ts';
import type { PracticeAttempt } from './practice.ts';

export const BACKTEST_SCHEMA = 'algorithm-dx-backtest-v1';
export const ALGORITHMS = ['linear-clipped-v1', 'bounded-tail-v2', 'gentle-decay-v3'] as const;
export const ACHIEVEMENT_BINS = ['<97', '[97,100)', '[100,100.5)', '[100.5,100.9)', '[100.9,101)', '101'] as const;

export function modelMetadata() {
  return { algorithms: ALGORITHMS, curveSha256: DX_CURVE.sourceSha256,
    fitRange: [DX_CURVE.fitMinQ, DX_CURVE.fitMaxQ], ratingGain: TOP_FACTOR_GAIN,
    legacyTail: { anchorRatio: 0.646, nextRatio: 0.732, displayCap: 101 },
    currentTail: { anchorRatio: 0.646, anchorAchievement: 100.5, limit: 101 },
    slowDecay: { version: 'gentle-decay-v3', linear: SLOW_DECAY_LINEAR, quadratic: SLOW_DECAY_QUADRATIC, floor: 0 } };
}

export function achievementForVersion(seconds: number, t97: number, version: typeof ALGORITHMS[number]): number {
  if (version === 'gentle-decay-v3') return achievementFromSeconds(seconds, t97);
  if (version !== 'linear-clipped-v1' && version !== 'bounded-tail-v2') throw new Error('未知算法版本');
  if (!(seconds > 0) || !Number.isFinite(seconds) || !(t97 > 0) || !Number.isFinite(t97)) throw new RangeError('用时与 T97 必须是有限正数');
  const r = seconds / t97;
  if (r >= 1) return 97 / r;
  return version === 'linear-clipped-v1' && r < 0.646
    ? Math.min(101, 100.5 + (0.646 - r) * 0.5 / (0.732 - 0.646)) : achievementFromSeconds(seconds, t97);
}

function distribution(values: number[]) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const a of values) counts[a < 97 ? 0 : a < 100 ? 1 : a < 100.5 ? 2 : a < 100.9 ? 3 : a < 101 ? 4 : 5]++;
  const ordered = [...values].sort((a, b) => a - b);
  return { count: values.length, counts,
    median: ordered.length ? (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2 : null,
    share100To101: values.length ? (counts[2] + counts[3] + counts[4]) / values.length : null,
    shareAt101: values.length ? counts[5] / values.length : null };
}

/** Caller supplies calendar boundaries; never treat incomplete boards as 50 observations. */
export function compareBoards(entries: readonly DxEntry[], since: number, until: number) {
  if (!(until > since)) throw new Error('年度边界不合法');
  const unique = new Map<string, DxEntry>();
  const excluded = { missingRating: 0, missingTime: 0, outsideFit: 0, futureRelease: 0, duplicate: 0 };
  for (const entry of entries) {
    if (entry.releasedAt !== null && entry.releasedAt >= until) { excluded.futureRelease++; continue; }
    if (entry.problemRating === null) { excluded.missingRating++; continue; }
    if (entry.recordedSeconds === null || !(entry.recordedSeconds > 0)) { excluded.missingTime++; continue; }
    if (entry.problemRating < DX_CURVE.fitMinQ || entry.problemRating > DX_CURVE.fitMaxQ) { excluded.outsideFit++; continue; }
    const key = `${entry.platform}:${entry.problemId}`;
    const prev = unique.get(key);
    if (prev) excluded.duplicate++;
    if (!prev || entry.recordedSeconds < prev.recordedSeconds!) unique.set(key, entry);
  }
  const eligible = [...unique.values()];
  const board = buildBoard(eligible, since);
  return { eligibleProblems: eligible.length, unknownRelease: eligible.filter(e => e.releasedAt === null).length,
    excluded, oldCount: board.oldCount, newCount: board.currentCount,
    fullBoard: board.oldCount === 35 && board.currentCount === 15,
    // Slow-decay changes can reorder B50; select and score each version independently.
    variants: ALGORITHMS.map(version => {
      const variantBoard = version === 'gentle-decay-v3' ? board :
        buildBoard(eligible, since, DX_CURVE, (seconds, t97) => achievementForVersion(seconds, t97, version));
      const slots = [...variantBoard.old, ...variantBoard.current].filter(s => s.entry && s.score);
      return { version, rating: variantBoard.rating, ...distribution(slots.map(s => s.score!.achievement)) };
    }) };
}

export type BoardComparison = ReturnType<typeof compareBoards>;

export function aggregateBoards(boards: readonly BoardComparison[]) {
  return { participants: boards.length, fullBoards: boards.filter(b => b.fullBoard).length,
    variants: ALGORITHMS.map(version => {
      const rows = boards.map(b => b.variants.find(v => v.version === version)!).filter(v => v.count > 0);
      const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      return { version, participantsWithScores: rows.length,
        meanPlayerShare100To101: mean(rows.map(r => r.share100To101!)),
        meanPlayerShareAt101: mean(rows.map(r => r.shareAt101!)),
        slotCounts: ACHIEVEMENT_BINS.map((_, i) => rows.reduce((n, row) => n + row.counts[i], 0)) };
    }) };
}

/** Whitelist-only export: no names, IDs, handles, problem IDs, exact dates, paths or individual times. */
export function localBacktestReport(entries: readonly DxEntry[], attempts: readonly PracticeAttempt[], year: number, since: number, until: number) {
  const valid = attempts.filter(a => a.platform === 'codeforces' && a.voided_at === null && a.archived_at === null);
  const entriesById = new Map(entries.map(e => [e.problemId, e]));
  const dated = valid.filter(a => a.timing_source === 'manual' && a.practice_kind !== 'unknown'
    && a.practice_kind !== 'assisted' && a.attempted_at !== null && a.attempted_at < until)
    .sort((a, b) => a.attempted_at! - b.attempted_at! || a.id - b.id);
  const toEntries = (rows: readonly PracticeAttempt[]) => rows.flatMap(a => {
    const e = entriesById.get(a.problem_id);
    return a.outcome === 'ac' && e ? [{ ...e, recordedSeconds: a.seconds }] : [];
  });
  const countsBy = (field: 'timing_source' | 'practice_kind' | 'outcome', names: string[]) => Object.fromEntries(
    names.map(name => [name, valid.filter(a => a[field] === name).length]));
  const checkpoints = [25, 50, 100, 200, 500].filter(n => n <= dated.length).map(n => ({
    observedAttempts: n, board: compareBoards(toEntries(dated.slice(0, n)), since, until),
  }));
  return { schema: BACKTEST_SCHEMA, kind: 'local-summary', year, models: modelMetadata(), bins: ACHIEVEMENT_BINS,
    calendar: { startOffsetMinutes: new Date(since * 1000).getTimezoneOffset(), endOffsetMinutes: new Date(until * 1000).getTimezoneOffset() },
    policy: { automaticUpload: false, yearMeaning: 'release-year; current best is not a historical snapshot',
      calibrationScope: 'dated manual first/repeat attempts before year end; current problem difficulty',
      fullBoardDoesNotProveTraining: true, unknownReleaseAssignedToOld: true,
      outsideFitExcluded: true, attemptsCoverage: 'only locally recorded attempts; not complete practice history' },
    coverage: { attempts: valid.length, voidedAttempts: attempts.filter(a => a.voided_at !== null).length,
      unknownAttemptDate: valid.filter(a => a.attempted_at === null).length,
      sources: countsBy('timing_source', ['legacy', 'manual', 'contest_estimate', 'timer']),
      kinds: countsBy('practice_kind', ['unknown', 'first', 'repeat', 'assisted']),
      outcomes: countsBy('outcome', ['ac', 'unfinished']) },
    currentBest: compareBoards(entries, since, until),
    independentManual: compareBoards(toEntries(dated), since, until),
    firstOnly: compareBoards(toEntries(dated.filter(a => a.practice_kind === 'first')), since, until),
    repeatOnly: compareBoards(toEntries(dated.filter(a => a.practice_kind === 'repeat')), since, until),
    checkpoints };
}

/** Validate only the comparable summaries; never copy arbitrary imported fields into a merged report. */
export function mergeLocalReports(reports: unknown[]) {
  if (!reports.length) throw new Error('至少提供一份报告');
  let signature: string | undefined;
  let year = 0;
  const cohorts: Record<string, BoardComparison[]> = { currentBest: [], independentManual: [], firstOnly: [], repeatOnly: [] };
  for (const input of reports) {
    const r = input as ReturnType<typeof localBacktestReport>;
    if (!r || r.schema !== BACKTEST_SCHEMA || r.kind !== 'local-summary'
      || !Number.isInteger(r.year) || r.year < 2000 || r.year > 3000
      || JSON.stringify(r.models) !== JSON.stringify(modelMetadata())
      || JSON.stringify(r.bins) !== JSON.stringify(ACHIEVEMENT_BINS)
      || !r.calendar || !Number.isInteger(r.calendar.startOffsetMinutes) || !Number.isInteger(r.calendar.endOffsetMinutes))
      throw new Error('报告格式或算法/曲线版本不一致');
    const key = JSON.stringify([r.year, r.calendar.startOffsetMinutes, r.calendar.endOffsetMinutes]);
    if (signature !== undefined && signature !== key) throw new Error('报告年度或日历时区不一致，须分组汇总');
    signature = key; year = r.year;
    for (const name of ['currentBest', 'independentManual', 'firstOnly', 'repeatOnly'] as const) {
      const board = r[name];
      if (!board || !Number.isInteger(board.oldCount) || board.oldCount < 0 || board.oldCount > 35
        || !Number.isInteger(board.newCount) || board.newCount < 0 || board.newCount > 15
        || board.fullBoard !== (board.oldCount === 35 && board.newCount === 15)
        || !Array.isArray(board.variants) || board.variants.length !== ALGORITHMS.length) throw new Error('榜单覆盖信息无效');
      for (const [i, row] of board.variants.entries()) {
        if (row.version !== ALGORITHMS[i] || !Array.isArray(row.counts) || row.counts.length !== ACHIEVEMENT_BINS.length
          || row.counts.some(n => !Number.isInteger(n) || n < 0) || row.count !== board.oldCount + board.newCount
          || row.counts.reduce((a, b) => a + b, 0) !== row.count
          || row.share100To101 !== (row.count ? (row.counts[2] + row.counts[3] + row.counts[4]) / row.count : null)
          || row.shareAt101 !== (row.count ? row.counts[5] / row.count : null)) throw new Error('完成度分布无效');
      }
      cohorts[name].push(board);
    }
  }
  const [, startOffsetMinutes, endOffsetMinutes] = JSON.parse(signature!);
  return { schema: BACKTEST_SCHEMA, kind: 'merged-local-summary', year, calendar: { startOffsetMinutes, endOffsetMinutes },
    models: modelMetadata(), bins: ACHIEVEMENT_BINS,
    reports: reports.length, policy: 'One latest report per person, chosen by the operator; identity-free reports cannot deduplicate people. No upload.',
    cohorts: Object.fromEntries(Object.entries(cohorts).map(([name, boards]) => [name, {
      all: aggregateBoards(boards), full: aggregateBoards(boards.filter(b => b.fullBoard)),
      incomplete: aggregateBoards(boards.filter(b => !b.fullBoard)),
    }])) };
}
