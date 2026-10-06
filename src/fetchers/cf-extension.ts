import { randomUUID, timingSafeEqual } from 'node:crypto';
import { FetchError } from './base.ts';
import { validateCfPageUrl } from './cf-browser.ts';
import type { PageSnapshot } from './codeforces-group-web.ts';
export function validExtensionToken(expected:string|undefined,provided:string|undefined):boolean{
 if(!expected||!provided||!(/^[a-f0-9]{64}$/.test(expected))||!(/^[a-f0-9]{64}$/.test(provided)))return false;
 return timingSafeEqual(Buffer.from(expected),Buffer.from(provided));
}
type Pending={id:string;url:string;leasedAt:number;resolve:(value:PageSnapshot)=>void;reject:(error:Error)=>void;cleanup:()=>void};
export class CfExtensionBridge{
 version:string|null=null;
 private lastPage:{url:string;state:string;rows:number;at:number;message?:string}|null=null;
 private pagesRead=0;
 status(){return {version:this.version,connected:this.lastSeen>0&&Date.now()-this.lastSeen<60000,lastSeen:this.lastSeen||null,pending:[...this.pending.values()].map(p=>({url:p.url,reading:Boolean(p.leasedAt)})),pagesRead:this.pagesRead,lastPage:this.lastPage};}
 pending=new Map<string,Pending>();lastSeen=0;wake:(()=>void)|undefined;
 async poll(signal?:AbortSignal):Promise<{id:string;url:string}|null>{
  this.lastSeen=Date.now();
  const take=()=>{for(const item of this.pending.values())if(!item.leasedAt||Date.now()-item.leasedAt>30000){item.leasedAt=Date.now();return {id:item.id,url:item.url};}return null;};
  const task=take();if(task)return task;
  await new Promise<void>(resolve=>{
   const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);if(this.wake===finish)this.wake=undefined;resolve();};
   const timer=setTimeout(finish,15000);this.wake?.();this.wake=finish;
   signal?.addEventListener('abort',finish,{once:true});if(signal?.aborted)finish();
  });
  this.lastSeen=Date.now();return signal?.aborted?null:take();
 }
 read(url:string,_expression:string,signal?:AbortSignal):Promise<PageSnapshot>{
  validateCfPageUrl(url);signal?.throwIfAborted();
  if(/\/problem\//.test(new URL(url).pathname)&&(!this.version||Number(this.version.split('.')[0])*100+Number(this.version.split('.')[1])<6))throw new FetchError('请重新加载 CF 扩展到 0.6.0 或更新版本后连接，以读取题面核对原题',false,'CF_EXTENSION_UPDATE_REQUIRED');
  if(Date.now()-this.lastSeen>60000)throw new FetchError('Edge 扩展尚未连接。请在普通 Edge 中打开 Algorithm DX 扩展并连接面板，同时保持一个已登录的 CF 标签页',false,'CF_EXTENSION_REQUIRED');
  return new Promise((resolve,reject)=>{
   const id=randomUUID();
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(id);};
   const abort=()=>{cleanup();reject(signal?.reason??new Error('已取消'));};
   const timer=setTimeout(()=>{this.lastPage={url,state:'failed',rows:0,at:Date.now(),message:'页面读取超时'};cleanup();reject(new FetchError('Edge 扩展读取超时，请检查扩展连接和 CF 标签页',false,'CF_EXTENSION_TIMEOUT'));},60000);
   this.pending.set(id,{id,url,leasedAt:0,resolve,reject,cleanup});
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else this.wake?.();
  });
 }
 complete(id:string,result:any,error?:string):boolean{
  const task=this.pending.get(id);if(!task)return false;
  task.cleanup();
  if(error){this.lastPage={url:task.url,state:'failed',rows:0,at:Date.now(),message:String(error).slice(0,300)};task.reject(new FetchError('Edge 扩展：'+String(error).slice(0,300),false,'CF_EXTENSION_READ_FAILED'));return true;}
  // Extension output is untrusted: validate before the existing parser consumes it.
  if(!result||result.url!==task.url||!Number.isInteger(result.status)||typeof result.loggedIn!=='boolean'||typeof result.challenge!=='boolean'||!Array.isArray(result.links)||!Array.isArray(result.rows)||result.links.length>20000||result.rows.length>5000){task.reject(new FetchError('Edge 扩展返回的数据格式异常',false,'SCHEMA_CHANGED'));return true;}
  if(result.links.some((l:any)=>typeof l?.href!=='string')||result.rows.some((r:any)=>!r||!Array.isArray(r.handles)||r.handles.some((h:any)=>typeof h!=='string')||['id','problem','title','time','verdict','verdictText','language','execution','memory'].some(k=>typeof r[k]!=='string'))){task.reject(new FetchError('Edge 扩展返回的记录格式异常',false,'SCHEMA_CHANGED'));return true;}
  if(result.problem!=null){const p=result.problem;if(!p||['title','statement','timeLimit','memoryLimit'].some(k=>typeof p[k]!=='string'||p[k].length>200000)||!Array.isArray(p.samples)||p.samples.length>100||p.samples.some((s:any)=>!s||typeof s.input!=='string'||typeof s.output!=='string'||s.input.length+s.output.length>100000)||!Array.isArray(p.sourceLinks)||p.sourceLinks.length>500||p.sourceLinks.some((s:any)=>typeof s!=='string'||s.length>2000)||(p.rating!=null&&(!Number.isSafeInteger(p.rating)||p.rating<=0||p.rating>100000))||(p.tags!=null&&(!Array.isArray(p.tags)||p.tags.length>100||p.tags.some((s:any)=>typeof s!=='string'||s.length>200)))){task.reject(new FetchError('Edge 扩展返回的题面格式异常',false,'SCHEMA_CHANGED'));return true;}}
  this.pagesRead++;this.lastPage={url:task.url,state:'read',rows:result.rows.length,at:Date.now()};
  task.resolve(result);return true;
 }
 reset(){this.lastPage=null;this.pagesRead=0;for(const task of this.pending.values()){task.cleanup();task.reject(new FetchError('扩展连接码已更新，请重新连接',false,'CF_EXTENSION_REQUIRED'));}this.lastSeen=0;this.wake?.();}
}
export const cfExtensionBridge=new CfExtensionBridge();
