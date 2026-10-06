import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { FetchError } from './base.ts';

const profile = () => resolve('data/cf-browser');
const unavailable = () => new FetchError('请在「CF 自建比赛」点击「打开 CF 登录窗口」，登录后保持该窗口开启再同步',false,'CF_BROWSER_REQUIRED');

export class Cdp {
  socket: WebSocket; next=0;
  pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(socket:WebSocket){
    this.socket=socket;
    socket.addEventListener('message',event=>{
      let message:any;try{message=JSON.parse(String(event.data));}catch{return;}
      const job=this.pending.get(message.id);if(!job)return;
      clearTimeout(job.timer);this.pending.delete(message.id);
      if(message.error)job.reject(new Error('浏览器读取失败，请重新打开 CF 登录窗口'));else job.resolve(message.result);
    });
    socket.addEventListener('close',()=>this.fail());
    socket.addEventListener('error',()=>this.fail());
  }
  fail(){for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(unavailable());}this.pending.clear();}
  static async connect(url:string){
    const socket=new WebSocket(url);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.close();reject(unavailable());},5000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(unavailable());},{once:true});
    });
    return new Cdp(socket);
  }
  call(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<any>{
    return new Promise((resolve,reject)=>{
      const id=++this.next;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('浏览器响应超时，请检查 CF 登录窗口'));},15000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}
      catch{clearTimeout(timer);this.pending.delete(id);reject(unavailable());}
    });
  }
  close(){this.fail();this.socket.close();}
}
async function connectBrowser(){
  try{
    const [port,path]=readFileSync(join(profile(),'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);
    if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path))throw Error();
    return await Cdp.connect('ws://127.0.0.1:'+port+path);
  }catch{throw unavailable();}
}
let opening:Promise<void>|undefined;
/** Only the explicit login button launches an interactive browser. Never reads the user's normal profile. */
export async function openCfBrowser(executableOverride?:string):Promise<void>{
  if(opening)return opening;
  opening=(async()=>{
    try{const cdp=await connectBrowser();try{
      const {targetInfos}=await cdp.call('Target.getTargets');
      const existing=targetInfos.find((t:any)=>t.type==='page'&&/^https:\/\/codeforces\.com(?:\/|$)/.test(t.url));
      if(existing)await cdp.call('Target.activateTarget',{targetId:existing.targetId});
      else await cdp.call('Target.createTarget',{url:'https://codeforces.com/enter?locale=en'});
    }finally{cdp.close();}return;}catch{}
    const candidates=[executableOverride,process.env.ALGORITHM_DX_CF_BROWSER_EXECUTABLE,
      process.env['ProgramFiles(x86)']&&join(process.env['ProgramFiles(x86)']!,'Microsoft/Edge/Application/msedge.exe'),
      process.env.ProgramFiles&&join(process.env.ProgramFiles,'Microsoft/Edge/Application/msedge.exe'),
      process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Microsoft/Edge/Application/msedge.exe'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/microsoft-edge','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
    const executable=candidates.find((p):p is string=>Boolean(p&&existsSync(p)));
    if(!executable)throw new Error('未找到 Edge / Chrome。请安装浏览器，或在 .env 设置 ALGORITHM_DX_CF_BROWSER_EXECUTABLE 为浏览器可执行文件路径');
    mkdirSync(profile(),{recursive:true});
    const child=spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile(),'--no-first-run','--no-default-browser-check','https://codeforces.com/enter?locale=en'],{detached:true,stdio:'ignore',windowsHide:true});
    let failed=false;child.on('error',()=>{failed=true;});child.unref();
    for(let i=0;i<30;i++){
      if(failed)break;
      await sleep(500);
      try{const cdp=await connectBrowser();cdp.close();return;}catch{}
    }
    throw new Error('CF 登录窗口启动失败；请关闭之前的专用窗口后重试');
  })();
  try{await opening;}finally{opening=undefined;}
}
export function validateCfPageUrl(value:string):URL{
  const url=new URL(value);
  if(url.origin!=='https://codeforces.com'||url.username||url.password||!/^(?:\/group\/[A-Za-z0-9]+\/(?:(?:contests|status)(?:\/page\/\d+)?|contest\/\d+\/(?:(?:status|my)(?:\/page\/\d+)?|problem\/[A-Za-z0-9]+))|\/problemset\/problem\/\d+\/[A-Za-z0-9]+|\/(?:contest|gym)\/\d+\/problem\/[A-Za-z0-9]+)$/.test(url.pathname))throw new Error('无效的 CF 群组或原题页面');
  return url;
}

export const CF_LOGIN_STATE = String.raw`(()=>({
 ready:document.readyState,
 challenge:/Just a moment|Checking your browser|Verify you are human|安全验证|正在验证/i.test(document.title)||Boolean(document.querySelector('#challenge-running,#challenge-stage')),
 loggedIn:Array.from(document.querySelectorAll('a[href]')).some(a=>/^\/logout(?:[?/#]|$)/.test(a.getAttribute('href')))
}))()`;
export function requireCfReady(states:{ready:string;challenge:boolean;loggedIn:boolean}[]):void{
 if(states.some(s=>s.challenge))throw new FetchError('CF 安全验证尚未完成，已停止网页请求。请在专用窗口手动完成验证；若一直加载，请先确认普通 Edge 能正常访问 CF',false,'CF_BROWSER_CHALLENGE');
 if(states.some(s=>s.ready!=='complete'))throw new FetchError('CF 页面仍在加载，已暂停网页抓取；请在专用窗口确认页面加载完成后重试',false,'CF_BROWSER_LOADING');
 if(!states.some(s=>s.ready==='complete'&&s.loggedIn))throw new FetchError('请先在专用 CF 窗口完成登录并打开群组页面，再同步；登录前不会发起网页抓取',false,'AUTH_REQUIRED');
}
async function checkLogin(cdp:Cdp){
 const {targetInfos}=await cdp.call('Target.getTargets');
 const states=[];
 for(const target of targetInfos.filter((t:any)=>t.type==='page'&&/^https:\/\/codeforces\.com(?:\/|$)/.test(t.url)).slice(0,10)){
  const {sessionId}=await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  try{
   const result=await cdp.call('Runtime.evaluate',{expression:CF_LOGIN_STATE,returnByValue:true},sessionId);
   if(result.result?.value)states.push(result.result.value);
  }finally{await cdp.call('Target.detachFromTarget',{sessionId}).catch(()=>{});}
 }
 requireCfReady(states);
}

let queue:Promise<unknown>=Promise.resolve(),nextRequest=0;
/** Each read has its own background tab, leaving the login tab untouched. */
export async function readCfPage(url:string,expression:string,signal?:AbortSignal):Promise<any>{
  validateCfPageUrl(url);
  const job=queue.catch(()=>{}).then(async()=>{
    signal?.throwIfAborted();
    await sleep(Math.max(0,nextRequest-Date.now()),undefined,{signal});nextRequest=Date.now()+2100;
    const cdp=await connectBrowser();let targetId:string|undefined;let preservePage=false;
    const abort=()=>cdp.close();signal?.addEventListener('abort',abort,{once:true});
    try{
      signal?.throwIfAborted();
      await checkLogin(cdp);
      targetId=(await cdp.call('Target.createTarget',{url:'about:blank',background:true})).targetId;
      const {sessionId}=await cdp.call('Target.attachToTarget',{targetId,flatten:true});
      await cdp.call('Page.enable',{},sessionId);
      const navigation=await cdp.call('Page.navigate',{url},sessionId);
      if(navigation.errorText)throw new Error('CF 网页无法访问，请检查网络');
      for(let i=0;i<40;i++){
        signal?.throwIfAborted();
        const state=await cdp.call('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,ready:document.readyState})',returnByValue:true},sessionId);
        const current=JSON.parse(state.result.value??'{}');
        if(current.url!=='about:blank'&&current.ready==='complete'){
          if(new URL(current.url).origin!=='https://codeforces.com')throw new Error('CF 页面跳转异常');
          const login=await cdp.call('Runtime.evaluate',{expression:CF_LOGIN_STATE,returnByValue:true},sessionId);
          if(login.result?.value?.challenge){preservePage=true;requireCfReady([login.result.value]);}
          if(!login.result?.value?.loggedIn){preservePage=true;requireCfReady([]);}
          const result=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
          if(result.exceptionDetails||!result.result?.value)throw new Error('CF 网页结构无法识别');
          if(result.result.value.challenge){preservePage=true;requireCfReady([{ready:'complete',challenge:true,loggedIn:false}]);}
          return result.result.value;
        }
        await sleep(500,undefined,{signal});
      }
      preservePage=true;throw new Error('CF 页面加载超时，已保留标签页并停止请求；请在专用窗口检查网络或验证状态后重试');
    }catch(error){signal?.throwIfAborted();throw error;}
    finally{
      signal?.removeEventListener('abort',abort);
      if(targetId&&!preservePage){
        // An aborted socket cannot close its tab; reconnect only for cleanup.
        try{if(cdp.socket.readyState===WebSocket.OPEN)await cdp.call('Target.closeTarget',{targetId});
          else{const cleanup=await connectBrowser();try{await cleanup.call('Target.closeTarget',{targetId});}finally{cleanup.close();}}}catch{}
      }
      cdp.close();
    }
  });
  queue=job;return job;
}
