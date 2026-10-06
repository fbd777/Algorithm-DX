import test from 'node:test';
import assert from 'node:assert/strict';
import { CfExtensionBridge, validExtensionToken } from '../src/fetchers/cf-extension.ts';
const url='https://codeforces.com/group/abc/contests?locale=en';
const snapshot={url,status:200,loggedIn:true,challenge:false,links:[],rows:[]};
test('extension tokens reject absent, wrong and non-ASCII input',()=>{
 const token='a'.repeat(64);assert.ok(validExtensionToken(token,token));
 for(const bad of [undefined,'', 'b'.repeat(64),'好'.repeat(64)])assert.equal(validExtensionToken(token,bad),false);
});
test('bridge transfers only allowed page tasks and accepts a result once',async()=>{
 const b=new CfExtensionBridge();await assert.rejects(async()=>b.read(url,''),/尚未连接/);
 b.lastSeen=Date.now();assert.throws(()=>b.read('https://evil.test/', ''));
 const result=b.read(url,'');const task=await b.poll();assert.equal(task?.url,url);
 assert.equal(b.complete(task!.id,snapshot),true);assert.deepEqual(await result,snapshot);assert.equal(b.complete(task!.id,snapshot),false);
});
test('cancelled, failed and malformed replies never produce successful empty records',async()=>{
 const b=new CfExtensionBridge();b.lastSeen=Date.now();
 const c=new AbortController();const cancelled=b.read(url,'',c.signal);const check=assert.rejects(cancelled,{name:'AbortError'});c.abort();await check;assert.equal(b.pending.size,0);
 for(const reply of [{...snapshot,url:'https://evil.test/'},{...snapshot,rows:[{}]}]){
  const r=b.read(url,'');const task=await b.poll();b.complete(task!.id,reply);await assert.rejects(r,/格式异常/);
 }
 const r=b.read(url,'');const task=await b.poll();b.complete(task!.id,null,'请登录');await assert.rejects(r,/请登录/);
});
test('pending poll wakes for a new task and rotating pairing cancels outstanding requests',async()=>{
 const b=new CfExtensionBridge();const poll=b.poll();const r=b.read(url,'');const task=await poll;assert.ok(task);
 const rejected=assert.rejects(r,/连接码已更新/);b.reset();await rejected;assert.equal(b.lastSeen,0);
});
