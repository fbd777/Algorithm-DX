import { BaseFetcher, FetchError, type ProbeResult } from './base.ts';
import { HttpClient } from './http.ts';
import { optionsOf, identifier, timestamp, statusOf, submission, unique } from './common.ts';
import type { Submission, FetchOptions, FetchBatch } from '../domain.ts';

export class AtCoderFetcher extends BaseFetcher {
  readonly platform='atcoder';
  http:HttpClient;
  constructor(http:HttpClient){super();this.http=http;}
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
      note:`AtCoder Problems 非官方镜像，可能延迟；题名暂用题目 ID。${backfill?'按时间分页回补。':'默认查询最近 30 天，可用 --since 指定起点。'}${!complete?'达到分页上限，尚未遍历到最新记录。':''}`};
  }
}
