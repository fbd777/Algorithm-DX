import { BaseFetcher, FetchError, hintCredential, type ProbeResult } from './base.ts';
import { HttpClient } from './http.ts';
import { optionsOf, identifier, timestamp, submission, unique } from './common.ts';
import type { Submission, SubmissionStatus, FetchOptions, FetchBatch } from '../domain.ts';
import { languageLabel } from '../../public/stat-labels.js';

/** 洛谷对非浏览器客户端会下发挑战 Cookie，因此固定声明一个常规浏览器 UA。 */
export const LUOGU_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface LuoguProfile{uid:string;name:string;slogan:string|null;registerTime:number|null;}

/**
 * 从用户页的 lentille-context 里读取公开资料。
 * 2026-09-16 实测：/user/<uid> 无需登录即可读取，但必须先接受一次挑战 Cookie（见 HttpClient.textFollowingChallenge）。
 */
export function parseLuoguProfile(text:string):LuoguProfile{
  const context=text.match(/<script\b[^>]*id=["']lentille-context["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!context)throw new FetchError('Luogu profile page did not contain lentille-context',false,'SCHEMA_CHANGED');
  let body:any;
  try{body=JSON.parse(context[1]);}
  catch{throw new FetchError('Invalid Luogu profile data',false,'SCHEMA_CHANGED');}
  const user=body?.currentData?.user??body?.data?.user;
  if(user?.uid==null||typeof user.name!=='string'||!user.name.trim())throw new FetchError('Luogu profile is missing uid or name',false,'SCHEMA_CHANGED');
  return{uid:String(user.uid),name:user.name.trim(),
    slogan:typeof user.slogan==='string'?user.slogan:null,
    registerTime:Number.isInteger(user.registerTime)?user.registerTime:null};
}

export function parseLuogu(text:string):any{
  let body:any;
  try{body=JSON.parse(text);}catch{
    const context=text.match(/<script\b[^>]*id=["']lentille-context["'][^>]*>([\s\S]*?)<\/script>/i);
    const legacy=text.match(/decodeURIComponent\(["']([^"']+)["']\)/);
    try{body=context?JSON.parse(context[1]):legacy?JSON.parse(decodeURIComponent(legacy[1])):null;}
    catch{throw new FetchError('Invalid Luogu page data',false,'SCHEMA_CHANGED');}
  }
  if(body?.status===401||body?.status===403||body?.data?.errorData?.needLogin)throw new FetchError('Luogu login required',false,'AUTH_REQUIRED');
  const records=body?.currentData?.records??body?.data?.records;
  if(!Array.isArray(records?.result)||!Number.isInteger(records.count))throw new FetchError('Luogu record list unavailable or schema changed',false,'SCHEMA_CHANGED');
  return records;
}
export function normalizeLuogu(s:any):Submission{
  // 2026-09-17 实测出现过的码：2（score=null，编译错误）、12（score=100，满分）、14（score=25，未满分）。
  // 14 是洛谷的 "Unaccepted"：判完了但没拿满分，具体是 WA/TLE 还是部分分不明确，**不能当成 WA**，
  // 所以保持 OTHER 并原样保留 raw_status。宁可粗一点，也不编一个站不住的判题结果。
  const map:Record<number,SubmissionStatus>={0:'PENDING',1:'PENDING',2:'CE',4:'MLE',5:'TLE',6:'WA',7:'RE',12:'AC'};
  return submission('luogu',{
    submission_id:identifier(s.id,'submission id'),problem_id:identifier(s.problem?.pid,'problem id'),
    // 2026-09-17 实测：problem 的字段是 pid / type / name / difficulty / fullScore / submitted / accepted，
    // **没有 title**。早先按 title 解析会让每次同步都以「Missing problem title」失败。
    problem_title:identifier(s.problem?.name,'problem name'),problem_url:`https://www.luogu.com.cn/problem/${encodeURIComponent(s.problem.pid)}`,
    difficulty:s.problem.difficulty??null,status:map[s.status]??'OTHER',raw_status:s.status==null?null:String(s.status),
    language:s.language==null?null:languageLabel(`Luogu language #${s.language}`),execution_time:s.time??null,memory:s.memory==null?null:s.memory*1024,
    // 洛谷的 score 是部分分（满分以 problem.fullScore 为准）。编译错误时实测为 null，保持 null。
    score:typeof s.score==='number'&&Number.isFinite(s.score)?s.score:null,
    submitted_at:timestamp(s.submitTime),
  });
}
export class LuoguFetcher extends BaseFetcher{
  readonly platform='luogu';http:HttpClient;cookie:string|undefined;
  constructor(http:HttpClient,cookie?:string){super();this.http=http;this.cookie=cookie;}
  async fetch_recent_submissions(handle:string,limit=100):Promise<Submission[]>{return(await this.fetch_batch(handle,{limit})).submissions;}
  /**
   * 只凭数字 UID 解析公开资料，不需要登录 Cookie。
   * 用途：绑定账号时确认「这串数字确实是我」，并把昵称写进库里供面板显示。
   */
  async fetch_profile(handle:string):Promise<LuoguProfile>{
    if(!/^[1-9]\d*$/.test(handle))throw new FetchError('Luogu requires a numeric user ID');
    const url=`https://www.luogu.com.cn/user/${handle}`;
    const profile=parseLuoguProfile(await this.http.textFollowingChallenge(url,{headers:{'user-agent':LUOGU_UA,Accept:'text/html'}}));
    if(profile.uid!==handle)throw new FetchError('Luogu returned a profile for another user',false,'ACCOUNT_MISMATCH');
    return profile;
  }
  /**
   * 绑定前探测：复用 `fetch_profile`（免登录的个人主页），它本来就顺带校验 uid 是否匹配。
   *
   * **只有「平台返回的确实是另一个 uid」才算 missing** —— 那是一个确定的反证。
   * 解析失败、404、被反爬挡住一律归 unknown：那些更可能是页面改版或这一轮没通过挑战，
   * 拿它们当「不存在」会挡住本来合法的绑定。
   */
  async probe_handle(handle:string):Promise<ProbeResult>{
    try{
      const profile=await this.fetch_profile(handle);
      return {status:'found',displayName:profile.name||null};
    }catch(error){
      if(error instanceof FetchError&&error.code==='ACCOUNT_MISMATCH')return {status:'missing',reason:'洛谷返回的资料不是这个 uid'};
      return {status:'unknown',reason:error instanceof Error?error.message:'洛谷探测失败'};
    }
  }
  async fetch_batch(handle:string,options:FetchOptions={}):Promise<FetchBatch>{
    const opts=optionsOf(options),backfill=opts.mode==='backfill';
    if(!/^[1-9]\d*$/.test(handle))throw new FetchError('Luogu requires a numeric user ID');
    if(!this.cookie)throw new FetchError('Luogu requires a login Cookie; set ALGO_COOKIE_LUOGU in .env (one Cookie covers every Luogu account you watch)',false,'AUTH_REQUIRED');
    let page=backfill?Number(opts.cursor??1):1,complete=false;
    if(!Number.isSafeInteger(page)||page<1)throw new FetchError('Invalid Luogu page cursor');
    const rows:Submission[]=[];
    for(let i=0;i<opts.maxPages;i++,page++){
      const url=`https://www.luogu.com.cn/record/list?user=${handle}&page=${page}`;
      // 401 既可能是 Cookie 过期，也可能是压根没配；两种都得说明「去哪儿修」。
      const records=await this.http.textFollowingChallenge(url,{headers:{Cookie:this.cookie,Accept:'text/html','user-agent':LUOGU_UA}})
        .then(parseLuogu)
        .catch((error:unknown)=>hintCredential(error,'ALGO_COOKIE_LUOGU','Luogu'));
      for(const r of records.result){
        if(r.user?.uid!=null&&String(r.user.uid)!==handle)throw new FetchError('Luogu returned records for another user',false,'ACCOUNT_MISMATCH');
      }
      rows.push(...records.result.map(normalizeLuogu));
      // Luogu pages are 20 records; use explicit page size if provided.
      const size=Number(records.perPage??20);
      if(records.result.length===0||page*size>=records.count){complete=true;break;}
      if(!backfill&&opts.since!==undefined&&rows.some(row=>row.submitted_at<opts.since)){page++;break;}
      if(!backfill&&rows.length>=opts.limit){page++;break;}
    }
    const all=unique(rows);
    return{submissions:backfill?all:all.slice(0,opts.limit),source:'https://www.luogu.com.cn/record/list',scope:backfill?'history':'recent',acceptedOnly:false,
      complete:complete&&(backfill||all.length<=opts.limit),nextCursor:complete?null:String(page),note:'洛谷登录态可见记录；私有、比赛隐藏记录可能不可见。语言暂保存官方枚举 ID。'};
  }
}
