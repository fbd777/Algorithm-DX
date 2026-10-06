const stateLabels={matched:'已配对',unrated:'原题未评级',ambiguous:'需要确认原题',not_found:'待补充原题链接',read_failed:'核对未完成',pending:'等待核对'};
const date=value=>value?new Date(value*1000).toLocaleDateString('zh-CN'):'未知';
export function groupSourceControls(container,accountId,onSaved){
 let busy=false;
 const element=(tag,text,className)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(className)e.className=className;return e;};
 const link=(url,title)=>{const a=element('a',title);a.href=url;a.target='_blank';a.rel='noopener';return a;};
 async function load(){
  if(busy)return;try{const r=await fetch('/api/cf-group-ratings?accountId='+accountId);if(!r.ok)throw Error('原题信息暂不可用');render((await r.json()).items??[]);}catch(e){container.textContent=e.message;}
 }
 function render(items){
  container.replaceChildren();if(!items.length){container.textContent='同步群组记录后可在这里核对原题。';return;}
  for(const item of items){
   const card=element('details',null,'cf-source-card'),summary=element('summary',item.problem_title+' · '+(item.rating??stateLabels[item.check_state]??'等待核对'));
   card.append(summary);const body=element('div',null,'cf-source-body');card.append(body);
   const info=element('p');info.append(link(item.problem_url,'查看群组题面'));
   if(item.source_url){info.append(' · ',link(item.source_url,'原题 '+item.source_problem_id+' '+(item.source_title||'')));}
   body.append(info,element('p',(stateLabels[item.check_state]??'等待核对')+(item.method==='content'?' · 题面与样例一致':item.method==='user_confirmed'?' · 已手动确认':'')));
   body.append(element('p','原题出题：'+date(item.source_released_at)+'；群组开赛：'+date(item.group_start_time)));
   if(item.last_error)body.append(element('p',item.last_error,'cf-dialog-hint'));
   if(item.candidates?.length){const candidates=element('p','候选原题：');for(const c of item.candidates){const a=link(c.url,c.id+(c.title?' '+c.title:''));candidates.append(a,' ');}body.append(candidates);}
   const field=element('label',null,'cf-dialog-field'),input=element('input',null,'input');input.type='url';input.placeholder='粘贴 CF 或 Gym 原题链接';input.value=item.source_url||'';field.append(element('span','原题链接'),input);body.append(field);
   const check=element('input');check.type='checkbox';const label=element('label');label.append(check,' 我已打开两道题，确认是同一道题');body.append(label);
   const controls=element('div',null,'cf-source-actions'),status=element('p',null,'cf-dialog-hint');status.setAttribute('role','status');
   for(const [action,title] of [['candidate','自动核对链接'],['confirm','确认原题'],['retry','重新自动匹配'],['clear','清除配对']]){
    const b=element('button',title,'btn btn-ghost');b.type='button';controls.append(b);
    b.onclick=async()=>{
     if(busy)return;if(['candidate','confirm'].includes(action)&&!input.value.trim()){status.textContent='请先粘贴原题链接。';return;}
     if(action==='confirm'&&!check.checked){status.textContent='请先打开两道题核对，并勾选确认。';return;}
     busy=true;container.querySelectorAll('button').forEach(x=>x.disabled=true);status.textContent='正在核对原题，请保持 Edge 开启…';
     try{const r=await fetch('/api/cf-group-source',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId,problemId:item.problem_id,action,sourceUrl:input.value.trim(),confirm:check.checked})});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');render(data.items??[]);await onSaved();}catch(e){status.textContent=e.message;}finally{busy=false;container.querySelectorAll('button').forEach(x=>x.disabled=false);}
    };
   }
   body.append(controls,status);container.append(card);
  }
 }
 load();return load;
}
