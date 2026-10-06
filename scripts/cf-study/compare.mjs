import fs from 'node:fs/promises';
import {FIT_MIN_Q,FIT_MAX_Q} from './core.mjs';
const root='results/cf-study';
const {manifest,baseline,sensitivity,bootstrap}=JSON.parse(await fs.readFile(root+'/summary.json','utf8'));
const fit=JSON.parse(await fs.readFile(root+'/fit.json','utf8'));
const smooth=JSON.parse(await fs.readFile(root+'/smooth_fit.json','utf8'));
// 未约束平滑值：用来区分「反转是被核平滑抹掉的」还是「留给保序回归压平的」。
// 这两件事性质完全不同 —— 前者说明带宽把窄幅交替当噪声平均掉了（代价：也可能吃掉真信号），
// 后者说明形状先验与数据正面冲突。靠 smooth_fit.json 判断不了，它只存带宽与指标，不存拟合值。
const smoothLines=(await fs.readFile(root+'/t97_smooth.csv','utf8')).trim().split(/\r?\n/);
const smoothHeader=smoothLines.shift().split(',');
const smoothRows=smoothLines.map(line=>Object.fromEntries(smoothHeader.map((k,i)=>[k,line.split(',')[i]])));
const unconstrainedAt=(model,q)=>{
  const r=smoothRows.find(x=>x.model===model&&Number(x.q)===q);
  return r&&r.fittedSeconds!==''&&r.fittedSeconds!==undefined?Number(r.fittedSeconds):null;
};
const main=baseline.filter(r=>r.q>=FIT_MIN_Q&&r.q<=FIT_MAX_Q),minutes=v=>v===null?'不可识别':(v/60).toFixed(2);
const interval=(lo,hi,status)=>status==='fewer_than_two_contests'?'独立比赛不足':`[${lo===null?'不可识别':minutes(lo)}, ${hi===null?'无有限上界':minutes(hi)}]`;
const comparisons=main.map(r=>({q:r.q,samples:r.samples,players:r.players,contests:r.contests,problems:r.problems,solved:r.solved,censored:r.censored,weightedSolveRate:r.weightedSolveRate,kmMinutes:r.t97KmSeconds===null?null:r.t97KmSeconds/60,kmCiLowMinutes:r.ciLowSeconds===null?null:r.ciLowSeconds/60,kmCiHighMinutes:r.ciHighSeconds===null?null:r.ciHighSeconds/60,successMedianMinutes:r.successP50Seconds===null?null:r.successP50Seconds/60,successCiLowMinutes:r.successMedianCiLowSeconds===null?null:r.successMedianCiLowSeconds/60,successCiHighMinutes:r.successMedianCiHighSeconds===null?null:r.successMedianCiHighSeconds/60,differenceMinutes:r.kmMinusSuccessMedianSeconds===null?null:r.kmMinusSuccessMedianSeconds/60,differenceCiLowMinutes:r.differenceCiLowSeconds===null?null:r.differenceCiLowSeconds/60,differenceCiHighMinutes:r.differenceCiHighSeconds===null?null:r.differenceCiHighSeconds/60,ratio:r.t97KmSeconds===null||!r.successP50Seconds?null:r.t97KmSeconds/r.successP50Seconds}));
const keys=Object.keys(comparisons[0]);
await fs.writeFile(root+'/comparison.csv',keys.join(',')+'\n'+comparisons.map(r=>keys.map(k=>r[k]??'').join(',')).join('\n')+'\n');
const total=main.reduce((n,r)=>n+r.samples,0),solved=main.reduce((n,r)=>n+r.solved,0),minimum=Math.min(...main.map(r=>r.samples));
const contestYears=[...new Set(manifest.contests.map(c=>new Date(c.start*1000).getUTCFullYear()))].sort((a,b)=>a-b);
const yearSpan=contestYears.length?`${contestYears[0]}–${contestYears[contestYears.length-1]}`:'未标注年份';
const paired=main.filter(r=>r.kmMinusSuccessMedianSeconds!==null),largest=[...paired].sort((a,b)=>b.kmMinusSuccessMedianSeconds-a.kmMinusSuccessMedianSeconds)[0];
// 「口径稳健的局部反转」：低档位点估计反而高于紧邻的高档位，而且**九种筛选口径下区间不重叠**。
// 这是本节最容易被误读的地方 —— 单调约束会把这类反转压成平段，如果不说清楚，
// 读者会以为平段只是平滑的副作用，而实际上那是数据里一个真实存在、无法用样本量解释的凹陷。
// 判据取「高档位九种口径的最大值 < 低档位九种口径的最小值」：只要还有任何一种筛选口径能翻转回来，
// 就不算稳健，那种情况交给未约束对照即可。
const robustInversion=(field,lo,hi)=>{
  const values=q=>sensitivity.filter(s=>s.q===q&&s[field]!==null).map(s=>s[field]);
  const a=values(lo),b=values(hi);
  return a.length===9&&b.length===9&&Math.max(...b)<Math.min(...a)?{lo,hi,loRange:[Math.min(...a),Math.max(...a)],hiRange:[Math.min(...b),Math.max(...b)]}:null;
};
const inversions=[];
for(let i=0;i<main.length-1;i++){
  for(const [field,label] of [['successP50Seconds','成功者中位（推荐 T97 锚点）'],['t97KmSeconds','KM 50% solve time']]){
    const hit=robustInversion(field,main[i].q,main[i+1].q);
    if(!hit)continue;
    const model=field==='t97KmSeconds'?'km':'success';
    const lo=unconstrainedAt(model,hit.lo),hi=unconstrainedAt(model,hit.hi);
    // 未约束平滑值若也已反转，说明带宽没能抹掉它，是保序回归压平的；否则是被核平滑抹掉的。
    inversions.push({...hit,field,label,survivesSmoothing:lo!==null&&hi!==null&&hi<lo,smoothLo:lo,smoothHi:hi});
  }
}
const survivesSmoothing=inversions.filter(v=>v.survivesSmoothing);
const text=[
'# 扩大样本后的两种 T97 比较',
'',
`实测数据：${manifest.contests.length} 场 ${yearSpan} 比赛，账本用 ${manifest.historyContests?.length??0} 场官方 Rating 变更记录核验赛前参赛历史。主口径为赛前 Rating ±100、已证实的赛前 rated 场次 ≥10、高斯 σ=75。${FIT_MIN_Q}–${FIT_MAX_Q} 合计 **${total} 条**，其中成功 ${solved}、右删失 ${total-solved}；各档 ${minimum}–${Math.max(...main.map(r=>r.samples))} 条。样本单位是选手×题目，同一选手可贡献多条。`,
'',
`每档至少 100 条的目标：**${minimum>=100?'已达到':'尚未全部达到'}**。各档独立比赛数 ${Math.min(...main.map(r=>r.contests))}–${Math.max(...main.map(r=>r.contests))}，因此大量同场样本不等于同样多的独立信息。`,
'',
'算法 A：加权 Kaplan–Meier 的总体 50% solve time，纳入未解出者的右删失。算法 B：比赛内成功者的加权耗时中位数，作为补充方案的 97% 锚点。两者使用完全相同的候选集合、Rating 窗口与权重；B 在其中条件于成功。单位均为分钟。',
'',
`${paired.length}/${main.length} 个档位两者都可识别。${largest?`A−B 点估计范围 ${minutes(Math.min(...paired.map(r=>r.kmMinusSuccessMedianSeconds)))}–${minutes(largest.kmMinusSuccessMedianSeconds)} 分钟，差距最大的是 ${largest.q} 档。`:'没有可比较的有限差值。'} 这是本轮经验结果，不外推到所有题目。`,
'',
'![两种 T97 与 95% CI](plots/t97-comparison.png)',
'',
...main.map(r=>`- **${r.q}**：n=${r.samples}，${r.players} 位选手，${r.contests} 场/${r.problems} 题，成功=${r.solved}；A=${minutes(r.t97KmSeconds)}，95% CI ${interval(r.ciLowSeconds,r.ciHighSeconds,r.ciStatus)}；B=${minutes(r.successP50Seconds)}，95% CI ${interval(r.successMedianCiLowSeconds,r.successMedianCiHighSeconds,r.successMedianCiStatus)}；A−B=${minutes(r.kmMinusSuccessMedianSeconds)}，配对 95% CI ${interval(r.differenceCiLowSeconds,r.differenceCiHighSeconds,r.differenceCiStatus)}。`),
'',
'## 如何理解差异',
'',
'A 回答“把未切掉的人也算上，何时累计约一半解出”；B 回答“本次比赛已经切掉的人，典型耗时是多少”。B 适合“成功者中位完成度约 97%”的最新目标；A 保留为总体解出难度诊断。不能把 B 对应的时间宣称为总体 50% 解出时刻，也不能通过计分公式强制实际解出率恰好 50%。',
'',
'B 条件于比赛截止前成功，后序题剩余时间较短会截掉较慢成功者，不能将曲线变平或局部下降直接解读为高 Rating 选手做题更快。A 的删失校正也依赖假设，不能消除读题起点误差或严格顺序筛选造成的偏差。',
'',
`两种估计的区间以及 A−B 的区间均由 ${bootstrap.reps} 次**配对比赛聚类 bootstrap**产生。保留 KM 不可识别的重复样本，不强填有限上界；同一选手跨比赛的依赖仍未完全处理。差值区间不覆盖 0 也只针对本次选择的参赛群体，不是跨所有题目的因果结论。`,
'',
'## 数据拟合',
'',
`对 ${main.length} 个 Rating 档的经验点估计分别拟合加权多项式，权重为每档有效样本量；模型阶数用留一 Rating 档交叉验证选择。KM 曲线选择 ${fit.selected.km.degree} 次式，LOOCV RMSE=${(fit.selected.km.loocvRmseSeconds/60).toFixed(2)} 分钟；成功者中位曲线选择 ${fit.selected.success.degree} 次式，RMSE=${(fit.selected.success.loocvRmseSeconds/60).toFixed(2)} 分钟。一次式/二次式/三次式指标保存在 [fit_metrics.csv](fit_metrics.csv)。这只是描述性平滑，不改变经验 T97。完整拟合表见 [t97_fitted.csv](t97_fitted.csv)，参数和残差见 [fit.json](fit.json)。`,
'',
`为了得到更平滑、低预测误差的曲线，另使用加权局部线性 Gaussian smoother，在固定带宽候选中按留一 Rating 档加权 MSE 选带宽。KM 选带宽 ${smooth.selected.km.bandwidth}，LOOCV RMSE ${(smooth.selected.km.loocvRmseSeconds/60).toFixed(2)} 分钟；成功者选带宽 ${smooth.selected.success.bandwidth}，RMSE ${(smooth.selected.success.loocvRmseSeconds/60).toFixed(2)} 分钟。未约束结果输出在 [t97_smooth.csv](t97_smooth.csv)：它不做形状约束，但**带宽本身仍会抹掉窄幅交替**，这部分不是「保留」而是「看不出」，见下面「口径稳健的局部反转」。`,
'',
`在此之上再做一层**加权保序回归**（PAVA），把「同 Rating 下 T97 不应随题目 Rating 下降」这个形状先验显式写进估计，输出 [t97_monotone.csv](t97_monotone.csv)。权重取每处核函数权重之和，因此样本稀少的档位权重低、会被邻近档位拉动 —— 这正是用来压住右端反转的机制。代价是它可能掩盖真实反转，所以未约束版本同时保留，逐档调整量与是否落在该档 95% 区间内见 [MONOTONE.md](MONOTONE.md)，主表 [T97_TABLE.md](T97_TABLE.md) 把两列并排列出。`,
'',
`在 ${FIT_MIN_Q}–${FIT_MAX_Q} 范围内，平滑后的经验预测可用于连续查表，但边界外不应外推；投入产品前仍需按比赛留出验证，并处理题目间相关性。`,
'',
...(inversions.length?[
  '### 口径稳健的局部反转（读表前必读）',
  '',
  ...inversions.map(v=>`- ${v.label}：**${v.lo} 档反而高于 ${v.hi} 档**。九种筛选口径下 ${v.lo} 档为 ${minutes(v.loRange[0])}–${minutes(v.loRange[1])} 分钟，${v.hi} 档为 ${minutes(v.hiRange[0])}–${minutes(v.hiRange[1])} 分钟，两个区间**不重叠**（换任何一种 Rating 窗口或稳定性门槛都翻不回来）。主推曲线里这一处已经消失，抹掉它的是**${v.survivesSmoothing?'保序回归':'核平滑'}**。`),
  '',
  '区间不重叠说明这不是样本量不足造成的噪声，而是数据里的形状。主推曲线把这些反转全部消掉了，但用的是两种**代价不同**的机制：',
  '',
  `- **${`核平滑抹掉的`}**：带宽 ${smooth.selected.success.bandwidth} 的局部线性平滑对 ±125 范围内的档位做加权平均，相邻档相差几分钟的交替在平均里就抵消了。代价是那里若真有信号，也一并被吃掉 —— 所以下面的「未约束对照」**不能**证明核平滑没吃信号，它只跳过了保序回归那一步。`,
  `- **${`保序回归压平的`}**：这些反转在未约束平滑里依然存在，只能靠形状约束合并成平线${survivesSmoothing.length?`（本次是 ${[...new Set(survivesSmoothing.map(v=>`${v.lo}→${v.hi}`))].join('、')}）`:''}。只有这些位置的平滑值可能落到自身经验点 95% 区间之外，[MONOTONE.md](MONOTONE.md) 里标为「否」—— 那是「不许下降」这条先验与数据正面冲突时的必然结果。`,
  '',
  '因此主推曲线应当读成「**在『T97 不随难度下降』这一先验下最保守的估计**」，而不是实测点。要做产品决策时以本节列出的实测区间为准。',
  '',
  '一个候选机制是成功者条件化偏差：题目越难，在题序里越靠后，剩余比赛时间越短，慢速成功者越早被删失，于是「成功者中位」被系统性压低。现有数据无法排除该机制，因此**不能**把高档位的低读数解读成「高 Rating 题目对匹配选手反而更容易」。',
  '',
]:['没有发现跨九种筛选口径都成立的局部反转：相邻档位的点估计差异都能被筛选口径的选择解释。','']),
'',
'## 采样方式与前一轮的区别',
'',
'前一轮为了节约接口调用，只查询 120 位选手的完整历史。本轮对所选比赛的所有合格正式参赛者构建候选记录，并用多场官方 ratingChanges 确认证据：某人在目标题比赛前已出现至少 10 次，就能证明其符合稳定性门槛。记录里的 priorRatedKind=certified_lower_bound 明确表示“已证实的场次下界”，不是精确的全部历史次数。原有完整历史仍用于那 120 位选手。',
`本轮先把 ${yearSpan} 全部正式比赛的 Rating 变更并进账本（共 ${manifest.historyContests?.length??0} 场），再挑比赛补档位。这一步是必要的：账本原先只覆盖 97 场、平均每月 1–4 场，而「赛前已参赛 ≥10 场」完全依赖它证明，结果是低档位只有极活跃的老手能过关 —— 800 档窗口内有 68025 条记录、只有 2281 条通过，通过率 3.4%，其中 65% 卡在 1–4 场。账本铺满后，同一批比赛的合格记录大幅增加，纳入的人也更接近「稳定参赛」而不是「异常活跃」。`,
'',
'本轮仍可能排除在所选历史比赛里出现较少、实际却很资深的选手。因此这是一组“可验证稳定参赛者”的样本，不是全体同 Rating 用户的无偏随机样本。前后结果变化不能全部归因于样本量增加；本报告只在本轮同一组数据内公平对比 A/B。',
'',
'## 筛选敏感性',
'',
...main.map(r=>{const v=sensitivity.filter(s=>s.q===r.q),a=v.filter(s=>s.t97KmSeconds!==null),b=v.filter(s=>s.successP50Seconds!==null);return `- ${r.q}：九种口径 n=${Math.min(...v.map(s=>s.samples))}–${Math.max(...v.map(s=>s.samples))}；A 可识别 ${a.length}/9，范围 ${a.length?minutes(Math.min(...a.map(s=>s.t97KmSeconds)))+'–'+minutes(Math.max(...a.map(s=>s.t97KmSeconds))):'无'}；B 范围 ${b.length?minutes(Math.min(...b.map(s=>s.successP50Seconds)))+'–'+minutes(Math.max(...b.map(s=>s.successP50Seconds))):'无'}。`; }),
'',
'九种口径是 Rating ±50/±100/±150 × 赛前参赛 ≥5/≥10/≥20。这里的范围是筛选敏感性，不是 95% CI。阶段门槛中的场次数有下界证据；证据不足不等于实际参赛少于门槛。',
'',
'计时起点仍是前一道正常 AC 的代理值，不能观察真正开始读题；严格顺序筛选及比赛结束删失仍可能产生选择偏差。各档经验点估计均为 empirical、不平滑；主推曲线只在核平滑之上加了单调约束，且与未约束版本并排给出，不据此固定 98%–100.5% 的时间分位点。',
'',
'[分钟单位对比 CSV](comparison.csv) · [完整秒单位统计](t97_raw.csv) · [九组敏感性](sensitivity.csv) · [数据来源与配置](summary.json) · [首批结果](../cf-study-first-batch/REPORT.md)',
'',
`[${FIT_MIN_Q}–${FIT_MAX_Q} 平滑 T97 表](T97_TABLE.md) · [机器可读表](t97_table.csv)`,
'',
`生成时间：${new Date().toISOString()}；抓取失败数：${manifest.errors.length}。原始响应带来源 URL、抓取时间，离线缓存可重建。`,
];
await fs.writeFile(root+'/COMPARISON.md',text.join('\n')+'\n');
await fs.writeFile(root+'/REPORT.md',text.join('\n')+'\n');
console.log(JSON.stringify({mainSamples:total,minPerBin:minimum,comparisons},null,2));
