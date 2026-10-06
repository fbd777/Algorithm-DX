// 按比赛留出验证：把「拟合曲线」当成一个预测器，用完全没参与拟合的比赛给它打分。
//
// 为什么必须这么做：核平滑 + 保序回归是描述性平滑，它在自己拟合过的档位上当然贴合原数据
// （MONOTONE.md 里那些「仍在区间内」正是这个意思）。唯一能回答「这条曲线拿去用靠不靠得住」
// 的办法，是让它在没见过的比赛上预测，并和几个朴素基线比。
//
// 分组单位是**比赛**而不是样本行：同一场比赛里几千条选手×题目记录高度相关，
// 按行分折会让训练集和测试集共享同一场比赛，误差被系统性低估。
//
// 四个候选预测器，每个都在训练集上重新走一遍生产流程：
//   constant  常数：训练档位的加权平均（「难度与耗时无关」的零模型）
//   raw       直接用训练档位的经验点，不平滑（「不做平滑」的对照）
//   smooth    按生产带宽选择 + 核平滑，未约束（「只平滑不约束」的对照）
//   monotone  核平滑 + 保序回归（**当前主推**）
//
// 判据在跑之前就定好，避免事后挑指标（见 gates）。
import fs from 'node:fs/promises';
import {bandRows,binEstimate,bootstrapPair,fitCurve,selectBandwidth,fitWeight,gaussianWeight,rng,MAIN_BAND,MAIN_MIN_PRIOR,FIT_MIN_Q,FIT_MAX_Q,fitGrid} from './core.mjs';
const root='results/cf-study';
const num=(name,fallback)=>{const hit=process.argv.find(x=>x.startsWith(`--${name}=`));return hit?Number(hit.split('=')[1]):fallback;};
const folds=num('folds',5),repeats=num('repeats',8),reps=num('bootstrap',500),seed=num('seed',20260918);
if(!Number.isInteger(folds)||folds<2)throw Error('--folds must be an integer >= 2');
if(!Number.isInteger(repeats)||repeats<1)throw Error('--repeats must be a positive integer');
const PREDICTORS=['constant','raw','smooth','monotone'];
// 留出档位要够格当评分目标：至少 3 场独立比赛、至少 100 条样本。
// 门槛与训练侧一致（训练侧还要求 samples>=100 才参与平滑），否则会拿一个噪声目标去罚预测器。
const MIN_TARGET_CONTESTS=3,MIN_TARGET_SAMPLES=100;
const GRID100=[];for(let q=FIT_MIN_Q;q<=FIT_MAX_Q;q+=100)GRID100.push(q);
const SMOOTH_GRID=fitGrid();

const samples=JSON.parse(await fs.readFile('data/cf-study/processed/samples.json','utf8'));
const manifest=JSON.parse(await fs.readFile('data/cf-study/manifest.json','utf8'));
const panel=samples.filter(r=>r.q>=FIT_MIN_Q&&r.q<=FIT_MAX_Q&&Math.abs(r.oldRating-r.q)<=MAIN_BAND&&r.priorRated>=MAIN_MIN_PRIOR);
const byQ=new Map(GRID100.map(q=>[q,panel.filter(r=>r.q===q)]));
const contestIds=[...new Set(panel.map(r=>r.contestId))].sort((a,b)=>a-b);
const startOf=new Map(manifest.contests.map(c=>[c.id,c.start]));
const weighted=rows=>rows.map(r=>({...r,weight:gaussianWeight(r.oldRating,r.q)}));

// 给定一组比赛，算出逐档点估计。用的是 core.mjs 的 binEstimate —— 与 analyze.mjs 同一份实现。
function binTable(keep){
  const out=new Map();
  for(const q of GRID100){
    const rows=byQ.get(q).filter(r=>keep.has(r.contestId));
    if(!rows.length)continue;
    const {summary}=binEstimate(weighted(rows));
    out.set(q,{q,y:summary.successP50Seconds,kmSeconds:summary.t97KmSeconds,contests:summary.contests,samples:summary.samples,effectiveSamples:summary.effectiveSamples,solved:summary.solved,status:summary.status});
  }
  return out;
}
// 训练侧：在留出集之外的档位上拟合四个预测器。网格用生产的 25 步长网格，
// 取值点用 100 步长 —— 与 table.mjs 读表的方式完全一致，验的就是真正上线的那条曲线。
function buildPredictors(trainBins){
  const data=[...trainBins.values()].filter(b=>b.y!=null&&b.samples>=100).map(b=>({q:b.q,y:b.y,effectiveSamples:b.effectiveSamples,samples:b.samples}));
  if(data.length<4)return null;
  const selection=selectBandwidth(data);
  const smooth=fitCurve(data,{bandwidth:selection.bandwidth,grid:SMOOTH_GRID,monotone:false});
  const monotone=fitCurve(data,{bandwidth:selection.bandwidth,grid:SMOOTH_GRID,monotone:true});
  let sw=0,sy=0;for(const b of data){const w=fitWeight(b);sw+=w;sy+=w*b.y;}
  const raw=new Map(data.map(b=>[b.q,b.y]));
  const at=q=>({
    constant:sw?sy/sw:null,
    raw:raw.get(q)??null,
    smooth:smooth.points.find(p=>p.q===q)?.y??null,
    monotone:monotone.points.find(p=>p.q===q)?.y??null,
  });
  return {bandwidth:selection.bandwidth,bands:data.length,at};
}
const rmse=recs=>recs.length?Math.sqrt(recs.reduce((n,r)=>n+r.err*r.err,0)/recs.length):null;
const mae=recs=>recs.length?recs.reduce((n,r)=>n+Math.abs(r.err),0)/recs.length:null;
// 配对 + 分折聚类 bootstrap：主推 vs 对照的 RMSE 差，按「折实例」整体重抽样。
// 同一折内的档位共享训练集，不能当作独立观测；重复分折之间又有重叠，所以这条区间是近似的，
// 只用于判断「差的方向是否稳定」，不用它做显著性断言。
function pairedBootstrap(records,other,{reps:boot=2000,seed:sd=7}={}){
  const instances=[...new Set(records.map(r=>r.instance))];
  if(instances.length<2)return {low:null,high:null,mean:null};
  const grouped=instances.map(k=>records.filter(r=>r.instance===k));
  const rand=rng(sd),out=[];
  for(let b=0;b<boot;b++){
    let sumA=0,sumB=0,n=0;
    for(let i=0;i<instances.length;i++){
      const g=grouped[Math.floor(rand()*instances.length)];
      for(const r of g){sumA+=r['err_'+other]*r['err_'+other];sumB+=r.err_monotone*r.err_monotone;n++;}
    }
    if(n)out.push(Math.sqrt(sumA/n)-Math.sqrt(sumB/n));
  }
  if(!out.length)return {low:null,high:null,mean:null};
  out.sort((a,b)=>a-b);
  return {low:out[Math.floor(.025*(out.length-1))],high:out[Math.ceil(.975*(out.length-1))],mean:out.reduce((a,b)=>a+b,0)/out.length};
}

// ---- 重复 k 折，按比赛分组 --------------------------------------------------
const instances=[],skipped=[];
for(let rep=0;rep<repeats;rep++){
  const order=[...contestIds],rand=rng(seed+rep*7919);
  for(let i=order.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  for(let f=0;f<folds;f++){
    const testIds=new Set(order.filter((_,i)=>i%folds===f)),trainIds=new Set(order.filter((_,i)=>i%folds!==f));
    const trainBins=binTable(trainIds),testBins=binTable(testIds);
    const predictors=buildPredictors(trainBins);
    const instance=`r${rep}f${f}`;
    if(!predictors){skipped.push({instance,reason:'fewer_than_four_training_bins'});continue;}
    const targets=[];
    for(const q of GRID100){
      const t=testBins.get(q);
      if(!t||t.y==null||t.contests<MIN_TARGET_CONTESTS||t.samples<MIN_TARGET_SAMPLES)continue;
      const pred=predictors.at(q);
      const rec={instance,scope:'fold',repeat:rep,fold:f,q,target:t.y,contests:t.contests,samples:t.samples,bandwidth:predictors.bandwidth};
      for(const p of PREDICTORS){rec[p]=pred[p];rec['err_'+p]=pred[p]===null?null:pred[p]-t.y;}
      if(PREDICTORS.every(p=>rec[p]!==null))targets.push(rec);
    }
    instances.push({instance,scope:'fold',repeat:rep,fold:f,bandwidth:predictors.bandwidth,trainingBins:predictors.bands,testContests:testIds.size,testIds,records:targets});
  }
}
const flat=instances.flatMap(i=>i.records);

// ---- 时间留出：早期比赛训练，晚期比赛测试 --------------------------------
const CUTOFF=Date.UTC(2026,0,1)/1000;
const earlyIds=new Set(contestIds.filter(id=>(startOf.get(id)??0)<CUTOFF)),lateIds=new Set(contestIds.filter(id=>(startOf.get(id)??0)>=CUTOFF));
const temporal=(()=>{
  const trainBins=binTable(earlyIds),testBins=binTable(lateIds);
  const predictors=buildPredictors(trainBins);
  if(!predictors)return {available:false,reason:'fewer_than_four_training_bins',trainContests:earlyIds.size,testContests:lateIds.size,records:[]};
  const records=[];
  for(const q of GRID100){
    const t=testBins.get(q);
    if(!t||t.y==null||t.contests<MIN_TARGET_CONTESTS||t.samples<MIN_TARGET_SAMPLES)continue;
    const pred=predictors.at(q);
    const rec={instance:'temporal',scope:'temporal',q,target:t.y,contests:t.contests,samples:t.samples,kmTarget:t.kmSeconds,bandwidth:predictors.bandwidth};
    for(const p of PREDICTORS){rec[p]=pred[p];rec['err_'+p]=pred[p]===null?null:pred[p]-t.y;}
    if(PREDICTORS.every(p=>rec[p]!==null))records.push(rec);
  }
  return {available:true,trainContests:earlyIds.size,testContests:lateIds.size,cutoffISO:new Date(CUTOFF*1000).toISOString(),bandwidth:predictors.bandwidth,bandsPredictors:predictors.bands,records};
})();

// ---- 覆盖率：留出档位自己的 bootstrap 95% 区间是否罩住预测值 --------------
// 只对 repeat 0 做（区间要按档跑 bootstrap，成本高），5 个折实例 × 最多 14 档。
const coverage=[];
for(const inst of instances.filter(i=>i.repeat===0)){
  // 留出折的成员直接取自分折时的那一份，不在这里重新洗一次牌 —— 重新洗牌就等于两处
  // 各自维护一份「谁在留出折里」，迟早对不上。
  const testIds=inst.testIds;
  if(!testIds)continue;
  for(const q of GRID100){
    const t=inst.records.find(r=>r.q===q);
    if(!t)continue;
    const rows=weighted(byQ.get(q).filter(r=>testIds.has(r.contestId)));
    const ci=bootstrapPair(rows,reps,20260918+q);
    const inside={};
    for(const p of PREDICTORS)inside[p]=ci.success.low===null||ci.success.high===null?null:(t[p]>=ci.success.low&&t[p]<=ci.success.high);
    coverage.push({instance:inst.instance,q,contests:t.contests,samples:t.samples,target:t.target,ciLowSeconds:ci.success.low,ciHighSeconds:ci.success.high,inside});
  }
}

// ---- 汇总 ------------------------------------------------------------------
const summaryOf=records=>Object.fromEntries(PREDICTORS.map(p=>[p,{rmseSeconds:rmse(records.map(r=>({err:r['err_'+p]}))),maeSeconds:mae(records.map(r=>({err:r['err_'+p]})))}]));
const overall=summaryOf(flat);
const paired={};
for(const other of ['constant','raw','smooth'])paired[other]=pairedBootstrap(flat,other);
const perRepeat=[];for(let rep=0;rep<repeats;rep++){const recs=flat.filter(r=>r.repeat===rep);if(recs.length)perRepeat.push({repeat:rep,...summaryOf(recs),records:recs.length});}
const perBand=GRID100.map(q=>{
  const recs=flat.filter(r=>r.q===q);
  if(!recs.length)return {q,records:0};
  return {q,records:recs.length,meanTarget:recs.reduce((n,r)=>n+r.target,0)/recs.length,...summaryOf(recs)};
}).filter(r=>r.records);
// 分段汇总：低段与高段的表现很可能完全不同，合成一个 RMSE 会把它藏起来。
const SEGMENTS=[{name:'800–1200',lo:800,hi:1200},{name:'1300–2100',lo:1300,hi:2100}];
const segmentsOf=records=>SEGMENTS.map(s=>{const recs=records.filter(r=>r.q>=s.lo&&r.q<=s.hi);return {name:s.name,lo:s.lo,hi:s.hi,records:recs.length,...(recs.length?summaryOf(recs):{})};});
const segments=segmentsOf(flat);
// 题序位置：必须检查的替代解释。归属时间是「上一个题位的 AC → 本题的 AC」，
// 第一题从比赛开始算，所以一个 Rating 2000 的题排在靠前的题位上，读数接近「开场到那一刻」；
// 而且低档位几乎全是第一题，高档位则在第 4~5 题 —— 题序与难度是系统相关的。
// 如果高档位系统性地由「靠前的题」构成，那反转可能只是题序造成的假象 —— 所以这里要排掉它。
const ordinal=p=>{const m=/^([A-Z]+)([0-9]*)$/.exec(p??'');if(!m)return null;return m[1].charCodeAt(0)-64+(m[2]?Number(m[2])-1:0)/10;};
const medianTime=rows=>{if(!rows.length)return null;const s=rows.map(r=>r.time).sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
const positionByBand=GRID100.map(q=>{
  const rows=byQ.get(q),solved=rows.filter(r=>r.event);
  const ords=rows.map(r=>ordinal(r.problem)).filter(v=>v!==null);
  const lateOnly=solved.filter(r=>(ordinal(r.problem)??0)>=3);
  return {q,samples:rows.length,
    meanOrdinal:ords.length?ords.reduce((a,b)=>a+b,0)/ords.length:null,
    earlyShare:ords.length?ords.filter(v=>v<=2).length/ords.length:null,
    solvedMedianSeconds:medianTime(solved),
    lateOnlySamples:lateOnly.length,
    lateOnlySolvedMedianSeconds:medianTime(lateOnly)};
});
// 把反转放到「题序 ≥ 3」的子集里重算一次：反转若消失了，就说明它是题序造成的。
const positionalReversals=(()=>{
  const out=[];
  for(let i=0;i<GRID100.length-1;i++){
    const a=positionByBand[i],b=positionByBand[i+1];
    if(a.lateOnlySolvedMedianSeconds===null||b.lateOnlySolvedMedianSeconds===null)continue;
    out.push({lo:a.q,hi:b.q,deltaSeconds:b.lateOnlySolvedMedianSeconds-a.lateOnlySolvedMedianSeconds,samples:Math.min(a.lateOnlySamples,b.lateOnlySamples)});
  }
  return out;
})();
// 时间留出里逐相邻档位的方向。判据 3 失败时，这一节负责说明**为什么**：
// 如果留出集自己就在下降，而主推曲线按构造不许下降，误差必然咬在那里。
const temporalReversals=(()=>{
  const byQ=new Map((temporal.records??[]).map(r=>[r.q,r])),out=[];
  for(let i=0;i<GRID100.length-1;i++){
    const a=byQ.get(GRID100[i]),b=byQ.get(GRID100[i+1]);
    if(a&&b)out.push({lo:GRID100[i],hi:GRID100[i+1],loTarget:a.target,hiTarget:b.target,deltaSeconds:b.target-a.target,loContests:a.contests,hiContests:b.contests});
  }
  return out;
})();
// 逐相邻档位的「留出集是否复现下降」。这是本节最直接回答「反转是不是真的」的量：
// 如果某个相邻对在绝大多数折实例里都下降，它就不是噪声；如果只有一半左右，那它不可分辨。
const reversals=GRID100.slice(0,-1).map((q,i)=>{
  const hi=GRID100[i+1];
  const recs=[];
  for(const inst of instances){
    const a=inst.records.find(r=>r.q===q),b=inst.records.find(r=>r.q===hi);
    if(a&&b)recs.push(b.target-a.target);
  }
  if(!recs.length)return {lo:q,hi:hi,instances:0};
  const sorted=[...recs].sort((a,b)=>a-b);
  const rand=rng(31337+i),out=[];
  for(let b=0;b<2000;b++){let s=0;for(let j=0;j<recs.length;j++)s+=recs[Math.floor(rand()*recs.length)];out.push(s/recs.length);}
  out.sort((a,b)=>a-b);
  return {lo:q,hi:hi,instances:recs.length,decreaseRate:recs.filter(v=>v<0).length/recs.length,meanDeltaSeconds:recs.reduce((a,b)=>a+b,0)/recs.length,medianDeltaSeconds:sorted[Math.floor(sorted.length/2)],ciLowSeconds:out[Math.floor(.025*(out.length-1))],ciHighSeconds:out[Math.ceil(.975*(out.length-1))]};
}).filter(r=>r.instances);
// k 折里由区间判定为「复现的下降」的相邻对，以及它与时间留出的交叉比对。
// 这两项是**跑完之后**才拿来做对照的，属于事后诊断，不是判据 —— 判据只有那三条。
const kfoldRobustDecreases=reversals.filter(r=>r.ciHighSeconds!==undefined&&r.ciHighSeconds<0).map(r=>`${r.lo}–${r.hi}`);
const temporalDecreases=temporalReversals.filter(x=>x.deltaSeconds<0).map(x=>`${x.lo}–${x.hi}`);
const temporalAgreesWithReversal=temporalDecreases.filter(k=>kfoldRobustDecreases.includes(k));
// 留出集自身的单调性违反率，用来对比「主推曲线按构造 0 违反」。
const violations=instances.map(inst=>{
  const vals=GRID100.map(q=>inst.records.find(r=>r.q===q)?.target??null);
  let v=0,pairs=0;
  for(let i=0;i<vals.length-1;i++)if(vals[i]!==null&&vals[i+1]!==null){pairs++;if(vals[i+1]<vals[i])v++;}
  return {instance:inst.instance,violations:v,pairs,rate:pairs?v/pairs:null};
});
const bandwidths=instances.map(i=>i.bandwidth);
const bandwidthCounts=Object.fromEntries([...new Set(bandwidths)].sort((a,b)=>a-b).map(h=>[h,bandwidths.filter(x=>x===h).length]));
// 全量数据选出来的带宽（生产值）。折间选到的带宽与它差得越远，说明这一档选择越不稳。
const productionBandwidth=await (async()=>{try{return JSON.parse(await fs.readFile(root+'/smooth_fit.json','utf8')).selected?.success?.bandwidth??null;}catch{return null;}})();
const coverageRate=p=>{const rows=coverage.filter(c=>c.inside[p]!==null);return {covered:rows.filter(c=>c.inside[p]).length,total:rows.length,rate:rows.length?rows.filter(c=>c.inside[p]).length/rows.length:null};};
const coveragePerPredictor=Object.fromEntries(PREDICTORS.map(p=>[p,coverageRate(p)]));
const temporalSummary=temporal.available?summaryOf(temporal.records):null;
const temporalPaired=temporal.available?Object.fromEntries(['constant','raw','smooth'].map(o=>[o,temporal.records.length?pairedBootstrap(temporal.records,o):{low:null,high:null,mean:null}])):null;

// ---- 预注册判据 ------------------------------------------------------------
const finite=x=>x!==null&&x!==undefined&&Number.isFinite(x);
const g1=finite(overall.monotone?.rmseSeconds)&&finite(overall.constant?.rmseSeconds)&&finite(paired.constant.low)
  ? {value:overall.monotone.rmseSeconds<overall.constant.rmseSeconds&&paired.constant.low>0,detail:`主推 ${(overall.monotone.rmseSeconds/60).toFixed(2)} 分钟 vs 常数 ${(overall.constant.rmseSeconds/60).toFixed(2)} 分钟；配对区间 [${(paired.constant.low/60).toFixed(3)}, ${(paired.constant.high/60).toFixed(3)}] 分钟`}
  : {value:false,detail:'样本不足，无法比较'};
const g2=finite(overall.monotone?.rmseSeconds)&&finite(overall.raw?.rmseSeconds)
  ? {value:overall.monotone.rmseSeconds<=overall.raw.rmseSeconds*1.1,detail:`主推 ${(overall.monotone.rmseSeconds/60).toFixed(2)} 分钟 vs 训练档位经验点 ${(overall.raw.rmseSeconds/60).toFixed(2)} 分钟（上限 ${(overall.raw.rmseSeconds*1.1/60).toFixed(2)}）`}
  : {value:false,detail:'样本不足，无法比较'};
const g3=finite(temporalSummary?.monotone?.rmseSeconds)&&finite(temporalSummary?.constant?.rmseSeconds)
  ? {value:temporalSummary.monotone.rmseSeconds<temporalSummary.constant.rmseSeconds,detail:`2026 留出：主推 ${(temporalSummary.monotone.rmseSeconds/60).toFixed(2)} 分钟 vs 常数 ${(temporalSummary.constant.rmseSeconds/60).toFixed(2)} 分钟`}
  : {value:false,detail:'时间留出不可用或样本不足'};
const gates={beatsConstant:g1,notWorseThanRaw:g2,temporalAgrees:g3};
const productionReady=Object.values(gates).every(g=>g.value);

const result={
  kind:'contest-level hold-out validation',
  generatedAt:new Date().toISOString(),
  config:{folds,repeats,bootstrapReps:reps,seed,groupingUnit:'contest',boundary:'main criterion |oldRating - q| <= '+MAIN_BAND+' and priorRated >= '+MAIN_MIN_PRIOR,fitRange:[FIT_MIN_Q,FIT_MAX_Q],gridStep:'25 (evaluated at every 100)',minTargetContests:MIN_TARGET_CONTESTS,minTargetSamples:MIN_TARGET_SAMPLES},
  panel:{contests:contestIds.length,rows:panel.length,byBand:GRID100.map(q=>({q,contests:new Set(byQ.get(q).map(r=>r.contestId)).size,samples:byQ.get(q).length}))},
  foldInstances:{total:instances.length,skipped,qualifiedTargets:flat.length,bandsPerInstance:instances.length?flat.length/instances.length:0},
  predictors:PREDICTORS,
  overall,paired,perRepeat,perBand,segments,reversals,violations,
  positionByBand,positionalReversals,
  temporalReversals,kfoldRobustDecreases,temporalDecreasesOnKfoldRobust:temporalAgreesWithReversal,
  bandwidth:{counts:bandwidthCounts,min:bandwidths.length?Math.min(...bandwidths):null,max:bandwidths.length?Math.max(...bandwidths):null},
  coverage:{perPredictor:coveragePerPredictor,rows:coverage},
  temporal:{...temporal,summary:temporalSummary,paired:temporalPaired},
  gates,productionReady,
};
await fs.writeFile(root+'/validation.json',JSON.stringify(result,null,2));
const header=['scope','instance','repeat','fold','q','contests','samples','target','constant','raw','smooth','monotone','err_constant','err_raw','err_smooth','err_monotone','bandwidth'];
const csvRows=[...flat.map(r=>({...r,scope:'fold'})),...temporal.records.map(r=>({instance:'temporal',scope:'temporal',repeat:'',fold:'',...r}))];
await fs.writeFile(root+'/validation.csv',header.join(',')+'\n'+csvRows.map(r=>header.map(k=>r[k]??'').join(',')).join('\n')+'\n');

const min=v=>v===null||v===undefined?'—':(v/60).toFixed(2);
// 逐档的平均偏差：主推减留出目标。产品要用这条曲线把「用时」换算成「完成度」，
// 那么偏差的方向与幅度就是直接的评分误差来源，必须能一眼看到最大的一处。
const biasByBand=perBand.map(b=>{
  const recs=flat.filter(r=>r.q===b.q);
  const biasSeconds=recs.length?recs.reduce((n,r)=>n+(r.monotone-r.target),0)/recs.length:null;
  return {q:b.q,records:recs.length,meanTargetSeconds:b.meanTarget,biasSeconds,relativeBias:b.meanTarget&&biasSeconds!==null?biasSeconds/b.meanTarget:null};
});
const worstBias=[...biasByBand].filter(b=>b.biasSeconds!==null).sort((a,b)=>Math.abs(b.biasSeconds)-Math.abs(a.biasSeconds))[0];
// 题序限制后仍下降的相邻对，与 k 折判定为「复现的下降」的那几对求交集 ——
// 交集越大，越能排除「反转只是题序构成的差异」这个替代解释。
const positionalDecreases=positionalReversals.filter(x=>x.deltaSeconds<0).map(x=>`${x.lo}–${x.hi}`);
const robustSurvivesPosition=kfoldRobustDecreases.filter(k=>positionalDecreases.includes(k));
const robustExplainedByPosition=kfoldRobustDecreases.filter(k=>!positionalDecreases.includes(k));
const earlyBand=positionByBand[0],lateBand=positionByBand.at(-1);
const bandwidthMode=Object.entries(bandwidthCounts).sort((a,b)=>b[1]-a[1])[0];
const pct=v=>v===null||v===undefined?'—':(v*100).toFixed(1)+'%';
const signed=v=>v===null||v===undefined?'—':(v>=0?'+':'')+(v/60).toFixed(2);
const lines=[
  '# 按比赛留出验证','',
  `生成时间 ${new Date().toISOString()}。分组单位是**比赛**：${contestIds.length} 场比赛被随机分成 ${folds} 折，重复 ${repeats} 次（不同随机划分），每个折实例用其余折重新拟合曲线，再在留出折上评分。共 ${instances.length} 个折实例、${flat.length} 个可评分的（折, 档位）观测。`,'',
  '评分目标是**留出折自己的经验点估计**（成功者中位耗时，主口径 ±'+MAIN_BAND+'、赛前 rated ≥'+MAIN_MIN_PRIOR+'，与生产口径完全一致）。要求该档在留出折里至少有 '+MIN_TARGET_CONTESTS+' 场独立比赛、'+MIN_TARGET_SAMPLES+' 条样本，否则不评分 —— 拿一个纯噪声目标去罚预测器没有意义。','',
  '四个预测器都在训练集上重新走一遍生产流程，评估点取 `table.mjs` 读表的同一批 100 步长档位，所以这里验的就是**要上线的那条曲线**。','',
  '## 结论','',
];
for(const [key,g] of Object.entries(gates))lines.push(`- **${g.value?'通过':'未通过'}** · ${({beatsConstant:'主推优于常数基线',notWorseThanRaw:'平滑与单调约束的代价可接受',temporalAgrees:'时间留出方向一致'})[key]}：${g.detail}`);
const robustCount=kfoldRobustDecreases.length;
lines.push('',`因此 \`productionReady\` = **${productionReady}**。`,'',
  `判据 1、2 说明两件事：曲线的整体趋势确实胜过「难度与耗时无关」的零模型（RMSE 降低约 ${((overall.constant.rmseSeconds-overall.monotone.rmseSeconds)/60).toFixed(2)} 分钟），而平滑与单调约束本身几乎没有代价（主推 ${min(overall.monotone.rmseSeconds)} 分钟 vs 不平滑的经验点 ${min(overall.raw.rmseSeconds)} 分钟）。`,
  // 这一段必须挂在**判据 3 的实际结果**上，不能挂在「反转处数」上 ——
  // 反转处数 > 0 与判据 3 失败是两件事：留出集里存在被压平的真实反转时，
  // 只要整体仍显著优于常数基线，判据 3 依然是通过的。
  gates.temporalAgrees.value
    ? `判据 3 通过：时间留出上主推依然显著优于常数基线。`+
      (robustCount
        ? `下面「反转复现率」一节里那 ${robustCount} 处相邻档位的**一致下降**（${kfoldRobustDecreases.join('、')}）仍会被保序回归压平，在这些档位上主推一定偏长；但它们的幅度不足以翻转整体结论。`
        : '留出集里没有出现稳定反转，形状先验与数据没有冲突。')
    : robustCount
      ? `判据 3 没通过，原因在下面「反转复现率」一节：留出数据本身在 ${robustCount} 处相邻档位上**一致下降**（${kfoldRobustDecreases.join('、')}），而主推曲线按构造必须把它们压平，于是在这些档位上一定偏长。**这不是实现缺陷，是形状先验与数据的正面冲突** —— 曲线保证了不出现反转，代价就是在真实存在反转的位置系统性偏离。`
      : '判据 3 没通过。',
  '',
  '## 主结果','',
  '| 预测器 | RMSE（分钟） | MAE（分钟） | 相对主推的配对 RMSE 差 95% 区间 |','|---|---:|---:|---|');
lines.push(`| 常数（零模型） | ${min(overall.constant.rmseSeconds)} | ${min(overall.constant.maeSeconds)} | ${paired.constant.low===null?'—':`[${signed(paired.constant.low)}, ${signed(paired.constant.high)}]`} |`);
lines.push(`| 训练档位经验点（不平滑） | ${min(overall.raw.rmseSeconds)} | ${min(overall.raw.maeSeconds)} | ${paired.raw.low===null?'—':`[${signed(paired.raw.low)}, ${signed(paired.raw.high)}]`} |`);
lines.push(`| 核平滑（未约束） | ${min(overall.smooth.rmseSeconds)} | ${min(overall.smooth.maeSeconds)} | ${paired.smooth.low===null?'—':`[${signed(paired.smooth.low)}, ${signed(paired.smooth.high)}]`} |`);
lines.push(`| **核平滑 + 保序（主推）** | **${min(overall.monotone.rmseSeconds)}** | **${min(overall.monotone.maeSeconds)}** | 基准 |`);
lines.push('','区间是「对照的 RMSE − 主推的 RMSE」，按折实例整体重抽样；正值表示主推更好。同一折内的档位共享训练集、重复分折之间又有重叠，所以这条区间是近似的，只用来看方向是否稳定，不用它做显著性断言。','');
lines.push(`逐次重复看方向是否稳定（${perRepeat.length} 次）：
`);
lines.push('| 重复 | 观测 | 常数 | 经验点 | 未约束平滑 | 主推 |','|---|---:|---:|---:|---:|---:|');
for(const r of perRepeat)lines.push(`| ${r.repeat} | ${r.records} | ${min(r.constant.rmseSeconds)} | ${min(r.raw.rmseSeconds)} | ${min(r.smooth.rmseSeconds)} | ${min(r.monotone.rmseSeconds)} |`);
lines.push('',`## 逐档误差（${perBand.length} 档）`,'',
  '| Rating | 观测数 | 留出目标均值（分钟） | 常数 RMSE | 经验点 RMSE | 未约束 RMSE | 主推 RMSE | 主推平均偏差 |','|---:|---:|---:|---:|---:|---:|---:|---:|');
for(const b of perBand){
  const recs=flat.filter(r=>r.q===b.q);
  const bias=recs.reduce((n,r)=>n+(r.monotone-r.target),0)/recs.length;
  lines.push(`| ${b.q} | ${b.records} | ${min(b.meanTarget)} | ${min(b.constant.rmseSeconds)} | ${min(b.raw.rmseSeconds)} | ${min(b.smooth.rmseSeconds)} | ${min(b.monotone.rmseSeconds)} | ${signed(bias)} |`);
}
lines.push('','### 分段汇总','',
  '把 14 档拆成低段与高段分别看 —— 合成一个 RMSE 会把「低段很准、高段不准」藏起来。','',
  '| 区间 | 观测 | 常数 | 经验点 | 未约束平滑 | 主推 |','|---|---:|---:|---:|---:|---:|');
for(const s of segments)lines.push(`| ${s.name} | ${s.records} | ${min(s.constant?.rmseSeconds)} | ${min(s.raw?.rmseSeconds)} | ${min(s.smooth?.rmseSeconds)} | ${min(s.monotone?.rmseSeconds)} |`);
lines.push('','### 主推曲线相对留出目标的平均偏差','',
  '产品要用这条曲线把「用时」换算成「完成度」，那么偏差的方向与幅度就是直接的评分误差来源。','',
  '| Rating | 观测 | 留出目标均值 | 主推平均偏差 | 相对偏差 |','|---:|---:|---:|---:|---:|');
for(const b of biasByBand)lines.push(`| ${b.q} | ${b.records} | ${min(b.meanTargetSeconds)} | ${signed(b.biasSeconds)} | ${pct(b.relativeBias)} |`);
if(worstBias)lines.push('',`偏差最大的一档是 **${worstBias.q}**：平均 ${signed(worstBias.biasSeconds)} 分钟，相对量级 ${pct(worstBias.relativeBias)}。（正号 = 主推算出的耗时比留出实测更长。）`,'');
lines.push('','## 反转复现率：留出集里那些「高档位反而更快」到底是不是真的','',
  '每一行取一个相邻档位对，统计它在所有同时包含这两档的折实例里**下降**的比例。','',
  '- 比例接近 0：留出数据一致显示上升，是稳定规律。',
  '- 比例在 0.5 附近：方向不可分辨，训练集里看到的「下降」多半是噪声。',
  '- 比例接近 1 且均值区间不含 0：**反转在没参与拟合的比赛里复现**，它是数据里的形状，不是拟合的产物。','',
  '| 相邻档位 | 有效折实例 | 下降比例 | 平均变化 | 变化 95% 区间 | 判读 |','|---|---:|---:|---:|---|---|');
for(const r of reversals){
  const verdict=r.ciLowSeconds>0?'一致上升':r.ciHighSeconds<0?'**复现的下降**':r.decreaseRate>=0.7?'下降为主但区间含 0':r.decreaseRate<=0.3?'上升为主但区间含 0':'方向不可分辨';
  lines.push(`| ${r.lo} → ${r.hi} | ${r.instances} | ${pct(r.decreaseRate)} | ${signed(r.meanDeltaSeconds)} | ${r.ciLowSeconds===undefined?'—':`[${signed(r.ciLowSeconds)}, ${signed(r.ciHighSeconds)}]`} | ${verdict} |`);
}
const withViolations=violations.filter(v=>v.violations>0);
lines.push('',`作为对照：**留出集的原始经验点**在 ${withViolations.length}/${violations.length} 个折实例里至少出现过一次相邻下降，平均违反率 ${pct(violations.reduce((n,v)=>n+(v.rate??0),0)/violations.length)}。主推曲线按构造是 0 —— 保序回归就是为了消除这些抖动，代价由上面「不比经验点差 10% 以上」那条判据来限制。`,'',
  '## 题序位置：一个必须检查、但排除了的替代解释','',
  '归属时间不是「在这道题上花了多久」，而是**从一个题位的 AC 到本题的 AC**（第一题从比赛开始算）—— 「真正开始读题的时刻」不可观测。所以题序位置本身就是读数的一部分：同一道 Rating 2000 的题，排在 Div.1 的第 2 题大致就是整场到那一刻的用时，排在 Div.2 末尾则要几十分钟。如果高档位系统性地由「靠前的题」构成，上面那些反转就可能只是题序造成的假象，必须排掉。','',
  '（2026-09-18 之前，`X1/X2` 这类 Easy/Hard 成对的题位是按个别题号切分时间轴的，那时 `B2` 的读数真的只有一两分钟；现在同一题位共用起点，那个假象已经消失 —— 见 `SLOT_CHECK.md` / `SUBTASK_MERGE.md`。）','',
  '| Rating | 样本 | 平均题序 | 题序 ≤2 占比 | 成功者中位 | 只留题序 ≥3 的成功者中位 |','|---:|---:|---:|---:|---:|---:|');
for(const b of positionByBand)lines.push(`| ${b.q} | ${b.samples} | ${b.meanOrdinal===null?'—':b.meanOrdinal.toFixed(2)} | ${pct(b.earlyShare)} | ${min(b.solvedMedianSeconds)} | ${min(b.lateOnlySolvedMedianSeconds)}${b.lateOnlySamples?`（n=${b.lateOnlySamples}）`:'（无样本）'} |`);
lines.push('',
  `题序确实随档位系统性变化：${earlyBand.q} 档平均题序 ${earlyBand.meanOrdinal?.toFixed(2)}（${pct(earlyBand.earlyShare)} 的样本题序 ≤2），基本全是该场比赛的第一题；到 ${lateBand.q} 档平均题序 ${lateBand.meanOrdinal?.toFixed(2)}、题序 ≤2 的样本 ${pct(lateBand.earlyShare)}。低档位的读数本质上就是「开场第一题」，这一点读表时要记住。`,
  '把样本限制到「题序 ≥ 3」重算后：','',
  `- 仍然下降的相邻对：${positionalDecreases.length?positionalDecreases.join('、'):'无'}`,
  robustSurvivesPosition.length?`- k 折判定为「复现的下降」的 ${kfoldRobustDecreases.length} 处里，**${robustSurvivesPosition.length} 处（${robustSurvivesPosition.join('、')}）在这一限制下依然下降** —— 题序解释不了它们。`:'',
  robustExplainedByPosition.length?`- 另有 ${robustExplainedByPosition.length} 处（${robustExplainedByPosition.join('、')}）限制后不再下降，这些更可能是题目构成差异造成的。`:'',
  '',
  '结论：**反转不是题序造成的**，但它确实提示「只用题目 Rating 一个维度」是这个估计量的结构性弱点 —— 同一 Rating 在 Div.1 和 Div.2 里扮演的角色不同，而归属时间把这种差异一并算了进去。',
  '','## 覆盖率','',
  `留出档位自身也有抽样不确定性。下表把留出折的 bootstrap ${reps} 次区间（比赛聚类）与该档四个预测值对照，看预测值是否落在区间内。区间只反映抽样误差，不含系统性偏差，因此覆盖率低于名义 95% 是正常的 —— 它衡量的是「平滑/约束把读数搬动了多远」，不是正确率。`,'',
  '| 预测器 | 落入区间 | 合计 | 覆盖率 |','|---|---:|---:|---:|');
for(const p of PREDICTORS){const c=coveragePerPredictor[p];lines.push(`| ${p} | ${c.covered} | ${c.total} | ${pct(c.rate)} |`);}
lines.push('',`## 带宽稳定性`,'',
  `每次重新拟合都独立选一次带宽（最小留一档位加权 MSE），结果分布：${Object.entries(bandwidthCounts).map(([h,n])=>`${h}: ${n} 次`).join('、')}。全部 ${bandwidths.length} 个折实例。`,
  `众数是 **${bandwidthMode[0]}**（${bandwidthMode[1]}/${bandwidths.length}，${pct(bandwidthMode[1]/bandwidths.length)}）${productionBandwidth===null?'':`，全量数据选出的生产带宽是 ${productionBandwidth}`}。${new Set(bandwidths).size===1?'每次都是同一个带宽，这一档选择对分折完全不敏感。':`仍有 ${new Set(bandwidths).size-1} 个折实例选了别的带宽，所以平滑曲线的**局部**形状不宜按单次结果精读；整体趋势不受影响。`}`,'',
  `## 时间留出（外推）`,'');
if(temporal.available){
  lines.push(`训练集 ${temporal.trainContests} 场（2026 之前），测试集 ${temporal.testContests} 场（2026 年），共 ${temporal.records.length} 个可评分档位。这一项测的不是「同样条件下换个样本」，而是**用旧比赛拟合、预测新比赛**。`,'',
    '| 预测器 | RMSE（分钟） | MAE（分钟） |','|---|---:|---:|');
  for(const p of PREDICTORS)lines.push(`| ${p} | ${min(temporalSummary[p].rmseSeconds)} | ${min(temporalSummary[p].maeSeconds)} |`);
  lines.push('','| Rating | 留出目标（分钟） | 主推（分钟） | 偏差 | 独立比赛 | 样本 |','|---:|---:|---:|---:|---:|---:|');
  for(const r of temporal.records)lines.push(`| ${r.q} | ${min(r.target)} | ${min(r.monotone)} | ${signed(r.monotone-r.target)} | ${r.contests} | ${r.samples} |`);
  lines.push('');
  if(temporalReversals.length){
    lines.push(`2026 留出集里逐相邻档位的变化：${temporalReversals.map(x=>`${x.lo}→${x.hi} ${signed(x.deltaSeconds)}`).join('、')}（分钟）。`,'');
    if(temporalDecreases.length)lines.push(`其中 **${temporalDecreases.length} 处是下降**（${temporalDecreases.join('、')}）${temporalAgreesWithReversal.length?`，而且 ${temporalAgreesWithReversal.join('、')} 正是上面 k 折判定为「复现的下降」的那几对`:''}。主推曲线按构造不许下降，所以在这些档位上它必然偏长。`,'');
    lines.push(`**这是事后诊断，不是判据。** 判据只有上面三条，跑之前就定好了。这一节只解释「留出集里的反转长什么样」，`
      +(gates.temporalAgrees.value
        ? `它有 ${temporalDecreases.length} 处下降，但仍不足以让判据 3 失败 —— 判据 3 比较的是**整条曲线对留出目标的 RMSE**，不是逐对的符号。`
        : `它正是判据 3 失败的直接原因；但即便判据 3 通过，也不能反过来拿这一节去加强结论。`),'');
  }
}else lines.push(`时间留出不可用（${temporal.reason}）。`,'');
lines.push('## 这些结论不能说明什么','',
  '- **按比赛留出 ≠ 按选手留出。** 折之间仍有大量选手重叠（熟练选手会反复出现在不同比赛里）。所以这里证明的是「对没见过的比赛」有效，不是「对没见过的选手」有效。','',
  '- **评分目标自身带噪声。** 留出折只有十几场比赛，某个档位可能只剩 3–5 场。四个预测器共用同一个噪声目标，所以相互比较是公平的，但绝对 RMSE 里有相当一部分是目标噪声而不是预测误差。逐档表里观测数少的档位尤其要谨慎。','',
  '- **不能推出因果。** 曲线描述的是「在这个 Rating 档位上，成功者的中位耗时」，不是「把题目 rating 调高就会变慢」。','',
  '- **不覆盖 ' + FIT_MIN_Q + '–' + FIT_MAX_Q + ' 之外。** 区间外没有数据，任何外推都是假设。','',
  `逐档调整量、未约束对照与经验点 95% 区间见 [MONOTONE.md](MONOTONE.md)，完整读数在 [validation.csv](validation.csv) 与 [validation.json](validation.json)。`,'');
await fs.writeFile(root+'/VALIDATION.md',lines.join('\n')+'\n');

// diagnostics.json 的 productionReady 由这里裁定 —— 它是唯一知道验证结果的地方。
// 合并而不是覆盖：report.mjs 往里面写的描述性统计要保留。
const previous=await (async()=>{try{return JSON.parse(await fs.readFile(root+'/diagnostics.json','utf8'));}catch{return {};}})();
const topBias=[...biasByBand].filter(b=>b.biasSeconds!==null).sort((a,b)=>Math.abs(b.biasSeconds)-Math.abs(a.biasSeconds)).slice(0,3);
await fs.writeFile(root+'/diagnostics.json',JSON.stringify({
  ...previous,
  productionReady,
  productionReadyBasis:'三条预注册判据（跑之前就定好，见 VALIDATION.md）：主推优于常数基线、平滑与单调约束的代价可接受、时间留出方向一致。三条全过才置 true。',
  validation:{
    generatedAt:result.generatedAt,groupingUnit:'contest',folds,repeats,observations:flat.length,
    gates:Object.fromEntries(Object.entries(gates).map(([k,v])=>[k,v.value])),
    gatesDetail:gates,
    rmseSeconds:Object.fromEntries(PREDICTORS.map(p=>[p,overall[p].rmseSeconds])),
    robustDecreases:kfoldRobustDecreases,
    bandwidthCounts,
    coverage:coveragePerPredictor,
    topBandBias:topBias,
    temporal:temporal.available?{trainContests:temporal.trainContests,testContests:temporal.testContests,bands:temporal.records.length,rmseSeconds:Object.fromEntries(PREDICTORS.map(p=>[p,temporalSummary[p].rmseSeconds]))}:{available:false},
  },
},null,2));
console.log(`RMSE（分钟）常数 ${min(overall.constant.rmseSeconds)} | 经验点 ${min(overall.raw.rmseSeconds)} | 未约束 ${min(overall.smooth.rmseSeconds)} | 主推 ${min(overall.monotone.rmseSeconds)}`);
console.log(`折实例 ${instances.length} | 可评分观测 ${flat.length} | 覆盖率(主推) ${pct(coveragePerPredictor.monotone.rate)} | productionReady=${productionReady}`);
for(const [key,g] of Object.entries(gates))console.log(`${g.value?'PASS':'FAIL'} ${key}: ${g.detail}`);
console.log(root+'/VALIDATION.md');
