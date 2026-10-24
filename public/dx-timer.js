import { cfRatingColor, cfToneColors } from './cf-rating-colors.js';
import { mascotImage } from './mascot.js';
import { clearWord, trackLabel, trackNumber, rankWord, scoreNumber, achievementColour, achievementLabel, medalPair, problemCard, cardTone, NUMBER_COLOURS } from './maimai-glyphs.js';
import { rankOf } from './dx-rank.js';

/**
 * 题目难度 → 数字。服务端给的是 number 或 null（见 src/dx/timer.ts）。
 * 这里显式转一次：老数据/预览样例里有把难度写成字符串的（'1700'），
 * 直接丢给 cfRatingColor 会得到 unrated —— 整张卡会错成灰的。
 * 空值仍然回 null（= 未评级），别把"没难度"变成"0 分"。
 */
function difficultyOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * 练习类型 → 卡片上那行小字的**第一个词**（第二个词是平台，见 problem-source.js 的
 * PLATFORM_LABELS）。这里也是 key→字面，不在模板里写死。
 */
const PRACTICE_KIND_LABEL = { first: 'INDEPENDENT', repeat: 'REPLAY', assisted: 'ASSISTED', unknown: 'PRACTICE' };

export function initDxTimer({ getUser, onComplete, onResultClose }) {
  const $ = id => document.getElementById(id);
  let timer = null, user = null, clockOffset = 0, requestId = null, busy = false, polling = false, revision = 0;
  let result = null, boardRefresh = Promise.resolve(), fastPollUntil = 0;
  const dialog = document.createElement('dialog');
  dialog.className = 'dx-result';
  dialog.setAttribute('aria-labelledby', 'dxResultTitle');
  dialog.innerHTML = `<div class="dx-result-sheet">
    <button class="dx-result-close" type="button" aria-label="关闭结算">×</button>
    <div class="dx-result-kicker"><span class="dx-result-track-word"></span><b>01</b><span>ALGORITHM DX</span></div>
    <h2 id="dxResultTitle" class="dx-result-clear"></h2>
    <div class="dx-result-track"></div>
    <section class="dx-result-achievement-section" aria-label="达成率结算">
      <div class="dx-result-achievement-top"><div class="dx-result-achievement-label"></div></div>
      <div class="dx-result-achievement"><span class="dx-result-achievement-value"></span></div>
    </section>
    <div class="dx-result-main"><div class="dx-result-performance"><div class="dx-result-rank" aria-label="本次评级"></div><div class="dx-result-badges"></div></div>
      <div class="dx-result-side"><figure class="dx-result-mascot" aria-hidden="true"></figure><div class="dx-result-detail"><div class="dx-result-time"><small>PLAY TIME</small><strong></strong></div><div class="dx-result-verdicts" aria-label="本次提交判定"></div><div class="dx-result-rating"><small>Rating</small><strong></strong><span class="dx-result-single-delta"></span></div></div></div>
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
    // 这几处用官方精灵拼：CLEAR! / TRACK / 段位 / 大数字，形和配色都是客户端那套
    const previewParams = new URLSearchParams(location.search);
    field('.dx-result-clear').replaceChildren(clearWord());
    // 轨道号只在段位/课题模式里有意义（客户端那边也是跑课程才显示 TRACK n）。
    // 普通练习模式这里是当天第几道题的固定值，没有意义。
    // ⚠️ 只藏内容、不删元素 —— 删掉会把 kicker 这一行压塌，上面的组件整体位移。
    field('.dx-result-track-word').style.visibility = 'hidden';
    field('.dx-result-kicker b').style.visibility = 'hidden';
    // ?track=03 时强制显示这一行，方便核对 TRACK 和数字的字体（正常用户看不到）。
    const trackPreview = previewParams.get('track');
    if (trackPreview !== null) {
      field('.dx-result-track-word').replaceChildren(trackLabel());
      field('.dx-result-track-word').style.visibility = '';
      field('.dx-result-kicker b').replaceChildren(
        trackNumber(trackPreview.replace(/\D/g, '').padStart(2, '0').slice(-2)));
      field('.dx-result-kicker b').style.visibility = '';
    }
    // 卡片整块用官方乐曲底板 + 官方等级数字重画（maimai-glyphs.js 的 problemCard）。
    // 配色还是那一条：难度 → cfRatingColor 的 tone → 底板/滤镜/板面底色。
    const difficulty = difficultyOf(result.difficulty);
    const color = cfRatingColor(difficulty);
    const [toneMain, toneDeep] = cfToneColors(color.tone);
    const tone = cardTone(color.tone);
    const card = field('.dx-result-track');
    card.dataset.ratingTone = color.tone;
    card.title = `题目难度配色参考 CF 名称颜色：${color.label}（${color.range}）`;
    card.style.setProperty('--mm-plate', `url('/assets/mm-result/${tone.plate}')`);
    card.style.setProperty('--mm-field', tone.field);
    card.style.setProperty('--mm-plate-filter', tone.filter);
    card.style.setProperty('--track-main', toneMain);
    card.style.setProperty('--track-deep', toneDeep);
    // 题面来源的平台**不传**：服务端今天只发 Codeforces，result 和 timer 上都没有 platform
    // 字段（见 src/dx/timer.ts 的 timerResult —— 平台在 SQL 里就是写死的 'codeforces'），
    // 所以这里不能凭空写 result.platform。不传 → problemCard → platformLabel() 落回
    // problem-source.js 的默认值，卡片照旧印 CODEFORCES；哪天服务端把平台发下来了，
    // 在这里补一个 platform: result.platform 就切换完了。
    card.replaceChildren(problemCard({
      problemId: timer.problem_id,
      kind: PRACTICE_KIND_LABEL[result.practiceKind] ?? result.practiceKind ?? '',
      title: result.title,
      difficulty,
      tone: color.tone,
    }));
    const achievementText = score ? score.achievementShown.toFixed(4) : null;
    // 显示哪个数字：调试用的 ?achievement= 优先，否则用本次成绩
    // 两条路都补齐到四位小数 —— 结算单上的达成率永远是 4 位（100.0000%）
    const achievementOverride = previewParams.get('achievement');
    const shownAchievement = achievementOverride && /^\d+(\.\d+)?$/.test(achievementOverride)
      ? Number(achievementOverride).toFixed(4) : achievementText;
    // 达成率 < 80% 不算 clear（客户端也是这个门槛），CLEAR! 就不该出现。
    // 这里必须放在 shownAchievement 算出来之后 —— 放在前面会踩 TDZ，
    // 直接抛 ReferenceError 让整个 showResult() 中断（什么精灵都画不出来）。
    // shownAchievement 为 null 表示这条没有成绩数字、按已通关处理，仍然显示。
    const isCleared = !shownAchievement || Number(shownAchievement) >= 80;
    // 用 visibility 而不是 hidden：达成率 <80 时只是把文字藏掉，
    // 这一块的高度必须留着 —— 否则底下的组件会整体往上顶。
    field('.dx-result-clear').style.visibility = isCleared ? '' : 'hidden';
    // 配色由达成率决定（<80 蓝、>=97 金、其余红）；调试时可以用 ?achvColor= 覆盖来看别的配色
    const numberColour = shownAchievement
      ? (NUMBER_COLOURS.includes(previewParams.get('achvColor')) ? previewParams.get('achvColor') : achievementColour(shownAchievement))
      : 'Gold';
    // 达成率标题用原版素材（UI_RSL_Base_Achievement 长条 + UI_RSL_Text_Achievement 字）
    field('.dx-result-achievement-label').replaceChildren(achievementLabel());
    field('.dx-result-achievement-value').replaceChildren(
      shownAchievement ? scoreNumber(shownAchievement + '%', { colour: numberColour }) : document.createTextNode('已通关'));
    // 段位只跟达成率有关，所以直接由上面显示的数字推 —— 两个数据源打架就会画出「88.8888 配 S」
    const rankText = previewParams.get('rank') || (shownAchievement ? rankOf(shownAchievement) : score?.rank) || 'AC';
    field('.dx-result-rank').replaceChildren(rankWord(rankText));
    // 结算底图：嵌逆向出来的客户端动态结算背景页（云/星屑/点阵/流星都在里面），
    // 按评级切色版。它只有 A/B/S/SS/SSS 五档，细分档（AA/AAA/BB/BBB 等）按下表归并，
    // 低于最低档、以及 AC 兜底（AC = Accepted，不是段位），都落到 B。
    const bgRank = { 'SSS+':'SSS', 'SSS':'SSS', 'SS+':'SS', 'SS':'SS',
                     'S+':'S', 'S':'S', 'AAA':'A', 'AA':'A', 'A':'A'
                   }[String(rankText).trim()] || 'B';
    const sheet = field('.dx-result-sheet');
    sheet.dataset.bg = bgRank.toLowerCase();
    if (!sheet.querySelector('.dx-result-bg')) {
      const bf = document.createElement('iframe');
      bf.className = 'dx-result-bg';
      bf.setAttribute('scrolling', 'no');
      bf.setAttribute('aria-hidden', 'true');
      bf.tabIndex = -1;
      sheet.insertBefore(bf, sheet.firstChild);
      // 背景比结算单大一圈：四周外扩 BLEED 像素，缩放取宽/高比例的较大者，
      // 这样无论哪一维差一点都不会在边上露出底色（用户要的"四周多几个像素"）。
      const BLEED = 24;
      sheet.style.setProperty('--result-bg-bleed', BLEED + 'px');
      const fit = () => {
        const kw = (sheet.clientWidth + BLEED * 2) / 903;
        const kh = (sheet.clientHeight + BLEED * 2) / 906;
        sheet.style.setProperty('--result-bg-scale',
          Math.max(kw, kh, 0.2).toFixed(4));
      };
      fit();
      if (window.ResizeObserver) new ResizeObserver(fit).observe(sheet);
      window.addEventListener('resize', fit);
    }
    // ?bgStill=1 时只留静态色版兜底，不嵌 iframe（排查用）
    if (previewParams.get('bgStill') !== '1') {
      sheet.querySelector('.dx-result-bg').src =
        '/mm-result-bg.html?ui=0&clear=1&t=0&rank=' + bgRank;
    }
    field('.dx-result-time strong').textContent = duration(result.seconds);
    field('.dx-result-rating strong').textContent = score ? score.rating.toFixed(1) : '—';
    const comparison = result.comparison, previous = comparison?.previousScore;
    const signed = (number, digits) => (number>=0?'+':'−')+Math.abs(number).toFixed(digits);
    const previousAchievement = previous?.achievementShown ?? 0;
    const improvement = score && comparison ? score.achievementShown-previousAchievement : null;
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
    // cleanSolve 原本用来切换 AC/CS 那对 CSS 勋章；现在勋章是官方精灵
    // （medalPair()：底座 + AP/FSD），这一段只剩判定，留着以后接精灵的亮暗。
    const cleanSolve = result.verdicts.AC > 0 && Object.entries(result.verdicts).every(([verdict, count]) => verdict === 'AC' || count === 0);
    // 勋章挂在这里：Accepted 有 AC 就有；Clean Solve 要求 AC 之外全为 0。
    field('.dx-result-badges').replaceChildren(medalPair({ cleanSolve }));
    // 勋章：官方底座 + 两枚圆章。Accepted 有 AC 就有；Clean Solve 要求 AC 之外全为 0。
    // cleanSolve 在下面才算，所以这里必须放在它后面挂载。
    field('.dx-result-verdicts').replaceChildren();
    for (const verdict of ['AC','WA','TLE','RE','CE','MLE','OTHER','PENDING']) {
      if (['MLE','OTHER','PENDING'].includes(verdict) && !result.verdicts[verdict]) continue;
      const tag = document.createElement('div'); tag.className='dx-result-verdict dx-result-verdict-'+verdict.toLowerCase();
      const name = document.createElement('span');name.textContent=verdict;
      const count = document.createElement('strong');count.textContent=String(result.verdicts[verdict]??0);
      tag.append(name,count);
      field('.dx-result-verdicts').append(tag);
    }
    // 看板娘每次都重画：用户可能在设置里刚换过，图源就是那串 lolicount.top 链接。
    // 远端挂了 mascotImage 会自己退回本地占位图，这里的排版不用管加载成功与否。
    field('.dx-result-mascot').replaceChildren(mascotImage({ className: 'dx-result-mascot-img' }));
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
  /**
   * 开发/设计预览：塞一份样例把结算弹窗直接弹出来，不必真的做完一道题。
   * 只改这份闭包里的状态，showResult 照常走；页面用 ?resultPreview=1 触发。
   */
  function previewResult(sample) {
    timer = { problem_id: sample.problemId, status: 'completed' };
    result = sample.result;
    user = getUser();
    showResult();
  }

  return {refresh,running:()=>timer?.status==='running',previewResult};
}
