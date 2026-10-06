import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,Repository} from '../src/db/database.ts';
import {submission} from '../src/fetchers/common.ts';
import {handleApi} from '../src/server/api.ts';

test('practice search and ordering cover the whole history before pagination; unknown dates sort last',async()=>{
 const db=openDatabase(':memory:');try {
  const repo=new Repository(db);const user=repo.createUser('test',true);const account=repo.addAccount(user,'codeforces','tester');
  for(let i=1;i<=55;i++){
    repo.saveSubmissions(account,[submission('codeforces',{submission_id:String(i),problem_id:i+':A',problem_title:i===1?'Unique Needle':'普通题',status:'AC',submitted_at:100,difficulty:i<=2?null:800+100*Math.floor(i/2)})]);
    db.prepare("INSERT INTO practice_attempts(user_id,platform,problem_id,seconds,outcome,practice_kind,timing_source,attempted_at,recorded_at) VALUES (?,'codeforces',?,?,'ac','unknown','manual',?,?)").run(user,i+':A',i,i===1?null:1000+i,2000+i);
  }
  const ctx={db,dbPath:':memory:',platforms:['codeforces'],envFile:'unused',openWrite:()=>db,syncJobs:{} as any};
  const request=async(params:Record<string,string>)=>handleApi(ctx,{method:'GET',pathname:'/api/dx/attempts',params:new URLSearchParams({user:String(user),...params})});
  const read=async(params:Record<string,string>)=>{const result=await request(params);assert.equal(result.status,200);return result.body as any;};
  assert.equal((await read({q:'nEeDlE'})).rows[0].problem_id,'1:A');
  assert.equal((await read({q:'55:A'})).total,1);
  assert.equal((await read({q:'%'})).total,0);
  const ascending=await read({sort:'seconds_asc'});assert.equal(ascending.rows[0].seconds,1);assert.equal(ascending.total,55);assert.equal(ascending.rows.length,50);
  assert.equal((await read({sort:'seconds_asc',offset:'50'})).rows[0].seconds,51);
  assert.equal((await read({sort:'seconds_desc'})).rows[0].seconds,55);
  assert.equal((await read({sort:'date_asc'})).rows[0].problem_id,'2:A');
  assert.equal((await read({sort:'date_desc'})).rows[0].problem_id,'55:A');
  for(const sort of ['date_asc','date_desc'])assert.equal((await read({sort,offset:'50'})).rows.at(-1).problem_id,'1:A');
  assert.deepEqual((await read({sort:'problem_asc'})).rows.slice(0,3).map((r:any)=>r.problem_id),['1:A','2:A','3:A']);
  assert.equal((await read({})).rows[0].problem_id,'55:A');
  assert.equal((await request({sort:'invalid'})).status,400);
  assert.equal((await request({q:'x'.repeat(121)})).status,400);
  for(const sort of ['difficulty_asc','difficulty_desc']) {
    const first=await read({sort});const last=await read({sort,offset:'50'});
    assert.equal(first.total,55);
    assert.equal(first.rows[0].problem_rating,sort==='difficulty_asc'?900:3500);
    const ordered=[...first.rows,...last.rows];
    assert.deepEqual(ordered.slice(-2).map((r:any)=>r.problem_id),['2:A','1:A']);
    assert.ok(ordered.slice(-2).every((r:any)=>r.problem_rating===null));
    const known=ordered.slice(0,-2);
    for(let i=1;i<known.length;i++)assert.ok(sort==='difficulty_asc'?known[i-1].problem_rating<=known[i].problem_rating:known[i-1].problem_rating>=known[i].problem_rating);
    const filtered=await read({sort,q:'普通题'});assert.equal(filtered.total,54);
  }
  const other=repo.createUser('other');assert.equal((await read({user:String(other),q:'Needle'})).total,0);
 }finally{db.close();}
});
