// Rebuild processed records entirely offline from cached official responses.
//
// 历史证据来自两处，优先级不同：
//   exact  —— 那 120 位选手有完整 user.rating，priorRated 是精确值；
//   ledger —— 其余选手用账本，priorRated 是**下界**（标记 certified_lower_bound）。
// 账本覆盖得越全，这个下界越接近真值，主口径「赛前已参赛 ≥10 场」的漏筛就越少。
import fs from 'node:fs/promises';
import {hash,candidates,attachHistory} from './core.mjs';
import {cached,saveJsonArray} from './api.mjs';
import {openLedger} from './ledger-store.mjs';
const root='data/cf-study';
async function read(method,params={}){
  return cached(method,params);
}
const manifest=JSON.parse(await fs.readFile(root+'/manifest.json','utf8'));
const selected=new Set(JSON.parse(await fs.readFile(root+'/processed/selected-handles.json','utf8')));
const all=[];
for(const c of manifest.contests){
  const params={contestId:String(c.id)};
  all.push(...candidates(await read('contest.standings',params),await read('contest.ratingChanges',params),await read('contest.status',params)));
}
const output=[];let missing=0;
if(manifest.cohort==='expanded-certified-history'){
  const store=openLedger(root+'/processed/history-ledger.sqlite');
  const historyFor=store.historyFor;
  const exactHandles=JSON.parse(await fs.readFile(root+'/runs/first-batch/processed/selected-handles.json','utf8'));
  const exact=new Map();
  for(const handle of exactHandles){try{exact.set(handle,await read('user.rating',{handle}));}catch(e){if(e.code!=='ENOENT')throw e;}}
  let exactUsed=0,ledgerUsed=0,noHistory=0;
  for(const row of all){
    const history=exact.get(row.handle);
    const source=history??historyFor(row.handle);
    if(history)exactUsed++;
    else if(source.length)ledgerUsed++;
    else noHistory++;
    const attached=attachHistory(row,source);
    if(attached)output.push({...attached,priorRatedKind:history?'exact':'certified_lower_bound'});
  }
  // priorRated 的分布决定了主口径门槛筛掉多少 —— 这是样本量的直接瓶颈，所以每次都打出来。
  const buckets={};
  for(const r of output){const b=r.priorRated>=20?'>=20':r.priorRated>=10?'10-19':r.priorRated>=5?'5-9':r.priorRated>=1?'1-4':'0';buckets[b]=(buckets[b]||0)+1;}
  console.log('历史来源：exact',exactUsed,'| 账本',ledgerUsed,'| 无任何历史',noHistory);
  console.log('priorRated 分布：',JSON.stringify(buckets));
  console.log('账本覆盖',store.contestCount(),'场、',store.rowCount(),'行、',store.handleCount(),'位选手');
  store.close();
}else for(const handle of selected){
  let history;
  try{history=await read('user.rating',{handle});}catch(e){if(e.code==='ENOENT'){missing++;continue;}throw e;}
  for(const row of all.filter(r=>r.handle===handle)){const attached=attachHistory(row,history);if(attached)output.push(attached);}
}
for(const [name,value]of [['candidates',all],['samples',output]]){
  const file=`${root}/processed/${name}.json`;
  // 流式写：这两个文件是接下来会长大的，拼成一个大字符串会在约 512 MiB 处抛 RangeError。
  await saveJsonArray(file,value);
  console.log(name+'.json',((await fs.stat(file)).size/1048576).toFixed(1)+' MB');
}
console.log(JSON.stringify({offline:true,candidates:all.length,samples:output.length,missingHistories:missing}));
