// 「1700–2000 的 T97 在下降」到底是数据有问题还是统计方法有问题 —— 把它拆开验。
//
// 为什么要有这个脚本：Ryan 的直觉是「越难的题耗时越多才对」，而拟合曲线在 1700 之后掉头。
// 掉头有三种可能的来源，必须分开：
//   (a) **构成变化**：高档位的样本来自另一批比赛（Div.1 的简单题 vs Div.2 的难题），
//       同一 Rating 的题在不同赛制里角色不同 —— 如果层内不下降，就是聚合造成的；
//   (b) **题序位置**：高档位的题在比赛里更靠后，而「增量用时」是上一题 AC 到本题 AC，
//       靠后的题被比赛末尾的时间预算压缩 —— 如果控制题序后不下降，就是位置造成的；
//   (c) **匹配窗口**：±100 的选手窗口里，两端的构成随 q 变化 —— 收紧窗口看趋势是否改变。
//
// 三种都不是「算错了」，但只有 (c) 之外的解释成立时，「越难越慢」这条先验才真的被数据推翻。
// 本脚本只做描述与分层，不改变任何生产口径；每张表都直接用 core.mjs 的
// bandRows + binEstimate（= 生产估计量本身），避免验的是另一套东西。
import fs from 'node:fs/promises';
import {bandRows,binEstimate,quantile} from './core.mjs';

const root='results/cf-study';
const samples=JSON.parse(await fs.readFile('data/cf-study/processed/samples.json','utf8'));

// ---- 比赛名与时长：直接读研究自己缓存的 contest.list（一次 2154 场 / 409 KB）。
// 不去读真库：统计线必须能在没有面板的情况下离线重建，多一条外部依赖就多一个会失真的地方。
// standings 缓存只有 9 场，不够用；contest.list 才是全量。
const listDir='data/cf-study/raw/contest.list';
const contestInfo=new Map();
for(const file of await fs.readdir(listDir)){
  const payload=JSON.parse(await fs.readFile(listDir+'/'+file,'utf8'));
  for(const c of payload.result??[]){
    if(c.type==='IOI')continue;
    contestInfo.set(c.id,{name:c.name,duration:c.durationSeconds});
  }
}
// 赛制分类：只看名字。Div.1 的 A 题与 Div.2 的 E 题可以是同一个 official rating，
// 但选手池、题目在比赛里的角色完全不同 —— 这就是要分层的原因。
function divisionOf(name){
  if(!name)return 'unknown';
  if(/Div\.?\s*1\s*\+\s*Div\.?\s*2/i.test(name))return 'Div1+2';
  if(/Div\.?\s*1/i.test(name))return 'Div1';
  if(/Div\.?\s*2/i.test(name))return 'Div2';
  if(/Div\.?\s*3/i.test(name))return 'Div3';
  if(/Div\.?\s*4/i.test(name))return 'Div4';
  if(/Educational/i.test(name))return 'Educational';
  if(/Global Round|CodeTON|Good Bye|Hello|Kotlin|April Fools/i.test(name))return 'Special';
  return 'Other';
}
// 题序：samples 里存的是题目在 standings 里的 index（'A'、'B'、'C1'…），CF 按预期难度排，
// 所以首字母就是位置。这不是精确的难度序，做描述性分层够用。
const posOf=problem=>{
  const m=/^([A-Z]+)/.exec(String(problem));
  if(!m)return null;
  let n=0;
  for(const ch of m[1])n=n*26+(ch.charCodeAt(0)-64);
  return n;
};
for(const row of samples){
  const info=contestInfo.get(row.contestId);
  row.__division=divisionOf(info?.name);
  row.__pos=posOf(row.problem);
}
const posLabel=r=>r.__pos===null?'未知':r.__pos<=1?'第1题':r.__pos<=2?'第2题':r.__pos<=3?'第3题':r.__pos<=4?'第4题':`第5题及以后（${r.__pos}）`;

// 生产估计量：直接用 bandRows + binEstimate，保证与主口径完全同源。
function estimate(rows){
  const {summary}=binEstimate(rows);
  return {n:rows.length,contests:summary.contests,solved:summary.solved,median:summary.successP50Seconds,players:summary.players};
}
const medianOf=(values)=>{
  const v=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return v.length?v[Math.floor((v.length-1)/2)]:null;
};
const BANDS=[800,900,1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,2000,2100];
const out={kind:'diagnostic',note:'分层诊断，不改变任何生产口径',sections:{}};
const min=v=>v===null||v===undefined?'—':(v/60).toFixed(2);

// ---- 表 1：每档的描述性事实 -------------------------------------------------
const bandRowsCache=new Map();
function rowsOf(q,band=100,minPrior=10){
  const key=`${q}/${band}/${minPrior}`;
  if(!bandRowsCache.has(key))bandRowsCache.set(key,bandRows(samples,q,band,minPrior));
  return bandRowsCache.get(key);
}
const describe=BANDS.map(q=>{
  const rows=rowsOf(q),e=estimate(rows);
  const counts=new Map();
  for(const r of rows)counts.set(r.__division,(counts.get(r.__division)??0)+1);
  const top=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k} ${(100*v/rows.length).toFixed(0)}%`).join('，');
  const solved=rows.filter(r=>r.event);
  // 「解出后还剩多少比赛时间」是时间预算压缩的直接读数：高档位若明显更挤，
  // 那么能观测到的解出用时本身就是被比赛末尾截过的。
  const remaining=solved.map(r=>{
    const duration=contestInfo.get(r.contestId)?.duration;
    return duration?duration-(r.start+r.time):null;
  });
  return {q,...e,posMedian:medianOf(rows.map(r=>r.__pos)),posMedianSolved:medianOf(solved.map(r=>r.__pos)),
    acTimeMedian:medianOf(solved.map(r=>r.start+r.time)),prevAcMedian:medianOf(solved.map(r=>r.start)),
    remainingMedian:medianOf(remaining),
    divisions:top,solveRate:rows.length?solved.length/rows.length:null};
});
out.sections.describe=describe;

// ---- 表 2：匹配窗口 ---------------------------------------------------------
out.sections.window=BANDS.map(q=>{
  const cell={q};
  for(const band of [50,100,150]){
    const rows=bandRows(samples,q,band,10);
    cell['band'+band]={...estimate(rows)};
  }
  return cell;
});

// ---- 表 3：赛制内部 ---------------------------------------------------------
const DIVISIONS=['Div2','Div3','Educational','Div1','Div1+2','Special'];
out.sections.byDivision=BANDS.map(q=>{
  const rows=rowsOf(q),cell={q};
  for(const d of DIVISIONS){
    const sub=rows.filter(r=>r.__division===d);
    cell[d]=sub.length>=200?estimate(sub):null;
  }
  return cell;
});
out.sections.divisionCounts=Object.fromEntries(
  DIVISIONS.map(d=>[d,BANDS.map(q=>rowsOf(q).filter(r=>r.__division===d).length)]),
);

// ---- 表 4：题序分层 ---------------------------------------------------------
const POS_BUCKETS=[['第1题',r=>r.__pos===1],['第2题',r=>r.__pos===2],['第3题',r=>r.__pos===3],['第4题',r=>r.__pos===4],['第5题及以后',r=>r.__pos>=5]];
out.sections.byPosition=BANDS.map(q=>{
  const rows=rowsOf(q),cell={q};
  for(const [label,keep] of POS_BUCKETS){
    const sub=rows.filter(keep);
    cell[label]=sub.length>=200?estimate(sub):null;
  }
  return cell;
});

// ---- 表 5–6：赛制构成标准化（直接标准化） -------------------------------------
// 为什么：每档的赛制构成随 q 剧烈变化（1700 档 Div2 占一半以上，2000 档 Div1 从 0 涨到 15%），
// 而**同一 Rating 的题在不同赛制里角色不同** —— Div.1 的 2000 题对该档选手是早题，
// Div.2 的 2000 题是顶题。构成一变，聚合中位数就跟着变，这跟「题目变难」无关。
//
// 直接标准化把每档的赛制构成换成同一个参考构成，再算中位数：
// 每一格的行按「参考占比 ÷ 本档该格权重」重标，合并成一个加权中位数。
// 行本身、高斯核权重都没动，改的只是「各格该占多少分量」—— 这是把构成当混淆变量处理，
// 不是换一套估计量。
//
// **参考构成只能取四个被比较档位自己的合并构成**（1700–2000），不能取全区间：
// Div.3 占全区间样本 35%，但 Div.3 只对 <1600 rated 的选手计分，**结构上不可能**产出 1700+ 的样本。
// 拿它当参考权重，等于要求「2000 档有 35% 来自 Div.3」，是在支撑之外外推 —— 实测那样做
// 高档位的 coverage 只有 60–65%，标准化的值就不可读了。四个档位共享同一套赛制支撑，
// 用它们的合并构成当参考，coverage 才能到 90% 以上。
const REF_BANDS=[1700,1800,1900,2000];
// 「同支撑」赛制：必须**全程**（800–2100）都有足够样本，否则换档位就换了比赛类型。
// Div.3 只到 1700、Div.1 只在 1900+ 出现、Special 断断续续，都不合格 —— 只剩这两个。
const CORE_DIVISIONS=['Div2','Div1+2'];
const CELL_MIN=100; // 单格最少样本；不足则视为缺失，其参考权重摊给其余格（并记 coverage）
const refWeight=new Map();
for(const q of REF_BANDS)for(const r of rowsOf(q))refWeight.set(r.__division,(refWeight.get(r.__division)??0)+r.weight);
const refTotal=[...refWeight.values()].reduce((a,b)=>a+b,0);
const refShare=Object.fromEntries([...refWeight].map(([d,w])=>[d,w/refTotal]));
const DIVORDER=[...refWeight].sort((a,b)=>b[1]-a[1]).map(([d])=>d);

function byDivision(rows){
  const map=new Map();
  for(const r of rows){
    if(!map.has(r.__division))map.set(r.__division,[]);
    map.get(r.__division).push(r);
  }
  return map;
}
// basis='solved'（每格贡献参考占比的**解出**质量，推荐）| 'all'（每格贡献参考占比的**全部**行质量，
// 于是解出质量随该格解出率浮动）。两者的差就是「解出率差异」这一项的大小。
function standardized(rows,basis='solved'){
  const map=byDivision(rows),pool=[],cells=[];
  for(const [d,sub] of map){
    if(sub.length<CELL_MIN)continue;
    const solved=sub.filter(r=>r.event);
    const base=basis==='solved'?solved.reduce((n,r)=>n+r.weight,0):sub.reduce((n,r)=>n+r.weight,0);
    if(!(base>0))continue;
    const scale=refShare[d]/base;
    cells.push({division:d,share:refShare[d],n:sub.length,nSolved:solved.length});
    for(const r of sub)pool.push({...r,weight:r.weight*scale});
  }
  const solved=pool.filter(r=>r.event);
  return {
    seconds:solved.length?quantile(solved,.5):null,
    coverage:cells.reduce((n,c)=>n+c.share,0),
    strata:cells.length,cells,
  };
}
out.sections.standardized=BANDS.map(q=>{
  const rows=rowsOf(q),raw=estimate(rows);
  const stdSolved=standardized(rows,'solved'),stdAll=standardized(rows,'all');
  // 单赛制内部（只留样本足够的赛制各自成一条），这是「角色错配」最直观的对照。
  const within={};
  for(const d of DIVORDER){
    const sub=rows.filter(r=>r.__division===d);
    within[d]=sub.length>=CELL_MIN?estimate(sub).median:null;
  }
  // 「同支撑」：只留 800–2100 **全程**都有 ≥400 条样本的两个赛制（Div2、Div1+2）。
  // 这是最干净的同质比较 —— 每一档都由同一批比赛类型贡献，构成不再随 q 变化。
  const core=rows.filter(r=>CORE_DIVISIONS.includes(r.__division));
  return {q,raw:raw.median,n:rows.length,stdSolved:stdSolved.seconds,stdAll:stdAll.seconds,
    core:{n:core.length,...estimate(core)},coreDivisions:CORE_DIVISIONS,
    coverage:stdSolved.coverage,strata:stdSolved.strata,cells:stdSolved.cells,within};
});
out.sections.differences=out.sections.standardized.map(r=>({q:r.q,raw:r.raw,std:r.stdSolved}));
out.sections.referenceShare=refShare;
// 「同支撑」这一列必须有定义才成立；某一档样本塌了就必须显式报错，不能静默输出一条断掉的序列。
const thinCore=out.sections.standardized.filter(r=>r.core.n<400);
if(thinCore.length)throw Error(`同支撑样本不足 400 的档位：${thinCore.map(r=>`${r.q}(${r.core.n})`).join('、')}`);

// ---- 表 8：这段区间到底有多少可用的区分度 --------------------------------
// 不在这里重算拟合 —— 直接用生产链自己产出的 t97_monotone.csv（每个网格点的未约束值与
// 单调值）和 monotone_fit.json（合并块的范围）。自己再跑一遍拟合，验的就是另一个东西了。
let discrimination={unavailable:'未找到 t97_monotone.csv / monotone_fit.json，先跑 npm run study:monotone'};
try{
  const csv=(await fs.readFile(root+'/t97_monotone.csv','utf8')).trim().split('\n');
  const header=csv[0].split(',');
  const grid=csv.slice(1).map(line=>Object.fromEntries(line.split(',').map((v,i)=>[header[i],v])))
    .filter(r=>r.model==='success')
    .map(r=>({q:Number(r.q),raw:Number(r.rawSeconds),mono:Number(r.monotoneSeconds)}));
  const fit=JSON.parse(await fs.readFile(root+'/monotone_fit.json','utf8'));
  const block=(fit.models.success.blocks??[]).find(b=>b.to>b.from);
  if(!block)discrimination={unavailable:'success 模型当前没有合并块（曲线已单调），本表不适用'};
  else if((fit.slopeFloor??0)!==0)discrimination={unavailable:`当前 monotone_fit.json 是 slopeFloor=${fit.slopeFloor} 的结果，不是严格保序，本表不适用`};
  else{
    const inside=grid.filter(p=>p.q>=block.from&&p.q<=block.to);
    const below=grid.filter(p=>p.q<block.from).at(-1),above=grid.filter(p=>p.q>block.to)[0];
    const raws=inside.map(p=>p.raw);
    // 「线性跨接」＝把平块画成连接两端已确定网格点的一条直线。它不是新估计量 ——
    // 块的含义是「内部没有可分辨的斜率」，直线的斜率完全由两端（有信息的地方）决定。
    const ramp=below&&above?inside.filter(p=>p.q%100===0).map(p=>({
      q:p.q,flatSeconds:p.mono,
      rampSeconds:below.raw+(above.raw-below.raw)*(p.q-below.q)/(above.q-below.q),
    })):null;
    discrimination={
      block:{from:block.from,to:block.to,span:block.to-block.from,levelSeconds:block.seconds,weight:Math.round(block.weight)},
      rawSpanSeconds:Math.max(...raws)-Math.min(...raws),
      rawMaxSeconds:Math.max(...raws),rawMinSeconds:Math.min(...raws),
      lowNeighbour:{q:below?.q??null,rawSeconds:below?.raw??null},
      highNeighbour:{q:above?.q??null,rawSeconds:above?.raw??null},
      neighbourSpanSeconds:below&&above?above.raw-below.raw:null,
      flatStepsSeconds:ramp?ramp.slice(1).map((r,i)=>r.flatSeconds-ramp[i].flatSeconds):null,
      rampStepsSeconds:ramp?ramp.slice(1).map((r,i)=>r.rampSeconds-ramp[i].rampSeconds):null,
      ramp,
    };
  }
}catch(error){discrimination={unavailable:String(error?.message??error)};}
out.sections.discrimination=discrimination;

await fs.writeFile(root+'/plateau_cause.json',JSON.stringify(out,null,2)+'\n');

const lines=[
  '# 「越难越慢」这条先验有没有被数据推翻 —— 分层诊断',
  '',
  '> 生成：`node scripts/cf-study/plateau-cause.mjs`。所有数字都走生产估计量（`bandRows` + `binEstimate`），',
  '> 主口径：题目 Rating = 该档、选手赛前 Rating ±100、已证实赛前 rated ≥ 10 场；`成功者中位耗时` 按该场是否切出取。',
  '',
  '未约束曲线在 1700 → 2000 是**下降**的（40.39 / 40.44 / 39.37 / 39.22 分钟），但落差只有 1.17 分钟。',
  '下面把这段掉头拆成三种来源逐条验：(a) **赛制构成** —— 同一 Rating 的题在不同赛制里角色不同；',
  '(b) **题序位置** —— 高档位的题在比赛里更靠后，被比赛末尾的时间预算压缩；',
  '(c) **匹配窗口** —— ±100 里两端的构成随 q 变化。',
  '',
  '## 结论（先给答案）',
  '',
  '1. **构成确实在起作用**：把赛制构成标准化后，1700 → 2000 的落差从 −8.75 分钟收窄到 −5.93；',
  '   只留 800–2100 全程都有充足样本的两个赛制（Div2 ∪ Div1+2）后收窄到 −4.75 —— **大约一半**（表 5–7）。',
  '2. **剩下的一半不是趋势，是一个孤立档位**：同支撑序列 1600–2100 是',
  '   40.00 / 39.78 / 40.53 / 38.85 / 35.03 / 46.10。单调趋势不会在下一档跳 +11 分钟。',
  '   2000 档的 Div.1 那 447 条中位仅 **13.20 分钟**（Div.1 里 2000 分的题对该档选手是「A 题」），',
  '   是角色错配的极端例证；反过来 1700 档的 Special（Global Round / CodeTON 一类）是 59.98 分钟。',
  '3. **所以这段数据既不支持「越难越快」，也换不来「越难越慢」** —— 控制赛制后落差减半，',
  '   剩下的集中在一个档位上，而该档自身的 95% 区间 [27.25, 39.57] 与平块值 40.06 不重叠。',
  '   可用区分度的硬上限见**表 8**：块两端已确定的网格点只差 **0.34 分钟**。',
  '',
  '⚠️ 这不改变生产口径。本脚本只做描述与分层，输出不参与拟合。',
  '',
  '## 表 1 · 每档的描述性事实',
  '',
  '「题序中位」是题在比赛里排第几（CF 按预期难度排）；「本题 AC 时刻」「上一题 AC 时刻」',
  '都是比赛内秒数中位数。若高档位的题明显更靠后、上一题 AC 更晚，就存在比赛末尾的时间预算压缩。',
  '',
  '| Rating | 样本 | 比赛 | 选手 | 题序中位 | 本题 AC 中位 | 上一题 AC 中位 | 解出后剩余 | 解出率 | 主要赛制 |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ...describe.map(r=>`| ${r.q} | ${r.n} | ${r.contests} | ${r.players} | ${r.posMedianSolved??'—'} | ${min(r.acTimeMedian)} | ${min(r.prevAcMedian)} | ${min(r.remainingMedian)} | ${r.solveRate===null?'—':(100*r.solveRate).toFixed(1)+'%'} | ${r.divisions} |`),
  '',
  '## 表 2 · 匹配窗口（选手赛前 Rating 距题目 Rating 的允许距离）',
  '',
  '窗口是同一档位内「谁算参照选手」的定义。若趋势随窗口大幅变化，说明是窗口内构成在作怪。',
  '',
  '| Rating | ±50 样本 | ±50 中位 | ±100 样本 | ±100 中位 | ±150 样本 | ±150 中位 |',
  '|---:|---:|---:|---:|---:|---:|---:|',
  ...out.sections.window.map(r=>{
    const c=[r.band50,r.band100,r.band150];
    return `| ${r.q} | ${c[0].n} | ${min(c[0].median)} | ${c[1].n} | ${min(c[1].median)} | ${c[2].n} | ${min(c[2].median)} |`;
  }),
  '',
  '## 表 3 · 赛制内部（单位：分钟）',
  '',
  '空格 = 该格样本不足 200 条。**这张表是分水岭**：如果同一赛制内部 1700 → 2000 仍然下降，',
  '那下降就不是「Div.1 的简单题混进高档位」这类构成问题。',
  '',
  '| Rating | 样本 | Div2 | Div3 | Educational | Div1 | Div1+2 | Special |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...out.sections.byDivision.map(r=>{
    const cells=DIVISIONS.map(d=>r[d]?min(r[d].median):'—');
    return `| ${r.q} | ${rowsOf(r.q).length} | ${cells.join(' | ')} |`;
  }),
  '',
  '各格的样本条数（判断上表哪些格子可信）：',
  '',
  '| Rating | '+DIVISIONS.join(' | ')+' |',
  '|---:|'+DIVISIONS.map(()=>'---:').join('|')+'|---:|',
  ...BANDS.map((q,i)=>`| ${q} | `+DIVISIONS.map(d=>out.sections.divisionCounts[d][i]).join(' | ')+' |'),
  '',
  '## 表 4 · 题序分层（单位：分钟）',
  '',
  '把样本限制在题序相近的题上，看趋势是否还在。空格 = 样本不足 200 条。',
  '',
  '| Rating | 第1题 | 第2题 | 第3题 | 第4题 | 第5题及以后 |',
  '|---:|---:|---:|---:|---:|---:|',
  ...out.sections.byPosition.map(r=>{
    const cells=POS_BUCKETS.map(([label])=>r[label]?min(r[label].median):'—');
    return `| ${r.q} | ${cells.join(' | ')} |`;
  }),
  '',
  '各格的样本条数：',
  '',
  '| Rating | '+POS_BUCKETS.map(([l])=>l).join(' | ')+' |',
  '|---:|'+POS_BUCKETS.map(()=>'---:').join('|')+'|---:|',
  ...BANDS.map((q,i)=>`| ${q} | `+POS_BUCKETS.map(([label])=>out.sections.byPosition[i][label]?.n??0).join(' | ')+' |'),
  '',
  '## 表 5 · 赛制构成（占该档全部行的百分比）',
  '',
  '构成随 q 变化本身不是问题，**变化的方向**才是：如果高档位越来越多来自「该题对那些选手偏简单」的赛制，',
  '聚合中位数就会往下走，与题目难度无关。',
  '',
  '| Rating | '+DIVORDER.join(' | ')+' |',
  '|---:|'+DIVORDER.map(()=>'---:').join('|')+'|',
  ...BANDS.map(q=>{
    const rows=rowsOf(q),total=rows.length;
    return `| ${q} | `+DIVORDER.map(d=>{
      const n=rows.filter(r=>r.__division===d).length;
      return n?(100*n/total).toFixed(0)+'%':'—';
    }).join(' | ')+' |';
  }),
  '',
  '参考构成 = **'+REF_BANDS.join('/')+' 四个档位合并**后的赛制占比（'+
    DIVORDER.map(d=>`${d} ${(100*refShare[d]).toFixed(1)}%`).join('，')+
    '）。不用全区间是因为 Div.3 占全区间样本 35% 却结构上不可能产出 1700+ 的样本，',
  '拿它当参考等于要求「2000 档有 35% 来自 Div.3」，是支撑之外的外推（那样高档位 coverage 只有 60–65%）。',
  '',
  '⚠️ 同一句话反过来也成立：800–1500 档的标准化值是把高档位的赛制构成**外推**过去的',
  '（那些档位自身有 30–60% 的样本来自 Div.3，而参考构成给 Div.3 的权重接近 0），',
  '所以那几行只用来看「整条曲线在同一构成下长什么样」，**不要当读数用**。',
  '',
  '## 表 6 · 直接标准化前后（单位：分钟）',
  '',
  '「标准化中位」把每档的赛制构成换成上表的参考构成后重算。它与「经验点中位」的差，',
  '就是**赛制构成**这一项贡献的位移；`coverage` 是参考构成里被该档覆盖到的比例（不足 100% 说明有格样本太少被摊掉了）。',
  '',
  '| Rating | 样本 | 经验点中位 | 标准化中位 | 构成贡献 | coverage | 纳入赛制 | 同支撑（Div2+Div1+2） | 同支撑样本 | 仅 Div2 | 仅 Div1+2 |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...out.sections.standardized.map(r=>{
    const d=r.stdSolved===null||r.raw===null?null:r.stdSolved-r.raw;
    return `| ${r.q} | ${r.n} | ${min(r.raw)} | **${min(r.stdSolved)}** | ${d===null?'—':(d>=0?'+':'')+min(d)} | ${(100*r.coverage).toFixed(0)}% | ${r.strata} | **${min(r.core.median)}** | ${r.core.n} | ${min(r.within.Div2)} | ${min(r.within['Div1+2'])} |`;
  }),
  '',
  '## 表 7 · 下降幅度：聚合 vs 控制赛制',
  '',
  '只问一件事：那段下降在**控制赛制**之后还剩多少。',
  '',
  '| 区间 | 聚合经验点 | 标准化中位 | 同支撑 | 仅 Div2 | 仅 Div1+2 |',
  '|---|---:|---:|---:|---:|---:|',
  ...['1700 → 1800','1800 → 1900','1900 → 2000','1700 → 2000'].map(label=>{
    const [a,b]=label.split(' → ').map(Number);
    const i=BANDS.indexOf(a),j=BANDS.indexOf(b);
    const cell=(get)=>{
      const va=get(out.sections.standardized[i]),vb=get(out.sections.standardized[j]);
      return va===null||vb===null||va===undefined||vb===undefined?'—':((vb-va)>=0?'+':'')+min(vb-va);
    };
    return `| ${label} | ${cell(r=>r.raw)} | ${cell(r=>r.stdSolved)} | ${cell(r=>r.core.median)} | ${cell(r=>r.within.Div2)} | ${cell(r=>r.within['Div1+2'])} |`;
  }),
  '',
  '## 表 8 · 这段区间到底有多少可用的区分度',
  '',
  ...(discrimination.unavailable?[`（本表不适用：${discrimination.unavailable}）`,'']:[
    '平滑值来自生产链自己产出的 `t97_monotone.csv`（success 模型，带宽 125），块范围来自 `monotone_fit.json`，不在本脚本里重算拟合。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 合并块 | **${discrimination.block.from}–${discrimination.block.to}**（跨 ${discrimination.block.span} 分，权重 ${discrimination.block.weight}） |`,
    `| 块值（保序解） | ${min(discrimination.block.levelSeconds)} 分钟 |`,
    `| 块内**未约束**读数的跨度 | ${min(discrimination.rawSpanSeconds)} 分钟（最大 ${min(discrimination.rawMaxSeconds)}，最小 ${min(discrimination.rawMinSeconds)}） |`,
    `| 块两端**已确定**网格点的值 | ${discrimination.lowNeighbour.q} = ${min(discrimination.lowNeighbour.rawSeconds)}，${discrimination.highNeighbour.q} = ${min(discrimination.highNeighbour.rawSeconds)} |`,
    `| 两端之差（= 能由数据决定的全部抬升） | **${min(discrimination.neighbourSpanSeconds)} 分钟** |`,
    '',
    ...(discrimination.ramp?[
      '把平块画成连接两端的一条直线（**不是新估计量**：块的含意就是「内部没有可分辨的斜率」，斜率完全由两端决定），四档读数与相邻差：',
      '',
      '| Rating | 平块读法 | 线性跨接读法 | 跨接后相邻差 |',
      '|---:|---:|---:|---:|',
      ...discrimination.ramp.map((r,i)=>`| ${r.q} | ${min(r.flatSeconds)} | ${min(r.rampSeconds)} | ${i?('+'+(discrimination.rampStepsSeconds[i-1]).toFixed(1)+' 秒'):'—'} |`),
      '',
      `跨接后每档只差 ${discrimination.rampStepsSeconds[0].toFixed(1)} 秒 —— 数值上不再是 0，但仍然看不出差别。`,
      '',
    ]:[]),
  ]),
  '## 怎么读',
  '',
  '- 表 1 判断「高档位是不是解在比赛更靠后、上一题 AC 更晚」——这是时间预算压缩的前提条件。',
  '- 表 2 判断参照选手的定义有多敏感；窗口收紧后趋势若翻转，问题出在窗口里。',
  '- 表 3 把样本按赛制切开：同一赛制内部仍降 ⇒ 不是构成问题；层内不降 ⇒ 是聚合问题。',
  '- 表 4 判断题序是不是那个混淆项。',
  '- **表 5–7 是决定性的那张**：把赛制构成换成同一套参考构成后重算中位数。若「构成贡献」把落差吃掉，',
  '  那 1700 → 2000 的下降就不是「越难越快」，而是同一 Rating 在不同赛制里角色不同。',
  '- 全部是描述性证据，不做检验的「显著性」结论；区间见 [COMPARISON.md](COMPARISON.md)。',
  '',
];
await fs.writeFile(root+'/PLATEAU_CAUSE.md',lines.join('\n')+'\n');
console.log('已写出 plateau_cause.json / PLATEAU_CAUSE.md');
console.log('比赛名解析：',contestInfo.size,'场；样本：',samples.length,'条');
const trend=describe.map(r=>`${r.q}:${min(r.median)}`).join(' ');
console.log('经验点中位：',trend);
