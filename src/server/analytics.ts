import type { DatabaseSync } from 'node:sqlite';
import { buildWhere, type Filters } from './queries.ts';
import { isContestScopedProblem } from '../problem-scope.ts';
import { languageLabel } from '../../public/stat-labels.js';

type Row = { platform: string; problem_id: string; status: string; submitted_at: number; difficulty: number | null; tags_json: string; language: string | null };
const day = (seconds: number, offset: number) => new Date((seconds + offset * 60) * 1000).toISOString().slice(0, 10);

/** First AC is measured against all stored history in the selected people/platform scope.
 * Status is a feed-only filter, matching getStats. Problem totals deduplicate across people.
 */
export function getAnalytics(db: DatabaseSync, f: Filters, now = Date.now() / 1000) {
  const clause = buildWhere({ ...f, since: null, until: null });
  const rows = db.prepare(`SELECT s.platform, s.problem_id, s.status, s.submitted_at,
    s.difficulty, s.tags_json, s.language FROM submissions s
    JOIN accounts a ON a.id=s.account_id JOIN users u ON u.id=a.user_id
    ${clause.sql} ORDER BY s.submitted_at, s.id`).all(...clause.params) as Row[];
  const first = new Set<string>();
  const solved = new Map<string, Row>();
  const daily = new Map<string, { date: string; submissions: number; ac: number; solved: Set<string>; fresh: number }>();
  const languages = new Map<string, number>();
  const verdicts = new Map<string, number>();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ label: `${hour}:00`, count: 0 }));
  let ac = 0, submissions = 0, fresh = 0;
  for (const row of rows) {
    const key = JSON.stringify([row.platform, row.problem_id]);
    const accepted = row.status === 'AC';
    const practice = !isContestScopedProblem(row.platform, row.problem_id);
    const isFirst = accepted && practice && !first.has(key);
    if (accepted && practice) first.add(key);
    if ((f.since !== null && row.submitted_at < f.since) || (f.until !== null && row.submitted_at > f.until)) continue;
    submissions++;
    const date = day(row.submitted_at, f.tzOffsetMinutes);
    if (!daily.has(date)) daily.set(date, { date, submissions: 0, ac: 0, solved: new Set(), fresh: 0 });
    const d = daily.get(date)!;
    d.submissions++;
    verdicts.set(row.status, (verdicts.get(row.status) ?? 0) + 1);
    const language = languageLabel(row.language);
    languages.set(language, (languages.get(language) ?? 0) + 1);
    hours[new Date((row.submitted_at + f.tzOffsetMinutes * 60) * 1000).getUTCHours()].count++;
    if (accepted) { d.ac++; ac++; }
    if (accepted && practice) { d.solved.add(key); solved.set(key, row); }
    if (isFirst) { d.fresh++; fresh++; }
  }
  const days = [...daily.values()].map(d => ({ ...d, solved: d.solved.size }));
  const tags = new Map<string, number>();
  const difficulties = new Map<string, Map<string, number>>();
  for (const row of solved.values()) {
    let parsed: unknown = [];
    try { parsed = JSON.parse(row.tags_json); } catch { /* missing metadata */ }
    const labels = Array.isArray(parsed) ? [...new Set(parsed.filter((v): v is string => typeof v === 'string' && !!v))] : [];
    for (const label of labels.length ? labels : ['未标注']) tags.set(label, (tags.get(label) ?? 0) + 1);
    if (!difficulties.has(row.platform)) difficulties.set(row.platform, new Map());
    const map = difficulties.get(row.platform)!;
    const label = row.difficulty === null ? '未知难度' : String(row.difficulty);
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  const counts = (map: Map<string, number>) => [...map].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  let longest = 0, streak = 0, previous = -Infinity;
  for (const d of days.filter(d => d.solved > 0)) {
    const n = Date.parse(d.date) / 86400000;
    streak = n === previous + 1 ? streak + 1 : 1;
    previous = n;
    longest = Math.max(longest, streak);
  }
  const end = day(f.until ?? now, f.tzOffsetMinutes);
  const start = day(f.since ?? (days.length ? Date.parse(days[0].date) / 1000 - f.tzOffsetMinutes * 60 : Math.min(now, f.until ?? now)), f.tzOffsetMinutes);
  return { start, end, days, hours, languages: counts(languages), verdicts: counts(verdicts), tags: counts(tags),
    difficulties: [...difficulties].map(([platform, map]) => ({ platform, items: counts(map).sort((a, b) => (a.label === '未知难度' ? Infinity : Number(a.label)) - (b.label === '未知难度' ? Infinity : Number(b.label))) })),
    summary: { submissions, ac, fresh, solved: solved.size, activeDays: days.length,
      acDays: days.filter(d => d.solved > 0).length, longest,
      current: previous >= Date.parse(end) / 86400000 - 1 ? streak : 0,
      bestDay: Math.max(0, ...days.map(d => d.solved)), acRate: submissions ? ac / submissions * 100 : 0 } };
}
