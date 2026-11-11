import { BaseFetcher, FetchError, type ProbeResult } from './base.ts';
import { HttpClient } from './http.ts';
import { optionsOf, identifier, timestamp, statusOf, submission, unique } from './common.ts';
import { Repository } from '../db/database.ts';
import { ATCODER_CF_MAPPING_VERSION, atCoderDifficultyToCodeforces, displayedAtCoderDifficulty } from '../dx/atcoder-rating.ts';
import type { Cache, Submission, FetchOptions, FetchBatch, ProblemMetadata, ProblemRating, ProblemRelease } from '../domain.ts';

const PROBLEMS_URL='https://kenkoooo.com/atcoder/resources/problems.json';
const MODELS_URL='https://kenkoooo.com/atcoder/resources/problem-models.json';
const CONTESTS_URL='https://kenkoooo.com/atcoder/resources/contests.json';
const CATALOG_TTL_SECONDS=6*3600;
const CATALOG_CACHE_KEY=`atcoder:problem-catalog:${ATCODER_CF_MAPPING_VERSION}`;
const CONTEST_CACHE_KEY='atcoder:contests:v1';

export function cachedAtCoderProblemRatings(cache:Cache):ProblemRating[]|null{
  const rows=cache.get<ProblemMetadata[]>(CATALOG_CACHE_KEY);
  return rows?rows.filter(row=>row.rating!==null&&!row.experimental).map(row=>({contestId:'atcoder',index:row.problemId,
    problemId:row.problemId,problemUrl:row.problemUrl,title:row.title,rating:row.rating!,nativeRating:row.nativeRating,tags:[]})):null;
}

export function cachedAtCoderProblemCatalog(cache:Cache):ProblemMetadata[]|null{
  return cache.get<ProblemMetadata[]>(CATALOG_CACHE_KEY)??null;
}

export class AtCoderFetcher extends BaseFetcher {
  readonly platform='atcoder';
  http:HttpClient;
  cache:Cache;
  constructor(http:HttpClient,cache:Cache=new Repository(http.db)){super();this.http=http;this.cache=cache;}
  async fetch_recent_submissions(handle:string,limit=100):Promise<Submission[]> {return (await this.fetch_batch(handle,{limit})).submissions;}
  /**
   * 绑定前探测：只靠 `atcoder.jp/users/<id>` 的 HTTP 状态码。
   *
   * 不用 kenkoooo 的提交接口来判 —— 那里返回空数组有两种可能（没这个人 / 只是没提交过），
   * 分不开。个人主页的 404 是平台自己给出的结论。
   * 反爬拦截（403 / 503）一律归 `unknown`：那是「这次被挡了」，不是「没有这个人」。
   */
  async probe_handle(handle:string):Promise<ProbeResult>{
    const url=`https://atcoder.jp/users/${encodeURIComponent(handle)}`;
    let res:{status:number;text:string};
    try{ res=await this.http.peek(url,{},1100); }
    catch(error){ return {status:'unknown',reason:error instanceof Error?error.message:'AtCoder 探测请求失败'}; }
    if(res.status===404)return {status:'missing',reason:'AtCoder 上没有这个用户'};
    if(res.status!==200)return {status:'unknown',reason:`这次没能探测（HTTP ${res.status}）`};
    return {status:'found',displayName:null};
  }
  override async fetch_problem_releases():Promise<ProblemRelease[]>{
    const cached=this.cache.get<ProblemRelease[]>(CONTEST_CACHE_KEY);
    if(cached)return cached;
    const raw=await this.http.json(CONTESTS_URL,{},1100);
    if(!Array.isArray(raw))throw new FetchError('Invalid AtCoder Problems contest list',false,'SCHEMA_CHANGED');
    const rows:ProblemRelease[]=[];
    for(const contest of raw){
      if(typeof contest?.id!=='string'||!Number.isSafeInteger(contest?.start_epoch_second))continue;
      rows.push({contestId:contest.id,name:typeof contest.title==='string'?contest.title:'',startTime:contest.start_epoch_second,
        durationSeconds:Number.isSafeInteger(contest.duration_second)?contest.duration_second:null});
    }
    this.cache.set(CONTEST_CACHE_KEY,rows,CATALOG_TTL_SECONDS);
    return rows;
  }
  override async fetch_problem_metadata():Promise<ProblemMetadata[]>{
    const cached=this.cache.get<ProblemMetadata[]>(CATALOG_CACHE_KEY);
    if(cached)return cached;
    const [problems,models]=await Promise.all([
      this.http.json(PROBLEMS_URL,{},1100),
      this.http.json(MODELS_URL,{},1100),
    ]);
    if(!Array.isArray(problems)||models===null||typeof models!=='object'||Array.isArray(models))
      throw new FetchError('Invalid AtCoder Problems metadata',false,'SCHEMA_CHANGED');
    const rows:ProblemMetadata[]=[];
    for(const problem of problems){
      if(typeof problem?.id!=='string'||typeof problem?.name!=='string'||typeof problem?.contest_id!=='string')continue;
      const model=(models as Record<string,any>)[problem.id];
      const raw=typeof model?.difficulty==='number'&&Number.isFinite(model.difficulty)?model.difficulty:null;
      const experimental=model?.is_experimental===true;
      rows.push({problemId:problem.id,contestId:problem.contest_id,title:problem.name,
        problemUrl:`https://atcoder.jp/contests/${encodeURIComponent(String(problem.contest_id??''))}/tasks/${encodeURIComponent(problem.id)}`,
        rating:raw===null||experimental?null:atCoderDifficultyToCodeforces(raw),
        nativeRating:raw===null?null:displayedAtCoderDifficulty(raw),experimental});
    }
    this.cache.set(CATALOG_CACHE_KEY,rows,CATALOG_TTL_SECONDS);
    return rows;
  }
  async fetch_problem_ratings():Promise<ProblemRating[]>{
    const rows=await this.fetch_problem_metadata();
    return rows.filter(row=>row.rating!==null&&!row.experimental).map(row=>({contestId:'atcoder',index:row.problemId,
      problemId:row.problemId,problemUrl:row.problemUrl,title:row.title,rating:row.rating!,nativeRating:row.nativeRating,tags:[]}));
  }
  async fetch_batch(handle:string,options:FetchOptions={}):Promise<FetchBatch>{
    const opts=optionsOf(options), backfill=opts.mode==='backfill';
    if(!/^[A-Za-z0-9_]{1,32}$/.test(handle)) throw new FetchError('Invalid AtCoder user ID');
    let cursor=backfill?Number(opts.cursor??0):(opts.since??Math.floor(Date.now()/1000)-30*86400);
    if(!Number.isSafeInteger(cursor)||cursor<0)throw new FetchError('Invalid AtCoder cursor');
    let complete=false;
    const rows:Submission[]=[];
    for(let page=0;page<opts.maxPages;page++){
      const url=new URL('https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions');
      url.search=new URLSearchParams({user:handle,from_second:String(cursor)}).toString();
      const raw=await this.http.json(url,{},1100);
      if(!Array.isArray(raw))throw new FetchError('Invalid AtCoder Problems response',false,'SCHEMA_CHANGED');
      const normalized=raw.map(s=>submission('atcoder',{
        submission_id:identifier(s.id,'submission id'),problem_id:identifier(s.problem_id,'problem id'),
        problem_title:identifier(s.problem_id,'problem id'),
        problem_url:`https://atcoder.jp/contests/${encodeURIComponent(identifier(s.contest_id,'contest id'))}/tasks/${encodeURIComponent(s.problem_id)}`,
        status:statusOf(s.result),raw_status:s.result??null,language:s.language??null,execution_time:s.execution_time??null,
        submitted_at:timestamp(s.epoch_second),
      }));
      rows.push(...normalized);
      if(raw.length<500){complete=true;break;}
      const next=Math.max(...normalized.map(s=>s.submitted_at));
      // Inclusive overlap preserves submissions sharing the boundary second.
      if(next<=cursor)throw new FetchError('AtCoder timestamp pagination stalled; cannot safely advance',false,'PAGINATION_STALLED');
      cursor=next;
    }
    const all=unique(rows).sort((a,b)=>b.submitted_at-a.submitted_at);
    return {submissions:backfill?all:all.slice(0,opts.limit),source:'https://kenkoooo.com/atcoder',scope:backfill?'history':'window',acceptedOnly:false,
      complete:complete&&(backfill||all.length<=opts.limit),nextCursor:complete?null:String(cursor),
      note:`AtCoder Problems 非官方镜像，可能延迟；同步后会用题目目录补齐题名与难度。${backfill?'按时间分页回补。':'默认查询最近 30 天，可用 --since 指定起点。'}${!complete?'达到分页上限，尚未遍历到最新记录。':''}`};
  }
}
