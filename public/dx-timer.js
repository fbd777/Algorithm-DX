import { cfRatingColor } from './cf-rating-colors.js';

export function initDxTimer({ getUser, onComplete, onResultClose }) {
  const $ = id => document.getElementById(id);
  let timer = null, user = null, clockOffset = 0, requestId = null, busy = false, polling = false, revision = 0;
  let result = null, boardRefresh = Promise.resolve(), fastPollUntil = 0;
  const dialog = document.createElement('dialog');
  dialog.className = 'dx-result';
  dialog.setAttribute('aria-labelledby', 'dxResultTitle');
  dialog.innerHTML = `<div class="dx-result-sheet">
    <button class="dx-result-close" type="button" aria-label="关闭结算">×</button>
    <div class="dx-result-kicker">TRACK <b>01</b><span>ALGORITHM DX</span></div>
    <h2 id="dxResultTitle" class="dx-result-clear">CLEAR!</h2>
    <div class="dx-result-track"><div class="dx-result-track-icon" aria-hidden="true">DX<span>✦</span></div><div class="dx-result-track-content"><div class="dx-result-track-heading"><span class="dx-result-kind"></span><span class="dx-result-problem"></span><i>DX</i></div><h3 class="dx-result-name"></h3></div><div class="dx-result-level"><small>LEVEL</small><strong></strong></div></div>
    <section class="dx-result-achievement-section" aria-label="达成率结算">
      <div class="dx-result-achievement-top"><div class="dx-result-achievement-label">达成率 <span>›››✦</span></div><div class="dx-result-best"><span>此前最佳 <b></b></span><span class="dx-result-achievement-delta"></span></div></div>
      <div class="dx-result-achievement"><span class="dx-result-achievement-value"></span></div><span class="dx-result-record" hidden>NEW RECORD</span>
    </section>
    <div class="dx-result-main"><div class="dx-result-performance"><div class="dx-result-rank" aria-label="本次评级"></div><div class="dx-result-badges"><div class="dx-result-award"><span class="dx-result-medal" aria-label="accepted"><b>AC</b><small>Accepted</small></span></div><div class="dx-result-award dx-result-award-cs"><span class="dx-result-medal dx-result-medal-cs" aria-label="clean solve"><b>CS</b><small>Clean Solve</small></span></div></div></div>
      <div class="dx-result-detail"><div class="dx-result-time"><small>PLAY TIME</small><strong></strong></div><div class="dx-result-verdicts" aria-label="本次提交判定"></div><div class="dx-result-rating"><small>Rating</small><strong></strong><span class="dx-result-single-delta"></span></div></div>
    </div>
    <div class="dx-result-bottom"><div class="dx-result-total"><div class="dx-result-total-label"><b>DX</b><span>RATING</span></div><div class="dx-result-total-score"><strong></strong></div><span class="dx-result-total-delta"></span></div>
    <div class="dx-result-footer"><button class="dx-result-next" type="button">下一步 <span aria-hidden="true">›</span></button></div></div>
    </div>`;
  document.body.append(dialog);
  const field = selector => dialog.querySelector(selector);
  const duration = seconds => [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
  function showResult() {
    if (!result || timer?.status !== 'completed' || user !== getUser()) return;
    const score = result.score;
    field('.dx-result-kicker b').textContent = String(result.dailyTrack || 1).padStart(2, '0');
    field('.dx-result-kicker').title = '当天第 ' + (result.dailyTrack || 1) + ' 道 AC 的题目';
    const color = cfRatingColor(result.difficulty);
    field('.dx-result-track').dataset.ratingTone = color.tone;
    field('.dx-result-track').title = `题目难度配色参考 CF 名称颜色：${color.label}（${color.range}）`;
    field('.dx-result-problem').textContent = 'CODEFORCES / '+timer.problem_id;
    field('.dx-result-name').textContent = result.title;
    field('.dx-result-level strong').textContent = result.difficulty ?? '待定';
    field('.dx-result-achievement-value').textContent = score ? score.achievementShown.toFixed(4)+'%' : '已通关';
    field('.dx-result-rank').textContent = score?.rank ?? 'AC';
    field('.dx-result-kind').textContent = {first:'INDEPENDENT',repeat:'REPLAY',assisted:'ASSISTED',unknown:'PRACTICE'}[result.practiceKind];
    field('.dx-result-time strong').textContent = duration(result.seconds);
    field('.dx-result-rating strong').textContent = score ? score.rating.toFixed(1) : '—';
    const comparison = result.comparison, previous = comparison?.previousScore;
    const signed = (number, digits) => (number>=0?'+':'−')+Math.abs(number).toFixed(digits);
    const previousAchievement = previous?.achievementShown ?? 0;
    const improvement = score && comparison ? score.achievementShown-previousAchievement : null;
    field('.dx-result-best b').textContent = comparison ? previousAchievement.toFixed(4)+'%' : '—';
    field('.dx-result-achievement-delta').textContent = improvement!==null ? signed(improvement,4)+'%' : '暂无对比';
    field('.dx-result-achievement-delta').dataset.direction = improvement!==null && improvement<0 ? 'down' : 'up';
    field('.dx-result-record').hidden = !comparison || !score || result.practiceKind==='assisted' || (previous && improvement<=0);
    field('.dx-result-single-delta').textContent = score && previous ? signed(score.rating-previous.rating,1) : '';
    const totalText = comparison ? comparison.ratingAfter.toFixed(1) : '—';
    const totalFrame = field('.dx-result-total');
    const totalColor = cfRatingColor(comparison?.ratingAfter);
    totalFrame.dataset.ratingTone = totalColor.tone;
    totalFrame.title = 'DX Rating · '+totalColor.label+'（'+totalColor.range+'）';
    const digits = field('.dx-result-total-score strong');
    digits.setAttribute('aria-label', totalText);
    digits.replaceChildren();
    for (const character of totalText.padStart(Math.max(6, totalText.length), ' ')) {
      const digit = document.createElement('span');
      digit.className = character === '.' ? 'dx-rating-point' : 'dx-rating-digit';
      digit.dataset.empty = String(character === ' ');
      digit.setAttribute('aria-hidden', 'true');
      digit.textContent = character === ' ' ? '\u00a0' : character;
      digits.append(digit);
    }
    field('.dx-result-total-delta').textContent = comparison ? signed(comparison.ratingDelta,1) : '—';
    const cleanSolve = result.verdicts.AC > 0 && Object.entries(result.verdicts).every(([verdict, count]) => verdict === 'AC' || count === 0);
    field('.dx-result-award-cs').hidden = !cleanSolve;
    field('.dx-result-medal-cs').setAttribute('aria-label','clean solve');
    field('.dx-result-award-cs').title = 'Clean Solve · AC only';
    field('.dx-result-verdicts').replaceChildren();
    for (const verdict of ['AC','WA','TLE','RE','CE','MLE','OTHER','PENDING']) {
      if (['MLE','OTHER','PENDING'].includes(verdict) && !result.verdicts[verdict]) continue;
      const tag = document.createElement('div'); tag.className='dx-result-verdict dx-result-verdict-'+verdict.toLowerCase();
      const name = document.createElement('span');name.textContent=verdict;
      const count = document.createElement('strong');count.textContent=String(result.verdicts[verdict]??0);
      tag.append(name,count);
      field('.dx-result-verdicts').append(tag);
    }
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener('close', async () => {
    if (user !== getUser() || timer?.status !== 'completed' || !(result?.comparison?.ratingDelta > 0)) return;
    const closedUser = user, problemId = timer.problem_id;
    try {
      await boardRefresh;
      if (closedUser === getUser()) await onResultClose?.({ userId: closedUser, problemId });
    } catch (error) { console.warn('Unable to focus the B50 result', error); }
  });
  field('.dx-result-close').addEventListener('click',()=>dialog.close());
  field('.dx-result-next').addEventListener('click',()=>{dialog.close();$('timerProblem').focus({preventScroll:true});});
  $('timerResultOpen').addEventListener('click',showResult);
  async function request(path, body) {
    const response = await fetch(path, {cache:'no-store',signal:AbortSignal.timeout(15000),
      ...(body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok && !(response.status===409 && data.job)) throw new Error(data.error || '暂时无法连接服务');
    return data;
  }
  function render() {
    const running = timer?.status === 'running';
    $('timerTitle').textContent=running?'专注解题中':'准备就绪，开始解题';
    $('timerForm').hidden = running;
    $('timerRunning').hidden = !running;
    $('timerStart').disabled = busy || getUser() == null;
    $('timerCheck').disabled = busy;
    $('timerCancel').disabled = busy;
    $('timerResultOpen').hidden = timer?.status !== 'completed' || !result;
    if (running) {
      $('timerProblemLabel').textContent = timer.problem_id;
      const [contest,index] = timer.problem_id.split(':');
      $('timerProblemLink').href = `https://codeforces.com/${Number(contest)>=100000?'gym':'contest'}/${contest}/problem/${index}`;
      $('timerStarted').textContent = '开始于 '+new Date(timer.started_at*1000).toLocaleString('zh-CN');
    }
    tick();
  }
  function tick() {
    if (timer?.status !== 'running') return;
    const seconds = Math.max(0,Math.floor(Date.now()/1000+clockOffset)-timer.started_at);
    $('timerClock').textContent = [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
    $('timerOverdue').hidden = seconds <= 86400;
  }
  async function receive(data, capturedUser) {
    if (capturedUser !== getUser()) return;
    const completed = timer?.status==='running' && data.timer?.id===timer.id && data.timer.status==='completed';
    user = capturedUser;
    timer = data.timer;
    result = data.result ?? null;
    clockOffset = data.serverNow-Date.now()/1000;
    if (timer?.status==='completed') {
      const seconds=timer.ended_at-timer.started_at;
      $('timerStatus').textContent = `${timer.problem_id} 已 AC · 用时 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒，已自动保存。${timer.practice_kind==='assisted'?'辅助解题保留在历史中，不计入 B50。':'可在全部成绩或练习历史中查看。'}`;
    } else if (timer?.status==='cancelled') $('timerStatus').textContent='上次计时已取消，没有生成成绩。账号发生变化时计时也会自动取消。';
    else if (timer?.status==='expired') $('timerStatus').textContent='已检查同步数据，24 小时内未发现对应 AC，本次计时已结束，未生成成绩。';
    else $('timerStatus').textContent='';
    if (timer?.status === 'running') $('timerStatus').textContent = data.check?.running
      ? '正在检查公开提交，确认 AC 后自动结算…'
      : data.check?.error ? '公开提交检查失败：'+data.check.error
      : '等待对应题目的 AC；每 15 秒自动检查公开提交。';
    render();
    if (completed) { boardRefresh = Promise.resolve().then(onComplete); showResult(); await boardRefresh; }
  }
  async function refresh() {
    const current=++revision;
    const capturedUser=getUser();
    if (capturedUser==null) return;
    if (user!==capturedUser) { dialog.close();timer=null;result=null; user=capturedUser; requestId=null; $('timerStatus').textContent='正在恢复计时状态…'; render(); }
    const data=await request('/api/dx/timer?user='+capturedUser+'&tz='+(-new Date().getTimezoneOffset()));
    if(current===revision) await receive(data,capturedUser);

  }
  $('timerForm').addEventListener('submit',async event=>{
    event.preventDefault();
    if (busy || getUser()==null) return;
    const capturedUser=getUser(); ++revision; busy=true; render();
    requestId ??= crypto.randomUUID();
    try {
      await receive(await request('/api/dx/timer/start',{userId:capturedUser,problemId:$('timerProblem').value,practiceKind:$('timerKind').value,requestId}),capturedUser);
      requestId=null;
    } catch(error) { $('timerStatus').textContent=error.message; }
    finally {busy=false;render();}
  });
  for (const id of ['timerProblem','timerKind']) $(id).addEventListener('input',()=>{requestId=null;});
  $('timerCheck').addEventListener('click',async()=>{
    if(busy || !timer) return;
    const capturedUser=getUser();
    fastPollUntil=Date.now()+60000;
    nextPollAt=0;
    ++revision;busy=true;render();
    try {
      await receive(await request('/api/dx/timer/check',{userId:capturedUser}),capturedUser);
      if(capturedUser===getUser() && timer?.status==='running') {
        $('timerStatus').textContent='正在检查公开提交，确认 AC 后自动结算…';
      }
    } catch(error){$('timerStatus').textContent=error.message;}
    finally{busy=false;render();}
  });
  $('timerCancel').addEventListener('click',async()=>{
    if(busy || !timer) return;
    const capturedUser=getUser(), id=timer.id;
    ++revision;busy=true;render();
    try {await receive(await request('/api/dx/timer/cancel',{userId:capturedUser,id}),capturedUser);}
    catch(error){$('timerStatus').textContent=error.message;}
    finally{busy=false;render();}
  });
  let clock, poll, nextPollAt = 0;
  async function check() {
    if(polling || busy || Date.now()<nextPollAt) return;
    nextPollAt=Date.now()+(timer?.status==='running' && Date.now()<fastPollUntil ? 400 : 3000);
    polling=true;
    try{await refresh();}catch{ $('timerStatus').textContent='暂时无法连接服务。计时已保存在本机，连接恢复后将重新检查 AC。'; }
    finally{polling=false;}
  }
  function startPolling() { clearInterval(clock);clearInterval(poll);clock=setInterval(tick,1000);nextPollAt=0;poll=setInterval(check,400); }
  startPolling();
  window.addEventListener('pageshow',event=>{if(event.persisted){startPolling();void check();}});
  window.addEventListener('pagehide',()=>{clearInterval(clock);clearInterval(poll);});
  return {refresh,running:()=>timer?.status==='running'};
}
