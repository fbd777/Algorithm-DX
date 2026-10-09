import { createHash, randomInt as cryptoRandomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProblemRating } from '../domain.ts';
import { scoreProblem } from './rating.ts';

/**
 * 随机抽题、每日一题与段位認定（挑战模式）—— **唯一实现**。
 *
 * 三件事共用同一套抽题引擎：
 *   1. **随机题目**：选一个档位，抽一道题（`single`）；也可以**自定义**难度范围与
 *      标签（tier=`custom`，条件存 `dan_sessions` 的区间列与 `tags_json`）
 *   2. **每日一题**：按（日期 + 用户）确定性抽一道，同一天刷新不变（`daily`）；
 *      难度带**按用户当前的等效 Rating 定**（±200，见 `dailyBand`）—— 不再全段乱抽
 *   3. **段位認定**：同一档位连抽 4 道、逐题限时，全部通关才算通过（`challenge`）
 *      四个难度档之外还有两个**随机段位**：小随机与大随机（`DAN_RANDOM_TIERS`）。
 *      注意口径：这是**挑战模式**，不发段位名。maimai 的随机段位認定同样不发段位名，
 *      发段位名的是固定选曲段 —— 所以这里也不造分数线，结算只出各题成绩与总分。
 *
 * ## 三条口径在这里定死
 *
 * **A. 题目链接在「开始做题」之前绝不下发。**
 * 抽题发生在服务端，结果只落库；任何读接口只返回**难度分数**（和档位），
 * 不返回 `problem_id`、题名、tags 或 URL。URL 只在 claim（锁题 + 起计时器）那一次
 * 响应里出现。这不是「前端藏起来」，是「客户端里根本还没有」—— F12、右键、
 * 网络面板都拿不到不存在的东西。
 *
 * 刻意**不做**右键屏蔽与 devtools 检测：那类拦截可被 View-Source、直接发请求、
 * 换浏览器绕过，只会挡住正常用户并制造虚假的安全感。真正的边界是数据不下发。
 *
 * **B. 抽题默认按 rating 均匀，不按题目均匀 —— 但「大随机段位」刻意反过来。**
 * 题库里 800-899 有 1104 道，而其他桶只有约 450 道。按题目均匀抽会让「初级」
 * 几乎全是 800 分的题，所以档位抽题的做法是：先均匀选一个 rating 值，再在该 rating
 * 内均匀选一道（`draw: 'rating'`）。
 *
 * 大随机段位（`draw: 'problem'`）**故意**改成在题目上均匀：它存在的意义就是
 * 「不保证难度分布」，让简单题按它们在题库里的真实占比出现。这是 maimai 里
 * 「随机段位」与「大随机段位」的区别 —— 前者难度铺得平，后者就是抓一把。
 *
 * **C. 难度在抽题时快照进 `dan_stages`。**
 * CF 的题目评级会变（公布、回填、重评），而这一轮的进展与结算必须可复现 ——
 * 与 `practice_timers.settlement_json` 是同一条理由。
 *
 * ## 与计时器的关系
 *
 * 本模块**只读** `practice_timers`，不 import `timer.ts`（依赖是单向的：
 * `timer.ts` → `dan.ts`）。claim 时由调用方先用 `startTimer` 起计时器，
 * 再把 `timer_id` 交进来；结算时直接读那张表的状态，与 `reconcileTimers`
 * 的判定天然一致。
 *
 * 唯一的例外是**超时取消**：段位限时是 dan 这一层的规则（不是计时器规则），
 * 所以在这里把该计时器置为 `cancelled`，语句与 `cancelTimer`（timer.ts）完全一致。
 * 不能在这里调用 `cancelTimer` —— 它会回调 `reconcileTimers`，而 `reconcileTimers`
 * 又会回调本函数，形成递归。
 *
 * ## 口径边界（必须显示给用户）
 *
 * 这是一套**自测**，不是防作弊。claim 之后你照样可以看题解、问 AI —— 这一点
 * 拦不住，与 `assisted` 自报标签是同一条现实。它唯一能保证的是「**你没法挑题**」。
 */

/** 挑战模式一轮的题数。 */
export const DAN_STAGES = 4;

/**
 * 一轮认定的总时长上限（秒），防止「抽了不点」把唯一的活动轮次永久占住
 * （`one_active_dan_per_user` 是唯一索引）。24 小时足够走完，也足够在
 * 关了浏览器之后回来接着做。
 */
export const DAN_SESSION_TTL_SECONDS = 86400;

export interface DanTier {
  key: string;
  name: string;
  minRating: number;
  maxRating: number;
  /** 单题限时（秒）。超时即该轮失败并结束。`perStageLimit` 为真时这只是展示回退值。 */
  limitSeconds: number;
  /**
   * 抽题分布（口径 B）：
   *   `rating`  —— 先均匀选 rating 值，再在该值内均匀选一道，难度铺得平；
   *   `problem` —— 直接在题目上均匀，难度分布就是题库的真实分布。
   */
  draw: 'rating' | 'problem';
  /** true = 逐题限时按**当题难度**定，不用 `limitSeconds`。随机段位专用。 */
  perStageLimit?: boolean;
}

/**
 * 四个档位。区间按 `problemset.problems` 的实际分布划定（各区间都有 1800+ 道题），
 * 上界 2600 是刻意留的：T97 曲线在 2000 以上是**已启用的外推**
 * （`productionReady: false`，见 results/cf-study/VALIDATION.md），
 * 把「超上级」再往上抬会让分数越来越依赖外推段。
 */
export const DAN_TIERS: readonly DanTier[] = [
  { key: 'beginner', name: '初级', minRating: 800, maxRating: 1100, limitSeconds: 1800, draw: 'rating' },
  { key: 'intermediate', name: '中级', minRating: 1200, maxRating: 1500, limitSeconds: 2400, draw: 'rating' },
  { key: 'advanced', name: '上级', minRating: 1600, maxRating: 2000, limitSeconds: 3000, draw: 'rating' },
  { key: 'expert', name: '超上级', minRating: 2100, maxRating: 2600, limitSeconds: 3600, draw: 'rating' },
];

/**
 * 两个**随机段位**：rating 区间取四个档位的并集（800–2600），**不分段**。
 *
 * - 小随机段位：按 rating 均匀 —— 每个 rating 值被抽到的机会一样，难度跨度铺得平。
 * - 大随机段位：按**题目**均匀 —— 不保证难度分布，800 分那一桶因为本身题最多，
 *   会成片地出现，「连着几道都是 800」是正常结果而不是 bug。
 *
 * 两者都设 `perStageLimit`：抽到的题横跨 800-2600，统一限时对两头都不公平。
 */
export const DAN_RANDOM_TIERS: readonly DanTier[] = [
  { key: 'small_random', name: '小随机段位', minRating: 800, maxRating: 2600, limitSeconds: 3600,
    draw: 'rating', perStageLimit: true },
  { key: 'big_random', name: '大随机段位', minRating: 800, maxRating: 2600, limitSeconds: 3600,
    draw: 'problem', perStageLimit: true },
];

/**
 * **自定义单题抽题**：难度范围与标签由用户在请求里给（只支持 `kind='single'`），
 * 区间不写死在这里 —— 真正的范围存 `dan_sessions.min_rating / max_rating`，
 * 标签存 `dan_stages` 同表的 `tags_json`（迁移 020）。
 *
 * 上下界放宽到 3500（题库的真实上界）：这是用户自己的明确选择，与档位刻意停在
 * 2600 的那条「评分口径」约束不是一回事 —— 但 2600 以上仍然是 T97 外推段，
 * 页面上要说明。`perStageLimit` 与随机段位同理：1200 的题给 60 分钟、3500 的题
 * 给 30 分钟都说不过去，限时随当题难度走。
 */
export const DAN_CUSTOM_TIER: DanTier = {
  key: 'custom', name: '自定义', minRating: 800, maxRating: 3500, limitSeconds: 3600,
  draw: 'rating', perStageLimit: true,
};

/** 自定义抽题允许的难度范围与标签数（越界在 API 层拒绝，这里只放口径）。 */
export const DAN_CUSTOM_MIN_RATING = 800;
export const DAN_CUSTOM_MAX_RATING = 3500;
export const DAN_CUSTOM_MAX_TAGS = 8;

/** 每日一题：全档位并集，一天一道。不属于可选的档位。 */
export const DAILY_TIER: DanTier = {
  key: 'daily', name: '每日一题', minRating: 800, maxRating: 2600, limitSeconds: 2700, draw: 'rating',
};

export type DanKind = 'challenge' | 'single' | 'daily';

export function danTier(key: string): DanTier | null {
  if (key === DAILY_TIER.key) return DAILY_TIER;
  if (key === DAN_CUSTOM_TIER.key) return DAN_CUSTOM_TIER;
  return DAN_TIERS.find((tier) => tier.key === key)
    ?? DAN_RANDOM_TIERS.find((tier) => tier.key === key) ?? null;
}

/** 可选档位（用于校验前端传来的 tier 参数，daily 不能当档位选）。 */
export function selectableDanTier(key: string): DanTier | null {
  return DAN_TIERS.find((tier) => tier.key === key)
    ?? DAN_RANDOM_TIERS.find((tier) => tier.key === key) ?? null;
}

/**
 * 按难度取限时。随机段位的题横跨 800–2600，统一限时对两头都不公平，所以随题走。
 *
 * 取「上界不低于它的第一个档位」而不是「落在区间内」：CF 评级是 100 的倍数，
 * 实际不会落进 1100→1200 这类空档，但万一日后区间调整，这个写法仍然单调。
 */
export function danLimitForRating(rating: number): number {
  return DAN_TIERS.find((tier) => rating <= tier.maxRating)?.limitSeconds
    ?? DAN_TIERS[DAN_TIERS.length - 1].limitSeconds;
}

/** 这一道题的限时：随机段位按当题难度，其余档位用档位自己的统一限时。 */
export function danStageLimit(tier: DanTier | null, rating: number, fallback: number): number {
  return tier?.perStageLimit ? danLimitForRating(rating) : fallback;
}

/**
 * 已落库的那一道的限时。
 *
 * `limit_seconds` 为 NULL 的是 019 之前抽出来的行 —— 它们属于「档位统一限时」
 * 那一套规则，沿用 session 的值，旧记录的解释一个字都不用改。
 */
export function danStageLimitOf(
  stage: { limit_seconds: number | null },
  session: { limit_seconds: number },
): number {
  return stage.limit_seconds ?? session.limit_seconds;
}

export function danStageCount(kind: DanKind): number {
  return kind === 'challenge' ? DAN_STAGES : 1;
}

/**
 * 题号归一：**统一大写**。
 *
 * `codeforces.ts` 拼 `problem_id` 时不做大小写归一（直接用 API 返回的 index），
 * 而 `normalizeTimerProblem`（timer.ts）会 `toUpperCase()`。为了「已做过的题」
 * 排除集与 `startTimer` 都匹配得上，这里统一按大写产出，并在比对时也归一。
 */
export function danProblemId(problem: ProblemRating): string {
  return `${problem.contestId}:${problem.index.toUpperCase()}`;
}

export function danProblemUrl(problemId: string): string {
  const colon = problemId.indexOf(':');
  const contest = Number(problemId.slice(0, colon));
  const index = problemId.slice(colon + 1);
  const kind = contest >= 100000 ? 'gym' : 'contest';
  return `https://codeforces.com/${kind}/${contest}/problem/${encodeURIComponent(index)}`;
}

export function danDateKey(epochSeconds: number, tzOffsetMinutes: number): string {
  return new Date((epochSeconds + tzOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
}

export interface DanPoolOptions {
  minRating: number;
  maxRating: number;
  /** 已见过的题号（大写）。抽题时排除。 */
  exclude: ReadonlySet<string>;
  /** 抽题分布，默认 `rating`（口径 B）。`problem` 只有「大随机段位」用。 */
  draw?: 'rating' | 'problem';
  /**
   * 标签条件（自定义抽题）：非空时只抽**至少带其中一个标签**的题（「含任一」）。
   * 用「含任一」而不是「全含」—— 全含会把池子筛到只剩几道，「dp AND graphs AND
   * greedy」这种交集在 11000 道的题库里也常常是空的。
   */
  tags?: ReadonlySet<string>;
}

/** 注入随机源，便于单测；生产用 crypto（服务端不可预测，见口径 A）。 */
export type DanRandomInt = (maxExclusive: number) => number;

const defaultRandomInt: DanRandomInt = (maxExclusive) => cryptoRandomInt(maxExclusive);

/**
 * 把题库切成「按 rating 升序的桶」，并保证**桶内顺序稳定**。
 *
 * 稳定排序是每日一题可复现的前提：题库来自 CF 的 JSON 数组，顺序不保证，
 * 若桶内顺序随响应变化，同一个种子会抽到不同的题。
 */
function groupDanCandidates(pool: readonly ProblemRating[], options: DanPoolOptions): ProblemRating[][] {
  const byRating = new Map<number, ProblemRating[]>();
  const wantTags = options.tags !== undefined && options.tags.size > 0;
  for (const problem of pool) {
    if (!Number.isSafeInteger(problem.rating)) continue;
    if (problem.rating < options.minRating || problem.rating > options.maxRating) continue;
    const id = danProblemId(problem);
    if (options.exclude.has(id)) continue;
    // 标签条件是「含任一」。老缓存（v1）里没有 tags 字段 —— 那是「没有标签信息」，
    // 不是「这道题没有标签」，带标签条件时一律不抽，而不是把整池当无标签放行。
    if (wantTags && !(problem.tags ?? []).some((tag) => options.tags!.has(tag))) continue;
    const bucket = byRating.get(problem.rating);
    if (bucket) bucket.push(problem); else byRating.set(problem.rating, [problem]);
  }
  return [...byRating.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => bucket.sort((a, b) => danProblemId(a).localeCompare(danProblemId(b))));
}

/**
 * 随机抽一道。
 *
 * 默认按 rating 均匀（口径 B）：先均匀选 rating 值，再在该 rating 内均匀选一道。
 * `draw: 'problem'` 时改成在题目上直接均匀 —— 难度分布就是题库的真实分布，
 * 800 分那一桶因为本身题最多会成片出现。这是「大随机段位」的定义，不是缺陷。
 */
export function drawDanCandidate(
  pool: readonly ProblemRating[],
  options: DanPoolOptions,
  randomInt: DanRandomInt = defaultRandomInt,
): ProblemRating | null {
  const buckets = groupDanCandidates(pool, options);
  if (buckets.length === 0) return null;
  if (options.draw === 'problem') {
    // flat() 之前桶已按 rating 升序、桶内按题号升序排过，顺序稳定，单测可复现。
    const problems = buckets.flat();
    return problems[randomInt(problems.length)] ?? null;
  }
  const bucket = buckets[randomInt(buckets.length)];
  return bucket[randomInt(bucket.length)] ?? null;
}

/**
 * 每日一题：由种子（日期 + 用户）确定性派生的抽题结果。
 *
 * 不对称是刻意的：随机抽题用 crypto 随机数（不可预测），每日一题必须可复现
 * （刷新不能换题），所以用哈希。每日一题本来就不是秘密测试 ——
 * 它同时发给所有用户，且 `problemset.problems` 是公开接口。
 * 真正需要不可预测的是挑战模式。
 */
export function dailyDanCandidate(
  pool: readonly ProblemRating[],
  options: DanPoolOptions,
  seed: string,
): ProblemRating | null {
  const buckets = groupDanCandidates(pool, options);
  if (buckets.length === 0) return null;
  const digest = createHash('sha256').update(seed).digest();
  const bucket = buckets[digest.readUInt32BE(0) % buckets.length];
  return bucket[digest.readUInt32BE(4) % bucket.length] ?? null;
}

export type DanErrorCode =
  | 'TIER_UNKNOWN'
  | 'CUSTOM_INVALID'
  | 'SESSION_ACTIVE'
  | 'SESSION_NOT_FOUND'
  | 'POOL_EMPTY'
  | 'NOTHING_TO_CLAIM'
  | 'ALREADY_CLAIMED';

export class DanError extends Error {
  code: DanErrorCode;
  constructor(code: DanErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DanSessionRow {
  id: string; user_id: number; tier: string; kind: DanKind;
  stage_count: number; limit_seconds: number; min_rating: number; max_rating: number;
  status: 'active' | 'cleared' | 'failed' | 'abandoned';
  started_at: number; finished_at: number | null;
  total_rating: number | null; settlement_json: string | null;
  /** 自定义抽题的标签条件（JSON 数组）。NULL = 没有标签条件（迁移 020 之前的行也是）。 */
  tags_json: string | null;
}

export interface DanStageRow {
  id: number; session_id: string; stage_index: number;
  problem_id: string; difficulty: number; drawn_at: number;
  claimed_at: number | null; timer_id: string | null;
  outcome: 'cleared' | 'timeout' | 'interrupted' | null;
  seconds: number | null; score_json: string | null;
  /** 这一道的限时（秒）。NULL = 019 之前的旧行，沿用 session.limit_seconds。 */
  limit_seconds: number | null;
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('SAVEPOINT dan_write');
  try { const result = action(); db.exec('RELEASE dan_write'); return result; }
  catch (error) { db.exec('ROLLBACK TO dan_write; RELEASE dan_write'); throw error; }
}

function sessionRow(db: DatabaseSync, id: string): DanSessionRow | undefined {
  return db.prepare('SELECT * FROM dan_sessions WHERE id=?').get(id) as unknown as DanSessionRow | undefined;
}

function stageRows(db: DatabaseSync, sessionId: string): DanStageRow[] {
  return db.prepare('SELECT * FROM dan_stages WHERE session_id=? ORDER BY stage_index').all(sessionId) as unknown as DanStageRow[];
}

export function activeDanSession(db: DatabaseSync, userId: number): DanSessionRow | null {
  return (db.prepare("SELECT * FROM dan_sessions WHERE user_id=? AND status='active'").get(userId) as unknown as DanSessionRow | undefined) ?? null;
}

/**
 * 「已经见过的题」——任何提交（不只是 AC）都排除。
 *
 * 拿到 WA 也算见过，重新抽到它就失去了「抽题」的意义；而只排 AC 会让
 * 「做过但没做出来」的题反复出现。
 *
 * 这个集**故意不看 `accounts.is_archived`**，与其他地方「只算当前账号」的口径
 * 不一样（B50、题友圈、练习记录都带 `is_archived=0`）。理由：归档的含义是
 * 「这个账号不再同步了」（换 handle、换号时旧账号会被归档），**不是**
 * 「那些题我没做过」。带上 `is_archived=0` 的后果是：换过一次 handle 的人，
 * 之前 AC 过的题会全部重新变成可抽 —— 这正是「别抽我做过的题」要防的事。
 *
 * 另外把**正在计时的题**也排除：计时可以不经提交直接对题号开始，
 * 于是不看这一处的话，段位有可能抽到你手上正在做的那道。
 */
export function danExcludedProblems(db: DatabaseSync, userId: number, sessionId?: string): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT s.problem_id FROM submissions s JOIN accounts a ON a.id=s.account_id
    WHERE a.user_id=? AND s.platform='codeforces'`).all(userId) as { problem_id: string }[];
  const exclude = new Set(rows.map((row) => String(row.problem_id).toUpperCase()));
  const timers = db.prepare('SELECT DISTINCT problem_id FROM practice_timers WHERE user_id=?')
    .all(userId) as { problem_id: string }[];
  for (const row of timers) exclude.add(String(row.problem_id).toUpperCase());
  if (sessionId) {
    const drawn = db.prepare('SELECT problem_id FROM dan_stages WHERE session_id=?').all(sessionId) as { problem_id: string }[];
    for (const row of drawn) exclude.add(String(row.problem_id).toUpperCase());
  }
  return exclude;
}

/** 每日一题难度带的半宽：以等效 Rating 为中心，上下各这个数。 */
export const DAILY_BAND_RADIUS = 200;

/** 每日一题的难度带：中心 + 上下界（已裁进档位并集 800–2600）。 */
export interface DailyBand {
  minRating: number;
  maxRating: number;
  /** 中心取整到 100 之后的值。null = 没有水平数据，退回全段。 */
  center: number | null;
  /** 榜算出的等效 Rating（未取整）。null = 没有任何可计分的成绩。 */
  equivalentRating: number | null;
}

/**
 * 每日一题的难度带：**以用户当前的等效 Rating 为中心 ±200**，裁进 [800, 2600]。
 *
 * 「不能太简单也不能太难」的落法。两端都裁进档位并集，于是中心特别低时带子
 * 收敛到 [800, 800]（水平还不到 800 就从最简单的抽），特别高时收敛到 [2600, 2600]
 * （2600 以上是 T97 外推段，档位刻意不往上走，每日一题跟着同一口径）。
 *
 * 中心**取整到 100**：题目 rating 本来就是 100 的倍数，取整不丢信息；更重要的是
 * 这让带子对 DX Rating 的小幅漂移不敏感 —— 一次同步把分数从 1543 推到 1549，
 * 今天的题不会跟着换；跨过 1550 这道坎（取整到 1600）才会挪一次
 * （见 docs/dan.md「每日一题按水平定带」）。
 */
export function dailyBand(equivalentRating: number | null): DailyBand {
  if (equivalentRating === null || !Number.isFinite(equivalentRating)) {
    return { minRating: DAILY_TIER.minRating, maxRating: DAILY_TIER.maxRating, center: null, equivalentRating: null };
  }
  const center = Math.round(equivalentRating / 100) * 100;
  return {
    minRating: Math.min(Math.max(center - DAILY_BAND_RADIUS, DAILY_TIER.minRating), DAILY_TIER.maxRating),
    maxRating: Math.max(Math.min(center + DAILY_BAND_RADIUS, DAILY_TIER.maxRating), DAILY_TIER.minRating),
    center,
    equivalentRating,
  };
}

/** 每日一题：确定性抽题 + 该用户未见过。不落库（读接口不能写，见口径 A 与 GET 只读约束）。 */
export function dailyProblem(
  db: DatabaseSync,
  userId: number,
  pool: readonly ProblemRating[],
  dateKey: string,
  band?: { minRating: number; maxRating: number },
): ProblemRating | null {
  const range = band ?? DAILY_TIER;
  return dailyDanCandidate(
    pool,
    { minRating: range.minRating, maxRating: range.maxRating, exclude: danExcludedProblems(db, userId) },
    `daily:${dateKey}:${userId}`,
  );
}

/** 自定义抽题的输入校验：范围与标签的**形状**。标签是否真实存在于题库，由 API 层对着题库验。 */
function validateCustomInput(input: { minRating?: number; maxRating?: number; tags?: readonly string[] }): {
  minRating: number; maxRating: number; tags: string[];
} {
  const { minRating, maxRating } = input;
  if (!Number.isSafeInteger(minRating) || !Number.isSafeInteger(maxRating)) {
    throw new DanError('CUSTOM_INVALID', '自定义抽题要给难度上下限（整数）');
  }
  if (minRating < DAN_CUSTOM_MIN_RATING || maxRating > DAN_CUSTOM_MAX_RATING || minRating > maxRating) {
    throw new DanError('CUSTOM_INVALID',
      `难度范围要在 ${DAN_CUSTOM_MIN_RATING}–${DAN_CUSTOM_MAX_RATING} 之内，且下限不超过上限`);
  }
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > DAN_CUSTOM_MAX_TAGS) {
    throw new DanError('CUSTOM_INVALID', `标签最多选 ${DAN_CUSTOM_MAX_TAGS} 个`);
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > 40) throw new DanError('CUSTOM_INVALID', '标签格式无效');
  }
  return { minRating, maxRating, tags: tags.map((tag) => tag.trim()) };
}

export function createDanSession(
  db: DatabaseSync,
  input: { id: string; userId: number; kind: DanKind; tierKey: string; now: number;
    minRating?: number; maxRating?: number; tags?: readonly string[] },
): DanSessionRow {
  const custom = input.tierKey === DAN_CUSTOM_TIER.key;
  if (custom && input.kind !== 'single') throw new DanError('CUSTOM_INVALID', '自定义条件只用于单题抽题');
  const customRange = custom ? validateCustomInput(input) : null;
  const tier = input.kind === 'daily' ? DAILY_TIER
    : custom ? DAN_CUSTOM_TIER : selectableDanTier(input.tierKey);
  if (!tier) throw new DanError('TIER_UNKNOWN', '不认识的档位');
  return transaction(db, () => {
    if (activeDanSession(db, input.userId)) {
      throw new DanError('SESSION_ACTIVE', '已经有一轮认定没结束，先完成或放弃它');
    }
    db.prepare(`INSERT INTO dan_sessions
      (id,user_id,tier,kind,stage_count,limit_seconds,min_rating,max_rating,status,started_at,tags_json)
      VALUES(?,?,?,?,?,?,?,?,'active',?,?)`)
      .run(input.id, input.userId, tier.key, input.kind, danStageCount(input.kind),
        tier.limitSeconds,
        customRange ? customRange.minRating : input.kind === 'daily' ? (input.minRating ?? tier.minRating) : tier.minRating,
        customRange ? customRange.maxRating : input.kind === 'daily' ? (input.maxRating ?? tier.maxRating) : tier.maxRating,
        input.now,
        customRange && customRange.tags.length ? JSON.stringify(customRange.tags) : null);
    return sessionRow(db, input.id)!;
  });
}

/**
 * 抽下一道题并落库。返回 null 表示这一轮不需要再抽（已结束，或当前那道还没结算）。
 *
 * 抽题结果**只落库**，调用方负责只把 `difficulty` 发出去（口径 A）。
 * 抽不到题（区间内全做过、或题库为空）抛 `POOL_EMPTY`，不静默降级成区间外的题。
 */
export function drawNextDanStage(
  db: DatabaseSync,
  input: { sessionId: string; pool: readonly ProblemRating[]; randomInt?: DanRandomInt; now: number; dateKey: string },
): DanStageRow | null {
  return transaction(db, () => {
    const session = sessionRow(db, input.sessionId);
    if (!session || session.status !== 'active') return null;
    const stages = stageRows(db, session.id);
    // 当前那道还没 claim / 还没结算，就不再抽 —— 否则会出现两道同时在手的题。
    if (stages.length > 0 && stages[stages.length - 1].outcome === null) return null;
    if (stages.length >= session.stage_count) return null;
    const tier = danTier(session.tier);
    // 自定义抽题的标签条件存在轮次上（迁移 020）；没有条件或旧行（NULL）都不筛。
    const tagList = session.tags_json ? JSON.parse(session.tags_json) as string[] : [];
    const options: DanPoolOptions = {
      minRating: session.min_rating,
      maxRating: session.max_rating,
      exclude: danExcludedProblems(db, session.user_id, session.id),
      draw: tier?.draw ?? 'rating',
      tags: tagList.length ? new Set(tagList) : undefined,
    };
    // 每日一题必须**可复现**（同一天刷新不能换题），所以走哈希而不是随机数；
    // 其余模式走 crypto 随机数，服务端不可预测（口径 A）。
    const candidate = session.kind === 'daily'
      ? dailyDanCandidate(input.pool, options, `daily:${input.dateKey}:${session.user_id}`)
      : drawDanCandidate(input.pool, options, input.randomInt);
    if (!candidate) throw new DanError('POOL_EMPTY', '这个区间里已经没有你没做过的题了');
    // 限时随题走（随机段位），抽到的那一刻就定下来 —— 与 difficulty 一样是快照，
    // 之后调档位区间不会把这一轮的规则重新解释一遍。
    const limit = danStageLimit(tier, candidate.rating, session.limit_seconds);
    const info = db.prepare(`INSERT INTO dan_stages(session_id,stage_index,problem_id,difficulty,drawn_at,limit_seconds)
      VALUES(?,?,?,?,?,?)`)
      .run(session.id, stages.length + 1, danProblemId(candidate), candidate.rating, input.now, limit);
    return db.prepare('SELECT * FROM dan_stages WHERE id=?').get(info.lastInsertRowid) as unknown as DanStageRow;
  });
}

/** 可开始的那一道：最新一条还没 claim 的记录。**只给服务端用**，不要把 problem_id 发出去。 */
export function claimableDanStage(db: DatabaseSync, sessionId: string): DanStageRow | null {
  const row = db.prepare(`SELECT * FROM dan_stages WHERE session_id=? AND claimed_at IS NULL AND outcome IS NULL
    ORDER BY stage_index DESC LIMIT 1`).get(sessionId) as unknown as DanStageRow | undefined;
  return row ?? null;
}

/**
 * 当前这一道：最新一条还没结算的记录（可能已经开始，也可能还没）。
 *
 * 与 `claimableDanStage` 分开是为了让「开始做题」幂等：重复点击时拿到的还是同一道，
 * 于是能返回同一个链接，而不是报「没有待开始的题目」。
 */
export function currentDanStage(db: DatabaseSync, sessionId: string): DanStageRow | null {
  const row = db.prepare(`SELECT * FROM dan_stages WHERE session_id=? AND outcome IS NULL
    ORDER BY stage_index DESC LIMIT 1`).get(sessionId) as unknown as DanStageRow | undefined;
  return row ?? null;
}

/** 锁题：记下开始时刻与计时器 id。计时器由调用方先建好（`startTimer`）。 */
export function claimDanStage(
  db: DatabaseSync,
  input: { sessionId: string; timerId: string; now: number },
): DanStageRow {
  return transaction(db, () => {
    const stage = claimableDanStage(db, input.sessionId);
    if (!stage) throw new DanError('NOTHING_TO_CLAIM', '没有待开始的题目，请刷新');
    db.prepare('UPDATE dan_stages SET claimed_at=?,timer_id=? WHERE id=? AND claimed_at IS NULL')
      .run(input.now, input.timerId, stage.id);
    return db.prepare('SELECT * FROM dan_stages WHERE id=?').get(stage.id) as unknown as DanStageRow;
  });
}

/**
 * 结算所有进行中的认定：把已结束的计时器落成阶段成绩，再决定整轮的胜负。
 *
 * 由 `reconcileTimers`（timer.ts）在同一个事务之外调用 —— 所以它自己开 SAVEPOINT。
 * 它**不抽题**：抽题要题库（网络），而计时器结算不该依赖网络。新一道由读接口
 * 按需抽（见口径 A）。
 */
export function advanceDanSessions(db: DatabaseSync, now: number, checkedAccountId?: number): void {
  transaction(db, () => {
    const sessions = db.prepare("SELECT * FROM dan_sessions WHERE status='active'").all() as unknown as DanSessionRow[];
    for (const session of sessions) settleDanSession(db, session, now, checkedAccountId);
  });
}

function settleDanSession(db: DatabaseSync, session: DanSessionRow, now: number, checkedAccountId?: number): void {
  // 整轮超期（抽了不点）就作废，否则会永久占住 `one_active_dan_per_user`。
  // 已开始的题先按提交时间结算；TTL 只清理未开始或等待下一题的轮次。
  if (now > session.started_at + DAN_SESSION_TTL_SECONDS
    && !stageRows(db, session.id).some(stage => stage.claimed_at !== null && stage.outcome === null)) {
    for (const stage of stageRows(db, session.id)) {
      if (stage.outcome !== null) continue;
      if (stage.timer_id) {
        db.prepare("UPDATE practice_timers SET status='cancelled',ended_at=? WHERE id=? AND status='running'")
          .run(now, stage.timer_id);
      }
      db.prepare("UPDATE dan_stages SET outcome='interrupted' WHERE id=?").run(stage.id);
    }
    finishDanSession(db, session, 'abandoned', now);
    return;
  }
  for (const stage of stageRows(db, session.id)) {
    if (stage.outcome !== null) continue;
    if (stage.claimed_at === null || stage.timer_id === null) continue; // 还没开始做
    const timer = db.prepare('SELECT * FROM practice_timers WHERE id=?').get(stage.timer_id) as unknown as
      { status: string; account_id: number; started_at: number; ended_at: number | null } | undefined;
    if (!timer) { db.prepare("UPDATE dan_stages SET outcome='interrupted' WHERE id=?").run(stage.id); continue; }
    if (timer.status === 'running') {
      const deadline = stage.claimed_at + danStageLimitOf(stage, session);
      if (now <= deadline) continue;
      // A local poll cannot prove there was no timely AC. Only the account's
      // successful submission check may time out a stage; pending verdicts wait.
      if (checkedAccountId !== timer.account_id) continue;
      if (db.prepare(`SELECT 1 FROM submissions WHERE account_id=? AND platform='codeforces'
        AND problem_id=? AND status='PENDING' AND submitted_at>? AND submitted_at<=?`)
        .get(timer.account_id, stage.problem_id, timer.started_at, deadline)) continue;
      // 超时取消：段位限时是 dan 这一层的规则，语句与 cancelTimer（timer.ts）一致。
      db.prepare("UPDATE practice_timers SET status='cancelled',ended_at=? WHERE id=? AND status='running'")
        .run(deadline, stage.timer_id);
      db.prepare("UPDATE dan_stages SET outcome='timeout' WHERE id=?").run(stage.id);
      continue;
    }
    if (timer.status === 'completed' && timer.ended_at !== null) {
      const seconds = timer.ended_at - timer.started_at;
      if (timer.ended_at > stage.claimed_at + danStageLimitOf(stage, session)) {
        db.prepare("UPDATE dan_stages SET outcome='timeout' WHERE id=?").run(stage.id);
        continue;
      }
      const score = scoreProblem({
        platform: 'codeforces', problemId: stage.problem_id, problemTitle: stage.problem_id, problemUrl: null,
        problemRating: stage.difficulty, solvedAt: timer.ended_at, releasedAt: null, recordedSeconds: seconds,
      });
      db.prepare("UPDATE dan_stages SET outcome='cleared',seconds=?,score_json=? WHERE id=?")
        .run(seconds, JSON.stringify(score), stage.id);
      continue;
    }
    // cancelled / expired：这一轮被打断，判为放弃。
    db.prepare("UPDATE dan_stages SET outcome='interrupted' WHERE id=?").run(stage.id);
  }

  const stages = stageRows(db, session.id);
  const interrupted = stages.find((stage) => stage.outcome === 'interrupted');
  if (interrupted) { finishDanSession(db, session, 'abandoned', now); return; }
  const timedOut = stages.find((stage) => stage.outcome === 'timeout');
  if (timedOut) { finishDanSession(db, session, 'failed', now); return; }
  if (stages.length < session.stage_count || stages.some((stage) => stage.outcome !== 'cleared')) return;
  finishDanSession(db, session, 'cleared', now);
}

/** 冻结结算：整轮的成绩写入 settlement_json，之后读到的都是当时的规则与数值。 */
function finishDanSession(db: DatabaseSync, session: DanSessionRow, status: 'cleared' | 'failed' | 'abandoned', now: number): void {
  const stages = stageRows(db, session.id);
  const scores = stages.map((stage) => {
    const score = stage.score_json ? JSON.parse(stage.score_json) as Record<string, unknown> : null;
    return {
      index: stage.stage_index,
      problemId: stage.problem_id,
      difficulty: stage.difficulty,
      outcome: stage.outcome,
      seconds: stage.seconds,
      // 逐题限时进结算快照：随机段位每题限时不同，历史记录要能按当时的规则解释。
      limitSeconds: danStageLimitOf(stage, session),
      achievementShown: score?.achievementShown ?? null,
      rank: score?.rank ?? null,
      rating: score?.rating ?? null,
    };
  });
  const cleared = status === 'cleared';
  const total = cleared
    ? Math.round(scores.reduce((sum, row) => sum + (typeof row.rating === 'number' ? row.rating : 0), 0) * 10) / 10
    : null;
  const settlement = {
    tier: session.tier, kind: session.kind, status,
    stageCount: session.stage_count, limitSeconds: session.limit_seconds,
    minRating: session.min_rating, maxRating: session.max_rating,
    // 自定义抽题的标签条件进快照：历史记录要能按当时的条件解释。
    tags: session.tags_json ? JSON.parse(session.tags_json) as string[] : null,
    startedAt: session.started_at, finishedAt: now, totalRating: total, stages: scores,
    selfReported: true,
  };
  db.prepare('UPDATE dan_sessions SET status=?,finished_at=?,total_rating=?,settlement_json=? WHERE id=? AND status=\'active\'')
    .run(status, now, total, JSON.stringify(settlement), session.id);
}

export function abandonDanSession(db: DatabaseSync, input: { sessionId: string; userId: number; now: number }): void {
  transaction(db, () => {
    const session = sessionRow(db, input.sessionId);
    if (!session || session.user_id !== input.userId) throw new DanError('SESSION_NOT_FOUND', '这一轮认定不存在');
    if (session.status !== 'active') return;
    for (const stage of stageRows(db, session.id)) {
      if (stage.outcome !== null) continue;
      if (stage.timer_id) {
        db.prepare("UPDATE practice_timers SET status='cancelled',ended_at=? WHERE id=? AND status='running'")
          .run(input.now, stage.timer_id);
        db.prepare("UPDATE dan_stages SET outcome='interrupted' WHERE id=?").run(stage.id);
      }
    }
    finishDanSession(db, session, 'abandoned', input.now);
  });
}

export interface DanStageView {
  index: number;
  /** 抽到的题目难度。**这是「开始做题」之前唯一允许下发的信息**（口径 A）。 */
  difficulty: number;
  /** 这一道的限时（秒）。随机段位逐题不同，按当题难度定。 */
  limitSeconds: number;
  claimed: boolean;
  outcome: 'cleared' | 'timeout' | 'interrupted' | null;
  seconds: number | null;
  achievement: number | null;
  rank: string | null;
  rating: number | null;
  /** null = 还没开始做题，题号与链接都不下发。 */
  problemId: string | null;
  problemUrl: string | null;
  deadlineAt: number | null;
  /** 题目名，来自已同步的提交；结算卡要显示。 */
  title: string | null;
  /** 这一次计时窗口内的判定计数 / WA 数，与普通计时结算同一口径。 */
  verdicts: Record<string, number>;
  waCount: number;
  /**
   * 计时器结算时冻结的 B50 对比（`{year,previousScore,currentScore,ratingBefore,ratingAfter,ratingDelta}`）。
   * 段位認定不另算一套分：这里读的就是 `reconcileTimers` 写进 `practice_timers.settlement_json` 的那份。
   */
  comparison: Record<string, unknown> | null;
  practiceKind: string | null;
}

export interface DanSessionView {
  id: string;
  tier: string;
  tierName: string;
  kind: DanKind;
  status: DanSessionRow['status'];
  stageCount: number;
  limitSeconds: number;
  minRating: number;
  maxRating: number;
  startedAt: number;
  finishedAt: number | null;
  expiresAt: number;
  totalRating: number | null;
  /** 抽题分布（口径 B）。`problem` 只可能是大随机段位。 */
  draw: 'rating' | 'problem';
  /** true = 逐题限时按当题难度，此时 `limitSeconds` 只是展示回退值。 */
  perStageLimit: boolean;
  /** 自定义抽题的标签条件；null = 没有条件。 */
  tags: string[] | null;
  stages: DanStageView[];
  /** 结算只出单题成绩与总分，**不发段位名**（随机段位認定是挑战模式）。 */
  selfReported: true;
}

export function danSessionView(db: DatabaseSync, session: DanSessionRow): DanSessionView {
  const tier = danTier(session.tier);
  return {
    id: session.id,
    tier: session.tier,
    tierName: tier?.name ?? session.tier,
    kind: session.kind,
    status: session.status,
    stageCount: session.stage_count,
    limitSeconds: session.limit_seconds,
    minRating: session.min_rating,
    maxRating: session.max_rating,
    startedAt: session.started_at,
    finishedAt: session.finished_at,
    expiresAt: session.started_at + DAN_SESSION_TTL_SECONDS,
    totalRating: session.total_rating,
    draw: tier?.draw ?? 'rating',
    perStageLimit: tier?.perStageLimit === true,
    tags: session.tags_json ? JSON.parse(session.tags_json) as string[] : null,
    stages: stageRows(db, session.id).map((stage) => danStageView(db, stage, session)),
    selfReported: true,
  };
}

function danStageView(db: DatabaseSync, stage: DanStageRow, session: DanSessionRow): DanStageView {
  const score = stage.score_json ? JSON.parse(stage.score_json) as Record<string, unknown> : null;
  // 口径 A：没 claim 过就不下发题号与链接。
  const revealed = stage.claimed_at !== null;
  const timer = stage.timer_id
    ? db.prepare('SELECT * FROM practice_timers WHERE id=?').get(stage.timer_id) as unknown as
      { account_id: number; started_at: number; ended_at: number | null; attempt_id: string | null;
        practice_kind: string; settlement_json: string | null } | undefined
    : undefined;
  const problem = revealed
    ? db.prepare(`SELECT MAX(problem_title) AS title FROM submissions
        WHERE platform='codeforces' AND problem_id=?`).get(stage.problem_id) as unknown as { title: string | null } | undefined
    : undefined;
  const verdicts: Record<string, number> = {};
  if (timer?.ended_at !== null && timer?.ended_at !== undefined) {
    const rows = db.prepare(`SELECT status,COUNT(*) AS count FROM submissions
      WHERE account_id=? AND platform='codeforces' AND problem_id=? AND submitted_at>? AND submitted_at<=?
      GROUP BY status`).all(timer.account_id, stage.problem_id, timer.started_at, timer.ended_at) as unknown as
      { status: string; count: number }[];
    for (const row of rows) verdicts[String(row.status)] = Number(row.count);
  }
  const attempt = timer?.attempt_id
    ? db.prepare('SELECT practice_kind FROM practice_attempts WHERE id=?').get(timer.attempt_id) as unknown as
      { practice_kind: string } | undefined
    : undefined;
  return {
    index: stage.stage_index,
    difficulty: stage.difficulty,
    limitSeconds: danStageLimitOf(stage, session),
    claimed: revealed,
    outcome: stage.outcome,
    seconds: stage.seconds,
    achievement: typeof score?.achievementShown === 'number' ? score.achievementShown : null,
    rank: typeof score?.rank === 'string' ? score.rank : null,
    rating: typeof score?.rating === 'number' ? score.rating : null,
    problemId: revealed ? stage.problem_id : null,
    problemUrl: revealed ? danProblemUrl(stage.problem_id) : null,
    deadlineAt: stage.claimed_at === null ? null : stage.claimed_at + danStageLimitOf(stage, session),
    title: revealed ? (problem?.title ?? null) : null,
    verdicts,
    waCount: verdicts.WA ?? 0,
    comparison: timer?.settlement_json ? JSON.parse(timer.settlement_json) as Record<string, unknown> : null,
    practiceKind: attempt?.practice_kind ?? timer?.practice_kind ?? null,
  };
}

export function danHistory(db: DatabaseSync, userId: number, limit = 20): DanSessionView[] {
  const rows = db.prepare(`SELECT * FROM dan_sessions WHERE user_id=? AND status!='active'
    ORDER BY started_at DESC LIMIT ?`).all(userId, limit) as unknown as DanSessionRow[];
  return rows.map((row) => danSessionView(db, row));
}