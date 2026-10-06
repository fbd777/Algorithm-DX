// 主推估计表：单调约束后的推荐 T97，并列出未约束对照与调整量。
// 刻意把两列并排：单调化是形状先验，不是实测值，不能让它看起来像原始读数。
import fs from 'node:fs/promises';
import {FIT_MIN_Q,FIT_MAX_Q} from './core.mjs';
const root='results/cf-study';
const read=async file=>{
  const lines=(await fs.readFile(file,'utf8')).trim().split(/\r?\n/);
  const header=lines.shift().split(',');
  return lines.map(line=>{const p=line.split(',');return Object.fromEntries(header.map((k,i)=>[k,p[i]]));});
};
const mono=await read(root+'/t97_monotone.csv');
const raw=await read(root+'/t97_smooth.csv');
const summary=JSON.parse(await fs.readFile(root+'/summary.json','utf8'));
const bins=new Map(summary.baseline.map(r=>[r.q,r]));
const pick=(source,model,q)=>{
  const r=source.find(x=>x.model===model&&Number(x.q)===q);
  if(!r)return null;
  const v=r.monotoneSeconds??r.fittedSeconds;
  return v===undefined||v===''?null:Number(v);
};
const out=[];
for(let q=FIT_MIN_Q;q<=FIT_MAX_Q;q+=100){
  const s=bins.get(q);
  out.push({
    rating:q,
    recommendedT97Seconds:pick(mono,'success',q),
    unconstrainedT97Seconds:pick(raw,'success',q),
    kmMonotoneSeconds:pick(mono,'km',q),
    kmUnconstrainedSeconds:pick(raw,'km',q),
    contests:s?.contests??null,
    samples:s?.samples??null,
    status:s?.status??null,
  });
}
const minutes=v=>v===null?'':(v/60).toFixed(2);
const signed=v=>v===null?'':(v>=0?'+':'')+(v/60).toFixed(2);
await fs.writeFile(root+'/t97_table.csv',
  'rating,recommendedT97Minutes,unconstrainedT97Minutes,deltaMinutes,kmMonotoneMinutes,kmUnconstrainedMinutes,contests,samples,status\n'+
  out.map(r=>{
    const d=r.recommendedT97Seconds!==null&&r.unconstrainedT97Seconds!==null?r.recommendedT97Seconds-r.unconstrainedT97Seconds:null;
    return [r.rating,minutes(r.recommendedT97Seconds),minutes(r.unconstrainedT97Seconds),signed(d),minutes(r.kmMonotoneSeconds),minutes(r.kmUnconstrainedSeconds),r.contests,r.samples,r.status].join(',');
  }).join('\n')+'\n');

const md=[
  `# ${FIT_MIN_Q}–${FIT_MAX_Q} T97 估计表`,
  '',
  '主推列是**单调约束**平滑值：先按 [smooth_fit.json](smooth_fit.json) 选定的带宽做加权局部线性核平滑，再对网格点做加权保序回归（PAVA），保证 T97 随题目 Rating 不下降。',
  '「未约束对照」是同一带宽下不做保序回归的结果，两列之差即单调化带来的调整量。',
  '',
  '推荐口径采用成功者中位耗时，作为 97% 锚点；KM 列保留为总体 50% solve time 诊断。每 100 Rating 一档。',
  '',
  '| Rating | 推荐 T97（单调） | 未约束对照 | 调整量 | KM 50%（单调） | KM（未约束） | 独立比赛 | 样本 |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|',
];
for(const r of out){
  const d=r.recommendedT97Seconds!==null&&r.unconstrainedT97Seconds!==null?r.recommendedT97Seconds-r.unconstrainedT97Seconds:null;
  md.push(`| ${r.rating} | **${minutes(r.recommendedT97Seconds)} 分钟** | ${minutes(r.unconstrainedT97Seconds)} 分钟 | ${signed(d)} | ${minutes(r.kmMonotoneSeconds)} 分钟 | ${minutes(r.kmUnconstrainedSeconds)} 分钟 | ${r.contests} | ${r.samples} |`);
}
// 相邻档位主推值完全相同的连续段。必须点出来，否则读者看到 1700–2000 四档数值一模一样
// 会以为那几档缺数据 —— 实际是保序回归把它们合并成了一个块（块内是平线），
// 逐块的起点、终点与权重在 MONOTONE.md 里。
const levelRuns=[];
for(let i=0;i<out.length;){
  let j=i;
  while(j+1<out.length&&out[j+1].recommendedT97Seconds!==null&&out[j+1].recommendedT97Seconds===out[i].recommendedT97Seconds)j++;
  if(j>i)levelRuns.push(`${out[i].rating}–${out[j].rating}`);
  i=j+1;
}
md.push(
  '',
  '调整量列只是**单调化**那一步造成的位移；核平滑本身也会移动读数（最右端 '+FIT_MAX_Q+' 附近没有右侧数据，边界效应明显，往右只有左侧数据可借）。两步合计的位移是否仍落在经验点的 95% 区间内，逐档见 [MONOTONE.md](MONOTONE.md)。',
  '',
  levelRuns.length
    ?`主推列里 ${levelRuns.join('、')} 是**同一段平线**，不是缺数据：保序回归判定这几档之间没有可分辨的斜率，把它们合并成了一个块。块内数值相同是设计结果，块与块之间仍严格非递减。`
    :'主推列相邻档位没有出现完全相同的值，保序回归没有合并任何块。',
  '',
  '`independent contests`（独立比赛）少于 10 的档位在 [t97_raw.csv](t97_raw.csv) 的 status 列标为 `small_sample`，其读数主要由邻近档位拉动，不应当作该档的实测点。',
  '',
  '注意：这是拟合估计，不是逐题经验点；适用范围为 '+FIT_MIN_Q+'–'+FIT_MAX_Q+'。原始点估计和置信区间见 [COMPARISON.md](COMPARISON.md)。',
);
await fs.writeFile(root+'/T97_TABLE.md',md.join('\n')+'\n');
console.log(md.join('\n'));
