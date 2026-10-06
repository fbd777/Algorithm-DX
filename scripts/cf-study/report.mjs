import fs from 'node:fs/promises';
const root='results/cf-study';
const {manifest,baseline:rows,sensitivity,bootstrap}=JSON.parse(await fs.readFile(root+'/summary.json','utf8'));
if(manifest.cohort==='expanded-certified-history'){await import('./compare.mjs');process.exit(0);}
const curves=JSON.parse(await fs.readFile(root+'/survival_curves.json','utf8'));
const minutes=x=>x===null?'不可识别/无数据':(x/60).toFixed(2)+' 分钟';
const pct=x=>x===null?'无数据':(x*100).toFixed(1)+'%';
const selected=rows.filter(r=>r.q<=2000),finite=selected.filter(r=>r.t97KmSeconds!==null);
function corr(xs,ys){if(xs.length<3)return null;const mean=a=>a.reduce((s,x)=>s+x,0)/a.length,mx=mean(xs),my=mean(ys);const a=xs.map(x=>x-mx),b=ys.map(y=>y-my);const den=Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0));return den?a.reduce((s,x,i)=>s+x*b[i],0)/den:null;}
const ranks=xs=>xs.map(x=>{const lower=xs.filter(v=>v<x).length,ties=xs.filter(v=>v===x).length;return lower+(ties+1)/2;});
const pearson=corr(finite.map(r=>r.q),finite.map(r=>r.t97KmSeconds));
const spearman=corr(ranks(finite.map(r=>r.q)),ranks(finite.map(r=>r.t97KmSeconds)));
const normalized=curves.filter(c=>c.q<=2000&&c.t97KmSeconds!==null);
let maxDistance=null,maxAt=null;
for(const x of [.25,.5,.75,1,1.25,1.5,2]){
  const values=normalized.filter(c=>c.curve.at(-1).normalizedTime>=x).map(c=>{const before=c.curve.filter(p=>p.normalizedTime<=x);return before.length?before.at(-1).cdf:0;});
  if(values.length<2)continue;
  const distance=Math.max(...values)-Math.min(...values);
  if(maxDistance===null||distance>maxDistance){maxDistance=distance;maxAt=x;}
}
const lines=[
'# 首批真实 Codeforces 统计实验',
'',
`生成时间：${new Date().toISOString()}。来源：Codeforces 公开 API；${manifest.contests.length} 场 2024–2025 比赛；核验 ${manifest.selectedHandles??manifest.maxHistories} 位选手历史；清洗记录 ${manifest.samples??'抓取尚未完成'} 条。主口径 ±100、赛前 rated 场次 ≥10、σ=75。所有时间均为代理起点后的耗时。`,
'',
`主口径最终 ${rows.reduce((n,r)=>n+r.samples,0)} 条，其中 800–2000 共 ${selected.reduce((n,r)=>n+r.samples,0)} 条；各档仅 ${Math.min(...selected.map(r=>r.samples))}–${Math.max(...selected.map(r=>r.samples))} 条。2100–2500 的明细也保存在 CSV；没有样本或不能识别的档位不填数字。`,
'',
'**这是 empirical / 实测探索结果，不是拟合参数，也不是生产用 T97 表。首批样本很小，不能据此确定完成度函数。没有 illustrative 数据。**',
'',
'## 1–2. 各 Rating 档大约需要多久？',
'',
'下面同时列出原定义 KM 50% solve time 和补充方案的成功者 P50。null 不补值。样本数是选手×题目，不等于唯一选手数。',
'',
...selected.map(r=>`- **${r.q}**：n=${r.samples}，${r.contests} 场/${r.problems} 题/${r.players} 位选手；成功 ${r.solved}、删失 ${r.censored}；KM=${minutes(r.t97KmSeconds)}；成功者 P50=${minutes(r.successP50Seconds)}、P90=${minutes(r.successP90Seconds)}；实际/加权解出率 ${pct(r.solveRate)}/${pct(r.weightedSolveRate)}。95% CI：${r.ciStatus==='fewer_than_two_contests'?'不足两场，无法提供比赛聚类区间':`${minutes(r.ciLowSeconds)} 至 ${r.ciHighSeconds===null?'无有限上界':minutes(r.ciHighSeconds)}`}。状态 ${r.status}。`),
'',
'## 3–4. 是否显著相关，呈现什么形状？',
'',
`仅对 800–2000 中 KM 可识别的 ${finite.length} 个档位作描述：Pearson r=${pearson?.toFixed(3)??'不可计算'}，Spearman ρ=${spearman?.toFixed(3)??'不可计算'}。这是少量有噪声档位估计之间的相关，不是选手级相关，也没有排除未识别档位导致的选择偏差。不能由此宣布显著关系、线性/非线性规律或“高 Rating 更快”。保留原始波动，不拟合、不强制单调。`,
'',
'## 5. 成功者耗时分布',
'',
'见 [quantiles.csv](quantiles.csv)：完整 P10/P20/P30/P50/P70/P80/P90/P95，既有高斯加权也有未加权版本，单位秒。[经验图](plots/empirical-summary.png) 对比 KM 与成功者 P50/P90。成功者条件分布会受比赛时长与筛选影响，不能替代包含失败者的生存曲线。',
'',
'## 6–7. 标准化后能否统一？',
'',
`在 t/KM 中位数={0.25,0.5,0.75,1,1.25,1.5,2} 的共同可观察点，档位间最大 CDF 范围差=${maxDistance===null?'不可计算':maxDistance.toFixed(3)}${maxAt===null?'':`（x=${maxAt}）`}。只在各条曲线实际观察时长内比较，不向尾部外推。这是描述性差异，样本稀疏，不是分布相同或不同的正式检验。当前不能确认统一 Achievement 函数。[标准化经验曲线](plots/normalized-curves.png)。`,
'',
'## 8. 各完成度的合理时间分位点',
'',
'按最新方案只确定 97% 锚定成功者中位时间；不要求成功者平均完成度恰好 97%。98/99/99.5/100/100.5 的时间分位点暂不决定，数据分布不能唯一决定游戏奖励强度。原方案 KM 中位数继续作为统计诊断量，两者不能混称。',
'',
'另附 [按成功者中位数标准化的成功者 CDF](plots/success-normalized-curves.png)，直接对应修订后的候选 97% 锚点。它条件于比赛内成功，不能用于声称总体解出概率是 50%。',
'',
'## 9. 成功者 P90 与 KM 50% solve time 差多少？',
'',
...selected.filter(r=>r.p90MinusKmSeconds!==null).map(r=>`- ${r.q}：P90 − KM 中位数 = ${(r.p90MinusKmSeconds/60).toFixed(2)} 分钟。`),
'',
'差值正负都可能出现，尤其在样本少、删失多时；某个量不可识别则不计算差值。不能将成功者 P90 命名为总体 T97。',
'',
'## 10. lookup table 还是函数？',
'',
'当前只保存经验 lookup 结果用于研究，**尚不用于产品计分**；没有生成拟合表。应先扩大独立比赛/题目和稳定选手样本，修正首批覆盖抽样的纳入概率，进行按比赛留出验证，再选择经验查表或统一函数。',
'',
'## 敏感性、置信区间与数据来源',
'',
`[sensitivity.csv](sensitivity.csv) 包含 ${sensitivity.length} 行：18 档 × 3 个 Rating 窗口 × 3 个稳定性门槛。bootstrap=${bootstrap.reps} 次，以比赛为聚类单位；不可识别重复样本保留为 +∞，不丢弃。跨比赛同一选手依赖仍未完全处理。主口径可识别并不保证其他口径可识别。`,
'',
...selected.map(r=>{const variants=sensitivity.filter(s=>s.q===r.q),identified=variants.filter(s=>s.t97KmSeconds!==null);return `- ${r.q}：九种口径的样本量 ${Math.min(...variants.map(s=>s.samples))}–${Math.max(...variants.map(s=>s.samples))}；${identified.length}/9 种口径 KM 可识别${identified.length?`，点估计范围 ${minutes(Math.min(...identified.map(s=>s.t97KmSeconds)))} 至 ${minutes(Math.max(...identified.map(s=>s.t97KmSeconds)))}`:''}。`; }),
'',
'上述点估计范围是筛选敏感性，不是置信区间。不同剩余比赛时长造成不同删失时刻，KM CDF 可能达到 50%，即使原始成功比例低于 50%；这依赖独立删失假设，不能混同原始解出率。',
'',
...manifest.contests.map(c=>`- [${c.id} · ${c.name}](https://codeforces.com/contest/${c.id})：${c.standings} standings 行，${c.submissions} 原始提交（包含练习等，清洗时剔除），${c.candidates} 候选记录。`),
'',
`抓取错误数：${manifest.errors.length}。原始缓存保存请求 URL 和时间；[summary.json](summary.json) 包含完整配置与 manifest。[详细方法与方案调整](../../docs/cf-maimai-study.md)。`,
'',
'[离线重建核对](reproducibility.json) 保存清洗前后候选集与样本的 SHA256；通过表示可从本地官方响应缓存重建相同记录。',
'',
'严格顺序筛选和比赛结束删失都可能引入选择偏差；真正开始读题时间不可观测。这些限制比曲线是否平滑更重要。',
];
await fs.writeFile(root+'/REPORT.md',lines.join('\n')+'\n');
await fs.writeFile(root+'/diagnostics.json',JSON.stringify({kind:'empirical_descriptive',finiteBins:finite.length,pearson,spearman,normalizedMaxCdfRange:maxDistance,normalizedMaxAt:maxAt,significance:'not_established',productionReady:false},null,2));
console.log(root+'/REPORT.md');
