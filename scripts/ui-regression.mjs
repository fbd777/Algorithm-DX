/** Local UI regression. Uses an in-memory fixture; never reads or writes the user's database.
 * Run with Node 24 and Edge installed. Screenshots are saved under output/ui-regression.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {Cdp} from '../src/fetchers/cf-browser.ts';
import {openDatabase,Repository} from '../src/db/database.ts';
import {handleApi} from '../src/server/api.ts';
import {PROBLEM_RATINGS_CACHE_KEY} from '../src/fetchers/codeforces-sync.ts';
import {submission} from '../src/fetchers/common.ts';
import {reconcileTimers} from '../src/dx/timer.ts';
const shots='output/ui-regression'; mkdirSync(shots,{recursive:true});
const db=openDatabase(':memory:'),repo=new Repository(db),user=repo.createUser('演示玩家',true),account=repo.addAccount(user,'codeforces','DemoPlayer');
repo.set(PROBLEM_RATINGS_CACHE_KEY,Array.from({length:20},(_,i)=>({contestId:i+1,index:'A',rating:1000,tags:['math']})),3600);
repo.set('cf:profile:v2:demoplayer',{handle:'DemoPlayer',avatar:'/fixture-avatar.svg'},3600);
const ctx={db,dbPath:':memory:',platforms:['codeforces'],envFile:'output/nonexistent-preview.env',openWrite:()=>db,syncJobs:{checkTimer:()=>{},timerCheckState:()=>null}};
const requests=[];
const publicFiles=new Set(readdirSync('public',{recursive:true}).map(path=>path.replaceAll('\\','/')));
const missingAssets=[];
const server=createServer(async(req,res)=>{try{
const url=new URL(req.url,'http://localhost');
if(url.pathname.startsWith('/api/')){
res.setHeader('Content-Type','application/json; charset=utf-8');
if(url.pathname==='/api/sync/status'){res.end(JSON.stringify({revision:1,nextAutoAt:Date.now()+600000}));return;}
let raw='';for await(const chunk of req)raw+=chunk;
requests.push({path:url.pathname,at:Date.now()});
const result=await handleApi(ctx,{method:req.method,pathname:url.pathname,params:url.searchParams,body:raw?JSON.parse(raw):undefined});res.statusCode=result.status;res.end(JSON.stringify(result.body));return;
}
if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return;}
if(url.pathname==='/fixture-avatar.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#356d8b"/><circle cx="50" cy="37" r="20" fill="#cee9f4"/><ellipse cx="50" cy="90" rx="37" ry="29" fill="#cee9f4"/></svg>');return;}
const assetPath=url.pathname==='/'?'index.html':url.pathname.slice(1);
if(!publicFiles.has(assetPath)){missingAssets.push(url.pathname);res.statusCode=404;res.end('Missing or case-mismatched asset');return;}
res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(url.pathname)]??'application/octet-stream')+'; charset=utf-8');res.end(readFileSync(join('public',url.pathname==='/'?'index.html':url.pathname)));
}catch(e){res.statusCode=500;res.end(String(e));}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const origin='http://127.0.0.1:'+server.address().port,dir=mkdtempSync(join(tmpdir(),'dan-life-ui-'));
const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+dir,'--no-first-run','about:blank'],{stdio:'ignore',windowsHide:true});let cdp;
try{
for(let i=0;i<80;i++){await sleep(250);try{const [port,path]=readFileSync(join(dir,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);cdp=await Cdp.connect('ws://127.0.0.1:'+port+path);break;}catch{}}
assert.ok(cdp);const originalCall=cdp.call.bind(cdp);cdp.call=async(method,params,session)=>{try{return await originalCall(method,params,session);}catch(error){console.error('CDP failed:',method,params);throw error;}};const {targetId}=await cdp.call('Target.createTarget',{url:'about:blank'});const {sessionId}=await cdp.call('Target.attachToTarget',{targetId,flatten:true});
const errors=[];cdp.socket.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.method==='Runtime.exceptionThrown')errors.push(m.params);});await cdp.call('Runtime.enable',{},sessionId);await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:"try{localStorage.removeItem('mm-mascot');}catch{}"},sessionId);
const evaluate=async expression=>{const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const waitFor=async expression=>{for(let i=0;i<60;i++){if(await evaluate(expression))return;await sleep(100);}throw Error('Timeout '+expression);};
const shot=async name=>{await sleep(name==='challenge-recovery'?120:400);const selector=name==='challenge-stage-result'?'.dx-result[open]':name==='challenge-final-result'?'.dan-result[open]':null;const clip=selector?await evaluate(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()`):null;const r=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:!!clip,...(clip?{clip}:{})},sessionId);writeFileSync(shots+'/'+name+'.png',Buffer.from(r.data,'base64'));};
await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false},sessionId);
await cdp.call('Page.navigate',{url:origin+'/dan.html'},sessionId);
await waitFor("document.querySelectorAll('#challengeTiers button').length===4");
await shot('random-practice-preview');
await evaluate("document.querySelector('#challengeTiers button').click()");await waitFor("!!document.querySelector('#active .dan-stage button')");
await evaluate("document.querySelector('#active .dan-stage button').click()");await waitFor("!!document.querySelector('.dan-clock[data-started]')");
assert.equal(await evaluate('location.pathname'),'/dan.html');
assert.equal(await evaluate("document.querySelector('#active .dan-stage a').target"),'_blank');
const timer=db.prepare("SELECT * FROM practice_timers WHERE status='running'").get();assert.ok(timer);
const now=Math.floor(Date.now()/1000);db.prepare('UPDATE practice_timers SET started_at=? WHERE id=?').run(now-1200,timer.id);db.prepare('UPDATE dan_stages SET claimed_at=? WHERE timer_id=?').run(now-1200,timer.id);
repo.saveSubmissions(account,[submission('codeforces',{submission_id:'ui-wa',problem_id:timer.problem_id,problem_title:'A fresh start',status:'WA',difficulty:1000,submitted_at:now-900}),submission('codeforces',{submission_id:'ui-ac',problem_id:timer.problem_id,problem_title:'A fresh start',status:'AC',difficulty:1000,submitted_at:now})]);reconcileTimers(db,account,now);
await cdp.call('Page.navigate',{url:origin+'/dan.html'},sessionId);await waitFor("!!document.querySelector('.dx-result[open]')");
assert.match(await evaluate("document.querySelector('.dx-result-time strong').textContent"),/00:20:00/);
await waitFor("document.querySelector('.dx-result-mascot-img').complete && document.querySelector('.dx-result-mascot-img').naturalWidth>0");
assert.equal(await evaluate("document.querySelector('.dx-result-mascot-img').dataset.character"),'derakkuma');
await shot('challenge-stage-result');
await evaluate("document.querySelector('.dx-result[open] .dx-result-next').click()");
assert.equal(db.prepare("SELECT count(*) AS n FROM practice_timers WHERE status='running'").get().n,0);
await shot('challenge-paused');
const clickAt=Date.now();await evaluate("[...document.querySelectorAll('#active > button')].find(n=>n.textContent==='开始下一题').click()");
await waitFor("!!document.querySelector('.dan-transition')");
assert.equal(db.prepare("SELECT count(*) AS n FROM practice_timers WHERE status='running'").get().n,0,'animation must not start timer');
await shot('challenge-recovery');await waitFor("!document.querySelector('.dan-transition') && !!document.querySelector('.dan-clock[data-started]')");
const lastClaim=requests.filter(r=>r.path==='/api/dan/claim').at(-1);assert.ok(lastClaim.at-clickAt>=1000,'claim only after animation');
const life=JSON.parse(db.prepare('SELECT life_json FROM dan_stages WHERE stage_index=1').get().life_json);assert.equal(life.remainingSeconds,5880);assert.equal(life.recoverySeconds,600);
await shot('challenge-running');
await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false},sessionId);
await cdp.call('Page.navigate',{url:origin+'/dx.html'},sessionId);await waitFor("!!document.querySelector('.dx-player-card img')");await evaluate("document.querySelector('#dxSummary').scrollIntoView({block:'center'})");await shot('player-card');
await cdp.call('Page.navigate',{url:origin+'/help.html'},sessionId);await waitFor("document.querySelector('#identity') && document.querySelector('.mm-theme-btn')");await shot('guide-022');

// Complete the round after exhausting the bank on stage 2.
for(let i=2;i<=4;i++){
if(i>2){await handleApi(ctx,{method:'POST',pathname:'/api/dan/next',params:new URLSearchParams(),body:{userId:user,tz:480}});const session=db.prepare("SELECT id FROM dan_sessions WHERE status='active'").get();await handleApi(ctx,{method:'POST',pathname:'/api/dan/claim',params:new URLSearchParams(),body:{userId:user,sessionId:session.id}});}
const current=db.prepare("SELECT * FROM practice_timers WHERE status='running'").get(),stamp=Math.floor(Date.now()/1000),seconds=i===2?6600:100;
db.prepare('UPDATE practice_timers SET started_at=? WHERE id=?').run(stamp-seconds,current.id);db.prepare('UPDATE dan_stages SET claimed_at=? WHERE timer_id=?').run(stamp-seconds,current.id);
repo.saveSubmissions(account,[submission('codeforces',{submission_id:'ui-final-'+i,problem_id:current.problem_id,problem_title:'Practice '+i,status:'AC',difficulty:1000,submitted_at:stamp})]);reconcileTimers(db,account,stamp);
}
await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false},sessionId);
await cdp.call('Page.navigate',{url:origin+'/dan.html'},sessionId);await waitFor("!!document.querySelector('.dx-result[open]')");
await evaluate("document.querySelector('.dx-result[open] .dx-result-next').click()");await waitFor("!!document.querySelector('.dan-result[open]')");
assert.deepEqual(await evaluate("[...document.querySelectorAll('.dan-track-stamp')].map(n=>n.alt)"),['可','不可','不可','不可']);
assert.match(await evaluate("document.querySelector('.dan-verdict-count').textContent"),/不合格/);
await shot('challenge-final-result');

// Query parameters must never alter real results, including after closing a preview.
const live = await handleApi(ctx,{method:'GET',pathname:'/api/dx/timer',params:new URLSearchParams({user:String(user),tz:'480'})});
const expected=live.body.result.score.achievementShown.toFixed(4)+'%', expectedRank=live.body.result.score.rank;
for(const preview of [false,true]) {
  await cdp.call('Page.navigate',{url:origin+'/dx.html?achievement=88&rank=A'+(preview?'&resultPreview=1':'')},sessionId);
  await waitFor("!document.querySelector('#timerResultOpen').hidden");
  if(preview) {
    await waitFor("document.querySelector('.dx-result[open][data-preview=true]')");
    assert.equal(await evaluate("document.querySelector('.dx-result-achievement-value .mm-number').getAttribute('aria-label')"),'88.0000%');
    await evaluate("document.querySelector('.dx-result-close').click()");
  }
  await evaluate("document.querySelector('#timerResultOpen').click()");
  await waitFor("document.querySelector('.dx-result[open][data-preview=false]')");
  assert.equal(await evaluate("document.querySelector('.dx-result-achievement-value .mm-number').getAttribute('aria-label')"),expected);
  assert.equal(await evaluate("document.querySelector('.dx-result-rank .mm-rank-word').getAttribute('aria-label')"),expectedRank);
  const ax=await cdp.call('Accessibility.getFullAXTree',{},sessionId);
  assert.ok(ax.nodes.some(n=>n.name?.value===expected),'screen reader can read achievement');
  await waitFor("document.querySelector('.dx-result-mascot-img').complete && document.querySelector('.dx-result-mascot-img').naturalWidth>0");
  assert.equal(await evaluate("document.querySelector('.dx-result-mascot-img').dataset.character"),'derakkuma');
  await shot(preview?'preview-restores-real-result':'ordinary-result');
}
await cdp.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
await evaluate("document.querySelector('.dx-result-close').click();document.querySelector('#timerResultOpen').click()");
assert.equal(await evaluate("document.querySelector('.dx-result-bg').getAttribute('src')"),null);
await cdp.call('Emulation.setEmulatedMedia',{features:[]},sessionId);

// All desktop pages share the theme. The guide keeps its new content and tables.
for(const page of ['/','/circle.html','/stats.html','/help.html','/dx.html','/dan.html']) {
  await cdp.call('Page.navigate',{url:origin+page},sessionId);
  await waitFor("document.readyState==='complete' && !!document.getElementById('mmThemeBtn')");
  for(const theme of ['light','dark']) {
    await evaluate(`if(document.documentElement.dataset.mmTheme!=='${theme}')document.getElementById('mmThemeBtn').click()`);
    assert.equal(await evaluate('document.documentElement.dataset.mmTheme'),theme);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,page+' horizontal overflow');
    assert.equal(await evaluate("document.querySelectorAll('.site-header nav a[href=\"/dan.html\"]').length"),1);
    if(page==='/help.html') {
      assert.equal(await evaluate("document.querySelectorAll('.help-platforms tbody tr').length"),7);
      assert.ok(await evaluate("document.querySelector('#dan').textContent.includes('第四题')"));
      await shot('guide-'+theme);
    }
    if(page==='/dx.html') {
      assert.ok(await evaluate("(()=>{const c=document.querySelector('.dx-player-card').getBoundingClientRect(),r=document.querySelector('.dx-player-card .dx-result-total').getBoundingClientRect();return r.top>=c.top-1&&r.bottom<=c.bottom+1;})()"),'rating frame stays inside player identity');
      await evaluate("document.querySelector('#dxSummary').scrollIntoView({block:'center'})");await shot('player-'+theme);}
  }
}

// A fully successful round ends on the fourth AC without a reward or transition.
const started=await handleApi(ctx,{method:'POST',pathname:'/api/dan/start',params:new URLSearchParams(),body:{userId:user,kind:'challenge',tier:'beginner',tz:480}});
assert.equal(started.status,200);
const successSession=started.body.session.id;
for(let i=1;i<=4;i++) {
  if(i>1) await handleApi(ctx,{method:'POST',pathname:'/api/dan/next',params:new URLSearchParams(),body:{userId:user,tz:480}});
  await handleApi(ctx,{method:'POST',pathname:'/api/dan/claim',params:new URLSearchParams(),body:{userId:user,sessionId:successSession}});
  const current=db.prepare("SELECT * FROM practice_timers WHERE status='running'").get(),stamp=Math.floor(Date.now()/1000);
  db.prepare('UPDATE practice_timers SET started_at=? WHERE id=?').run(stamp-1200,current.id);
  db.prepare('UPDATE dan_stages SET claimed_at=? WHERE timer_id=?').run(stamp-1200,current.id);
  repo.saveSubmissions(account,[submission('codeforces',{submission_id:'ui-success-'+i,problem_id:current.problem_id,problem_title:'Success '+i,status:'AC',difficulty:1000,submitted_at:stamp})]);
  reconcileTimers(db,account,stamp);
}
const lastLife=JSON.parse(db.prepare('SELECT life_json FROM dan_stages WHERE session_id=? AND stage_index=4').get(successSession).life_json);
assert.equal(lastLife.recoverySeconds,0);assert.equal(lastLife.remainingSeconds,4200);
await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:1200,deviceScaleFactor:1,mobile:false},sessionId);

await cdp.call('Page.navigate',{url:origin+'/dan.html'},sessionId);
await waitFor("document.querySelector('.dx-result[open]')");
assert.match(await evaluate("document.querySelector('.dan-sheet-strip').textContent"),/本轮结束/);
assert.doesNotMatch(await evaluate("document.querySelector('.dan-sheet-strip').textContent"),/待恢复/);
await evaluate("document.querySelector('.dx-result-next').click()");
await waitFor("document.querySelector('.dan-result[open]')");
assert.deepEqual(await evaluate("[...document.querySelectorAll('.dan-track-stamp')].map(n=>n.alt)"),['可','可','可','可']);
assert.equal(await evaluate("document.querySelector('.dan-life-time').textContent"),'70:00');
await shot('challenge-success');
assert.equal(errors.length,0,JSON.stringify(errors));
assert.equal(missingAssets.length,0,'Missing local assets: '+JSON.stringify([...new Set(missingAssets)]));
console.log('PASS: real APIs and desktop browser; independent timing, pause/recovery/new tab, failure propagation, retained scores, avatar, real-score isolation, accessible sprites, reduced motion, all-page themes and guide.');
}finally{cdp?.close();child.kill();server.close();db.close();}