import { readFileSync } from 'node:fs';
import { CodeforcesSyncFetcher } from './codeforces-sync.ts';
import { readCfPage } from './cf-browser.ts';
import { FetchError } from './base.ts';
import { optionsOf, unique, submission } from './common.ts';
import type { GroupContest } from './codeforces-group.ts';
import type { Cache, FetchBatch, FetchOptions, Submission } from '../domain.ts';
import type { HttpClient } from './http.ts';

// Read the original response, before CF converts server timestamps to the browser's timezone.
const parserSource=readFileSync(new URL('../../extensions/cf-sync/parser.js',import.meta.url),'utf8');
export const CF_GROUP_SNAPSHOT = '(async()=>{' + parserSource + `
 await new Promise(r=>setTimeout(r,2100));
 const response=await fetch(location.href,{credentials:'same-origin',redirect:'error'});
 return parseCfHtml(await response.text(),location.href,response.status);
})()`;
export interface PageSnapshot {
 url:string; status:number; title:string; viewer?:string|null; loggedIn:boolean; challenge:boolean;
 contestTable:boolean; statusTable:boolean; empty:boolean;
 links:{href:string;text:string}[];
 rows:{id:string;handles:string[];problem:string;title:string;time:string;verdict:string;verdictText:string;language:string;execution:string;memory:string}[];
}
export type PageReader=(url:string,expression:string,signal?:AbortSignal)=>Promise<PageSnapshot>;
function validatePage(page:PageSnapshot,expected:string){
 if(page.challenge)throw new FetchError('CF 需要浏览器验证，请在负责同步的 CF 浏览器窗口打开群组页面完成验证后重试',false,'CF_BROWSER_CHALLENGE');
 if((!page.loggedIn&&!page.contestTable&&!page.statusTable)||/\/enter(?:[/?]|$)/.test(new URL(page.url).pathname))throw new FetchError('CF 登录已失效，请在负责同步的 CF 浏览器窗口重新登录',false,'AUTH_REQUIRED');
 if(page.status!==200||new URL(page.url).pathname!==new URL(expected).pathname)throw new FetchError('CF 群组页面不可访问，请确认登录账号能查看该比赛的提交记录',false,'GROUP_ACCESS_FAILED');
}
function pageNumber(path:string,base:string):number|null{
 if(path===base)return 1;
 if(!path.startsWith(base+'/page/'))return null;
 const n=path.slice((base+'/page/').length);return /^[1-9]\d*$/.test(n)?Number(n):null;
}
export function nextPage(page:PageSnapshot,base:string,current:number):number|null{
 let next:number|null=null;
 for(const link of page.links){
  const url=new URL(link.href,'https://codeforces.com');if(url.origin!=='https://codeforces.com')continue;
  const n=pageNumber(url.pathname,base);if(n!==null&&n>current)next=Math.min(next??Infinity,n);
 }
 // Never jump to the last page when CF displays an ellipsis in the pager.
 return next===null?null:current+1;
}
export function cfServerTime(value:string):number{
 const match=value.match(/^([A-Za-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
 if(!match)throw new FetchError('CF 提交时间格式无法识别',false,'SCHEMA_CHANGED');
 const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[1]);
 const [, ,day,year,hour,minute,second='0']=match;
 if(month<0||Number(day)<1||Number(day)>31||Number(hour)>23||Number(minute)>59||Number(second)>59)throw new FetchError('CF 提交时间无效',false,'SCHEMA_CHANGED');
 const date=new Date(Date.UTC(+year,month,+day,+hour,+minute,+second));
 if(date.getUTCMonth()!==month)throw new FetchError('CF 提交日期无效',false,'SCHEMA_CHANGED');
 return date.getTime()/1000-3*3600;
}
export function parseWebRows(page:PageSnapshot,contest:GroupContest,handle:string):Submission[]{
 const result:Submission[]=[];
 for(const row of page.rows){
  if(!row.handles.length)throw new FetchError('CF 提交用户无法识别',false,'SCHEMA_CHANGED');
  if(!row.handles.some(h=>h.toLowerCase()===handle.toLowerCase()))continue;
  const url=new URL(row.problem,'https://codeforces.com');
  // CF may link the source problem outside the group; keep the group index only when explicitly present.
  const match=url.pathname.match(/^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)$/);
  if(url.origin!=='https://codeforces.com'||!match||match[1]!==contest.group||match[2]!==contest.id||!/^\d+$/.test(row.id)||!row.title)
   throw new FetchError('CF 提交的题目或比赛无法识别',false,'SCHEMA_CHANGED');
  const verdict=row.verdict.toUpperCase();
  const statuses:Record<string,Submission['status']>={OK:'AC',WRONG_ANSWER:'WA',TIME_LIMIT_EXCEEDED:'TLE',MEMORY_LIMIT_EXCEEDED:'MLE',RUNTIME_ERROR:'RE',COMPILATION_ERROR:'CE',TESTING:'PENDING',SKIPPED:'OTHER',CHALLENGED:'OTHER',PARTIAL:'OTHER'};
  let status=statuses[verdict];
  if(!status){
   const v=row.verdictText;
   status=/^Accepted$/i.test(v)?'AC':/^Wrong answer/i.test(v)?'WA':/^Time limit/i.test(v)?'TLE':/^Memory limit/i.test(v)?'MLE':/^Runtime error/i.test(v)?'RE':/^Compilation error/i.test(v)?'CE':/^(Running|In queue|Judging|Testing)/i.test(v)?'PENDING':'OTHER';
  }
  const execution=row.execution.match(/^(\d+)\s*ms$/i),memory=row.memory.match(/^(\d+)\s*KB$/i);
  result.push(submission('codeforces',{submission_id:row.id,problem_id:contest.id+':'+match[3],problem_title:row.title.replace(new RegExp('^'+match[3]+'\\s*[-.：:]\\s*'),'').trim(),problem_url:contest.url+'/problem/'+match[3],
   status,raw_status:row.verdict||row.verdictText,language:row.language||null,submitted_at:cfServerTime(row.time),execution_time:execution?Number(execution[1]):null,memory:memory?Number(memory[1])*1024:null}));
 }
 return result;
}
export class CodeforcesGroupWebFetcher extends CodeforcesSyncFetcher{
 groups:GroupContest[];read:PageReader;
 private viewers=new Map<string,string>();
 constructor(cache:Cache,http:HttpClient,groups:GroupContest[],read:PageReader=readCfPage){super(cache,http);this.groups=groups;this.read=read;}
 async discover(signal?:AbortSignal){
  this.viewers.clear();
  const contests=new Map<string,GroupContest>();
  for(const group of this.groups){
   if(group.id){contests.set(group.id,group);continue;}
   const base='/group/'+group.group+'/contests';let pageNumber=1;const seen=new Set<string>();
   for(let count=0;;count++){
    if(count>=100)throw new FetchError('群组比赛列表超过本轮分页上限',false,'PAGINATION_LIMIT');
    const url='https://codeforces.com'+base+(pageNumber===1?'':'/page/'+pageNumber)+'?locale=en';
    const page=await this.read(url,CF_GROUP_SNAPSHOT,signal);validatePage(page,url);
    if(page.loggedIn&&page.viewer)this.viewers.set(group.group,page.viewer.toLowerCase());
    const found=new Map<string,GroupContest>();
    for(const link of page.links){const u=new URL(link.href,'https://codeforces.com');const m=u.pathname.match(/^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)(?:\/|$)/);
      if(u.origin==='https://codeforces.com'&&m&&m[1]===group.group)found.set(m[2],{group:group.group,id:m[2],url:'https://codeforces.com/group/'+group.group+'/contest/'+m[2]});}
    if(!found.size&&!page.contestTable&&!page.empty)throw new FetchError('CF 群组比赛列表无法识别或不可见',false,'SCHEMA_CHANGED');
    const signature=[...found.keys()].sort().join(',');if(seen.has(signature))throw new FetchError('CF 群组列表分页没有前进',false,'PAGINATION_STALLED');seen.add(signature);
    for(const [id,contest] of found)contests.set(id,contest);
    const next=nextPage(page,base,pageNumber);if(next===null)break;pageNumber=next;
   }
  }
  return [...contests.values()].sort((a,b)=>Number(b.id)-Number(a.id));
 }
 override async fetch_batch(handle:string,options:FetchOptions={}):Promise<FetchBatch>{
  try { return await this.fetchGroupedBatch(handle,options); }
  catch(error) {
   options.signal?.throwIfAborted();
   // Optional group access must not block public submissions. Keep backfill strict.
   if(options.mode==='backfill'||!(error instanceof FetchError)||error.code!=='CF_EXTENSION_REQUIRED')throw error;
   const batch=await super.fetch_batch(handle,options);
   return {...batch,complete:false,note:batch.note+'｜群组提交未同步：本地 CF 扩展未连接；公开提交已正常获取'};
  }
 }
 private async fetchGroupedBatch(handle:string,options:FetchOptions):Promise<FetchBatch>{
  const opts=optionsOf(options),backfill=opts.mode==='backfill';
  let progress:{version:number;public:string|null;groups:Record<string,number|null>;paths:Record<string,string>}={version:3,public:'1',groups:{},paths:{}};
  if(backfill&&opts.cursor){
   try{const old=JSON.parse(opts.cursor);if(old?.version===2||old?.version===3){
    if(!(old.public===null||/^[1-9]\d*$/.test(old.public))||!old.groups||typeof old.groups!=='object'||Array.isArray(old.groups)||Object.values(old.groups).some(n=>n!==null&&(!Number.isSafeInteger(n)||Number(n)<1)))throw Error();if(old.version===3&&(!old.paths||typeof old.paths!=='object'||Array.isArray(old.paths)||Object.values(old.paths).some(p=>p!=='my'&&p!=='status')))throw Error();progress={...old,version:3,paths:old.paths??Object.fromEntries(Object.keys(old.groups).map(id=>[id,'status']))};
   }else if(old?.version===1){progress.public=old.public;}else if(Number.isSafeInteger(old)&&old>0){progress.public=String(old);}else throw Error();
   }catch{throw new FetchError('CF 网页回补进度无效，请重新回补历史');}
  }
  const contests=await this.discover(options.signal),rows:Submission[]=[];
  if(!backfill||progress.public!==null){const batch=await super.fetch_batch(handle,{...options,cursor:backfill?progress.public:null});rows.push(...batch.submissions);progress.public=batch.complete?null:batch.nextCursor;}
  for(const contest of contests){
   if(backfill&&progress.groups[contest.id]===null)continue;
   const own=this.viewers.get(contest.group)===handle.toLowerCase();
   let path=backfill&&progress.paths[contest.id]?progress.paths[contest.id]:(own?'my':'status');
   let base='/group/'+contest.group+'/contest/'+contest.id+'/'+path;
   let pageNumber=backfill?progress.groups[contest.id]??1:1,complete=false;const seen=new Set<string>();
   for(let count=0;count<opts.maxPages;count++){
    options.signal?.throwIfAborted();
    let url='https://codeforces.com'+base+(pageNumber===1?'':'/page/'+pageNumber)+'?locale=en&order=BY_ARRIVED_DESC';
    let page=await this.read(url,CF_GROUP_SNAPSHOT,options.signal);
    // Prefer own submissions once the visible page confirms the account identity.
    if(!page.challenge&&page.loggedIn&&pageNumber===1&&base.endsWith('/status')&&page.viewer?.toLowerCase()===handle.toLowerCase()&&(!backfill||!progress.paths[contest.id])){
      base=base.slice(0,-7)+'/my';
      url='https://codeforces.com'+base+(pageNumber===1?'':'/page/'+pageNumber)+'?locale=en&order=BY_ARRIVED_DESC';
      page=await this.read(url,CF_GROUP_SNAPSHOT,options.signal);
    }
    validatePage(page,url);
    if(base.endsWith('/my')&&page.viewer?.toLowerCase()!==handle.toLowerCase())throw new FetchError('CF 登录账号发生变化或无法确认，请使用待同步账号登录后重试',false,'AUTH_REQUIRED');
    if(!page.statusTable)throw new FetchError('CF 比赛提交列表不可见或页面格式已变化',false,'GROUP_ACCESS_FAILED');
    const signature=page.rows.map(row=>row.id).join(',');if(seen.has(signature))throw new FetchError('CF 提交分页没有前进',false,'PAGINATION_STALLED');seen.add(signature);
    rows.push(...parseWebRows(page,contest,handle));
    const next=nextPage(page,base,pageNumber);if(next===null){complete=true;break;}pageNumber=next;
   }
   // One-page overlap prevents ordinary page shifts during backfill from skipping submissions.
   progress.paths[contest.id]=base.endsWith('/my')?'my':'status';
   progress.groups[contest.id]=complete?null:Math.max(1,pageNumber-(opts.maxPages>1?1:0));
  }
  const complete=progress.public===null&&contests.every(c=>progress.groups[c.id]===null);
  return {submissions:unique(rows),source:'https://codeforces.com/group',scope:backfill?'history':'window',acceptedOnly:false,complete,nextCursor:backfill&&!complete?JSON.stringify(progress):null,
   note:'公开提交与登录账号可见的 Group 提交；已读取 '+contests.length+' 场 Group 比赛、'+unique(rows).filter(row=>row.problem_url?.includes('/group/')).length+' 条本账号群组提交。'+(complete?'本轮可见记录已遍历完成。':'本轮最多读取每场 '+opts.maxPages+' 页，完整可见记录请继续回补历史。')};
 }
}
