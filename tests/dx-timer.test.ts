import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { startTimer, timerState, reconcileTimers, cancelTimer, normalizeTimerProblem } from '../src/dx/timer.ts';
import { listPractice, voidPractice, recordPractice } from '../src/dx/practice.ts';
import { submission } from '../src/fetchers/common.ts';
import { handleApi, WRITE_ROUTES } from '../src/server/api.ts';
import { createTimerSync } from '../src/server/timer-sync.ts';
import { TimerSubmissionChecker, fetchTimerWindow } from '../src/server/timer-check.ts';
import { SyncService } from '../src/sync/service.ts';
import { BaseFetcher } from '../src/fetchers/base.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const db=openDatabase(':memory:'),repo=new Repository(db);
  const user=repo.createUser('test',true),account=repo.addAccount(user,'codeforces','fixture');
  const other=repo.createUser('other'),otherAccount=repo.addAccount(other,'codeforces','other');
  const now=Math.floor(Date.now()/1000)-1000;
  const start=(id='timer-test-1',problemId='2259:A',practiceKind:any='unknown')=>startTimer(db,{userId:user,problemId,practiceKind,requestId:id},now);
  const add=(id:string,at:number,problemId='2259:A',status:any='AC',accountId=account)=>repo.saveSubmissions(accountId,[submission('codeforces',{
    submission_id:id,problem_id:problemId,problem_title:'Timed practice',status,submitted_at:at,difficulty:1400})]);
  return {db,repo,user,account,other,otherAccount,now,start,add};
}

test('small public responses expand when needed to preserve the complete timed verdict window',async()=>{
 const calls:number[]=[];
 const rows=Array.from({length:10},(_,i)=>submission('codeforces',{submission_id:String(i),problem_id:'1:A',status:i?'WA':'AC',submitted_at:200-i}));
 const fetcher={fetch_batch:async(_handle:string,options:any)=>{calls.push(options.limit);return {submissions:rows} as any;}};
 await fetchTimerWindow(fetcher,'fixture',195);
 assert.deepEqual(calls,[10]);calls.length=0;
 await fetchTimerWindow(fetcher,'fixture',100);
 assert.deepEqual(calls,[10,100]);calls.length=0;
 rows.splice(1);
 await fetchTimerWindow(fetcher,'fixture',100);
 assert.deepEqual(calls,[10]);
});

test('track counts distinct daily AC problems in completion-day order, including untimed solves',()=>{
 const s=setup();try {
  const midnight=Date.parse('2026-10-06T00:00:00+08:00')/1000;
  startTimer(s.db,{userId:s.user,problemId:'2259:C',practiceKind:'first',requestId:'daily-track-test'},midnight-20);
  s.add('yesterday',midnight-1,'2259:X');
  s.add('first',midnight,'2259:A');
  s.add('first-repeat',midnight+5,'2259:A');
  s.add('other-user',midnight+6,'2259:X','AC',s.otherAccount);
  s.add('wa-only',midnight+7,'2259:Y','WA');
  s.add('second',midnight+10,'2259:B');
  s.add('completed',midnight+20,'2259:C');
  s.add('later',midnight+30,'2259:D');
  reconcileTimers(s.db,s.account,midnight+40);
  assert.equal(timerState(s.db,s.user,480).result?.dailyTrack,3);
  assert.equal(timerState(s.db,s.user,0).result?.dailyTrack,4);
  startTimer(s.db,{userId:s.user,problemId:'2259:A',practiceKind:'repeat',requestId:'daily-track-repeat'},midnight+50);
  s.add('redo',midnight+60,'2259:A');
  reconcileTimers(s.db,s.account,midnight+70);
  assert.equal(timerState(s.db,s.user,480).result?.dailyTrack,1);
 }finally{s.db.close();}
});

test('timer accepts unseen problems, canonicalizes CF URLs, and start retries cannot create duplicates',()=>{
  const s=setup();try {
    assert.equal(normalizeTimerProblem('https://codeforces.com/problemset/problem/2259/a'),'2259:A');
    assert.equal(normalizeTimerProblem('https://codeforces.com/gym/100001/problem/B1'),'100001:B1');
    assert.equal(normalizeTimerProblem('2259a'),'2259:A');
    assert.throws(()=>normalizeTimerProblem('https://evil.test/contest/2259/problem/A'));
    assert.throws(()=>normalizeTimerProblem('2259:A;DELETE'));
    const timer=s.start();assert.equal(s.start().id,timer.id);
    assert.throws(()=>s.start('timer-test-2'),/已有计时/);
    assert.throws(()=>s.start('timer-test-1','2259:B'),/另一场/);
    assert.equal(timerState(s.db,s.user).timer?.status,'running');
    assert.equal(s.db.prepare('SELECT count(*) n FROM practice_attempts').get()!.n,0);
  }finally{s.db.close();}
});

test('only matching account/problem/new AC stops the timer; elapsed excludes crawl delay and saves once',()=>{
  const s=setup();try {
    s.start();s.add('old',s.now-1);s.add('same-second',s.now);
    s.add('wrong-user',s.now+10,'2259:A','AC',s.otherAccount);
    s.add('wrong-problem',s.now+20,'2259:B');s.add('wa',s.now+30,'2259:A','WA');
    s.add('future',s.now+2000);
    reconcileTimers(s.db,s.account,s.now+800);assert.equal(timerState(s.db,s.user).timer?.status,'running');
    s.add('later',s.now+240);s.add('first-new',s.now+120);
    reconcileTimers(s.db,s.account,s.now+800);reconcileTimers(s.db,s.account,s.now+900);
    const timer=timerState(s.db,s.user).timer!;
    assert.equal(timer.status,'completed');assert.equal(timer.ended_at,s.now+120);assert.equal(timer.submission_id,'first-new');
    const attempts=listPractice(s.db,s.user);assert.equal(attempts.length,1);assert.equal(attempts[0].seconds,120);
    assert.equal(attempts[0].timing_source,'timer');assert.equal(attempts[0].practice_kind,'repeat');
    assert.equal(s.db.prepare('SELECT seconds FROM problem_times').get()!.seconds,120);
    voidPractice(s.db,s.user,attempts[0].id);reconcileTimers(s.db,s.account);
    assert.equal(s.db.prepare('SELECT count(*) n FROM problem_times').get()!.n,0);
    assert.equal(listPractice(s.db,s.user).length,1);
  }finally{s.db.close();}
});

test('cancel is user scoped and idempotent; assisted sessions never enter best times; identity changes cancel',()=>{
  const s=setup();try {
    const timer=s.start();assert.throws(()=>cancelTimer(s.db,s.other,timer.id));
    cancelTimer(s.db,s.user,timer.id);cancelTimer(s.db,s.user,timer.id);
    s.add('after-cancel',s.now+10);reconcileTimers(s.db,s.account);
    assert.equal(listPractice(s.db,s.user).length,0);
    s.start('timer-assisted','2259:B','assisted');s.add('assisted-ac',s.now+50,'2259:B');
    reconcileTimers(s.db,s.account);assert.equal(listPractice(s.db,s.user).length,1);
    assert.equal(s.db.prepare('SELECT count(*) n FROM problem_times').get()!.n,0);
    s.start('timer-archived','2259:C');s.db.prepare('UPDATE accounts SET is_archived=1 WHERE id=?').run(s.account);
    s.add('archived-ac',s.now+60,'2259:C');reconcileTimers(s.db);
    assert.equal(timerState(s.db,s.user).timer?.status,'cancelled');
  }finally{s.db.close();}
});

test('overdue offline sessions recover valid historical AC before expiry; missed windows do not fabricate time',()=>{
  const s=setup();try {
    const started=s.now-90000;
    startTimer(s.db,{userId:s.user,problemId:'2259:A',practiceKind:'first',requestId:'timer-offline'},started);
    reconcileTimers(s.db,undefined,s.now);assert.equal(timerState(s.db,s.user).timer?.status,'running');
    s.add('offline-ac',started+800);reconcileTimers(s.db,s.account,s.now);
    assert.equal(timerState(s.db,s.user).timer?.ended_at,started+800);
    startTimer(s.db,{userId:s.user,problemId:'2259:B',practiceKind:'unknown',requestId:'timer-expired'},started+1);
    reconcileTimers(s.db,s.account,s.now);assert.equal(timerState(s.db,s.user).timer?.status,'expired');
    assert.equal(listPractice(s.db,s.user).length,1);
  }finally{s.db.close();}
});

test('sync transaction records AC and timer atomically; repeated sync remains idempotent',async()=>{
  const s=setup();try {
    s.start();
    class Fake extends BaseFetcher {
      readonly platform='codeforces';
      async fetch_submissions(){return [];}
      async fetch_batch(){return {submissions:[submission('codeforces',{submission_id:'sync-ac',problem_id:'2259:A',status:'AC',difficulty:1400,submitted_at:s.now+200})],source:'fixture',scope:'recent' as const,acceptedOnly:false,complete:false,nextCursor:null,note:'test'};}
    }
    const service=new SyncService(s.db,()=>new Fake(),{});
    assert.equal((await service.sync(s.account,{mode:'recent',force:true}))[0].status,'success');
    assert.equal(timerState(s.db,s.user).timer?.status,'completed');
    await service.sync(s.account,{mode:'recent',force:true});
    assert.equal(listPractice(s.db,s.user).length,1);
  }finally{s.db.close();}
});

test('background timer checks ignore group-job cooldown and check every fifteen seconds',()=>{
  const s=setup();try {
    let busy=false;const requests:any[]=[];
    const tick=createTimerSync(s.db,()=>s.db,{busy:()=>busy,autoAvailableAt:()=>Infinity,checkTimer:(accountId:number)=>requests.push(accountId)} as any);
    tick(0);assert.equal(requests.length,0);s.start();busy=true;tick(1000);assert.equal(requests.length,1);
    busy=false;tick(2000);tick(3000);assert.equal(requests.length,1);
    assert.equal(requests[0],s.account);
    tick(16000);assert.equal(requests.length,2);
    cancelTimer(s.db,s.user,'timer-test-1');tick(70000);assert.equal(requests.length,2);
  }finally{s.db.close();}
});

test('dedicated public check settles AC atomically and coalesces simultaneous checks',async()=>{
 const s=setup();try {
  s.start();let calls=0,changed=0;
  let deliver:any;
  const pending=new Promise<any>(resolve=>{deliver=resolve;});
  const checker=new TimerSubmissionChecker(()=>s.db,()=>changed++,async()=>{calls++;return pending;});
  const first=checker.check(s.account);
  await checker.check(s.account);
  assert.equal(calls,1);assert.equal(checker.state(s.account)?.running,true);
  deliver({submissions:[submission('codeforces',{submission_id:'public-ac',problem_id:'2259:A',problem_title:'Public',status:'AC',submitted_at:s.now+50,difficulty:1400})]});
  await first;
  assert.equal(timerState(s.db,s.user).timer?.status,'completed');
  assert.equal(timerState(s.db,s.user).result?.seconds,50);
  assert.equal(changed,1);assert.equal(checker.state(s.account)?.error,null);
 }finally{s.db.close();}
});

test('public check exposes failures and does not save results after an account identity changes',async()=>{
 const s=setup();try {
  s.start();const failed=new TimerSubmissionChecker(()=>s.db,()=>{},async()=>{throw Error('network unavailable');});
  await failed.check(s.account);
  assert.match(failed.state(s.account)?.error??'',/network unavailable/);
  assert.equal(timerState(s.db,s.user).timer?.status,'running');
  const changed=new TimerSubmissionChecker(()=>s.db,()=>{},async()=>{
   s.db.prepare('UPDATE accounts SET handle_key=? WHERE id=?').run('replacement',s.account);
   return {submissions:[submission('codeforces',{submission_id:'stale-ac',problem_id:'2259:A',status:'AC',submitted_at:s.now+60})]} as any;
  });
  await changed.check(s.account);
  assert.equal(s.db.prepare("SELECT count(*) n FROM submissions WHERE submission_id='stale-ac'").get()!.n,0);
 }finally{s.db.close();}
});

test('timer read endpoint is read-only; writes are allowlisted and score library exposes server scores beyond B50',async()=>{
  const s=setup();try {
    let writes=0;const ctx={db:s.db,dbPath:':memory:',platforms:['codeforces'],envFile:'unused',syncJobs:{} as any,openWrite:()=>{writes++;return s.db;}};
    const read=await handleApi(ctx,{method:'GET',pathname:'/api/dx/timer',params:new URLSearchParams({user:String(s.user)})});
    assert.equal(read.status,200);assert.equal(writes,0);
    for(const path of ['/api/dx/timer/start','/api/dx/timer/cancel','/api/dx/timer/check'])assert.ok(WRITE_ROUTES.has(path));
    const invalid=await handleApi(ctx,{method:'POST',pathname:'/api/dx/timer/start',params:new URLSearchParams(),body:{userId:s.user,problemId:'bad',practiceKind:'unknown',requestId:'bad-start'}});
    assert.equal(invalid.status,400);
    for(let i=0;i<40;i++){
      s.add('library-'+i,s.now,'1:A'+i);
      s.db.prepare("INSERT INTO problem_times(user_id,platform,problem_id,seconds) VALUES(?,'codeforces',?,600)").run(s.user,'1:A'+i);
    }
    const library:any=await handleApi(ctx,{method:'GET',pathname:'/api/dx',params:new URLSearchParams({user:String(s.user)})});
    assert.equal(library.body.recorded.length,40);
    assert.equal(library.body.recorded.filter((r:any)=>r.state==='belowCutoff').length,5);
    assert.ok(library.body.recorded.every((r:any)=>r.score && r.score.rating>0));
  }finally{s.db.close();}
});

test('active timers survive database reopen and resolve after the service restarts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-timer-')),path=join(dir,'timer.sqlite');
  let db=openDatabase(path);
  try {
    let repo=new Repository(db);const user=repo.createUser('restart'),account=repo.addAccount(user,'codeforces','restart');
    const started=Math.floor(Date.now()/1000)-100;
    startTimer(db,{userId:user,problemId:'1:A',practiceKind:'unknown',requestId:'timer-restart'},started);
    db.close();db=openDatabase(path);repo=new Repository(db);
    assert.equal(timerState(db,user).timer?.started_at,started);
    repo.saveSubmissions(account,[submission('codeforces',{submission_id:'restart-ac',problem_id:'1:A',status:'AC',submitted_at:started+40})]);
    reconcileTimers(db,account);
    assert.equal(listPractice(db,user)[0].seconds,40);
  }finally{db.close();rmSync(dir,{recursive:true});}
});

test('a failed timer completion rolls back the attempt and leaves the timer retryable',()=>{
  const s=setup();try {
    s.start();s.add('ac',s.now+80);
    s.db.exec("CREATE TRIGGER reject_timer_completion BEFORE UPDATE ON practice_timers WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    assert.throws(()=>reconcileTimers(s.db,s.account),/test failure/);
    assert.equal(timerState(s.db,s.user).timer?.status,'running');
    assert.equal(listPractice(s.db,s.user).length,0);
    assert.equal(s.db.prepare('SELECT count(*) n FROM problem_times').get()!.n,0);
    s.db.exec('DROP TRIGGER reject_timer_completion');reconcileTimers(s.db,s.account);
    assert.equal(listPractice(s.db,s.user).length,1);
  }finally{s.db.close();}
});

test('settlement counts only session verdicts and scores this attempt rather than the saved best',()=>{
  const s=setup();try {
    s.add('old-wa',s.now,'2259:A','WA');s.add('old-ac',s.now-50);
    recordPractice(s.db,{userId:s.user,platform:'codeforces',problemId:'2259:A',seconds:60,
      outcome:'ac',practiceKind:'first',timingSource:'manual',attemptedAt:s.now-50});
    s.start();
    s.add('wa-1',s.now+10,'2259:A','WA');s.add('wa-2',s.now+20,'2259:A','WA');
    s.add('tle',s.now+30,'2259:A','TLE');s.add('pending',s.now+40,'2259:A','PENDING');
    s.add('other-problem',s.now+50,'2259:B','WA');s.add('other-account',s.now+60,'2259:A','WA',s.otherAccount);
    s.add('ac',s.now+120);s.add('after-ac',s.now+121,'2259:A','WA');
    reconcileTimers(s.db,s.account);
    const result=timerState(s.db,s.user).result!;
    assert.equal(result.waCount,2);assert.equal(result.seconds,120);assert.equal(result.practiceKind,'repeat');
    assert.deepEqual(result.verdicts,{AC:1,PENDING:1,TLE:1,WA:2});
    assert.equal(result.title,'Timed practice');assert.equal(result.difficulty,1400);assert.ok(result.score?.rating);
    assert.equal(s.db.prepare('SELECT seconds FROM problem_times').get()!.seconds,60);
    assert.equal(result.comparison.ratingDelta,0);
    assert.ok(result.comparison.previousScore.achievementShown>result.score!.achievementShown);
    startTimer(s.db,{userId:s.user,problemId:'2259:A',practiceKind:'assisted',requestId:'timer-next'},s.now+121);
    s.add('next-ac',s.now+600);
    reconcileTimers(s.db,s.account);
    assert.equal(timerState(s.db,s.user).result?.practiceKind,'assisted');
    assert.equal(timerState(s.db,s.user).result?.seconds,479);
    assert.equal(timerState(s.db,s.user).result?.comparison.ratingDelta,0);
  }finally{s.db.close();}
});

test('settlement preserves AC and WA counts when problem difficulty is unavailable',()=>{
  const s=setup();try {
    s.start();s.repo.saveSubmissions(s.account,[submission('codeforces',{
      submission_id:'unrated-ac',problem_id:'2259:A',status:'AC',submitted_at:s.now+15})]);
    reconcileTimers(s.db,s.account);
    const result=timerState(s.db,s.user).result!;
    assert.equal(result.score,null);assert.equal(result.waCount,0);assert.equal(result.verdicts.AC,1);
    assert.equal(result.seconds,15);
    assert.equal(result.comparison.ratingDelta,0);
  }finally{s.db.close();}
});

test('settlement freezes the previous best and actual B50 gain across subsequent history changes',()=>{
  const s=setup();try {
    s.add('old-ac',s.now-100);
    recordPractice(s.db,{userId:s.user,platform:'codeforces',problemId:'2259:A',seconds:5000,
      outcome:'ac',practiceKind:'first',timingSource:'manual',attemptedAt:s.now-100});
    s.start();s.add('new-ac',s.now+600);reconcileTimers(s.db,s.account);
    const result=timerState(s.db,s.user).result!,comparison=result.comparison;
    assert.ok(comparison.ratingDelta>0);
    assert.equal(comparison.ratingBefore,comparison.previousScore.rating);
    assert.equal(comparison.ratingAfter,result.score!.rating);
    assert.ok(comparison.currentScore.achievementShown>comparison.previousScore.achievementShown);
    voidPractice(s.db,s.user,timerState(s.db,s.user).timer!.attempt_id!);
    assert.deepEqual(timerState(s.db,s.user).result!.comparison,comparison);
    assert.deepEqual(timerState(s.db,s.user).result!.score,result.score);
  }finally{s.db.close();}
});

test('a first result below B35 cutoff earns a single score but no total Rating gain',()=>{
  const s=setup();try {
    for(let i=0;i<35;i++) {
      const problemId='1:A'+i;
      s.repo.saveSubmissions(s.account,[submission('codeforces',{submission_id:'top-'+i,
        problem_id:problemId,status:'AC',difficulty:3000,submitted_at:s.now-100})]);
      recordPractice(s.db,{userId:s.user,platform:'codeforces',problemId,seconds:60,
        outcome:'ac',practiceKind:'first',timingSource:'manual',attemptedAt:s.now-100});
    }
    s.start();s.add('below-cutoff',s.now+600);reconcileTimers(s.db,s.account);
    const result=timerState(s.db,s.user).result!;
    assert.ok(result.score!.rating>0);assert.equal(result.comparison.previousScore,null);
    assert.equal(result.comparison.ratingDelta,0);
    assert.equal(result.comparison.ratingBefore,result.comparison.ratingAfter);
  }finally{s.db.close();}
});
