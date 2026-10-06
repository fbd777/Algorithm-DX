import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Cdp} from '../src/fetchers/cf-browser.ts';
test('real Edge rendered-page extraction works without fetch and preserves original times', {skip:!existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),timeout:20000},async()=>{
const dir=mkdtempSync(join(tmpdir(),'cf-rendered-test-'));
const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+dir,'--no-first-run','about:blank'],{stdio:'ignore',windowsHide:true});
let cdp;
try{
 for(let i=0;i<40;i++){await sleep(250);try{const [port,path]=readFileSync(join(dir,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);cdp=await Cdp.connect('ws://127.0.0.1:'+port+path);break;}catch{}}
 assert.ok(cdp);
 const {targetId}=await cdp.call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await cdp.call('Target.attachToTarget',{targetId,flatten:true});
 const url='https://codeforces.com/group/abc/contest/720850/status?locale=en&order=BY_ARRIVED_DESC';
 let challenge=false,requests=0;
 const normal='<html><head><title>Status - Codeforces</title></head><body><div id="header"><a href="/profile/Tester">Tester</a><a href="javascript:logout()">Logout</a></div><table class="status-frame-datatable"><tr data-submission-id="123"><td>123</td><td><span class="format-time">Oct/03/2026 08:12</span></td><td><a href="/profile/Tester">Tester</a></td><td><a href="/group/abc/contest/720850/problem/A">A - Test</a></td><td>C++</td><td><span submissionverdict="OK">Accepted</span></td><td>15 ms</td><td>256 KB</td></tr></table><script>document.addEventListener("DOMContentLoaded",()=>{const e=document.querySelector(".format-time");e.textContent="Oct/03/2026 13:12";e.className="formatted-time";});</script></body></html>';
 cdp.socket.addEventListener('message',async e=>{const m=JSON.parse(String(e.data));if(m.method==='Fetch.requestPaused'){
  requests++;
  await cdp.call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:challenge?403:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(challenge?'<html><head><title>Just a moment...</title></head><body id="challenge-stage">Verify you are human</body></html>':normal).toString('base64')},sessionId);
 }});
 await cdp.call('Page.enable',{},sessionId);
 await cdp.call('Runtime.enable',{},sessionId);
 cdp.socket.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.method==='Runtime.exceptionThrown')console.log(JSON.stringify(m.params.exceptionDetails));});
 await cdp.call('Fetch.enable',{patterns:[{urlPattern:'*'}]},sessionId);
 const scripts=readFileSync(new URL('../extensions/cf-sync/parser.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../extensions/cf-sync/reader.js',import.meta.url),'utf8');
 await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:'globalThis.chrome={runtime:{id:"test",onMessage:{addListener:f=>globalThis.listener=f}}};globalThis.fetch=()=>{throw Error("fetch must not run")};'+scripts},sessionId);
 await cdp.call('Page.navigate',{url},sessionId);await sleep(1000);
 const read=()=>cdp.call('Runtime.evaluate',{expression:'new Promise(resolve=>listener({type:"read-cf-group",url:'+JSON.stringify(url)+'},{id:"test"},resolve))',returnByValue:true,awaitPromise:true},sessionId);
 let result=await read();assert.equal(result.exceptionDetails,undefined);assert.equal(result.result.value.error,undefined,JSON.stringify(result.result.value));
 assert.equal(result.result.value.result.rows[0].time,'Oct/03/2026 08:12');assert.equal(result.result.value.result.source,'rendered-page');
 const displayed=await cdp.call('Runtime.evaluate',{expression:'document.querySelector(".formatted-time").textContent',returnByValue:true},sessionId);assert.equal(displayed.result.value,'Oct/03/2026 13:12');
 const before=requests;await read();assert.equal(requests,before,'DOM read must not issue any HTTP requests');
 const groupFixture='<html><head><title>Contests - Codeforces</title></head><body><div class="datatable"><table><tr><td><a href="/group/abc/contest/720850">Enter</a></td></tr></table></div></body></html>';
 const groupResult=await cdp.call('Runtime.evaluate',{expression:'parseCfHtml('+JSON.stringify(groupFixture)+',"https://codeforces.com/group/abc/contests",200)',returnByValue:true},sessionId);assert.equal(groupResult.result.value.contestTable,true);
 challenge=true;await cdp.call('Page.navigate',{url},sessionId);await sleep(500);result=await read();assert.match(result.result.value.error,/安全验证/);assert.equal(result.result.value.result,undefined);
 console.log('PASS: Edge document_start extraction; fetch disabled; local-time transformation preserves original timestamp; challenge page rejected without network retries');
}finally{if(cdp){try{await cdp.call('Browser.close');}catch{}cdp.close();}else child.kill();}

});
