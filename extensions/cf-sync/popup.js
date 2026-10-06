const $=id=>document.getElementById(id);
(async()=>{const c=await chrome.storage.local.get(['server','token','status']);$('server').value=c.server||'http://127.0.0.1:8787';$('token').value=c.token||'';$('status').textContent=c.status||'尚未连接';})();
chrome.storage.onChanged.addListener(changes=>{if(changes.status)$('status').textContent=changes.status.newValue;});
$('connect').onclick=async()=>{
 try{
  const u=new URL($('server').value.trim());
  if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('请输入本机面板地址，例如 http://127.0.0.1:8787');
  const token=$('token').value.trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('请粘贴面板生成的完整连接码');
  await chrome.storage.local.set({server:u.origin,token,enabled:true,status:'正在连接…'});await chrome.runtime.sendMessage({type:'connect'});
 }catch(error){$('status').textContent=error.message;}
};
$('disconnect').onclick=async()=>{await chrome.storage.local.set({enabled:false,status:'已断开'});};

$('show-page').onclick=()=>chrome.runtime.sendMessage({type:'show-reading-page'});
