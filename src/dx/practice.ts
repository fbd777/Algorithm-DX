import type { DatabaseSync } from 'node:sqlite';
import { computeContestAutoSeconds, DX_PLATFORM } from './rating.ts';
import { listContestTimeline } from '../server/queries.ts';

export interface PracticeInput {
  userId: number;
  platform: string;
  problemId: string;
  seconds: number;
  outcome: 'ac' | 'unfinished';
  practiceKind: 'unknown' | 'first' | 'repeat' | 'assisted';
  timingSource: 'manual' | 'contest_estimate';
  attemptedAt: number | null;
  requestId?: string;
  manual?: boolean;
  title?: string;
  difficulty?: number | null;
}
export interface PracticeAttempt {
  id: number; user_id: number; platform: string; problem_id: string; seconds: number;
  outcome: 'ac' | 'unfinished'; practice_kind: PracticeInput['practiceKind'];
  timing_source: 'legacy' | 'timer' | PracticeInput['timingSource']; attempted_at: number | null;
  recorded_at: number; voided_at: number | null; archived_at: number | null;
  revision: number; edited_at: number | null;
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('SAVEPOINT practice_write');
  try { const result = action(); db.exec('RELEASE practice_write'); return result; }
  catch (error) { db.exec('ROLLBACK TO practice_write; RELEASE practice_write'); throw error; }
}

/** Materialized best time for the existing DX queries; raw history is the source of truth. */
export function refreshBestTime(db: DatabaseSync, userId: number, platform: string, problemId: string): void {
  const best = db.prepare(`SELECT MIN(seconds) AS seconds FROM practice_attempts
    WHERE user_id=? AND platform=? AND problem_id=? AND voided_at IS NULL AND archived_at IS NULL
    AND outcome='ac' AND practice_kind!='assisted'`).get(userId, platform, problemId)!;
  if (best.seconds === null) {
    db.prepare('DELETE FROM problem_times WHERE user_id=? AND platform=? AND problem_id=?').run(userId, platform, problemId);
  } else {
    db.prepare(`INSERT INTO problem_times(user_id,platform,problem_id,seconds) VALUES(?,?,?,?)
      ON CONFLICT(user_id,platform,problem_id) DO UPDATE SET seconds=excluded.seconds, updated_at=unixepoch()`)
      .run(userId, platform, problemId, best.seconds);
  }
}

function validatePractice(input: PracticeInput) {
  if (!input.platform.trim() || input.platform.length > 64) throw new Error('平台不能为空且不能超过 64 字符');
  if (!input.problemId.trim() || input.problemId.length > 64) throw new Error('题号不能为空且不能超过 64 字符');
  if (input.timingSource === 'contest_estimate' && input.platform !== DX_PLATFORM) throw new Error('比赛估算仅支持 Codeforces');
  if (input.manual && input.timingSource !== 'manual') throw new Error('手动记录须填写实际用时');
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) throw new Error('题名不能超过 200 字符');
  if (input.difficulty != null && (!Number.isSafeInteger(input.difficulty) || input.difficulty < 0 || input.difficulty > 1000000)) throw new Error('难度须为 0～1000000 的整数或留空');
  if (!['ac', 'unfinished'].includes(input.outcome) || !['unknown', 'first', 'repeat', 'assisted'].includes(input.practiceKind)
    || !['manual', 'contest_estimate'].includes(input.timingSource)) throw new Error('练习类型、结果或计时来源不合法');
  if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 86400) throw new Error('用时须为 1～86400 的整数秒');
  if (input.attemptedAt !== null && (!Number.isSafeInteger(input.attemptedAt) || input.attemptedAt < 0
    || input.attemptedAt > Math.floor(Date.now() / 1000))) throw new Error('练习日期无效或晚于当前时间');
  if (input.requestId !== undefined && !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId)) throw new Error('请求标识不合法');
}

export function recordPractice(db: DatabaseSync, input: PracticeInput, replaceBest = false) {
  validatePractice(input);
  return transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(input.userId)) throw new Error('用户不存在');
    const known = db.prepare(`SELECT MAX(s.status='AC') AS solved FROM submissions s JOIN accounts a ON a.id=s.account_id
      WHERE a.user_id=? AND a.is_archived=0 AND s.platform=? AND s.problem_id=?`).get(input.userId, input.platform, input.problemId)!;
    if (input.manual && !db.prepare('SELECT 1 FROM users WHERE id=? AND is_self=1').get(input.userId)) throw new Error('只能手动添加自己的做题记录');
    if (!input.manual && known.solved === null) throw new Error('请先同步这道题的提交记录');
    if (!input.manual && input.outcome === 'ac' && !known.solved) throw new Error('这道题尚无 AC 记录，只能记录未完成尝试');
    if (input.requestId) {
      const previous = db.prepare('SELECT * FROM practice_attempts WHERE request_id=?').get(input.requestId);
      if (previous) {
        if (previous.is_manual !== Number(!!input.manual) || previous.manual_title !== (input.title ?? null) || previous.manual_difficulty !== (input.difficulty ?? null)
          || previous.user_id !== input.userId || previous.platform !== input.platform || previous.problem_id !== input.problemId
          || previous.seconds !== input.seconds || previous.outcome !== input.outcome || previous.practice_kind !== input.practiceKind
          || previous.timing_source !== input.timingSource || (input.timingSource === 'manual' && previous.attempted_at !== input.attemptedAt))
          throw new Error('请求标识已用于另一条记录');
        return { id: Number(previous.id), created: false };
      }
    }
    let attemptedAt = input.attemptedAt;
    if (input.timingSource === 'contest_estimate') {
      const timeline = listContestTimeline(db, input.userId, input.platform);
      const estimated = computeContestAutoSeconds(timeline).get(input.problemId);
      if (input.outcome !== 'ac' || input.practiceKind !== 'unknown' || estimated !== input.seconds)
        throw new Error('比赛估算须与本机提交时间轴一致，练习类型保留未知');
      attemptedAt = Math.min(...timeline.filter(r => r.problemId === input.problemId && r.status === 'AC').map(r => r.submittedAt));
      const previous = db.prepare(`SELECT id FROM practice_attempts WHERE user_id=? AND platform=? AND problem_id=?
        AND timing_source='contest_estimate' AND attempted_at=? AND seconds=? AND voided_at IS NULL AND archived_at IS NULL`)
        .get(input.userId, input.platform, input.problemId, attemptedAt, input.seconds);
      if (previous) return { id: Number(previous.id), created: false };
    }
    if (replaceBest) {
      db.prepare(`UPDATE practice_attempts SET voided_at=unixepoch() WHERE id=(SELECT id FROM practice_attempts
        WHERE user_id=? AND platform=? AND problem_id=? AND outcome='ac' AND practice_kind!='assisted'
        AND voided_at IS NULL AND archived_at IS NULL ORDER BY seconds,id LIMIT 1)`)
        .run(input.userId, input.platform, input.problemId);
    }
    const result = db.prepare(`INSERT INTO practice_attempts
      (user_id,platform,problem_id,seconds,outcome,practice_kind,timing_source,attempted_at,request_id,is_manual,manual_title,manual_difficulty) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.userId, input.platform, input.problemId, input.seconds, input.outcome, input.practiceKind,
        input.timingSource, attemptedAt, input.requestId ?? null, Number(!!input.manual), input.title ?? null, input.difficulty ?? null);
    refreshBestTime(db, input.userId, input.platform, input.problemId);
    return { id: Number(result.lastInsertRowid), created: true };
  });
}

export function editPractice(db: DatabaseSync, userId: number, id: number, revision: number,
  changes: Pick<PracticeInput, 'seconds' | 'outcome' | 'practiceKind' | 'attemptedAt'>) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM practice_attempts WHERE id=? AND user_id=? AND archived_at IS NULL AND voided_at IS NULL').get(id, userId);
    if (!row) throw new Error('记录不存在或已作废，请刷新后重试');
    if (row.revision !== revision) throw new Error('记录已被修改，请刷新后重新打开');
    const input: PracticeInput = { ...changes, userId, platform: String(row.platform), problemId: String(row.problem_id), timingSource: 'manual' };
    validatePractice(input);
    const known = db.prepare(`SELECT MAX(s.status='AC') AS solved FROM submissions s JOIN accounts a ON a.id=s.account_id
      WHERE a.user_id=? AND a.is_archived=0 AND s.platform=? AND s.problem_id=?`).get(userId, input.platform, input.problemId)!;
    if (!row.is_manual && known.solved === null) throw new Error('该题已不属于当前账号记录');
    if (!row.is_manual && input.outcome === 'ac' && !known.solved) throw new Error('这道题尚无 AC 记录，只能记录未完成尝试');
    if (row.seconds === input.seconds && row.outcome === input.outcome && row.practice_kind === input.practiceKind && row.attempted_at === input.attemptedAt)
      return { id, updated: false };
    db.prepare(`UPDATE practice_attempts SET seconds=?,outcome=?,practice_kind=?,attempted_at=?,
      timing_source='manual',edited_at=unixepoch(),revision=revision+1 WHERE id=?`)
      .run(input.seconds, input.outcome, input.practiceKind, input.attemptedAt, id);
    refreshBestTime(db, userId, input.platform, input.problemId);
    return { id, updated: true };
  });
}

export function voidPractice(db: DatabaseSync, userId: number, id: number, revision?: number) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM practice_attempts WHERE id=? AND user_id=? AND archived_at IS NULL').get(id, userId);
    if (!row) throw new Error('练习记录不存在');
    if (revision !== undefined && row.revision !== revision) throw new Error('记录已被修改，请刷新后重新打开');
    db.prepare('UPDATE practice_attempts SET voided_at=COALESCE(voided_at,unixepoch()) WHERE id=?').run(id);
    refreshBestTime(db, userId, String(row.platform), String(row.problem_id));
    return { voided: true };
  });
}

export function clearPracticeBest(db: DatabaseSync, userId: number, platform: string, problemId: string) {
  return transaction(db, () => {
    const existed = !!db.prepare('SELECT 1 FROM problem_times WHERE user_id=? AND platform=? AND problem_id=?').get(userId, platform, problemId);
    db.prepare(`UPDATE practice_attempts SET voided_at=unixepoch() WHERE user_id=? AND platform=? AND problem_id=?
      AND outcome='ac' AND practice_kind!='assisted' AND voided_at IS NULL AND archived_at IS NULL`).run(userId, platform, problemId);
    refreshBestTime(db, userId, platform, problemId);
    return { cleared: existed };
  });
}

/** Only current identity records; archived attempts cannot reappear when a replacement solves the same problem. */
export function listPractice(db: DatabaseSync, userId: number): (PracticeAttempt & { problem_title: string | null; problem_rating: number | null })[] {
  return db.prepare(`SELECT p.*, CASE WHEN p.edited_at IS NULL AND EXISTS (SELECT 1 FROM practice_timers t WHERE t.attempt_id=p.id)
      THEN 'timer' ELSE p.timing_source END AS timing_source,
    COALESCE(p.manual_title, (SELECT MAX(s.problem_title) FROM submissions s JOIN accounts a ON a.id=s.account_id
      WHERE a.user_id=p.user_id AND a.is_archived=0 AND s.platform=p.platform AND s.problem_id=p.problem_id)) AS problem_title,
      COALESCE(p.manual_difficulty, (SELECT MAX(s.difficulty) FROM submissions s JOIN accounts a ON a.id=s.account_id
       WHERE a.user_id=p.user_id AND a.is_archived=0 AND s.platform=p.platform AND s.problem_id=p.problem_id)) AS problem_rating
    FROM practice_attempts p WHERE user_id=? AND archived_at IS NULL
    AND (p.is_manual=1 OR EXISTS (SELECT 1 FROM submissions s JOIN accounts a ON a.id=s.account_id
      WHERE a.user_id=p.user_id AND a.is_archived=0 AND s.platform=p.platform AND s.problem_id=p.problem_id))
    ORDER BY recorded_at DESC,id DESC`).all(userId) as unknown as (PracticeAttempt & { problem_title: string | null; problem_rating: number | null })[];
}
