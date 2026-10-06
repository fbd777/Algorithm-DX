/**
 * 面板里的后台同步任务。
 *
 * 为什么不在 HTTP 请求里同步跑完：一次完整回补要抓几十页（洛谷 653 条 = 33 页），
 * 几十秒到几分钟不等，把它挂在请求上只会撞超时，而且刷个新页面就白跑。
 * 所以接口只负责「开始」，进度靠前端轮询。
 *
 * 同一时刻只允许一个任务：`SyncService` 自己在数据库里有 sync_lock（能挡住并行的命令行进程），
 * 但那道锁是 90 秒心跳的，撞上只会得到一句「Another sync is already running」；
 * 历史回补可中止近期任务，等待其释放锁后再启动；其余冲突保持互斥。
 */
import { randomUUID } from 'node:crypto';
import { HttpClient } from '../fetchers/http.ts';
import type { DatabaseSync } from 'node:sqlite';
import { createFactory } from '../fetchers/registry.ts';
import { SyncService, type SyncResult } from '../sync/service.ts';
import { envFor, redactSecrets } from '../credentials.ts';

export interface SyncJobRequest {
  automatic?: boolean;
  /** null 表示全部账号。 */
  accountId: number | null;
  mode: 'recent' | 'backfill';
  force: boolean;
}

export interface SyncJobState {
  id: number;
  running: boolean;
  cancelled?: boolean;
  cancelling?: boolean;
  accountId: number | null;
  mode: 'recent' | 'backfill';
  force: boolean;
  startedAt: number;
  finishedAt: number | null;
  results: SyncResult[] | null;
  /** 整轮失败的报错（单个账号失败不走这里，走 results[].message）。 */
  error: string | null;
}

/**
 * 同步参数：与命令行的默认值保持一致，免得「面板同步」和 `npm run sync` 抓出不同的东西。
 * recent 保持 10 页（近期窗口）；backfill 给足 100 页，够覆盖现有的全量历史。
 */
const LIMITS = {
  recent: { limit: 100, maxPages: 10 },
  backfill: { limit: 100, maxPages: 100 },
} as const;

export class SyncJobRunner {
  private job: SyncJobState | null = null;
  private seq = 0;
  private controller: AbortController | null = null;
  private completion: Promise<void> = Promise.resolve();
  private nextAutoAt = 0;
  static readonly MIN_AUTO_INTERVAL_MS = 60_000;
  autoAvailableAt(): number { return this.nextAutoAt; }
  cancel(id: number): SyncJobState | null {
    if (this.job?.id === id && this.job.running) {
      this.job.cancelling = true;
      this.controller?.abort();
      this.nextAutoAt = Date.now() + SyncJobRunner.MIN_AUTO_INTERVAL_MS;
    }
    return this.job;
  }
  private dataRevision = randomUUID();

  markDataChanged(): void { this.dataRevision = randomUUID(); }
  revision(): string { return this.dataRevision; }
  /** 显式声明而不是 `constructor(private getDb: …)`：Node 的 strip-only 模式不支持参数属性。 */
  private getDb: () => DatabaseSync;
  private envFile: string;
  constructor(getDb: () => DatabaseSync, envFile: string) {
    this.getDb = getDb;
    this.envFile = envFile;
  }

  state(): SyncJobState | null {
    return this.job;
  }

  busy(): boolean {
    return Boolean(this.job?.running);
  }

  start(request: SyncJobRequest): SyncJobState {
    const previous = this.completion;
    const replacing = Boolean(this.job?.running);
    if (replacing) {
      if (request.mode !== 'backfill' || this.job!.mode === 'backfill') throw new Error('ALREADY_RUNNING');
      this.cancel(this.job!.id);
    }
    if (request.automatic && Date.now() < this.nextAutoAt) throw new Error('AUTO_COOLDOWN');
    this.nextAutoAt = Date.now() + SyncJobRunner.MIN_AUTO_INTERVAL_MS;
    const controller = new AbortController();
    this.controller = controller;
    const job: SyncJobState = {
      id: ++this.seq,
      running: true,
      accountId: request.accountId,
      mode: request.mode,
      force: request.force,
      startedAt: Math.floor(Date.now() / 1000),
      finishedAt: null,
      results: null,
      error: null,
    };
    this.job = job;
    this.completion = replacing ? previous.then(() => this.run(job, controller.signal)) : this.run(job, controller.signal);
    return job;
  }

  private async run(job: SyncJobState, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      const db = this.getDb();
      // 每次开工都重读一遍 .env：面板可能刚把凭据写进去，而进程里那份是启动时的旧值。
      // `createFactory` 与 `SyncService` 必须拿同一份 env，否则会出现
      // 「前置条件检查说配了、工厂却拿不到 Cookie」这种自相矛盾。
      const env = envFor(this.envFile);
      const service = new SyncService(db, createFactory(db, env, new HttpClient(db, fetch, undefined, signal)), env);
      const options = { ...LIMITS[job.mode], mode: job.mode, force: job.force, signal };
      job.results = await service.sync(job.accountId ?? undefined, options);
    } catch (error) {
      // 与 service.ts 同一道规范：写进面板的东西不能夹带凭据。
      if (signal.aborted) job.cancelled = true;
      else job.error = redactSecrets(error instanceof Error ? error.message : '同步失败');
    } finally {
      this.nextAutoAt = Date.now() + SyncJobRunner.MIN_AUTO_INTERVAL_MS;
      this.dataRevision = randomUUID();
      job.running = false;
      job.finishedAt = Math.floor(Date.now() / 1000);
    }
  }
}
