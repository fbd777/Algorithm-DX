// 只读探查：本人（is_self=1）的 CF 比赛窗口内 AC 题，能否自动算出精确到秒的用时。
// 口径 A：elapsed = 窗口内最早 AC - 开赛（CF 官方「解题时间」口径）
// 口径 B：按题号顺序做的假设下，减去前面题的用时（统计线的纯耗时口径）
import { openProbe } from './probe-context.mjs';

const { db, userId } = openProbe();

// 本人账号 + 窗口内最早 AC
const rows = db.prepare(`
  SELECT s.problem_id,
         MAX(s.problem_title) AS title,
         MIN(CASE WHEN s.submitted_at >= c.start_time
                AND s.submitted_at < c.start_time + c.duration_seconds
               THEN s.submitted_at END) AS first_ac_in_window,
         MAX(s.difficulty) AS rating,
         c.start_time, c.duration_seconds, c.contest_id,
         (SELECT COUNT(*) FROM submissions s2
           WHERE s2.account_id = s.account_id AND s2.platform = 'codeforces'
             AND s2.problem_id = s.problem_id) AS attempts
  FROM submissions s
  JOIN accounts a ON a.id = s.account_id
  JOIN contests c ON c.platform = s.platform
       AND c.contest_id = CAST(substr(s.problem_id, 1, instr(s.problem_id, ':') - 1) AS INTEGER)
  WHERE a.user_id = ? AND s.platform = 'codeforces' AND s.status = 'AC'
  GROUP BY s.problem_id
  ORDER BY c.start_time, s.problem_id
`).all(userId);

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

const lines = [];
lines.push('=== 本人 CF 比赛窗口内 AC 的题（自动计时可行性探查）===');
lines.push(`共 ${rows.length} 道有 AC 的 CF 题联到了比赛`);
lines.push('');

for (const r of rows) {
  if (r.first_ac_in_window === null) {
    lines.push(`${r.problem_id}  [无窗口内 AC —— 赛后练习解的，不能自动计时] rating=${r.rating ?? '?'}`);
    continue;
  }
  const elapsed = r.first_ac_in_window - r.start_time;
  lines.push(
    `${r.problem_id}  rating=${r.rating ?? '?'}  提交 ${r.attempts} 次  ` +
    `口径A(距开赛)=${elapsed}s (${fmt(elapsed)})`,
  );
}

// 口径 B 需要同一比赛内按题号顺序；把同一场比赛的题列在一起算
lines.push('');
lines.push('=== 按比赛分组（口径 B = 减去同场前面题的用时，仅当按序做）===');
const byContest = new Map();
for (const r of rows) {
  if (r.first_ac_in_window === null) continue;
  if (!byContest.has(r.contest_id)) byContest.set(r.contest_id, []);
  byContest.get(r.contest_id).push(r);
}
for (const [cid, list] of byContest) {
  list.sort((x, y) => x.problem_id.localeCompare(y.problem_id));
  let prev = 0;
  lines.push(`比赛 ${cid}（时长 ${Math.round(r_duration(list) / 60)} 分钟）:`);
  for (const r of list) {
    const elapsed = r.first_ac_in_window - r.start_time;
    const pure = elapsed - prev;
    lines.push(
      `  ${r.problem_id}  A=${fmt(elapsed)}  B=${pure >= 0 ? fmt(pure) : '顺序异常(跳题)'}  ` +
      `(首AC在开赛后 ${fmt(elapsed)})`,
    );
    prev = elapsed;
  }
}
function r_duration(list) {
  return list[0].duration_seconds;
}

// 输出到终端，也可自行重定向保存。
const out = lines.join('\n');
console.log(out);
db.close();
console.log('done, rows=' + rows.length);
