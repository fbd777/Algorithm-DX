// 历史证据账本的存储层（SQLite）。
//
// 为什么不是 JSON：账本要覆盖年份区间内**全部**正式比赛的 Rating 变更（约 1000 场、
// 数百万行）。JSON 版本长到 505 MB 时撞上了 V8 的单字符串上限（约 512 MiB），
// JSON.stringify 抛 RangeError —— 而且是从撞上限那一刻起**每一次落盘都失败**，
// 已经抓到的数据只存在于内存里，随进程一起没了（2026-09-17 实测，19 场白抓）。
// 换成 node:sqlite（项目本来就用它，仍然零第三方依赖）之后：追加是增量的、
// 没有体积天花板、按 handle 取历史走主键范围扫描、崩了也不会毁掉已经写进去的部分。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openLedger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // 主键 (handle, contest_id) 一举两得：
  //   1. 按 handle 取历史正好是主键前缀的范围扫描 —— 这正是 attachHistory 每次都要的；
  //   2. 天然去重，同一场比赛同一个人只可能有一条 Rating 变更，重跑不会写重。
  // WITHOUT ROWID：这张表本身就是按 handle 组织的，不需要再存一份 rowid 副本。
  db.exec(`CREATE TABLE IF NOT EXISTS rating_changes(
    handle TEXT NOT NULL,
    contest_id INTEGER NOT NULL,
    rating_update_time INTEGER NOT NULL,
    old_rating INTEGER,
    new_rating INTEGER,
    PRIMARY KEY(handle, contest_id)
  ) WITHOUT ROWID`);
  // 账本覆盖了哪些比赛。与 rating_changes 分开存，是因为「这场抓过但没有 Rating 变更」
  // （非 rated / 娱乐场次）也要记下来，否则每轮都会重新请求一遍。
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_contests(
    contest_id INTEGER PRIMARY KEY,
    start_time INTEGER,
    rows INTEGER NOT NULL,
    added_at TEXT NOT NULL
  )`);

  const insertChange = db.prepare(`INSERT OR IGNORE INTO rating_changes
    (handle, contest_id, rating_update_time, old_rating, new_rating) VALUES(?, ?, ?, ?, ?)`);
  const insertContest = db.prepare(`INSERT OR REPLACE INTO ledger_contests
    (contest_id, start_time, rows, added_at) VALUES(?, ?, ?, ?)`);
  const selectHistory = db.prepare(`SELECT contest_id, rating_update_time, old_rating, new_rating
    FROM rating_changes WHERE handle = ? ORDER BY rating_update_time`);
  const countContests = db.prepare('SELECT count(*) AS n FROM ledger_contests');
  const countRows = db.prepare('SELECT count(*) AS n FROM rating_changes');
  const countHandles = db.prepare('SELECT count(DISTINCT handle) AS n FROM rating_changes');
  // 按 handle 缓存历史。写入时必须清掉，理由见 historyFor。
  const historyCache = new Map();

  const store = {
    db,
    file,

    /** 已覆盖的比赛 id 集合（含「抓过但没有 Rating 变更」的场次）。 */
    coveredContests() {
      return new Set(db.prepare('SELECT contest_id FROM ledger_contests').all().map(r => Number(r.contest_id)));
    },

    contestRows() {
      return db.prepare('SELECT contest_id, start_time, rows FROM ledger_contests ORDER BY start_time').all()
        .map(r => ({ contestId: Number(r.contest_id), start: r.start_time === null ? null : Number(r.start_time), rows: Number(r.rows) }));
    },

    contestCount: () => Number(countContests.get().n),
    rowCount: () => Number(countRows.get().n),
    handleCount: () => Number(countHandles.get().n),

    /** 写入一场比赛的 Rating 变更。返回真正新增的行数（重复的会被主键挡掉）。 */
    appendContest(contestId, startTime, rows) {
      db.exec('BEGIN IMMEDIATE');
      try {
        let inserted = 0;
        for (const r of rows) {
          inserted += insertChange.run(
            String(r.handle).toLowerCase(),
            Number(contestId),
            Number(r.ratingUpdateTimeSeconds ?? 0),
            r.oldRating ?? null,
            r.newRating ?? null,
          ).changes;
        }
        insertContest.run(Number(contestId), startTime ?? null, rows.length, new Date().toISOString());
        db.exec('COMMIT');
        historyCache.clear();
        return inserted;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    /** 只登记「这场比赛抓过了」，不写行（非 rated 的场次）。 */
    markContest(contestId, startTime, rowCount) {
      insertContest.run(Number(contestId), startTime ?? null, rowCount, new Date().toISOString());
      historyCache.clear();
    },

    /**
     * 一位选手的历史。字段名与 CF 官方 ratingChanges 一致，attachHistory 直接可用。
     * 结果按 handle 缓存 —— backfill 会按行逐条查，同一个人在一场比赛里出现很多次。
     * 缓存必须随写入失效：attachHistory 要求**当前这场比赛**也在历史里（用它核对 oldRating），
     * 若缓存停留在「那场比赛还没写进去」的时刻，整行会被判 null 静默丢掉。
     */
    historyFor(handle) {
      const key = String(handle).toLowerCase();
      let rows = historyCache.get(key);
      if (rows === undefined) {
        rows = selectHistory.all(key).map(r => ({
          contestId: Number(r.contest_id),
          ratingUpdateTimeSeconds: Number(r.rating_update_time),
          oldRating: r.old_rating === null ? null : Number(r.old_rating),
          newRating: r.new_rating === null ? null : Number(r.new_rating),
        }));
        historyCache.set(key, rows);
      }
      return rows;
    },

    /** 清掉进程内缓存。批量写入不走 appendContest 时手动调用。 */
    clearCache() { historyCache.clear(); },

    close() { db.close(); },
  };
  return store;
}

/**
 * 把旧版 history-ledger.json 一次性灌进 SQLite。
 * 旧格式是按 handle 分组的原始 CF ratingChanges 行，正好与 rating_changes 一一对应。
 * start_time 旧文件里没有，先留空 —— 之后跑一次 ledger.mjs 会用 contest.list 补上。
 * 返回 { handles, rows, contests }。
 */
export async function importLegacyJson(store, jsonFile) {
  const text = await fsp.readFile(jsonFile, 'utf8');
  const legacy = JSON.parse(text);
  const insert = store.db.prepare(`INSERT OR IGNORE INTO rating_changes
    (handle, contest_id, rating_update_time, old_rating, new_rating) VALUES(?, ?, ?, ?, ?)`);
  const perContest = new Map(); // contestId -> 行数，只有几千个键，不占内存
  let rows = 0;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const [handle, entries] of Object.entries(legacy)) {
      const h = String(handle).toLowerCase();
      for (const e of entries ?? []) {
        const id = Number(e.contestId);
        if (!Number.isFinite(id)) continue;
        insert.run(h, id, Number(e.ratingUpdateTimeSeconds ?? 0), e.oldRating ?? null, e.newRating ?? null);
        perContest.set(id, (perContest.get(id) ?? 0) + 1);
        rows++;
      }
    }
    for (const [id, n] of perContest) store.markContest(id, null, n);
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  return { handles: Object.keys(legacy).length, rows, contests: perContest.size };
}
