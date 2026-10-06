// 全档均衡补足：找出按主口径样本偏薄的 Rating 档，挑能把它们补起来的比赛。
//
// 与 targeted.mjs 的区别：
//   1. 档位不写死，且每轮重算「这场能补几个还没达标的档」，而不是只看有几道目标档题目；
//   2. 年份与比赛族都不设限，Div.1 / Div.1+Div.2 一并纳入 —— 2000 以上的题基本只在
//      这些场次出现，之前正是选择池排除纯 Div.1 才让高段样本断掉的；
//   3. 判据是「独立比赛数」而不是样本条数：同一场比赛来一千个人也只算一场，因为
//      曲线抖动的根源是独立比赛太少，不是记录条数太少。
import fs from 'node:fs/promises';
import path from 'node:path';
import {api,cached,saveJson,saveJsonArray,dataRoot} from './api.mjs';
import {hash,candidates,attachHistory,MAIN_BAND,MAIN_MIN_PRIOR,UNRATED_CONTEST_NAME} from './core.mjs';
import {openLedger} from './ledger-store.mjs';

const arg=(name,fallback)=>process.argv.find(x=>x.startsWith('--'+name+'='))?.split('=')[1]??fallback;
const flag=name=>process.argv.includes('--'+name);
const perBand=Number(arg('per-band',15));
const fromYear=Number(arg('from',2022)),toYear=Number(arg('to',2026));
const bandLo=Number(arg('band-lo',900)),bandHi=Number(arg('band-hi',2200));
const maxContests=Number(arg('contests',90));
const minInWindow=Number(arg('min-in-window',25));
const dryRun=flag('dry-run');
for(const [name,n] of Object.entries({perBand,fromYear,toYear,bandLo,bandHi,maxContests,minInWindow}))
  if(!Number.isInteger(n)||n<1)throw Error(name+' must be a positive integer');
if(bandHi<bandLo)throw Error('--band-hi must not be below --band-lo');
const bands=[];for(let q=bandLo;q<=bandHi;q+=100)bands.push(q);
const bandSet=new Set(bands);
console.log('BANDS',bands.join(','),'| 每档目标比赛数',perBand,'| 每场该档至少',minInWindow,'位参赛者','| 年份',fromYear+'-'+(toYear-1),'| 上限',maxContests,'场',dryRun?'| DRY RUN':'');

const manifestFile=path.join(dataRoot,'manifest.json');
const samplesFile=path.join(dataRoot,'processed/samples.json');
const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
const samples=JSON.parse(await fs.readFile(samplesFile,'utf8'));
const store=openLedger(path.join(dataRoot,'processed/history-ledger.sqlite'));
const historyFor=store.historyFor;
const seenHandles=new Set(samples.map(r=>r.handle));
const seenKeys=new Set(samples.map(r=>`${r.contestId}/${r.handle}/${r.problem}`));
// 账本里已经有 Rating 变更的比赛不必重复写：主键 (handle, contest_id) 已经保证写不重，
// ledgerContests 只是省掉一次多余的解析。ledger.mjs 抓过的场次会命中缓存后走到这里。
const ledgerContests=store.coveredContests();
console.log('已加载 samples',samples.length,'| 账本覆盖比赛',ledgerContests.size,'| 选手',store.handleCount(),'| 行',store.rowCount());

// 与 analyze.mjs 的主口径严格一致：只算 |oldRating-q|<=MAIN_BAND 且赛前已证实场次 >= MAIN_MIN_PRIOR
// 的记录，并且按 (档位 → 不同 contestId 集合) 统计。两者用的常量都来自 core.mjs。
const coverage=new Map(bands.map(q=>[q,new Set()]));
function noteCoverage(row){
  if(row.priorRated<MAIN_MIN_PRIOR||!bandSet.has(row.q))return;
  if(Math.abs(row.oldRating-row.q)>MAIN_BAND)return;
  coverage.get(row.q).add(row.contestId);
}
for(const r of samples)noteCoverage(r);
const report=()=>Object.fromEntries(bands.map(q=>[q,coverage.get(q).size]));
const pending=()=>bands.filter(q=>coverage.get(q).size<perBand);
console.log('起始覆盖',JSON.stringify(report()));

// 第一批那 120 位选手有完整 user.rating，沿用同样的标记方式（exact / certified_lower_bound）。
const exact=new Map();
try{
  const handles=JSON.parse(await fs.readFile(path.join(dataRoot,'runs/first-batch/processed/selected-handles.json'),'utf8'));
  for(const h of handles){try{exact.set(h,await cached('user.rating',{handle:h}));}catch(e){if(e.code!=='ENOENT')throw e;}}
}catch(e){if(e.code!=='ENOENT')throw e;}
console.log('完整历史（exact）可用选手',exact.size);

const list=await api('contest.list',{gym:'false'});
const problemset=await api('problemset.problems');
// 只关心目标档位的题：候选比赛至少要含一道。
const difficulty=new Map();
for(const p of problemset.problems){
  if(!bandSet.has(p.rating))continue;
  if(!difficulty.has(p.contestId))difficulty.set(p.contestId,new Set());
  difficulty.get(p.contestId).add(p.rating);
}
// 光看题目难度会被骗：Div.3 里确实可能出现 2000 分的题，但 Div.3 只对 <1600 的选手 rated，
// 2000 分的选手参赛根本不产生 Rating 变更，candidates() 一条都产不出来。
// 所以判据要再加一条 —— 这场比赛**真有**该档位的参赛者。账本里存着每场比赛的
// old_rating 全量，直接当证据用，不用额外请求。
const histogram=new Map(); // contestId -> Map(档位 -> 该档参赛人数)
for(const r of store.db.prepare('SELECT contest_id, old_rating FROM rating_changes WHERE old_rating IS NOT NULL').all()){
  const id=Number(r.contest_id);let bins=histogram.get(id);if(!bins){bins=new Map();histogram.set(id,bins);}
  const band=Math.floor(Number(r.old_rating)/100)*100;
  bins.set(band,(bins.get(band)??0)+1);
}
// 与主口径的 MAIN_BAND 对齐：oldRating 落在 [q-100, q+100] 才算这个档位的参赛者。
const participants=(contestId,q)=>{const bins=histogram.get(contestId);return (bins?.get(q-100)??0)+(bins?.get(q)??0);};
const known=new Set(manifest.contests.map(c=>c.id));
// 不能产生任何样本的场次，直接排除，别让贪心算法挑中它们浪费请求：
//   1. 账本里 rows=0 的场次 —— 抓过、但没有 Rating 变更（非 rated / 不公开）；
//   2. manifest.unavailableRatingChanges —— 请求时被 CF 明确拒绝的场次；
//   3. manifest.errors 里同类的历史遗留 —— 「UNAVAILABLE 分支」加进来之前的运行会把它们记成普通错误，
//      那时它们不会进 unavailableRatingChanges，于是每轮都留在候选池里被重新挑中（比赛 1970 就是这样）。
// 三者的共同后果一样：拿不到 oldRating，candidates() 一条记录都产不出来。
const zeroRow=new Set(store.contestRows().filter(r=>r.rows===0).map(r=>r.contestId));
const staleUnavailable=(manifest.errors??[]).filter(e=>/rating changes are unavailable/i.test(e.reason||'')).map(e=>e.id);
const unavailable=new Set([...(manifest.unavailableRatingChanges??[]),...zeroRow,...staleUnavailable]);
const fromSec=Date.UTC(fromYear,0,1)/1000,toSec=Date.UTC(toYear,0,1)/1000;
const pool=list.filter(c=>c.phase==='FINISHED'&&c.type!=='IOI'&&c.startTimeSeconds>=fromSec&&c.startTimeSeconds<toSec&&!known.has(c.id)&&!unavailable.has(c.id)&&!UNRATED_CONTEST_NAME.test(c.name||'')&&difficulty.get(c.id)?.size);
console.log('候选池',pool.length,'场（已排除已入库的',known.size,'场、无 Rating 变更的',unavailable.size,'场）');

const tiers=c=>[...difficulty.get(c.id)].filter(q=>bandSet.has(q)&&participants(c.id,q)>=minInWindow).sort((a,b)=>a-b);
const missing=c=>tiers(c).filter(q=>coverage.get(q).size<perBand);
const score=c=>missing(c).length;

const attempted=new Set(),added=[];
const started=Date.now();
while(added.length<maxContests){
  const need=pending();
  if(!need.length){console.log('所有目标档位都已达标');break;}
  const pick=pool.filter(c=>!attempted.has(c.id)).map(c=>({c,s:score(c)})).filter(x=>x.s>0)
    .sort((a,b)=>b.s-a.s||hash(a.c.id).localeCompare(hash(b.c.id)))[0];
  if(!pick){console.log('候选池里再没有能补这些档位的比赛：',JSON.stringify(need));break;}
  const c=pick.c;attempted.add(c.id);
  const covers=missing(c);
  if(dryRun){
    // 乐观估计：假定这场真能补上它含有的全部未达标档，用来看大概要几场。
    added.push({id:c.id,covers});
    for(const q of covers)coverage.get(q).add(c.id);
    console.log('PLAN',String(added.length).padStart(3),c.id,new Date(c.startTimeSeconds*1000).toISOString().slice(0,10),(c.name||'').slice(0,44),'可补',covers.join('/'));
    continue;
  }
  const id=String(c.id);
  let changes;
  try{changes=await api('contest.ratingChanges',{contestId:id});}
  catch(e){
    if(/rating changes are unavailable/i.test(e.message)){
      manifest.unavailableRatingChanges=[...new Set([...(manifest.unavailableRatingChanges??[]),c.id])];
      unavailable.add(c.id);
      await saveJson(manifestFile,manifest);
      console.log('UNAVAILABLE',c.id,(c.name||'').slice(0,44),'不公开 Rating 变更，永久排除');
    }else{
      manifest.errors.push({id:c.id,phase:'backfill_rating_changes',reason:e.message});
      console.error('ERR ratingChanges',c.id,e.message);
    }
    continue;
  }
  if(!changes.length){console.log('SKIP',c.id,'没有 Rating 变更记录（非 rated），不纳入');continue;}
  if(!ledgerContests.has(c.id)){
    store.appendContest(c.id,c.startTimeSeconds,changes);
    ledgerContests.add(c.id);
  }
  let standings,submissions;
  try{
    standings=await api('contest.standings',{contestId:id});
    submissions=await api('contest.status',{contestId:id});
  }catch(e){manifest.errors.push({id:c.id,phase:'backfill_samples',reason:e.message});console.error('ERR samples',c.id,e.message);continue;}
  const rows=candidates(standings,changes,submissions);
  let appended=0;
  for(const row of rows){
    const attached=attachHistory(row,exact.get(row.handle)??historyFor(row.handle));
    if(!attached)continue;
    noteCoverage(attached);
    const key=`${attached.contestId}/${attached.handle}/${attached.problem}`;
    if(seenKeys.has(key))continue;
    seenKeys.add(key);seenHandles.add(attached.handle);
    samples.push({...attached,priorRatedKind:exact.has(attached.handle)?'exact':'certified_lower_bound'});
    appended++;
  }
  manifest.contests.push({id:c.id,name:c.name,start:c.startTimeSeconds,standings:standings.rows.length,submissions:submissions.length,candidates:rows.length,backfillTiers:tiers(c)});
  if(!manifest.historyContests.some(x=>x.id===c.id))manifest.historyContests.push({id:c.id,start:c.startTimeSeconds,rows:changes.length,backfill:true});
  manifest.samples=samples.length;manifest.selectedHandles=seenHandles.size;
  added.push({id:c.id,covers,appended,coverage:report()});
  await saveJsonArray(samplesFile,samples);
  await fs.copyFile(samplesFile,path.join(dataRoot,'processed/samples-expanded.json'));
  await saveJson(manifestFile,manifest);
  await saveJson(path.join(dataRoot,'backfill-progress.json'),{startedAt:new Date(started).toISOString(),perBand,bands,fromYear,toYear,contestsAdded:added.length,maxContests,log:added});
  console.log('BACKFILL',added.length+'/'+maxContests,c.id,new Date(c.startTimeSeconds*1000).toISOString().slice(0,10),(c.name||'').slice(0,40),'candidates='+rows.length,'appended='+appended,'coverage='+JSON.stringify(report()),'elapsed='+Math.round((Date.now()-started)/1000)+'s');
}
if(!dryRun){
  manifest.backfillFinishedAt=new Date().toISOString();
  await saveJson(manifestFile,manifest);
}
const final=report();
const short=Object.fromEntries(bands.map(q=>[q,perBand-final[q]]).filter(([,v])=>v>0));
console.log('DONE',JSON.stringify({dryRun,contestsAdded:added.length,coverage:final,stillShortByContests:short,errors:manifest.errors.length,samples:samples.length,ledgerContests:store.contestCount(),ledgerRows:store.rowCount()},null,2));
store.close();
if(dryRun)console.log('DRY RUN 是乐观估计：假定每场都能把它含有的未达标档位补满，实际需要的场数只会更多。');
