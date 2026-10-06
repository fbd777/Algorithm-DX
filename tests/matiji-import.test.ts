import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { importMatiji } from '../src/matiji-import.ts';
import { acquireSyncLock } from '../src/sync/lock.ts';
import { handleApi } from '../src/server/api.ts';
import { SyncJobRunner } from '../src/server/sync-job.ts';
const record=(id:number)=>({submissionId:String(id),problemId:'p'+id,problemTitle:'题目 '+id,judgeResult:'Accepted',submitTime:1700000000});
function fixture(){const db=openDatabase(':memory:');const repo=new Repository(db);const uid=repo.createUser('me',true);const aid=repo.addAccount(uid,'matiji','test');return {db,aid};}
test('preview is read-only; complete import exceeds 100 records and duplicate uploads are idempotent',()=>{
 const {db,aid}=fixture();try{
 const snapshot={account_handle:'test',records:[...Array.from({length:150},(_,i)=>record(i)),record(1)]};
 db.exec('PRAGMA query_only=ON');const preview=importMatiji(db,aid,snapshot);db.exec('PRAGMA query_only=OFF');
 assert.equal(preview.unique,150);assert.equal(preview.duplicates,1);
 assert.equal(db.prepare('SELECT count(*) n FROM submissions').get()!.n,0);
 const first=importMatiji(db,aid,snapshot,true);assert.equal(first.inserted,150);
 const again=importMatiji(db,aid,snapshot,true);assert.equal(again.inserted,0);assert.equal(again.existing,150);
 assert.equal(db.prepare('SELECT history_complete FROM sync_state WHERE account_id=?').get(aid)!.history_complete,0);
 }finally{db.close();}
});
test('bad files and wrong accounts are rejected atomically; existing records survive conflicts',()=>{
 const {db,aid}=fixture();try{
 assert.throws(()=>importMatiji(db,aid,{account_handle:'other',records:[record(1)]},true));
 assert.throws(()=>importMatiji(db,aid,{account_handle:'test',records:[record(1),{}]},true));
 assert.equal(db.prepare('SELECT count(*) n FROM submissions').get()!.n,0);
 importMatiji(db,aid,{account_handle:'test',records:[record(1)]},true);
 assert.throws(()=>importMatiji(db,aid,{account_handle:'test',records:[record(2),{...record(1),problemId:'other'}]},true));
 assert.equal(db.prepare('SELECT count(*) n FROM submissions').get()!.n,1);
 db.prepare('UPDATE accounts SET is_archived=1 WHERE id=?').run(aid);
 assert.throws(()=>importMatiji(db,aid,{account_handle:'test',records:[record(2)]},true));
 }finally{db.close();}
});
test('active sync lock blocks writes; preview remains available',()=>{
 const {db,aid}=fixture();try{
 acquireSyncLock(db);const snapshot={account_handle:'test',records:[record(1)]};
 assert.equal(importMatiji(db,aid,snapshot).unique,1);
 assert.throws(()=>importMatiji(db,aid,snapshot,true),/正在运行/);
 assert.equal(db.prepare('SELECT count(*) n FROM submissions').get()!.n,0);
 }finally{db.close();}
});
test('web endpoint imports and signals all pages to refresh',async()=>{
 const {db,aid}=fixture();try{
 const jobs=new SyncJobRunner(()=>db,'unused');const before=jobs.revision();
 const ctx={db,dbPath:':memory:',platforms:['matiji'],envFile:'unused',openWrite:()=>db,syncJobs:jobs};
 const result=await handleApi(ctx,{method:'POST',pathname:'/api/import/matiji',params:new URLSearchParams(),body:{accountId:aid,snapshot:{account_handle:'test',records:[record(1)]},commit:true}});
 assert.equal(result.status,200);assert.notEqual(jobs.revision(),before);
 assert.equal((result.body as any).inserted,1);
 }finally{db.close();}
});
