// 题位（Easy/Hard Version）时间归属：三个变体的逐档对照。
//
// 背景链：
//   1. `SUBTASK_PROBE.md` 查出题号 `X2`（B2/C2…）的归属用时是「解出 X1 → 解出 X2 的增量」；
//   2. `SLOT_CHECK.md` 查出这些 `X1/X2` 其实是 **Easy / Hard Version 成对**，
//      是**两道定数不同的题**（落差中位 +400 分），不是同一道题的两种限制；
//   3. 于是 `core.mjs` 改成**题位共用起点**：同一题位的每个子任务各出一条记录、
//      共用同一个 `start`。`X2` 的用时变成「冷启动 → 解出 X2」的整段，`X1` 的记录原样保留。
//
// 本脚本把三个变体跑同一批比赛逐档对照（只出报告，不改产物）：
//   legacy   —— 改动前的实现（逐题号、顺序切分时间轴 → X2 拿的是增量）
//   dropEasy —— 我先写的那版「合并成一个题位、只留最后一个子任务」（**会丢掉 easy 版样本**）
//   cold     —— 现行实现（题位共用起点，两边都留）
//
// ⚠️ 内存：`contest.status` 缓存里有一场 155 MB（解压后几百 MB），逐场读 + 累积三份候选行会撑爆堆。
// 所以分三步：先筛「含子任务题的比赛」，再**逐场落盘**小结果，最后统一聚合。
import fs from 'node:fs/promises';
import path from 'node:path';
import { candidates, bandRows, binEstimate, quantile } from './core.mjs';
import { cached } from './api.mjs';

const SPOOL = 'data/cf-study/tmp-merge';

/** 旧实现：题号逐个走、时间轴顺序切分（原样照抄改动前的 core.mjs）。 */
function candidatesLegacy(standings, changes, submissions, window = 150) {
  const { contest: c, problems, rows } = standings;
  if (c.phase !== 'FINISHED' || c.type === 'IOI') return [];
  const ratings = new Map(changes.map((x) => [x.handle.toLowerCase(), x.oldRating]));
  const byHandle = new Map();
  for (const s of submissions) {
    if (s.author.participantType !== 'CONTESTANT' || s.author.members.length !== 1 || s.relativeTimeSeconds < 0 || s.relativeTimeSeconds > c.durationSeconds) continue;
    const h = s.author.members[0].handle.toLowerCase();
    if (!byHandle.has(h)) byHandle.set(h, []);
    byHandle.get(h).push(s);
  }
  const output = [];
  for (const row of rows) {
    if (row.party.participantType !== 'CONTESTANT' || row.party.members.length !== 1 || row.party.ghost) continue;
    const handle = row.party.members[0].handle.toLowerCase(), rating = ratings.get(handle);
    if (!Number.isFinite(rating)) continue;
    const ss = byHandle.get(handle) || [];
    const first = problems.map((p) => Math.min(...ss.filter((s) => s.problem.index === p.index && s.verdict === 'OK').map((s) => s.relativeTimeSeconds)));
    let start = 0;
    for (let i = 0; i < problems.length; i += 1) {
      const p = problems[i], end = first[i], event = Number.isFinite(end) ? 1 : 0, stop = event ? end : c.durationSeconds;
      if (stop <= start) break;
      const targetEarly = ss.some((s) => s.problem.index === p.index && s.relativeTimeSeconds < start);
      const later = new Set(problems.slice(i + 1).map((x) => x.index));
      const skipped = ss.some((s) => later.has(s.problem.index) && s.relativeTimeSeconds <= stop);
      if (targetEarly || skipped) break;
      if (p.rating >= 800 && p.rating <= 2500 && Math.abs(rating - p.rating) <= window) {
        output.push({ contestId: c.id, startTime: c.startTimeSeconds, problem: p.index, q: p.rating, handle, oldRating: rating, event, time: stop - start, start, attempted: ss.some((s) => s.problem.index === p.index), priorRated: null });
      }
      if (!event) break;
      start = end;
    }
  }
  return output;
}

/** 中间那一版：题位合并成一条记录、只留最后一个子任务（等价于丢掉 easy 版）。 */
function candidatesDropEasy(standings, changes, submissions, window = 150) {
  const { contest: c, problems, rows } = standings;
  if (c.phase !== 'FINISHED' || c.type === 'IOI') return [];
  const ratings = new Map(changes.map((x) => [x.handle.toLowerCase(), x.oldRating]));
  const byHandle = new Map();
  for (const s of submissions) {
    if (s.author.participantType !== 'CONTESTANT' || s.author.members.length !== 1 || s.relativeTimeSeconds < 0 || s.relativeTimeSeconds > c.durationSeconds) continue;
    const h = s.author.members[0].handle.toLowerCase();
    if (!byHandle.has(h)) byHandle.set(h, []);
    byHandle.get(h).push(s);
  }
  const slots = [];
  for (let i = 0; i < problems.length; i += 1) {
    const key = String(problems[i].index).replace(/\d+$/, '');
    const last = slots[slots.length - 1];
    if (last && last.key === key) last.items.push(i);
    else slots.push({ key, items: [i] });
  }
  const output = [];
  for (const row of rows) {
    if (row.party.participantType !== 'CONTESTANT' || row.party.members.length !== 1 || row.party.ghost) continue;
    const handle = row.party.members[0].handle.toLowerCase(), rating = ratings.get(handle);
    if (!Number.isFinite(rating)) continue;
    const ss = byHandle.get(handle) || [];
    const first = problems.map((p) => Math.min(...ss.filter((s) => s.problem.index === p.index && s.verdict === 'OK').map((s) => s.relativeTimeSeconds)));
    let start = 0;
    for (let si = 0; si < slots.length; si += 1) {
      const slot = slots[si];
      const ends = slot.items.map((i) => first[i]);
      const solved = ends.every(Number.isFinite);
      const stop = solved ? Math.max(...ends) : c.durationSeconds;
      if (stop <= start) break;
      const own = new Set(slot.items.map((i) => problems[i].index));
      const later = new Set();
      for (let j = si + 1; j < slots.length; j += 1) for (const i of slots[j].items) later.add(problems[i].index);
      const targetEarly = ss.some((s) => own.has(s.problem.index) && s.relativeTimeSeconds < start);
      const skipped = ss.some((s) => later.has(s.problem.index) && s.relativeTimeSeconds <= stop);
      if (targetEarly || skipped) break;
      const p = problems[slot.items[slot.items.length - 1]];
      if (p.rating >= 800 && p.rating <= 2500 && Math.abs(rating - p.rating) <= window) {
        output.push({ contestId: c.id, startTime: c.startTimeSeconds, problem: p.index, q: p.rating, handle, oldRating: rating, event: solved ? 1 : 0, time: stop - start, start, attempted: ss.some((s) => own.has(s.problem.index)), priorRated: null });
      }
      if (!solved) break;
      start = stop;
    }
  }
  return output;
}

/** 题号尾部数字 ≥ 2 = 子任务题的后半段。 */
const genOf = (index) => {
  const m = /\d+$/.exec(String(index));
  return m ? Number(m[0]) : 1;
};

const root = 'results/cf-study';
const out = [];
const p = (s) => out.push(s);
const min1 = (s) => (Number.isFinite(s) ? (s / 60).toFixed(2) : '—');
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const num = (x) => x.toLocaleString('en-US');

// 只累积受影响的档位（q ≥ 1400），并把 priorRated mock 成「通过」——
// `candidates()` 的 priorRated 是 null（历史由 build.mjs 的 attachHistory 补），`bandRows` 要按它筛。
// 三个变体用同一个 mock，所以相互对比有效；绝对样本数会比生产多。
const WANT_MIN_Q = 1400;
const want = (r) => r.q >= WANT_MIN_Q && Math.abs(r.oldRating - r.q) <= 150;
const strip = (rows) => rows.filter(want).map((r) => ({ ...r, priorRated: 999 }));

const manifest = JSON.parse(await fs.readFile('data/cf-study/manifest.json', 'utf8'));
await fs.mkdir(SPOOL, { recursive: true });

// ── 阶段 A：筛出「含子任务题的比赛」（standings 总量只有 122 MB）──────────────────
const targets = [];
let scanned = 0;
for (const c of manifest.contests) {
  let st;
  try {
    st = await cached('contest.standings', { contestId: String(c.id) });
  } catch {
    continue;
  }
  scanned += 1;
  const sub = (st.problems ?? []).map((x) => String(x.index)).filter((x) => genOf(x) >= 2);
  if (sub.length) targets.push({ id: c.id, sub });
  st = null;
}
process.stdout.write(`阶段 A：扫了 ${scanned} 场，含子任务题的有 ${targets.length} 场\n`);

// ── 阶段 B：逐场跑三份实现，只把筛过的行落盘（单场峰值 = 一个 payload）────────────
const MAXC = Number(process.env.MAXC ?? 0) || targets.length;
let done = 0;
let skipped = 0;
for (const t of targets.slice(0, MAXC)) {
  const params = { contestId: String(t.id) };
  let st, ch, sub;
  try {
    st = await cached('contest.standings', params);
    ch = await cached('contest.ratingChanges', params);
    sub = await cached('contest.status', params);
  } catch {
    skipped += 1;
    continue;
  }
  const payload = {
    contestId: t.id,
    sub: t.sub,
    legacy: strip(candidatesLegacy(st, ch, sub)),
    dropEasy: strip(candidatesDropEasy(st, ch, sub)),
    cold: strip(candidates(st, ch, sub)),
  };
  await fs.writeFile(path.join(SPOOL, `${t.id}.json`), JSON.stringify(payload), 'utf8');
  st = ch = sub = null;
  done += 1;
  if (done % 10 === 0) process.stdout.write(`  阶段 B：${done}/${Math.min(MAXC, targets.length)}\n`);
}
process.stdout.write(`阶段 B：完成 ${done} 场（失败跳过 ${skipped} 场）\n`);

// ── 阶段 C：汇总（内存里只有筛过的行）──────────────────────────────────────────
const files = (await fs.readdir(SPOOL)).filter((f) => f.endsWith('.json'));
const V = { legacy: [], dropEasy: [], cold: [] };
const slotRows = new Map();   // `${contestId}/${slot}` → { legacy: [], cold: [] }
for (const f of files) {
  const d = JSON.parse(await fs.readFile(path.join(SPOOL, f), 'utf8'));
  for (const k of ['legacy', 'dropEasy', 'cold']) V[k].push(...(d[k] ?? []));
  const seeds = d.legacy ?? [];
  for (const r of seeds) {
    const key = `${r.contestId}/${String(r.problem).replace(/\d+$/, '')}`;
    if (!slotRows.has(key)) slotRows.set(key, { legacy: [], cold: [] });
    slotRows.get(key).legacy.push(r);
  }
  for (const r of d.cold ?? []) {
    if (!r.slot) continue;
    const key = `${r.contestId}/${String(r.problem).replace(/\d+$/, '')}`;
    if (!slotRows.has(key)) slotRows.set(key, { legacy: [], cold: [] });
    slotRows.get(key).cold.push(r);
  }
}

const BANDS = [1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100];
const est = (rows, q) => binEstimate(bandRows(rows, q, 100, 10)).summary;

p('# 题位（Easy / Hard Version）时间归属：三变体对照');
p('');
p('> 生成：`node scripts/cf-study/subtask-merge.mjs`。**只出报告，不改产物。**');
p('> 口径：同一份 `bandRows` + `binEstimate`（题目 Rating 恰好等于该档、赛前 Rating ±100、赛前 rated ≥ 10 场），');
p('> 读数是 `successP50Seconds`（成功者加权中位，也就是上线的那一个估计量）。');
p(`> 范围：manifest ${scanned} 场里**含子任务题的 ${targets.length} 场**，实跑 ${done} 场；`);
p(`> 只保留题目 Rating ≥ ${WANT_MIN_Q} 的行，` + '`priorRated` mock 成「通过」（不筛历史，所以绝对样本数高于生产）。');
p('');
p('三个变体：');
p('');
p('| 变体 | `X2` 的用时怎么算 | `X1` 的记录 |');
p('|---|---|---|');
p('| **legacy**（改动前） | 解出 `X1` → 解出 `X2` 的**增量** | 保留（自己的整段） |');
p('| **dropEasy**（中间版） | 题位起点 → 解出最后一个子任务 | ❌ **整条丢掉** |');
p('| **cold**（现行） | 题位起点 → 解出该子任务（**冷启动**） | ✅ 保留（自己的整段） |');
p('');
p('`legacy` 的问题不在「切分时间轴」本身，而在 `X1/X2` 是**同一道题的易/难两版**：');
p('解完 `X1` 再解 `X2`，那 1~20 分钟是「刚做完近乎同一道题」的顺手改动，不是解这道题要花的时间。');
p('`dropEasy` 修好了它，但代价是把 36 个题位的易版样本（大多落在 800–1900）整条抹掉。');
p('`cold` 两个都不丢。');
p('');

p('## 表 1 · 分档 T97（分钟）');
p('');
p('| Rating | legacy 样本 | legacy T97 | dropEasy 样本 | dropEasy T97 | **cold 样本** | **cold T97** | legacy → cold |');
p('|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const q of BANDS) {
  const l = est(V.legacy, q);
  const d = est(V.dropEasy, q);
  const c = est(V.cold, q);
  const delta = Number.isFinite(l.successP50Seconds) && Number.isFinite(c.successP50Seconds)
    ? (c.successP50Seconds - l.successP50Seconds) / 60 : null;
  p(`| ${q} | ${num(l.samples)} | ${min1(l.successP50Seconds)} | ${num(d.samples)} | ${min1(d.successP50Seconds)} | **${num(c.samples)}** | **${min1(c.successP50Seconds)}** | ${delta === null ? '—' : `**${delta > 0 ? '+' : ''}${delta.toFixed(2)}**`} |`);
}
p('');
p('位移为正 = 现行口径下这一档的 T97 **变长**（原来被低估）。');
p('');

p('## 表 2 · 独立比赛数（门槛 = 15）');
p('');
p('| Rating | legacy | dropEasy | cold |');
p('|---:|---:|---:|---:|');
for (const q of BANDS) {
  p(`| ${q} | ${est(V.legacy, q).contests} | ${est(V.dropEasy, q).contests} | ${est(V.cold, q).contests} |`);
}
p('');
p('`dropEasy` 之所以危险，看这一列：它把易版的独立比赛数一起吃掉，高档位很容易跌破 15。');
p('');

p('## 表 3 · 短用时行（「一分钟解掉一道难题」应当基本消失）');
p('');
p('| Rating | legacy < 1 分钟 | dropEasy | **cold** | legacy < 2 分钟 | dropEasy | **cold** |');
p('|---:|---:|---:|---:|---:|---:|---:|');
for (const q of BANDS) {
  const f = (rows) => {
    const s = bandRows(rows, q, 100, 10).filter((r) => r.event);
    return [s.filter((r) => r.time < 60).length, s.filter((r) => r.time < 120).length];
  };
  const [a1, a2] = f(V.legacy), [b1, b2] = f(V.dropEasy), [c1, c2] = f(V.cold);
  p(`| ${q} | ${num(a1)} | ${num(b1)} | **${num(c1)}** | ${num(a2)} | ${num(b2)} | **${num(c2)}** |`);
}
p('');

p('## 表 4 · 逐题位明细（行数最大的 16 个题位）');
p('');
p('每个子任务一行：`q<定数>: legacy 中位 → cold 中位`（单位分钟，只用解出的样本）。');
p('');
p('| contestId | 题位 | cold 行数 | legacy → cold（按定数分列） |');
p('|---:|---|---:|---|');
{
  const med = (rows) => {
    const s = rows.filter((r) => r.event);
    return s.length >= 5 ? min1(quantile(s, 0.5)) : '—';
  };
  const top = [...slotRows].sort((a, b) => b[1].cold.length - a[1].cold.length).slice(0, 16);
  for (const [key, v] of top) {
    const byQ = new Map();
    for (const r of v.legacy) {
      if (!byQ.has(r.q)) byQ.set(r.q, { legacy: [], cold: [] });
      byQ.get(r.q).legacy.push(r);
    }
    for (const r of v.cold) {
      if (!byQ.has(r.q)) byQ.set(r.q, { legacy: [], cold: [] });
      byQ.get(r.q).cold.push(r);
    }
    const parts = [...byQ.keys()].sort((a, b) => a - b)
      .map((q) => `q${q}: ${med(byQ.get(q).legacy)} → ${med(byQ.get(q).cold)}`);
    p(`| ${key.split('/')[0]} | ${key.split('/')[1]} | ${num(v.cold.length)} | ${parts.join(' ； ') || '—'} |`);
  }
}
p('');

p('## 怎么读');
p('');
p('- 表 1 是主表：`legacy → cold` 那一列就是「原来低估了多少」，高档位最明显。');
p('- 表 3 是「改动是否真的生效」的直接证据：`< 1 分钟` 的行必须几乎归零。');
p('- 表 2 是**为什么不用 `dropEasy`**：它把易版的独立比赛数一起吃掉，2000 档会跌破 15 的门槛。');
p('- 定数与题名对照见 `SLOT_CHECK.md`（36 / 38 个题位是 `Easy Version` / `Hard Version` 成对，落差中位 +400）。');
p('- 产物要重新生成得跑 `npm run study:build`（离线、只重读缓存），然后跑完整条链。');
p('');

await fs.writeFile(`${root}/SUBTASK_MERGE.md`, out.join('\n'), 'utf8');
process.stdout.write(`wrote ${root}/SUBTASK_MERGE.md | contests=${done} legacy=${V.legacy.length} dropEasy=${V.dropEasy.length} cold=${V.cold.length}\n`);
