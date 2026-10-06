import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,Repository} from '../src/db/database.ts';
import {submission} from '../src/fetchers/common.ts';
import {refreshGroupRatings,sameProblemContent,sourceProblem,confirmGroupSource,addGroupSourceCandidate,clearGroupSource} from '../src/fetchers/cf-group-sources.ts';
import {listDxEntries,listContestTimeline} from '../src/server/queries.ts';
import {computeContestAutoSeconds,buildBoard} from '../src/dx/rating.ts';
import {handleApi} from '../src/server/api.ts';
const statement='Given a rectangle with positive integer sides a and b, find the number of squares. The constraints are 1 <= a,b <= 1000. Print the number of squares.';
const problem={title:'Square?',statement,samples:[{input:'2 3',output:'6'}],sourceLinks:[],timeLimit:'1 second',memoryLimit:'256 MB',rating:null};
const snapshot=(url:string,p:any)=>({url,status:200,loggedIn:true,challenge:false,problem:p,links:[],rows:[]}) as any;
function fixture(){const db=openDatabase(':memory:'),repo=new Repository(db),user=repo.createUser('Me',true),account=repo.addAccount(user,'codeforces','Tester');
 repo.saveSubmissions(account,[submission('codeforces',{submission_id:'1',problem_id:'700001:A',problem_title:'Square?',problem_url:'https://codeforces.com/group/abc/contest/700001/problem/A',status:'AC',submitted_at:1700000060}),submission('codeforces',{submission_id:'2',problem_id:'2:A',problem_title:'Square?',status:'AC',submitted_at:1700000080})]);
 repo.saveProblemReleases('codeforces',[{contestId:700001,name:'Training',startTime:1700000000,durationSeconds:7200},{contestId:1,name:'Original',startTime:1500000000,durationSeconds:3600},{contestId:2,name:'Other',startTime:1600000000,durationSeconds:3600}]);
 repo.set('cf:group-source-catalog:v1',[{contestId:1,index:'A',name:'Square?',rating:900,tags:['math']},{contestId:2,index:'A',name:'Square?',rating:800}],21600);
 return {db,repo,user,account};}
const read=async(url:string)=>snapshot(url,url.includes('/2/A')?{...problem,statement:statement.replace('1000','2000')}:problem);

test('verified copies share one B50 slot using the best score while unpaired identities remain separate',()=>{
 const base={platform:'codeforces',problemId:'1:A',problemTitle:'Original',problemUrl:null,problemRating:900,solvedAt:1700000000,releasedAt:1500000000,recordedSeconds:1000};
 const copy={...base,problemId:'700001:A',canonicalProblemId:'1:A',recordedSeconds:100};
 const board=buildBoard([base,copy],1600000000);assert.equal(board.total,1);assert.equal(board.old[0].entry?.problemId,'700001:A');assert.equal(buildBoard([base,{...copy,canonicalProblemId:undefined}],1600000000).total,2);
});

test('full statement and samples distinguish same names, variants, renamed copies and short collisions',()=>{
 assert.equal(sameProblemContent(problem,{...problem,title:'Renamed'}),true);
 assert.equal(sameProblemContent(problem,{...problem,statement:statement.replace('1000','2000')}),false);
 assert.equal(sameProblemContent(problem,{...problem,samples:[{input:'2 3',output:'5'}]}),false);
 assert.equal(sameProblemContent({...problem,statement:'a'},{...problem,statement:'a'}),false);
 for(const url of ['https://evil.test/contest/1/problem/A','https://codeforces.com@evil.test/contest/1/problem/A','https://codeforces.com/group/abc/contest/1/problem/A'])assert.throws(()=>sourceProblem(url));
 assert.equal(sourceProblem('https://codeforces.com/gym/103055/problem/M').id,'103055:M');
});
test('verified duplicate title updates only group difficulty/tags and separates release from contest timing',async()=>{
 const {db,user,account}=fixture();try{
 await refreshGroupRatings(db,account,undefined,{read});
 const row=db.prepare("SELECT * FROM submissions WHERE submission_id='1'").get()!;assert.equal(row.difficulty,900);assert.equal(row.submitted_at,1700000060);assert.equal(row.problem_id,'700001:A');assert.equal(row.tags_json,'["math"]');
 assert.equal(db.prepare("SELECT difficulty FROM submissions WHERE submission_id='2'").get()!.difficulty,null);
 const source=db.prepare('SELECT * FROM cf_group_rating_sources').get()!;assert.equal(source.method,'content');assert.equal(source.source_problem_id,'1:A');
 assert.equal(listDxEntries(db,user,'codeforces').find(x=>x.problemId==='700001:A')!.releasedAt,1500000000);
 assert.equal(computeContestAutoSeconds(listContestTimeline(db,user,'codeforces')).get('700001:A'),60);
 }finally{db.close();}
});
test('title-only legacy matches are revoked rather than promoted without evidence',async()=>{
 const {db,account}=fixture();try{
 db.prepare("INSERT INTO cf_group_rating_sources(problem_id,source_problem_id,rating,method) VALUES('700001:A','1:A',900,'unique_title')").run();db.prepare("UPDATE submissions SET difficulty=900 WHERE submission_id='1'").run();
 await refreshGroupRatings(db,account);assert.equal(db.prepare("SELECT difficulty FROM submissions WHERE submission_id='1'").get()!.difficulty,null);
 assert.equal(db.prepare('SELECT check_state FROM cf_group_rating_sources').get()!.check_state,'read_failed');
 }finally{db.close();}
});
test('ambiguous identical variants never select the first or highest-rated candidate',async()=>{
 const {db,account}=fixture();try{await refreshGroupRatings(db,account,undefined,{read:async u=>snapshot(u,problem)});const r=db.prepare('SELECT * FROM cf_group_rating_sources').get()!;assert.equal(r.rating,null);assert.equal(r.check_state,'ambiguous');}finally{db.close();}
});
test('unavailable candidate cannot be ignored to declare the other candidate unique',async()=>{
 const {db,account}=fixture();try{await refreshGroupRatings(db,account,undefined,{read:async u=>{if(u.includes('/2/A'))throw Error('unavailable');return snapshot(u,problem);}});assert.equal(db.prepare('SELECT check_state FROM cf_group_rating_sources').get()!.check_state,'read_failed');}finally{db.close();}
});
test('network failure preserves verified mapping and never overwrites stored practice time',async()=>{
 const {db,account,user}=fixture();try{await refreshGroupRatings(db,account,undefined,{read});db.prepare("INSERT INTO problem_times(user_id,platform,problem_id,seconds) VALUES(?,'codeforces','700001:A',53)").run(user);
 await refreshGroupRatings(db,account,undefined,{force:true,read:async()=>{throw Error('network');}});const r=db.prepare('SELECT * FROM cf_group_rating_sources').get()!;assert.equal(r.rating,900);assert.equal(r.check_state,'read_failed');assert.equal(db.prepare('SELECT seconds FROM problem_times').get()!.seconds,53);
 }finally{db.close();}
});
test('Gym original can be identified without manufacturing an official rating',async()=>{
 const {db,repo,account,user}=fixture();try{
 repo.set('cf:group-source-catalog:v1',[],21600);repo.set('cf:group-source-contests:v1:gym',[{id:103055,startTimeSeconds:1600000000}],21600);
 const gym='https://codeforces.com/gym/103055/problem/A';addGroupSourceCandidate(db,account,'700001:A',gym);
 await refreshGroupRatings(db,account,undefined,{read:async u=>snapshot(u,problem)});
 const r=db.prepare('SELECT * FROM cf_group_rating_sources').get()!;assert.equal(r.source_problem_id,'103055:A');assert.equal(r.rating,null);assert.equal(r.check_state,'unrated');assert.equal(listDxEntries(db,user,'codeforces').find(x=>x.problemId==='700001:A')!.releasedAt,1600000000);
 }finally{db.close();}
});
test('manual pairing is explicit, survives automatic updates, refreshes official rating and can be cleared',async()=>{
 const {db,repo,account}=fixture();try{
 await confirmGroupSource(db,account,'700001:A','https://codeforces.com/contest/2/problem/A');
 repo.set('cf:group-source-catalog:v1',[{contestId:2,index:'A',name:'Square?',rating:1000}],21600);
 await refreshGroupRatings(db,account,undefined,{force:true,read});const r=db.prepare('SELECT * FROM cf_group_rating_sources').get()!;assert.equal(r.method,'user_confirmed');assert.equal(r.rating,1000);
 assert.throws(()=>addGroupSourceCandidate(db,account,'2:A','https://codeforces.com/contest/2/problem/A'),/群组/);
 clearGroupSource(db,account,'700001:A');assert.equal(db.prepare("SELECT difficulty FROM submissions WHERE submission_id='1'").get()!.difficulty,null);
 }finally{db.close();}
});

test('new submissions receive cached verified metadata; missing date does not prevent identity pairing',async()=>{
 const {db,repo,account}=fixture();try{
 await refreshGroupRatings(db,account,undefined,{read});
 repo.saveSubmissions(account,[submission('codeforces',{submission_id:'3',problem_id:'700001:A',problem_title:'Square?',problem_url:'https://codeforces.com/group/abc/contest/700001/problem/A',status:'AC',submitted_at:1700000100})]);
 await refreshGroupRatings(db,account,undefined,{read:async()=>{throw Error('cached, must not read');}});assert.equal(db.prepare("SELECT difficulty FROM submissions WHERE submission_id='3'").get()!.difficulty,900);
 db.prepare('DELETE FROM contests WHERE contest_id=1').run();
 const http={json:async()=>{throw Error('unavailable');}} as any;
 await refreshGroupRatings(db,account,http,{read,force:true});const r=db.prepare('SELECT * FROM cf_group_rating_sources').get()!;assert.equal(r.method,'content');assert.equal(r.source_released_at,1500000000);assert.match(String(r.last_error),/日期/);
 }finally{db.close();}
});

test('pairing API requires explicit confirmation, blocks concurrent sync and updates AC/DX source information',async()=>{
 const {db,account,user}=fixture();try{
 let busy=false,changes=0;const ctx={db,openWrite:()=>db,platforms:['codeforces'],syncJobs:{busy:()=>busy,markDataChanged:()=>changes++}} as any;
 const request={method:'POST',pathname:'/api/cf-group-source',params:new URLSearchParams(),body:{accountId:account,problemId:'700001:A',action:'confirm',sourceUrl:'https://codeforces.com/contest/1/problem/A'}};
 assert.equal((await handleApi(ctx,request)).status,400);
 busy=true;assert.equal((await handleApi(ctx,{...request,body:{...request.body,confirm:true}})).status,409);busy=false;
 assert.equal((await handleApi(ctx,{...request,body:{...request.body,confirm:true}})).status,200);assert.equal(changes,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_lock').get()!.n,0);
 const feed=await handleApi(ctx,{method:'GET',pathname:'/api/feed',params:new URLSearchParams({user:String(user),platform:'codeforces'})});const items=(feed.body as any).items;assert.equal(items.find((x:any)=>x.problem_id==='700001:A').source_problem_id,'1:A');assert.equal(items.find((x:any)=>x.problem_id==='2:A').source_problem_id,undefined);
 const dx=await handleApi(ctx,{method:'GET',pathname:'/api/dx',params:new URLSearchParams({user:String(user)})});assert.equal((dx.body as any).pending.find((x:any)=>x.problemId==='700001:A').sourceProblemId,'1:A');
 }finally{db.close();}
});
