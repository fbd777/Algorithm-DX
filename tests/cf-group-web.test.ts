import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeforcesGroupWebFetcher, cfServerTime, parseWebRows, nextPage, CF_GROUP_SNAPSHOT, type PageSnapshot } from '../src/fetchers/codeforces-group-web.ts';
import { validateCfPageUrl, requireCfReady, CF_LOGIN_STATE } from '../src/fetchers/cf-browser.ts';
import { parseGroupLinks } from '../src/fetchers/codeforces-group.ts';
import { createFactory } from '../src/fetchers/registry.ts';
import { SyncService } from '../src/sync/service.ts';
import { listProblems, listDxEntries } from '../src/server/queries.ts';
import { listPractice, recordPractice } from '../src/dx/practice.ts';
import { openDatabase, Repository } from '../src/db/database.ts';
import { FetchError } from '../src/fetchers/base.ts';
const root='https://codeforces.com/group/abc';
const contest=parseGroupLinks(root+'/contest/720850')[0];
const cache={get:()=>undefined,set:()=>{}} as any;
const http={json:async()=>({status:'OK',result:[]})} as any;
const page=(url:string,extra:Partial<PageSnapshot>={}):PageSnapshot=>({url,status:200,title:'Status - Codeforces',loggedIn:true,challenge:false,contestTable:true,statusTable:true,empty:false,links:[],rows:[],...extra});
const row=(id:string,handle='Tester')=>({id,handles:[handle],problem:'/group/abc/contest/720850/problem/A',title:'A - Test',time:'Oct/03/2026 08:12',verdict:'OK',verdictText:'Accepted',language:'GNU C++20',execution:'15 ms',memory:'256 KB'});

test('disconnected group extension still returns public ACs without claiming complete group coverage', async()=>{
 const publicHttp={json:async()=>({status:'OK',result:[{id:123,creationTimeSeconds:200,verdict:'OK',problem:{contestId:41,index:'A',name:'Public problem',rating:800}}]})} as any;
 const f=new CodeforcesGroupWebFetcher(cache,publicHttp,[contest],async()=>{throw new FetchError('not connected',false,'CF_EXTENSION_REQUIRED');});
 const batch=await f.fetch_batch('Tester');
 assert.equal(batch.submissions[0].problem_id,'41:A');
 assert.equal(batch.submissions[0].status,'AC');
 assert.equal(batch.complete,false);
 assert.match(batch.note,/群组提交未同步/);
 await assert.rejects(f.fetch_batch('Tester',{mode:'backfill'}),{code:'CF_EXTENSION_REQUIRED'});
});
test('browser expression compiles and navigation cannot leave CF group pages',()=>{
 new Function('return '+CF_GROUP_SNAPSHOT);
 assert.equal(validateCfPageUrl(root+'/contests?locale=en').hostname,'codeforces.com');
 for(const url of ['http://codeforces.com/group/abc/contests','https://evil.test/group/abc/contests','https://codeforces.com@evil.test/group/abc/contests','https://codeforces.com/settings/api'])assert.throws(()=>validateCfPageUrl(url));
});
test('web rows filter user, preserve group identity and convert original server timestamps',()=>{
 const rows=parseWebRows(page(root,{rows:[row('1'),row('2','Other')]}),contest,'tester');
 assert.equal(rows.length,1);assert.equal(rows[0].status,'AC');assert.equal(rows[0].problem_id,'720850:A');assert.equal(rows[0].problem_title,'Test');
 assert.equal(rows[0].memory,262144);assert.equal(rows[0].difficulty,null);
 assert.equal(rows[0].submitted_at,Date.parse('2026-10-03T05:12:00Z')/1000);
 assert.throws(()=>cfServerTime('Feb/30/2026 12:00'));
 assert.throws(()=>parseWebRows(page(root,{rows:[{...row('1'),problem:'/group/other/contest/720850/problem/A'}]}),contest,'Tester'));
});
test('discovery paginates within group, deduplicates and sees newly added contests',async()=>{
 const visits:string[]=[];let added=false;
 const reader=async(url:string)=>{visits.push(url);const u=new URL(url);
  if(u.pathname.endsWith('/contests'))return page(url,{links:[{href:'/group/abc/contest/720850',text:''},{href:'/group/abc/contests/page/2',text:'2'},{href:'/group/other/contest/999',text:''}]});
  return page(url,{links:[{href:'/group/abc/contest/'+(added?'720852':'720851'),text:''}]});};
 const f=new CodeforcesGroupWebFetcher(cache,http,parseGroupLinks(root+'/contests '+contest.url),reader);
 assert.deepEqual((await f.discover()).map(c=>c.id),['720851','720850']);added=true;
 assert.deepEqual((await f.discover()).map(c=>c.id),['720852','720850']);assert.equal(visits.length,4);
 assert.equal(nextPage(page(root,{links:[{href:'/group/abc/contests/page/99',text:'99'}]}),'/group/abc/contests',1),2);
});
test('backfill resumes webpages and completed public source; discovers completion without API keys',async()=>{
 const visits:string[]=[];
 const reader=async(url:string)=>{visits.push(url);const second=url.includes('/page/2');return page(url,{rows:[row(second?'2':'1')],links:second?[]:[{href:'/group/abc/contest/720850/status/page/2',text:'2'}]});};
 const f=new CodeforcesGroupWebFetcher(cache,http,[contest],reader);
 const first=await f.fetch_batch('Tester',{mode:'backfill',maxPages:1});assert.equal(first.complete,false);assert.equal(JSON.parse(first.nextCursor!).groups['720850'],2);
 const second=await f.fetch_batch('Tester',{mode:'backfill',maxPages:1,cursor:first.nextCursor});assert.equal(second.complete,true);assert.equal(second.submissions[0].submission_id,'2');assert.equal(visits.length,2);
});
test('login, challenge, wrong pages, unknown markup and repeated pages never become empty success',async()=>{
 for(const change of [{loggedIn:false,contestTable:false,statusTable:false},{challenge:true},{status:403},{statusTable:false},{url:'https://codeforces.com/enter'}]){
  const f=new CodeforcesGroupWebFetcher(cache,http,[contest],async(url)=>page(url,change));
  await assert.rejects(f.fetch_batch('Tester'));
 }
 const repeated=new CodeforcesGroupWebFetcher(cache,http,[contest],async(url)=>page(url,{rows:[row('1')],links:[{href:'/group/abc/contest/720850/status/page/99',text:'99'}]}));
 const stalled=await repeated.fetch_batch('Tester');assert.equal(stalled.complete,false);assert.match(stalled.note,/分页没有前进/);assert.equal(stalled.submissions.length,1);
 const empty=new CodeforcesGroupWebFetcher(cache,http,[contest],async(url)=>page(url));
 assert.equal((await empty.fetch_batch('Tester')).complete,true);
});
test('legacy API cursors restart group pages, new contests join history and abort is respected',async()=>{
 const visits:string[]=[];const reader=async(url:string)=>{visits.push(url);return page(url);};
 const f=new CodeforcesGroupWebFetcher(cache,http,[contest],reader);
 await f.fetch_batch('Tester',{mode:'backfill',cursor:JSON.stringify({version:1,public:null,groups:{720850:null}})});
 assert.equal(visits.length,1);
 const controller=new AbortController();controller.abort();
 await assert.rejects(f.fetch_batch('Tester',{signal:controller.signal}),{name:'AbortError'});
});
test('factory defaults configured groups to browser and allows explicit API mode',()=>{
 const db=openDatabase(':memory:');try{
  const account={id:1,user_id:1,platform:'codeforces',handle:'Tester'};
  const env={ALGO_CF_GROUPS_1:contest.url};
  assert.ok(createFactory(db,env,http)(account) instanceof CodeforcesGroupWebFetcher);
  assert.equal(createFactory(db,{...env,ALGO_CF_GROUP_MODE_1:'api'},http)(account).constructor.name,'CodeforcesGroupFetcher');
 }finally{db.close();}
});

test('private contests can fall back to own submissions only for the logged-in user',async()=>{
 const visits:string[]=[];
 const f=new CodeforcesGroupWebFetcher(cache,http,[contest],async(url)=>{
  visits.push(url);return url.includes('/my?')?page(url,{rows:[row('1')],viewer:'Tester'}):page(url,{statusTable:false,viewer:'Tester'});
 });
 const result=await f.fetch_batch('Tester');assert.equal(result.submissions.length,1);assert.equal(visits.length,2);
 await assert.rejects(f.fetch_batch('Other'),/不可见/);
});

test('browser readiness blocks challenge loops and unsigned-in pages before issuing requests',()=>{
 new Function('return '+CF_LOGIN_STATE);
 assert.throws(()=>requireCfReady([]),/完成登录/);
 assert.throws(()=>requireCfReady([{ready:'loading',challenge:false,loggedIn:true}]),/暂停网页抓取/);
 assert.throws(()=>requireCfReady([{ready:'complete',challenge:true,loggedIn:false},{ready:'complete',challenge:false,loggedIn:true}]),/已停止网页请求/);
 assert.doesNotThrow(()=>requireCfReady([{ready:'complete',challenge:false,loggedIn:true}]));
});

test('valid visible submission tables are accepted even when header login detection fails',async()=>{
 const f=new CodeforcesGroupWebFetcher(cache,http,[contest],async(url)=>page(url,{loggedIn:false,rows:[row('1')]}));
 assert.equal((await f.fetch_batch('Tester')).submissions[0].status,'AC');
});

 test('own account uses my pages directly after group discovery and retains source across backfill',async()=>{
 const visits:string[]=[];
 const f=new CodeforcesGroupWebFetcher(cache,http,parseGroupLinks(root+'/contests'),async url=>{
 visits.push(url);if(url.includes('/contests'))return page(url,{viewer:'Tester',links:[{href:contest.url,text:'Contest'}]});
 assert.match(url,/\/my/);const second=url.includes('/page/2');return page(url,{viewer:'Tester',rows:[row(second?'2':'1')],links:second?[]:[{href:contest.url+'/my/page/2',text:'2'}]});
 });
 const first=await f.fetch_batch('Tester',{mode:'backfill',maxPages:1});const cursor=JSON.parse(first.nextCursor!);assert.equal(cursor.paths['720850'],'my');
 const second=await f.fetch_batch('Tester',{mode:'backfill',maxPages:1,cursor:first.nextCursor});assert.equal(second.complete,true);assert.equal(second.submissions[0].submission_id,'2');
 assert.equal(visits.some(url=>url.includes('/status')),false);
 });
 test('following another user keeps full status pages and filters their records',async()=>{
 const f=new CodeforcesGroupWebFetcher(cache,http,parseGroupLinks(root+'/contests'),async url=>{
 if(url.includes('/contests'))return page(url,{viewer:'Tester',links:[{href:contest.url,text:'Contest'}]});
 assert.match(url,/\/status/);return page(url,{viewer:'Tester',rows:[row('1'),row('2','Other')]});
 });const batch=await f.fetch_batch('Other');assert.deepEqual(batch.submissions.map(s=>s.submission_id),['2']);
 });
 test('changing logged-in account mid-sync cannot turn own history into empty success',async()=>{
 const f=new CodeforcesGroupWebFetcher(cache,http,parseGroupLinks(root+'/contests'),async url=>url.includes('/contests')?page(url,{viewer:'Tester',links:[{href:contest.url,text:'Contest'}]}):page(url,{viewer:'Other'}));
 await assert.rejects(f.fetch_batch('Tester'),{code:'AUTH_REQUIRED'});
 });

 test('group sync reaches AC records and DX entries, then saved timing appears in practice history',async()=>{
 const db=openDatabase(':memory:');try{
 const repo=new Repository(db),user=repo.createUser('Group reader',true),account=repo.addAccount(user,'codeforces','Tester');
 const f=new CodeforcesGroupWebFetcher(cache,http,[contest],async url=>page(url,{rows:[row('1'),row('2','Other')]}));
 f.fetch_problem_releases=async()=>[];f.fetch_problem_ratings=async()=>[];
 const sync=new SyncService(db,()=>f,{});const result=await sync.sync(account,{force:true});assert.equal(result[0].status,'success');assert.equal(result[0].inserted,1);
 const ac=listProblems(db,{platforms:['codeforces'],userId:user,scope:'me',status:'ac',q:null,since:null,until:null,tzOffsetMinutes:480},50,0);
 assert.equal(ac.total,1);assert.equal(ac.items[0].problem_id,'720850:A');assert.equal(ac.items[0].problem_url,contest.url+'/problem/A');
 assert.equal(listDxEntries(db,user,'codeforces').length,1);
 assert.equal(listPractice(db,user).length,0,'sync must not invent a practice duration');
 recordPractice(db,{userId:user,platform:'codeforces',problemId:'720850:A',seconds:120,outcome:'ac',practiceKind:'first',timingSource:'manual',attemptedAt:null});
 assert.equal(listPractice(db,user)[0].problem_title,'Test');assert.equal(listPractice(db,user)[0].problem_rating,null);
 assert.equal((await sync.sync(account,{force:true}))[0].inserted,0,'repeat sync must not duplicate submissions');
 }finally{db.close();}
 });

test('personal-page redirect falls back once to common status and filters the account',async()=>{
 const visits:string[]=[];const f=new CodeforcesGroupWebFetcher(cache,http,parseGroupLinks(root+'/contests'),async url=>{
 visits.push(url);if(url.includes('/contests'))return page(url,{viewer:'Tester',links:[{href:contest.url,text:'Contest'}]});
 if(url.includes('/my?'))throw new FetchError('期望 /720850/my，实际 /other/my',false,'CF_EXTENSION_READ_FAILED');
 return page(url,{viewer:'Tester',rows:[row('1'),row('2','Other')]});
 });const batch=await f.fetch_batch('Tester');assert.equal(batch.submissions.length,1);assert.equal(visits.filter(url=>url.includes('/my?')).length,1);assert.equal(visits.filter(url=>url.includes('/status?')).length,1);
});

test('one unavailable contest preserves valid records and resumes only unfinished contests',async()=>{
 const contests=[contest,{...contest,id:'710682',url:root+'/contest/710682'},{...contest,id:'710519',url:root+'/contest/710519'}];let broken=true;const visits:string[]=[];
 const f=new CodeforcesGroupWebFetcher(cache,http,contests,async url=>{visits.push(url);if(url.includes('/710682/')&&broken)throw new FetchError('page unavailable',false,'GROUP_ACCESS_FAILED');const id=url.match(/contest\/(\d+)/)![1];return page(url,{rows:[{...row(id),problem:root+'/contest/'+id+'/problem/A'}]});});
 const first=await f.fetch_batch('Tester',{mode:'backfill'});assert.equal(first.submissions.length,2);assert.equal(first.complete,false);assert.match(first.note,/群组未完成.*710682/);assert.equal(JSON.parse(first.nextCursor!).groups['710682'],1);
 broken=false;visits.length=0;const next=await f.fetch_batch('Tester',{mode:'backfill',cursor:first.nextCursor});assert.equal(next.complete,true);assert.equal(next.submissions.length,1);assert.equal(visits.length,1);assert.match(visits[0],/710682/);
});
