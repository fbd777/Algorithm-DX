import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Repository } from '../src/db/database.ts';
import { submission } from '../src/fetchers/common.ts';
import { collectibleProfile, equipCollectible } from '../src/dx/collectibles.ts';
import { contestTracker } from '../src/server/tracker.ts';
import { createDanSession, drawNextDanStage } from '../src/dx/dan.ts';

function fixture(){
  const db=openDatabase(':memory:'),repo=new Repository(db),user=repo.createUser('我',true),account=repo.addAccount(user,'codeforces','tester');
  return {db,repo,user,account};
}

test('collectibles unlock thresholds, persist equipment, and award auditable contest titles',()=>{
  const s=fixture();
  s.db.prepare('INSERT INTO sync_state(account_id,history_complete) VALUES(?,1)').run(s.account);
  s.repo.saveProblemReleases('codeforces',[{contestId:100,name:'Round Clean',startTime:1000,durationSeconds:7200},{contestId:101,name:'Round Clear',startTime:2000,durationSeconds:7200}]);
  s.repo.saveSubmissions(s.account,[
    submission('codeforces',{submission_id:'1',problem_id:'100:A',problem_title:'A',status:'AC',submitted_at:1100,difficulty:800}),
    submission('codeforces',{submission_id:'2',problem_id:'100:B',problem_title:'B',status:'AC',submitted_at:1200,difficulty:900}),
    submission('codeforces',{submission_id:'3',problem_id:'101:A',problem_title:'A',status:'AC',submitted_at:2100,difficulty:800}),
    submission('codeforces',{submission_id:'4',problem_id:'101:B',problem_title:'B',status:'WA',submitted_at:2200,difficulty:900}),
    submission('codeforces',{submission_id:'5',problem_id:'101:B',problem_title:'B',status:'AC',submitted_at:2300,difficulty:900}),
  ]);
  const pool=[{contestId:100,index:'A',rating:800},{contestId:100,index:'B',rating:900},{contestId:101,index:'A',rating:800},{contestId:101,index:'B',rating:900}];
  const profile=collectibleProfile(s.db,s.user,pool),ids=new Set(profile.owned.map(item=>item.id));
  assert.ok(ids.has('title:newcomer'));assert.ok(ids.has('achievement:first-ac'));
  assert.ok(ids.has('title:cf:100:white'));assert.ok(ids.has('title:cf:100:silver'));
  assert.ok(ids.has('title:cf:101:white'));assert.ok(!ids.has('title:cf:101:silver'));
  const equipped=equipCollectible(s.db,s.user,'title:cf:100:silver');
  assert.equal(equipped.loadout.titleId,'title:cf:100:silver');
  assert.equal(collectibleProfile(s.db,s.user,pool).loadout.titleId,'title:cf:100:silver');
  s.db.close();
});

test('selected problem sessions draw exactly the requested unseen problem',()=>{
  const s=fixture(),pool=[{contestId:200,index:'A',rating:800},{contestId:200,index:'B',rating:900}];
  const session=createDanSession(s.db,{id:'selected-one',userId:s.user,platform:'codeforces',kind:'single',tierKey:'selected',selectedProblemId:'200:B',now:100});
  const stage=drawNextDanStage(s.db,{sessionId:session.id,pool,now:100,dateKey:'2026-01-01'});
  assert.equal(stage?.problem_id,'200:B');assert.equal(stage?.difficulty,900);
  s.db.close();
});

test('contest tracker groups problems, distinguishes attempted, AC and clean rows',()=>{
  const s=fixture();
  s.repo.saveProblemReleases('codeforces',[{contestId:300,name:'Tracker Round',startTime:3000,durationSeconds:7200}]);
  s.repo.saveSubmissions(s.account,[
    submission('codeforces',{submission_id:'t1',problem_id:'300:A',problem_title:'A',status:'AC',submitted_at:3100,difficulty:800}),
    submission('codeforces',{submission_id:'t2',problem_id:'300:B',problem_title:'B',status:'WA',submitted_at:3200,difficulty:900}),
  ]);
  const result=contestTracker(s.db,s.user,'codeforces',[{contestId:300,index:'A',rating:800},{contestId:300,index:'B',rating:900},{contestId:300,index:'C',rating:1000}],{offset:0,limit:20});
  assert.equal(result.total,1);assert.equal(result.items[0].solved,1);assert.equal(result.items[0].clean,1);
  assert.deepEqual(result.items[0].problems.map(p=>p.status),['ac','attempted','none']);
  assert.equal(result.items[0].completed,false);
  s.db.close();
});
