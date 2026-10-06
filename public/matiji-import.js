export function openMatijiImport(account, onImported) {
  const dialog=document.createElement('dialog');
  dialog.className='import-dialog';
  dialog.innerHTML='<h2>导入码蹄集记录</h2><p class="import-account"></p><p>选择记录 JSON 文件（最多 10 MB），预览核对后导入。已有记录会合并，不会重复计数。</p><input type="file" accept=".json,application/json" aria-label="选择码蹄集记录文件"><p role="status" aria-live="polite"></p><ul></ul><p><a href="/help.html#matiji" target="_blank" rel="noopener">文件格式与获取说明</a> · <button type="button" class="btn btn-ghost template">下载格式模板</button></p><div class="form-actions"><button type="button" class="btn btn-primary commit" disabled>确认导入</button><button type="button" class="btn btn-ghost close">关闭</button></div>';
  dialog.querySelector('.import-account').textContent='账号：'+account.handle+' · '+account.user_name;
  const input=dialog.querySelector('input'), status=dialog.querySelector('[role=status]'), list=dialog.querySelector('ul'), button=dialog.querySelector('.commit');
  let snapshot=null, revision=0, importing=false;
  const request=async(commit)=>{
    const response=await fetch('/api/import/matiji',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:account.id,snapshot,commit})});
    const body=await response.json(); if(!response.ok)throw Error(body.error || '导入失败'); return body;
  };
  input.addEventListener('change',async()=>{
    const current=++revision; snapshot=null; button.disabled=true; list.replaceChildren();
    const file=input.files[0]; if(!file){status.textContent='请选择文件';return;}
    status.textContent='正在检查文件…';
    try {
      if(file.size>10*1024*1024)throw Error('文件超过 10 MB，请拆分后导入');
      const contents=await file.text(); if(current!==revision)return;
      try { snapshot=JSON.parse(contents.replace(/^\uFEFF/,'')); } catch { throw Error('文件不是有效的 JSON，请查看文件格式说明'); }
      const result=await request(false); if(current!==revision)return;
      status.textContent='共 '+result.unique+' 条提交，其中 '+result.accepted+' 条 AC；已有 '+result.existing+' 条，文件内重复 '+result.duplicates+' 条。'+(result.unknown?'有 '+result.unknown+' 条无法识别的结果，会保留为其他状态。':'');
      for(const row of result.sample){const li=document.createElement('li');li.textContent=row.problem+' · '+row.status;list.append(li);}
      button.disabled=false;
    } catch(error){if(current===revision){status.textContent=error.message;snapshot=null;}}
  });
  button.addEventListener('click',async()=>{
    if(!snapshot || importing)return;
    importing=true; button.disabled=true; input.disabled=true; status.textContent='正在导入…';
    try {
      const result=await request(true);
      status.textContent='导入完成：新增 '+result.inserted+' 条，合并已有 '+result.existing+' 条。';
      snapshot=null;
      try { await onImported(); } catch { status.textContent+=' 页面暂未更新，请刷新查看。'; }
    } catch(error){status.textContent=error.message;button.disabled=false;}
    finally{importing=false;input.disabled=false;}
  });
  dialog.querySelector('.template').addEventListener('click',()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify({account_handle:account.handle,records:[]},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='matiji-template.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    status.textContent='模板不含记录。请填入真实提交数据，字段说明见使用指南。';
  });
  dialog.querySelector('.close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{++revision;dialog.remove();});
  document.body.append(dialog);dialog.showModal();
}
