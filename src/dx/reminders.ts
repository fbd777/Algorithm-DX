import type { DatabaseSync } from 'node:sqlite';

export const REMINDER_DAYS = 7;
export function reminderGroup(solvedAt: number, dismissed: boolean, now = Math.floor(Date.now()/1000)) {
  return dismissed ? 'dismissed' : solvedAt >= now-REMINDER_DAYS*86400 ? 'recent' : 'historical';
}
export function dismissedProblems(db: DatabaseSync, userId: number): Set<string> {
  return new Set((db.prepare(`SELECT DISTINCT r.problem_id FROM dx_time_reminders r JOIN accounts a ON a.id=r.account_id
    WHERE a.user_id=? AND a.platform='codeforces' AND a.is_archived=0`).all(userId) as {problem_id:string}[]).map(r=>r.problem_id));
}
export function setTimeReminder(db: DatabaseSync, userId: number, problemId: string, dismissed: boolean) {
  if (typeof dismissed !== 'boolean') throw new Error('提醒设置无效');
  const accounts=db.prepare(`SELECT DISTINCT a.id FROM accounts a JOIN submissions s ON s.account_id=a.id
    WHERE a.user_id=? AND a.platform='codeforces' AND a.is_archived=0 AND s.problem_id=? AND s.status='AC'`).all(userId,problemId);
  if(!accounts.length) throw new Error('当前用户没有这道题的 AC 记录');
  db.exec('SAVEPOINT dx_reminder');
  try {
    for(const account of accounts) {
      if(dismissed) db.prepare('INSERT OR IGNORE INTO dx_time_reminders(account_id,problem_id) VALUES(?,?)').run(account.id,problemId);
      else db.prepare('DELETE FROM dx_time_reminders WHERE account_id=? AND problem_id=?').run(account.id,problemId);
    }
    db.exec('RELEASE dx_reminder');return {dismissed};
  } catch(error) {db.exec('ROLLBACK TO dx_reminder; RELEASE dx_reminder');throw error;}
}
