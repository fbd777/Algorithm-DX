import type { DatabaseSync } from 'node:sqlite';
import { buildWhere, type Filters } from './queries.ts';
import { isContestScopedProblem } from '../problem-scope.ts';
import { scoreProblem, curveInfo } from '../dx/rating.ts';
import type { PracticeAttempt } from '../dx/practice.ts';

interface TodayRow {
  user_id:number; user_name:string; platform:string; problem_id:string; problem_title:string;
  problem_url:string|null; difficulty:number|null; submitted_at:number; status:string; language:string|null;
}

/** Today follows the browser timezone, independent of the historical date filter. */
export function getToday(db: DatabaseSync, filters: Filters, now = Date.now() / 1000) {
  const offset = filters.tzOffsetMinutes * 60;
  const start = Math.floor((now + offset) / 86400) * 86400 - offset;
  const where = buildWhere({ ...filters, since: start, until: Math.min(now, start + 86400 - 1), q: null });
  const rows = db.prepare(`SELECT s.*, a.user_id, u.name AS user_name FROM submissions s
    JOIN accounts a ON a.id=s.account_id JOIN users u ON u.id=a.user_id
    ${where.sql} ORDER BY s.submitted_at,s.id`).all(...where.params) as unknown as TodayRow[];
  const groups = new Map<string, TodayRow[]>();
  for (const row of rows) {
    if (isContestScopedProblem(row.platform, row.problem_id)) continue;
    const key = JSON.stringify([row.user_id,row.platform,row.problem_id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const history = db.prepare(`SELECT MIN(s.submitted_at) AS first FROM submissions s JOIN accounts a ON a.id=s.account_id
    WHERE a.user_id=? AND a.is_archived=0 AND s.platform=? AND s.problem_id=? AND s.status='AC'`);
  const practice = db.prepare(`SELECT * FROM practice_attempts WHERE user_id=? AND platform=? AND problem_id=?
    AND outcome='ac' AND voided_at IS NULL AND archived_at IS NULL AND attempted_at>=? AND attempted_at<=?
    ORDER BY attempted_at DESC,recorded_at DESC,id DESC`);
  const cards = [...groups.values()].flatMap(group => {
    const accepted = group.filter(r => r.status === 'AC');
    if (!accepted.length) return [];
    const row = accepted[accepted.length - 1];
    // Attach only an actual AC's practice record, never a best time from an older day.
    const attempt = (practice.all(row.user_id,row.platform,row.problem_id,start,now) as unknown as PracticeAttempt[])
      .find(p => accepted.some(r => r.submitted_at === p.attempted_at));
    const first = Number(history.get(row.user_id,row.platform,row.problem_id)!.first);
    const score = attempt && attempt.practice_kind !== 'assisted' ? scoreProblem({
      platform:row.platform,problemId:row.problem_id,problemTitle:row.problem_title,problemUrl:row.problem_url,
      problemRating:row.difficulty,solvedAt:row.submitted_at,releasedAt:null,recordedSeconds:attempt.seconds,
    }) : null;
    return [{ userId:row.user_id,userName:row.user_name,platform:row.platform,problemId:row.problem_id,
      title:row.problem_title,url:row.problem_url,difficulty:row.difficulty,firstAc:accepted[0].submitted_at,
      lastAc:row.submitted_at,fresh:first>=start,submissions:group.length,ac:accepted.length,
      language:row.language,seconds:attempt?.seconds??null,practiceKind:attempt?.practice_kind??null,
      timingSource:attempt?.timing_source??null,practiceAt:attempt?.attempted_at??null,score }];
  }).sort((a,b)=>b.lastAc-a.lastAc);
  const hours = Array.from({length:24},(_,hour)=>({hour,submissions:0,ac:0}));
  for(const row of rows){const h=hours[new Date((row.submitted_at+offset)*1000).getUTCHours()];h.submissions++;if(row.status==='AC')h.ac++;}
  const timed = cards.filter(c=>c.seconds!==null);
  const rated = cards.filter(c=>c.score!==null);
  const best = [...rated].sort((a,b)=>b.score!.achievement-a.score!.achievement)[0];
  return { date:new Date((start+offset)*1000).toISOString().slice(0,10),cards,hours,curve:curveInfo(),
    summary:{solved:cards.length,fresh:cards.filter(c=>c.fresh).length,submissions:rows.length,
      ac:rows.filter(r=>r.status==='AC').length,attempted:groups.size,unfinished:groups.size-cards.length,
      timed:timed.length,seconds:timed.reduce((n,c)=>n+c.seconds!,0),rated:rated.length,
      bestRank:best?.score?.rank??null,bestTitle:best?.title??null} };
}
