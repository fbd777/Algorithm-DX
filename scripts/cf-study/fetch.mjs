import fs from 'node:fs/promises';
import path from 'node:path';
import {hash,candidates,attachHistory} from './core.mjs';
const root=path.resolve('data/cf-study');
await fs.mkdir(root,{recursive:true});
async function saveJson(file,value){
  await fs.writeFile(file+'.tmp',JSON.stringify(value,null,2));
  await fs.rename(file+'.tmp',file);
}
let last=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,params={}){
  const query=new URLSearchParams(params),key=hash(method+'?'+query),file=path.join(root,'raw',method,key+'.json');
  try{return JSON.parse(await fs.readFile(file,'utf8')).result;}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(path.dirname(file),{recursive:true});
  for(let attempt=0;attempt<4;attempt++){
    await sleep(Math.max(0,6100-(Date.now()-last)));last=Date.now();
    const url='https://codeforces.com/api/'+method+'?'+query;
    try{
      console.log('GET',method,query.toString());
      const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw Error('HTTP '+response.status+' '+(await response.text()).slice(0,500));
      const body=await response.json();if(body.status!=='OK')throw Error(body.comment);
      const record={...body,source:url,fetchedAt:new Date().toISOString()};
      await fs.writeFile(file+'.tmp',JSON.stringify(record));await fs.rename(file+'.tmp',file);return body.result;
    }catch(e){console.error(e.message);if(attempt===3)throw e;await sleep(6100*2**attempt);}
  }
}
const arg=(name,fallback)=>process.argv.find(x=>x.startsWith('--'+name+'='))?.split('=')[1]??fallback;
const maxHistories=Number(arg('histories','80')),contestCount=Number(arg('contests','8'));
if(!Number.isInteger(maxHistories)||maxHistories<1||!Number.isInteger(contestCount)||contestCount<1)throw Error('histories and contests must be positive integers');
const list=await api('contest.list',{gym:'false'});
const eligible=list.filter(c=>c.phase==='FINISHED'&&c.type!=='IOI'&&c.startTimeSeconds>=Date.parse('2024-01-01')/1000&&c.startTimeSeconds<Date.parse('2026-01-01')/1000&&/Div\.\s*[23]|Educational|Div\.\s*1\s*\+\s*Div\.\s*2/.test(c.name));
// Deterministic random ordering within each family, then round robin; no outcome-based selection.
const family=c=>/Educational/.test(c.name)?'edu':/Div\.\s*3/.test(c.name)?'div3':/Div\.\s*1/.test(c.name)?'combined':'div2';
const queues=['div2','div3','edu','combined'].map(f=>eligible.filter(c=>family(c)===f).sort((a,b)=>hash(a.id).localeCompare(hash(b.id))));
const selected=[];while(selected.length<contestCount&&queues.some(q=>q.length)){for(const q of queues)if(q.length&&selected.length<contestCount)selected.push(q.shift());}
const problemset=await api('problemset.problems');
const difficultyByContest=new Map();
for(const p of problemset.problems){if(!difficultyByContest.has(p.contestId))difficultyByContest.set(p.contestId,new Set());difficultyByContest.get(p.contestId).add(p.rating);}
const missing=new Set(Array.from({length:13},(_,i)=>800+i*100));
for(const c of selected)for(const q of difficultyByContest.get(c.id)||[])missing.delete(q);
// Fill missing difficulty coverage using only published problem ratings, never solve outcomes.
while(missing.size){
  const choices=eligible.filter(c=>!selected.some(s=>s.id===c.id)).map(c=>({c,coverage:[...(difficultyByContest.get(c.id)||[])].filter(q=>missing.has(q)).length})).filter(x=>x.coverage).sort((a,b)=>b.coverage-a.coverage||hash(a.c.id).localeCompare(hash(b.c.id)));
  if(!choices.length)break;
  const c=choices[0].c;selected.push(c);for(const q of difficultyByContest.get(c.id)||[])missing.delete(q);
}
const manifest={kind:'empirical',createdAt:new Date().toISOString(),selection:'2024–2025 deterministic hash, round robin Div2/Div3/Edu/combined, plus problem-rating coverage top-up',requestedContests:contestCount,maxHistories,contests:[],errors:[]};
const all=[];
for(const c of selected){
  try{
    const changes=await api('contest.ratingChanges',{contestId:String(c.id)});if(!changes.length){manifest.errors.push({id:c.id,reason:'no_rating_changes'});continue;}
    const standings=await api('contest.standings',{contestId:String(c.id)});
    const submissions=await api('contest.status',{contestId:String(c.id)});
    const rows=candidates(standings,changes,submissions);all.push(...rows);
    manifest.contests.push({id:c.id,name:c.name,start:c.startTimeSeconds,standings:standings.rows.length,submissions:submissions.length,candidates:rows.length});
    console.log('CONTEST',c.id,rows.length,'candidates');
  }catch(e){manifest.errors.push({id:c.id,reason:e.message});}
  await saveJson(path.join(root,'manifest.json'),manifest);
}
await fs.mkdir(path.join(root,'processed'),{recursive:true});
await fs.writeFile(path.join(root,'processed/candidates.json'),JSON.stringify(all));
// Stratify only on pre-outcome rating proximity/problem rating; each q gets a turn.
const buckets=Array.from({length:18},(_,i)=>800+i*100).map(q=>[...new Set(all.filter(r=>r.q===q).map(r=>r.handle))].sort((a,b)=>hash(a).localeCompare(hash(b))));
const handles=new Set();while(handles.size<maxHistories&&buckets.some(b=>b.length)){for(const b of buckets){if(b.length&&handles.size<maxHistories)handles.add(b.shift());}}
await fs.writeFile(path.join(root,'processed/selected-handles.json'),JSON.stringify([...handles]));
const samples=[];
for(const handle of handles){
  try{
    const history=await api('user.rating',{handle});
    for(const r of all.filter(r=>r.handle===handle)){
      const attached=attachHistory(r,history);if(attached)samples.push(attached);
    }
  }catch(e){manifest.errors.push({handle,reason:e.message});}
  await saveJson(path.join(root,'processed/samples.json'),samples);
  console.log('HISTORY',samples.length,'samples');
}
manifest.selectedHandles=handles.size;manifest.samples=samples.length;
manifest.finishedAt=new Date().toISOString();await saveJson(path.join(root,'manifest.json'),manifest);
console.log('DONE',manifest.samples);
if(manifest.errors.length||!samples.length)process.exitCode=1;
