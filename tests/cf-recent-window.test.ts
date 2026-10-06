import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { CodeforcesSyncFetcher } from '../src/fetchers/codeforces-sync.ts';
import { HttpClient } from '../src/fetchers/http.ts';
import { SyncService } from '../src/sync/service.ts';
import { submission } from '../src/fetchers/common.ts';

function fixture(db:any, times:number[], calls:number[]) {
  return new CodeforcesSyncFetcher(new Repository(db),new HttpClient(db,async url=>{
    const u=new URL(String(url));
    assert.equal(u.pathname,'/api/user.status');
    const count=Number(u.searchParams.get('count'));calls.push(count);
    return Response.json({status:'OK',result:times.slice(0,count).map((time,i)=>({
      id:1000-i,creationTimeSeconds:time,verdict:'OK',problem:{contestId:4,index:'A',name:'Watermelon'}
    }))});
  },async()=>{}));
}

test('CF small probe expands at the time boundary and preserves force/backfill behavior',async()=>{
  const db=openDatabase(':memory:');
  try {
    const calls:number[]=[],fetcher=fixture(db,Array.from({length:120},(_,i)=>200000-i*1000),calls);
    const small=await fetcher.fetch_batch('tourist',{since:195000});
    assert.deepEqual(calls.splice(0),[10]);assert.equal(small.submissions.length,10);assert.equal(small.complete,false);
    await fetcher.fetch_batch('tourist',{since:191000});
    assert.deepEqual(calls.splice(0),[10,100]); // Equal timestamps must not truncate the boundary.
    await fetcher.fetch_batch('tourist',{since:100000});
    assert.deepEqual(calls.splice(0),[10,100]);
    await fetcher.fetch_batch('tourist',{since:195000,force:true});
    assert.deepEqual(calls.splice(0),[100]);
    await fetcher.fetch_batch('tourist',{since:195000,mode:'backfill',maxPages:1});
    assert.deepEqual(calls.splice(0),[1000]);
    const exhausted=await fixture(db,[200000],calls).fetch_batch('tourist',{since:100000});
    assert.equal(exhausted.complete,true);assert.deepEqual(calls,[10]);
  } finally {db.close();}
});

test('latest CF sync uses completed coverage, bypasses response cache, and revisits pending records',async()=>{
  const db=openDatabase(':memory:');
  try {
    const repo=new Repository(db),user=repo.createUser('Test',true),account=repo.addAccount(user,'codeforces','tourist');
    const calls:number[]=[],fetcher=fixture(db,Array.from({length:75},(_,i)=>200000-i*20000),calls);
    // Keep this integration test focused on submissions rather than auxiliary metadata.
    fetcher.fetch_problem_releases=async()=>null;
    fetcher.fetch_problem_ratings=async()=>null;
    const service=new SyncService(db,()=>fetcher,{});
    assert.equal((await service.sync(account))[0].status,'success');
    assert.deepEqual(calls.splice(0),[100]); // First sync retains the old window.
    assert.equal((await service.sync(account))[0].status,'success');
    assert.deepEqual(calls.splice(0),[10]);
    assert.equal((await service.sync(account))[0].status,'success');
    assert.deepEqual(calls.splice(0),[10]); // Immediate repeat still reaches CF.
    repo.saveSubmissions(account,[submission('codeforces',{submission_id:'old-pending',problem_id:'4:A',submitted_at:10000,status:'PENDING'})]);
    assert.equal((await service.sync(account))[0].status,'success');
    assert.deepEqual(calls.splice(0),[10,100]);
    assert.equal((await service.sync(account,{force:true}))[0].status,'success');
    assert.deepEqual(calls,[100]);
  } finally {db.close();}
});
