// Resolve CF links consistently: CF uses both absolute and relative href values.
function cfPath(href){try{const u=new URL(href,'https://codeforces.com');return u.origin==='https://codeforces.com'?u.pathname:'';}catch{return '';}}
function cfLoggedIn(doc){
 if(Array.from(doc.querySelectorAll('a[href]')).some(a=>/^\/logout(?:\/|$)/.test(cfPath(a.getAttribute('href')))))return true;
 const header=doc.querySelector?.('#header,.lang-chooser');
 return Boolean(header&&cfProfileHandles(header).length&&Array.from(header.querySelectorAll('a,button,input[type=submit]')).some(a=>/^(Logout|Log out|Sign out|Выход|Выйти|退出|退出登录)$/i.test((a.textContent||a.value||'').trim())));
}
function cfProfileHandles(doc){return Array.from(doc.querySelectorAll('a[href]')).map(a=>cfPath(a.getAttribute('href')).match(/^\/profile\/([^/]+)\/?$/)?.[1]).filter(Boolean);}
function cfChallenge(doc){
 // Check the rendered page identity, never keywords inside script bodies or inline resources.
 return /^(?:Just a moment|Checking your browser|Verify you are human|Attention Required)(?:\b|[.!…])/i.test((doc.title||doc.querySelector('title')?.textContent||'').trim())||Boolean(doc.querySelector('#challenge-running,#challenge-stage'));
}
// Shared CF HTML parser. Never executes scripts from the response.
function parseCfHtml(html,url,status){
return parseCfDocument(new DOMParser().parseFromString(html,'text/html'),url,status);
}
function parseCfDocument(doc,url,status,originalTime){
 const text=e=>(e?.textContent||'').trim().replace(/\s+/g,' ');
 const links=Array.from(doc.querySelectorAll('a[href]')).map(a=>({href:a.getAttribute('href'),text:text(a)}));
 const rows=Array.from(doc.querySelectorAll('tr[data-submission-id]')).map(tr=>{
   const cells=Array.from(tr.querySelectorAll('td'));
   const problem=tr.querySelector('a[href*="/problem/"]');
   const verdict=tr.querySelector('[submissionverdict],.submissionVerdictWrapper');
   return {id:tr.getAttribute('data-submission-id'),
     handles:cfProfileHandles(tr),
     problem:problem?.getAttribute('href'),title:text(problem),
     time:originalTime ? (originalTime(tr)||'') : text(tr.querySelector('.format-time')||cells[1]),
     verdict:verdict?.getAttribute('submissionverdict')||'',verdictText:text(verdict||cells[5]),
     language:text(cells[4]),execution:text(cells[6]),memory:text(cells[7])};
 });
 if(originalTime&&rows.some(row=>!row.time))throw Error('未捕获到提交的原始时间。请刷新此读取页面，再重新连接；不会猜测时区写入记录');
 const path=cfPath(url);
 const group=path.match(/^\/group\/([A-Za-z0-9]+)\/contests(?:\/page\/\d+)?\/?$/)?.[1];
 const visibleContests=Boolean(group&&links.some(link=>{const match=cfPath(link.href).match(/^\/group\/([A-Za-z0-9]+)\/contest\/\d+(?:\/|$)/);return match?.[1]===group;}));
 const contests=[];
 if(group){
  const seen=new Set();
  for(const a of doc.querySelectorAll('a[href]')){
   const match=cfPath(a.getAttribute('href')).match(/^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)(?:\/|$)/);
   if(!match||match[1]!==group||seen.has(match[2]))continue;
   const tr=a.closest('tr'),cells=tr?Array.from(tr.querySelectorAll('td')):[];
   if(cells.length<3)continue;
   const time=originalTime?(originalTime(tr)||''):text(tr.querySelector('.format-time'));
   const duration=text(cells[2]);
   if(!time||!/^\d+:\d{2}(?::\d{2})?$/.test(duration))continue;
   seen.add(match[2]);contests.push({id:match[2],name:text(cells[0]).replace(/Enter\s*»|Virtual participation\s*»/g,'').trim(),time,duration});
  }
 }
 return {contests,url,status,title:text(doc.querySelector('title')),
   viewer:((doc.querySelector('#header,.lang-chooser'))?cfProfileHandles(doc.querySelector('#header,.lang-chooser'))[0]:null)||null,
   loggedIn:cfLoggedIn(doc),
   challenge:cfChallenge(doc),
   contestTable:visibleContests||Boolean(doc.querySelector('.contests-table,[class*="contestList"]')),
   statusTable:rows.length>0||Boolean(doc.querySelector('.status-frame-datatable')),
   empty:/No submissions|No contests|There are no submissions/i.test(text(doc.querySelector('#pageContent'))),
   links,rows};
}
