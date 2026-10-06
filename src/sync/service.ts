import { CodeforcesSyncFetcher } from '../fetchers/codeforces-sync.ts';
import { CodeforcesGroupWebFetcher } from '../fetchers/codeforces-group-web.ts';
import { refreshGroupRatings } from '../fetchers/cf-group-ratings.ts';
import { acquireSyncLock } from './lock.ts';
import { reconcileTimers } from '../dx/timer.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Account, FetchBatch, FetchOptions } from '../domain.ts';
import { Repository } from '../db/database.ts';
import { BaseFetcher, FetchError } from '../fetchers/base.ts';
import { platforms, historyCapability, missingPrerequisite, type PlatformPrerequisite } from '../fetchers/registry.ts';
import { optionsOf } from '../fetchers/common.ts';
import { redactSecrets } from '../credentials.ts';

export type FetcherFactory = (account: Account) => BaseFetcher;
/**
 * `skipped` 与 `failed` 是两回事：
 * - `failed`：**试过了**，但抓取挂了（网络、401、解析失败……）。
 * - `skipped`：**前置条件没配齐，一个请求都没发出**（缺 Cookie / 缺本地快照）。
 *
 * 分开记是为了不让「还没配 Cookie」冒充「抓取失败」—— 后者会写进
 * `sync_runs.status='failed'` 与 `sync_state.last_error`，让面板一直挂着红字。
 * 两者都**不计入成功**，`skipped` 也绝不会被算成「抓到了 0 条」。
 */
export type SyncStatus = 'success' | 'failed' | 'skipped';
export interface SyncResult {
  accountId: number;
  status: SyncStatus;
  fetched: number;
  inserted: number;
  message: string;
  /** 仅 `status === 'skipped'` 时非空：缺的是哪个前置条件。 */
  prerequisite?: PlatformPrerequisite | null;
}

/**
 * 「出题日期」（比赛开始时间）的刷新周期。
 *
 * 比赛是既成事实，只有「新办了一场比赛」才会变，而 `contest.list` 一次 400 KB。
 * 所以不必每次同步都抓：6 小时足够让当天新办的比赛生效，也不会让每次同步都多一个请求。
 * 判定「本年度新题」用的是这个日期，所以它只会影响「某道刚出的题算不算 b15」，
 * 晚几个小时生效没有实际后果。
 */
const PROBLEM_RELEASE_TTL_SECONDS = 6 * 3600;

export class SyncService {
  db:DatabaseSync;
  repo:Repository;
  factory:FetcherFactory;
  /** 前置条件（Cookie / 本地快照）从这份环境里读。面板传的是以 .env 为准的快照。 */
  env:NodeJS.ProcessEnv;
  constructor(db:DatabaseSync,factory:FetcherFactory,env:NodeJS.ProcessEnv=process.env){this.db=db;this.repo=new Repository(db);this.factory=factory;this.env=env;}
  async sync(accountId?:number,options:FetchOptions={}):Promise<SyncResult[]>{
    optionsOf(options);
    options.signal?.throwIfAborted();
    let accounts=(accountId===undefined?this.db.prepare('SELECT * FROM accounts WHERE is_archived=0 ORDER BY id').all():this.db.prepare('SELECT * FROM accounts WHERE id=? AND is_archived=0').all(accountId)) as unknown as Account[];
    if(accountId!==undefined&&!accounts.length)throw new Error('Account does not exist');
    if(!accounts.length)return [];
    const owner=acquireSyncLock(this.db);
    let lost=false;
    const heartbeat=setInterval(()=>{
      try{if(!this.db.prepare('UPDATE sync_lock SET expires_at=unixepoch()+90 WHERE id=1 AND owner=?').run(owner).changes)lost=true;}
      catch{lost=true;}
    },15000);
    try{
      // Read identities again after acquiring the lease: another process may have replaced one.
      accounts=(accountId===undefined?this.db.prepare('SELECT * FROM accounts WHERE is_archived=0 ORDER BY id').all():this.db.prepare('SELECT * FROM accounts WHERE id=? AND is_archived=0').all(accountId)) as unknown as Account[];
      if(accountId!==undefined&&!accounts.length)throw new Error('Account is archived or does not exist');
      this.db.prepare("UPDATE sync_runs SET status='interrupted',finished_at=unixepoch(),error_code='INTERRUPTED',message='Previous process stopped before completion' WHERE status='running'").run();
      this.db.exec('DELETE FROM response_cache WHERE expires_at <= unixepoch(); DELETE FROM fetch_cache WHERE expires_at <= unixepoch()');
      const results:SyncResult[]=[];
      for(const account of accounts){
        options.signal?.throwIfAborted();
        if(lost)throw new Error('Sync lock lost');
        results.push(await this.syncAccount(account,options,()=>{
          options.signal?.throwIfAborted();
          const lock=this.db.prepare('SELECT owner,expires_at FROM sync_lock WHERE id=1').get();
          if(lost||lock?.owner!==owner||Number(lock.expires_at)<=Math.floor(Date.now()/1000))throw new Error('Sync lock lost');
        }));
      }
      return results;
    }finally{
      clearInterval(heartbeat);
      this.db.prepare('DELETE FROM sync_lock WHERE id=1 AND owner=?').run(owner);
    }
  }
  private async syncAccount(account:Account,options:FetchOptions,assertLock:()=>void):Promise<SyncResult>{
    if(!(platforms as readonly string[]).includes(account.platform))return {accountId:account.id,status:'skipped',fetched:0,inserted:0,message:'该平台已停止支持，已有数据保留'};
    // 前置条件没配齐：返回 skipped 并**在写任何状态之前退出**。
    // 不插 sync_runs、不动 sync_state（连 last_attempt_at 也不动）——
    // 这三个字段记的都是「抓取尝试」，而这里一次尝试都没发生。
    const missing=missingPrerequisite(this.env,account,options.mode??'recent');
    if(missing){
      return{accountId:account.id,status:'skipped',fetched:0,inserted:0,
        message:`${missing.detail}（缺 ${missing.variable}）`,prerequisite:missing};
    }
    const mode=options.mode??'recent';
    if(account.platform==='matiji'&&mode==='backfill'&&this.env[`ALGORITHM_DX_MATIJI_SNAPSHOT_${account.id}`])return {accountId:account.id,status:'skipped',fetched:0,inserted:0,message:'此账号仍使用旧快照配置；移除 ALGORITHM_DX_MATIJI_SNAPSHOT 配置并设置码蹄集登录后可回补'};
    const capability=historyCapability(account.platform);
    if(mode==='backfill'&&!capability.supported)return {accountId:account.id,status:'skipped',fetched:0,inserted:0,message:capability.detail};
    this.db.prepare('INSERT INTO sync_state(account_id,last_attempt_at) VALUES (?,unixepoch()) ON CONFLICT(account_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at').run(account.id);
    const state=this.db.prepare('SELECT * FROM sync_state WHERE account_id=?').get(account.id)!;
    const runId=this.db.prepare("INSERT INTO sync_runs(account_id,status,mode) VALUES (?,'running',?)").run(account.id,mode).lastInsertRowid;
    try{
      const effective={...options,cursor:mode==='backfill'?(options.force?null:state.history_cursor as string|null):null};
      // Use the last completed sync's frontier, not timer imports which may leave gaps.
      // Revisit a day for recent verdict changes, and include every known pending verdict.
      if(account.platform==='codeforces'&&mode==='recent'&&!options.force&&options.since===undefined){
        const coverage=state.coverage_json?JSON.parse(String(state.coverage_json)):null;
        if(Number.isSafeInteger(coverage?.newest)){
          const pending=this.db.prepare("SELECT MIN(submitted_at) AS oldest FROM submissions WHERE account_id=? AND status='PENDING'").get(account.id);
          const timer=this.db.prepare("SELECT MIN(started_at) AS oldest FROM practice_timers WHERE account_id=? AND status='running'").get(account.id);
          effective.since=Math.max(0,Math.min(coverage.newest-86400,Number(pending?.oldest??coverage.newest),Number(timer?.oldest??coverage.newest)));
        }
      }
      // Revisit one day plus any pending verdicts, then stop paging old Luogu records.
      // Backfill and explicit force still traverse their full requested window.
      if(account.platform==='luogu'&&mode==='recent'&&!options.force&&options.since===undefined){
        const frontier=this.db.prepare("SELECT MAX(submitted_at) AS latest, MIN(CASE WHEN status='PENDING' THEN submitted_at END) AS pending FROM submissions WHERE account_id=?").get(account.id);
        if(frontier?.latest!=null)effective.since=Math.max(0,Math.min(Number(frontier.latest)-86400,Number(frontier.pending??frontier.latest)));
      }
      // A completed backfill can be explicitly restarted with --force.
      if(mode==='backfill'&&state.history_complete&&!options.force)throw new FetchError('History already traversed; use --force to restart',false,'ALREADY_COMPLETE');
      const key=JSON.stringify([account.id,account.platform,account.handle,mode,effective.cursor,options.limit??100,options.maxPages??10,effective.since??null]);
      // Always revalidate the cookie owner for private LeetCode history, including retries.
      const privateHistory=account.platform==='leetcode-cn'&&mode==='backfill';
      const freshPublic=account.platform==='codeforces'&&mode==='recent';
      const cached=options.force||privateHistory||freshPublic?undefined:this.db.prepare('SELECT payload FROM response_cache WHERE cache_key=? AND expires_at>unixepoch()').get(key);
      const fetcher=this.factory(account);
      const batch:FetchBatch=cached?JSON.parse(String(cached.payload)):await fetcher.fetch_batch(account.handle,effective);
      assertLock();
      // 出题日期是判「本年度新题」的依据，而它不在提交载荷里，得另外取一次。
      // 失败不抛：提交已经到手了，不该因为一份辅助数据把它丢掉。
      const releaseNote=await this.refreshProblemReleases(fetcher,account);
      assertLock();
      const note=[batch.note,releaseNote].filter(Boolean).join('｜');
      const coverage={source:batch.source,scope:batch.scope,acceptedOnly:batch.acceptedOnly,complete:batch.complete,note,
        requestedSince:options.since??null,cached:Boolean(cached),
        oldest:batch.submissions.length?Math.min(...batch.submissions.map(s=>s.submitted_at)):null,
        newest:batch.submissions.length?Math.max(...batch.submissions.map(s=>s.submitted_at)):null};
      const encoded=JSON.stringify(coverage);
      this.db.exec('BEGIN IMMEDIATE');
      let inserted=0;
      try{
        assertLock();
        const before=Number(this.db.prepare('SELECT count(*) AS n FROM submissions WHERE account_id=?').get(account.id)!.n);
        this.repo.saveSubmissions(account.id,batch.submissions);
        if(account.platform==='codeforces'&&batch.groupReleases?.length)this.repo.saveProblemReleases(account.platform,batch.groupReleases);
        if(account.platform==='codeforces')reconcileTimers(this.db,account.id);
        const after=Number(this.db.prepare('SELECT count(*) AS n FROM submissions WHERE account_id=?').get(account.id)!.n);
        inserted=after-before;
        this.db.prepare('UPDATE sync_state SET last_success_at=unixepoch(),last_error=NULL,coverage_json=? WHERE account_id=?').run(encoded,account.id);
        if(mode==='backfill')this.db.prepare('UPDATE sync_state SET history_cursor=?,history_complete=? WHERE account_id=?').run(batch.nextCursor,Number(batch.complete),account.id);
        this.db.prepare("UPDATE sync_runs SET status='success',finished_at=unixepoch(),fetched=?,inserted=?,coverage_json=?,message=? WHERE id=?").run(batch.submissions.length,inserted,encoded,note,runId);
        if(!cached&&!privateHistory)this.db.prepare('INSERT INTO response_cache VALUES (?,?,unixepoch()+60) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at').run(key,JSON.stringify(batch));
        this.db.exec('COMMIT');
      }catch(e){this.db.exec('ROLLBACK');throw e;}
      // 题目评级回填放在**事务提交之后**：这一批刚入库的未评定提交（比赛刚打完
      // 抓回来的那种）在同一次同步里就有机会补上评级，不用等下一轮。
      // 失败与出题日期同样处理：不算同步失败，说明拼进记录即可。
      let ratingNote=await this.refreshProblemRatings(fetcher,account);
      if(fetcher instanceof CodeforcesSyncFetcher){try{const note=await refreshGroupRatings(this.db,account.id,fetcher.http,{read:fetcher instanceof CodeforcesGroupWebFetcher?fetcher.read:undefined,signal:options.signal,force:options.force});ratingNote=[ratingNote,note].filter(Boolean).join('｜');}catch(error){options.signal?.throwIfAborted();ratingNote+='｜Group 原题难度未更新（'+redactSecrets(error instanceof Error?error.message:'读取失败')+'）';}}
      assertLock();
      if(ratingNote)this.db.prepare('UPDATE sync_runs SET message=message||? WHERE id=?').run(`｜${ratingNote}`,runId);
      return {accountId:account.id,status:'success',fetched:batch.submissions.length,inserted,message:ratingNote?`${note}｜${ratingNote}`:note};
    }catch(error){
      if(options.signal?.aborted){
        this.db.prepare("UPDATE sync_runs SET status='interrupted',finished_at=unixepoch(),error_code='CANCELLED',message='已取消获取' WHERE id=? AND status='running'").run(runId);
        throw options.signal.reason;
      }
      // 适配器本就不该把 Cookie / 授权头 / 响应体拼进报错；这里再兜一道脱敏，
      // 因为这条消息会落进 sync_state.last_error 与 sync_runs.message，进而出现在面板和 CSV 备份里。
      const message=redactSecrets(error instanceof Error?error.message:'Sync failed');
      const code=error instanceof FetchError?error.code:'SYNC_ERROR';
      this.db.prepare('UPDATE sync_state SET last_error=? WHERE account_id=?').run(message,account.id);
      this.db.prepare("UPDATE sync_runs SET status='failed',finished_at=unixepoch(),error_code=?,message=? WHERE id=?").run(code,message,runId);
      return {accountId:account.id,status:'failed',fetched:0,inserted:0,message};
    }
  }
  /**
   * 补一次「出题日期」（比赛开始时间），返回一段说明拼进同步记录。
   *
   * 三件事刻意这么做：
   *  1. 平台不提供（`fetch_problem_releases` 返回 null）就静默跳过，不打任何标记。
   *  2. 失败**不算同步失败**：提交已经抓回来了，不该因为一份辅助数据丢掉它。
   *     但也不能吞 —— 说明会出现在 `sync_runs.message` 里，面板上看得到。
   *  3. TTL 内不重复抓：比赛开始时间是既成事实，只有新办比赛才会新增。
   */
  private async refreshProblemReleases(fetcher:BaseFetcher,account:Account):Promise<string>{
    const row=this.db.prepare('SELECT COALESCE(MAX(fetched_at),0) AS t FROM contests WHERE platform=?').get(account.platform);
    const lastAt=Number(row?.t??0);
    // TTL 之外的第二个刷新条件：CF 的 duration_seconds（v8 新列）还有 NULL 的行。
    // 那是**数据不完整**而不是「可以等等」—— duration 缺失的比赛判不了「比赛内提交」，
    // 首页的最快用时就不会显示。只在 CF 上判：只有 CF 的 contest.list 提供这个字段，
    // 别的平台永远填不上 NULL 之外的值，不该被这个条件反复触发重抓。
    const incomplete=account.platform==='codeforces'&&
      Number(this.db.prepare('SELECT COUNT(*) AS n FROM contests WHERE platform=? AND duration_seconds IS NULL').get(account.platform)?.n??0)>0;
    if(!incomplete&&Math.floor(Date.now()/1000)-lastAt<PROBLEM_RELEASE_TTL_SECONDS)return '';
    try{
      const rows=await fetcher.fetch_problem_releases();
      if(rows===null)return '';
      if(!rows.length)return '出题日期：这次没取到比赛列表';
      this.repo.saveProblemReleases(account.platform,rows);
      return `出题日期 ${rows.length} 场`;
    }catch(error){
      return `出题日期未更新（${redactSecrets(error instanceof Error?error.message:'抓取失败')}）`;
    }
  }
  /**
   * 回填题目评级（CF 专用）。返回一段说明拼进同步记录。
   *
   * 为什么需要它：提交载荷里的 `difficulty` 只在**抓到那条提交的当时**有值 ——
   * 比赛刚打完时 CF 还没公布评级，那次抓回来的就是 NULL。之后的同步只刷近期提交，
   * 一旦这道题滑出近期窗口，评级就永远补不上。所以另取 problemset.problems
   * （fetcher 内部缓存 6 小时）把 NULL 的补齐。
   *
   * 这正是「未评定的题先填用时、评级公布后自动进榜」的后半句：`submissions.difficulty`
   * 一填上，DX 榜下一次读取就会把那道题计分进榜，不需要任何人再动它。
   *
   * 规矩与出题日期相同：平台不提供（null）静默跳过；失败不算同步失败，
   * 说明照旧进 `sync_runs.message`；gym / unrated round 的题在 problemset 里
   * 本来就没有 rating，查不到就保持 NULL，那是事实而不是遗漏。
   */
  private async refreshProblemRatings(fetcher:BaseFetcher,account:Account):Promise<string>{
    if(account.platform!=='codeforces')return '';
    const missing=this.db.prepare(
      "SELECT DISTINCT problem_id FROM submissions WHERE platform='codeforces' AND difficulty IS NULL",
    ).all() as {problem_id:string}[];
    if(!missing.length)return '';
    try{
      const rows=await fetcher.fetch_problem_ratings();
      if(rows===null)return '';
      if(!rows.length)return '题目评级：这次没取到题目清单';
      const ratings=new Map(rows.map(r=>[`${r.contestId}:${r.index}`,r.rating] as const));
      let updated=0;
      for(const {problem_id} of missing){
        const rating=ratings.get(problem_id);
        if(rating===undefined)continue;
        updated+=Number(this.db.prepare(
          "UPDATE submissions SET difficulty=? WHERE platform='codeforces' AND problem_id=? AND difficulty IS NULL",
        ).run(rating,problem_id).changes);
      }
      return updated?`题目评级补齐 ${updated} 条`:'';
    }catch(error){
      return `题目评级未更新（${redactSecrets(error instanceof Error?error.message:'抓取失败')}）`;
    }
  }
}
