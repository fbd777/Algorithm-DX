// 未约束核平滑：按留一档位加权 MSE 在候选带宽里选一个，然后在网格上出曲线。
//
// 平滑器本身在 core.mjs（localLinear / selectBandwidth / fitCurve）——
// smooth-fit、monotone-fit、validate 三处必须用同一份实现，
// 否则留出验证打分的就不是真正上线的那条曲线。
import fs from 'node:fs/promises';
import {FIT_MIN_Q,FIT_MAX_Q,fitGrid,selectBandwidth,localLinear} from './core.mjs';
const root='results/cf-study';
const summary=JSON.parse(await fs.readFile(root+'/summary.json','utf8'));
const rows=summary.baseline.filter(r=>r.q>=FIT_MIN_Q&&r.q<=FIT_MAX_Q&&r.samples>=100);
const grid=fitGrid();
const fitted=[],metrics=[];
for(const model of ['km','success']){
  const field=model==='km'?'t97KmSeconds':'successP50Seconds';
  // 必须带上 effectiveSamples / samples：fitWeight() 靠它算权重，
  // 缺字段会算出 NaN，随后核平滑会把所有网格点静默丢掉（踩过）。
  const data=rows.filter(r=>r[field]!=null).map(r=>({q:r.q,y:r[field],n:r.samples,effectiveSamples:r.effectiveSamples}));
  const selection=selectBandwidth(data);
  for(const m of selection.metrics)metrics.push({model,...m});
  for(const q of grid)fitted.push({model,q,fittedSeconds:localLinear(data,q,selection.bandwidth).y,bandwidth:selection.bandwidth});
}
const csv=(rs)=>{const ks=Object.keys(rs[0]);return ks.join(',')+'\n'+rs.map(r=>ks.map(k=>r[k]??'').join(',')).join('\n')+'\n';};
await fs.writeFile(root+'/t97_smooth.csv',csv(fitted));
await fs.writeFile(root+'/smooth_fit_metrics.csv',csv(metrics));
await fs.writeFile(root+'/smooth_fit.json',JSON.stringify({kind:'fitted',method:'weighted local-linear Gaussian smoother',selection:'minimum leave-one-rating-bin-out weighted MSE',weight:'effective sample size',inputBins:rows.map(r=>({q:r.q,samples:r.samples})),metrics,selected:Object.fromEntries(['km','success'].map(m=>[m,metrics.filter(x=>x.model===m).sort((a,b)=>a.loocvMseSeconds2-b.loocvMseSeconds2)[0]]))},null,2));
console.log(JSON.stringify({selected:Object.fromEntries(['km','success'].map(m=>[m,metrics.filter(x=>x.model===m).sort((a,b)=>a.loocvMseSeconds2-b.loocvMseSeconds2)[0]]))},null,2));
