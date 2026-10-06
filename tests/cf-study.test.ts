import test from 'node:test';
import assert from 'node:assert/strict';
import {km,quantile,bootstrap,bootstrapPair,candidates,rank,attachHistory,rng,isotonicNonDecreasing,blockSecondsAt,FIT_MIN_Q,FIT_MAX_Q,fitGrid,localLinear,selectBandwidth,fitCurve,bandRows,binEstimate,MAIN_BAND,MAIN_MIN_PRIOR} from '../scripts/cf-study/core.mjs';
import {openLedger} from '../scripts/cf-study/ledger-store.mjs';
import {saveJsonArray} from '../scripts/cf-study/api.mjs';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('KM retains censored people; median can be unidentified',()=>{
  assert.equal(km([{time:1,event:1},{time:2,event:0},{time:2,event:0}]).median,null);
  assert.equal(quantile([{time:1,event:1}],.5),1);
  assert.equal(km([{time:1,event:1},{time:2,event:1},{time:3,event:0}]).median,2);
});
test('KM event/censor ties use entire risk set and Gaussian weights',()=>{
  const result=km([{time:1,event:1,weight:1},{time:1,event:0,weight:2},{time:2,event:1,weight:1}]);
  assert.equal(result.curve[0].cdf,.25);assert.equal(result.median,2);
});
test('bootstrap keeps unidentified replicates and refuses one-cluster CI',()=>{
  const rows=[{contestId:1,time:1,event:1},{contestId:2,time:2,event:0}];
  const ci=bootstrap(rows,1000);assert.equal(ci.high,null);assert.ok(ci.identified<1);assert.equal(ci.reason,'upper_unbounded');
  assert.equal(bootstrap(rows.slice(0,1),100).reason,'fewer_than_two_contests');
});
test('strict sequence includes unattempted next problem as censored; rejects jumping',()=>{
  const party={participantType:'CONTESTANT',members:[{handle:'a'}]};
  const standings={contest:{id:1,startTimeSeconds:1000,durationSeconds:100,type:'CF',phase:'FINISHED'},problems:[{index:'A',rating:1000},{index:'B',rating:1100}],rows:[{party}]};
  const submission={author:party,problem:{index:'A'},relativeTimeSeconds:10,verdict:'OK'};
  const rows=candidates(standings,[{handle:'a',oldRating:1000}],[submission]);
  assert.deepEqual(rows.map(r=>[r.time,r.event,r.attempted]),[[10,1,true],[90,0,false]]);
  assert.equal(candidates(standings,[{handle:'a',oldRating:1000}],[submission,{...submission,problem:{index:'B'},relativeTimeSeconds:5,verdict:'WRONG_ANSWER'}]).length,0);
});
test('rank boundaries include below 97 and 101',()=>{
  assert.equal(rank(96.9999),'AAA');assert.equal(rank(97),'S');assert.equal(rank(0),'D');assert.equal(rank(75),'BBB');assert.equal(rank(101),'SSS+');assert.throws(()=>rank(NaN));
});
test('stability counts only unique histories before contest start; mismatched old rating rejected',()=>{
  const row={contestId:9,startTime:100,oldRating:1200};
  const history=[{contestId:9,oldRating:1200,ratingUpdateTimeSeconds:200},{contestId:8,ratingUpdateTimeSeconds:99},{contestId:8,ratingUpdateTimeSeconds:99},{contestId:7,ratingUpdateTimeSeconds:101}];
  assert.equal(attachHistory(row,history).priorRated,1);
  assert.equal(attachHistory({...row,oldRating:1500},history),null);
});
test('first final OK defines event, practice/virtual/late submissions cannot create events',()=>{
  const party={participantType:'CONTESTANT',members:[{handle:'a'}]};
  const standings={contest:{id:1,startTimeSeconds:1000,durationSeconds:100,type:'CF',phase:'FINISHED'},problems:[{index:'A',rating:1000}],rows:[{party}]};
  const s={author:party,problem:{index:'A'},relativeTimeSeconds:20,verdict:'OK'};
  const changes=[{handle:'a',oldRating:1000}];
  assert.equal(candidates(standings,changes,[s,{...s,relativeTimeSeconds:40}])[0].time,20);
  const rows=candidates(standings,changes,[{...s,author:{...party,participantType:'VIRTUAL'}},{...s,relativeTimeSeconds:101}]);
  assert.equal(rows[0].event,0);assert.equal(rows[0].time,100);
});
test('isotonic regression merges only the descending neighbours and keeps every grid point',()=>{
  const out=isotonicNonDecreasing([{q:800,y:10,w:1},{q:900,y:30,w:1},{q:1000,y:20,w:1},{q:1100,y:40,w:1}]);
  assert.deepEqual([...out.values.entries()],[[800,10],[900,25],[1000,25],[1100,40]]);
  assert.equal(out.blocks.length,3);
  assert.deepEqual(out.blocks.map(b=>[b.from,b.to]),[[800,800],[900,1000],[1100,1100]]);
});
test('isotonic regression pools descending input, leaves sorted input alone, and weights the merge',()=>{
  assert.deepEqual([...isotonicNonDecreasing([{q:1,y:3,w:1},{q:2,y:2,w:1}]).values.values()],[2.5,2.5]);
  assert.deepEqual([...isotonicNonDecreasing([{q:1,y:1,w:1},{q:2,y:2,w:1}]).values.values()],[1,2]);
  // 权重更大的块在合并时占更大比重，这是样本稀少档位被邻近档拉动（而非被平均掉）的原因。
  assert.equal(isotonicNonDecreasing([{q:1,y:4,w:9},{q:2,y:0,w:1}]).values.get(1),3.6);
});
test('isotonic regression with a slope floor lets a descending run keep its slope',()=>{
  // 严格保序（0）把一路下降的四个点压成同一条平线 —— 1700–2000 在真实数据上就是这样。
  const flat=isotonicNonDecreasing([{q:800,y:40,w:1},{q:900,y:39,w:1},{q:1000,y:38,w:1},{q:1100,y:37,w:1}]);
  assert.deepEqual([...flat.values.values()],[38.5,38.5,38.5,38.5]);
  // 给 0.01 秒/Rating 的下降余量后，四个点重新分开，且斜率正好卡在下界上。
  const sloped=isotonicNonDecreasing([{q:800,y:40,w:1},{q:900,y:39,w:1},{q:1000,y:38,w:1},{q:1100,y:37,w:1}],0.01);
  const v=[...sloped.values.values()];
  assert.equal(new Set(v).size,4);
  for(let i=1;i<v.length;i+=1)assert.ok(Math.abs((v[i-1]-v[i])-0.01*100)<1e-9,'相邻档位应恰好差 slopeFloor × 100 分');
  // 放松的是「允许下降」，不是「必须下降」：本来就上升的序列一个点都不许动。
  const rising=[{q:800,y:10,w:1},{q:900,y:30,w:1},{q:1000,y:40,w:1}];
  assert.deepEqual([...isotonicNonDecreasing(rising,0.01).values.values()],[10,30,40]);
  assert.throws(()=>isotonicNonDecreasing(rising,-1));
});
test('blockSecondsAt reads the sloped block, level alone would be off by slopeFloor × q',()=>{
  // 坡度比下界更陡，所以这三档会被并进同一个块；块内不再是一条平线。
  const {blocks}=isotonicNonDecreasing([{q:800,y:40,w:1},{q:900,y:38,w:1},{q:1000,y:36,w:1}],0.005);
  assert.equal(blocks.length,1);
  const block=blocks[0];
  assert.equal(block.from,800);assert.equal(block.to,1000);
  assert.ok(Math.abs((blockSecondsAt(block,800)-blockSecondsAt(block,1000))-0.005*200)<1e-9,'块内落差应等于 slopeFloor × 跨距');
  // slopeFloor=0 时它必须回到块值本身，老口径一个字节都不能变。
  const plain=isotonicNonDecreasing([{q:1,y:3,w:1},{q:2,y:2,w:1}]).blocks[0];
  assert.equal(blockSecondsAt(plain,1),2.5);
});
test('optimized paired bootstrap matches explicit cluster resampling',()=>{
  const rows=[{contestId:1,time:2,event:1,weight:1},{contestId:1,time:5,event:0,weight:.7},{contestId:2,time:2,event:0,weight:1},{contestId:2,time:8,event:1,weight:.8},{contestId:3,time:4,event:1,weight:1}];
  const clusters=[1,2,3].map(c=>rows.filter(r=>r.contestId===c)),random=rng(42),a=[],b=[],d=[];
  for(let i=0;i<300;i++){
    const sample=[];for(let j=0;j<3;j++)sample.push(...clusters[Math.floor(random()*3)]);
    const x=km(sample).median??Infinity,y=quantile(sample.filter(r=>r.event),.5)??Infinity;a.push(x);b.push(y);d.push(Number.isFinite(x)&&Number.isFinite(y)?x-y:Infinity);
  }
  const result=bootstrapPair(rows,300,42);
  for(const [key,values] of [['km',a],['success',b],['difference',d]] as const){
    values.sort((a,b)=>a-b);const lo=values[Math.floor(.025*299)],hi=values[Math.ceil(.975*299)];
    assert.equal(result[key].low,Number.isFinite(lo)?lo:null);assert.equal(result[key].high,Number.isFinite(hi)?hi:null);
  }
});
test('ledger store dedupes and invalidates its history cache on write',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-ledger-'));
  const store=openLedger(join(dir,'ledger.sqlite'));
  try{
    assert.equal(store.contestCount(),0);
    const batch=[
      {handle:'Alpha',contestId:1,ratingUpdateTimeSeconds:100,oldRating:800,newRating:850},
      {handle:'Beta',contestId:1,ratingUpdateTimeSeconds:100,oldRating:1500,newRating:1480},
    ];
    assert.equal(store.appendContest(1,50,batch),2);
    // 重跑同一场：主键 (handle, contest_id) 挡住，不会写第二遍。
    assert.equal(store.appendContest(1,50,batch),0);
    assert.equal(store.rowCount(),2);assert.equal(store.handleCount(),2);
    // historyFor 大小写不敏感，字段名与官方 ratingChanges 一致，按时间升序。
    assert.deepEqual(store.historyFor('ALPHA'),[{contestId:1,ratingUpdateTimeSeconds:100,oldRating:800,newRating:850}]);
    // 缓存必须随写入失效：attachHistory 要求当前这场比赛也在历史里，
    // 缓存若停在「那场还没写进去」的时刻，整行会被判 null 静默丢掉。
    const before=store.historyFor('alpha');
    store.appendContest(2,150,[{handle:'alpha',contestId:2,ratingUpdateTimeSeconds:200,oldRating:850,newRating:900}]);
    const after=store.historyFor('alpha');
    assert.equal(before.length,1);assert.equal(after.length,2);assert.notEqual(before,after);
    const attached=attachHistory({contestId:2,startTime:180,oldRating:850,handle:'alpha'},store.historyFor('alpha'));
    assert.equal(attached?.priorRated,1);
    // 非 rated 的场次也要登记覆盖，否则每轮都会重新请求一遍。
    store.markContest(3,250,0);
    assert.deepEqual([...store.coveredContests()].sort((a,b)=>a-b),[1,2,3]);
    assert.deepEqual(store.contestRows().map(r=>[r.contestId,r.rows]),[[1,2],[2,1],[3,0]]);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('the fit grid spans the configured range and lines up with the 100-step tables',()=>{
  const grid=fitGrid();
  assert.equal(grid[0],FIT_MIN_Q);
  assert.equal(grid.at(-1),FIT_MAX_Q);
  // smooth-fit / monotone-fit 按 25 步长写 CSV，table.mjs / compare.mjs 按 100 步长精确查表。
  // 端点不是 100 的倍数时，最后一档会被静默漏掉（少一行，不报错），所以这里逐个核对。
  for(let q=FIT_MIN_Q;q<=FIT_MAX_Q;q+=100)assert.ok(grid.includes(q),q+' is missing from the fit grid');
  assert.throws(()=>fitGrid(0),/positive integer/);
});
test('the shared smoother reproduces a straight line and ignores far-away bins',()=>{
  // 平滑器被 analyze/smooth-fit/monotone-fit/validate 四处共用，所以它的基本性质必须钉住。
  const line=[{q:800,y:600,effectiveSamples:1000},{q:1000,y:1200,effectiveSamples:1000},{q:1200,y:1800,effectiveSamples:1000},{q:1400,y:2400,effectiveSamples:1000}];
  const at=localLinear(line,1100,200).y;
  assert.ok(Math.abs(at-1500)<1e-6,`expected 1500, got ${at}`);
  // 带宽之外的点权重趋近 0，不该影响结果。
  const withOutlier=[...line,{q:20000,y:1e6,effectiveSamples:1000}];
  assert.ok(Math.abs(localLinear(withOutlier,1100,200).y-1500)<1);
  // 采样点为空时返回 null 而不是 NaN —— 返回 NaN 会让下游整条曲线静默消失。
  assert.equal(localLinear([],1100,200).y,null);
});
test('band selection follows the leave-one-bin-out MSE, and the fit curve is monotone only when asked',()=>{
  const data=[{q:800,y:600,effectiveSamples:1000},{q:1000,y:900,effectiveSamples:1000},{q:1200,y:1700,effectiveSamples:1000},{q:1400,y:1600,effectiveSamples:1000}];
  const selection=selectBandwidth(data,[100,400]);
  assert.ok([100,400].includes(selection.bandwidth));
  assert.equal(selection.metrics.length,2);
  assert.equal(selection.loocvRmseSeconds,Math.sqrt(selection.loocvMseSeconds2));
  const grid=[800,1000,1200,1400];
  const free=fitCurve(data,{bandwidth:400,grid,monotone:false}).points.map(p=>p.y);
  const mono=fitCurve(data,{bandwidth:400,grid,monotone:true});
  for(let i=0;i<free.length-1;i++)assert.ok(mono.points[i].y<=mono.points[i+1].y+1e-9,'monotone curve must not decrease');
  // rawY 必须保留保序前的值，否则「单调化改了多少」无从核对。
  assert.deepEqual(mono.points.map(p=>p.rawY),free);
  assert.ok(mono.blocks.length>=1);
});
test('band rows weight players by distance to the band and binEstimate counts contests, not rows',()=>{
  const samples=[
    {contestId:1,q:1000,oldRating:1000,handle:'a',event:1,time:100,attempted:true,problem:'A',priorRated:99,priorRatedKind:'certified_lower_bound'},
    {contestId:1,q:1000,oldRating:1099,handle:'b',event:0,time:200,attempted:true,problem:'A',priorRated:99,priorRatedKind:'certified_lower_bound'},
    {contestId:2,q:1000,oldRating:901,handle:'c',event:1,time:300,attempted:true,problem:'A',priorRated:99,priorRatedKind:'exact'},
    {contestId:2,q:1000,oldRating:1000,handle:'d',event:0,time:400,attempted:true,problem:'A',priorRated:3,priorRatedKind:'exact'},
  ];
  const rows=bandRows(samples,1000,MAIN_BAND,MAIN_MIN_PRIOR);
  assert.equal(rows.length,3,'the row below the prior-played threshold must be excluded');
  assert.equal(rows[0].weight,1,'a player exactly at the band centre gets weight 1');
  assert.ok(rows[1].weight<rows[0].weight,'weight decays with distance to the band');
  const {summary}=binEstimate(rows);
  // 四行里只有三行入选，但主口径按**独立比赛数**判断样本是否够用 —— 同一场比赛来一千人只算一场。
  assert.equal(summary.contests,2);
  assert.equal(summary.samples,3);
  assert.equal(summary.solved,2);
  assert.equal(summary.exactHistorySamples,1);
  assert.equal(summary.certifiedHistorySamples,2);
  assert.equal(summary.status,'small_sample','two contests is below the five-contest floor');
});
test('streaming JSON array writer survives the string-length ceiling',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-arr-'));
  const file=join(dir,'rows.json');
  try{
    // 数据量要跨过 1 MB 的刷新边界，且含中文与需要转义的字符。
    const items=Array.from({length:60000},(_,i)=>({i,handle:'选手"'+i,note:'a\\b/中文',v:i*1.5}));
    return (async()=>{
      await saveJsonArray(file,items);
      assert.equal(JSON.stringify(JSON.parse(readFileSync(file,'utf8'))),JSON.stringify(items));
      await saveJsonArray(file,[]);assert.equal(readFileSync(file,'utf8'),'[]');
      await saveJsonArray(file,[items[0]]);assert.equal(JSON.parse(readFileSync(file,'utf8')).length,1);
    })().finally(()=>rmSync(dir,{recursive:true,force:true}));
  }catch(e){rmSync(dir,{recursive:true,force:true});throw e;}
});
