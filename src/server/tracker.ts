import type { DatabaseSync } from 'node:sqlite';
import type { ProblemMetadata, ProblemRating } from '../domain.ts';
import { danProblemId, danProblemUrl } from '../dx/dan.ts';

type TrackerProblem={id:string;index:string;title:string;url:string;difficulty:number|null;status:'ac'|'attempted'|'none';clean:boolean};

function problemState(rows:{problem_id:string;status:string;submitted_at:number;submission_id:string}[]){
  const by=new Map<string,typeof rows>();
  for(const row of rows){const key=row.problem_id.toUpperCase(),list=by.get(key);if(list)list.push(row);else by.set(key,[row]);}
  return by;
}

export function contestTracker(db:DatabaseSync,userId:number,platform:'codeforces'|'atcoder',catalog:readonly ProblemRating[]|readonly ProblemMetadata[],options:{q?:string;offset:number;limit:number}){
  if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))throw new Error('用户不存在');
  const submitted=db.prepare(`SELECT s.problem_id,s.status,s.submitted_at,s.submission_id FROM submissions s
    JOIN accounts a ON a.id=s.account_id WHERE a.user_id=? AND s.platform=? ORDER BY s.submitted_at,s.submission_id`).all(userId,platform) as
    {problem_id:string;status:string;submitted_at:number;submission_id:string}[];
  const states=problemState(submitted),groups=new Map<string,TrackerProblem[]>();
  for(const raw of catalog as readonly (ProblemRating&ProblemMetadata)[]){
    let contestId:string,id:string,index:string,title:string,url:string,difficulty:number|null;
    if(platform==='codeforces'){
      if(raw.problemId)continue;contestId=String(raw.contestId);id=danProblemId(raw);index=String(raw.index);title=raw.title??id;url=danProblemUrl(id);difficulty=raw.rating;
    }else{
      id=raw.problemId;contestId=raw.contestId??raw.problemUrl?.match(/\/contests\/([^/]+)/)?.[1]??id.replace(/_[^_]+$/,'');
      index=id.startsWith(contestId+'_')?id.slice(contestId.length+1).toUpperCase():id;title=raw.title??id;url=raw.problemUrl??danProblemUrl(id,'atcoder');difficulty=raw.nativeRating??null;
    }
    const rows=states.get(id.toUpperCase())??[],ac=rows.some(row=>row.status==='AC');
    const item:TrackerProblem={id,index,title,url,difficulty,status:ac?'ac':rows.length?'attempted':'none',clean:ac&&rows[0]?.status==='AC'};
    const list=groups.get(contestId);if(list)list.push(item);else groups.set(contestId,[item]);
  }
  const q=(options.q??'').trim().toLowerCase();
  const rows=[...groups].map(([contestId,problems])=>{
    const meta=db.prepare('SELECT name,start_time FROM contests WHERE platform=? AND contest_id=?').get(platform,contestId);
    const name=String(meta?.name??contestId),solved=problems.filter(p=>p.status==='ac').length,clean=problems.filter(p=>p.clean).length;
    return {contestId,name,startTime:meta?.start_time==null?null:Number(meta.start_time),problems,solved,clean,total:problems.length,
      completed:solved===problems.length,cleanCompleted:clean===problems.length};
  }).filter(row=>!q||row.contestId.toLowerCase().includes(q)||row.name.toLowerCase().includes(q))
    .sort((a,b)=>(b.startTime??0)-(a.startTime??0)||b.contestId.localeCompare(a.contestId));
  const visible=rows.slice(options.offset,options.offset+options.limit);
  return {platform,total:rows.length,offset:options.offset,limit:options.limit,summary:{contests:rows.length,completed:rows.filter(r=>r.completed).length,
    cleanCompleted:rows.filter(r=>r.cleanCompleted).length,solvedProblems:states.size?new Set(submitted.filter(r=>r.status==='AC').map(r=>r.problem_id)).size:0},items:visible};
}
