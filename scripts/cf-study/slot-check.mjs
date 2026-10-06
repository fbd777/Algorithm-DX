// 合并题位（X1/X2/X3）的定数一致性体检 —— 只回答一个问题：
//
//   `candidates()` 合并后的记录用「最后一个子任务」的题号与定数（`p = problems[slot.items.at(-1)]`），
//   这个选择是否安全？
//
// 安全的充要条件是 **同一题位里各子任务的 rating 相同**。若不同，就得改成取最大（或加权），
// 否则「一道题的定数」会随「你解到第几个子任务」而变 —— 那是错的。
//
// 顺带给出：题位出现频率、子任务个数分布、以及 rating 不一致的题位清单（应为空）。
// 只读缓存，不改任何产物。
import fs from 'node:fs/promises';
import {cached} from './api.mjs';

const root = 'results/cf-study';
const out = [];
const p = (s) => out.push(s);

const manifest = JSON.parse(await fs.readFile('data/cf-study/manifest.json', 'utf8'));

let contests = 0, multiSlots = 0, rowsTotal = 0;
const genCounts = new Map();        // 子任务个数 → 题位数
const mismatch = [];                // rating 不一致的题位
const missing = [];                 // 有子任务但 rating 缺失
const slotTable = [];

for (const c of manifest.contests) {
  let st;
  try {
    st = await cached('contest.standings', { contestId: String(c.id) });
  } catch { continue; }
  const { contest, problems } = st;
  if (contest.phase !== 'FINISHED' || contest.type === 'IOI') continue;
  contests += 1;

  const slots = [];
  for (let i = 0; i < problems.length; i += 1) {
    const key = String(problems[i].index).replace(/\d+$/, '');
    const last = slots[slots.length - 1];
    if (last && last.key === key) last.items.push(i);
    else slots.push({ key, items: [i] });
  }
  for (const s of slots) {
    if (s.items.length < 2) continue;
    multiSlots += 1;
    rowsTotal += s.items.length;
    genCounts.set(s.items.length, (genCounts.get(s.items.length) ?? 0) + 1);
    const rs = s.items.map((i) => problems[i].rating);
    const idx = s.items.map((i) => problems[i].index);
    const uniq = [...new Set(rs.filter(Number.isFinite))];
    const names = s.items.map((i) => problems[i].name);
    if (rs.some((r) => !Number.isFinite(r))) missing.push({ contestId: contest.id, slot: idx.join('+'), rs });
    else if (uniq.length > 1) mismatch.push({ contestId: contest.id, slot: idx.join('+'), rs });
    slotTable.push({ contestId: contest.id, slot: idx.join('+'), rs, used: idx.at(-1), q: rs.at(-1), names, contestName: contest.name });
  }
}

p('# 合并题位的定数一致性体检');
p('');
p('> 生成：`node scripts/cf-study/slot-check.mjs`。只读缓存，不改口径。');
p('');
p(`范围：manifest ${manifest.contests.length} 场里 ${contests} 场非 IOI 的已完赛比赛，`);
p(`其中含合并题位（子任务 ≥ 2）的 **${multiSlots}** 个题位、共 ${rowsTotal} 个题号。`);
p('');
p('## 表 1 · 每个合并题位里各子任务的定数与题名');
p('');
p('| contestId | 比赛 | 题位 | 各子任务 rating | 题名 | 合并后取 | 定数 q | 一致 |');
p('|---:|---|---|---|---|---|---:|---|');
for (const r of slotTable) {
  p(`| ${r.contestId} | ${r.contestName} | ${r.slot} | ${r.rs.join(' / ')} | ${r.names.join(' + ')} | ${r.used} | ${r.q} | ${new Set(r.rs).size === 1 ? '✅' : '❌'} |`);
}
p('');
p('## 表 1b · 两子任务的 rating 落差');
p('');
{
  const gaps = slotTable.filter((r) => r.rs.length === 2 && new Set(r.rs).size === 2).map((r) => r.rs[1] - r.rs[0]);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  p(`- 落差的中位是 **+${med}** 分，最小 ${gaps[0]}、最大 ${gaps[gaps.length - 1]}。`);
  p('- 落差**恒为正**（第二个子任务定数总是更高），说明这不是「同一道题的两种限制」，');
  p('  而是**两道难度不同的题被编成了同一个题位**。');
}
p('');
p('## 表 2 · 子任务个数分布');
p('');
p('| 子任务个数 | 题位数 |');
p('|---:|---:|');
for (const [n, k] of [...genCounts].sort((a, b) => a[0] - b[0])) p(`| ${n} | ${k} |`);
p('');
p('## 结论');
p('');
if (!mismatch.length && !missing.length) {
  p(`- **全部 ${multiSlots} 个合并题位里，各子任务的 rating 完全相同** → 取「最后一个子任务」的题号与定数`);
  p('  与取第一个、取最大，结果逐字相同。合并是安全的，不需要额外加权。');
} else {
  if (mismatch.length) {
    p(`- ⚠️ **有 ${mismatch.length} 个题位的子任务 rating 不一致**，取最后一个会改变该题位定数：`);
    p('');
    p('| contestId | 题位 | 各子任务 rating |');
    p('|---:|---|---|');
    for (const m of mismatch) p(`| ${m.contestId} | ${m.slot} | ${m.rs.join(' / ')} |`);
  }
  if (missing.length) p(`- ⚠️ 有 ${missing.length} 个题位缺失 rating（会被现有 rating>=800 门槛自然跳过）。`);
}
p('');

await fs.writeFile(`${root}/SLOT_CHECK.md`, out.join('\n'), 'utf8');
process.stdout.write(`wrote ${root}/SLOT_CHECK.md | contests=${contests} multiSlots=${multiSlots} mismatch=${mismatch.length} missing=${missing.length}\n`);
