import { createHash, randomBytes } from 'node:crypto';
import { CodeforcesSyncFetcher } from './codeforces-sync.ts';
import { normalize } from './codeforces.ts';
import { FetchError } from './base.ts';
import { optionsOf, unique } from './common.ts';
import type { Cache, FetchBatch, FetchOptions, Submission, ProblemRelease } from '../domain.ts';
import type { HttpClient } from './http.ts';

export interface GroupContest { group: string; id: string; url: string }
export function parseGroupLinks(input: string): GroupContest[] {
  const links=input.split(/[\s;]+/).filter(Boolean);
  if(links.length>20)throw new Error('最多配置 20 个群组或比赛链接');
  const seen=new Map<string,GroupContest>();
  for(const link of links){
    let url:URL;try{url=new URL(link);}catch{throw new Error('请填写完整的 CF Group 或比赛链接');}
    const match=url.pathname.match(/^\/group\/([A-Za-z0-9]+)(?:\/contest\/([1-9]\d*)(?:\/.*)?|\/(?:contests|status)\/?|\/?)$/);
    if(url.protocol!=='https:' || url.hostname!=='codeforces.com' || url.port || url.username || url.password || !match)
      throw new Error('请使用 https://codeforces.com/group/群组编号 或其比赛链接');
    if(match[2]&&!Number.isSafeInteger(Number(match[2])))throw new Error('比赛编号无效');
    const id=match[2]??'';
    seen.set(id?'contest:'+id:'group:'+match[1],{group:match[1],id,url:'https://codeforces.com/group/'+match[1]+(id?'/contest/'+id:'')});
  }
  return [...seen.values()];
}
export function signedCfUrl(method:string, params:Record<string,string>, key:string, secret:string, time=Math.floor(Date.now()/1000), nonce=randomBytes(3).toString('hex')):URL {
  const entries=Object.entries({...params,apiKey:key,time:String(time)}).sort(([a],[b])=>a<b?-1:a>b?1:0);
  const query=entries.map(([k,v])=>k+'='+v).join('&');
  const signature=nonce+createHash('sha512').update(nonce+'/'+method+'?'+query+'#'+secret).digest('hex');
  const url=new URL('https://codeforces.com/api/'+method);
  url.search=new URLSearchParams([...entries,['apiSig',signature]]).toString();return url;
}
export class CodeforcesGroupFetcher extends CodeforcesSyncFetcher {
  groups:GroupContest[]; key:string; secret:string;
  constructor(cache:Cache,http:HttpClient,groups:GroupContest[],key:string,secret:string){super(cache,http);this.groups=groups;this.key=key;this.secret=secret;}
  private async authorizedRequest(method:string,params:Record<string,string>,signal?:AbortSignal):Promise<any> {
    const url=signedCfUrl(method,params,this.key,this.secret);
    // CF returns useful API errors with HTTP 400; retain the reason without logging signed URLs.
    if(typeof this.http.peek !== 'function')return this.http.json(url,{signal});
    const response=await this.http.peek(url,{signal});
    let body:any;try{body=JSON.parse(response.text);}catch{throw new FetchError('CF 返回了验证页面或非 JSON 响应，请稍后重试',false,'GROUP_ACCESS_FAILED');}
    if(body?.status==='FAILED'){
      const comment=String(body.comment??'');
      if(/not found/i.test(comment))throw new FetchError('CF API 返回找不到比赛 '+(params.contestId??'')+'。可能与比赛编号或 API 访问权限有关；浏览器中能查看比赛，不代表 API 能读取提交。详情见使用指南。',false,'GROUP_CONTEST_UNAVAILABLE');
      if(/apiKey|apiSig|signature|secret|time/i.test(comment))throw new FetchError('CF 授权校验失败，请检查 API Key、Secret 和电脑时间',false,'GROUP_AUTH_FAILED');
      if(/limit exceeded/i.test(comment))throw new FetchError('CF 请求过于频繁，请稍后重试',true,'RATE_LIMITED');
    }
    return body;
  }
  private async discoverContests(signal?:AbortSignal):Promise<GroupContest[]> {
    const contests=new Map<string,GroupContest>();
    for(const entry of this.groups){
      signal?.throwIfAborted();
      if(entry.id){contests.set(entry.id,entry);continue;}
      // CF separates ordinary contests and gyms; merge both without duplicate requests for submissions.
      for(const gym of ['false','true']){
        let body:any;
        try{body=await this.authorizedRequest('contest.list',{groupCode:entry.group,gym},signal);}
        catch(error){signal?.throwIfAborted();if(error instanceof FetchError)throw error;throw new FetchError('群组 '+entry.group+' 比赛列表获取失败，请检查授权和访问权限',false,'GROUP_ACCESS_FAILED');}
        if(body?.status!=='OK'||!Array.isArray(body.result))throw new FetchError('群组 '+entry.group+' 比赛列表不可访问，请检查 API 授权',false,'GROUP_ACCESS_FAILED');
        for(const contest of body.result){
          if(!Number.isSafeInteger(contest?.id)||contest.id<=0)throw new FetchError('群组比赛列表格式异常',false,'SCHEMA_CHANGED');
          const id=String(contest.id);
          contests.set(id,{group:entry.group,id,url:entry.url+'/contest/'+id});
        }
      }
    }
    return [...contests.values()].sort((a,b)=>Number(b.id)-Number(a.id));
  }
  override async fetch_batch(handle:string,options:FetchOptions={}):Promise<FetchBatch>{
    const opts=optionsOf(options),backfill=opts.mode==='backfill';
    if(!this.key || !this.secret)throw new FetchError('请在 CF 账号的「Group 比赛」中配置 API Key 和 Secret',false,'SETUP_REQUIRED');
    const contests=await this.discoverContests(options.signal);
    let progress:{public:string|null;groups:Record<string,number|null>}={public:'1',groups:{}};
    if(backfill&&opts.cursor){
      try{
        if(/^\d+$/.test(opts.cursor))progress.public=opts.cursor;
        else {
          const value=JSON.parse(opts.cursor);
          if(value.version!==1 || !(value.public===null || /^\d+$/.test(value.public)) || !value.groups || typeof value.groups!=='object')throw Error();
          for(const n of Object.values(value.groups))if(n!==null&&(!Number.isSafeInteger(n)||Number(n)<1))throw Error();
          progress=value;
        }
      }catch{throw new FetchError('Group 回补进度无效，请重新回补历史');}
    }
    const rows:Submission[]=[];
    if(!backfill || progress.public!==null){
      const batch=await super.fetch_batch(handle,{...options,cursor:backfill?progress.public:null});
      rows.push(...batch.submissions);progress.public=batch.complete?null:batch.nextCursor;
    }
    for(const contest of contests){
      options.signal?.throwIfAborted();
      if(backfill && progress.groups[contest.id]===null)continue;
      let from=backfill?(progress.groups[contest.id]??1):1;
      let done=false;const seen=new Set<string>();
      for(let page=0;page<(backfill?opts.maxPages:Math.min(opts.maxPages,Math.ceil(opts.limit/100)));page++){
        options.signal?.throwIfAborted();
        const count=backfill?1000:Math.min(100,opts.limit-(from-1));
        let body:any;
        try{
          body=await this.authorizedRequest('contest.status',{groupCode:contest.group,contestId:contest.id,handle,from:String(from),count:String(count)},options.signal);
        }catch(error){
          options.signal?.throwIfAborted();
          if(error instanceof FetchError)throw error;
          throw new FetchError('Group 比赛 '+contest.id+' 获取失败，请检查 API 授权、比赛访问权限或稍后重试',false,'GROUP_ACCESS_FAILED');
        }
        if(body?.status!=='OK'||!Array.isArray(body.result))throw new FetchError('Group 比赛 '+contest.id+' 获取失败，请核对 API Key / Secret、账号权限和电脑时间',false,'GROUP_ACCESS_FAILED');
        const signature=body.result.map((s:any)=>s.id).join(',');
        if(body.result.length&&seen.has(signature))throw new FetchError('Group 比赛分页没有前进',false,'PAGINATION_STALLED');
        seen.add(signature);
        for(const item of body.result){
          if(String(item.contestId??item.problem?.contestId)!==contest.id || !item.author?.members?.some((m:any)=>typeof m.handle==='string'&&m.handle.toLowerCase()===handle.toLowerCase()))throw new FetchError('Group 提交的比赛或用户与请求不匹配',false,'SCHEMA_CHANGED');
          const row=normalize(item);
          row.problem_id=contest.id+':'+item.problem.index;
          row.problem_url=contest.url+'/problem/'+encodeURIComponent(item.problem.index);
          rows.push(row);
        }
        if(body.result.length<count){done=true;break;}
        from+=backfill?Math.max(1,body.result.length-1):body.result.length;
      }
      progress.groups[contest.id]=done?null:from;
    }
    const complete=progress.public===null&&contests.every(g=>progress.groups[g.id]===null);
    return {submissions:unique(rows),source:'https://codeforces.com/api',scope:backfill?'history':'recent',acceptedOnly:false,complete,
      nextCursor:backfill&&!complete?JSON.stringify({version:1,...progress}):null,
      note:'公开提交及已配置群组/比赛的可见提交；群组内新增比赛将在后续同步自动发现。'};
  }
}

/** Supplemental Group timing only; public submission fetching is unchanged. */
export async function fetchGroupReleases(http:HttpClient,groups:GroupContest[],key:string,secret:string,signal?:AbortSignal):Promise<ProblemRelease[]>{
 const rows=new Map<number,ProblemRelease>();
 for(const group of new Set(groups.map(g=>g.group))){
  for(const gym of ['false','true']){
   signal?.throwIfAborted();
   const url=signedCfUrl('contest.list',{groupCode:group,gym},key,secret);
   const body:any=await http.json(url.toString(),{signal});
   if(body?.status!=='OK'||!Array.isArray(body.result))throw new FetchError('Group 比赛时间信息暂不可用',false,'GROUP_METADATA_FAILED');
   for(const c of body.result){
    if(!Number.isSafeInteger(c.id)||c.id<=0||!Number.isSafeInteger(c.startTimeSeconds)||c.startTimeSeconds<=0||!Number.isSafeInteger(c.durationSeconds)||c.durationSeconds<=0)continue;
    if(!groups.some(g=>g.group===group&&(!g.id||Number(g.id)===c.id)))continue;
    rows.set(c.id,{contestId:c.id,name:String(c.name||''),startTime:c.startTimeSeconds,durationSeconds:c.durationSeconds});
   }
  }
 }
 return [...rows.values()];
}
