function validCfTask(value){
 try{const u=new URL(value);return u.origin==='https://codeforces.com'&&!u.username&&!u.password&&/^\/group\/[A-Za-z0-9]+\/(?:contests(?:\/page\/\d+)?|contest\/\d+\/(?:status|my)(?:\/page\/\d+)?)$/.test(u.pathname);}catch{return false;}
}
// Capture server-rendered dates while HTML is being parsed, before CF's DOM-ready
// formatter converts them to the visitor's local time. Never guess a timezone.
const cfOriginalTimes=new WeakMap();
const cfRowTimes=new WeakMap();
function rememberCfTime(element){
 if(document.readyState!=='loading'||!element?.matches?.('.format-time')||cfOriginalTimes.has(element))return;
 const value=(element.textContent||'').trim().replace(/\s+/g,' ');
 if(/^[A-Za-z]{3}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(value)){cfOriginalTimes.set(element,value);const row=element.closest('tr[data-submission-id]');if(row)cfRowTimes.set(row,value);}
}
function rememberCfTree(root){
 if(root?.nodeType===3){rememberCfTime(root.parentElement?.closest('.format-time'));return;}
 rememberCfTime(root);root?.querySelectorAll?.('.format-time').forEach(rememberCfTime);
}
const timeObserver=new MutationObserver(records=>{
 for(const record of records){rememberCfTree(record.target);for(const node of record.addedNodes||[])rememberCfTree(node);}
});
timeObserver.observe(document,{subtree:true,childList:true,characterData:true});rememberCfTree(document);
document.addEventListener('DOMContentLoaded',()=>{timeObserver.disconnect();},{once:true});
function sameCfPage(actual,requested){
 try{const a=new URL(actual),b=new URL(requested);return a.origin===b.origin&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'')&&Array.from(a.searchParams.keys()).every(k=>k==='locale'||k==='order'||a.searchParams.get(k)===b.searchParams.get(k))&&(!a.searchParams.has('order')||a.searchParams.get('order')===(b.searchParams.get('order')||'BY_ARRIVED_DESC'));}catch{return false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return;
 if(message?.type==='cf-ready'){
  reply({actualUrl:location.href,ready:document.readyState!=='loading',challenge:cfChallenge(document),loggedIn:cfLoggedIn(document)});return;
 }
 if(message?.type!=='read-cf-group')return;
 try{
  if(!validCfTask(message.url))throw Error('群组页面地址无效');
  if(!sameCfPage(location.href,message.url))throw Error('浏览器尚未打开本次请求的群组页面');
  if(cfChallenge(document))throw Error('当前标签页正在安全验证，已停止读取。点击扩展「打开读取页面」，手动完成验证后重新连接');
  if(document.readyState==='loading')throw Error('群组页面尚未加载完成');
  // Read the actual document. No fetch/XHR, cookie export or extra CF HTTP request.
  const result=parseCfDocument(document,message.url,200,row=>cfRowTimes.get(row));
  result.source='rendered-page';result.actualUrl=location.href;
  if(!result.contestTable&&!result.statusTable)throw Error('未识别到比赛/提交表格（'+String(document.title).slice(0,70)+'；'+location.pathname+'）。请打开读取页面确认内容');
  reply({result});
 }catch(error){reply({error:String(error.message||'CF 页面读取失败')});}
});
