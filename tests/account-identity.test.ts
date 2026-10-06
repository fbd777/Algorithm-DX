import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { renameAccount, replaceAccount, bindAccount } from '../src/account-admin.ts';
import { submission } from '../src/fetchers/common.ts';
import { setProblemTime } from '../src/dx-admin.ts';
import { getMeta, listDxEntries, listContestTimeline } from '../src/server/queries.ts';
import { SyncService } from '../src/sync/service.ts';
import { handleApi } from '../src/server/api.ts';

function fixture() {
 const db=openDatabase(':memory:'); const repo=new Repository(db);
 const user=repo.createUser('me',true); const old=repo.addAccount(user,'codeforces','old');
 const ac=submission('codeforces',{submission_id:'1',problem_id:'100:A',status:'AC',submitted_at:1000,difficulty:1200});
 repo.saveSubmissions(old,[ac]);
 db.prepare('INSERT INTO sync_state(account_id,history_cursor,history_complete) VALUES (?,?,1)').run(old,'501');
 setProblemTime(db,{userId:user,platform:'codeforces',problemId:'100:A',seconds:600});
 return {db,repo,user,old,ac};
}

test('same identity rename requires confirmation and preserves records and cursor',()=>{
 const {db,repo,old}=fixture();try {
  assert.throws(()=>renameAccount(db,old,'new'),{code:'IDENTITY_CONFIRM_REQUIRED'});
  repo.setDisplayName(old,'stale');
  assert.equal(renameAccount(db,old,'new',true).submissions,1);
  assert.equal(db.prepare('SELECT history_cursor FROM sync_state').get()!.history_cursor,'501');
  assert.equal(db.prepare('SELECT display_name FROM accounts').get()!.display_name,null);
  const numeric=repo.addAccount(1,'luogu','123');
  assert.throws(()=>renameAccount(db,numeric,'456',true),{code:'STABLE_ID'});
 }finally{db.close();}
});

test('replacement preserves archive and isolates stats, sync and manual times',async()=>{
 const {db,repo,user,old,ac}=fixture();try {
  const result=replaceAccount(db,old,'new');
  assert.notEqual(result.id,old);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions WHERE account_id=?').get(old)!.n,1);
  assert.equal(db.prepare('SELECT history_cursor FROM sync_state WHERE account_id=?').get(old)!.history_cursor,'501');
  assert.equal(db.prepare('SELECT * FROM sync_state WHERE account_id=?').get(result.id),undefined);
  assert.equal(db.prepare('SELECT seconds FROM archived_problem_times').get()!.seconds,600);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM problem_times').get()!.n,0);
  const meta=getMeta(db,':memory:',['codeforces']);
  assert.equal(meta.problems.solved,0);
  assert.equal(meta.users[0].account_count,1);
  assert.equal(meta.accounts.find(a=>a.id===old)!.is_archived,true);
  assert.deepEqual(listDxEntries(db,user,'codeforces'),[]);
  assert.deepEqual(listContestTimeline(db,user,'codeforces'),[]);
  assert.throws(()=>setProblemTime(db,{userId:user,platform:'codeforces',problemId:'100:A',seconds:700}),{code:'PROBLEM_NOT_SOLVED'});
  let factoryCalled=false;
  const sync=new SyncService(db,()=>{factoryCalled=true;throw Error('unexpected');},{});
  await assert.rejects(sync.sync(old),/Account/); assert.equal(factoryCalled,false);
  await assert.rejects(bindAccount(db,{userId:user,platform:'codeforces',handle:'old',envFile:'unused',reuseExisting:true,probe:false}),{code:'ACCOUNT_ARCHIVED'});
  repo.saveSubmissions(result.id,[ac]);
  assert.equal(listDxEntries(db,user,'codeforces')[0].recordedSeconds,null);
 }finally{db.close();}
});

test('replacement retains shared user time when another active account solved the same problem',()=>{
 const {db,repo,user,old,ac}=fixture();try {
  repo.saveSubmissions(repo.addAccount(user,'codeforces','other'),[ac]);
  replaceAccount(db,old,'new');
  assert.equal(listDxEntries(db,user,'codeforces')[0].recordedSeconds,600);
 }finally{db.close();}
});

test('identity mutations reject conflicts and running sync without partial writes',()=>{
 const {db,repo,user,old}=fixture();try {
  repo.addAccount(user,'codeforces','taken');
  assert.throws(()=>replaceAccount(db,old,'TAKEN'),{code:'HANDLE_TAKEN'});
  assert.throws(()=>replaceAccount(db,old,'OLD'),{code:'HANDLE_TAKEN'});
  db.exec("INSERT INTO sync_lock VALUES (1,'test',unixepoch()+90)");
  assert.throws(()=>replaceAccount(db,old,'new'),{code:'SYNC_BUSY'});
  assert.throws(()=>renameAccount(db,old,'new',true),{code:'SYNC_BUSY'});
  assert.equal(db.prepare('SELECT is_archived FROM accounts WHERE id=?').get(old)!.is_archived,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM problem_times').get()!.n,1);
 }finally{db.close();}
});

test('replacement API requires confirmation and returns independent account',async()=>{
 const {db,old}=fixture();try {
  const ctx={db,dbPath:':memory:',platforms:['codeforces'],envFile:'unused',openWrite:()=>db,syncJobs:{} as any};
  const request={method:'POST',pathname:'/api/accounts/replace',params:new URLSearchParams(),body:{id:old,handle:'new'}};
  const denied=await handleApi(ctx,request);assert.equal(denied.status,400);
  const accepted=await handleApi(ctx,{...request,body:{...request.body,confirm:true}});
  assert.equal(accepted.status,200);
  assert.equal((accepted.body as any).archivedId,old);
 }finally{db.close();}
});
