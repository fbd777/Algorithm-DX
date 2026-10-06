import type { Submission, FetchOptions, FetchBatch, ProblemRelease, ProblemRating } from '../domain.ts';

/**
 * 绑定前的探测结果 —— **三态，不是二态**。
 *
 * `unknown` 与 `missing` 必须分开，理由与「跳过 ≠ 失败」是同一条：
 * 没配 Cookie、平台不支持、网络不通、页面改版，都只是**这次没探到**，
 * 它不证明账号不存在。把它们当成「不存在」会挡住本来就合法的绑定。
 */
export type ProbeResult =
  /** 平台上确实有这个人。`displayName` 顺手带回公开昵称，供面板确认「绑对了人」。 */
  | { status: 'found'; displayName?: string | null }
  /** 平台明确说没有这个人 —— 这是可以据此**拒绝**绑定的唯一一种。 */
  | { status: 'missing'; reason: string }
  /** 这次探不了。**不阻断绑定**，只把原因报给使用者知道。 */
  | { status: 'unknown'; reason: string };

export abstract class BaseFetcher {
  abstract readonly platform: string;
  abstract fetch_recent_submissions(user_handle: string, limit?: number): Promise<Submission[]>;
  async fetch_batch(handle: string, options: FetchOptions = {}): Promise<FetchBatch> {
    if (options.mode === 'backfill') throw new FetchError('This platform does not support history backfill');
    return { submissions: await this.fetch_recent_submissions(handle, options.limit), source:this.platform,
      scope:'recent', acceptedOnly:false, complete:false, nextCursor:null, note:'Recent records only' };
  }
  /**
   * 该平台的「题目发布日期」（= 比赛开始时间）来源。
   *
   * 返回 `null` 表示**这个平台不提供**，调用方直接跳过，不当作失败 ——
   * 与「提供了但这次一条都没有」区分开（后者返回空数组）。
   * 目前只有 Codeforces 实现：DX Rating 的 b15 要靠它判定「本年度新题」。
   */
  async fetch_problem_releases(): Promise<ProblemRelease[] | null> { return null; }
  /**
   * 该平台的**题目官方评级**来源（CF：problemset.problems）。
   *
   * 返回 `null` 表示平台不提供，调用方直接跳过。用途：提交载荷里的 `difficulty`
   * 在 CF 未公布评级时是 NULL，这里拿全量评纔回填 —— 未评定的题可以先填用时，
   * 评级一到就自动进 DX 榜，不需要任何人再动它。
   */
  async fetch_problem_ratings(): Promise<ProblemRating[] | null> { return null; }
  /**
   * 绑定前探测：这个 handle 在平台上是否真实存在。
   *
   * 默认返回 `unknown` —— 只有能可靠判「有 / 没有」的平台才覆写它。宁可探不到也不乱判：
   * 误报 `missing` 会挡住合法绑定，误报 `found` 会让填错的 handle 一路绑到同步才发现。
   *
   * 实现约定：
   * - 只走**公开、最省**的接口，一次请求就够，不为了探测抓提交列表；
   * - 尚未实现可靠账号探测的平台（码蹄集）一律 `unknown`；
   * - 网络错误、平台改版、限流统统归 `unknown`，不归 `missing`。
   */
  async probe_handle(_handle: string): Promise<ProbeResult> {
    return { status: 'unknown', reason: 'This platform has no public account lookup' };
  }
}

export class FetchError extends Error {
  retryable: boolean;
  code: string;
  constructor(message: string, retryable = false, code = 'FETCH_FAILED') {
    super(message); this.name = 'FetchError'; this.retryable = retryable;
    this.code = code;
  }
}

/**
 * 401/403 发生在「已经带上登录 Cookie」之后，只可能是凭据本身的问题：
 * 过期、复制少了字符、或者贴的是别的站点的值。裸的 401 只报域名和状态码，
 * 用户看不出该改哪里，所以这里补上确切的变量名再抛出。
 * 非凭据错误原样抛出，不吞掉原始 code。
 */
export function hintCredential(error: unknown, variable: string, platform: string): never {
  const authFailed = error instanceof FetchError
    && (error.code === 'AUTH_REQUIRED' || /HTTP (401|403)\b/.test(error.message));
  if (!authFailed) throw error;
  throw new FetchError(
    `${(error as Error).message} — ${platform} rejected the login Cookie. It is missing, expired or copied wrong; refresh ${variable} in .env.`,
    false, 'AUTH_REQUIRED');
}
