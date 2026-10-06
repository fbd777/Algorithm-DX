let running=false;
function configValid(config){try{const u=new URL(config.server);return u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash&&/^[a-f0-9]{64}$/.test(config.token);}catch{return false;}}
async function status(text){await chrome.storage.local.set({status:text});}
async function post(config,path,body){
 const response=await fetch(config.server.replace(/\/$/,'')+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.token},body:JSON.stringify(body),signal:AbortSignal.timeout(22000)});
 if(!response.ok)throw Error(response.status===401?'连接码无效，请在面板重新生成并粘贴':'面板暂时不可用，请确认已启动');
 return response.json();
}
async function findCfTab(){
 const tabs=await chrome.tabs.query({url:'https://codeforces.com/*'});
 if(!tabs.length)throw Error('请在普通 Edge 打开并登录 CF，然后重新连接');
 let received=false,challenge=false,loading=false,fallback=null;
 for(const tab of [...tabs].sort((a,b)=>Number(b.active)-Number(a.active))){
  try{
   const response=await chrome.tabs.sendMessage(tab.id,{type:'cf-ready'});
   if(!response)continue;received=true;challenge ||= response.challenge;loading ||= !response.ready;
   if(response.ready&&!response.challenge){if(response.loggedIn)return tab;fallback ||= tab;}
  }catch{}
 }
 if(fallback)return fallback;
 if(!received)throw Error('CF 页面尚未加载扩展：请刷新 CF 标签页，再点击连接');
 if(challenge)throw Error('CF 页面尚在安全验证，请手动完成后再连接');
 if(loading)throw Error('CF 页面内容尚未加载，请等待页面出现后重新连接');
 throw Error('未识别到 CF 登录状态，请确认右上角显示用户名和 Logout，再刷新页面并连接');
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sameTaskPage(actual,requested){
 try{const a=new URL(actual),b=new URL(requested);return a.origin===b.origin&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'')&&Array.from(a.searchParams.keys()).every(k=>k==='locale'||k==='order'||a.searchParams.get(k)===b.searchParams.get(k))&&(!a.searchParams.has('order')||a.searchParams.get('order')===(b.searchParams.get('order')||'BY_ARRIVED_DESC'));}catch{return false;}
}
async function readThroughTab(task,anchor){
 // Prefer an already-open matching page. Never navigate a user's own tab.
 const tabs=await chrome.tabs.query({url:'https://codeforces.com/*'});
 let tab;
 // Reloading the extension invalidates scripts in existing tabs. URL alone is insufficient.
 for(const candidate of tabs.filter(t=>t.status!=='loading'&&sameTaskPage(t.url,task.url))){
  try{const ready=await chrome.tabs.sendMessage(candidate.id,{type:'cf-ready'});if(ready?.ready){tab=candidate;break;}}catch{}
 }
 if(!tab){
  const saved=await chrome.storage.session.get('workerTabId');
  if(saved.workerTabId){try{const old=await chrome.tabs.get(saved.workerTabId);if(/^https:\/\/codeforces\.com\//.test(old.url||''))tab=old;}catch{}}
  await pause(2100);
  if(tab)tab=await chrome.tabs.update(tab.id,{url:task.url});
  else {tab=await chrome.tabs.create({url:task.url,active:false,windowId:anchor.windowId});await chrome.storage.session.set({workerTabId:tab.id});}
 }
 await chrome.storage.session.set({readingTabId:tab.id});
 let lastError='',recovered=false;
 for(let i=0;i<50;i++){
  if(!(await chrome.storage.local.get('enabled')).enabled)throw Error('扩展已断开');
  const current=await chrome.tabs.get(tab.id);
  if(current.status!=='loading'){
   try{
    const ready=await chrome.tabs.sendMessage(tab.id,{type:'cf-ready'});
    if(ready?.challenge)return {error:'浏览器读取页面出现安全验证。点击扩展「打开读取页面」手动完成后重连；没有再次发起 fetch 请求'};
    if(ready?.ready){
     if(!sameTaskPage(current.url,task.url))return {error:'CF 跳转到了其他页面，请打开读取页面确认登录或比赛权限'};
     return await chrome.tabs.sendMessage(tab.id,{type:'read-cf-group',url:task.url});
    }
   }catch(error){
    lastError=String(error.message||error);
    // Recreate document_start scripts only in our own reader tab; preserve the user's tabs.
    // Never reload a detected challenge or retry a parser error.
    if(/Receiving end does not exist|Could not establish connection/i.test(lastError)&&!recovered&&i>=5){
     const saved=await chrome.storage.session.get('workerTabId');
     if(saved.workerTabId===tab.id){recovered=true;await chrome.tabs.reload(tab.id);}
    }
   }
  }
  await pause(400);
 }
 throw Error('群组读取页未响应（'+new URL(task.url).pathname+'；'+(lastError||'页面尚未就绪')+'）。已保留页面，请点击「打开读取页面」检查扩展的网站访问权限');
}
async function start(){
 if(running)return;running=true;
 try{
  for(;;){
   const config=await chrome.storage.local.get(['server','token','enabled']);if(!config.enabled||!configValid(config))break;
   let tab;try{tab=await findCfTab();}catch(error){await chrome.storage.local.set({enabled:false});await status(error.message);break;}
   let task;
   try{({task}=await post(config,'/api/cf-extension/poll',{}));}catch(error){await status(error.message||'连接中断');break;}
   if(!(await chrome.storage.local.get('enabled')).enabled)break;
   if(!task){await status('已连接，等待同步');continue;}
   let payload;
   try{
    tab=await findCfTab();
    await status('正在读取 CF 群组记录…');
    payload=await readThroughTab(task,tab);
    if(!payload)throw Error('页面未响应，请刷新 CF 标签页后重连');
   }catch(error){payload={error:error.message||'CF 标签页不可用'};}
   try{await post(config,'/api/cf-extension/result',{id:task.id,...payload});}catch(error){await status(error.message);break;}
   if(payload.error){await chrome.storage.local.set({enabled:false});await status(payload.error);break;}
   await status('已读取，等待下一页');
  }
 }finally{running=false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return;
 if(message?.type==='show-reading-page'){chrome.storage.session.get('readingTabId').then(async saved=>{if(saved.readingTabId)await chrome.tabs.update(saved.readingTabId,{active:true});}).catch(()=>{});reply({opened:true});return;}
 if(message?.type!=='connect')return;
 chrome.alarms.create('cf-sync',{periodInMinutes:0.5});start();reply({started:true});
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='cf-sync')start();});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create('cf-sync',{periodInMinutes:0.5});start();});
chrome.runtime.onInstalled.addListener(()=>chrome.alarms.create('cf-sync',{periodInMinutes:0.5}));
