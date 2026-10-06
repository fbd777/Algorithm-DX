export function openCfGroups(account,onSaved) {
  const dialog=document.createElement('dialog'); dialog.className='import-dialog cf-group-dialog'; dialog.setAttribute('aria-labelledby','cfGroupDialogTitle');
  dialog.innerHTML=`
    <header class="cf-dialog-header">
      <h2 id="cfGroupDialogTitle">CF 自建比赛</h2>
      <p class="account"></p>
    </header>
    <div class="cf-dialog-body">
      <label class="cf-dialog-field">
        <span>群组或比赛链接</span>
        <textarea class="input links" rows="4" spellcheck="false" aria-describedby="cfLinksHint" placeholder="https://codeforces.com/group/0doN9wUJK1/contests"></textarea>
      </label>
      <p id="cfLinksHint" class="cf-dialog-hint">每行一个链接。群组内新增比赛会自动发现，也支持单场比赛链接。</p>
      <label class="cf-dialog-field"><span>获取方式</span><select class="input mode"><option value="extension">普通 Edge 扩展（推荐）</option><option value="browser">专用浏览器（兼容方式）</option><option value="api">API Key</option></select></label>
      <section class="extension-auth">
        <p class="cf-dialog-hint">在普通 Edge 安装项目扩展后，可使用已有的 CF 登录同步。<a href="/help.html#cf-extension" target="_blank" rel="noopener">安装与连接教程 ↗</a></p>
        <button class="btn btn-ghost extension-pair" type="button">生成连接码</button>
        <label class="cf-dialog-field pair-field" hidden><span>连接码（粘贴到扩展中）</span><input class="input pair-code" type="password" readonly autocomplete="off"><button type="button" class="btn btn-ghost pair-copy">复制连接码</button></label>
        <p class="cf-dialog-hint">首次生成后连接一次即可；重新生成会使旧连接码失效。同步时保持普通 Edge 和已登录的 CF 标签页开启。</p>
      </section>
      <section class="browser-auth">
        <p class="cf-dialog-hint">在专用窗口登录能访问群组的 CF 账号，并保持窗口开启。登录状态会保存在本机。</p>
        <button class="btn btn-ghost browser-login" type="button">打开 CF 登录窗口</button>
        <a href="/help.html#cf-groups" target="_blank" rel="noopener">使用指南 ↗</a>
      </section>
      <section class="cf-dialog-auth" aria-labelledby="cfAuthTitle">
        <div class="cf-auth-heading"><h3 id="cfAuthTitle">API 授权</h3><a href="/help.html#cf-groups" target="_blank" rel="noopener">设置教程 ↗</a></div>
        <p class="cf-dialog-hint">使用能访问比赛的账号，在 <a href="https://codeforces.com/settings/api" target="_blank" rel="noopener">CF API 设置 ↗</a> 获取 Key 和 Secret。</p>
        <div class="cf-auth-fields">
          <label class="cf-dialog-field"><span>API Key</span><input class="input key" type="password" autocomplete="off" aria-describedby="cfOAuthHint"></label>
          <label class="cf-dialog-field"><span>API Secret</span><input class="input secret" type="password" autocomplete="off" aria-describedby="cfOAuthHint"></label>
        </div>
        <p class="credential-note cf-dialog-hint"></p>
        <details class="cf-oauth-help"><summary>看到的是 OAuth 应用页面？</summary><p id="cfOAuthHint">当前不支持 OAuth。请勿填写 Client id 或 Client secret，也无需配置 Redirect Uris；具体区别见设置教程。</p></details>
      </section>
      <p class="cf-dialog-status" role="status" aria-live="polite"></p>
    </div>
    <footer class="cf-dialog-footer"><button class="btn btn-ghost close" type="button">关闭</button><button class="btn btn-primary save" type="button">保存配置</button></footer>
  `;
  dialog.querySelector('.account').textContent='提交账号：'+account.handle;
  dialog.querySelector('.links').value=(account.cfGroups??[]).join('\n');
  dialog.querySelector('.credential-note').textContent=account.cfAuthorized?'已保存授权，Key 和 Secret 留空可沿用。':'授权仅保存在本机，各 CF 账号共用。';
  const status=dialog.querySelector('[role=status]'),button=dialog.querySelector('.save');
  const mode=dialog.querySelector('.mode'),login=dialog.querySelector('.browser-login');
  mode.value=account.cfGroupMode||'extension';
  const showMode=()=>{dialog.querySelector('.extension-auth').hidden=mode.value!=='extension';dialog.querySelector('.cf-dialog-auth').hidden=mode.value!=='api';dialog.querySelector('.browser-auth').hidden=mode.value!=='browser';};
  mode.onchange=showMode;showMode();
  const pair=dialog.querySelector('.extension-pair');
  pair.onclick=async()=>{pair.disabled=true;
    try{const r=await fetch('/api/cf-extension/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const body=await r.json();if(!r.ok)throw Error(body.error||'生成失败');
      dialog.querySelector('.pair-code').value=body.token;dialog.querySelector('.pair-field').hidden=false;status.textContent='复制连接码到 Edge 扩展并点击连接，然后保存配置。';
    }catch(e){status.textContent=e.message;}finally{pair.disabled=false;}
  };
  dialog.querySelector('.pair-copy').onclick=async()=>{const field=dialog.querySelector('.pair-code');try{await navigator.clipboard.writeText(field.value);status.textContent='连接码已复制，请粘贴到 Edge 扩展。';}catch{field.focus();field.select();status.textContent='请按 Ctrl+C 复制选中的连接码。';}};
  login.onclick=async()=>{
    login.disabled=true;status.textContent='正在打开 CF 登录窗口…';
    try{const response=await fetch('/api/accounts/cf-browser',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const body=await response.json();if(!response.ok)throw Error(body.error||'打开失败');
      status.textContent='请在新窗口登录 CF，确认能打开群组的比赛提交页，然后保存配置并同步。同步时请保持窗口开启。';
    }catch(error){status.textContent=error.message;}finally{login.disabled=false;}
  };
  dialog.querySelector('.close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>dialog.remove());
  button.onclick=async()=>{
    button.disabled=true;status.textContent='正在保存…';
    try {
      const response=await fetch('/api/accounts/cf-groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:account.id,mode:mode.value,links:dialog.querySelector('.links').value,key:dialog.querySelector('.key').value.trim(),secret:dialog.querySelector('.secret').value.trim()})});
      const body=await response.json();if(!response.ok)throw Error(body.error||'保存失败');
      dialog.querySelector('.key').value='';dialog.querySelector('.secret').value='';
      status.textContent='已保存。点击「同步最新数据」获取近期提交；较早记录可通过「回补历史」获取。';
      await onSaved();
    } catch(error){status.textContent=error.message;}
    finally{button.disabled=false;}
  };
  document.body.append(dialog);dialog.showModal();
}
