import type { DatabaseSync } from 'node:sqlite';
import { recordPractice, type PracticeInput } from './practice.ts';
import { scoreProblem, buildBoard } from './rating.ts';
import { advanceDanSessions } from './dan.ts';
import { listDxEntries } from '../server/queries.ts';

export interface PracticeTimer {
  id: string; user_id: number; account_id: number; handle_key: string; problem_id: string;
  practice_kind: PracticeInput['practiceKind']; started_at: number; ended_at: number | null;
  status: 'running' | 'completed' | 'cancelled' | 'expired'; attempt_id: number | null;
  submission_id: string | null;
  settlement_json: string | null;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function normalizeTimerProblem(value: string): string {
  let raw = value.trim();
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!['codeforces.com', 'www.codeforces.com'].includes(url.hostname)) throw new Error('请填写 Codeforces 题目链接');
    const match = url.pathname.match(/^\/(?:contest|gym)\/(\d+)\/problem\/([a-z]\d*)\/?$/i)
      ?? url.pathname.match(/^\/problemset\/problem\/(\d+)\/([a-z]\d*)\/?$/i);
    if (!match) throw new Error('无法识别题目链接');
    raw = `${match[1]}:${match[2]}`;
  }
  const match = raw.match(/^(\d{1,7})\s*[:\- ]?\s*([a-z]\d*)$/i);
  if (!match || Number(match[1]) < 1) throw new Error('请输入题号，如 2259:A，或 Codeforces 题目链接');
  return `${Number(match[1])}:${match[2].toUpperCase()}`;
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('SAVEPOINT timer_write');
  try { const result = action(); db.exec('RELEASE timer_write'); return result; }
  catch (error) { db.exec('ROLLBACK TO timer_write; RELEASE timer_write'); throw error; }
}

export function timerState(db: DatabaseSync, userId: number, tzOffsetMinutes = 480) {
  const timer = db.prepare(`SELECT * FROM practice_timers WHERE user_id=?
    ORDER BY (status='running') DESC, started_at DESC, rowid DESC LIMIT 1`).get(userId) as unknown as PracticeTimer | undefined;
  return { timer: timer ?? null, result: timer?.status === 'completed' ? timerResult(db, timer, tzOffsetMinutes) : null, serverNow: nowSeconds() };
}

/** Session verdicts are scoped to this identity, problem and timed AC window. */
function timerResult(db: DatabaseSync, timer: PracticeTimer, tzOffsetMinutes: number) {
  const dayStart = Math.floor((timer.ended_at! + tzOffsetMinutes * 60) / 86400) * 86400 - tzOffsetMinutes * 60;
  // Rank distinct problems by their first AC on the completion day, including untimed solves.
  const dailyProblems = db.prepare(`SELECT problem_id, MIN(submitted_at) AS first_ac FROM submissions
    WHERE account_id=? AND platform='codeforces' AND status='AC' AND submitted_at>=? AND submitted_at<=?
    GROUP BY problem_id ORDER BY first_ac, problem_id`).all(timer.account_id, dayStart, timer.ended_at);
  const dailyTrack = dailyProblems.findIndex(row => row.problem_id === timer.problem_id) + 1;
  const rows = db.prepare(`SELECT status,COUNT(*) AS count FROM submissions
    WHERE account_id=? AND platform='codeforces' AND problem_id=? AND submitted_at>? AND submitted_at<=?
    GROUP BY status`).all(timer.account_id, timer.problem_id, timer.started_at, timer.ended_at);
  const verdicts = Object.fromEntries(rows.map(row => [String(row.status), Number(row.count)]));
  const problem = db.prepare(`SELECT MAX(problem_title) AS title,MAX(difficulty) AS difficulty FROM submissions
    WHERE account_id=? AND platform='codeforces' AND problem_id=?`).get(timer.account_id, timer.problem_id)!;
  const attempt = db.prepare('SELECT practice_kind FROM practice_attempts WHERE id=?').get(timer.attempt_id);
  const seconds = timer.ended_at! - timer.started_at;
  const difficulty = problem.difficulty === null ? null : Number(problem.difficulty);
  const comparison = timer.settlement_json ? JSON.parse(timer.settlement_json) : null;
  return { seconds, dailyTrack, verdicts, waCount: verdicts.WA ?? 0, title: problem.title ?? timer.problem_id,
    comparison,
    difficulty, practiceKind: attempt?.practice_kind ?? timer.practice_kind,
    score: comparison ? comparison.currentScore : difficulty === null || seconds <= 0 ? null : scoreProblem({ platform: 'codeforces', problemId: timer.problem_id,
      problemTitle: String(problem.title ?? timer.problem_id), problemUrl: null, problemRating: difficulty,
      solvedAt: timer.ended_at!, releasedAt: null, recordedSeconds: seconds }) };
}

export function startTimer(db: DatabaseSync, input: { userId: number; problemId: string; practiceKind: PracticeInput['practiceKind']; requestId: string }, now = nowSeconds()) {
  const problemId = normalizeTimerProblem(input.problemId);
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId)) throw new Error('请求标识不合法');
  if (!['unknown','first','repeat','assisted'].includes(input.practiceKind)) throw new Error('练习类型不合法');
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM practice_timers WHERE id=?').get(input.requestId) as unknown as PracticeTimer | undefined;
    if (previous) {
      if (previous.user_id !== input.userId || previous.problem_id !== problemId || previous.practice_kind !== input.practiceKind) throw new Error('请求标识已用于另一场计时');
      return previous;
    }
    const account = db.prepare("SELECT id,handle_key FROM accounts WHERE user_id=? AND platform='codeforces' AND is_archived=0").get(input.userId);
    if (!account) throw new Error('请先为当前用户绑定 Codeforces 账号');
    if (db.prepare("SELECT 1 FROM practice_timers WHERE user_id=? AND status='running'").get(input.userId)) throw new Error('已有计时正在进行，请先结束或取消');
    db.prepare(`INSERT INTO practice_timers(id,user_id,account_id,handle_key,problem_id,practice_kind,started_at) VALUES(?,?,?,?,?,?,?)`)
      .run(input.requestId,input.userId,account.id,account.handle_key,problemId,input.practiceKind,now);
    return db.prepare('SELECT * FROM practice_timers WHERE id=?').get(input.requestId) as unknown as PracticeTimer;
  });
}

/** Called in the sync transaction: AC and its timed practice are committed together. */
export function reconcileTimers(db: DatabaseSync, accountId?: number, now = nowSeconds()): void {
  transaction(db, () => {
    const timers = db.prepare(`SELECT * FROM practice_timers WHERE status='running' ${accountId === undefined ? '' : 'AND account_id=?'}`)
      .all(...(accountId === undefined ? [] : [accountId])) as unknown as PracticeTimer[];
    for (const timer of timers) {
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(timer.account_id);
      if (!account || account.is_archived || account.user_id !== timer.user_id || account.handle_key !== timer.handle_key) {
        db.prepare("UPDATE practice_timers SET status='cancelled',ended_at=? WHERE id=?").run(now,timer.id);
        continue;
      }
      const ac = db.prepare(`SELECT submission_id,submitted_at FROM submissions WHERE account_id=? AND platform='codeforces'
        AND problem_id=? AND status='AC' AND submitted_at>? AND submitted_at<=? AND submitted_at<=?
        ORDER BY submitted_at,submission_id LIMIT 1`).get(timer.account_id,timer.problem_id,timer.started_at,timer.started_at+86400,now);
      if (ac) {
        const endedAt = Number(ac.submitted_at);
        // A prior AC discovered by this very sync also identifies a repeat.
        const prior = db.prepare(`SELECT 1 FROM submissions WHERE account_id=? AND problem_id=? AND status='AC' AND submitted_at<=? LIMIT 1`)
          .get(timer.account_id,timer.problem_id,timer.started_at);
        const kind = timer.practice_kind === 'unknown' && prior ? 'repeat' : timer.practice_kind;
        const year = new Date(endedAt * 1000).getFullYear();
        const since = Math.floor(new Date(year,0,1).getTime()/1000);
        const until = Math.floor(new Date(year+1,0,1).getTime()/1000);
        const entries = listDxEntries(db,timer.user_id,'codeforces').filter(e=>e.releasedAt===null || e.releasedAt<until);
        const previousEntry = entries.find(e=>e.problemId===timer.problem_id);
        const previousScore = previousEntry ? scoreProblem(previousEntry) : null;
        const currentScore = previousEntry ? scoreProblem({...previousEntry,recordedSeconds:endedAt-timer.started_at}) : null;
        const before = buildBoard(entries,since).rating;
        const attempt = recordPractice(db,{userId:timer.user_id,platform:'codeforces',problemId:timer.problem_id,
          seconds:endedAt-timer.started_at,outcome:'ac',practiceKind:kind,timingSource:'manual',attemptedAt:endedAt,requestId:`timer-${timer.id}`});
        const afterEntries = listDxEntries(db,timer.user_id,'codeforces').filter(e=>e.releasedAt===null || e.releasedAt<until);
        const after = buildBoard(afterEntries,since).rating;
        const comparison = { year, previousScore, currentScore, ratingBefore: before, ratingAfter: after,
          ratingDelta: Math.round((after-before)*10)/10 };
        db.prepare("UPDATE practice_timers SET status='completed',ended_at=?,attempt_id=?,submission_id=?,settlement_json=? WHERE id=?")
          .run(endedAt,attempt.id,ac.submission_id,JSON.stringify(comparison),timer.id);
      }
      // Keep an overdue timer recoverable until synchronization has checked the account.
      else if (accountId !== undefined && now > timer.started_at + 86400) {
        db.prepare("UPDATE practice_timers SET status='expired',ended_at=? WHERE id=?").run(timer.started_at+86400,timer.id);
      }
    }
  });
  // 挑战/段位認定：计时器落成 completed 之后，那一轮才知道自己第几道做完了。
  // 放在事务外，且**不调 cancelTimer** —— 它会回调本函数，形成递归
  // （超时取消在 advanceDanSessions 里直接置状态，见 dan.ts）。
  advanceDanSessions(db, now);
}

export function cancelTimer(db: DatabaseSync, userId: number, id: string) {
  return transaction(db, () => {
    const timer = db.prepare('SELECT * FROM practice_timers WHERE id=? AND user_id=?').get(id,userId);
    if (!timer) throw new Error('计时记录不存在');
    // Resolve any already synchronized AC before cancelling a completed attempt.
    reconcileTimers(db);
    db.prepare("UPDATE practice_timers SET status='cancelled',ended_at=? WHERE id=? AND user_id=? AND status='running'")
      .run(nowSeconds(),id,userId);
    return timerState(db,userId);
  });
}
