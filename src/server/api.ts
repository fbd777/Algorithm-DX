import { randomBytes } from 'node:crypto';
import { cfExtensionBridge } from '../fetchers/cf-extension.ts';
import { openCfBrowser } from '../fetchers/cf-browser.ts';
import { acquireSyncLock } from '../sync/lock.ts';
import { parseGroupLinks } from '../fetchers/codeforces-group.ts';
import { importMatiji } from '../matiji-import.ts';
import { MatijiLiveFetcher } from '../fetchers/matiji-live.ts';
import { resolveMatijiIdentity } from '../fetchers/matiji-identity.ts';
import { HttpClient } from '../fetchers/http.ts';
/**
 * Dashboard 的 JSON API。
 *
 * 分成两类，边界很清楚：
 * - **读**（GET）：只碰 `ctx.db`，那条连接是 `PRAGMA query_only = ON` 打开的，连误写都不可能。
 * - **写**（POST）：只走 `ctx.openWrite()` 拿到的读写连接，且必须先通过 server.ts 的同源校验。
 *
 * 所以「面板能改数据」这件事的范围是可枚举的：下面 WRITE_ROUTES 里那几个。
 * 没有任意 SQL 入口，没有路径拼接的表名。
 */
import type { DatabaseSync } from 'node:sqlite';
import { getAnalytics } from './analytics.ts';
import { getToday } from './today.ts';
import { getCircle } from './circle.ts';
import {
  DEFAULT_TZ_OFFSET_MINUTES,
  getMeta,
  getStats,
  listContestTimeline,
  listDxEntries,
  listProblemSubmissions,
  listProblems,
  type Filters,
  type Scope,
  type StatusFilter,
} from './queries.ts';
import { credentialKey, credentialPlatforms, historyCapability, missingPrerequisite } from '../fetchers/registry.ts';
import { assertSafeEnvValue, upsertEnvVars, envFor, isEnvVarSet } from '../credentials.ts';
import {
  AdminError,
  bindAccount,
  createUser,
  removeUser,
  renameAccount,
  replaceAccount,
  setFollowed,
  unbindAccount,
  type AdminErrorCode,
} from '../account-admin.ts';
import {
  DX_PLATFORM,
  NEW_SLOTS,
  OLD_SLOTS,
  buildBoard,
  buildPending,
  buildRankTimeTable,
  computeContestAutoSeconds,
  curveInfo,
  factorFromAchievement,
  scoreProblem,
  PROBLEM_RATING_DIVISOR,
} from '../dx/rating.ts';
import {
  DxTimeError,
  MAX_SECONDS,
  MIN_SECONDS,
  clearProblemTime,
  setProblemTime,
  type DxTimeErrorCode,
} from '../dx-admin.ts';
import type { SyncJobRunner, SyncJobState } from './sync-job.ts';
import { listPractice, recordPractice, editPractice, voidPractice, type PracticeInput } from '../dx/practice.ts';
import { localBacktestReport } from '../dx/backtest.ts';
import { startTimer, timerState, cancelTimer, reconcileTimers } from '../dx/timer.ts';
import { dismissedProblems, reminderGroup, REMINDER_DAYS, setTimeReminder } from '../dx/reminders.ts';

export interface ApiContext {
  db: DatabaseSync;
  dbPath: string;
  platforms: readonly string[];
  /** 写入凭据用的 .env 路径。 */
  envFile: string;
  /** 惰性打开的读写连接。读端点永远不该调用它。 */
  openWrite: () => DatabaseSync;
  syncJobs: SyncJobRunner;
}

export interface ApiRequest {
  method: string;
  pathname: string;
  params: URLSearchParams;
  /** 已解析的 JSON 请求体；写端点用。 */
  body?: unknown;
}

export interface ApiResult {
  status: number;
  body: unknown;
  downloadName?: string;
}

const MAX_PLATFORMS = 20;

class BadRequest extends Error {}
class Conflict extends Error {}

/**
 * 已经有同步在跑。
 *
 * 关键是**把正在跑的那个任务一起送回前端**：它多半就是使用者的另一次点击
 * （首页的全平台同步还没跑完，又切到 DX 页点了同步）。这时候让人「等一会儿再点」
 * 等于把一个内部状态推给人去猜 —— 拿到 job.id 前端就能跟着它跑到完。
 */
class SyncConflict extends Error {
  job: SyncJobState;
  constructor(job: SyncJobState) {
    super('已经有一个同步任务在跑了，正在跟着它跑到结束');
    this.job = job;
  }
}

/** 写端点清单。server.ts 用它判断是否需要同源校验，也让「能改什么」一眼可查。 */
export const WRITE_ROUTES = new Set([
  '/api/accounts/cf-groups',
  '/api/accounts/cf-browser',
  '/api/cf-extension/pair',
  '/api/import/matiji',
  '/api/accounts/matiji/identity',
  '/api/users',
  '/api/users/remove',
  '/api/accounts',
  '/api/accounts/unbind',
  '/api/accounts/rename',
  '/api/accounts/replace',
  '/api/users/follow',
  '/api/sync',
  '/api/sync/cancel',
  '/api/dx/time',
  '/api/dx/time/clear',
  '/api/dx/attempts',
  '/api/dx/reminder',
  '/api/dx/timer/start',
  '/api/dx/timer/cancel',
  '/api/dx/timer/check',
  '/api/dx/attempts/void',
  '/api/dx/attempts/edit',
]);

const ADMIN_MESSAGES: Record<AdminErrorCode, string> = {
  IDENTITY_CONFIRM_REQUIRED: '请确认这是同一平台账号改名；更换账号请使用换绑',
  STABLE_ID: '数字用户 ID 不能改名，请使用换绑账号',
  ACCOUNT_ARCHIVED: '账号已归档，不能重新绑定或修改',
  SYNC_BUSY: '正在同步，请等同步结束后再操作',
  USER_NOT_FOUND: '指定的用户不存在，请先创建该用户',
  USER_NAME_INVALID: '用户名需要 1 到 40 个字符',
  SELF_ALREADY_SET: '已经有一个标记为「我」的用户了，不能重复设置',
  CREDENTIAL_NOT_APPLICABLE: '该平台不需要登录凭据',
  CREDENTIAL_INVALID: '凭据里不能有引号、反斜杠或换行',
  PLATFORM_UNKNOWN: '不认识的平台',
  HANDLE_INVALID: '账号标识格式不对：洛谷和牛客要填数字 ID，不能填昵称',
  ACCOUNT_EXISTS: '这个账号已经绑定过了',
  ACCOUNT_OWNED_BY_OTHER: '这个 handle 已经绑在另一个用户名下；同一平台一个 handle 只能绑一次',
  ACCOUNT_NOT_FOUND: '账号不存在，可能已被解绑',
  ACCOUNT_NOT_ON_PLATFORM: '平台上查不到这个账号，多半是标识填错了',
  HANDLE_TAKEN: '这个标识已绑定或已归档，请检查账号列表',
  SELF_CANNOT_UNFOLLOW: '本人不能取消关注 —— 自己是主视图的锚点',
  USER_MISSING: '用户不存在，可能已被删除',
};

const ADMIN_STATUS: Record<AdminErrorCode, number> = {
  IDENTITY_CONFIRM_REQUIRED: 400, STABLE_ID: 400, ACCOUNT_ARCHIVED: 409, SYNC_BUSY: 409,
  USER_NOT_FOUND: 400,
  USER_NAME_INVALID: 400,
  SELF_ALREADY_SET: 409,
  CREDENTIAL_NOT_APPLICABLE: 400,
  CREDENTIAL_INVALID: 400,
  PLATFORM_UNKNOWN: 400,
  HANDLE_INVALID: 400,
  ACCOUNT_EXISTS: 409,
  ACCOUNT_OWNED_BY_OTHER: 409,
  ACCOUNT_NOT_FOUND: 404,
  // 平台上查不到这个人 —— 是客户端填错了标识，不是服务端出错，所以仍是 400。
  ACCOUNT_NOT_ON_PLATFORM: 400,
  HANDLE_TAKEN: 409,
  SELF_CANNOT_UNFOLLOW: 409,
  USER_MISSING: 404,
};

/** 填写完成用时失败的文案与状态码。与账号那套分开，两边的失败原因完全不同。 */
const DX_TIME_MESSAGES: Record<DxTimeErrorCode, string> = {
  USER_NOT_FOUND: '指定的用户不存在',
  PLATFORM_UNSUPPORTED: '目前只有 Codeforces 的题目计入 DX Rating',
  PROBLEM_NOT_SOLVED: '这道题还没有 AC 记录，不能填用时',
  TIME_INVALID: `用时必须是 ${MIN_SECONDS} 秒到 ${MAX_SECONDS / 3600} 小时之间的整数`,
};

const DX_TIME_STATUS: Record<DxTimeErrorCode, number> = {
  USER_NOT_FOUND: 404,
  PLATFORM_UNSUPPORTED: 400,
  PROBLEM_NOT_SOLVED: 400,
  TIME_INVALID: 400,
};

/* ---------- 参数解析 ---------- */

function clampInt(value: string | null, fallback: number, min: number, max: number, label: string): number {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new BadRequest(`${label} 必须是整数`);
  return Math.min(max, Math.max(min, n));
}

function parseIntOrNull(value: string | null, min: number, max: number, label: string): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new BadRequest(`${label} 必须是整数`);
  if (n < min || n > max) throw new BadRequest(`${label} 超出允许范围`);
  return n;
}

function parseFilters(params: URLSearchParams, ctx: ApiContext): Filters {
  const rawPlatforms = params.getAll('platform').flatMap((v) => v.split(','));
  const platforms: string[] = [];
  for (const raw of rawPlatforms) {
    const name = raw.trim();
    if (!name) continue;
    if (!ctx.platforms.includes(name)) throw new BadRequest(`未知平台：${name}`);
    if (!platforms.includes(name)) platforms.push(name);
  }
  if (platforms.length > MAX_PLATFORMS) throw new BadRequest('筛选的平台过多');

  const rawUser = params.get('user');
  const userId = rawUser === null || rawUser === '' || rawUser === 'all' ? null : parseIntOrNull(rawUser, 1, Number.MAX_SAFE_INTEGER, 'user');

  const scope = parseScope(params);

  const rawStatus = (params.get('status') ?? 'all').trim();
  if (rawStatus !== 'all' && rawStatus !== 'ac' && rawStatus !== 'unac') throw new BadRequest('status 必须是 all / ac / unac');
  const status = rawStatus as StatusFilter;

  const rawQ = params.get('q');
  const q = rawQ && rawQ.trim() ? rawQ.trim().slice(0, 120) : null;

  const tzOffsetMinutes = clampInt(params.get('tz'), DEFAULT_TZ_OFFSET_MINUTES, -840, 840, 'tz');

  let since = parseIntOrNull(params.get('since'), 0, 4_102_444_800, 'since');
  let until = parseIntOrNull(params.get('until'), 0, 4_102_444_800, 'until');
  if (since !== null && until !== null && since > until) [since, until] = [until, since];

  return { platforms, userId, scope, status, q, since, until, tzOffsetMinutes };
}

/**
 * 读范围参数。默认 `all`（我 + 我关注的人）—— 建了人就是要看他，
 * 而「取消关注」是显式动作，不该因为 URL 里少一个参数就退回「只看我」。
 */
function parseScope(params: URLSearchParams): Scope {
  const raw = (params.get('scope') ?? 'all').trim();
  if (raw !== 'me' && raw !== 'all') throw new BadRequest('scope 必须是 me / all');
  return raw;
}

/* ---------- 读端点 ---------- */

/** 各平台凭据配置情况。只回报「配了没有」，凭据本身不进响应体。 */
function credentials(envFile: string) {
  return credentialPlatforms.map((platform) => {
    const variable = credentialKey(platform);
    return { platform, variable, configured: isEnvVarSet(envFile, variable) };
  });
}

function meta(ctx: ApiContext, params: URLSearchParams): ApiResult {
  // 总览里的「题目总数 / 平台分布」也要跟着范围走，否则会出现
  // 「提交流里没有这个人、总数却把他算进去了」。
  const base = getMeta(ctx.db, ctx.dbPath, ctx.platforms, parseScope(params));
  // 与同步用的是同一份环境（以 .env 为准），否则会出现「徽标说配了、同步说没配」。
  const env = envFor(ctx.envFile);
  return {
    status: 200,
    body: {
      ...base,
      // 每个账号缺哪个前置条件；齐了是 null。
      // 注意这是「当前环境就绪情况」，不是「上一次抓取结果」——所以它不需要跑一次同步才会更新，
      // 在面板里填好凭据后立刻就会变成 null。
      accounts: base.accounts.map((account) => ({ ...account, cfGroupMode: account.platform === 'codeforces' ? (['api','browser'].includes(env['ALGO_CF_GROUP_MODE_'+account.id]??'')?env['ALGO_CF_GROUP_MODE_'+account.id]:'extension') : undefined, cfGroups: account.platform === 'codeforces' ? (env['ALGO_CF_GROUPS_'+account.id]??'').split(';').filter(Boolean) : undefined, cfAuthorized: account.platform === 'codeforces' ? Boolean(env.ALGO_CF_API_KEY && env.ALGO_CF_API_SECRET) : undefined, retired: !ctx.platforms.includes(account.platform),
        history: account.platform === 'matiji' && env[`ALGO_MATIJI_SNAPSHOT_${account.id}`]
          ? { supported: false, detail: '正在使用旧快照配置；切换网络同步需移除此配置并设置登录' } : historyCapability(account.platform),
        prerequisite: missingPrerequisite(env, account),
        historyPrerequisite: missingPrerequisite(env, account, 'backfill') })),
      // 面板要靠这份清单决定「凭据输入框要不要显示」以及「已配置」徽标，
      // 免得前端再维护一份「哪些平台要登录」的副本。
      credentialPlatforms: [...credentialPlatforms],
      credentials: credentials(ctx.envFile),
    },
  };
}

function stats(ctx: ApiContext, params: URLSearchParams): ApiResult {
  const filters = parseFilters(params, ctx);
  return { status: 200, body: { filters: describe(filters), stats: getStats(ctx.db, filters), analytics: getAnalytics(ctx.db, filters), today: getToday(ctx.db, filters) } };
}

function feed(ctx: ApiContext, params: URLSearchParams): ApiResult {
  const filters = parseFilters(params, ctx);
  const limit = clampInt(params.get('limit'), 24, 1, 200, 'limit');
  const offset = clampInt(params.get('offset'), 0, 0, 1_000_000, 'offset');
  const page = listProblems(ctx.db, filters, limit, offset);
  return {
    status: 200,
    body: {
      filters: describe(filters),
      limit,
      offset,
      total: page.total,
      hasMore: offset + page.items.length < page.total,
      items: page.items,
    },
  };
}

function problemDetail(ctx: ApiContext, params: URLSearchParams): ApiResult {
  const platform = (params.get('platform') ?? '').trim();
  const problemId = (params.get('problemId') ?? '').trim();
  if (!platform || !problemId) throw new BadRequest('需要 platform 与 problemId');
  if (!ctx.platforms.includes(platform)) throw new BadRequest(`未知平台：${platform}`);
  if (problemId.length > 200) throw new BadRequest('problemId 过长');
  const filters = parseFilters(params, ctx);
  const items = listProblemSubmissions(ctx.db, filters, platform, problemId);
  return { status: 200, body: { filters: describe(filters), platform, problemId, total: items.length, items } };
}

function syncStatus(ctx: ApiContext): ApiResult {
  const job = ctx.syncJobs.state();
  // 顺带把库里最近几次同步记录带上：页面刷新后任务状态没了，也能看到上次跑成什么样。
  const runs = ctx.db
    .prepare(
      `SELECT r.id, r.account_id, a.platform, a.handle, r.status, r.mode, r.started_at, r.finished_at,
              r.fetched, r.inserted, r.error_code, r.message
       FROM sync_runs r JOIN accounts a ON a.id = r.account_id
       ORDER BY r.id DESC LIMIT 10`,
    )
    .all();
  return { status: 200, body: { job, runs, revision: ctx.syncJobs.revision(), nextAutoAt: ctx.syncJobs.autoAvailableAt() } };
}

/* ---------- 写端点 ---------- */

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('请求体必须是 JSON 对象');
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string, max: number, required = true): string {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (required) throw new BadRequest(`缺少字段：${key}`);
    return '';
  }
  if (typeof raw !== 'string') throw new BadRequest(`字段 ${key} 必须是字符串`);
  const value = raw.trim();
  if (required && !value) throw new BadRequest(`字段 ${key} 不能为空`);
  if (value.length > max) throw new BadRequest(`字段 ${key} 过长（最多 ${max} 字符）`);
  return value;
}

function positiveInt(body: Record<string, unknown>, key: string): number {
  const raw = body[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new BadRequest(`字段 ${key} 必须是正整数`);
  return n;
}

/** 删改类操作必须显式确认：外键级联会连带删掉提交记录与同步历史。 */
function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw new BadRequest('这是不可逆操作：需要显式确认（confirm: true）');
}

async function bind(ctx: ApiContext, body: unknown): Promise<ApiResult> {
  const input = objectBody(body);
  const platform = text(input, 'platform', 32);
  const cookie = text(input, 'cookie', 4096, false);
  let handle = text(input, 'handle', platform === 'matiji' ? 512 : 120, platform !== 'matiji');
  let identity: { handle: string; displayName: string | null } | null = null;
  if (platform === 'matiji') {
    const savedCookie = cookie || envFor(ctx.envFile).ALGO_COOKIE_MATIJI;
    let safeCookie: string | undefined;
    try { safeCookie = savedCookie ? assertSafeEnvValue('ALGO_COOKIE_MATIJI', savedCookie) : undefined; }
    catch (error) { throw new AdminError('CREDENTIAL_INVALID', error instanceof Error ? error.message : 'Invalid credential'); }
    try {
      identity = await resolveMatijiIdentity(handle, new HttpClient(ctx.openWrite()), safeCookie);
      handle = identity.handle;
    } catch (error) { throw new BadRequest(error instanceof Error ? error.message : '码蹄集账号识别失败，请稍后重试'); }
  }
  const outcome = await bindAccount(ctx.openWrite(), {
    userId: positiveInt(input, 'userId'),
    platform,
    handle,
    // 凭据留空就只绑账号 —— 面板上那个框本来就可以不填。
    cookie: cookie || null,
    envFile: ctx.envFile,
    // 面板点「绑定」时已绑定列表就在旁边，复用是明确意图而不是误操作。
    reuseExisting: true,
    // 面板可以显式关掉探测（`probe: false`），离线或明知查不到时用它。
    probe: input.probe !== false,
  });
  if (identity?.displayName) {
    ctx.openWrite().prepare('UPDATE accounts SET display_name=? WHERE id=?').run(identity.displayName, outcome.id);
    outcome.displayName = identity.displayName;
    outcome.probe = { status: 'found', displayName: identity.displayName };
  }
  return { status: outcome.existing ? 200 : 201, body: { ...outcome, handle, credentials: credentials(ctx.envFile) } };
}

function unbind(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  requireConfirm(input);
  return { status: 200, body: unbindAccount(ctx.openWrite(), positiveInt(input, 'id')) };
}

/**
 * 改账号标识 —— 历史**原样保留**（提交按 account_id 关联，不按 handle）。
 *
 * 不需要 confirm：它是可逆的，而且不删任何东西。把它做成低成本操作，
 * 正是为了让人不必为了改一个字符去走「解绑 → 重绑」那条会清空历史的路。
 */
function rename(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  return {
    status: 200,
    body: renameAccount(ctx.openWrite(), positiveInt(input, 'id'), text(input, 'handle', 120), input.sameIdentity === true),
  };
}

/** 切换关注。取消关注只是不显示，不删任何数据 —— 所以也不需要 confirm。 */
function follow(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  return { status: 200, body: setFollowed(ctx.openWrite(), positiveInt(input, 'id'), input.followed === true) };
}

function addUser(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  const id = createUser(ctx.openWrite(), text(input, 'name', 40), input.isSelf === true);
  return { status: 201, body: { id } };
}

function dropUser(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  requireConfirm(input);
  return { status: 200, body: removeUser(ctx.openWrite(), positiveInt(input, 'id')) };
}

function startSync(ctx: ApiContext, body: unknown): ApiResult {
  const input = body === undefined ? {} : objectBody(body);
  const accountId = input.accountId === undefined || input.accountId === null ? null : positiveInt(input, 'accountId');
  const mode = input.mode === undefined ? 'recent' : text(input, 'mode', 16);
  if (mode !== 'recent' && mode !== 'backfill') throw new BadRequest('mode 必须是 recent 或 backfill');
  if (accountId !== null && !ctx.db.prepare('SELECT id FROM accounts WHERE id=? AND is_archived=0').get(accountId)) {
    throw new BadRequest('账号不存在');
  }
  let job: SyncJobState;
  try {
    job = ctx.syncJobs.start({ accountId, mode, force: input.force === true, automatic: input.automatic === true && mode === 'recent' });
  } catch (error) {
    if (error instanceof Error && error.message === 'AUTO_COOLDOWN') return { status: 200, body: { job: ctx.syncJobs.state(), throttled: true, nextAutoAt: ctx.syncJobs.autoAvailableAt() } };
    const running = ctx.syncJobs.state();
    if (running?.running) throw new SyncConflict(running);
    throw new Conflict('已经有一个同步任务在跑了，等它结束再开始');
  }
  return { status: 202, body: { job } };
}

function describe(f: Filters) {
  return {
    platforms: f.platforms,
    user: f.userId,
    scope: f.scope,
    status: f.status,
    q: f.q,
    since: f.since,
    until: f.until,
    tzOffsetMinutes: f.tzOffsetMinutes,
  };
}

/* ---------- DX Rating ---------- */

/** 本年度起点：**本地时区**的 1 月 1 日 0 点（UTC 秒）。跨年换季的边界按本地日历走。 */
function yearStartSeconds(year: number): number {
  return Math.floor(new Date(year, 0, 1, 0, 0, 0, 0).getTime() / 1000);
}

/**
 * DX 榜。
 *
 * 四条口径都在服务端定死，前端不做任何筛选：
 *  1. 只有 Codeforces 的题；
 *  2. 只有 AC 过的题；
 *  3. **只有填过完成用时的题才进榜** —— 没填的不算 0 分，是不存在；
 *  4. 旧题 / 新题按**出题日期**分（`releasedAt` = 比赛开始时间），与 AC 时间无关。
 */
function dx(ctx: ApiContext, params: URLSearchParams): ApiResult {
  const userId = parseIntOrNull(params.get('user'), 1, Number.MAX_SAFE_INTEGER, 'user');
  if (userId === null) throw new BadRequest('缺少 user 参数');
  const year = clampInt(params.get('year'), new Date().getFullYear(), 2000, 3000, 'year');
  const since = yearStartSeconds(year);

  const entries = listDxEntries(ctx.db, userId, DX_PLATFORM);
  const until = yearStartSeconds(year + 1);
  const eligible = entries.filter(e => e.releasedAt === null || e.releasedAt < until);
  const board = buildBoard(eligible, since);
  const selected = new Set([...board.old, ...board.current].flatMap(s => s.entry ? [s.entry.problemId] : []));
  const recorded = entries.filter(e => e.recordedSeconds !== null).map(e => ({
    ...e,
    score: scoreProblem(e),
    state: e.releasedAt !== null && e.releasedAt >= until ? 'outsideYear'
      : e.problemRating === null ? 'waitingRating' : selected.has(e.problemId) ? 'onBoard' : 'belowCutoff',
  }));
  // 待填写清单的口径与排序都在 buildPending 里（没填用时的题都收，含未评定的；
  // 未评定的填完等评级回填后自动进榜）。按 AC 时间倒序。
  // 「比赛计时」按钮的值在这里覆盖：时间轴（窗口内全部提交）→ 纯函数算纯耗时 →
  // 逐题挂到待填写行上。算不出（练习解 / 跳题穿插 / duration 缺失）就是 null。
  const autoSeconds = computeContestAutoSeconds(listContestTimeline(ctx.db, userId, DX_PLATFORM));
  const dismissed = dismissedProblems(ctx.db, userId);
  const reminderNow = Math.floor(Date.now()/1000);
  const pending = buildPending(entries, since).map((p) => ({
    ...p,
    reminderGroup: reminderGroup(p.solvedAt, dismissed.has(p.problemId), reminderNow),
    autoSeconds: autoSeconds.get(p.problemId) ?? null,
    outsideYear: p.releasedAt !== null && p.releasedAt >= until,
    isCurrent: p.isCurrent && p.releasedAt !== null && p.releasedAt < until,
  }));
  // 出题日期缺失的数量。它意味着这些题进不了 b15（按旧题处理），必须让人看得见：
  // 常见原因是还没同步过（`contests` 表为空），点一次「同步最新数据」就会补上。
  const unknownRelease = entries.filter((e) => e.problemRating !== null && e.releasedAt === null).length;

  return {
    status: 200,
    body: {
      user: userId,
      platform: DX_PLATFORM,
      year,
      yearStart: since,
      yearEnd: until,
      recorded,
      scoring: { divisor: PROBLEM_RATING_DIVISOR, atT97: factorFromAchievement(97), atSSSPlus: factorFromAchievement(100.5) },
      // 年度下拉的选项：本年度 + 已 AC 题目**出题**年份，新的在前。
      // 用出题年份而不是 AC 年份 —— 选 2024 年问的是「2024 年出的题里我拿了多少」。
      years: [
        ...new Set([
          year,
          new Date().getFullYear(),
          ...entries.flatMap((e) => (e.releasedAt === null ? [] : [new Date(e.releasedAt * 1000).getFullYear()])),
        ]),
      ].sort((a, b) => b - a),
      curve: curveInfo(),
      slots: { old: OLD_SLOTS, current: NEW_SLOTS },
      board,
      pending,
      reminderDays: REMINDER_DAYS,
      // 各难度 × 各评级的用时对照表。每次请求现算（纯函数、不读库），
      // 所以曲线一换它就是新的 —— 前端不存、不算，只负责画出来。
      rankTimes: buildRankTimeTable(),
      counts: {
        pendingRecent: pending.filter(p=>p.reminderGroup==='recent').length,
        solved: entries.length,
        rated: entries.filter((e) => e.problemRating !== null).length,
        missingRating: entries.filter((e) => e.problemRating === null).length,
        recorded: entries.filter((e) => e.recordedSeconds !== null).length,
        unknownRelease,
      },
    },
  };
}

/** 写端点的公共目标字段。平台不从请求体取 —— 榜单只覆盖 CF，别让它被参数改写。 */
function dxTarget(input: Record<string, unknown>): { userId: number; platform: string; problemId: string } {
  return {
    userId: positiveInt(input, 'userId'),
    platform: DX_PLATFORM,
    problemId: text(input, 'problemId', 64),
  };
}

function setDxTime(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  const target = dxTarget(input);
  const result = setProblemTime(ctx.openWrite(), { ...target, seconds: positiveInt(input, 'seconds') });
  return { status: result.created ? 201 : 200, body: result };
}

function clearDxTime(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  return { status: 200, body: clearProblemTime(ctx.openWrite(), dxTarget(input)) };
}

function practiceHistory(ctx: ApiContext, params: URLSearchParams): ApiResult {
  const user = parseIntOrNull(params.get('user'), 1, Number.MAX_SAFE_INTEGER, 'user');
  if (user === null) throw new BadRequest('缺少 user 参数');
  const offset = clampInt(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const q = (params.get('q') ?? '').trim().toLowerCase();
  if (q.length > 120) throw new BadRequest('搜索内容不能超过 120 个字符');
  const sort = params.get('sort') ?? 'recorded_desc';
  if (!['recorded_desc','date_desc','date_asc','seconds_asc','seconds_desc','problem_asc','difficulty_asc','difficulty_desc'].includes(sort)) throw new BadRequest('不支持的排序方式');
  const rows = listPractice(ctx.db, user).filter(r => !q || r.problem_id.toLowerCase().includes(q) || (r.problem_title ?? '').toLowerCase().includes(q));
  rows.sort((a,b) => {
    let order = 0;
    if (sort.startsWith('difficulty_')) {
      if (a.problem_rating === null || b.problem_rating === null) order = Number(a.problem_rating === null) - Number(b.problem_rating === null);
      else order = (a.problem_rating-b.problem_rating) * (sort === 'difficulty_asc' ? 1 : -1);
    } else if (sort.startsWith('date_')) {
      if (a.attempted_at === null || b.attempted_at === null) order = Number(a.attempted_at === null) - Number(b.attempted_at === null);
      else order = (a.attempted_at-b.attempted_at) * (sort === 'date_asc' ? 1 : -1);
    } else if (sort.startsWith('seconds_')) order = (a.seconds-b.seconds) * (sort === 'seconds_asc' ? 1 : -1);
    else if (sort === 'problem_asc') order = a.problem_id.localeCompare(b.problem_id, 'en', {numeric:true});
    else order = b.recorded_at-a.recorded_at;
    return order || b.id-a.id;
  });
  const page = rows.slice(offset, offset + 50).map(row => {
    const scoreReason = row.voided_at !== null ? '已作废，不计分'
      : row.outcome !== 'ac' ? '未完成，不计分'
      : row.practice_kind === 'assisted' ? '辅助解题，不计分'
      : row.platform !== DX_PLATFORM ? '该平台仅记录练习，不参与 CF 评分'
      : row.problem_rating === null ? '未填写题目难度' : null;
    const score = scoreReason ? null : scoreProblem({
      platform: row.platform, problemId: row.problem_id, problemTitle: row.problem_title,
      problemUrl: null, problemRating: row.problem_rating, recordedSeconds: row.seconds,
      solvedAt: row.attempted_at ?? row.recorded_at, releasedAt: null,
    });
    return { ...row, score, scoreReason };
  });
  return { status: 200, body: { rows: page, total: rows.length, offset, limit: 50, q, sort } };
}

function addPractice(ctx: ApiContext, body: unknown): ApiResult {
  const input = objectBody(body);
  const result = recordPractice(ctx.openWrite(), {
    ...dxTarget(input), platform: input.platform === undefined ? DX_PLATFORM : text(input, 'platform', 64).trim(),
    manual: input.manual === true, title: input.title === undefined ? undefined : text(input, 'title', 200),
    difficulty: input.difficulty == null ? null : input.difficulty as number,
    seconds: positiveInt(input, 'seconds'),
    outcome: text(input, 'outcome', 20) as PracticeInput['outcome'],
    practiceKind: text(input, 'practiceKind', 20) as PracticeInput['practiceKind'],
    timingSource: text(input, 'timingSource', 30) as PracticeInput['timingSource'],
    attemptedAt: input.attemptedAt === null ? null : positiveInt(input, 'attemptedAt'),
    requestId: text(input, 'requestId', 100),
  });
  return { status: result.created ? 201 : 200, body: result };
}

function exportBacktest(ctx: ApiContext, params: URLSearchParams): ApiResult {
  const user = parseIntOrNull(params.get('user'), 1, Number.MAX_SAFE_INTEGER, 'user');
  if (user === null || !ctx.db.prepare('SELECT 1 FROM users WHERE id=?').get(user)) throw new BadRequest('用户不存在');
  const year = clampInt(params.get('year'), new Date().getFullYear(), 2000, 3000, 'year');
  return { status: 200, downloadName: params.get('download') === '1' ? `algorithm-dx-backtest-${year}.json` : undefined,
    body: localBacktestReport(listDxEntries(ctx.db, user, DX_PLATFORM), listPractice(ctx.db, user),
    year, yearStartSeconds(year), yearStartSeconds(year + 1)) };
}

/* ---------- 路由 ---------- */

export async function handleApi(ctx: ApiContext, request: ApiRequest): Promise<ApiResult> {
  const { pathname, params, body, method } = request;
  try {
    if (method === 'GET') {
      switch (pathname) {
        case '/api/circle': {
          const cursor = params.get('cursor');
          if (cursor && (!/^\d+:\d+$/.test(cursor) || cursor.split(':').some(v => !Number.isSafeInteger(Number(v))))) throw new BadRequest('无效的分页位置');
          return { status: 200, body: getCircle(ctx.db, parseFilters(params, ctx), cursor, params.get('archived') === '1') };
        }
        case '/api/meta':
          return meta(ctx, params);
        case '/api/stats':
          return stats(ctx, params);
        case '/api/dx/rules':
          return { status: 200, body: { curve: curveInfo(), scoring: { divisor: PROBLEM_RATING_DIVISOR, atT97: factorFromAchievement(97), atSSSPlus: factorFromAchievement(100.5) }, rankTimes: buildRankTimeTable() } };
        case '/api/dx':
          return dx(ctx, params);
        case '/api/dx/timer': {
          const user = parseIntOrNull(params.get('user'), 1, Number.MAX_SAFE_INTEGER, 'user');
          if (user === null) throw new BadRequest('缺少 user 参数');
          return { status: 200, body: timerState(ctx.db, user, clampInt(params.get('tz'), DEFAULT_TZ_OFFSET_MINUTES, -840, 840, 'tz')) };
        }
        case '/api/dx/attempts':
          return practiceHistory(ctx, params);
        case '/api/dx/backtest':
          return exportBacktest(ctx, params);
        case '/api/feed':
          return feed(ctx, params);
        case '/api/problem':
          return problemDetail(ctx, params);
        case '/api/sync/status':
          return syncStatus(ctx);
        default:
          return { status: 404, body: { error: `未知接口：${pathname}` } };
      }
    }
    if (method === 'POST') {
      switch (pathname) {
        case '/api/import/matiji': {
          const input = objectBody(body);
          const commit = input.commit === true;
          if (commit && ctx.syncJobs.busy()) throw new Conflict('正在同步，请等同步完成或取消获取后再导入');
          const result = importMatiji(commit ? ctx.openWrite() : ctx.db, positiveInt(input, 'accountId'), input.snapshot, commit);
          if (commit) ctx.syncJobs.markDataChanged();
          return { status:200, body:result };
        }
        case '/api/accounts/matiji/identity': {
          const input = objectBody(body);
          const cookie = text(input, 'cookie', 4096, false) || envFor(ctx.envFile).ALGO_COOKIE_MATIJI;
          if (!cookie) throw new BadRequest('请先填写码蹄集登录 Cookie，再点击「识别我的账号」');
          const safeCookie = assertSafeEnvValue('ALGO_COOKIE_MATIJI', cookie);
          const identity = await new MatijiLiveFetcher(new HttpClient(ctx.openWrite()), safeCookie).currentAccount();
          return { status: 200, body: identity };
        }
        case '/api/cf-extension/pair': {
          if(ctx.syncJobs.busy())throw new Conflict('请先等待同步完成或取消同步，再生成连接码');
          const token=randomBytes(32).toString('hex');
          upsertEnvVars(ctx.envFile,{ALGO_CF_EXTENSION_TOKEN:token});cfExtensionBridge.reset();
          return {status:200,body:{token}};
        }
        case '/api/accounts/cf-browser': {
          if(ctx.syncJobs.busy())throw new Conflict('请先等待同步完成或取消同步，再打开登录窗口');
          await openCfBrowser(envFor(ctx.envFile).ALGO_CF_BROWSER_EXECUTABLE);
          return {status:200,body:{opened:true}};
        }
        case '/api/accounts/cf-groups': {
          const input=objectBody(body), id=positiveInt(input,'accountId');
          if(!ctx.db.prepare("SELECT 1 FROM accounts WHERE id=? AND platform='codeforces' AND is_archived=0").get(id))throw new BadRequest('CF 账号不存在');
          if(ctx.syncJobs.busy())throw new Conflict('请等待同步完成或取消获取后再保存');
          const groups=parseGroupLinks(text(input,'links',6000,false));
          const key=text(input,'key',200,false), secret=text(input,'secret',200,false);
          const mode=text(input,'mode',20,false)||'extension';
          if(!['api','browser','extension'].includes(mode))throw new BadRequest('获取方式无效');
          if(Boolean(key)!==Boolean(secret))throw new BadRequest('更新授权时需同时填写 API Key 和 Secret');
          if(key&&(!/^[A-Za-z0-9_-]+$/.test(key)||!/^[A-Za-z0-9_-]+$/.test(secret)))throw new BadRequest('API Key 或 Secret 格式无效');
          const env=envFor(ctx.envFile);
          if(mode==='api'&&groups.length&&!(key&&secret)&&!(env.ALGO_CF_API_KEY&&env.ALGO_CF_API_SECRET))throw new BadRequest('请先填写 API Key 和 Secret');
          const db=ctx.openWrite(), owner=acquireSyncLock(db);
          try {
            const current=db.prepare("SELECT 1 FROM accounts WHERE id=? AND platform='codeforces' AND is_archived=0").get(id);
            if(!current)throw new BadRequest('CF 账号已更改，请刷新后重试');
            const values:Record<string,string>={['ALGO_CF_GROUPS_'+id]:groups.map(g=>g.url).join(';'),['ALGO_CF_GROUP_MODE_'+id]:mode};
            if(key){values.ALGO_CF_API_KEY=key;values.ALGO_CF_API_SECRET=secret;}
            upsertEnvVars(ctx.envFile,values);
            db.prepare('UPDATE sync_state SET history_cursor=NULL,history_complete=0 WHERE account_id=?').run(id);
            db.exec('DELETE FROM response_cache');
          } finally {db.prepare('DELETE FROM sync_lock WHERE id=1 AND owner=?').run(owner);}
          ctx.syncJobs.markDataChanged();
          return {status:200,body:{saved:true,groups:groups.map(g=>g.url),configured:Boolean(key||(env.ALGO_CF_API_KEY&&env.ALGO_CF_API_SECRET))}};
        }
        case '/api/accounts':
          return await bind(ctx, body);
        case '/api/accounts/unbind':
          return unbind(ctx, body);
        case '/api/accounts/replace': {
          const input = objectBody(body);
          requireConfirm(input);
          return { status: 200, body: replaceAccount(ctx.openWrite(), positiveInt(input, 'id'), text(input, 'handle', 120)) };
        }
        case '/api/accounts/rename':
          return rename(ctx, body);
        case '/api/users/follow':
          return follow(ctx, body);
        case '/api/users':
          return addUser(ctx, body);
        case '/api/users/remove':
          return dropUser(ctx, body);
        case '/api/sync/cancel':
          return { status: 200, body: { job: ctx.syncJobs.cancel(positiveInt(objectBody(body), 'jobId')) } };
        case '/api/sync':
          return startSync(ctx, body);
        case '/api/dx/time':
          return setDxTime(ctx, body);
        case '/api/dx/reminder': {
          const input = objectBody(body);
          return {status:200,body:setTimeReminder(ctx.openWrite(),positiveInt(input,'userId'),text(input,'problemId',64),input.dismissed as boolean)};
        }
        case '/api/dx/timer/start': {
          const input = objectBody(body);
          const timer = startTimer(ctx.openWrite(), { userId: positiveInt(input,'userId'), problemId: text(input,'problemId',300),
            practiceKind: text(input,'practiceKind',20) as PracticeInput['practiceKind'], requestId: text(input,'requestId',100) });
          return { status: 200, body: { timer, serverNow: Math.floor(Date.now()/1000) } };
        }
        case '/api/dx/timer/cancel': {
          const input = objectBody(body);
          return { status: 200, body: cancelTimer(ctx.openWrite(),positiveInt(input,'userId'),text(input,'id',100)) };
        }
        case '/api/dx/timer/check': {
          const input = objectBody(body);
          const user = positiveInt(input,'userId');
          reconcileTimers(ctx.openWrite());
          return { status: 200, body: timerState(ctx.db,user) };
        }
        case '/api/dx/time/clear':
          return clearDxTime(ctx, body);
        case '/api/dx/attempts':
          return addPractice(ctx, body);
        case '/api/dx/attempts/edit': {
          const input = objectBody(body);
          const revision = Number(input.revision);
          if (!Number.isSafeInteger(revision) || revision < 0 || input.revision == null) throw new Error('记录版本无效');
          return { status: 200, body: editPractice(ctx.openWrite(), positiveInt(input, 'userId'), positiveInt(input, 'id'), revision, {
            seconds: positiveInt(input, 'seconds'), outcome: text(input, 'outcome', 20) as PracticeInput['outcome'],
            practiceKind: text(input, 'practiceKind', 20) as PracticeInput['practiceKind'],
            attemptedAt: input.attemptedAt === null ? null : positiveInt(input, 'attemptedAt'),
          }) };
        }
        case '/api/dx/attempts/void': {
          const input = objectBody(body);
          if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)) throw new Error('记录版本无效');
          return { status: 200, body: voidPractice(ctx.openWrite(), positiveInt(input, 'userId'), positiveInt(input, 'id'), input.revision as number | undefined) };
        }
        default:
          return { status: 404, body: { error: `未知接口：${pathname}` } };
      }
    }
    return { status: 405, body: { error: `${pathname} 不支持 ${method}` } };
  } catch (error) {
    if (error instanceof BadRequest) return { status: 400, body: { error: error.message } };
    if (error instanceof Conflict) return { status: 409, body: { error: error.message } };
    // 冲突不是终点：把正在跑的任务交给前端，让它跟着跑完，而不是让人反复点。
    if (error instanceof SyncConflict) {
      return { status: 409, body: { error: error.message, code: 'SYNC_ALREADY_RUNNING', job: error.job } };
    }
    if (error instanceof AdminError) {
      // 给用户看中文，给排查留英文原文与 code。
      return {
        status: ADMIN_STATUS[error.code],
        body: { error: ADMIN_MESSAGES[error.code], code: error.code, detail: error.message },
      };
    }
    if (error instanceof DxTimeError) {
      return {
        status: DX_TIME_STATUS[error.code],
        body: { error: DX_TIME_MESSAGES[error.code], code: error.code, detail: error.message },
      };
    }
    // 其余错误（handle 格式、凭据含换行等）保持原文，避免把原因翻译没了。
    return { status: 400, body: { error: error instanceof Error ? error.message : '操作失败' } };
  }
}
