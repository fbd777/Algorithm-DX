import type { DatabaseSync } from 'node:sqlite';
import type { Filters } from './queries.ts';
import { PRACTICE_PROBLEM } from '../problem-scope.ts';

/** A read-only social view. Only followed people, never the self account. */
export function getCircle(db: DatabaseSync, f: Filters, cursor: string | null, archived = false) {
  const people = db.prepare(`SELECT u.id, u.name,
    COUNT(s.id) AS submissions,
    COUNT(DISTINCT CASE WHEN s.status='AC' AND ${PRACTICE_PROBLEM.replaceAll('platform', 's.platform').replaceAll('problem_id', 's.problem_id')}
      THEN s.platform || char(31) || s.problem_id END) AS solved,
    MAX(s.submitted_at) AS last_at
    FROM users u LEFT JOIN accounts a ON a.user_id=u.id AND a.is_archived=0
    LEFT JOIN submissions s ON s.account_id=a.id
    WHERE u.is_self=0 AND u.is_followed=1 GROUP BY u.id ORDER BY last_at DESC, u.id`).all();
  const conditions = ['u.is_self=0', 'u.is_followed=1'];
  const values: (string | number)[] = [];
  if (!archived || f.userId === null) conditions.push('a.is_archived=0');
  if (f.userId !== null) { conditions.push('u.id=?'); values.push(f.userId); }
  if (f.platforms.length) { conditions.push(`s.platform IN (${f.platforms.map(() => '?').join(',')})`); values.push(...f.platforms); }
  if (f.status !== 'all') conditions.push(f.status === 'ac' ? "s.status='AC'" : "s.status<>'AC'");
  if (f.q) {
    conditions.push("(s.problem_title LIKE ? ESCAPE '\\' OR s.problem_id LIKE ? ESCAPE '\\')");
    const q = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`; values.push(q, q);
  }
  if (f.since !== null) { conditions.push('s.submitted_at>=?'); values.push(f.since); }
  if (f.until !== null) { conditions.push('s.submitted_at<=?'); values.push(f.until); }
  if (cursor) {
    const [time, id] = cursor.split(':').map(Number);
    conditions.push('(s.submitted_at<? OR (s.submitted_at=? AND s.id<?))'); values.push(time, time, id);
  }
  const rows = db.prepare(`SELECT s.*, u.id AS user_id, u.name AS user_name,
    a.handle, a.display_name, a.is_archived FROM submissions s
    JOIN accounts a ON a.id=s.account_id JOIN users u ON u.id=a.user_id
    WHERE ${conditions.join(' AND ')} ORDER BY s.submitted_at DESC, s.id DESC LIMIT 31`).all(...values);
  const items = rows.slice(0, 30);
  const last = items.at(-1);
  return { people, items, next: rows.length > 30 && last ? `${last.submitted_at}:${last.id}` : null };
}
