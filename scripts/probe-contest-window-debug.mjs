// 深挖：为什么所有 CF AC 都不在比赛窗口内？看原始时间戳对比。
import { openProbe } from './probe-context.mjs';
const { db, userId } = openProbe();

const lines = [];
// 1. 最近的几场有提交的比赛：contests 行 vs 提交时间
const contests = db.prepare(`
  SELECT contest_id, name, start_time, duration_seconds,
         datetime(start_time, 'unixepoch') AS start_utc
  FROM contests
  WHERE platform = 'codeforces' AND contest_id IN (
    SELECT CAST(substr(s.problem_id, 1, instr(s.problem_id, ':') - 1) AS INTEGER)
    FROM submissions s JOIN accounts a ON a.id = s.account_id
    WHERE a.user_id = ? AND s.platform = 'codeforces'
  )
  ORDER BY contest_id DESC LIMIT 10
`).all(userId);
lines.push('=== contests 表里的比赛 ===');
for (const c of contests) {
  lines.push(`${c.contest_id}  start=${c.start_utc}  duration=${c.duration_seconds}s (${Math.round((c.duration_seconds ?? 0) / 60)}min)  ${String(c.name).slice(0, 40)}`);
}

// 2. 本人最近的 CF 提交（含未 AC），对齐比赛窗口
const subs = db.prepare(`
  SELECT s.problem_id, s.status, s.submitted_at,
         datetime(s.submitted_at, 'unixepoch') AS t_utc,
         a.handle
  FROM submissions s JOIN accounts a ON a.id = s.account_id
  WHERE a.user_id = ? AND s.platform = 'codeforces'
  ORDER BY s.submitted_at DESC LIMIT 40
`).all(userId);
lines.push('');
lines.push('=== 本人最近 40 条 CF 提交 ===');
for (const s of subs) {
  lines.push(`${s.problem_id.padEnd(9)} ${s.status.padEnd(4)} ${s.t_utc} (UTC)  ${s.handle}`);
}

// 3. 窗口判定逐条对照（最近 6 场比赛）
lines.push('');
lines.push('=== 窗口判定对照 ===');
const detail = db.prepare(`
  SELECT s.problem_id, s.status, s.submitted_at,
         c.contest_id, c.start_time, c.duration_seconds
  FROM submissions s
  JOIN accounts a ON a.id = s.account_id
  JOIN contests c ON c.platform = s.platform
       AND c.contest_id = CAST(substr(s.problem_id, 1, instr(s.problem_id, ':') - 1) AS INTEGER)
  WHERE a.user_id = ? AND s.platform = 'codeforces'
  ORDER BY s.submitted_at DESC LIMIT 60
`).all(userId);
for (const d of detail) {
  const end = d.start_time + d.duration_seconds;
  const inWin = d.submitted_at >= d.start_time && d.submitted_at < end;
  lines.push(
    `${d.problem_id.padEnd(9)} ${d.status.padEnd(4)} 提交=${d.submitted_at} 窗口=[${d.start_time}, ${end}) ` +
    `${inWin ? '★窗口内' : '窗口外(差 ' + Math.round((d.submitted_at - end) / 3600) + ' 小时)'} dur=${d.duration_seconds}`,
  );
}

console.log(lines.join('\n'));
db.close();
console.log('done');
