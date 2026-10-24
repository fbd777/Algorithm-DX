import type { DatabaseSync } from 'node:sqlite';

export const DAN_LIFE_RULES = { version: 3, initialSeconds: 7200, maxSeconds: 7200, recoverySeconds: 600, penaltySeconds: 600 } as const;
export type LifeRules = { version: number; initialSeconds: number; maxSeconds: number; recoverySeconds: number; penaltySeconds: number };
export interface LifeResult {
  startSeconds: number; remainingSeconds: number; recoverySeconds: number;
  penaltySeconds: number; failed: boolean; inheritedFailure: boolean; pending: boolean;
  events: { id: string; verdict: string; at: number; seconds: number }[];
}
export function lifeRules(session: { rules_json: string | null }): LifeRules | null {
  return session.rules_json ? JSON.parse(session.rules_json) : null;
}
export function stageLife(db: DatabaseSync, session: { id: string; stage_count: number; rules_json: string | null },
  stage: { stage_index: number; timer_id: string | null; life_json: string | null }, now: number): LifeResult | null {
  const rules = lifeRules(session);
  if (!rules) return null;
  if (stage.life_json) {
    const saved: LifeResult = JSON.parse(stage.life_json);
    return stage.stage_index >= session.stage_count ? { ...saved, recoverySeconds: 0 } : saved;
  }
  const previous = db.prepare('SELECT life_json FROM dan_stages WHERE session_id=? AND stage_index=?')
    .get(session.id, stage.stage_index - 1);
  const before: LifeResult | null = previous?.life_json ? JSON.parse(String(previous.life_json)) : null;
  const startSeconds = before ? Math.min(rules.maxSeconds, before.remainingSeconds + before.recoverySeconds) : rules.initialSeconds;
  const result: LifeResult = { startSeconds, remainingSeconds: startSeconds, recoverySeconds: 0,
    penaltySeconds: 0, failed: before?.failed ?? false, inheritedFailure: before?.failed ?? false, pending: false, events: [] };
  const timer = stage.timer_id ? db.prepare('SELECT * FROM practice_timers WHERE id=?').get(stage.timer_id) : null;
  if (!timer) return result;
  const end = Math.min(Number(timer.ended_at ?? now), now);
  const rows = db.prepare(`SELECT submission_id,status,submitted_at FROM submissions
    WHERE account_id=? AND platform='codeforces' AND problem_id=? AND submitted_at>? AND submitted_at<=?
    ORDER BY submitted_at, length(submission_id), submission_id`).all(timer.account_id!, timer.problem_id!, timer.started_at!, end);
  result.pending = rows.some(row => row.status === 'PENDING');
  for (const row of rows) {
    if (['WA','TLE','MLE','RE'].includes(String(row.status))) {
      result.penaltySeconds += rules.penaltySeconds;
      result.events.push({ id: String(row.submission_id), verdict: String(row.status), at: Number(row.submitted_at), seconds: -rules.penaltySeconds });
    }
  }
  result.remainingSeconds = Math.max(0, startSeconds - Math.max(0, end - Number(timer.started_at)) - result.penaltySeconds);
  result.failed ||= result.remainingSeconds <= 0;
  if (stage.stage_index < session.stage_count && timer.status === 'completed' && !result.failed && !result.pending) {
    result.recoverySeconds = Math.min(rules.recoverySeconds, rules.maxSeconds - result.remainingSeconds);
  }
  return result;
}
export function sessionLife(db: DatabaseSync, session: { id: string; stage_count: number; rules_json: string | null; status: string }, now: number) {
  const rules = lifeRules(session);
  if (!rules) return null;
  const stage = db.prepare('SELECT * FROM dan_stages WHERE session_id=? ORDER BY stage_index DESC LIMIT 1').get(session.id) as
    { stage_index: number; timer_id: string | null; life_json: string | null; outcome: string | null } | undefined;
  const life = stage ? stageLife(db, session, stage, now) : null;
  return { ...rules, ...life, remainingSeconds: life?.remainingSeconds ?? rules.initialSeconds,
    // Keep the rule separate from the accumulated penalty on the current stage.
    penaltyPerSubmissionSeconds: rules.penaltySeconds,
    // Recovery is earned at AC, displayed during the transition, consumed once by the next stage.
    pendingRecovery: stage?.outcome && session.status === 'active' ? life?.recoverySeconds ?? 0 : 0,
    running: Boolean(stage?.timer_id && !stage.outcome),
    finished: session.status !== 'active', serverNow: now };
}
