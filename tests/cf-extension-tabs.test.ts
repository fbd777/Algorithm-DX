import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source=readFileSync(new URL('../extensions/cf-sync/background.js',import.meta.url),'utf8');
function finder(responses:any[],polls?:string[]){
 const noop={addListener:()=>{}};
 const context={chrome:{runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},tabs:{query:async()=>responses.map((_,id)=>({id,active:id===0})),sendMessage:async(id:number)=>{polls?.push(String(id));if(responses[id] instanceof Error)throw responses[id];return responses[id];}}}};
 return runInNewContext(source+';findCfTab',context);
}
test('selects a ready logged-in tab when active CF tab has no content script',async()=>{
 const find=finder([new Error('Receiving end does not exist'),{ready:true,loggedIn:true,challenge:false}]);assert.equal((await find()).id,1);
});
test('reports missing content script, challenge and login before claiming connection',async()=>{
 await assert.rejects(finder([new Error('Receiving end')])(),/刷新 CF/);
 await assert.rejects(finder([{ready:true,loggedIn:false,challenge:true}])(),/安全验证/);
 assert.equal((await finder([{ready:true,loggedIn:false,challenge:false}])()).id,0);
 await assert.rejects(finder([{ready:false,loggedIn:false,challenge:false}])(),/加载/);
 await assert.rejects(finder([])(),/打开并登录/);
});

test('CF login and profile detection handles absolute links, queries and relative links',()=>{
 const parser=readFileSync(new URL('../extensions/cf-sync/parser.js',import.meta.url),'utf8');
 const functions=runInNewContext(parser+';({cfLoggedIn,cfProfileHandles})',{URL});
 const doc=(links:string[])=>({querySelectorAll:()=>links.map(href=>({getAttribute:()=>href}))});
 for(const href of ['/logout?session=example','https://codeforces.com/logout?session=example','//codeforces.com/logout','/logout/'])assert.equal(functions.cfLoggedIn(doc([href])),true);
 assert.equal(functions.cfLoggedIn(doc(['https://evil.test/logout','/profile/Tester'])),false);
 assert.deepEqual(Array.from(functions.cfProfileHandles(doc(['https://codeforces.com/profile/Tester?locale=en','/profile/Other','https://evil.test/profile/Fake']))),['Tester','Other']);
});
test('content script can detect login once DOM is interactive, without waiting for external resources',()=>{
 let listener:any;
 const context={URL,MutationObserver:class{observe(){} disconnect(){}},document:{addEventListener:()=>{},readyState:'interactive',title:'Codeforces',querySelector:()=>null,querySelectorAll:()=>[{getAttribute:()=> 'https://codeforces.com/logout?session=example'}]},chrome:{runtime:{id:'test',onMessage:{addListener:(fn:any)=>{listener=fn;}}}}};
 runInNewContext(readFileSync(new URL('../extensions/cf-sync/parser.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../extensions/cf-sync/reader.js',import.meta.url),'utf8'),context);
 let result:any;listener({type:'cf-ready'},{id:'test'},(r:any)=>{result=r;});assert.equal(result.ready,true);assert.equal(result.loggedIn,true);assert.equal(result.challenge,false);
});

test('header profile plus scripted Logout is recognized without a logout URL',()=>{
 const parser=readFileSync(new URL('../extensions/cf-sync/parser.js',import.meta.url),'utf8');
 const {cfLoggedIn}=runInNewContext(parser+';({cfLoggedIn})',{URL});
 const profile={getAttribute:()=>'/profile/Tester',textContent:'Tester'};
 const logout={getAttribute:()=> 'javascript:logout()',textContent:'Logout'};
 const header={querySelectorAll:()=>[profile,logout]};
 assert.equal(cfLoggedIn({querySelectorAll:()=>[profile,logout],querySelector:()=>header}),true);
 assert.equal(cfLoggedIn({querySelectorAll:()=>[profile],querySelector:()=>({querySelectorAll:()=>[profile]})}),false);
});

test('challenge detection ignores CF scripts and only recognizes challenge page identity',()=>{
 const parser=readFileSync(new URL('../extensions/cf-sync/parser.js',import.meta.url),'utf8');
 const {cfChallenge}=runInNewContext(parser+';({cfChallenge})',{URL});
 const normal={title:'Contests - Codeforces',querySelector:()=>null,documentElement:{innerHTML:'<script>var cf="cf-chl- Verify you are human Just a moment";</script>'}};
 assert.equal(cfChallenge(normal),false);
 assert.equal(cfChallenge({...normal,title:'Just a moment...'}),true);
 assert.equal(cfChallenge({...normal,querySelector:()=>({})}),true);
});

function navigationHarness(initialTabs:any[],challenge=false,missingScripts:number[]=[],recoverOnReload=true){
 const tabs=initialTabs.map(t=>({...t})),operations:any[]=[],session:any={};let next=10;
 const noop={addListener:()=>{}};
 const chrome={runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop},storage:{local:{get:async()=>({enabled:true})},session:{get:async()=>session,set:async(value:any)=>Object.assign(session,value)}},tabs:{
  query:async()=>tabs,get:async(id:number)=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t;},
  create:async(value:any)=>{operations.push(['create',value]);const tab={...value,id:next++,status:'complete'};tabs.push(tab);return tab;},
  update:async(id:number,value:any)=>{operations.push(['update',id,value]);const t=tabs.find(t=>t.id===id);Object.assign(t,value);return t;},
  reload:async(id:number)=>{operations.push(['reload',id]);if(recoverOnReload){const index=missingScripts.indexOf(id);if(index>=0)missingScripts.splice(index,1);}},
  sendMessage:async(id:number,message:any)=>{if(missingScripts.includes(id))throw Error('Could not establish connection. Receiving end does not exist.');return message.type==='cf-ready'?{ready:true,loggedIn:true,challenge}:{result:{source:'rendered-page',url:message.url,rows:[]}};}
 }};
 const read=runInNewContext(source+';readThroughTab',{chrome,URL,setTimeout:(f:any)=>{f();return 0;}});
 return {read,operations,session};
}
test('rendered reader reuses matching page without navigating user tab or sending CF HTTP requests',async()=>{
 const url='https://codeforces.com/group/abc/contests';const h=navigationHarness([{id:1,url,windowId:1,status:'complete'}]);
 const result=await h.read({url:url+'?locale=en'},{id:1,windowId:1});assert.equal(result.result.source,'rendered-page');assert.equal(h.operations.length,0);
});
test('pagination navigates only the extension-owned tab and keeps challenges available for manual handling',async()=>{
 const h=navigationHarness([{id:1,url:'https://codeforces.com/profile/Tester',windowId:1,status:'complete'}]);
 await h.read({url:'https://codeforces.com/group/abc/contests'},{id:1,windowId:1});
 await h.read({url:'https://codeforces.com/group/abc/contests/page/2'},{id:1,windowId:1});
 assert.equal(h.operations[0][0],'create');assert.equal(h.operations[1][0],'update');assert.equal(h.operations[1][1],10);
 assert.equal(h.session.readingTabId,10);
 const blocked=navigationHarness([{id:1,url:'https://codeforces.com/profile/Tester',status:'complete'}],true);
 const failure=await blocked.read({url:'https://codeforces.com/group/abc/contests'},{id:1});assert.match(failure.error,/安全验证/);assert.equal(blocked.session.readingTabId,10);assert.equal(blocked.operations.length,1);
});
test('a filtered status page is not reused for an unfiltered task',async()=>{
 const h=navigationHarness([{id:1,url:'https://codeforces.com/group/abc/contest/720850/status?my=on',status:'complete'}]);
 await h.read({url:'https://codeforces.com/group/abc/contest/720850/status?order=BY_ARRIVED_DESC'},{id:1});assert.equal(h.operations[0][0],'create');
});

 test('stale matching user tab is skipped without reloading or navigating it',async()=>{
 const url='https://codeforces.com/group/abc/contests';
 const h=navigationHarness([{id:1,url,status:'complete',windowId:1}],false,[1]);
 const result=await h.read({url},{id:1,windowId:1});
 assert.equal(result.result.source,'rendered-page');assert.equal(h.operations.length,1);assert.equal(h.operations[0][0],'create');assert.equal(h.session.readingTabId,10);
 });
 test('missing script in owned reader is recovered by a single reload',async()=>{
 const h=navigationHarness([],false,[10]);
 const result=await h.read({url:'https://codeforces.com/group/abc/contests'},{id:1,windowId:1});
 assert.equal(result.result.source,'rendered-page');assert.deepEqual(h.operations.filter(op=>op[0]==='reload'),[['reload',10]]);
 });
 test('persistent missing script stops after one reload with page-specific diagnostics',async()=>{
 const h=navigationHarness([],false,[10],false);
 await assert.rejects(h.read({url:'https://codeforces.com/group/abc/contest/720850/status/page/2'},{id:1,windowId:1}),/720850.*Receiving end/);
 assert.deepEqual(h.operations.filter(op=>op[0]==='reload'),[['reload',10]]);
 });
