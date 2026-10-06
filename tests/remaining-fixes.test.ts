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
  const start=new Date(2025,0,1).getTime()/1000,end=new Date(2026,0,1).getTime()/1000;
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
