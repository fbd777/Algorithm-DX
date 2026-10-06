// 检查真库 duration_seconds 的覆盖情况
import { openProbe } from './probe-context.mjs';
const { db, userId } = openProbe();
const lines = [];

const total = db.prepare(`SELECT COUNT(*) AS c FROM contests WHERE platform='codeforces'`).get();
const withDur = db.prepare(`SELECT COUNT(*) AS c FROM contests WHERE platform='codeforces' AND duration_seconds IS NOT NULL`).get();
lines.push(`codeforces 比赛总数: ${total.c}，有时长: ${withDur.c}`);

// 用户的 CF 提交涉及的比赛里，多少缺时长
const involved = db.prepare(`
  SELECT DISTINCT c.contest_id, c.duration_seconds
  FROM submissions s
  JOIN accounts a ON a.id = s.account_id
  JOIN contests c ON c.platform = s.platform
       AND c.contest_id = CAST(substr(s.problem_id, 1, instr(s.problem_id, ':') - 1) AS INTEGER)
  WHERE a.user_id = ? AND s.platform = 'codeforces'
`).all(userId);
const missing = involved.filter((r) => r.duration_seconds === null);
lines.push(`本人提交涉及比赛: ${involved.length} 场，缺时长: ${missing.length} 场`);
lines.push('缺时长的: ' + missing.map((r) => r.contest_id).sort((a, b) => b - a).join(', '));

// sync_state 里 CF 的最后同步时间
const ss = db.prepare(`SELECT account_id, last_attempt_at, datetime(last_attempt_at,'unixepoch') AS t FROM sync_state`).all();
for (const s of ss) lines.push(`sync_state 账号${s.account_id}: last_attempt=${s.t}`);

// fetch_cache 里 contest.list 的缓存情况
const fc = db.prepare(`SELECT cache_key AS k, length(payload) AS bytes, datetime(expires_at,'unixepoch') AS t FROM response_cache WHERE cache_key LIKE '%contest%' LIMIT 10`).all();
lines.push('');
lines.push('response_cache 里 contest 相关键:');
for (const f of fc) lines.push(`  ${f.k}  ${f.bytes} bytes  expires=${f.t}`);

console.log(lines.join('\n'));
db.close();
console.log('done');
