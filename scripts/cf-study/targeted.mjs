// 固定档位（1800/1900/2000）的单次补抓。
// 注意：全档均衡补足请用 backfill.mjs —— 它每轮重算「哪场能补最多未达标档」、不写死档位、
// 也纳入 Div.1。这个脚本保留是因为档位固定、行为可预期，代价是它会重复抓已经覆盖的场次。
import fs from 'node:fs/promises';
import path from 'node:path';
import {api,cached,saveJson,saveJsonArray,dataRoot} from './api.mjs';
import {hash,candidates,attachHistory} from './core.mjs';
import {openLedger} from './ledger-store.mjs';
const arg=(name,fallback)=>process.argv.find(x=>x.startsWith('--'+name+'='))?.split('=')[1]??fallback;
const limit=Number(arg('contests',24));
const manifest=JSON.parse(await fs.readFile(path.join(dataRoot,'manifest.json'),'utf8'));
const existing=new Set(manifest.contests.map(c=>c.id));
const list=await api('contest.list',{gym:'false'}),problemset=await api('problemset.problems');
const target=[1800,1900,2000],diff=new Map();
for(const p of problemset.problems){if(!diff.has(p.contestId))diff.set(p.contestId,new Set());if(target.includes(p.rating))diff.get(p.contestId).add(p.rating);}
const eligible=list.filter(c=>c.phase==='FINISHED'&&c.type!=='IOI'&&c.startTimeSeconds>=Date.parse('2022-01-01')/1000&&c.startTimeSeconds<Date.parse('2026-01-01')/1000&&!existing.has(c.id)&&diff.get(c.id)?.size);
const selected=[...eligible].sort((a,b)=>{
  const sa=diff.get(a.id).size,sb=diff.get(b.id).size;
  return sb-sa||hash(a.id).localeCompare(hash(b.id));
}).slice(0,limit);
const store=openLedger(path.join(dataRoot,'processed/history-ledger.sqlite'));
const all=[],added=[];
for(const c of selected){
  try{
    const changes=await api('contest.ratingChanges',{contestId:String(c.id)});if(!changes.length)continue;
    store.appendContest(c.id,c.startTimeSeconds,changes);
    const standings=await api('contest.standings',{contestId:String(c.id)}),submissions=await api('contest.status',{contestId:String(c.id)});
    const rows=candidates(standings,changes,submissions);all.push(...rows);
    added.push({id:c.id,name:c.name,start:c.startTimeSeconds,standings:standings.rows.length,submissions:submissions.length,candidates:rows.length,ratings:[...diff.get(c.id)]});
    console.log('TARGET',added.length,'/',selected.length,c.id,JSON.stringify([...diff.get(c.id)]),rows.length);
  }catch(e){manifest.errors.push({id:c.id,phase:'targeted',reason:e.message});console.error('TARGET ERROR',c.id,e.message);}
}
const current=JSON.parse(await fs.readFile(path.join(dataRoot,'processed/samples.json'),'utf8'));
const existingKeys=new Set(current.map(r=>`${r.contestId}/${r.handle}/${r.problem}`));
for(const row of all){const attached=attachHistory(row,store.historyFor(row.handle));if(attached){const key=`${row.contestId}/${row.handle}/${row.problem}`;if(!existingKeys.has(key)){current.push({...attached,priorRatedKind:'certified_lower_bound'});existingKeys.add(key);}}}
manifest.contests.push(...added);manifest.targetedContests=(manifest.targetedContests??0)+added.length;manifest.targetedFinishedAt=new Date().toISOString();
// 账本覆盖范围以 store 为准重建，别再手写 rows:0 这种占位。
const knownHistory=new Map(manifest.historyContests.map(x=>[x.id,x]));
manifest.historyContests=store.contestRows().map(r=>({...(knownHistory.get(r.contestId)??{}),id:r.contestId,start:r.start,rows:r.rows,ledger:true}));
manifest.samples=current.length;manifest.selectedHandles=new Set(current.map(r=>r.handle)).size;
await saveJsonArray(path.join(dataRoot,'processed/samples.json'),current);await saveJsonArray(path.join(dataRoot,'processed/samples-expanded.json'),current);await saveJson(path.join(dataRoot,'manifest.json'),manifest);
store.close();
console.log(JSON.stringify({added:added.length,newSamples:current.length,errors:manifest.errors.length,ledgerContests:store.contestCount(),coverage:Object.fromEntries(target.map(q=>[q,current.filter(r=>r.q===q&&Math.abs(r.oldRating-q)<=100&&r.priorRated>=10).length]))},null,2));
