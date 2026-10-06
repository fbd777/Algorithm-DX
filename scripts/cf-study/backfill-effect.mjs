// 量化「补比赛」这一步本身的效果：把 backfill 加进来的比赛从样本里剔除，
// 用与 analyze.mjs 完全相同的口径重算一遍「补之前」，逐档并排。
//
// 为什么要单独一个脚本：会话里的「前」通常是上一次 analyze 留下的 summary.json，
// 而那份文件可能是在账本重建之前跑的（口径一样但数据文件不同），拿它对比会把
// 「账本重建」和「补比赛」两步的效果混在一起。这个脚本只剔除 backfill 加的比赛，
// 其余一切不变，所以差值是干净的。
import fs from 'node:fs/promises';
import {MAIN_BAND,MAIN_MIN_PRIOR,FIT_MIN_Q,FIT_MAX_Q} from './core.mjs';

const samples=JSON.parse(await fs.readFile('data/cf-study/processed/samples.json','utf8'));
const progress=JSON.parse(await fs.readFile('data/cf-study/backfill-progress.json','utf8'));
const added=new Set(progress.log.map(x=>x.id));
const before=samples.filter(r=>!added.has(r.contestId));
const bins=[];for(let q=FIT_MIN_Q;q<=FIT_MAX_Q;q+=100)bins.push(q);

const stat=rows=>bins.map(q=>{
  const selected=rows.filter(r=>r.q===q&&Math.abs(r.oldRating-q)<=MAIN_BAND&&r.priorRated>=MAIN_MIN_PRIOR);
  return {q,contests:new Set(selected.map(r=>r.contestId)).size,samples:selected.length,solved:selected.filter(r=>r.event).length,players:new Set(selected.map(r=>r.handle)).size};
});
const a=stat(before),b=stat(samples);
const table=bins.map((q,i)=>({
  rating:q,
  contestsBefore:a[i].contests,contestsAfter:b[i].contests,
  samplesBefore:a[i].samples,samplesAfter:b[i].samples,
  playersBefore:a[i].players,playersAfter:b[i].players,
  solvedBefore:a[i].solved,solvedAfter:b[i].solved,
  contestsAdded:b[i].contests-a[i].contests,
}));
const sum=(rows,key)=>rows.reduce((n,r)=>n+r[key],0);
const summary={
  backfilledContests:added.size,
  totalContestsBefore:new Set(before.map(r=>r.contestId)).size,
  totalContestsAfter:new Set(samples.map(r=>r.contestId)).size,
  observationsBefore:before.length,
  observationsAfter:samples.length,
  mainCohortBefore:sum(a,'samples'),
  mainCohortAfter:sum(b,'samples'),
  mainCohortSolvedBefore:sum(a,'solved'),
  mainCohortSolvedAfter:sum(b,'solved'),
  binsUnderTenContestsBefore:table.filter(r=>r.contestsBefore<10).map(r=>r.rating),
  binsUnderTenContestsAfter:table.filter(r=>r.contestsAfter<10).map(r=>r.rating),
  table,
};
const head='rating,contestsBefore,contestsAfter,samplesBefore,samplesAfter,playersBefore,playersAfter,solvedBefore,solvedAfter';
const csv=head+'\n'+table.map(r=>[r.rating,r.contestsBefore,r.contestsAfter,r.samplesBefore,r.samplesAfter,r.playersBefore,r.playersAfter,r.solvedBefore,r.solvedAfter].join(',')).join('\n')+'\n';
await fs.mkdir('results/cf-study',{recursive:true});
await fs.writeFile('results/cf-study/backfill_effect.csv',csv);
await fs.writeFile('results/cf-study/backfill_effect.json',JSON.stringify(summary,null,2));
console.log('Rating  独立比赛        主口径样本        唯一选手        AC');
for(const r of table){
  console.log(
    String(r.rating).padEnd(7)+
    `${r.contestsBefore}→${r.contestsAfter}`.padEnd(17)+
    `${r.samplesBefore}→${r.samplesAfter}`.padEnd(18)+
    `${r.playersBefore}→${r.playersAfter}`.padEnd(15)+
    `${r.solvedBefore}→${r.solvedAfter}`
  );
}
console.log(JSON.stringify({
  补进的比赛:summary.backfilledContests,
  总比赛数:`${summary.totalContestsBefore}→${summary.totalContestsAfter}`,
  样本行数:`${summary.observationsBefore}→${summary.observationsAfter}`,
  主口径样本:`${summary.mainCohortBefore}→${summary.mainCohortAfter}`,
  主口径AC:`${summary.mainCohortSolvedBefore}→${summary.mainCohortSolvedAfter}`,
  补前独立比赛少于10的档位:summary.binsUnderTenContestsBefore,
  补后独立比赛少于10的档位:summary.binsUnderTenContestsAfter,
},null,2));
