import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,Repository} from '../src/db/database.ts';
import {reminderGroup,setTimeReminder,dismissedProblems} from '../src/dx/reminders.ts';
import {submission} from '../src/fetchers/common.ts';
import {handleApi,WRITE_ROUTES} from '../src/server/api.ts';
import {recordPractice} from '../src/dx/practice.ts';

test('reminders use actual AC date and inclusive seven-day boundary; dismissed always wins',()=>{
  const now=2000000;
  assert.equal(reminderGroup(now-7*86400,false,now),'recent');
  assert.equal(reminderGroup(now-7*86400-1,false,now),'historical');
  assert.equal(reminderGroup(now,true,now),'dismissed');
});

test('historical imports stay accessible; dismiss/restore does not modify AC or scores and still allows recording',async()=>{
  const db=openDatabase(':memory:');try{
    const repo=new Repository(db),user=repo.createUser('me'),account=repo.addAccount(user,'codeforces','me');
    const other=repo.createUser('other'),now=Math.floor(Date.now()/1000);
    for(const [id,at] of [['1:A',now-800000],['2:A',now-100],['3:A',now-200]] as const)repo.saveSubmissions(account,[submission('codeforces',{submission_id:id,problem_id:id,status:'AC',difficulty:1400,submitted_at:at})]);
    const record=(problemId:string)=>recordPractice(db,{userId:user,platform:'codeforces',problemId,seconds:600,outcome:'ac',practiceKind:'unknown',timingSource:'manual',attemptedAt:null});
    record('3:A');
    const ctx={db,dbPath:':memory:',platforms:['codeforces'],envFile:'unused',openWrite:()=>db,syncJobs:{} as any};
    const read=async()=> (await handleApi(ctx,{method:'GET',pathname:'/api/dx',params:new URLSearchParams({user:String(user)})})).body as any;
    let data=await read();const rating=data.board.rating;
    assert.equal(data.counts.pendingRecent,1);assert.equal(data.pending.length,2);
    assert.equal(data.pending.find((p:any)=>p.problemId==='1:A').reminderGroup,'historical');
    assert.throws(()=>setTimeReminder(db,other,'2:A',true));
    assert.throws(()=>setTimeReminder(db,user,'2:A','true' as any));
    setTimeReminder(db,user,'2:A',true);setTimeReminder(db,user,'2:A',true);
    data=await read();assert.equal(data.counts.pendingRecent,0);assert.equal(data.board.rating,rating);
    assert.equal(data.counts.solved,3);assert.equal(data.recorded.length,1);
    assert.equal(data.pending.find((p:any)=>p.problemId==='2:A').reminderGroup,'dismissed');
    setTimeReminder(db,user,'2:A',false);assert.equal((await read()).counts.pendingRecent,1);
    setTimeReminder(db,user,'1:A',true);setTimeReminder(db,user,'1:A',false);
    assert.equal((await read()).pending.find((p:any)=>p.problemId==='1:A').reminderGroup,'historical');
    setTimeReminder(db,user,'2:A',true);record('2:A');
    data=await read();assert.equal(data.recorded.length,2);assert.ok(!data.pending.some((p:any)=>p.problemId==='2:A'));
    assert.ok(WRITE_ROUTES.has('/api/dx/reminder'));
    assert.equal((await handleApi(ctx,{method:'POST',pathname:'/api/dx/reminder',params:new URLSearchParams(),body:{userId:other,problemId:'2:A',dismissed:true}})).status,400);
  }finally{db.close();}
});

test('reminder preferences do not leak across replacement accounts',()=>{
  const db=openDatabase(':memory:');try{
    const repo=new Repository(db),user=repo.createUser('me'),account=repo.addAccount(user,'codeforces','old');
    repo.saveSubmissions(account,[submission('codeforces',{submission_id:'1',problem_id:'1:A',status:'AC',submitted_at:100})]);
    setTimeReminder(db,user,'1:A',true);assert.ok(dismissedProblems(db,user).has('1:A'));
    db.prepare('UPDATE accounts SET is_archived=1 WHERE id=?').run(account);
    repo.addAccount(user,'codeforces','new');assert.equal(dismissedProblems(db,user).size,0);
  }finally{db.close();}
});
