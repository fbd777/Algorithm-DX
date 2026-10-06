import { createHash } from 'node:crypto';
export const hash = x => createHash('sha256').update(String(x)).digest('hex');
export function attachHistory(row,history){
  const current=history.find(h=>h.contestId===row.contestId);
  if(!current||current.oldRating!==row.oldRating)return null;
  const prior=new Set(history.filter(h=>h.contestId!==row.contestId&&h.ratingUpdateTimeSeconds<row.startTime).map(h=>h.contestId));
  return {...row,priorRated:prior.size};
}
// `window` 是**选手赛前 Rating 距题目 Rating 的允许距离**。主流程用 150（
// 主口径 ±100 与敏感性 ±150 都落在里面）。放宽它不会改变循环结构，只是多推入一些
// (选手, 题目) 对 —— 每个选手的题序重建成本与窗口无关。
//
// 为什么要放宽：DX 的评级门槛要锚到「等效选手 Rating = 题目 Rating × 系数因子」，
// 最高一档是 1.160 倍，需要 q 上方 16% 的选手（q=2100 时是 +336），150 不够。
//
// **题位分组（2026-09-18 加）**：CF 把一道被拆成子任务的题显示成两个独立题号
// （`C1` / `C2`），它们在 `problems` 里是**相邻的两项**。不分组的话，「上一题 AC → 本题 AC」
// 这条规则会把 `C2` 的用时算成「解出 C1 之后再解出 C2 的**增量**」——几秒到几十秒，
// 2000 档有 27.4% 的样本是这种行（见 `SUBTASK_PROBE.md`）。
// 所以先把题号按**字母部分**归成「题位」（`B1`+`B2`+`B3` → 一个题位），再走同一套题序逻辑：
//   - 题位解出 = **组内每个子任务都解出**（只交出 B1 不算解出这道题）；
//   - 题位用时 = 从上一次 AC 到组内**最后一个**子任务的 AC；
//   - 题位定数 = 组内**最后一个**子任务的 Rating（解出整道题的门槛由它决定）。
export function candidates(standings, changes, submissions, window=150) {
  const {contest:c,problems,rows}=standings;
  if(c.phase!=='FINISHED'||c.type==='IOI') return [];
  const ratings=new Map(changes.map(x=>[x.handle.toLowerCase(),x.oldRating]));
  const byHandle=new Map();
  for(const s of submissions){
    if(s.author.participantType!=='CONTESTANT'||s.author.members.length!==1||s.relativeTimeSeconds<0||s.relativeTimeSeconds>c.durationSeconds) continue;
    const h=s.author.members[0].handle.toLowerCase();
    if(!byHandle.has(h)) byHandle.set(h,[]);
    byHandle.get(h).push(s);
  }
  // 题号 → **题位**键：只去尾部数字（`B2` → `B`、`C3` → `C`、`A` → `A`）。同键的项一定相邻
  // （standings 按题号排），所以一次线性扫描就够。
  //
  // 为什么需要题位：CF 把一部分题做成 **Easy / Hard Version 成对**（`C1. … (Easy Version)` /
  // `C2. … (Hard Version)`）。它们是**两道定数不同的题**（实测落差中位 +400 分），
  // 不是同一道题的两种限制。所以这里合并的是**时间轴**，不是题：
  //
  //   同一题位里的每个子任务各出一条记录，**共用同一个起点 `start`**。
  //
  // 于是 `C2` 的用时 =「冷启动 → 解出 C2」的整段，而不再是「解出 C1 之后的增量」——
  // 后者把 C1 那一段省掉了，而且样本必然只含「刚做完近乎同一道题」的人，会系统性偏短
  // （`2219:B2` 的增量中位只有 1.4 分钟）。同时 **C1 自己的记录原样保留**：
  // 合并前 `/hard version/i` 那 36 个题位的低档样本一条不丢。
  const slots=[];
  for(let i=0;i<problems.length;i++){
    const key=String(problems[i].index).replace(/\d+$/,'');
    const last=slots[slots.length-1];
    if(last&&last.key===key) last.items.push(i);
    else slots.push({key,items:[i]});
  }
  const output=[];
  for(const row of rows){
    if(row.party.participantType!=='CONTESTANT'||row.party.members.length!==1||row.party.ghost)continue;
    const handle=row.party.members[0].handle.toLowerCase(), rating=ratings.get(handle);
    if(!Number.isFinite(rating))continue;
    const ss=byHandle.get(handle)||[];
    const first=problems.map(p=>Math.min(...ss.filter(s=>s.problem.index===p.index&&s.verdict==='OK').map(s=>s.relativeTimeSeconds)));
    // 同题位的子任务共用 `start`，所以出记录这件事抽成一个闭包，避免两处重复。
    const push=(slot,i,end,event,start)=>{
      const p=problems[i];
      if(!(p.rating>=800&&p.rating<=2500)||Math.abs(rating-p.rating)>window)return;
      const rec={contestId:c.id,startTime:c.startTimeSeconds,problem:p.index,q:p.rating,handle,oldRating:rating,event,time:end-start,start,attempted:ss.some(s=>s.problem.index===p.index),priorRated:null};
      if(slot.items.length>1) rec.slot=slot.items.map(j=>problems[j].index); // 合并过的题位，便于追溯
      output.push(rec);
    };
    let start=0;
    for(let si=0;si<slots.length;si++){
      const slot=slots[si];
      const ends=slot.items.map(i=>first[i]);
      const solvedFlags=ends.map(Number.isFinite);
      const solvedEnds=ends.filter(Number.isFinite);
      const stop=solvedEnds.length?Math.max(...solvedEnds):c.durationSeconds;
      if(stop<=start)break;
      const own=new Set(slot.items.map(i=>problems[i].index));
      const later=new Set();
      for(let j=si+1;j<slots.length;j++) for(const i of slots[j].items) later.add(problems[i].index);
      // Reject any target work before its inferred start and any later-slot work before its endpoint.
      const targetEarly=ss.some(s=>own.has(s.problem.index)&&s.relativeTimeSeconds<start);
      const skipped=ss.some(s=>later.has(s.problem.index)&&s.relativeTimeSeconds<=stop);
      if(targetEarly||skipped)break;
      if(!solvedEnds.length){
        // 本题位一个子任务都没解出：首个未解出的子任务作为删失记录，然后收工。
        push(slot,slot.items[0],c.durationSeconds,0,start);
        break;
      }
      // Eligibility is based on ordered progress, not observing a submission to the target.
      for(let k=0;k<slot.items.length;k++) push(slot,slot.items[k],solvedFlags[k]?ends[k]:c.durationSeconds,solvedFlags[k]?1:0,start);
      if(solvedEnds.length<slot.items.length)break;   // 题位没做全 → 后面走不下去
      start=stop;
    }
  }
  return output;
}
export function km(rows){
  const groups=new Map();let risk=0,survival=1;
  for(const r of rows){const w=r.weight??1;risk+=w;const g=groups.get(r.time)||{exit:0,death:0};g.exit+=w;g.death+=w*r.event;groups.set(r.time,g);}
  const curve=[];let median=null;
  for(const [t,g] of [...groups].sort((a,b)=>a[0]-b[0])){
    survival*=Math.max(0,1-g.death/risk);
    curve.push({time:t,cdf:1-survival,risk});
    if(median===null&&1-survival>=0.5-1e-12)median=t;
    risk-=g.exit;
  }
  return {median,curve};
}
export function quantile(rows,p){
  if(!rows.length)return null;
  const sorted=[...rows].sort((a,b)=>a.time-b.time),total=sorted.reduce((n,r)=>n+(r.weight??1),0);let sum=0;
  for(const r of sorted){sum+=r.weight??1;if(sum>=p*total)return r.time;}
  return sorted.at(-1).time;
}
export function rng(seed=20260916){return ()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
export function bootstrap(rows,reps=500,seed=42){
  return bootstrapPair(rows,reps,seed).km;
}
export function bootstrapPair(rows,reps=500,seed=42){
  const ids=[...new Set(rows.map(r=>r.contestId))],index=new Map(ids.map((id,i)=>[id,i]));
  const unavailable={low:null,high:null,identified:0,reps,reason:'fewer_than_two_contests'};
  if(ids.length<2)return {km:unavailable,success:unavailable,difference:unavailable};
  // Sort once. A cluster's bootstrap multiplicity scales its rows' Gaussian weights.
  const sorted=[...rows].sort((a,b)=>a.time-b.time).map(r=>({t:r.time,e:r.event,w:r.weight??1,c:index.get(r.contestId)}));
  const random=rng(seed),kmValues=[],successValues=[],differences=[];
  for(let b=0;b<reps;b++){
    const count=new Int32Array(ids.length);
    for(let j=0;j<ids.length;j++)count[Math.floor(random()*ids.length)]++;
    let risk=0,totalSuccess=0;
    for(const r of sorted){const w=r.w*count[r.c];risk+=w;totalSuccess+=w*r.e;}
    let survival=1,completed=0,kmMedian=null,successMedian=null;
    for(let i=0;i<sorted.length;){
      const t=sorted[i].t;let deaths=0,exits=0;
      while(i<sorted.length&&sorted[i].t===t){const r=sorted[i++],w=r.w*count[r.c];exits+=w;deaths+=w*r.e;}
      if(exits===0)continue;
      if(risk>0)survival*=Math.max(0,1-deaths/risk);
      completed+=deaths;
      if(kmMedian===null&&1-survival>=.5-1e-12)kmMedian=t;
      if(successMedian===null&&totalSuccess>0&&completed>=.5*totalSuccess-1e-12)successMedian=t;
      risk-=exits;
    }
    kmValues.push(kmMedian??Infinity);successValues.push(successMedian??Infinity);
    differences.push(kmMedian===null||successMedian===null?Infinity:kmMedian-successMedian);
  }
  function interval(values){
    values.sort((a,b)=>a-b);
    const low=values[Math.floor(.025*(reps-1))],high=values[Math.ceil(.975*(reps-1))];
    return {low:Number.isFinite(low)?low:null,high:Number.isFinite(high)?high:null,identified:values.filter(Number.isFinite).length/reps,reps,reason:Number.isFinite(high)?null:'upper_unbounded'};
  }
  return {km:interval(kmValues),success:interval(successValues),difference:interval(differences)};
}
// 加权保序回归（非减）：相邻两块若逆序就合并为一块，块值取加权均值。
// points 必须按 q 升序。返回每个点的保序值以及合并后的块，供拟合脚本与图共用。
//
// `slopeFloor` 是**允许的下降速率**（秒 / Rating），默认 0 = 严格非减（现行口径）。
// 它存在的理由：严格保序会把数据里持续下降的一段压成一条平线（1700–2000 就是这样），
// 平线本身没错，但看上去像缺数据。要恢复区分度只能放松先验，于是把「放松多少」变成
// 一个显式参数。取 s > 0 时约束变成「每 1 Rating 最多下降 s 秒」：
//
//     f_j − f_i ≥ −s·(q_j − q_i)   ⟺   (f_j + s·q_j) ≥ (f_i + s·q_i)
//
// 所以只要先把序列抬成 y + s·q，跑同一套 PAVA，再减回去，就得到有斜率下界的保序解。
// 这是**先验的松弛**，不是数据：块值仍然由加权均值决定，s 只是允许它斜着走。
export function isotonicNonDecreasing(points,slopeFloor=0){
  if(!(slopeFloor>=0)||!Number.isFinite(slopeFloor))throw Error('slopeFloor must be a non-negative finite number');
  const work=slopeFloor?points.map(p=>({q:p.q,y:p.y+slopeFloor*p.q,w:p.w})):points;
  const blocks=[];
  for(const p of work){
    blocks.push({y:p.y,w:p.w,first:p.q,last:p.q});
    while(blocks.length>1){
      const b=blocks[blocks.length-1],a=blocks[blocks.length-2];
      if(a.y<=b.y)break;
      blocks.splice(blocks.length-2,2,{y:(a.y*a.w+b.y*b.w)/(a.w+b.w),w:a.w+b.w,first:a.first,last:b.last});
    }
  }
  const values=new Map();
  for(const b of blocks)for(const p of points)if(p.q>=b.first&&p.q<=b.last)values.set(p.q,b.y-slopeFloor*p.q);
  return {
    values,
    blocks:blocks.map(b=>({
      from:b.first,to:b.last,
      // level 是抬高后的块值（s=0 时就是块值本身）；实际曲线在块内是一条斜率 −s 的线，
      // 用 blockSecondsAt() 取任一点的值，别直接拿 level 当读数。
      level:b.y,slopeFloor,seconds:b.y-slopeFloor*(b.first+b.last)/2,weight:b.w,
    })),
  };
}
// 取块内某一点的实际读数（s=0 时与 level 相同）。
export function blockSecondsAt(block,q){
  return block.level-block.slopeFloor*q;
}
// ---- 单档样本与点估计 -------------------------------------------------------
// 这一节是 analyze.mjs（出报告）与 validate.mjs（按比赛留出验证）的共同底座。
// 必须共用：留出验证要评估的是**要上线的那一个估计量**；验证脚本若自己再写一份
// 筛选/加权逻辑，验的就是另一个东西了。
export const GAUSS_SIGMA=75;
// 组内权重按「选手赛前 Rating 离该档多远」衰减，σ=75。
export const gaussianWeight=(oldRating,q)=>Math.exp(-((oldRating-q)**2)/(2*GAUSS_SIGMA**2));
// 成功者耗时分位点。P50 是推荐的 97% 锚点，其余供分布对比。
export const SUCCESS_QUANTILES=[.1,.2,.3,.5,.7,.8,.9,.95];
// 主口径筛选：题目 Rating 恰好等于该档、选手赛前 Rating 在 ±band 内、已证实的赛前 rated 场次达门槛。
export const bandRows=(samples,q,band,minPrior)=>samples
  .filter(r=>r.q===q&&Math.abs(r.oldRating-q)<=band&&r.priorRated>=minPrior)
  .map(r=>({...r,weight:gaussianWeight(r.oldRating,q)}));
// 一档的全部点估计（需要 bootstrap 的区间在 analyze 里另外补）。
// small_sample 的判据是**独立比赛数** <5，不是样本条数 —— 同一场来一千人也只算一场。
export function binEstimate(rows){
  const solved=rows.filter(r=>r.event);
  const weight=rows.reduce((n,r)=>n+r.weight,0),sw=solved.reduce((n,r)=>n+r.weight,0);
  const contests=new Set(rows.map(r=>r.contestId)).size;
  const survival=km(rows);
  const out={
    contests,
    problems:new Set(rows.map(r=>r.contestId+'/'+r.problem)).size,
    players:new Set(rows.map(r=>r.handle)).size,
    samples:rows.length,
    solved:solved.length,
    censored:rows.length-solved.length,
    attempted:rows.filter(r=>r.attempted).length,
    solveRate:rows.length?solved.length/rows.length:null,
    weightedSolveRate:weight?sw/weight:null,
    effectiveSamples:weight?weight**2/rows.reduce((n,r)=>n+r.weight**2,0):0,
    t97KmSeconds:survival.median,
    status:!rows.length?'no_data':survival.median===null?'not_identifiable':rows.length<30||contests<5?'small_sample':'exploratory',
  };
  for(const p of SUCCESS_QUANTILES){
    out['successP'+Math.round(p*100)+'Seconds']=quantile(solved,p);
    out['successUnweightedP'+Math.round(p*100)+'Seconds']=quantile(solved.map(r=>({...r,weight:1})),p);
  }
  out.kmMinusSuccessMedianSeconds=survival.median===null||out.successP50Seconds===null?null:survival.median-out.successP50Seconds;
  out.exactHistorySamples=rows.filter(r=>r.priorRatedKind!=='certified_lower_bound').length;
  out.certifiedHistorySamples=rows.filter(r=>r.priorRatedKind==='certified_lower_bound').length;
  out.p90MinusKmSeconds=survival.median===null||out.successP90Seconds===null?null:out.successP90Seconds-survival.median;
  return {summary:out,survival};
}
// ---- 把档位点估计平滑成曲线 -------------------------------------------------
// smooth-fit（未约束）、monotone-fit（+保序回归）、validate（留出预测）共用同一份实现。
// 数据点是「档位」而不是「选手×题目」，所以这里的权重取有效样本量。
export const fitWeight=r=>{
  const v=Number.isFinite(r.effectiveSamples)?r.effectiveSamples:r.samples;
  return Number.isFinite(v)?Math.max(1,v):1;
};
export const DEFAULT_BANDWIDTHS=[75,100,125,150,200,250,300,400,500,600];
// 加权局部线性 Gaussian 核：对每个目标 q 做一次局部加权最小二乘（带一次项）。
// 比 Nadaraya-Watson（局部常数）在峰值与边界处偏倚更小 —— 这正是 plot.py 里那份手写
// 平滑被删掉的原因：两个估计量不是一回事，同一张图上不能混用。
export function localLinear(data,q,bandwidth,weight=fitWeight){
  let sw=0,sx=0,sxx=0,sy=0,sxy=0;
  for(const r of data){
    const z=(r.q-q)/bandwidth,k=Math.exp(-.5*z*z),w=k*weight(r);
    sw+=w;sx+=w*(r.q-q);sxx+=w*(r.q-q)**2;sy+=w*r.y;sxy+=w*(r.q-q)*r.y;
  }
  if(!(sw>0))return {y:null,sw:0};
  const det=sw*sxx-sx*sx;
  return {y:Math.abs(det)<1e-9?sy/sw:(sy*sxx-sxy*sx)/det,sw};
}
// 留一档位的加权均方误差。候选带宽按它选最小者。
// 某档缺 y 时（局部邻域为空）该档跳过；样本会被静默丢掉的做法在这个位置踩过。
export function bandwidthCvMse(data,bandwidth,weight=fitWeight){
  let mse=0,sw=0;
  for(let i=0;i<data.length;i++){
    const train=data.filter((_,j)=>j!==i);
    const y=localLinear(train,data[i].q,bandwidth,weight).y;
    if(y===null)continue;
    const e=y-data[i].y;
    mse+=weight(data[i])*e*e;sw+=weight(data[i]);
  }
  return sw?mse/sw:Number.POSITIVE_INFINITY;
}
export function selectBandwidth(data,bandwidths=DEFAULT_BANDWIDTHS,weight=fitWeight){
  const metrics=bandwidths.map(bandwidth=>{
    const loocvMseSeconds2=bandwidthCvMse(data,bandwidth,weight);
    return {bandwidth,loocvMseSeconds2,loocvRmseSeconds:Math.sqrt(loocvMseSeconds2)};
  });
  const best=[...metrics].sort((a,b)=>a.loocvMseSeconds2-b.loocvMseSeconds2)[0];
  return {...best,metrics};
}
// 在网格上出曲线。monotone=true 时叠加加权保序回归（PAVA）。
// 无论哪种模式都留下保序前的 rawY：单调化是形状先验而不是实测值，
// 必须能随时看出它把哪个位置挪了多少。
export function fitCurve(data,{bandwidth,grid=fitGrid(),monotone=false,weight=fitWeight,slopeFloor=0}={}){
  const raw=grid.map(q=>{const s=localLinear(data,q,bandwidth,weight);return {q,y:s.y,w:s.sw};}).filter(p=>p.y!==null);
  if(!monotone)return {points:raw.map(p=>({q:p.q,y:p.y,rawY:p.y,w:p.w})),blocks:null};
  const {values,blocks}=isotonicNonDecreasing(raw,slopeFloor);
  return {points:raw.map(p=>({q:p.q,y:values.get(p.q),rawY:p.y,w:p.w})),blocks};
}
// 主口径：赛前 Rating 窗口 ±100、已证实的赛前 rated 场次 ≥10。
// 挑选比赛（backfill）与统计汇总（analyze）必须用同一组数字，所以只在这里定义一次。
export const MAIN_BAND=100,MAIN_MIN_PRIOR=10;
// 拟合与出表的 Rating 范围。上限 2400（2026-09-21 从 2100 抬上来）。
// 旧注释说「2200 只有 10 场，撑不起一个档位」—— 那句只对了一半：真因不是年份窄，
// 而是「含该题」且「该档 ≥25 位参赛者」两个条件同时满足的比赛本来就少（2022–2026 全部比赛里
// 2200 恰好 19 场）。backfill 按档位贪心补赛之后，2200/2300/2400 三档各自凑够 15 场
// （共新抓 18 场 Div.1 / Div.1+2 / Global Round），样本 4166 / 3108 / 2101 条，于是右端推进到 2400。
// 更上面 2500/2600 仍不收：2500 档只有 31 场候选、2600 档每场中位 21 位参赛者已跌破 min-in-window=25。
// 范围只在这里定义一次：平滑、单调化、出表、画图必须用同一个区间，否则最右端的边界效应会不一致。
export const FIT_MIN_Q=800,FIT_MAX_Q=2400;
// 拟合网格：从 FIT_MIN_Q 到 FIT_MAX_Q、默认步长 25，smooth-fit / monotone-fit 共用。
// 为什么要有这条断言：table.mjs、compare.mjs 是按 100 步长在同一区间**精确查表**的
// （`Number(x.q)===q`），端点一旦不是 100 的倍数，最后一档就会被静默漏掉 ——
// 表里少一行，不报错。tests/cf-study.test.ts 用同一个函数守着这条不变式。
export const fitGrid=(step=25)=>{
  if(FIT_MIN_Q%100||FIT_MAX_Q%100)throw Error('FIT_MIN_Q and FIT_MAX_Q must be multiples of 100 so the 100-step tables land on them');
  if(FIT_MAX_Q<FIT_MIN_Q)throw Error('FIT_MAX_Q must not be below FIT_MIN_Q');
  if(!Number.isInteger(step)||step<1)throw Error('fit grid step must be a positive integer');
  const grid=[];for(let q=FIT_MIN_Q;q<=FIT_MAX_Q;q+=step)grid.push(q);
  return grid;
};
// 「这场不可能有 CF Rating 变更」的名字特征：娱乐场次（April Fools / Kotlin / Testing）、
// 以及 ICPC 区域赛与外站 mirror —— 后者 CF 直接返回 400 Rating changes are unavailable。
// ledger 与 backfill 必须共用这一份：分头维护会让两边互相漏（补比赛曾反复挑中
// 账本早已排除的 mirror 场次，白花请求）。
export const UNRATED_CONTEST_NAME=/April Fools|Kotlin|Unrated|Testing|Experimental|Q#|Marathon|ICPC Asia|Regional Contest|online mirror|Online Mirror|Open Cup|Universal Cup/i;
export const rankThresholds=[[100.5,'SSS+'],[100,'SSS'],[99.5,'SS+'],[99,'SS'],[98,'S+'],[97,'S'],[94,'AAA'],[90,'AA'],[80,'A'],[75,'BBB'],[70,'BB'],[60,'B'],[50,'C'],[0,'D']];
export function rank(a){if(!Number.isFinite(a)||a<0||a>101)throw Error('Achievement must be 0..101');return rankThresholds.find(([t])=>a>=t)[1];}
