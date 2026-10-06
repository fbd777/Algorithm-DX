/**
 * Phase 3 Dashboard 的只读查询层。
 *
 * 约定（与 README「练习量与鼓励的统计口径」一致）：
 * - 同一平台内以 (platform, problem_id) 去重题目；不宣称跨平台同题唯一。
 * - 保留 WA/TLE 等尝试，不只用 AC 计数。
 * - 统计一律以 SQLite 中最新判题结果为准（重复提交是 upsert）。
 * - 时间统一存 UTC 秒；活跃天数按调用方传入的时区偏移换算，不假设服务器时区。
 * - 本文件只执行 SELECT，任何写操作都不得出现在这里。
 */

import type { DatabaseSync } from 'node:sqlite';
import { CONTEST_SCOPED_PROBLEM, PRACTICE_PROBLEM } from '../problem-scope.ts';
import type { ContestTimelineRow } from '../dx/types.ts';

export type { ContestTimelineRow };

export type StatusFilter = 'all' | 'ac' | 'unac';

/**
 * 主视图的范围 —— **「我」与「我关注的人」是两层，不是一层**。
 *
 * - `me`：只看本人（`is_self = 1`）。
 * - `all`：本人 + 所有**已关注**的人（`is_self = 1 OR is_followed = 1`）。
 *
 * 「存在但不关注」的人在任何一档里都不出现。这正是关注标记存在的理由：
 * 想临时不看某人，切一下标记就行，不必删掉他 —— 删用户会连带删掉他名下
 * 所有账号与提交记录（外键 ON DELETE CASCADE），那是不可逆的。
 *
 * 显式指定 `userId` 时以它为准（点某个人单独看），范围档不再生效。
 */
export type Scope = 'me' | 'all';

/**
 * 范围条件的 SQL 片段 —— **只有这一处出处**。
 *
 * 提交流 / 统计（走 `buildWhere`）与总览数字（`getMeta` 里的独立查询）都引用它，
 * 否则会出现「列表里没有这个人、总数却把他算进去了」这种对不上账的情况。
 */
const SCOPE_SQL: Record<Scope, string> = {
  me: 'u.is_self = 1',
  all: '(u.is_self = 1 OR u.is_followed = 1)',
};

export interface Filters {
  platforms: string[];
  userId: number | null;
  /** 主视图范围。默认 `all`。 */
  scope: Scope;
  status: StatusFilter;
  q: string | null;
  since: number | null;
  until: number | null;
  tzOffsetMinutes: number;
}

export const DEFAULT_TZ_OFFSET_MINUTES = 480;

/** 把 problem_id 与 platform 拼成去重键时使用的连接符，避免与题目 ID 自身的字符冲突。 */
const SEP = ' || char(31) || ';

/**
 * 洛谷的比赛内编号：形如 `T1234567`（T + 数字）。
 *
 * 2026-09-17 实测：语言月赛的同一道题在记录列表里会出现两次 —— 比赛期间的临时编号
 * `T…` 与赛后公开的练习编号 `B…`，两者题名完全相同。按 problem_id 聚合会把同一道题
 * 算两遍（实测多算 13 题：230 而不是 217）。
 *
 * 约定：**题目数量口径排除它们**（`attempted` / `solved` / 题目卡片统计），
 * 但**提交明细与提交条数照常保留**。规则本身定义在 `src/problem-scope.ts`，这里只做引用，
 * 不复制字符串 —— 口径必须只有一处出处。
 */
const CONTEST_SCOPED = CONTEST_SCOPED_PROBLEM;
/** 计入口径的「练习题目」。 */
const PRACTICE_ONLY = PRACTICE_PROBLEM;

interface Clause {
  sql: string;
  params: (string | number)[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildWhere(f: Filters): Clause {
  const parts: string[] = ['a.is_archived = 0'];
  const params: (string | number)[] = [];
  if (f.platforms.length) {
    parts.push(`s.platform IN (${f.platforms.map(() => '?').join(',')})`);
    params.push(...f.platforms);
  }
  if (f.userId !== null) {
    // 显式点名某个人时以它为准 —— 范围档是「默认看哪些人」，不是硬过滤。
    parts.push('a.user_id = ?');
    params.push(f.userId);
  } else {
    parts.push(SCOPE_SQL[f.scope]);
  }
  if (f.q) {
    parts.push("(s.problem_title LIKE ? ESCAPE '\\' OR s.problem_id LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(f.q)}%`;
    params.push(like, like);
  }
  if (f.since !== null) {
    parts.push('s.submitted_at >= ?');
    params.push(f.since);
  }
  if (f.until !== null) {
    parts.push('s.submitted_at <= ?');
    params.push(f.until);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/**
 * 所有查询共用的候选集 CTE：把提交联到账号与人物上，并套用筛选条件。
 * 视图 submission_feed 已表达同样的语义，这里显式 JOIN 是为了能在同一条语句里
 * 继续做窗口聚合，而不必新建视图或物化表。
 */
function baseCte(clause: Clause): string {
  return `WITH f AS (
    SELECT s.id AS sid, s.account_id, s.platform, s.problem_id, s.problem_title, s.problem_url,
           s.difficulty, s.tags_json, s.status, s.raw_status, s.language,
           s.execution_time, s.memory, s.score, s.submitted_at,
           a.user_id, a.handle, a.display_name, u.name AS user_name
    FROM submissions s
    JOIN accounts a ON a.id = s.account_id
    JOIN users u ON u.id = a.user_id
    ${clause.sql}
  )`;
}

function statusHaving(status: StatusFilter): string {
  if (status === 'ac') return "HAVING SUM(CASE WHEN status = 'AC' THEN 1 ELSE 0 END) > 0";
  if (status === 'unac') return "HAVING SUM(CASE WHEN status = 'AC' THEN 1 ELSE 0 END) = 0";
  return '';
}

export interface ProblemRow {
  platform: string;
  problem_id: string;
  problem_title: string;
  problem_url: string | null;
  difficulty: number | null;
  tags: string[];
  user_name: string;
  handle: string;
  /** 平台公开昵称；数字 UID 平台（洛谷）绑定时解析，缺失时为 null。 */
  display_name: string | null;
  attempts: number;
  ac_count: number;
  failed_count: number;
  solved: boolean;
  /** 洛谷比赛内编号（`T…`）：仍在动态里显示，但**不参与题目数量统计**。 */
  contest_scoped: boolean;
  /**
   * 历史最高得分与最近一次得分（洛谷）。其他平台不提供分数，恒为 null。
   * **满分由题目决定，不是固定的 100**，所以只报原始分，不折算成百分比。
   * 「未 AC」的题目上看最高分比看最近一次更有意义 —— 它说明离满分还有多远。
   */
  best_score: number | null;
  latest_score: number | null;
  first_ac_at: number | null;
  last_ac_at: number | null;
  last_at: number;
  /**
   * 「最快用时」：比赛窗口 [开赛, 开赛+时长) 内最早一次 AC 与开赛时间的差（秒），
   * 取**当前范围内**（仅我 / 我和关注的人）最快的那个人。
   * CF 题专属 —— problem_id 前缀联 `contests` 只有 CF 形态（`2263:A`）匹配得上。
   * 比赛时长缺失（v8 迁移后未刷新）、gym、纯 practice 解掉的题为 null，**不猜**。
   */
  fastest_solve_seconds: number | null;
  /** 拿到最快用时的那个人（范围内用户名）。 */
  fastest_user: string | null;
  ac: {
    submission_id: string;
    submitted_at: number;
    raw_status: string | null;
    language: string | null;
    execution_time: number | null;
    memory: number | null;
    score: number | null;
  } | null;
}

interface RawProblemRow {
  platform: string;
  problem_id: string;
  problem_title: string;
  problem_url: string | null;
  difficulty: number | null;
  tags_json: string;
  user_name: string;
  handle: string;
  display_name: string | null;
  attempts: number;
  ac_count: number;
  solved: number;
  contest_scoped: number;
  best_score: number | null;
  latest_score: number | null;
  first_ac_at: number | null;
  last_ac_at: number | null;
  last_at: number;
  ac_sid: number | null;
  ac_submission_id: string | null;
  ac_raw_status: string | null;
  ac_language: string | null;
  ac_time: number | null;
  ac_memory: number | null;
  ac_score: number | null;
  fastest_solve_seconds: number | null;
  fastest_user: string | null;
}

function toProblem(row: RawProblemRow): ProblemRow {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json || '[]');
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = [];
  }
  const acCount = Number(row.ac_count ?? 0);
  return {
    platform: row.platform,
    problem_id: row.problem_id,
    problem_title: row.problem_title,
    problem_url: row.problem_url,
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    tags,
    user_name: row.user_name,
    handle: row.handle,
    display_name: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    attempts: Number(row.attempts ?? 0),
    ac_count: acCount,
    failed_count: Number(row.attempts ?? 0) - acCount,
    solved: Number(row.solved ?? 0) === 1,
    contest_scoped: Number(row.contest_scoped ?? 0) === 1,
    best_score: row.best_score === null || row.best_score === undefined ? null : Number(row.best_score),
    latest_score: row.latest_score === null || row.latest_score === undefined ? null : Number(row.latest_score),
    first_ac_at: row.first_ac_at === null ? null : Number(row.first_ac_at),
    last_ac_at: row.last_ac_at === null ? null : Number(row.last_ac_at),
    last_at: Number(row.last_at),
    fastest_solve_seconds:
      row.fastest_solve_seconds === null || row.fastest_solve_seconds === undefined
        ? null
        : Number(row.fastest_solve_seconds),
    fastest_user: row.fastest_user === null || row.fastest_user === undefined ? null : String(row.fastest_user),
    ac:
      row.ac_submission_id === null
        ? null
        : {
            submission_id: row.ac_submission_id,
            submitted_at: Number(row.last_ac_at ?? row.last_at),
            raw_status: row.ac_raw_status,
            language: row.ac_language,
            execution_time: row.ac_time === null ? null : Number(row.ac_time),
            memory: row.ac_memory === null ? null : Number(row.ac_memory),
            score: row.ac_score === null || row.ac_score === undefined ? null : Number(row.ac_score),
          },
  };
}

/** 题目级聚合：AC 卡片与未 AC 折叠组都用这一个形状。 */
export function listProblems(
  db: DatabaseSync,
  f: Filters,
  limit: number,
  offset: number,
): { total: number; items: ProblemRow[] } {
  const clause = buildWhere(f);
  const statusClause = f.status === 'ac' ? 'WHERE solved = 1' : f.status === 'unac' ? 'WHERE solved = 0' : '';

  const totalRow = db
    .prepare(
      `${baseCte(clause)}
       SELECT COUNT(*) AS c FROM (
         SELECT platform, problem_id, SUM(CASE WHEN status = 'AC' THEN 1 ELSE 0 END) AS acs
         FROM f GROUP BY platform, problem_id ${statusHaving(f.status)}
       )`,
    )
    .get(...clause.params) as { c: number } | undefined;

  const rows = db
    .prepare(
      `${baseCte(clause)},
       ranked AS (
         SELECT f.*,
           ROW_NUMBER() OVER (PARTITION BY platform, problem_id ORDER BY submitted_at DESC, sid DESC) AS rn_latest,
           MAX(CASE WHEN status = 'AC' THEN 1 ELSE 0 END) OVER (PARTITION BY platform, problem_id) AS solved,
           COUNT(*) OVER (PARTITION BY platform, problem_id) AS attempts,
           SUM(CASE WHEN status = 'AC' THEN 1 ELSE 0 END) OVER (PARTITION BY platform, problem_id) AS ac_count,
           MIN(CASE WHEN status = 'AC' THEN submitted_at END) OVER (PARTITION BY platform, problem_id) AS first_ac_at,
           MAX(CASE WHEN status = 'AC' THEN submitted_at END) OVER (PARTITION BY platform, problem_id) AS last_ac_at,
           MAX(submitted_at) OVER (PARTITION BY platform, problem_id) AS last_at,
           MAX(score) OVER (PARTITION BY platform, problem_id) AS best_score,
           -- 比赛内编号在同一个 (platform, problem_id) 分区里是常量，取 MAX 只是把它带出来。
           MAX(CASE WHEN ${CONTEST_SCOPED} THEN 1 ELSE 0 END) OVER (PARTITION BY platform, problem_id) AS contest_scoped
         FROM f
       ),
       acr AS (
         SELECT f.*, ROW_NUMBER() OVER (PARTITION BY platform, problem_id ORDER BY submitted_at DESC, sid DESC) AS rn_ac
         FROM f WHERE f.status = 'AC'
       ),
       -- 「最快用时」：比赛窗口内的最早一次 AC。窗口右端必须用 duration_seconds 卡死 ——
       -- 否则赛后再做（practice / virtual）的 AC 会以「距开赛好几天」的身份混进来，
       -- 那不是用时是垃圾值。duration 未知的比赛**一行都不收**，宁缺毋滥。
       fastr AS (
         SELECT platform, problem_id, user_name AS fast_user, fast_seconds
         FROM (
           SELECT f.platform, f.problem_id, f.user_name,
                  f.submitted_at - cc.start_time AS fast_seconds,
                  ROW_NUMBER() OVER (PARTITION BY f.platform, f.problem_id ORDER BY f.submitted_at ASC, f.sid ASC) AS rn_fast
           FROM f JOIN contests cc
                  ON cc.platform = f.platform
                 AND cc.contest_id = CAST(substr(f.problem_id, 1, instr(f.problem_id, ':') - 1) AS INTEGER)
           WHERE f.status = 'AC'
             AND cc.duration_seconds IS NOT NULL
             AND f.submitted_at >= cc.start_time
             AND f.submitted_at < cc.start_time + cc.duration_seconds
         ) WHERE rn_fast = 1
       )
       SELECT g.platform, g.problem_id, g.problem_title, g.problem_url, g.difficulty, g.tags_json,
              g.user_name, g.handle, g.display_name, g.attempts, g.ac_count, g.solved, g.contest_scoped,
              g.first_ac_at, g.last_ac_at, g.last_at, g.best_score, g.score AS latest_score,
              ac.sid AS ac_sid, ac.raw_status AS ac_raw_status, ac.language AS ac_language,
              ac.execution_time AS ac_time, ac.memory AS ac_memory, ac.score AS ac_score,
              ft.fast_seconds AS fastest_solve_seconds, ft.fast_user AS fastest_user
       FROM (SELECT * FROM ranked WHERE rn_latest = 1) g
       LEFT JOIN acr ac
         ON ac.platform = g.platform AND ac.problem_id = g.problem_id AND ac.rn_ac = 1
       LEFT JOIN fastr ft
         ON ft.platform = g.platform AND ft.problem_id = g.problem_id
       ${statusClause}
       ORDER BY g.solved DESC, g.last_at DESC, g.platform ASC, g.problem_id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...clause.params, limit, offset) as unknown as RawProblemRow[];

  return { total: Number(totalRow?.c ?? 0), items: rows.map(toProblem) };
}

export interface SubmissionRow {
  id: number;
  platform: string;
  submission_id: string;
  problem_id: string;
  problem_title: string;
  problem_url: string | null;
  difficulty: number | null;
  tags: string[];
  status: string;
  raw_status: string | null;
  language: string | null;
  execution_time: number | null;
  memory: number | null;
  score: number | null;
  submitted_at: number;
  user_name: string;
  handle: string;
}

/** 单题全部提交（含尝试次数与判题时间线），供「尝试 N 次」按需展开。 */
export function listProblemSubmissions(
  db: DatabaseSync,
  f: Filters,
  platform: string,
  problemId: string,
): SubmissionRow[] {
  const clause = buildWhere(f);
  const extra: string[] = ['s.platform = ?', 's.problem_id = ?'];
  const extraParams: (string | number)[] = [platform, problemId];
  const sql = `SELECT s.id, s.platform, s.submission_id, s.problem_id, s.problem_title, s.problem_url,
        s.difficulty, s.tags_json, s.status, s.raw_status, s.language,
        s.execution_time, s.memory, s.score, s.submitted_at, a.handle, u.name AS user_name
      FROM submissions s
      JOIN accounts a ON a.id = s.account_id
      JOIN users u ON u.id = a.user_id
      ${clause.sql ? `${clause.sql} AND ${extra.join(' AND ')}` : `WHERE ${extra.join(' AND ')}`}
      ORDER BY s.submitted_at ASC, s.id ASC`;
  const rows = db.prepare(sql).all(...clause.params, ...extraParams) as Record<string, unknown>[];
  return rows.map((row) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(String(row.tags_json ?? '[]'));
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = [];
    }
    return {
      id: Number(row.id),
      platform: String(row.platform),
      submission_id: String(row.submission_id),
      problem_id: String(row.problem_id),
      problem_title: String(row.problem_title),
      problem_url: row.problem_url === null ? null : String(row.problem_url),
      difficulty: row.difficulty === null ? null : Number(row.difficulty),
      tags,
      status: String(row.status),
      raw_status: row.raw_status === null ? null : String(row.raw_status),
      language: row.language === null ? null : String(row.language),
      execution_time: row.execution_time === null ? null : Number(row.execution_time),
      memory: row.memory === null ? null : Number(row.memory),
      score: row.score === null || row.score === undefined ? null : Number(row.score),
      submitted_at: Number(row.submitted_at),
      user_name: String(row.user_name),
      handle: String(row.handle),
    };
  });
}

export interface PlatformStat {
  platform: string;
  submissions: number;
  attempted: number;
  solved: number;
  active_days: number;
  last_at: number | null;
}

export interface StatusCount {
  status: string;
  count: number;
}

/**
 * 洛谷比赛内编号（`T…`）单列出来的数量。它们的提交已经计入 `submissions` / `active_days`，
 * 但**不计入 `attempted` / `solved`** —— 与同名的练习编号是同一道题。
 * 单独列出来是为了让「排除了多少」可见，而不是静默过滤。
 */
export interface ContestOnlyStat {
  submissions: number;
  problems: number;
  solved: number;
}

export interface Stats {
  submissions: number;
  attempted: number;
  solved: number;
  unsolved: number;
  active_days: number;
  platforms: number;
  accounts: number;
  first_at: number | null;
  last_at: number | null;
  by_platform: PlatformStat[];
  by_status: StatusCount[];
  contest_only: ContestOnlyStat;
  /** 得分 > 0 但未判 AC 的提交数（洛谷 status=14 的部分分）。其他平台不提供分数，恒为 0。 */
  partial_credit: number;
}

export function getStats(db: DatabaseSync, f: Filters): Stats {
  const clause = buildWhere(f);
  const tz = f.tzOffsetMinutes * 60;

  const total = db
    .prepare(
      `${baseCte(clause)}
       SELECT COUNT(*) AS submissions,
              COUNT(DISTINCT CASE WHEN ${PRACTICE_ONLY} THEN platform${SEP}problem_id END) AS attempted,
              COUNT(DISTINCT CASE WHEN ${PRACTICE_ONLY} AND status = 'AC' THEN platform${SEP}problem_id END) AS solved,
              COUNT(DISTINCT date(submitted_at + ?, 'unixepoch')) AS active_days,
              COUNT(DISTINCT platform) AS platforms,
              COUNT(DISTINCT account_id) AS accounts,
              MIN(submitted_at) AS first_at,
              MAX(submitted_at) AS last_at,
              COUNT(DISTINCT CASE WHEN ${CONTEST_SCOPED} THEN platform${SEP}problem_id END) AS contest_problems,
              COUNT(DISTINCT CASE WHEN ${CONTEST_SCOPED} AND status = 'AC' THEN platform${SEP}problem_id END) AS contest_solved,
              SUM(CASE WHEN ${CONTEST_SCOPED} THEN 1 ELSE 0 END) AS contest_submissions,
              SUM(CASE WHEN status <> 'AC' AND score IS NOT NULL AND score > 0 THEN 1 ELSE 0 END) AS partial_credit
       FROM f`,
    )
    .get(...clause.params, tz) as Record<string, unknown>;

  const byPlatform = db
    .prepare(
      `${baseCte(clause)}
       SELECT platform, COUNT(*) AS submissions,
              COUNT(DISTINCT CASE WHEN ${PRACTICE_ONLY} THEN problem_id END) AS attempted,
              COUNT(DISTINCT CASE WHEN ${PRACTICE_ONLY} AND status = 'AC' THEN problem_id END) AS solved,
              COUNT(DISTINCT date(submitted_at + ?, 'unixepoch')) AS active_days,
              MAX(submitted_at) AS last_at
       FROM f GROUP BY platform ORDER BY submissions DESC, platform ASC`,
    )
    .all(...clause.params, tz) as Record<string, unknown>[];

  const byStatus = db
    .prepare(`${baseCte(clause)} SELECT status, COUNT(*) AS c FROM f GROUP BY status ORDER BY c DESC, status ASC`)
    .all(...clause.params) as Record<string, unknown>[];

  const attempted = Number(total.attempted ?? 0);
  const solved = Number(total.solved ?? 0);
  return {
    submissions: Number(total.submissions ?? 0),
    attempted,
    solved,
    unsolved: attempted - solved,
    active_days: Number(total.active_days ?? 0),
    platforms: Number(total.platforms ?? 0),
    accounts: Number(total.accounts ?? 0),
    first_at: total.first_at === null ? null : Number(total.first_at),
    last_at: total.last_at === null ? null : Number(total.last_at),
    by_platform: byPlatform.map((row) => ({
      platform: String(row.platform),
      submissions: Number(row.submissions),
      attempted: Number(row.attempted),
      solved: Number(row.solved),
      active_days: Number(row.active_days),
      last_at: row.last_at === null ? null : Number(row.last_at),
    })),
    by_status: byStatus.map((row) => ({ status: String(row.status), count: Number(row.c) })),
    contest_only: {
      submissions: Number(total.contest_submissions ?? 0),
      problems: Number(total.contest_problems ?? 0),
      solved: Number(total.contest_solved ?? 0),
    },
    partial_credit: Number(total.partial_credit ?? 0),
  };
}

export interface AccountMeta {
  is_archived: boolean;
  id: number;
  user_id: number;
  user_name: string;
  is_self: boolean;
  platform: string;
  handle: string;
  display_name: string | null;
  stored_submissions: number;
  /** 计入题目口径的 AC 题数（已排除洛谷比赛内编号）。 */
  stored_solved: number;
  /** 该账号被排除在题目口径之外的洛谷比赛内编号数量，供界面标注。 */
  stored_contest_problems: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  history_complete: boolean;
  coverage: unknown;
}

export interface Meta {
  dbPath: string;
  generatedAt: number;
  users: { id: number; name: string; is_self: boolean; is_followed: boolean; account_count: number }[];
  accounts: AccountMeta[];
  platforms_present: { platform: string; submissions: number }[];
  problems: { attempted: number; solved: number };
}

export function getMeta(db: DatabaseSync, dbPath: string, knownPlatforms: readonly string[], scope: Scope = 'all'): Meta {
  const where = SCOPE_SQL[scope];
  /**
   * 把范围判断隔离在子查询里，**不 JOIN 进外层**。
   *
   * 原因：外层的题目口径常量（`PRACTICE_ONLY`）是从 `problem-scope.ts` 引过来的裸列名片段，
   * 不带表别名；一旦 JOIN 进 `accounts` / `users`，`platform` 就在两张表里都存在，
   * SQLite 会直接报 `ambiguous column name`。子查询让外层仍然只有 submissions 一张表。
   */
  const scopeIds = `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.is_archived = 0 AND ${where}`;
  // 本人排最前，其余按加入顺序 —— 「我」是主视图的锚点，不该混在列表中间。
  const users = db
    .prepare(
      `SELECT u.id, u.name, u.is_self, u.is_followed,
              (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id AND a.is_archived = 0) AS account_count
       FROM users u ORDER BY u.is_self DESC, u.id`,
    )
    .all() as Record<string, unknown>[];

  const accounts = db
    .prepare(
      `SELECT a.id, a.user_id, u.name AS user_name, u.is_self, a.platform, a.handle, a.display_name, a.is_archived,
              (SELECT COUNT(*) FROM submissions WHERE account_id = a.id) AS stored_submissions,
              (SELECT COUNT(DISTINCT problem_id) FROM submissions
                 WHERE account_id = a.id AND status = 'AC' AND ${PRACTICE_ONLY}) AS stored_solved,
              (SELECT COUNT(DISTINCT problem_id) FROM submissions
                 WHERE account_id = a.id AND ${CONTEST_SCOPED} ) AS stored_contest_problems,
              ss.last_attempt_at, ss.last_success_at, ss.last_error, ss.history_complete, ss.coverage_json
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN sync_state ss ON ss.account_id = a.id
       ORDER BY a.id`,
    )
    .all() as Record<string, unknown>[];

  const present = db
    .prepare(
      `SELECT s.platform, COUNT(*) AS c,
              COUNT(DISTINCT s.problem_id) AS attempted,
              COUNT(DISTINCT CASE WHEN s.status = 'AC' THEN s.problem_id END) AS solved
       FROM submissions s
       WHERE s.account_id IN (${scopeIds})
       GROUP BY s.platform ORDER BY c DESC`,
    )
    .all() as Record<string, unknown>[];

  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN ${PRACTICE_ONLY} THEN s.platform${SEP}s.problem_id END) AS attempted,
              COUNT(DISTINCT CASE WHEN ${PRACTICE_ONLY} AND s.status = 'AC' THEN s.platform${SEP}s.problem_id END) AS solved
       FROM submissions s
       WHERE s.account_id IN (${scopeIds})`,
    )
    .get() as Record<string, unknown>;

  const rank = new Map(knownPlatforms.map((p, i) => [p, i]));
  const platformsPresent = present
    .map((row) => ({ platform: String(row.platform), submissions: Number(row.c) }))
    .sort((a, b) => (rank.get(a.platform) ?? 99) - (rank.get(b.platform) ?? 99) || a.platform.localeCompare(b.platform));

  return {
    dbPath,
    generatedAt: Math.floor(Date.now() / 1000),
    users: users.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      is_self: Number(row.is_self) === 1,
      is_followed: Number(row.is_followed ?? 1) === 1,
      account_count: Number(row.account_count),
    })),
    accounts: accounts.map((row) => ({
      is_archived: Number(row.is_archived) === 1,
      id: Number(row.id),
      user_id: Number(row.user_id),
      user_name: String(row.user_name),
      is_self: Number(row.is_self) === 1,
      platform: String(row.platform),
      handle: String(row.handle),
      display_name: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
      stored_submissions: Number(row.stored_submissions),
      stored_solved: Number(row.stored_solved),
      stored_contest_problems: Number(row.stored_contest_problems ?? 0),
      last_attempt_at: row.last_attempt_at === null ? null : Number(row.last_attempt_at),
      last_success_at: row.last_success_at === null ? null : Number(row.last_success_at),
      last_error: row.last_error === null ? null : String(row.last_error),
      history_complete: Number(row.history_complete ?? 0) === 1,
      coverage: parseJsonOrNull(row.coverage_json),
    })),
    platforms_present: platformsPresent,
    problems: {
      attempted: Number(totals.attempted ?? 0),
      solved: Number(totals.solved ?? 0),
    },
  };
}

function parseJsonOrNull(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/* ---------- DX Rating ---------- */

export interface DxEntryRow {
  canonicalProblemId: string;
  sourceProblemId: string | null;
  sourceProblemUrl: string | null;
  problemId: string;
  problemTitle: string;
  problemUrl: string | null;
  /** CF 题目 Rating，即 DX 口径里的「定数」。可能为 NULL（老题或未发布难度）。 */
  problemRating: number | null;
  /** 该题**最早**一次 AC 的时间（UTC 秒）。只用于排序与显示。 */
  solvedAt: number;
  /**
   * **出题日期** = 原题所属比赛的开始时间（UTC 秒）。Group 副本只用已确认来源的时间。
   * b35 / b15 的分板看的是它，不是 AC 时间 —— 2026 年切掉一道 2013 年的老题，
   * 它仍然进旧题区。查不到（比赛不在 `contests` 表里，例如 gym）时为 null。
   */
  releasedAt: number | null;
  /** 用户填写的完成用时（秒）；没填就是 null。 */
  recordedSeconds: number | null;
}

/**
 * 列出某用户在某平台上 AC 过的全部题目，并带上他填写的完成用时与题目的出题日期。
 *
 * 只取**最早**一次 AC 作为 `solvedAt`：重复 AC 不改变「这题是什么时候做的」，
 * 列表按它倒序，同一道题不该跳来跳去。
 *
 * 题目 Rating 取该题所有提交中非空的 `difficulty`（CF 是官方数字）——
 * 同一题的不同提交理论上同值，用 MAX 只是为了在混合 NULL 时稳定取到那个非空值。
 *
 * 普通题的出题日期来自 `contests`；Group 副本来自已确认的原题，不使用训练赛日期。
 * 普通 problem_id 形如 `339:A`，`:` 前那一段就是比赛 id，
 * 联上比赛开始时间即可。`instr` 找不到 `:` 时 `substr` 会得到空串、`CAST` 成 0，
 * 匹配不到任何比赛 → NULL，不会误判成 1970 年。
 */
export function listDxEntries(db: DatabaseSync, userId: number, platform: string): DxEntryRow[] {
  const rows = db
    .prepare(
      `SELECT s.problem_id,
              MAX(CASE WHEN s.platform='codeforces' AND s.problem_url LIKE 'https://codeforces.com/group/%' AND gs.method IN ('content','user_confirmed') THEN gs.source_problem_id ELSE s.problem_id END) AS canonical_problem_id,
              MAX(CASE WHEN s.problem_url LIKE 'https://codeforces.com/group/%' AND gs.method IN ('content','user_confirmed') THEN gs.source_problem_id END) AS source_problem_id,
              MAX(CASE WHEN s.problem_url LIKE 'https://codeforces.com/group/%' AND gs.method IN ('content','user_confirmed') THEN gs.source_url END) AS source_url,
              MAX(s.problem_title) AS problem_title,
              MAX(s.problem_url)   AS problem_url,
              MAX(s.difficulty)    AS difficulty,
              MIN(s.submitted_at)  AS solved_at,
              MAX(CASE WHEN s.platform='codeforces' AND s.problem_url LIKE 'https://codeforces.com/group/%'
                THEN CASE WHEN gs.method IN ('content','user_confirmed') THEN gs.source_released_at END
                ELSE c.start_time END) AS released_at,
              MAX(pt.seconds)      AS recorded_seconds
       FROM submissions s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN cf_group_rating_sources gs ON s.platform='codeforces' AND gs.problem_id=s.problem_id
       LEFT JOIN contests c
              ON c.platform = s.platform
             AND c.contest_id = CAST(substr(s.problem_id, 1, instr(s.problem_id, ':') - 1) AS INTEGER)
       LEFT JOIN problem_times pt
              ON pt.user_id = a.user_id AND pt.platform = s.platform AND pt.problem_id = s.problem_id
       WHERE a.is_archived = 0 AND a.user_id = ? AND s.platform = ? AND s.status = 'AC'
       GROUP BY s.problem_id
       ORDER BY solved_at DESC`,
    )
    .all(userId, platform) as Record<string, unknown>[];
  return rows.map((row) => ({
    problemId: String(row.problem_id),
    canonicalProblemId: String(row.canonical_problem_id ?? row.problem_id),
    sourceProblemId: row.source_problem_id == null ? null : String(row.source_problem_id),
    sourceProblemUrl: row.source_url == null ? null : String(row.source_url),
    problemTitle: String(row.problem_title ?? ''),
    problemUrl: row.problem_url === null || row.problem_url === undefined ? null : String(row.problem_url),
    problemRating: row.difficulty === null || row.difficulty === undefined ? null : Number(row.difficulty),
    solvedAt: Number(row.solved_at),
    releasedAt: row.released_at === null || row.released_at === undefined ? null : Number(row.released_at),
    recordedSeconds: row.recorded_seconds === null || row.recorded_seconds === undefined ? null : Number(row.recorded_seconds),
  }));
}

/**
 * 「比赛自动计时」的原料：某用户在某平台上、落在比赛窗口
 * [start_time, start_time + duration_seconds) 内的**全部**提交（含 WA）。
 *
 * 只取 duration 已知的比赛 —— 窗口右端必须卡死，否则赛后再做的提交会以
 * 「距开赛好几天」的身份混进来，减法就全成了垃圾值。这条口径与 `listProblems`
 * 的 `fastr` CTE 完全一致，纯耗时算法在 `computeContestAutoSeconds`（纯函数）。
 */
export function listContestTimeline(db: DatabaseSync, userId: number, platform: string): ContestTimelineRow[] {
  const rows = db
    .prepare(
      `SELECT s.problem_id, s.submitted_at, s.status,
              c.start_time, c.duration_seconds
       FROM submissions s
       JOIN accounts a ON a.id = s.account_id
       JOIN contests c
              ON c.platform = s.platform
             AND c.contest_id = CAST(substr(s.problem_id, 1, instr(s.problem_id, ':') - 1) AS INTEGER)
       WHERE a.is_archived = 0 AND a.user_id = ? AND s.platform = ?
         AND c.duration_seconds IS NOT NULL
         AND s.submitted_at >= c.start_time
         AND s.submitted_at < c.start_time + c.duration_seconds
       ORDER BY s.submitted_at ASC, s.id ASC`,
    )
    .all(userId, platform) as Record<string, unknown>[];
  return rows.map((row) => ({
    problemId: String(row.problem_id),
    submittedAt: Number(row.submitted_at),
    status: String(row.status),
    contestStart: Number(row.start_time),
    contestDuration: Number(row.duration_seconds),
  }));
}
