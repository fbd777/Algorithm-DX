// 单调约束平滑：在「未约束的核平滑」之上做加权保序回归（PAVA），让 T97 随题目 Rating 不下降。
//
// 为什么需要：原始 KM 曲线在若干高档位掉头向下，根因是那些档位独立比赛太少、
// 权重极小，偶然低值把右端整条拽下来。单调化把「同 Rating 下 T97 不应随难度下降」
// 这个形状先验显式写进估计。
//
// 代价必须说清楚：单调化会掩盖真实反转。所以未约束版本一并输出，并逐档给出调整量、
// 该档 95% CI，以及单调化后的值是否仍落在该区间内 —— 落在区间内说明只是消除噪声，
// 落到区间外说明单调化改写了读数，该档需要单独审视。
//
// 平滑器与保序回归都在 core.mjs（fitCurve / isotonicNonDecreasing），
// 与 smooth-fit、validate 共用同一份实现。
import fs from 'node:fs/promises';
import {fitCurve,blockSecondsAt,FIT_MIN_Q,FIT_MAX_Q} from './core.mjs';
const root='results/cf-study';
// --slope-floor=<秒/Rating>：放松「T97 随难度不下降」这条先验。默认 0 = 严格保序（原口径）。
// 为什么需要它：1700–2000 那一段的未约束曲线本身就在下降，严格保序只能把它压成一条平线，
// 四档数值完全相同。要让它们重新有区分度，只能让出一点斜率。代价与取值对照见
// PLATEAU_OPTIONS.md；这个数会被写进输出，别让读者以为下面这条是严格单调的结果。
const argOf=name=>{const hit=process.argv.find(a=>a.startsWith('--'+name+'='));return hit?hit.split('=')[1]:null;};
const slopeFloor=Number(argOf('slope-floor')??0);
if(!(slopeFloor>=0)||!Number.isFinite(slopeFloor))throw Error('--slope-floor 必须是非负有限数');
const summary=JSON.parse(await fs.readFile(root+'/summary.json','utf8'));
const smooth=JSON.parse(await fs.readFile(root+'/smooth_fit.json','utf8'));
const rows=summary.baseline.filter(r=>r.q>=FIT_MIN_Q&&r.q<=FIT_MAX_Q&&r.samples>=100);
if(rows.length<4)throw Error('Need at least four rating bins with >=100 samples');
const fitted=[],report={kind:'fitted',method:slopeFloor>0?`weighted local-linear Gaussian smoother followed by isotonic regression (PAVA) with a slope floor of ${slopeFloor} s/Rating`:'weighted local-linear Gaussian smoother followed by weighted isotonic regression (PAVA)',slopeFloor,note:'monotoneSeconds 是主推值；rawSeconds 是同一带宽下的未约束值，保留作对照',models:{}};
for(const model of ['km','success']){
  const field=model==='km'?'t97KmSeconds':'successP50Seconds';
  const data=rows.filter(r=>r[field]!=null).map(r=>({q:r.q,y:r[field],effectiveSamples:r.effectiveSamples,samples:r.samples}));
  const bandwidth=smooth.selected[model].bandwidth;
  const {points,blocks}=fitCurve(data,{bandwidth,monotone:true,slopeFloor});
  const details=points.map(p=>({model,q:p.q,rawSeconds:p.rawY,monotoneSeconds:p.y,deltaSeconds:p.y-p.rawY,smoothWeight:p.w,bandwidth}));
  for(const d of details)fitted.push(d);
  const adjusted=details.filter(d=>Math.abs(d.deltaSeconds)>1e-6);
  // 每 100 一档的对照：经验点估计、同带宽未约束平滑值、单调化后的值，三者并列才看得出改了什么。
  const bins=rows.filter(r=>r[field]!=null).map(r=>{
    const d=details.find(x=>x.q===r.q);
    const ciLow=model==='km'?r.ciLowSeconds:r.successMedianCiLowSeconds;
    const ciHigh=model==='km'?r.ciHighSeconds:r.successMedianCiHighSeconds;
    const mono=d?.monotoneSeconds??null;
    return {
      q:r.q,contests:r.contests,samples:r.samples,players:r.players,
      observedSeconds:r[field],
      unconstrainedSeconds:d?.rawSeconds??null,
      monotoneSeconds:mono,
      deltaVsUnconstrainedSeconds:d?d.monotoneSeconds-d.rawSeconds:null,
      deltaVsObservedSeconds:mono===null?null:mono-r[field],
      ciLowSeconds:ciLow,ciHighSeconds:ciHigh,
      ciStatus:model==='km'?r.ciStatus:r.successMedianCiStatus,
      status:r.status,
      monotoneWithinCi:ciLow===null||ciHigh===null||mono===null?null:(mono>=ciLow&&mono<=ciHigh),
    };
  });
  report.models[model]={bandwidth,field,adjustedGridPoints:adjusted.length,totalGridPoints:details.length,maxAbsDeltaSeconds:adjusted.length?Math.max(...adjusted.map(d=>Math.abs(d.deltaSeconds))):0,blocks,binDetails:bins};
  console.log(model,'带宽',bandwidth,'| 被推动的网格点',adjusted.length+'/'+details.length,'| 最大调整',report.models[model].maxAbsDeltaSeconds.toFixed(1)+'秒');
}
const keys=Object.keys(fitted[0]);
await fs.writeFile(root+'/t97_monotone.csv',keys.join(',')+'\n'+fitted.map(r=>keys.map(k=>r[k]??'').join(',')).join('\n')+'\n');
await fs.writeFile(root+'/monotone_fit.json',JSON.stringify(report,null,2));

const min=v=>v===null||v===undefined?'':(v/60).toFixed(2);
const lines=[
  '# 单调约束说明','',
  '方法：先按 [smooth_fit.json](smooth_fit.json) 选定的带宽做加权局部线性核平滑（未约束），再对网格点做加权保序回归（PAVA）。权重是该处核函数权重之和，因此样本稀少的档位权重低、会被邻近档位拉动。','',
  ...(slopeFloor>0?[
    `**本次放松了单调先验**：斜率下界 \`--slope-floor=${slopeFloor}\`（秒 / Rating），含义是「相邻档位最多允许下降这么多」。`,
    `取 0 时（严格保序）1700–2000 会被压成一条平线，四档数值完全相同；放松的原因、代价与取值对照见 [PLATEAU_OPTIONS.md](PLATEAU_OPTIONS.md)。`,
    `放松后合并块内部不再是一条平线，而是一条斜率固定为 −${slopeFloor} 秒/Rating 的直线。`,'',
  ]:[]),
  '下表每 100 Rating 一档。三列数值都是**同一口径、同一带宽**下的结果，只有「经验点」是直接来自数据的原始点估计：','',
  '- **经验点**：`t97_raw.csv` 里的点估计，不平滑。',
  '- **未约束平滑**：同带宽核平滑，保留数据中的局部反转。',
  '- **单调化**：在未约束平滑之上做保序回归，主推值。','',
  '按比赛留出的验证结果（预测误差、逐档覆盖率、反转复现率）见 [VALIDATION.md](VALIDATION.md) —— 那一份测的是「这条曲线拿去预测没见过的比赛准不准」，本表只说明它相对经验点改动了什么。','',
];
for(const model of ['km','success']){
  const m=report.models[model];
  lines.push(`## ${model==='km'?'KM 50% solve time（诊断列）':'成功者中位耗时（推荐 T97 锚点）'}`,'');
  lines.push(`带宽 ${m.bandwidth}；${m.totalGridPoints} 个网格点中 ${m.adjustedGridPoints} 个被推动，最大调整 ${(m.maxAbsDeltaSeconds/60).toFixed(2)} 分钟。`,'');
  // 合并块必须单独写出来：块内是一条平线，如果只报「被推动的网格点数」，
  // 读者看到连续几档数值一模一样会误以为那几档缺数据。块的存在反而是好证据 ——
  // 它说明未约束曲线只在那一处不单调，保序回归的改动是局部的，不是全局拉平。
  const merged=(m.blocks??[]).filter(b=>b.to>b.from);
  if(merged.length)lines.push(`保序回归合并了 ${merged.length} 个块：${merged.map(b=>`**${b.from}–${b.to}**（跨 ${b.to-b.from} 分，${slopeFloor>0?`块内从 ${(blockSecondsAt(b,b.from)/60).toFixed(2)} 降到 ${(blockSecondsAt(b,b.to)/60).toFixed(2)} 分钟`:`块值 ${(b.seconds/60).toFixed(2)} 分钟`}，权重 ${Math.round(b.weight)}）`).join('、')}。${slopeFloor>0?`块内是一条斜率 −${slopeFloor} 秒/Rating 的直线（不是平线，也不是硬造出来的上升线）。`:'块内是一条平线。'}这不是缺数据，而是该区间**没有可分辨的斜率**：未约束曲线在那里先鼓后凹，保序回归${slopeFloor>0?'只能把它压成一条缓降线':'只能把它压成平段'}，而不是硬造一条上升线。`,`其余 ${(m.blocks??[]).length-merged.length} 个块都是单个网格点。`,'');
  else lines.push('未约束曲线本身已经单调，保序回归没有合并任何相邻块。','');
  lines.push('| Rating | 经验点 | 未约束平滑 | 单调化 | 调整 | 独立比赛 | 样本 | 经验点 95% CI | 平滑后仍在区间内 |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for(const b of m.binDetails){
    const ci=b.ciLowSeconds===null||b.ciHighSeconds===null?'无有限区间':`[${min(b.ciLowSeconds)}, ${min(b.ciHighSeconds)}]`;
    const flag=b.monotoneWithinCi===null?'无法判断':b.monotoneWithinCi?'是':'**否**';
    lines.push(`| ${b.q} | ${min(b.observedSeconds)} | ${min(b.unconstrainedSeconds)} | **${min(b.monotoneSeconds)}** | ${b.deltaVsUnconstrainedSeconds>=0?'+':''}${min(b.deltaVsUnconstrainedSeconds)} | ${b.contests} | ${b.samples} | ${ci} | ${flag} |`);
  }
  lines.push('');
  const outside=m.binDetails.filter(b=>b.monotoneWithinCi===false);
  if(outside.length)lines.push(`⚠️ ${outside.map(b=>b.q).join('、')} 档平滑后落到了自身经验点 95% 区间之外。注意区分两种成因：「调整」列为 0 时位移全部来自**核平滑的带宽效应**（边界档位尤其明显，最右端没有右侧数据），非 0 则还叠加了保序回归的拉动。无论哪种，这些档位的平滑值都不能当作实测点。`,'');
  else lines.push('所有档位平滑后仍落在自身经验点 95% 区间内。','');
  lines.push('区间是经验点估计的比赛聚类 bootstrap 95% 线，只反映抽样不确定性，不含「账本证据是否充分」这类系统性误差；用它做「平滑位移是否过大」的参照并不严格，因为平滑值本身不是同一个估计量。','');
}
lines.push('单位均为分钟。','');
await fs.writeFile(root+'/MONOTONE.md',lines.join('\n')+'\n');
console.log('已写出 t97_monotone.csv / monotone_fit.json / MONOTONE.md');
