// 1700–2000 的平块要不要拆开、拆到什么程度 —— 把「放松单调先验多少」做成一张可读的网格。
//
// 背景：T97_TABLE.md 里 1700 / 1800 / 1900 / 2000 四行数值完全一样。那不是缺数据，而是
// 保序回归（PAVA）把 1675–2025 合并成了一个块。**只要坚持严格非减，这一段必然是平线**：
// 未约束曲线在那里整体就是向下的（40.39 → 40.44 → 39.37 → 39.22 分钟），PAVA 遇到持续
// 下降只会合并，不可能凭空造出一条上升线。所以「要区分度」等价于「放松单调先验」。
//
// 这个脚本把放松量 slopeFloor（秒 / Rating）做成网格。对每个取值给出：
//   * 留一档位的加权与等权 RMSE（与 smooth-fit 选带宽同一套判据，直接可比）；
//   * 合并块的数量，以及还剩几处相邻档位在下降；
//   * 每 100 Rating 一档的读数 —— 区分度直接看这一张。
// 选哪个由人定，但代价（拟合误差）与收益（区分度）都摆在台面上。
//
// slopeFloor 的语义见 core.mjs 的 isotonicNonDecreasing：s=0 就是现行口径。
import fs from 'node:fs/promises';
import {fitCurve,fitWeight,fitGrid,FIT_MIN_Q,FIT_MAX_Q} from './core.mjs';
const root='results/cf-study';
const summary=JSON.parse(await fs.readFile(root+'/summary.json','utf8'));
const smooth=JSON.parse(await fs.readFile(root+'/smooth_fit.json','utf8'));
const BANDWIDTH=smooth.selected.success.bandwidth;
const rows=summary.baseline
  .filter(r=>r.q>=FIT_MIN_Q&&r.q<=FIT_MAX_Q&&r.samples>=100&&r.successP50Seconds!=null)
  .map(r=>({q:r.q,y:r.successP50Seconds,effectiveSamples:r.effectiveSamples,samples:r.samples,contests:r.contests,
    ciLow:r.successMedianCiLowSeconds,ciHigh:r.successMedianCiHighSeconds}));
const GRID=fitGrid();
const SLOPES=[0,0.05,0.1,0.15,0.2,0.25,0.3,0.5,1,2];
// 留一档位：把该档从数据里拿掉，重跑「核平滑 + 保序回归」整条流程，再回到该档的 Rating 上取预测。
// 必须连保序那一步一起重跑 —— 只留一平滑的话，验的是另一个估计量（validate.mjs 是同一条规矩）。
function loocv(slopeFloor){
  let mseW=0,sw=0,n=0,mseEq=0;
  for(let i=0;i<rows.length;i+=1){
    const train=rows.filter((_,j)=>j!==i).map(r=>({q:r.q,y:r.y,effectiveSamples:r.effectiveSamples,samples:r.samples}));
    const {points}=fitCurve(train,{bandwidth:BANDWIDTH,grid:GRID,monotone:true,slopeFloor});
    const hit=points.find(p=>p.q===rows[i].q);
    if(!hit)continue;
    const e=hit.y-rows[i].y,w=fitWeight(rows[i]);
    mseW+=w*e*e;sw+=w;mseEq+=e*e;n+=1;
  }
  return {weightedRmseSeconds:Math.sqrt(mseW/sw),equalWeightRmseSeconds:Math.sqrt(mseEq/n),bins:n};
}
function valueAt(points,q){
  const hit=points.find(p=>p.q===q);
  return hit?hit.y:null;
}
const candidates=[];
for(const slopeFloor of SLOPES){
  const {points,blocks}=fitCurve(rows,{bandwidth:BANDWIDTH,grid:GRID,monotone:true,slopeFloor});
  const bins=rows.map(r=>valueAt(points,r.q));
  const merges=(blocks??[]).filter(b=>b.to>b.from);
  const drops=rows.filter((r,i)=>i>0&&bins[i]-bins[i-1]<-1e-6);
  candidates.push({
    slopeFloor,...loocv(slopeFloor),
    mergedBlocks:merges.map(b=>({from:b.from,to:b.to,seconds:Math.round(b.seconds)})),
    ratingBins:bins.map((y,i)=>({q:rows[i].q,seconds:y})),
    // 最陡的一处下降（秒），是「先验被放松掉多少」的直接读数。
    steepestDropSeconds:Math.min(0,Math.min(...rows.slice(1).map((r,i)=>bins[i+1]-bins[i]))),
    recovering:rows.map((r,i)=>({q:r.q,dropSeconds:i?bins[i]-bins[i-1]:null})).filter(x=>x.dropSeconds!==null&&x.dropSeconds<-1e-6),
  });
}
const unconstrained=fitCurve(rows,{bandwidth:BANDWIDTH,grid:GRID,monotone:false});
const unconstrainedBins=rows.map(r=>valueAt(unconstrained.points,r.q));
await fs.writeFile(root+'/plateau_options.json',JSON.stringify({
  kind:'diagnostic',bandwidth:BANDWIDTH,metric:'successP50Seconds',
  note:'slopeFloor 单位是秒/Rating；0 即现行严格保序口径。unconstrained 是同一带宽下不做保序的对照。',
  slopes:candidates,unconstrainedBins:unconstrainedBins.map((y,i)=>({q:rows[i].q,seconds:y})),
},null,2)+'\n');

const min=v=>v===null||v===undefined?'—':(v/60).toFixed(2);
const lines=[
  '# 1700–2000 平块：拆开要付多少代价',
  '',
  `> 生成：\`node scripts/cf-study/plateau-options.mjs\`；口径：成功者中位耗时、带宽 ${BANDWIDTH}、` +
  `两者都是 \`smooth_fit.json\` 选定的那一组。`,
  '',
  '**先把结论说清楚：只要坚持「T97 随难度不下降」，1700–2000 就必然是平线。**',
  '保序回归（PAVA）遇到持续下降只会合并相邻块，不会造出上升线；未约束曲线在那一段是',
  `40.39 → 40.44 → 39.37 → 39.22 分钟，其中 1800 之后的每一步都在下降。所以「让这几档有区分度」`,
  '与「让这几档不平」是同一件事，都要放松单调先验。',
  '',
  `` + '`slopeFloor`' + ` 就是放松量：单位**秒 / Rating**，含义是「相邻档位最多允许下降多少」。`,
  '它由 core.mjs 的 `isotonicNonDecreasing` 实现（把序列抬成 `y + s·q` 跑 PAVA 再减回去，',
  '所以「每 Rating 最多降 s 秒」恰好等价于抬高后的非减约束）。',
  '',
  '## 逐档经验点（未平滑）',
  '',
  '先看没做任何平滑的原始点估计，以及它的比赛聚类 bootstrap 95% 区间 ——',
  '区间宽到互相重叠，是后面所有讨论的前提。',
  '',
  '| Rating | 经验点 | 95% CI | 独立比赛 | 样本 |',
  '|---:|---:|---|---:|---:|',
  ...rows.map(r=>`| ${r.q} | ${min(r.y)} | [${min(r.ciLow)}, ${min(r.ciHigh)}] | ${r.contests} | ${r.samples} |`),
  '',
  '## 放松量网格',
  '',
  '`LOOCV` 是把该档拿掉、重跑整条流程再预测回来的误差（与选带宽同一套判据，越低越好）。',
  '「块」是还剩几个合并块；「下降档数」是全区间里相邻档位实际在下降的位置数 —— 放松越多，',
  '被允许的下降越多。',
  '',
  '| slopeFloor (秒/Rating) | LOOCV 加权 RMSE | LOOCV 等权 RMSE | 合并块 | 下降档数 | 最陡一处下降 |',
  '|---:|---:|---:|---:|---:|---:|',
];
for(const c of candidates){
  const merges=c.mergedBlocks.length?c.mergedBlocks.map(b=>`${b.from}–${b.to}`).join(' '):'无';
  lines.push(`| ${c.slopeFloor.toFixed(2)} | ${(c.weightedRmseSeconds/60).toFixed(2)} 分钟 | ${(c.equalWeightRmseSeconds/60).toFixed(2)} 分钟 | ${merges} | ${c.recovering.length} | ${c.steepestDropSeconds?(-c.steepestDropSeconds/60).toFixed(2)+' 分钟':'0'} |`);
}
lines.push('','## 各档读数（分钟）','');
const header=['slopeFloor',...rows.map(r=>r.q)].join(' | ');
lines.push('| '+header+' |');
lines.push('|'+rows.map(()=>'---:').join('|')+'|---:|');
lines.push('| （未约束） | '+unconstrainedBins.map(min).join(' | ')+' |');
for(const c of candidates){
  lines.push(`| ${c.slopeFloor.toFixed(2)} | ${c.ratingBins.map(b=>min(b.seconds)).join(' | ')} |`);
}
lines.push('');
lines.push('## 怎么读','');
lines.push('- **未约束那一行**是数据的原话：1700–2100 之间最大落差 2.77 分钟，方向先上后下再上。');
lines.push('- **slopeFloor = 0 那一行**就是现行主推值，1700–2000 完全相同。');
lines.push('- 越往下放松，区分度越大，但 LOOCV 会变差 —— 变差多少就是「区分度」的价格。');
lines.push('- 区分度不是免费的：那几个档位的 95% 区间互相重叠，任何一种「把它们拉开」的做法都在');
lines.push('  拟合噪声。放松量选多大是**产品权衡**，不是统计结论，所以这里只列代价，不替你选。');
lines.push('');
lines.push('单位均为分钟（slopeFloor 除外）。');
await fs.writeFile(root+'/PLATEAU_OPTIONS.md',lines.join('\n')+'\n');
console.log('已写出 plateau_options.json / PLATEAU_OPTIONS.md');
for(const c of candidates){
  console.log('slopeFloor',c.slopeFloor.toFixed(2),
    '| 加权 RMSE',(c.weightedRmseSeconds/60).toFixed(3),'分钟',
    '| 合并块',c.mergedBlocks.map(b=>b.from+'-'+b.to).join(',')||'无',
    '| 1700/2000',(valueAt(fitCurve(rows,{bandwidth:BANDWIDTH,grid:GRID,monotone:true,slopeFloor:c.slopeFloor}).points,1700)/60).toFixed(2),
    (valueAt(fitCurve(rows,{bandwidth:BANDWIDTH,grid:GRID,monotone:true,slopeFloor:c.slopeFloor}).points,2000)/60).toFixed(2));
}
console.log('未约束 1700/1800/1900/2000 =',
  [1700,1800,1900,2000].map(q=>min(valueAt(unconstrained.points,q))).join(' / '));
