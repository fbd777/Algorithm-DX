// 经验统计汇总：18 档 × 3 个 Rating 窗口 × 3 个稳定性门槛 = 162 个格子的点估计与区间。
//
// 档位筛选、加权、点估计全部取自 core.mjs（bandRows + binEstimate）。
// 这里只负责**编排**：跑 bootstrap 补区间、写出 CSV、为主口径留 KM 曲线。
// 留出验证（validate.mjs）调用的是同一对函数，因此验证的正是生产用的那个估计量。
import fs from 'node:fs/promises';
import {bandRows,binEstimate,bootstrapPair,km,MAIN_BAND,MAIN_MIN_PRIOR} from './core.mjs';
const root='results/cf-study';await fs.mkdir(root+'/plots',{recursive:true});
const samples=JSON.parse(await fs.readFile('data/cf-study/processed/samples.json','utf8'));
const manifest=JSON.parse(await fs.readFile('data/cf-study/manifest.json','utf8'));
const reps=Number(process.argv.find(x=>x.startsWith('--bootstrap='))?.split('=')[1]??1000);
if(!Number.isInteger(reps)||reps<100)throw Error('bootstrap must be integer >=100');
const output=[],curves=[];
for(const band of [50,100,150])for(const minPrior of [5,10,20])for(let q=800;q<=2500;q+=100){
  const rows=bandRows(samples,q,band,minPrior);
  const {summary:core,survival}=binEstimate(rows);
  const pairCI=bootstrapPair(rows,reps,20260916+q+band+minPrior),ci=pairCI.km;
  const summary={
    kind:'empirical',q,band,minPrior,...core,
    ciLowSeconds:ci.low,ciHighSeconds:ci.high,bootstrapIdentifiedFraction:ci.identified,ciStatus:ci.reason??'finite',
    successMedianCiLowSeconds:pairCI.success.low,successMedianCiHighSeconds:pairCI.success.high,successMedianCiStatus:pairCI.success.reason??'finite',
    differenceCiLowSeconds:pairCI.difference.low,differenceCiHighSeconds:pairCI.difference.high,differenceCiStatus:pairCI.difference.reason??'finite',
  };
  output.push(summary);
  if(band===MAIN_BAND&&minPrior===MAIN_MIN_PRIOR){
    const solved=rows.filter(r=>r.event),successMedian=summary.successP50Seconds;
    curves.push({q,kind:'empirical',normalization:'KM median',t97KmSeconds:survival.median,curve:survival.curve.map(p=>({...p,normalizedTime:survival.median?p.time/survival.median:null})),successMedianSeconds:successMedian,successCurve:km(solved).curve.map(p=>({...p,normalizedTime:successMedian?p.time/successMedian:null}))});
  }
}
const csv=rows=>{const keys=Object.keys(rows[0]);return keys.join(',')+'\n'+rows.map(r=>keys.map(k=>r[k]??'').join(',')).join('\n')+'\n';};
const baseline=output.filter(r=>r.band===MAIN_BAND&&r.minPrior===MAIN_MIN_PRIOR);
await fs.writeFile(root+'/t97_raw.csv',csv(baseline));
await fs.writeFile(root+'/sensitivity.csv',csv(output));
await fs.writeFile(root+'/quantiles.csv',csv(baseline.map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>['kind','q','samples','solved'].includes(k)||k.startsWith('success'))))));
await fs.writeFile(root+'/survival_curves.json',JSON.stringify(curves,null,2));
await fs.writeFile(root+'/summary.json',JSON.stringify({manifest,bootstrap:{reps,seed:20260916,unit:'contest',interval:'percentile; unidentified replicates retained as +Infinity'},baseline,sensitivity:output},null,2));
console.log('Saved empirical summaries, nine sensitivity configurations, and KM curves for ' + samples.length + ' observations.');
