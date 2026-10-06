import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Cdp} from '../src/fetchers/cf-browser.ts';

test('Group dialog checks connection and saves before starting account history in real Edge',{skip:!existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cf-group-ui-'));
 const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+dir,'--no-first-run','about:blank'],{stdio:'ignore',windowsHide:true});let cdp;
 try{
 for(let i=0;i<40;i++){await sleep(250);try{const [port,path]=readFileSync(join(dir,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);cdp=await Cdp.connect('ws://127.0.0.1:'+port+path);break;}catch{}}
 assert.ok(cdp);const {targetId}=await cdp.call('Target.createTarget',{url:'about:blank'});const {sessionId}=await cdp.call('Target.attachToTarget',{targetId,flatten:true});
 const writes:any[]=[];let connected=false;
 cdp.socket.addEventListener('message',async event=>{const message=JSON.parse(String(event.data));if(message.method!=='Fetch.requestPaused')return;
 const request=message.params.request,url=new URL(request.url);let body='',type='application/json';
 if(url.pathname==='/'){type='text/html';body='<html><body></body></html>';}
 else if(url.pathname==='/cf-groups.js'){type='text/javascript';body=readFileSync(new URL('../public/cf-groups.js',import.meta.url),'utf8');}
 else if(url.pathname==='/api/cf-extension/status')body=JSON.stringify({connected,pending:[],lastPage:null});
 else{if(request.method==='POST')writes.push({path:url.pathname,body:JSON.parse(request.postData||'{}')});body=JSON.stringify(url.pathname.endsWith('cf-groups')?{groups:['https://codeforces.com/group/abc/contests']}:{job:{id:1,running:true}});}
 await cdp!.call('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:type}],body:Buffer.from(body).toString('base64')},sessionId);
 });
 await cdp.call('Fetch.enable',{patterns:[{urlPattern:'*'}]},sessionId);await cdp.call('Page.navigate',{url:'http://127.0.0.1:9999/'},sessionId);await sleep(200);
 const evaluate=async(expression:string)=>{const result=await cdp!.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));return result.result.value;};
 await evaluate("import('/cf-groups.js').then(m=>m.openCfGroups({id:1,handle:'Tester',cfGroups:['https://codeforces.com/group/abc/contests']},async()=>{}))");await sleep(200);
 assert.match(await evaluate("document.querySelector('.extension-status').textContent"),/未连接/);
 await evaluate("document.querySelector('.extension-sync').click()");await sleep(200);assert.equal(writes.length,0);
 connected=true;await evaluate("document.querySelector('.extension-check').click()");await sleep(100);
 await evaluate("document.querySelector('.extension-sync').click()");await sleep(300);
 assert.deepEqual(writes.map(w=>w.path),['/api/accounts/cf-groups','/api/sync']);assert.equal(writes[1].body.accountId,1);assert.equal(writes[1].body.mode,'backfill');
 assert.match(await evaluate("document.querySelector('.cf-dialog-status').textContent"),/已开始/);
 await evaluate("document.querySelector('.close').click()");assert.equal(await evaluate("document.querySelector('dialog')===null"),true);
 }finally{if(cdp){try{await cdp.call('Browser.close');}catch{}cdp.close();}else child.kill();}
});
