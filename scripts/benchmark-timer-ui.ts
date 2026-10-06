import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { openProbe } from './probe-context.mjs';
import { openDatabase, Repository } from '../src/db/database.ts';
import { startTimer } from '../src/dx/timer.ts';
import { SyncJobRunner } from '../src/server/sync-job.ts';
import { handleApi } from '../src/server/api.ts';

// Isolated manual-check benchmark: real public CF request, real app UI, no background scheduler.
const { db: production, userId } = openProbe();
const sample = production.prepare(`SELECT s.problem_id,s.submitted_at,a.handle FROM submissions s
  JOIN accounts a ON a.id=s.account_id WHERE a.user_id=? AND a.is_archived=0 AND s.platform='codeforces'
  AND s.status='AC' AND CAST(s.problem_id AS INTEGER)<100000 ORDER BY s.submitted_at DESC LIMIT 1`).get(userId);
production.close();
if (!sample) throw new Error('所选用户没有可用于测试的 Codeforces AC 记录，请先同步。');
let ctx:any, clickAt=0, trial=0;
function reset() {
  ctx?.db.close();
  const db=openDatabase(':memory:'), repo=new Repository(db);
  const user=repo.createUser('计时实测',true);
  repo.addAccount(user,'codeforces',String(sample.handle));
  startTimer(db,{userId:user,problemId:String(sample.problem_id),practiceKind:'first',requestId:'benchmark-timer-'+(++trial)},Number(sample.submitted_at)-120);
  const jobs=new SyncJobRunner(()=>db,'unused');
  const original=jobs.markDataChanged.bind(jobs);
  jobs.markDataChanged=()=>{original();console.log(JSON.stringify({trial,serverDetectedMs:Date.now()-clickAt}));};
  ctx={db,dbPath:':memory:',platforms:['codeforces'],envFile:'unused',openWrite:()=>db,syncJobs:jobs};
}
reset();
const instrumentation=`<script>
document.addEventListener('DOMContentLoaded',()=>{
 const result=document.createElement('output');result.id='benchmarkMetric';
 result.style='position:fixed;bottom:4px;left:4px;z-index:99999;background:white;color:black;padding:6px';
 result.textContent='等待点击检查 AC';document.body.append(result);
 let started;
 document.getElementById('timerCheck').addEventListener('click',()=>{started=performance.now();},true);
 new MutationObserver(()=>{
  if(started!=null&&document.querySelector('.dx-result')?.open){
   result.textContent='检查 → 弹窗：'+(performance.now()-started).toFixed(0)+' ms';started=null;
  }
 }).observe(document.body,{attributes:true,subtree:true,attributeFilter:['open']});
});</script>`;
createServer(async(req,res)=>{
 try {
  const url=new URL(req.url!,'http://127.0.0.1:8799');
  if(url.pathname==='/benchmark/reset'&&req.method==='POST'){reset();res.end('reset');return;}
  if(url.pathname.startsWith('/api/')){
   res.setHeader('Content-Type','application/json');
   if(url.pathname==='/api/sync'){res.end(JSON.stringify({job:null}));return;}
   const parts=[];for await(const part of req)parts.push(part);
   if(url.pathname==='/api/dx/timer/check')clickAt=Date.now();
   const result=await handleApi(ctx,{method:req.method!,pathname:url.pathname,params:url.searchParams,body:parts.length?JSON.parse(Buffer.concat(parts).toString()):undefined});
   res.statusCode=result.status;res.end(JSON.stringify(result.body));return;
  }
  const path=resolve('public','.'+url.pathname);
  if(!path.startsWith(resolve('public')+sep)){res.statusCode=404;res.end();return;}
  const mime:any={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
  res.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream');
  const content=readFileSync(path);
  res.end(extname(path)==='.html'?content.toString().replace('</head>',instrumentation+'</head>'):content);
 }catch(e){res.statusCode=500;res.end(String(e));}
}).listen(8799,'127.0.0.1',()=>console.log(JSON.stringify({port:8799,problem:sample.problem_id,trial})));
