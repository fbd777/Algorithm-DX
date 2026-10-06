import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {Repository} from '../db/database.ts';
import {HttpClient} from './http.ts';
import {CF_GROUP_SNAPSHOT, type PageReader, type PageSnapshot} from './codeforces-group-web.ts';

type Problem = NonNullable<PageSnapshot['problem']>;
type Candidate = {id:string;url:string;title:string};
type Options = {read?:PageReader;signal?:AbortSignal;force?:boolean;onlyProblemId?:string};
const normalize=(s:string)=>s.normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\$\$\$/g,'').replace(/\s+/g,' ').trim();
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const json=<T>(s:unknown,fallback:T):T=>{try{return JSON.parse(String(s));}catch{return fallback;}};
const confirmed=(method:string)=>['content','user_confirmed'].includes(method);

/** Public CF identity; a Group index and a title are not source identities. */
export function sourceProblem(value:string):Candidate{
 const u=new URL(value,'https://codeforces.com');
 const m=u.pathname.match(/^\/(?:problemset\/problem\/(\d+)\/|(?:contest|gym)\/(\d+)\/problem\/)([A-Za-z0-9]+)\/?$/);
 if(u.origin!=='https://codeforces.com'||u.username||u.password||!m||!Number.isSafeInteger(Number(m[1]||m[2]))||Number(m[1]||m[2])<1)throw Error('请填写 CF 普通题或 Gym 原题链接');
 const contest=Number(m[1]||m[2]),index=m[3];
 return {id:contest+':'+index,url:'https://codeforces.com/'+(contest>=100000?'gym/'+contest+'/problem/':'problemset/problem/'+contest+'/')+index,title:''};
}
function titleCandidates(title:string,catalog:any[]):Candidate[]{
 const result=new Map<string,Candidate>();
 for(const p of catalog)if(typeof p?.name==='string'&&normalize(p.name)===normalize(title)&&Number.isSafeInteger(p.contestId)&&p.contestId>0&&typeof p.index==='string'&&/^[A-Za-z0-9]+$/.test(p.index)){
  const c=sourceProblem('https://codeforces.com/contest/'+p.contestId+'/problem/'+p.index);result.set(c.id,{...c,title:p.name});
 }
 return [...result.values()];
}
/** Discovery only: callers must verify content before using this rating. */
export function matchGroupTitle(title:string,catalog:any[]){
 const matches=titleCandidates(title,catalog),p=matches.length===1?catalog.find(p=>p.contestId+':'+p.index===matches[0].id):null;
 return {method:matches.length>1?'ambiguous':matches.length?'title_candidate':'not_found',sourceId:matches.length===1?matches[0].id:null,url:matches.length===1?matches[0].url:null,rating:p?.rating??null};
}
export function sameProblemContent(a:Problem,b:Problem):boolean{
 const aa=normalize(a.statement),bb=normalize(b.statement);
 // Require the full statement including constraints AND every sample.
 return aa.length>=80&&aa===bb&&a.samples.length>0&&a.samples.length===b.samples.length&&a.samples.every((s,i)=>normalize(s.input)===normalize(b.samples[i].input)&&normalize(s.output)===normalize(b.samples[i].output));
}
function evidence(p:Problem){return {statementHash:hash(normalize(p.statement)),sampleHash:hash(JSON.stringify(p.samples.map(s=>[normalize(s.input),normalize(s.output)]))),timeLimit:p.timeLimit,memoryLimit:p.memoryLimit};}
async function catalogFor(repo:Repository,http:HttpClient,signal?:AbortSignal){
 let catalog=repo.get<any[]>('cf:group-source-catalog:v1');
 if(!catalog){const body=await http.json('https://codeforces.com/api/problemset.problems',{signal});if(body?.status!=='OK'||!Array.isArray(body.result?.problems))throw Error('CF 原题清单暂不可用');catalog=body.result.problems;repo.set('cf:group-source-catalog:v1',catalog,21600);}
 return catalog;
}
async function readProblem(repo:Repository,read:PageReader|undefined,url:string,signal?:AbortSignal,force=false):Promise<Problem>{
 const key='cf:group-statement:v1:'+url;
 if(!force){const cached=repo.get<Problem>(key);if(cached)return cached;}
 if(!read)throw Error('读取题面需要连接 0.6.0 或更新版本的 CF 扩展');
 const page=await read(url+'?locale=en',CF_GROUP_SNAPSHOT,signal);
 if(page.challenge||page.status!==200||new URL(page.url).pathname!==new URL(url).pathname||!page.problem?.statement)throw Error('题面不可读，已有提交记录保留；请检查 CF 读取页面');
 repo.set(key,page.problem,86400);return page.problem;
}
async function sourceMetadata(repo:Repository,http:HttpClient,c:Candidate,catalog:any[],page:Problem|undefined,signal?:AbortSignal){
 const [contest,index]=c.id.split(':'),p=catalog.find(p=>String(p.contestId)===contest&&p.index===index);
 if(!p&&!page)throw Error('需要读取原题以确认元信息');
 const rating=p?(Number.isSafeInteger(p.rating)&&p.rating>0?p.rating:null):(Number.isSafeInteger(page?.rating)&&page!.rating!>0?page!.rating!:null);
 let releasedAt=repo.db.prepare("SELECT start_time FROM contests WHERE platform='codeforces' AND contest_id=?").get(Number(contest))?.start_time as number|undefined;
 let timeError:string|undefined;
 if(releasedAt==null){
  try{
  const key='cf:group-source-contests:v1:'+(Number(contest)>=100000?'gym':'regular');let contests=repo.get<any[]>(key);
  if(!contests){const body=await http.json('https://codeforces.com/api/contest.list?gym='+(Number(contest)>=100000),{signal});if(body?.status!=='OK'||!Array.isArray(body.result))throw Error('原比赛时间读取失败');contests=body.result;repo.set(key,contests,21600);}
  const time=contests.find(r=>r.id===Number(contest))?.startTimeSeconds;releasedAt=Number.isSafeInteger(time)&&time>0?time:undefined;
  }catch(error){signal?.throwIfAborted();timeError='原题已确认，原比赛日期暂时读取失败，下次同步重试';}
 }
 return {title:p?.name??page?.title??c.title,rating,releasedAt:releasedAt??null,tags:(p?.tags??page?.tags??[]).filter((x:any)=>typeof x==='string'),timeError};
}
type Resolution={candidate:Candidate|null;method:string;state:string;meta?:Awaited<ReturnType<typeof sourceMetadata>>;evidence?:unknown;candidates:Candidate[];error?:string};
function saveResolution(db:DatabaseSync,id:string,r:Resolution){
 db.exec('SAVEPOINT group_source');try{
  const old=db.prepare('SELECT rating,source_tags_json,source_problem_id,source_released_at FROM cf_group_rating_sources WHERE problem_id=?').get(id);
  if(r.meta?.timeError&&old?.source_problem_id===r.candidate?.id&&old?.source_released_at!=null)r.meta.releasedAt=Number(old.source_released_at);
  // Clear only resolver-owned values. Never touch non-Group submissions.
  if(old?.rating!=null)db.prepare("UPDATE submissions SET difficulty=NULL WHERE platform='codeforces' AND problem_id=? AND problem_url LIKE 'https://codeforces.com/group/%' AND difficulty=?").run(id,old.rating);
  if(old?.source_tags_json&&old.source_tags_json!=='[]')db.prepare("UPDATE submissions SET tags_json='[]' WHERE platform='codeforces' AND problem_id=? AND problem_url LIKE 'https://codeforces.com/group/%' AND tags_json=?").run(id,old.source_tags_json);
  db.prepare(`INSERT INTO cf_group_rating_sources(problem_id,source_problem_id,source_url,rating,method,source_title,source_released_at,source_tags_json,evidence_json,candidates_json,check_state,last_error)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(problem_id) DO UPDATE SET source_problem_id=excluded.source_problem_id,source_url=excluded.source_url,rating=excluded.rating,method=excluded.method,source_title=excluded.source_title,source_released_at=excluded.source_released_at,source_tags_json=excluded.source_tags_json,evidence_json=excluded.evidence_json,candidates_json=excluded.candidates_json,check_state=excluded.check_state,last_error=excluded.last_error,updated_at=unixepoch()`)
   .run(id,r.candidate?.id??null,r.candidate?.url??null,r.meta?.rating??null,r.method,r.meta?.title??null,r.meta?.releasedAt??null,JSON.stringify(r.meta?.tags??[]),JSON.stringify(r.evidence??{}),JSON.stringify(r.candidates),r.state,r.error??r.meta?.timeError??null);
  if(confirmed(r.method)&&r.meta)db.prepare("UPDATE submissions SET difficulty=?,tags_json=? WHERE platform='codeforces' AND problem_id=? AND problem_url LIKE 'https://codeforces.com/group/%'").run(r.meta.rating,JSON.stringify(r.meta.tags),id);
  db.exec('RELEASE group_source');
 }catch(e){db.exec('ROLLBACK TO group_source; RELEASE group_source');throw e;}
}

/** Never rewrites submission identity/title, timestamp or saved practice time. */
export async function refreshGroupRatings(db:DatabaseSync,accountId:number,http=new HttpClient(db),options:Options={}){
 const rows=db.prepare("SELECT DISTINCT problem_id,problem_title,problem_url FROM submissions WHERE account_id=? AND platform='codeforces' AND problem_url LIKE 'https://codeforces.com/group/%'").all(accountId) as {problem_id:string;problem_title:string;problem_url:string}[];
 if(!rows.length)return '';
 const repo=new Repository(db),catalog=await catalogFor(repo,http,options.signal);let failures=0;
 for(const row of rows){
  if(options.onlyProblemId&&row.problem_id!==options.onlyProblemId)continue;
  options.signal?.throwIfAborted();
  const old=db.prepare('SELECT * FROM cf_group_rating_sources WHERE problem_id=?').get(row.problem_id) as any;
  if(!options.force&&old?.method!=='unique_title'&&Number(old?.updated_at)>Date.now()/1000-21600){
   // Replayed submissions may have blank metadata. Reapply verified values even
   // when source revalidation is cached; new submissions share the same identity.
   if(confirmed(old.method))db.prepare("UPDATE submissions SET difficulty=?,tags_json=? WHERE platform='codeforces' AND problem_id=? AND problem_url LIKE 'https://codeforces.com/group/%'").run(old.rating,old.source_tags_json,row.problem_id);
   continue;
  }
  let candidates=titleCandidates(row.problem_title,catalog);
  for(const c of json<Candidate[]>(old?.candidates_json,[])){try{const parsed=sourceProblem(c.url);if(!candidates.some(x=>x.id===parsed.id))candidates.push({...parsed,title:typeof c.title==='string'?c.title:''});}catch{}}
  try{
   if(old?.method==='user_confirmed'){
    const c=sourceProblem(old.source_url),p=catalog.some(p=>p.contestId+':'+p.index===c.id)?undefined:await readProblem(repo,options.read,c.url,options.signal,options.force);
    const meta=await sourceMetadata(repo,http,c,catalog,p,options.signal);
    saveResolution(db,row.problem_id,{candidate:c,method:'user_confirmed',state:meta.rating===null?'unrated':'matched',meta,evidence:json(old.evidence_json,{}),candidates});continue;
   }
   const group=await readProblem(repo,options.read,row.problem_url,options.signal,options.force);
   for(const link of group.sourceLinks){try{const c=sourceProblem(link);if(!candidates.some(x=>x.id===c.id))candidates.unshift(c);}catch{}}
   const exact:{c:Candidate;p:Problem}[]=[];let readFailures=0;
   for(const c of candidates.slice(0,8)){
    try{const p=await readProblem(repo,options.read,c.url,options.signal,options.force);if(sameProblemContent(group,p))exact.push({c,p});}catch(e){options.signal?.throwIfAborted();readFailures++;}
   }
   if(exact.length===1&&!readFailures&&candidates.length<=8){
    const {c,p}=exact[0],meta=await sourceMetadata(repo,http,c,catalog,p,options.signal);
    saveResolution(db,row.problem_id,{candidate:c,method:'content',state:meta.rating===null?'unrated':'matched',meta,evidence:{...evidence(group),source:evidence(p)},candidates});
   }else if(readFailures)throw Error('部分候选题面读取失败，尚不能排除同名歧义');
   else saveResolution(db,row.problem_id,{candidate:null,method:'unresolved',state:exact.length>1||candidates.length>8?'ambiguous':'not_found',evidence:evidence(group),candidates});
  }catch(e){
   options.signal?.throwIfAborted();failures++;const error=(e instanceof Error?e.message:'读取失败').slice(0,250);
   // Network errors do not revoke a previously verified identity.
   if(old&&confirmed(old.method))db.prepare("UPDATE cf_group_rating_sources SET check_state='read_failed',last_error=?,updated_at=unixepoch() WHERE problem_id=?").run(error,row.problem_id);
   else saveResolution(db,row.problem_id,{candidate:null,method:'unresolved',state:'read_failed',candidates,error});
  }
 }
 const states=db.prepare("SELECT DISTINCT r.problem_id,r.method,r.rating FROM cf_group_rating_sources r JOIN submissions s ON s.problem_id=r.problem_id WHERE s.account_id=? AND s.platform='codeforces' AND s.problem_url LIKE 'https://codeforces.com/group/%'").all(accountId);
 const matched=states.filter(r=>confirmed(String(r.method))),rated=matched.filter(r=>r.rating!=null);
 return `Group 原题：${matched.length} 题已确认，${rated.length} 题有官方难度，${matched.length-rated.length} 题原题未评级，${rows.length-matched.length} 题待匹配`+(failures?`（${failures} 题本轮读取未完成）`:'');
}
export function listGroupSources(db:DatabaseSync,accountId:number){
 return db.prepare(`SELECT DISTINCT s.problem_id,s.problem_title,s.problem_url,r.source_problem_id,r.source_url,r.rating,r.method,r.source_title,r.source_released_at,r.check_state,r.last_error,r.candidates_json,
  c.start_time AS group_start_time,c.duration_seconds AS group_duration_seconds
  FROM submissions s LEFT JOIN cf_group_rating_sources r ON r.problem_id=s.problem_id LEFT JOIN contests c ON c.platform='codeforces' AND c.contest_id=CAST(substr(s.problem_id,1,instr(s.problem_id,':')-1) AS INTEGER)
  WHERE s.account_id=? AND s.platform='codeforces' AND s.problem_url LIKE 'https://codeforces.com/group/%' ORDER BY s.problem_id`).all(accountId).map(r=>({...r,candidates:json(r.candidates_json,[]),candidates_json:undefined}));
}
function requireGroup(db:DatabaseSync,accountId:number,id:string){
 if(!db.prepare("SELECT 1 FROM submissions s JOIN accounts a ON a.id=s.account_id WHERE s.account_id=? AND a.is_archived=0 AND s.platform='codeforces' AND s.problem_id=? AND s.problem_url LIKE 'https://codeforces.com/group/%'").get(accountId,id))throw Error('当前账号没有这道群组题目的记录');
}
export function addGroupSourceCandidate(db:DatabaseSync,accountId:number,id:string,url:string){
 requireGroup(db,accountId,id);const c=sourceProblem(url),old=db.prepare('SELECT candidates_json FROM cf_group_rating_sources WHERE problem_id=?').get(id);
 const candidates=json<Candidate[]>(old?.candidates_json,[]).filter(x=>x.id!==c.id);candidates.unshift(c);
 db.prepare("INSERT INTO cf_group_rating_sources(problem_id,method,candidates_json,updated_at) VALUES(?,'unresolved',?,0) ON CONFLICT(problem_id) DO UPDATE SET candidates_json=excluded.candidates_json,updated_at=0").run(id,JSON.stringify(candidates.slice(0,20)));
}
export async function confirmGroupSource(db:DatabaseSync,accountId:number,id:string,url:string,http=new HttpClient(db),read?:PageReader){
 requireGroup(db,accountId,id);const c=sourceProblem(url),repo=new Repository(db),catalog=await catalogFor(repo,http);
 const p=catalog.some(p=>p.contestId+':'+p.index===c.id)?undefined:await readProblem(repo,read,c.url);
 const meta=await sourceMetadata(repo,http,c,catalog,p);
 saveResolution(db,id,{candidate:c,method:'user_confirmed',state:meta.rating===null?'unrated':'matched',meta,evidence:{confirmedAt:Math.floor(Date.now()/1000)},candidates:[c]});
}
export function clearGroupSource(db:DatabaseSync,accountId:number,id:string){requireGroup(db,accountId,id);saveResolution(db,id,{candidate:null,method:'unresolved',state:'pending',candidates:[]});}
