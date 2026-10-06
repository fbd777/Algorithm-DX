// 扩充历史证据账本：把年份区间内所有正式比赛的 Rating 变更并进 SQLite 账本。
//
// 账本是「赛前已参赛 ≥10 场」这条主口径门槛的唯一证据来源。原有账本只覆盖 97 场、
// 平均每月 1–4 场，于是低档位只有极活跃的老手能通过门槛（800 档通过率 3.4%，
// 65% 的记录卡在 1–4 场）—— 既是样本瓶颈，也是选择偏差的来源。
//
// ratingChanges 每场只有 1 个请求、约 0.46 MB，比抓比赛（每场 3 请求、其中 status
// 平均 31 MB 压缩后）便宜一个量级，所以先把账本铺满再谈加比赛。
//
// 存储见 ledger-store.mjs：为什么不是 JSON，那里写了原因（V8 单字符串上限）。
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { api, saveJson, dataRoot } from './api.mjs';
import { openLedger, importLegacyJson } from './ledger-store.mjs';
import { UNRATED_CONTEST_NAME } from './core.mjs';

const arg = (name, fallback) => process.argv.find(x => x.startsWith('--' + name + '='))?.split('=')[1] ?? fallback;
const flag = name => process.argv.includes('--' + name);
const fromYear = Number(arg('from', 2022)), toYear = Number(arg('to', 2026));
const maxContests = Number(arg('contests', 400)), flushEvery = Number(arg('flush', 10));
const dryRun = flag('dry-run');
for (const [name, n] of Object.entries({ fromYear, toYear, maxContests, flushEvery }))
  if (!Number.isInteger(n) || n < 1) throw Error(name + ' must be a positive integer');

const storeFile = path.join(dataRoot, 'processed/history-ledger.sqlite');
const legacyFile = path.join(dataRoot, 'processed/history-ledger.json');
const archiveFile = path.join(dataRoot, 'runs/pre-backfill/history-ledger.json.gz');
const manifestFile = path.join(dataRoot, 'manifest.json');
const store = openLedger(storeFile);

// 旧版 JSON 账本只在 SQLite 还空着时导入一次，导完压缩存档、删掉原文件 ——
// 505 MB 的 JSON 已经撞上 V8 的字符串上限，留着它下次运行还会崩在同一个地方。
if (!dryRun && store.contestCount() === 0) {
  let hasLegacy = true;
  try { await fs.access(legacyFile); } catch { hasLegacy = false; }
  if (hasLegacy) {
    console.log('导入旧版 JSON 账本…');
    const r = await importLegacyJson(store, legacyFile);
    console.log('导入完成：选手', r.handles, '| 行', r.rows, '| 比赛', r.contests);
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    await pipeline(createReadStream(legacyFile), createGzip({ level: 1 }), createWriteStream(archiveFile));
    await fs.rm(legacyFile);
    console.log('旧版 JSON 已压缩存档并删除 →', path.relative(process.cwd(), archiveFile));
  }
}

const covered = store.coveredContests();
const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
console.log('账本现有', covered.size, '场比赛、', store.rowCount(), '行、', store.handleCount(), '位选手');

const list = await api('contest.list', { gym: 'false' });
const fromSec = Date.UTC(fromYear, 0, 1) / 1000, toSec = Date.UTC(toYear, 0, 1) / 1000;
// type 字段有个坑：'ICPC' 不是「ICPC 赛制的比赛」，而是指标准 ACM 赛制 ——
// `Codeforces Round 1114 (Div. 3)`、`Educational Codeforces Round 194` 全都是 type='ICPC'。
// 只取 type==='CF' 会漏掉整整一半的正式比赛（2022–2026 共 587 场里 223 场），
// 而 Educational / Div.3 正是低分选手最早拿到 rated 记录的地方 —— 漏掉它们会让
// 低档位的 priorRated 系统性偏低，正是要修的那个偏差。所以判据改成 type!=='IOI'。
// 剩下的娱乐场次靠名单排除，名单没盖到的由「有没有 Rating 变更」兜底（见循环里的 UNAVAILABLE）。
const skip = UNRATED_CONTEST_NAME;
const pool = list
  .filter(c => c.phase === 'FINISHED' && c.type !== 'IOI' && c.startTimeSeconds >= fromSec && c.startTimeSeconds < toSec && !covered.has(c.id) && !skip.test(c.name || ''))
  .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
console.log('待补比赛', pool.length, '场 | 年份', fromYear + '-' + (toYear - 1), '| 上限', maxContests, '场', dryRun ? '| DRY RUN' : '');

if (dryRun) {
  for (const c of pool.slice(0, maxContests)) console.log('PLAN', c.id, new Date(c.startTimeSeconds * 1000).toISOString().slice(0, 10), (c.name || '').slice(0, 52));
  console.log('DRY RUN 结束：实际请求数 = 上表场数（每场 1 个 ratingChanges 请求，约 6.1 秒间隔；命中缓存则不发请求）。');
  store.close();
  process.exit(0);
}

// manifest.historyContests 是账本覆盖范围的可读镜像，以 store 为准重建。
function syncManifestHistory() {
  const known = new Map(manifest.historyContests.map(x => [x.id, x]));
  manifest.historyContests = store.contestRows().map(r => ({
    ...(known.get(r.contestId) ?? {}),
    id: r.contestId, start: r.start, rows: r.rows, ledger: true,
  }));
}

let added = 0, empty = 0, failed = 0, unavailable = 0, rowsAdded = 0, processed = 0;
const emptyIds = [];
const started = Date.now();
for (const c of pool) {
  if (processed >= maxContests) break;
  processed++;
  try {
    const changes = await api('contest.ratingChanges', { contestId: String(c.id) });
    if (!changes.length) {
      // 抓过但没有 Rating 变更的场次也要登记，否则下一轮会再请求一遍。
      store.markContest(c.id, c.startTimeSeconds, 0);
      covered.add(c.id); empty++; emptyIds.push(c.id);
      console.log('EMPTY', c.id, (c.name || '').slice(0, 46), '（无 Rating 变更）');
      continue;
    }
    const inserted = store.appendContest(c.id, c.startTimeSeconds, changes);
    covered.add(c.id);
    added++; rowsAdded += inserted;
    console.log('LEDGER', processed + '/' + pool.length, c.id, new Date(c.startTimeSeconds * 1000).toISOString().slice(0, 10), (c.name || '').slice(0, 46), 'rows=' + changes.length, 'inserted=' + inserted, 'elapsed=' + Math.round((Date.now() - started) / 1000) + 's');
    if (added % flushEvery === 0) {
      syncManifestHistory();
      await saveJson(manifestFile, manifest);
      console.log('  flushed（账本', covered.size, '场、', store.rowCount(), '行）');
    }
  } catch (e) {
    // CF 对一部分场次（ICPC 区域赛、mirror 等）直接返回 400「Rating changes are unavailable」。
    // 这不是故障，是「这场比赛没公开 Rating 变更」—— 同样登记为已覆盖 0 行，免得每轮重试。
    if (/rating changes are unavailable|Rating changes are unavailable/i.test(e.message)) {
      store.markContest(c.id, c.startTimeSeconds, 0);
      covered.add(c.id); unavailable++; emptyIds.push(c.id);
      console.log('UNAVAILABLE', c.id, (c.name || '').slice(0, 46));
      continue;
    }
    failed++; console.error('ERR', c.id, e.message);
  }
}
syncManifestHistory();
await saveJson(manifestFile, manifest);
if (emptyIds.length) console.log('无 Rating 变更 / 不公开的场次:', emptyIds.join(', '));
console.log('DONE', JSON.stringify({
  requested: processed, addedContests: added, rowsAdded, emptyContests: empty, unavailableContests: unavailable, failed,
  handles: store.handleCount(), totalContests: covered.size, totalRows: store.rowCount(),
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
}, null, 2));
store.close();
console.log('下一步：node scripts/cf-study/build.mjs 用新账本重建全部记录，再跑 backfill 加比赛。');
