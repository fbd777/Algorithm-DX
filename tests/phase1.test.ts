import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, Repository } from '../src/db/database.ts';
import { CodeforcesFetcher, normalize } from '../src/fetchers/codeforces.ts';

const raw = { id:123, creationTimeSeconds:1700000000, problem:{ contestId:4,index:'A',name:'Watermelon',rating:800,tags:['math'] }, verdict:'OK', programmingLanguage:'GNU C++20', timeConsumedMillis:15, memoryConsumedBytes:2048 };

test('schema persists, constraints hold, rejudging is idempotent, failed batch rolls back', () => {
  const directory = mkdtempSync(join(tmpdir(),'algo-observer-'));
  const path = join(directory,'test.sqlite');
  const db = openDatabase(path);
  try {
    const repo = new Repository(db);
    const user = repo.createUser('Me',true);
    const account = repo.addAccount(user,'codeforces','Tourist');
    assert.throws(() => repo.addAccount(user,'codeforces','tourist'));
    assert.throws(() => repo.addAccount(999,'codeforces','other'));
    assert.throws(() => repo.createUser('Other self',true));
    repo.saveSubmissions(account,[normalize({...raw,verdict:undefined})]);
    repo.saveSubmissions(account,[normalize(raw)]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM submissions').get()!.n,1);
    assert.equal(db.prepare('SELECT status FROM submission_feed').get()!.status,'AC');
    assert.equal(db.prepare('SELECT user_id FROM submission_feed').get()!.user_id,user);
    assert.throws(() => repo.saveSubmissions(account,[normalize({...raw,id:124}),{...normalize(raw),platform:'atcoder'}]));
    assert.equal(db.prepare('SELECT count(*) AS n FROM submissions').get()!.n,1);
    repo.set('test',[normalize(raw)],60);
    assert.equal(repo.get('test')![0].submission_id,'123');
    repo.set('expired',[], -1);
    assert.equal(repo.get('expired'),undefined);
  } finally { db.close(); }
  const reopened = openDatabase(path);
  try {
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM submissions').get()!.n,1);
    reopened.exec('DELETE FROM users');
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM submissions').get()!.n,0);
  } finally { reopened.close(); rmSync(directory,{recursive:true}); }
});

test('normalizes pending, unknown and gym submissions without inventing verdicts', () => {
  assert.equal(normalize({...raw,verdict:undefined}).status,'PENDING');
  const unknown = normalize({...raw,verdict:'NEW_VERDICT'});
  assert.equal(unknown.status,'OTHER');
  assert.equal(unknown.raw_status,'NEW_VERDICT');
  assert.match(normalize({...raw,problem:{...raw.problem,contestId:100001}}).problem_url!, /\/gym\//);
  assert.throws(() => normalize({}));
});

test('Codeforces adapter caches, retries transient errors, rejects API errors and invalid input', async () => {
  const db = openDatabase(':memory:');
  try {
    const repo = new Repository(db);
    let calls = 0;
    const fake: typeof fetch = async (url) => {
      calls++;
      assert.equal(new URL(String(url)).searchParams.get('count'),'2');
      return calls === 1 ? new Response('',{status:503}) : Response.json({status:'OK',result:[raw]});
    };
    const fetcher = new CodeforcesFetcher(repo,fake);
    const result = await fetcher.fetch_recent_submissions('tourist',2);
    assert.equal(result[0].status,'AC');
    assert.equal(calls,2);
    assert.deepEqual(await fetcher.fetch_recent_submissions('Tourist',2),result);
    assert.equal(calls,2);
    await assert.rejects(fetcher.fetch_recent_submissions('bad handle'));
    await assert.rejects(fetcher.fetch_recent_submissions('tourist',0));
    let permanentCalls = 0;
    const failed = new CodeforcesFetcher(repo,async () => {
      permanentCalls++;
      return Response.json({status:'FAILED',comment:'handle: User not found'});
    });
    await assert.rejects(failed.fetch_recent_submissions('missing'),/User not found/);
    assert.equal(permanentCalls,1);
    assert.equal(repo.get('cf:v1:missing:100'),undefined);
  } finally { db.close(); }
});
