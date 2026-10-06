import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {hostname} from 'node:os';
import {openDatabase} from '../src/db/database.ts';
import {acquireSyncLock} from '../src/sync/lock.ts';

test('sync immediately recovers a terminated local process without stealing live or unknown leases',()=>{
 const db=openDatabase(':memory:');try {
  const pid=Number(execFileSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}));
  const owner=JSON.stringify({version:1,host:hostname(),pid,token:'exited'});
  db.prepare('INSERT INTO sync_lock VALUES(1,?,unixepoch()+90)').run(owner);
  const acquired=acquireSyncLock(db);assert.notEqual(acquired,owner);
  assert.equal(JSON.parse(acquired).pid,process.pid);
  assert.throws(()=>acquireSyncLock(db),/已有同步任务/);
  assert.equal(db.prepare('SELECT owner FROM sync_lock').get()!.owner,acquired);
  for(const unknown of ['legacy-uuid',JSON.stringify({version:1,host:'another-host',pid,token:'remote'})]){
    db.prepare('UPDATE sync_lock SET owner=?,expires_at=unixepoch()+90').run(unknown);
    assert.throws(()=>acquireSyncLock(db),/秒后重试/);
    assert.equal(db.prepare('SELECT owner FROM sync_lock').get()!.owner,unknown);
  }
  db.exec('UPDATE sync_lock SET expires_at=unixepoch()');assert.ok(acquireSyncLock(db));
 }finally{db.close();}
});
