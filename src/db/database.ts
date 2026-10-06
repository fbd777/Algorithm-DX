import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cache, ProblemRelease, Submission } from '../domain.ts';

/** 已支持的 Schema 版本与对应的迁移步骤，按顺序执行；每一步都幂等（用 IF NOT EXISTS / 版本判断）。 */
const MIGRATIONS: readonly { appliesWhenAtMost: number; file: string }[] = [
  { appliesWhenAtMost: 0, file: './schema.sql' },
  { appliesWhenAtMost: 1, file: './migrations/002-sync.sql' },
  { appliesWhenAtMost: 2, file: './migrations/003-account-profile.sql' },
  { appliesWhenAtMost: 3, file: './migrations/004-score.sql' },
  { appliesWhenAtMost: 4, file: './migrations/005-problem-time.sql' },
  { appliesWhenAtMost: 5, file: './migrations/006-contest.sql' },
  { appliesWhenAtMost: 6, file: './migrations/007-follow.sql' },
  { appliesWhenAtMost: 7, file: './migrations/008-contest-duration.sql' },
  { appliesWhenAtMost: 8, file: './migrations/009-account-archive.sql' },
  { appliesWhenAtMost: 9, file: './migrations/010-practice-attempts.sql' },
  { appliesWhenAtMost: 10, file: './migrations/011-practice-timers.sql' },
  { appliesWhenAtMost: 11, file: './migrations/012-dx-reminders.sql' },
  { appliesWhenAtMost: 12, file: './migrations/013-practice-edit.sql' },
  { appliesWhenAtMost: 13, file: './migrations/014-manual-practice.sql' },
  { appliesWhenAtMost: 14, file: './migrations/015-timer-settlement.sql' },
  { appliesWhenAtMost: 15, file: './migrations/016-group-rating-sources.sql' },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(path = 'data/algo-observer.sqlite'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = db.prepare('PRAGMA user_version').get()!.user_version;
    if (version > SCHEMA_VERSION) throw new Error(`Unsupported schema version: ${version}`);
    for (const step of MIGRATIONS) {
      if (version > step.appliesWhenAtMost) continue;
      db.exec('BEGIN');
      db.exec(readFileSync(new URL(step.file, import.meta.url), 'utf8'));
      db.exec('COMMIT');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

/** handle 的归一化规则：目前只有 Codeforces 已知（忽略大小写），未来由各适配器自己负责。 */
function handleKey(platform: string, handle: string): string {
  const clean = handle.trim();
  return platform === 'codeforces' ? clean.toLowerCase() : clean;
}

export class Repository implements Cache {
  db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  /**
   * 建一个被观测的人。
   *
   * `isFollowed` 默认开：专门新建一个人，目的通常就是看他。本人（`isSelf`）恒为已关注 ——
   * 他是主视图与 DX 榜的锚点，取消关注等于把自己从自己的面板里摘出去。
   */
  createUser(name: string, isSelf = false, isFollowed = true): number {
    return Number(this.db.prepare('INSERT INTO users(name,is_self,is_followed) VALUES (?,?,?)')
      .run(name.trim(), Number(isSelf), Number(isSelf || isFollowed)).lastInsertRowid);
  }
  addAccount(userId: number, platform: string, handle: string): number {
    return Number(this.db.prepare('INSERT INTO accounts(user_id,platform,handle,handle_key) VALUES (?,?,?,?)')
      .run(userId, platform, handle.trim(), handleKey(platform, handle)).lastInsertRowid);
  }
  /**
   * 按「平台 + handle」找已绑定的账号，用于让重复绑定变成可识别的更新而不是约束冲突。
   * accounts 上是 UNIQUE(platform, handle_key)（不含 user_id），即同一平台同一个 handle 全局唯一。
   */
  findAccount(platform: string, handle: string): { id: number; user_id: number; display_name: string | null } | undefined {
    return this.db.prepare('SELECT id,user_id,display_name FROM accounts WHERE platform=? AND handle_key=?')
      .get(platform, handleKey(platform, handle)) as { id: number; user_id: number; display_name: string | null } | undefined;
  }
  /** 记录平台解析出的公开昵称；只用于显示，不参与抓取或唯一性判断。 */
  setDisplayName(accountId: number, name: string): void {
    this.db.prepare('UPDATE accounts SET display_name=?, display_name_at=unixepoch() WHERE id=?').run(name.trim(), accountId);
  }
  /** 同一账号改名；身份确认与同步互斥由 account-admin 负责。清除旧昵称缓存。 */
  renameAccount(accountId: number, platform: string, handle: string): void {
    this.db.prepare('UPDATE accounts SET handle=?, handle_key=?, display_name=NULL, display_name_at=NULL WHERE id=?')
      .run(handle.trim(), handleKey(platform, handle), accountId);
  }
  saveSubmissions(accountId: number, rows: Submission[]): void {
    const account = this.db.prepare('SELECT platform FROM accounts WHERE id=?').get(accountId);
    if (!account) throw new Error('Account does not exist');
    const statement = this.db.prepare(`INSERT INTO submissions
      (account_id,platform,submission_id,problem_id,problem_title,problem_url,difficulty,tags_json,status,raw_status,language,execution_time,memory,score,submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,submission_id) DO UPDATE SET
      problem_title=excluded.problem_title,problem_url=excluded.problem_url,
      -- difficulty 用 COALESCE：提交载荷只在平台公布评级**之后**才带值。已回填的官方评级
      -- （problemset 补的那种）不能被「还没公布」的 NULL 盖回去 —— 否则每次重复同步
      -- 都会把回填成果清掉，下一轮再补、再被清，永远不稳定。
      difficulty=COALESCE(excluded.difficulty,difficulty),
      tags_json=excluded.tags_json,status=excluded.status,raw_status=excluded.raw_status,
      language=excluded.language,execution_time=excluded.execution_time,memory=excluded.memory,
      score=excluded.score`);
    this.db.exec('SAVEPOINT save_submissions');
    try {
      for (const s of rows) {
        if (s.platform !== account.platform) throw new Error('Submission platform does not match account');
        // score 用 ?? null：手写的提交对象可能完全没有这个字段，
        // 而 undefined 无法绑定到 SQLite 参数（会抛 ERR_INVALID_ARG_TYPE）。
        statement.run(accountId,s.platform,s.submission_id,s.problem_id,s.problem_title,s.problem_url,s.difficulty,JSON.stringify(s.tags),s.status,s.raw_status,s.language,s.execution_time,s.memory,s.score??null,s.submitted_at);
      }
      this.db.exec('RELEASE save_submissions');
    } catch (error) { this.db.exec('ROLLBACK TO save_submissions; RELEASE save_submissions'); throw error; }
  }
  /**
   * 落库「比赛 id → 开始时间」。**只写不读**：读在 `queries.ts` 的 `listDxEntries` 里，
   * 按 problem_id 前缀联出来。
   *
   * 整体覆盖写入（upsert）：比赛开始时间是既成事实，重抓只会把 `fetched_at` 刷新 ——
   * 那是 TTL 判断的依据，不能只更新名称而留下旧的时间戳。
   */
  saveProblemReleases(platform: string, rows: readonly ProblemRelease[]): void {
    const statement = this.db.prepare(`INSERT INTO contests(platform,contest_id,name,start_time,duration_seconds,fetched_at)
      VALUES (?,?,?,?,?,unixepoch()) ON CONFLICT(platform,contest_id) DO UPDATE SET
      name=excluded.name,start_time=excluded.start_time,duration_seconds=excluded.duration_seconds,fetched_at=excluded.fetched_at`);
    this.db.exec('SAVEPOINT save_releases');
    try {
      for (const row of rows) statement.run(platform, row.contestId, row.name, row.startTime, row.durationSeconds ?? null);
      this.db.exec('RELEASE save_releases');
    } catch (error) { this.db.exec('ROLLBACK TO save_releases; RELEASE save_releases'); throw error; }
  }
  get<T = Submission[]>(key: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM fetch_cache WHERE cache_key=? AND expires_at > unixepoch()').get(key);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  set<T = Submission[]>(key: string, value: T, ttlSeconds: number): void {
    this.db.prepare('INSERT INTO fetch_cache VALUES (?,?,unixepoch()+?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at').run(key,JSON.stringify(value),ttlSeconds);
  }
}
