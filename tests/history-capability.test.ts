import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,Repository} from '../src/db/database.ts';
import {historyCapability} from '../src/fetchers/registry.ts';
import {SyncService} from '../src/sync/service.ts';

test('unsupported history backfill is skipped without fetching or recording a failure',async()=>{
 const db=openDatabase(':memory:');try {
  const repo=new Repository(db);const user=repo.createUser('me',true);const id=repo.addAccount(user,'leetcode','example');
  const service=new SyncService(db,()=>{throw Error('Unsupported backfill must not fetch');},{});
  const result=await service.sync(id,{mode:'backfill'});
  assert.equal(result[0].status,'skipped');
  assert.match(result[0].message,/20/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get()!.n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_state').get()!.n,0);
  for(const p of ['luogu','atcoder','codeforces','matiji','leetcode-cn'])assert.equal(historyCapability(p).supported,true);
  for(const p of ['leetcode'])assert.equal(historyCapability(p).supported,false);
 }finally{db.close();}
});
