import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CodeforcesGroupFetcher, parseGroupLinks, signedCfUrl } from '../src/fetchers/codeforces-group.ts';
const groups=parseGroupLinks('https://codeforces.com/group/0doN9wUJK1/contest/720850/standings/groupmates/true');
const cache={get:()=>undefined,set:()=>{}} as any;
const row=(id:number,contestId=720850,handle='Tester')=>({id,contestId,creationTimeSeconds:1700000000+id,problem:{contestId,index:'A',name:'Test'},author:{members:[{handle}]},verdict:'OK'});
test('Group URLs canonicalize without arbitrary hosts or duplicate contests',()=>{
 assert.equal(groups[0].url,'https://codeforces.com/group/0doN9wUJK1/contest/720850');
 assert.equal(parseGroupLinks(groups[0].url+'\n'+groups[0].url).length,1);
 assert.throws(()=>parseGroupLinks('https://example.com/group/a/contest/1'));
 assert.throws(()=>parseGroupLinks('https://codeforces.com@evil.test/group/a/contest/1'));
});
test('CF signature includes sorted parameters with a six character nonce',()=>{
 const url=signedCfUrl('contest.status',{handle:'Tester',contestId:'720850',groupCode:'0doN9wUJK1'},'key','secret',1700000000,'123456');
 const hash=createHash('sha512').update('123456/contest.status?apiKey=key&contestId=720850&groupCode=0doN9wUJK1&handle=Tester&time=1700000000#secret').digest('hex');
 assert.equal(url.searchParams.get('apiSig'),'123456'+hash);assert.ok(!url.href.includes('secret'));
});
test('Group recent sync merges public submissions and retains correct Group links',async()=>{
 const http={json:async(url:URL)=>({status:'OK',result:url.pathname.endsWith('user.status')?[row(1,123)]:[row(2)]})} as any;
 const result=await new CodeforcesGroupFetcher(cache,http,groups,'key','secret').fetch_batch('Tester');
 assert.equal(result.submissions.length,2);assert.equal(result.submissions[1].status,'AC');
 assert.equal(result.submissions[1].problem_url,groups[0].url+'/problem/A');
});
test('history resumes each source and does not repeat completed public pages',async()=>{
 let publicCalls=0;let groupCalls=0;
 const http={json:async(url:URL)=>{if(url.pathname.endsWith('user.status')){publicCalls++;return {status:'OK',result:[]};}groupCalls++;return {status:'OK',result:groupCalls===1?Array.from({length:1000},(_,i)=>row(i+1)):[]};}} as any;
 const fetcher=new CodeforcesGroupFetcher(cache,http,groups,'key','secret');
 const first=await fetcher.fetch_batch('Tester',{mode:'backfill',maxPages:1});
 assert.equal(first.complete,false);assert.equal(JSON.parse(first.nextCursor!).groups['720850'],1000);
 const second=await fetcher.fetch_batch('Tester',{mode:'backfill',maxPages:1,cursor:first.nextCursor});
 assert.equal(second.complete,true);assert.equal(publicCalls,1);
});
test('access failures never reveal secrets; unexpected users and cancellation are rejected',async()=>{
 const mock=(group:any)=>({json:async(url:URL)=>url.pathname.endsWith('user.status')?{status:'OK',result:[]}:group}) as any;
 await assert.rejects(new CodeforcesGroupFetcher(cache,mock({status:'FAILED',comment:'secret'}),groups,'key','secret').fetch_batch('Tester'),error=>!String(error).includes('secret')&&String(error).includes('720850'));
 await assert.rejects(new CodeforcesGroupFetcher(cache,mock({status:'OK',result:[row(2,720850,'Other')]}),groups,'key','secret').fetch_batch('Tester'),/不匹配/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(new CodeforcesGroupFetcher(cache,mock({status:'OK',result:[]}),groups,'key','secret').fetch_batch('Tester',{signal:controller.signal}),{name:'AbortError'});
});


test('whole Group discovery includes new contests on later sync and deduplicates overlapping links',async()=>{
 const root='https://codeforces.com/group/0doN9wUJK1';
 assert.equal(parseGroupLinks(root+'/contests')[0].url,root);
 assert.equal(parseGroupLinks(root+'/')[0].id,'');
 assert.throws(()=>parseGroupLinks(root+'/contest/nope'));
 let ids=[720850], calls:string[]=[],listCalls=0;
 const http={json:async(url:URL)=>{
   if(url.pathname.endsWith('contest.list')){listCalls++;assert.equal(url.searchParams.get('groupCode'),'0doN9wUJK1');assert.ok(url.searchParams.get('apiSig'));return {status:'OK',result:ids.map(id=>({id}))};}
   if(url.pathname.endsWith('user.status'))return {status:'OK',result:[]};
   assert.equal(url.searchParams.get('groupCode'),'0doN9wUJK1');const id=url.searchParams.get('contestId')!;calls.push(id);return {status:'OK',result:[row(Number(id),Number(id))]};
 }} as any;
 const fetcher=new CodeforcesGroupFetcher(cache,http,parseGroupLinks(root+' '+root+'/contest/720850'),'key','secret');
 const first=await fetcher.fetch_batch('Tester');assert.equal(first.submissions.length,1);assert.deepEqual(calls,['720850']);
 ids.push(720851);calls=[];
 const next=await fetcher.fetch_batch('Tester');assert.equal(next.submissions.length,2);assert.deepEqual(calls,['720851','720850']);assert.equal(listCalls,4);
 assert.equal(next.submissions[0].problem_url,root+'/contest/720851/problem/A');
});
test('Group discovery failure is not mistaken for empty successful history',async()=>{
 const http={json:async()=>({status:'FAILED',comment:'sensitive data'})} as any;
 await assert.rejects(new CodeforcesGroupFetcher(cache,http,parseGroupLinks('https://codeforces.com/group/abc'),'key','secret').fetch_batch('Tester'),/比赛列表不可访问/);
});
test('new Group contests join an unfinished history cursor while completed contests stay complete',async()=>{
 const called:string[]=[];
 const http={json:async(url:URL)=>{
  if(url.pathname.endsWith('contest.list'))return {status:'OK',result:[{id:720850},{id:720851}]};
  called.push(url.searchParams.get('contestId')!);return {status:'OK',result:[]};
 }} as any;
 const result=await new CodeforcesGroupFetcher(cache,http,parseGroupLinks('https://codeforces.com/group/abc'),'key','secret').fetch_batch('Tester',{mode:'backfill',cursor:JSON.stringify({version:1,public:null,groups:{720850:null}})});
 assert.deepEqual(called,['720851']);assert.equal(result.complete,true);
});

 test('HTTP 400 contest-not-found explains visibility without exposing signed request secrets',async()=>{
 const http={json:async()=>({status:'OK',result:[]}),peek:async()=>({status:400,text:JSON.stringify({status:'FAILED',comment:'contestId: Contest with id 720850 not found'})})} as any;
 await assert.rejects(new CodeforcesGroupFetcher(cache,http,groups,'key','secret').fetch_batch('Tester'),error=>String(error).includes('CF API 返回找不到比赛 720850')&&!String(error).includes('secret'));
});
