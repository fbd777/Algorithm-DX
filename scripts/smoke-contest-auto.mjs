// 只读冒烟：使用已同步的实际比赛时长，走完整的
// listDxEntries → listContestTimeline → computeContestAutoSeconds → buildPending 链路，
// 打印待填写清单里每道题会不会出「比赛计时」按钮、值是多少。
import { openProbe } from './probe-context.mjs';
import { listContestTimeline, listDxEntries } from '../src/server/queries.ts';
import { buildPending, computeContestAutoSeconds, DX_PLATFORM } from '../src/dx/rating.ts';

const { db, userId } = openProbe();

const entries = listDxEntries(db, userId, DX_PLATFORM);
const pending = buildPending(entries, Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000));
const auto = computeContestAutoSeconds(listContestTimeline(db, userId, DX_PLATFORM));

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const lines = [];
lines.push(`待填写 ${pending.length} 道；能出「比赛计时」按钮的：`);
for (const p of pending) {
  const s = auto.get(p.problemId);
  if (s !== undefined) lines.push(`  ${p.problemId}  →  ${s}s = ${fmt(s)}${p.recordedSeconds ?? ''}`);
}
lines.push('');
lines.push('（其余待填写题不显示按钮：练习解 / 穿插 / 时长缺失）');

// 顺带验证窗口判定对这几场的解释
const tl = listContestTimeline(db, userId, DX_PLATFORM);
lines.push('');
lines.push(`时间轴共 ${tl.length} 条窗口内提交，按比赛分组：`);
const byContest = new Map();
for (const r of tl) {
  const key = r.problemId.slice(0, r.problemId.indexOf(':'));
  if (!byContest.has(key)) byContest.set(key, []);
  byContest.get(key).push(r);
}
for (const [cid, list] of byContest) {
  lines.push(`  ${cid}: ${list.map((r) => `${r.problemId.slice(r.problemId.indexOf(':') + 1)}@${r.submittedAt - list[0].contestStart}s${r.status === 'AC' ? '✓' : `(${r.status})`}`).join(' ')}`);
}

console.log(lines.join('\n'));
db.close();
console.log('done');
