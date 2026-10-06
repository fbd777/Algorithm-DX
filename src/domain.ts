export type SubmissionStatus = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'CE' | 'PENDING' | 'OTHER';
export interface Submission {
  platform: string;
  submission_id: string;
  problem_id: string;
  problem_title: string;
  problem_url: string | null;
  difficulty: number | null;
  tags: string[];
  status: SubmissionStatus;
  raw_status: string | null;
  language: string | null;
  execution_time: number | null;
  memory: number | null;
  /**
   * 平台给的原始得分（洛谷）。**满分由题目决定，不要假设是 100** —— 实测有 30 与 100，也有更大的。
   * **平台不提供时为 null，不要用 0 冒充零分。**
   */
  score: number | null;
  submitted_at: number;
}
export interface Cache {
  get<T = Submission[]>(key: string): T | undefined;
  set<T = Submission[]>(key: string, value: T, ttlSeconds: number): void;
}

export interface FetchOptions {
  signal?: AbortSignal;
  limit?: number;
  maxPages?: number;
  mode?: 'recent' | 'backfill';
  cursor?: string | null;
  since?: number;
  force?: boolean;
}
export interface FetchBatch {
  submissions: Submission[];
  source: string;
  scope: 'recent' | 'window' | 'history';
  acceptedOnly: boolean;
  complete: boolean;
  nextCursor: string | null;
  note: string;
}
export interface Account { id: number; user_id: number; platform: string; handle: string; }

/**
 * 一道题的「出题日期」来源：它所属比赛的开始时间。
 *
 * 为什么要单独一个类型而不是复用 Submission：提交载荷里**没有**这个日期
 * （CF 的 `user.status` 只给 contestId 与 rating），要从平台的比赛列表里另取一次。
 * 只有提供这个来源的平台才实现 `fetch_problem_releases`。
 */
export interface ProblemRelease {
  /** 平台内的比赛 id，与 problem_id 里 `:` 前面那一段对应（CF 是 `339:A` → 339）。 */
  contestId: number;
  /** 比赛名。只用于显示与排查，不参与判定。 */
  name: string;
  /** 比赛开始时间（epoch 秒），即题目的发布日期。 */
  startTime: number;
  /** 比赛时长（秒）。CF 的 contest.list 提供；**判「比赛内提交」靠它，缺失时不判**。 */
  durationSeconds: number | null;
}

/**
 * 一道题的官方评级（CF 的 problemset.problems）。
 *
 * 为什么需要单独补：提交载荷里的 `difficulty` 只在**抓到那条提交的当时**有值 ——
 * 比赛刚打完时 CF 还没公布评级，那次抓回来的是 NULL；之后的同步只刷近期提交，
 * 题一旦滑出近期窗口，评级就永远补不上了。所以另取一份全量评级来回填 NULL。
 */
export interface ProblemRating {
  contestId: number;
  index: string;
  rating: number;
}
