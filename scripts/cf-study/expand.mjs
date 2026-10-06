import fs from 'node:fs/promises';
import path from 'node:path';
import {api,cached,saveJson,saveJsonArray,dataRoot} from './api.mjs';
import {hash,candidates,attachHistory,MAIN_BAND,MAIN_MIN_PRIOR} from './core.mjs';
import {openLedger} from './ledger-store.mjs';
const arg=(name,fallback)=>process.argv.find(x=>x.startsWith('--'+name+'='))?.split('=')[1]??fallback;
const contestCount=Number(arg('contests',40)),historyCount=Number(arg('history-contests',60)),minCoverage=Number(arg('coverage',5));
if([contestCount,historyCount,minCoverage].some(n=>!Number.isInteger(n)||n<1))throw Error('positive integer arguments required');
// Preserve the completed small experiment before replacing active outputs.
const archive=path.join(dataRoot,'runs/first-batch');
try{await fs.access(archive);}catch{
  await fs.mkdir(archive,{recursive:true});
  for(const name of ['manifest.json','processed/samples.json','processed/selected-handles.json']){
    await fs.mkdir(path.dirname(path.join(archive,name)),{recursive:true});
    await fs.copyFile(path.join(dataRoot,name),path.join(archive,name));
  }
  await fs.cp('results/cf-study','results/cf-study-first-batch',{recursive:true});
}
const list=await api('contest.list',{gym:'false'}),problemset=await api('problemset.problems');
const eligible=list.filter(c=>c.phase==='FINISHED'&&c.type!=='IOI'&&/Div\.\s*[123]|Educational/.test(c.name));
const family=c=>/Educational/.test(c.name)?'edu':/Div\.\s*3/.test(c.name)?'div3':/Div\.\s*1/.test(c.name)?'combined':'div2';
function choose(pool,count){
  const queues=['div2','div3','edu','combined'].map(f=>pool.filter(c=>family(c)===f).sort((a,b)=>hash(a.id).localeCompare(hash(b.id))));
  const chosen=[];while(chosen.length<count&&queues.some(q=>q.length))for(const q of queues)if(q.length&&chosen.length<count)chosen.push(q.shift());
  return chosen;
}
const studyPool=eligible.filter(c=>c.startTimeSeconds>=Date.parse('2024-01-01')/1000&&c.startTimeSeconds<Date.parse('2026-01-01')/1000&&(!/Div\.\s*1/.test(c.name)||/Div\.\s*2/.test(c.name)));
const selected=choose(studyPool,contestCount),bins=Array.from({length:13},(_,i)=>800+100*i);
const difficulties=new Map();
for(const p of problemset.problems){if(!difficulties.has(p.contestId))difficulties.set(p.contestId,new Set());difficulties.get(p.contestId).add(p.rating);}
const coverage=()=>Object.fromEntries(bins.map(q=>[q,selected.filter(c=>difficulties.get(c.id)?.has(q)).length]));
while(Object.values(coverage()).some(n=>n<minCoverage)){
  const counts=coverage();
  const next=studyPool.filter(c=>!selected.some(s=>s.id===c.id)).map(c=>({c,score:bins.filter(q=>counts[q]<minCoverage&&difficulties.get(c.id)?.has(q)).length})).filter(x=>x.score).sort((a,b)=>b.score-a.score||hash(a.c.id).localeCompare(hash(b.c.id)))[0];
  if(!next)break;selected.push(next.c);
}
const warmup=choose(eligible.filter(c=>c.startTimeSeconds>=Date.parse('2022-01-01')/1000&&c.startTimeSeconds<Date.parse('2024-01-01')/1000),historyCount);
const manifest={kind:'empirical',cohort:'expanded-certified-history',createdAt:new Date().toISOString(),selection:'2024–2025 family-balanced fixed hash + difficulty coverage; all eligible contestants with certified history',requestedContests:contestCount,historyContestCount:historyCount,minCoverage,contests:[],historyContests:[],errors:[]};
const store=openLedger(path.join(dataRoot,'processed/history-ledger.sqlite'));
for(const c of [...warmup,...selected]){
  try{
    const changes=await api('contest.ratingChanges',{contestId:String(c.id)});
    if(!changes.length)continue;
    manifest.historyContests.push({id:c.id,start:c.startTimeSeconds,rows:changes.length});
    store.appendContest(c.id,c.startTimeSeconds,changes);
    console.log('LEDGER',manifest.historyContests.length,'/',warmup.length+selected.length);
  }catch(e){manifest.errors.push({id:c.id,phase:'rating_changes',reason:e.message});}
  await saveJson(path.join(dataRoot,'expanded-progress.json'),manifest);
}
const exactHistories=new Map();
for(const handle of JSON.parse(await fs.readFile(path.join(archive,'processed/selected-handles.json'),'utf8'))){
  try{exactHistories.set(handle,await cached('user.rating',{handle}));}catch(e){if(e.code!=='ENOENT')throw e;}
}
const all=[],samples=[];
for(const c of selected){
  try{
    const changes=await cached('contest.ratingChanges',{contestId:String(c.id)});if(!changes.length)continue;
    const standings=await api('contest.standings',{contestId:String(c.id)});
    const submissions=await api('contest.status',{contestId:String(c.id)});
    const rows=candidates(standings,changes,submissions);all.push(...rows);
    for(const row of rows){
      const exact=exactHistories.get(row.handle);
      const attached=attachHistory(row,exact??store.historyFor(row.handle));
      if(attached)samples.push({...attached,priorRatedKind:exact?'exact':'certified_lower_bound'});
    }
    manifest.contests.push({id:c.id,name:c.name,start:c.startTimeSeconds,standings:standings.rows.length,submissions:submissions.length,candidates:rows.length});
    const counts=Object.fromEntries(bins.map(q=>[q,samples.filter(r=>r.q===q&&Math.abs(r.oldRating-q)<=MAIN_BAND&&r.priorRated>=MAIN_MIN_PRIOR).length]));
    console.log('STUDY',manifest.contests.length,'/',selected.length,JSON.stringify(counts));
    manifest.baselineCoverage=counts;
  }catch(e){manifest.errors.push({id:c.id,phase:'samples',reason:e.message});}
  await saveJsonArray(path.join(dataRoot,'processed/samples-expanded.json'),samples);
  await saveJson(path.join(dataRoot,'expanded-progress.json'),manifest);
}
await saveJsonArray(path.join(dataRoot,'processed/candidates.json'),all);
await saveJsonArray(path.join(dataRoot,'processed/samples.json'),samples);
await saveJson(path.join(dataRoot,'processed/selected-handles.json'),[...new Set(samples.map(r=>r.handle))]);
manifest.samples=samples.length;manifest.selectedHandles=new Set(samples.map(r=>r.handle)).size;
manifest.exactHistoryHandles=exactHistories.size;manifest.finishedAt=new Date().toISOString();
// 账本覆盖范围以 store 为准重建 —— manifest 是镜像，不是真相。
const knownHistory=new Map(manifest.historyContests.map(x=>[x.id,x]));
manifest.historyContests=store.contestRows().map(r=>({...(knownHistory.get(r.contestId)??{}),id:r.contestId,start:r.start,rows:r.rows,ledger:true}));
await saveJson(path.join(dataRoot,'manifest.json'),manifest);
store.close();
console.log('DONE',JSON.stringify({samples:samples.length,counts:manifest.baselineCoverage,errors:manifest.errors.length,ledgerContests:store.contestCount()}));
if(manifest.errors.length)process.exitCode=1;
