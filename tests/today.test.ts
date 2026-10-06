import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { submission } from '../src/fetchers/common.ts';
import { getToday } from '../src/server/today.ts';
import type { Filters } from '../src/server/queries.ts';
const f:Filters={platforms:[],userId:null,scope:'me',status:'all',q:null,since:1,until:2,tzOffsetMinutes:480};
const start=Date.parse('2026-09-26T00:00:00+08:00')/1000;
test('today isolates local day, users and AC-matched practice records',()=>{
 const db=openDatabase(':memory:');
 try{
  const repo=new Repository(db),me=repo.createUser('Me',true),account=repo.addAccount(me,'codeforces','tester');
  repo.saveSubmissions(account,[['1','1:A','AC',start-1],['2','1:A','WA',start],['3','1:A','AC',start+120],['4','1:B','AC',start+180],['5','1:C','WA',start+200],['6','1:D','AC',start+86400]].map(([id,problem,status,time])=>submission('codeforces',{submission_id:String(id),problem_id:String(problem),problem_title:String(problem),status:status as 'AC'|'WA',submitted_at:Number(time),difficulty:1000})));
  const insert=db.prepare("INSERT INTO practice_attempts(user_id,platform,problem_id,seconds,outcome,practice_kind,timing_source,attempted_at,voided_at) VALUES(?,'codeforces',?,?,'ac',?,'manual',?,?)");
  insert.run(me,'1:A',1,'first',start-1,null);
  insert.run(me,'1:A',600,'repeat',start+120,null);
  insert.run(me,'1:A',2,'repeat',start+120,1);
  insert.run(me,'1:B',5,'first',start-10,null);
  const today=getToday(db,f,start+3600);
  assert.equal(today.date,'2026-09-26');assert.equal(today.summary.solved,2);assert.equal(today.summary.fresh,1);
  assert.equal(today.summary.unfinished,1);assert.equal(today.summary.submissions,4);assert.equal(today.summary.seconds,600);
  assert.equal(today.cards.find(c=>c.problemId==='1:A')!.seconds,600);
  assert.ok(today.cards.find(c=>c.problemId==='1:A')!.score);
  assert.equal(today.cards.find(c=>c.problemId==='1:B')!.score,null);
  const other=repo.createUser('Other',false),otherAccount=repo.addAccount(other,'codeforces','other');
  repo.saveSubmissions(otherAccount,[submission('codeforces',{submission_id:'7',problem_id:'1:A',status:'AC',submitted_at:start+300,difficulty:1000})]);
  assert.equal(getToday(db,f,start+3600).summary.solved,2);
  insert.run(other,'1:A',100,'assisted',start+300,null);
  const single=getToday(db,{...f,userId:other},start+3600);assert.equal(single.summary.solved,1);assert.equal(single.cards[0].score,null);
  assert.equal(getToday(db,{...f,platforms:['luogu']},start+3600).summary.solved,0);
  db.prepare('UPDATE accounts SET is_archived=1 WHERE id=?').run(account);
  assert.equal(getToday(db,f,start+3600).summary.solved,0);
 }finally{db.close();}
});
