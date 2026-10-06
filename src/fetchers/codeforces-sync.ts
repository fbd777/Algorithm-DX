import { CodeforcesFetcher, normalize } from './codeforces.ts';
import { FetchError, type ProbeResult } from './base.ts';
import { HttpClient } from './http.ts';
import { optionsOf, unique } from './common.ts';
import type { Cache, FetchOptions, FetchBatch, ProblemRelease, ProblemRating, Submission } from '../domain.ts';

/** contest.list 一次返回全部（非 gym）比赛，没有分页参数；实测 2154 场 / 409 KB。 */
const CONTEST_LIST_URL = 'https://codeforces.com/api/contest.list?gym=false';
/** problemset.problems 一次返回全量题目（含历史）；实测 ~9000 题 / 1.5 MB。 */
const PROBLEMSET_URL = 'https://codeforces.com/api/problemset.problems';
/** 全量评级缓存 6 小时：与 contest.list 同一条规矩 —— 既成事实，没必要次次抓。 */
const RATINGS_CACHE_KEY = 'cf:problemset-ratings:v1';
const RATINGS_TTL_SECONDS = 6 * 3600;

// Keep the Phase 1 standalone interface compatible; sync uses shared DB rate slots.
export class CodeforcesSyncFetcher extends CodeforcesFetcher {
  http:HttpClient;
  constructor(cache:Cache,http:HttpClient){super(cache);this.http=http;}
  override async fetch_recent_submissions(handle:string,limit=100):Promise<Submission[]>{return(await this.fetch_batch(handle,{limit})).submissions;}
  /**
   * 比赛开始时间 = 题目的**出题日期**。CF 的提交载荷里没有这个字段，只有这里拿得到，
   * 而 DX Rating 的 b15 区正要靠它判定「本年度新题」。
   *
   * 不按 `type` 过滤：`contest.list` 的 type 语义有坑 —— `'ICPC'` **不是**「ICPC 赛制」，
   * Div.3 与 Educational 全都是 `'ICPC'`，而低分选手最早拿 rated 记录的比赛就在那批里。
   * `gym=false` 已经排除了 gym（gym 题本来也没有题目 Rating，进不了榜），剩下的照单全收。
   */
  override async fetch_problem_releases():Promise<ProblemRelease[]>{
    const body=await this.http.json(CONTEST_LIST_URL);
    if(body?.status!=='OK')throw new FetchError('Codeforces: '+(body?.comment??'contest.list failed'),false,'API_ERROR');
    if(!Array.isArray(body.result))throw new FetchError('Invalid Codeforces contest list',false,'SCHEMA_CHANGED');
    const rows:ProblemRelease[]=[];
    for(const contest of body.result){
      // 没有开始时间的比赛无法参与判定：跳过，而不是填 0 —— 填 0 会被读成
      // 「1970 年出的题」，那是编出来的事实。实测 2154 场全部带该字段。
      if(!Number.isSafeInteger(contest?.id)||!Number.isSafeInteger(contest?.startTimeSeconds))continue;
      // durationSeconds 决定「比赛窗口」的右端：判定一条提交是不是**比赛内**的（首页的
      // 最快用时、以及将来一切按比赛口径的统计都靠它）。缺失时存 NULL，判定一律不做。
      const duration=Number.isSafeInteger(contest?.durationSeconds)?contest.durationSeconds:null;
      rows.push({contestId:contest.id,name:typeof contest.name==='string'?contest.name:'',startTime:contest.startTimeSeconds,durationSeconds:duration});
    }
    return rows;
  }
  /**
   * 全量题目评级（problemset.problems）。
   *
   * 只在需要回填时调用（SyncService 见到 NULL difficulty 才来），并缓存 6 小时。
   * 没公布评级的题（unrated round、刚打完的比赛）在这个接口里**本来就没有 rating 字段**，
   * 跳过它们不是错误 —— 下次公布后再同步就会补上。
   */
  override async fetch_problem_ratings():Promise<ProblemRating[]|null>{
    const cached=this.cache.get<ProblemRating[]>(RATINGS_CACHE_KEY);
    if(cached)return cached;
    const body=await this.http.json(PROBLEMSET_URL);
    if(body?.status!=='OK')throw new FetchError('Codeforces: '+(body?.comment??'problemset.problems failed'),false,'API_ERROR');
    const problems=body.result?.problems;
    if(!Array.isArray(problems))throw new FetchError('Invalid Codeforces problemset',false,'SCHEMA_CHANGED');
    const rows:ProblemRating[]=[];
    for(const p of problems){
      if(!Number.isSafeInteger(p?.contestId)||typeof p?.index!=='string'||!Number.isSafeInteger(p?.rating))continue;
      rows.push({contestId:p.contestId,index:p.index,rating:p.rating});
    }
    this.cache.set(RATINGS_CACHE_KEY,rows,RATINGS_TTL_SECONDS);
    return rows;
  }
  /**
   * 绑定前探测：Codeforces 的 `user.info` 是官方公开接口，一次请求就能判「有没有这个人」。
   *
   * 判据只用平台自己给的信号：不存在的 handle 会回 **HTTP 400** 且 `comment` 里带
   * `not found`；存在则 200 + `result` 数组非空。除此之外（限流、改版、网络）一律 `unknown`
   * —— 探不到不等于没有，那会挡住本来合法的绑定。
   */
  override async probe_handle(handle:string):Promise<ProbeResult>{
    const url=new URL('https://codeforces.com/api/user.info');
    url.search=new URLSearchParams({handles:handle}).toString();
    let res:{status:number;text:string};
    try{ res=await this.http.peek(url); }
    catch(error){ return {status:'unknown',reason:error instanceof Error?error.message:'Codeforces 探测请求失败'}; }
    let body:any=null;
    try{ body=JSON.parse(res.text); }catch{ /* 不是 JSON 就只按状态码判 */ }
    const comment=typeof body?.comment==='string'?body.comment:'';
    if(res.status===200&&body?.status==='OK'&&Array.isArray(body.result)&&body.result.length){
      const user=body.result[0]??{};
      const name=[user.firstName,user.lastName].filter((part)=>typeof part==='string'&&part.trim()).join(' ').trim();
      return {status:'found',displayName:name||(typeof user.handle==='string'?user.handle:null)};
    }
    // **只有平台自己说出 not found 才算「没有这个人」**。HTTP 400 本身说明不了什么 ——
    // 参数格式不对、被限流、接口改版都会回 400，拿状态码判 missing 会挡住合法的绑定。
    if(/not found/i.test(comment))return {status:'missing',reason:`Codeforces 上没有这个账号：${comment}`};
    return {status:'unknown',reason:`这次没能探测（HTTP ${res.status}${comment?`：${comment}`:''}）`};
  }
  override async fetch_batch(handle:string,options:FetchOptions={}):Promise<FetchBatch>{
    const opts=optionsOf(options),backfill=opts.mode==='backfill';
    if(!/^[A-Za-z0-9_.-]{3,24}$/.test(handle))throw new FetchError('Invalid Codeforces handle');
    let from=backfill?Number(opts.cursor??1):1,complete=false;
    if(!Number.isSafeInteger(from)||from<1)throw new FetchError('Invalid Codeforces cursor');
    const rows:Submission[]=[];
    for(let page=0;page<opts.maxPages;page++){
      const count=backfill?1000:Math.min(100,opts.limit-rows.length);
      const url=new URL('https://codeforces.com/api/user.status');
      url.search=new URLSearchParams({handle,from:String(from),count:String(count)}).toString();
      let body:any;
      for(let attempt=0;attempt<3;attempt++){
        body=await this.http.json(url);
        if(body.status==='OK')break;
        if(!/limit exceeded/i.test(body.comment??'')||attempt===2)throw new FetchError('Codeforces: '+(body.comment??'API failed'),false,'API_ERROR');
        await this.http.wait(2100*2**attempt);
      }
      if(!Array.isArray(body.result))throw new FetchError('Invalid Codeforces result',false,'SCHEMA_CHANGED');
      rows.push(...body.result.map(normalize));
      if(body.result.length<count){complete=true;break;}
      // One record overlap mitigates ordinary pagination shifts; rerun backfill for old rejudges.
      from+=backfill?Math.max(1,body.result.length-1):body.result.length;
      if(!backfill&&rows.length>=opts.limit)break;
    }
    return {submissions:unique(rows),source:'https://codeforces.com/api',scope:backfill?'history':'recent',acceptedOnly:false,
      complete,nextCursor:complete?null:String(from),note:'官方公开提交；分页期间新提交可能使偏移变化，历史回补结束后仍定期刷新近期记录。'};
  }
}
