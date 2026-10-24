import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, Repository } from '../src/db/database.ts';
import { bindAccount } from '../src/account-admin.ts';
import { submission } from '../src/fetchers/common.ts';
import { handleApi } from '../src/server/api.ts';
import { factorFromAchievement } from '../src/dx/rating.ts';

test('failed binding preserves credentials and rolls back account writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-bind-'));const envFile=join(dir,'.env');
 const db=openDatabase(':memory:');const repo=new Repository(db);
 try {
  const owner=repo.createUser('owner'),other=repo.createUser('other');repo.addAccount(owner,'luogu','123');
  const original='# comment\r\nALGORITHM_DX_COOKIE_LUOGU="old-test-value"\r\n';writeFileSync(envFile,original);
  const input={userId:other,platform:'luogu',handle:'123',cookie:'new-test-value',envFile,reuseExisting:true,probe:false,resolveProfile:false};
  await assert.rejects(bindAccount(db,input),{code:'ACCOUNT_OWNED_BY_OTHER'});
  assert.equal(readFileSync(envFile,'utf8'),original);
  await assert.rejects(bindAccount(db,{...input,userId:owner,reuseExisting:false}),{code:'ACCOUNT_EXISTS'});
  assert.equal(readFileSync(envFile,'utf8'),original);
  await assert.rejects(bindAccount(db,{...input,handle:'456',envFile:join(dir,'missing','.env')}));
  assert.equal(repo.findAccount('luogu','456'),undefined);
  // Deferred FK failure occurs at COMMIT, after the credential was successfully written.
  db.exec("CREATE TABLE deferred_check (user_id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER INSERT ON accounts BEGIN INSERT INTO deferred_check VALUES (999999); END;");
  await assert.rejects(bindAccount(db,{...input,handle:'789'}));
  assert.equal(readFileSync(envFile,'utf8'),original);
  assert.equal(repo.findAccount('luogu','789'),undefined);
  const absent=join(dir,'new.env');
  await assert.rejects(bindAccount(db,{...input,handle:'789',envFile:absent}));
  assert.equal(existsSync(absent),false);
 }finally{db.close();rmSync(dir,{recursive:true});}
});

test('DX exposes every saved time, year bounds, dynamic rules and rating arrival',async()=>{
 const db=openDatabase(':memory:');const repo=new Repository(db);
 try {
  const user=repo.createUser('me',true);const account=repo.addAccount(user,'codeforces','tester');
  const year=new Date().getFullYear(),start=new Date(year,0,1).getTime()/1000,end=new Date(year+1,0,1).getTime()/1000;
  repo.saveProblemReleases('codeforces',[{contestId:1,name:'old',startTime:start-1},{contestId:2,name:'new',startTime:start},{contestId:3,name:'future',startTime:end}]);
  const rows=Array.from({length:40},(_,i)=>submission('codeforces',{submission_id:String(i),problem_id:'1:'+i,status:'AC',difficulty:800,submitted_at:end+100}));
  rows.push(submission('codeforces',{submission_id:'wait',problem_id:'2:A',status:'AC',difficulty:null,submitted_at:end+100}));
  rows.push(submission('codeforces',{submission_id:'future',problem_id:'3:A',status:'AC',difficulty:2000,submitted_at:end+100}));
  repo.saveSubmissions(account,rows);
  for(const r of rows)db.prepare('INSERT INTO problem_times(user_id,platform,problem_id,seconds) VALUES (?,?,?,600)').run(user,'codeforces',r.problem_id);
  const ctx={db,dbPath:':memory:',platforms:['codeforces'],envFile:'unused',openWrite:()=>db,syncJobs:{} as any};
  const read=async()=>{const r=await handleApi(ctx,{method:'GET',pathname:'/api/dx',params:new URLSearchParams({user:String(user),year:'2025'})});assert.equal(r.status,200);return r.body as any;};
  let result=await read();
  assert.equal(result.board.oldCount,35);assert.equal(result.board.currentCount,0);
  assert.equal(result.recorded.length,42);
  assert.equal(result.recorded.filter((r:any)=>r.state==='belowCutoff').length,5);
  assert.equal(result.recorded.find((r:any)=>r.problemId==='2:A').state,'waitingRating');
  assert.equal(result.recorded.find((r:any)=>r.problemId==='3:A').state,'outsideYear');
  assert.equal(result.scoring.atSSSPlus,factorFromAchievement(100.5));
  assert.equal(result.year,year);
  assert.equal(result.yearStart,start);
  assert.equal(result.yearEnd,end);
  // A later rating payload keeps saved seconds, and the next read includes the problem.
  repo.saveSubmissions(account,[submission('codeforces',{submission_id:'wait',problem_id:'2:A',status:'AC',difficulty:1200,submitted_at:end+100})]);
  result=await read();assert.equal(result.board.currentCount,1);
  assert.equal(result.recorded.find((r:any)=>r.problemId==='2:A').recordedSeconds,600);
  // Saved entries outside the board remain editable and can be cleared.
  const target={userId:user,problemId:'1:39',seconds:900};
  assert.equal((await handleApi(ctx,{method:'POST',pathname:'/api/dx/time',params:new URLSearchParams(),body:target})).status,200);
  assert.equal((await read()).recorded.find((r:any)=>r.problemId==='1:39').recordedSeconds,900);
  assert.equal((await handleApi(ctx,{method:'POST',pathname:'/api/dx/time/clear',params:new URLSearchParams(),body:target})).status,200);
  assert.equal((await read()).pending.some((r:any)=>r.problemId==='1:39'),true);
 }finally{db.close();}
});


test('DX uses the local system year, ignores legacy year parameters and reclassifies on rollover', async t => {
 const end=new Date(2027,0,1).getTime()/1000,start=new Date(2026,0,1).getTime()/1000;
 t.mock.timers.enable({apis:['Date'],now:end*1000-1});
 const db=openDatabase(':memory:'),repo=new Repository(db);
 try {
  const user=repo.createUser('calendar demo',true),account=repo.addAccount(user,'codeforces','calendar-demo');
  repo.saveProblemReleases('codeforces',[
   {contestId:1,name:'before year',startTime:start-1},
   {contestId:2,name:'year start',startTime:start},
   {contestId:3,name:'year end',startTime:end-1},
   {contestId:4,name:'next year',startTime:end},
  ]);
  for(let i=1;i<=5;i++) {
   const id=i+':A';
   // The AC date is the same for every record; only release dates partition B50.
   repo.saveSubmissions(account,[submission('codeforces',{submission_id:id,problem_id:id,status:'AC',difficulty:1200,submitted_at:start+100})]);
   db.prepare('INSERT INTO problem_times(user_id,platform,problem_id,seconds) VALUES (?,?,?,600)').run(user,'codeforces',id);
  }
  const saved=db.prepare('SELECT * FROM problem_times ORDER BY problem_id').all();
  const ctx={db,dbPath:':memory:',platforms:['codeforces'],envFile:'unused',openWrite:()=>{throw new Error('read route wrote data');},syncJobs:{} as any};
  const read=async(pathname:string,year?:string,download=false)=>{
   const params=new URLSearchParams({user:String(user)});
   if(year!==undefined)params.set('year',year);
   if(download)params.set('download','1');
   const response=await handleApi(ctx,{method:'GET',pathname,params});
   assert.equal(response.status,200);return response;
  };
  const ids=(slots:any[])=>slots.flatMap(s=>s.entry?[s.entry.problemId]:[]).sort();
  const initial=(await read('/api/dx')).body as any;
  assert.equal(initial.year,2026);assert.equal(initial.yearStart,start);assert.equal(initial.yearEnd,end);
  assert.deepEqual(ids(initial.board.old),['1:A','5:A']);
  assert.deepEqual(ids(initial.board.current),['2:A','3:A']);
  assert.equal(initial.recorded.find((r:any)=>r.problemId==='4:A').state,'outsideYear');
  assert.equal(Object.hasOwn(initial,'years'),false);
  for(const requested of ['2000','3000','invalid']) {
   const body=(await read('/api/dx',requested)).body as any;
   assert.equal(body.year,2026);assert.deepEqual(body.board,initial.board);
   const report=await read('/api/dx/backtest',requested,true);
   assert.equal((report.body as any).year,2026);
   assert.equal((report.body as any).currentBest.oldCount,2);
   assert.equal((report.body as any).currentBest.newCount,2);
   assert.equal(report.downloadName,'algorithm-dx-backtest-2026.json');
  }
  // Exactly local midnight, without a server restart or a new practice record.
  t.mock.timers.setTime(end*1000);
  const next=(await read('/api/dx','2026')).body as any;
  assert.equal(next.year,2027);assert.equal(next.yearStart,end);
  assert.deepEqual(ids(next.board.old),['1:A','2:A','3:A','5:A']);
  assert.deepEqual(ids(next.board.current),['4:A']);
  const report=await read('/api/dx/backtest','2026',true);
  assert.equal((report.body as any).year,2027);
  assert.equal((report.body as any).currentBest.oldCount,4);
  assert.equal((report.body as any).currentBest.newCount,1);
  assert.equal(report.downloadName,'algorithm-dx-backtest-2027.json');
  assert.deepEqual(db.prepare('SELECT * FROM problem_times ORDER BY problem_id').all(),saved);
 } finally {db.close();t.mock.timers.reset();}
});
