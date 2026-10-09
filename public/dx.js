import { cfRatingColor } from './cf-rating-colors.js';
import { inferPracticeKind } from './practice-kind.js';
import { startAutoSync } from './auto-sync.js';
import { initDxTimer } from './dx-timer.js';
import { focusB50Card } from './dx-b50-focus.js';
import { queryRecords, recordsCsv } from './dx-records.js';
import { saveB50Image } from './dx-export.js';
/**
 * DX Rating 页。
 *
 * 这一页**不做任何口径计算** —— 单题 rating、完成度、Rank、b35/b15 的选取全在服务端
 * （`src/dx/rating.ts`）算好。前端只负责把数字摆出来、把用户填的用时送回去。
 * 理由和研究线里那条一样：口径只有一处出处，否则界面和文档迟早对不上。
 */

/* ---------- DOM 助手 ---------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

const $ = (id) => document.getElementById(id);
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

/* ---------- 格式化 ---------- */

const pad2 = (n) => String(n).padStart(2, '0');

/** 秒 → mm:ss（超过一小时给 h:mm:ss）。 */
function fmtClock(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** 秒 → 人类可读的用时，用于待填写列表。 */
function fmtSeconds(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (total >= 60) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}

function fmtDate(seconds) {
  if (!seconds) return '—';
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 秒 → MM-DD HH:mm。待填写列表按 AC 时间倒序，只有日期分不出先后。 */
function fmtDateTime(seconds) {
  if (!seconds) return '—';
  const d = new Date(seconds * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const num1 = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(1));

/** 秒 → 时/分/秒三格，用于回填输入框。 */
function splitClock(seconds) {
  const total = Math.max(0, Math.round(seconds ?? 0));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/**
 * 读三格输入框的时/分/秒。**留空按 0 算** —— 只想填「14 分 12 秒」时不必先填两个 0。
 * 返回 `{ seconds }` 或 `{ error }`，由调用方决定怎么显示。
 */
function readDuration() {
  const fields = ['timeHours', 'timeMinutes', 'timeSeconds'];
  const values = fields.map((id) => $(id).value.trim());
  const [h, m, s] = values.map((value) => (value === '' ? 0 : Number(value)));

  if ([h, m, s].some((n) => !Number.isInteger(n) || n < 0)) return { error: '时、分、秒都要填非负整数' };
  if (m > 59 || s > 59) return { error: '分和秒都要小于 60' };
  if (h > 24) return { error: '小时数不能超过 24（用时上限就是 24 小时）' };

  const seconds = h * 3600 + m * 60 + s;
  // 服务端只接受 1 秒起的用时；三个框全空等于没填。
  if (seconds < 1) return { error: '三个框都是空的 —— 至少填一个不为 0 的数' };
  return { seconds };
}

/* ---------- 网络 ---------- */

async function api(path, params) {
  const search = new URLSearchParams(params ?? {});
  search.set('tz', String(-new Date().getTimezoneOffset()));
  const res = await fetch(`${path}?${search.toString()}`, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
  return body;
}

async function postJson(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
  return body;
}

/**
 * 发起一轮同步。**已经在跑的那一轮不算失败** —— 服务端会把它的 job 一起回过来。
 *
 * 为什么不能直接把 409 当错误：那一轮多半就是使用者自己在另一个页面点的同步
 * （首页的全平台同步要走 CF → 洛谷 → 力扣，二十多秒），
 * 「等它结束再开始」是把一个本来能自动处理的状态推回给人。所以这里把它变成可跟随的任务。
 */
async function requestSync(accountId) {
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ accountId, mode: 'recent' }),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 202) return { jobId: body.job.id, followed: false };
  if (res.status === 409 && body && body.job && body.job.id) return { jobId: body.job.id, followed: true };
  throw new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
}

/* ---------- 状态 ---------- */

const pageParams = new URLSearchParams(location.search);
let pageView = ['practice', 'history', 'recorded', 'board'].includes(pageParams.get('view')) ? pageParams.get('view') : 'board';
const requestedYear = Number(pageParams.get('year'));
const state = { userId: null, year: Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 3000 ? requestedYear : null,
  data: null, meta: null, modalTarget: null };

function updatePageNavigation() {
  const labels = { practice: '用时补录', history: '练习历史', recorded: '全部成绩', board: 'Rating 总览' };
  document.title = `Algorithm DX · ${labels[pageView]}`;
  for (const view of ['practice', 'history', 'recorded', 'board']) {
    const link = $(`${view}PageLink`);
    const params = new URLSearchParams();
    if (view !== 'board') params.set('view', view);
    if (state.userId !== null) params.set('user', String(state.userId));
    if (state.year !== null) params.set('year', String(state.year));
    link.href = '/dx.html' + (params.size ? '?' + params : '');
    link.className = `btn ${view === pageView ? 'btn-primary' : 'btn-ghost'}`;
    if (view === pageView) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const practiceView = pageView === 'practice' || pageView === 'history';
  $('practicePage').hidden = !practiceView;
  $('boardPage').hidden = pageView !== 'board';
  $('recordedPage').hidden = pageView !== 'recorded';
  $('practicePageTitle').textContent = labels[pageView];
  $('practicePageDescription').textContent = pageView === 'history'
    ? '回看每次练习的用时与成绩，可搜索、排序，并修改或作废记录。'
    : '记得实际用时就补录，不必补齐刷题历史。不记得用时可以选择不再提醒。';
  setPracticeView(pageView === 'history');
  $('yearSelect').hidden = practiceView;
  $('rankTableBtn').hidden = practiceView;
  $('scoringNote').hidden = pageView !== 'board';
  $('saveB50Btn').hidden = pageView !== 'board';
  $('saveB50Status').hidden = pageView !== 'board';
}

/* ---------- 渲染 ---------- */

function setPracticeView(history) {
  $('pendingPanel').hidden = history;
  $('historyPanel').hidden = !history;
  $('practiceSortField').hidden = !history;

}

function renderNextStep(data) {
  const node = $('dxNext');
  clear(node);
  const pending = data.counts.pendingRecent ?? 0;
  node.hidden = !pending && data.counts.solved > 0;
  const title = pending ? `最近 ${data.reminderDays} 天有 ${pending} 道题可补录` : '从第一道 Codeforces 练习开始';
  const description = pending ? '记得实际用时就补录；不记得可选择「不再提醒」。无需补齐历史题目。'
    : data.counts.solved ? '继续练习后同步新题，或记录一次重做。所有已填成绩都能查看上榜状态。'
    : '先绑定 Codeforces 账号并同步 AC 记录，再回来填写练习用时。';
  node.append(el('div', {}, [el('strong', { text: title }), el('p', { text: description })]),
    el('a', { class: 'btn btn-primary', href: !data.counts.solved ? '/' : $(pending ? 'practicePageLink' : 'recordedPageLink').href,
      text: !data.counts.solved ? '前往 AC 记录' : pending ? '查看近期练习' : '查看全部成绩' }));
}

function statCard(label, value, sub, tone) {
  return el('div', { class: `dx-stat${tone ? ' is-' + tone : ''}` }, [
    el('span', { class: 'dx-stat-label', text: label }),
    el('strong', { class: 'dx-stat-value', text: value }),
    sub ? el('span', { class: 'dx-stat-sub', text: sub }) : null,
  ]);
}

function ratingSummary(value, sub) {
  const color = cfRatingColor(value);
  const digits = el('strong', { 'aria-label': num1(value) },
    [...num1(value).padStart(6, ' ')].map(character => el('span', {
      class: character === '.' ? 'dx-rating-point' : 'dx-rating-digit',
      'aria-hidden': 'true', 'data-empty': String(character === ' '),
      text: character === ' ' ? '\u00a0' : character,
    })));
  return el('div', { class: 'dx-stat is-primary dx-board-rating' }, [
    el('span', { class: 'dx-stat-label', text: '我的 DX Rating' }),
    el('div', { class: 'dx-result-total dx-board-rating-frame', 'data-rating-tone': color.tone,
      title: `DX Rating · ${color.label}（${color.range}）` }, [
      el('div', { class: 'dx-result-total-label' }, [el('b', { text: 'DX' }), el('span', { text: 'RATING' })]),
      el('div', { class: 'dx-result-total-score' }, [digits]),
    ]),
    el('span', { class: 'dx-stat-sub', text: sub }),
  ]);
}

function renderSummary(data) {
  const { board, counts, slots } = data;
  clear($('dxSummary'));
  const oldSum = board.old.reduce((n, s) => n + (s.score?.rating ?? 0), 0);
  const newSum = board.current.reduce((n, s) => n + (s.score?.rating ?? 0), 0);
  $('dxSummary').append(
    ratingSummary(board.rating, `旧题 ${num1(oldSum)} + 新题 ${num1(newSum)}`),
    statCard('旧题 Best 35', `${board.oldCount} / ${slots.old}`, `出题日期早于 ${data.year}-01-01 的题`),
    statCard('新题 Best 15', `${board.currentCount} / ${slots.current}`, `${data.year} 年发布的题目`),
    statCard('已记录成绩', `${counts.recorded} 题`, '未计时题目保留 AC 记录，无需补齐'),
  );
}

/**
 * 出题日期缺失时的提示。
 *
 * 这不是可以静默的状态：缺出题日期的题一律按旧题处理，而它最常见的成因是**还没同步过**
 * （`contests` 表为空），点上面那个按钮就能补上。不说的话，用户只会看到「新题区莫名其妙空了」。
 */
function renderReleaseNotice(data) {
  const notice = $('releaseNotice');
  clear(notice);
  const missing = data.counts.unknownRelease ?? 0;
  if (!missing) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  notice.append(
    el('strong', { text: `${missing} 道题还没有出题日期，暂时都按旧题处理。` }),
    el('span', {
      text:
        '可尝试「同步最新数据」补全。',
    }),
  );
}

function slotCard(slot, partition) {
  const card = scoreCard({ ...slot.entry, score: slot.score }, `${partition} #${slot.position}`);
  card.dataset.problemId = slot.entry.problemId;
  card.tabIndex = -1;
  return card;
}

function renderGrids(data) {
  $('saveB50Btn').disabled = false;
  const oldGrid = $('oldGrid');
  const newGrid = $('newGrid');
  clear(oldGrid);
  clear(newGrid);
  for (const [grid, slots] of [[oldGrid, data.board.old], [newGrid, data.board.current]]) {
    const filled = slots.filter(slot => slot.entry);
    for (const slot of filled) grid.append(slotCard(slot, grid === oldGrid ? 'B35' : 'B15'));
    if (filled.length < slots.length) grid.append(el('div', { class: 'dx-slot-summary', text: `还有 ${slots.length - filled.length} 个空位 · 继续记录练习，符合条件的成绩会自动入榜` }));
  }
  $('oldCount').textContent = ` ${data.board.oldCount} / ${data.slots.old}`;
  $('newCount').textContent = ` ${data.board.currentCount} / ${data.slots.current}`;
  $('newHint').textContent = `Best 15 · ${data.year} 年发布的题，按单题 rating 降序`;
  $('oldHint').textContent = data.board.oldCount
    ? `Best 35 · 出题日期早于 ${data.year}-01-01 的题，按单题 rating 降序`
    : `Best 35 · ${data.year} 年以前发布的题目`;
}

let pendingPage = 0;
async function changeReminder(item, button) {
  const userId=state.userId;
  button.disabled=true;
  try {
    const dismissed=item.reminderGroup!=='dismissed';
    await postJson('/api/dx/reminder',{userId,problemId:item.problemId,dismissed});
    if(userId!==state.userId)return;
    $('pendingActionStatus').textContent=dismissed?`${item.problemId} 已设为不再提醒，AC 记录仍保留。`:`${item.problemId} 已恢复，可在近期或历史清单中查看。`;
    await load(true);
  } catch(error) {if(userId===state.userId)$('pendingActionStatus').textContent=error.message;button.disabled=false;}
}
function pendingRow(item) {
  return el('div', { class: 'dx-pending-row dx-pending-entry' }, [
    el('span', { class: 'dx-pending-id', text: item.problemId }),
    el('span', { class: 'dx-pending-name', text: item.problemTitle || '' }),
    // 未评定的题也进清单：现在就能填，评级公布后自动计分进榜。
    item.problemRating === null
      ? el('span', {
          class: 'badge',
          text: item.sourceProblemId?'原题未评级':item.problemUrl?.includes('/group/')?'待核对原题':'未评定',
          title: item.sourceProblemId?'已确认原题，但 CF 未提供官方题目 Rating。可先记录用时。':item.problemUrl?.includes('/group/')?'请在账号管理的「原题配对与难度」核对来源。':'CF 尚无这道题的 Rating，可先填写用时。',
        })
      : el('span', { class: 'dx-pending-meta', text: `难度 ${item.problemRating}` }),
    el('span', {
      class: 'dx-pending-meta',
      // 年份和 AC 时间固定在第二行，不随按钮数量换行。
      text: `${item.releasedAt == null ? 'CF????' : 'CF' + new Date(item.releasedAt * 1000).getFullYear()} · AC ${fmtDateTime(item.solvedAt)}`,
      title:
        item.releasedAt === null
          ? '尚未确认原题出题日期，暂按旧题处理'
          : `出题 ${fmtDate(item.releasedAt)} · ${item.outsideYear ? '晚于所选年度' : item.isCurrent ? '新题' : '旧题'}；按比赛开始时间划分 B35 / B15`,
    }),
    // 比赛自动计时（口径 B）：窗口内按「被切的时间顺序」逐题相减算出的纯耗时。
    // 服务端算好秒数；算不出（练习解 / 跳题穿插 / 比赛时长缺失）就没有这个按钮。
    item.autoSeconds != null
      ? el('button', {
          class: 'btn btn-ghost btn-mini',
          type: 'button',
          text: `比赛计时 ${fmtClock(item.autoSeconds)}`,
          title:
            `按比赛窗口内的提交自动算出：这道题切掉的时刻减上一道切掉的题（第一道减开赛），精确到秒。` +
            `点击保存为比赛估算记录；填错的记录可在练习历史中作废。`,
          onclick: () => autoFillContestTime(item),
        })
      : null,
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: '填写用时',
      onclick: () => openModal({ ...item, recordedSeconds: null }, item.problemTitle || item.problemId),
    }),
    el('button',{class:'btn btn-ghost btn-mini',type:'button',text:item.reminderGroup==='dismissed'?'恢复提醒':'不再提醒',
      onclick:event=>changeReminder(item,event.currentTarget)}),
  ]);
}

function renderPending(data) {
  const list = $('pendingList');
  clear(list);
  const query = $('practiceSearch').value.trim().toLowerCase();
  const scope=$('pendingScope').value;
  const pending = data.pending.filter(p => p.reminderGroup===scope && (!query || p.problemId.toLowerCase().includes(query) || (p.problemTitle ?? '').toLowerCase().includes(query)));
  $('pendingEmpty').textContent = query ? '当前范围内没有匹配题目，可以切换查看范围或修改搜索。' : scope==='recent'?'近期没有需要补录的题目。直接开始下一次练习即可。':scope==='historical'?'没有历史未计时题目。':'尚未将题目设为不再提醒。';
  $('pendingSection').hidden = pending.length === 0;
  $('pendingEmpty').hidden = pending.length !== 0;
  $('pendingCount').textContent = ` ${pending.length}`;

  const pages=Math.max(1,Math.ceil(pending.length/20));pendingPage=Math.min(pendingPage,pages-1);
  $('pendingPrev').disabled=pendingPage===0;$('pendingNext').disabled=pendingPage>=pages-1;
  $('pendingPagination').textContent=`第 ${pendingPage+1} / ${pages} 页 · ${pending.length} 题`;
  for (const item of pending.slice(pendingPage*20,(pendingPage+1)*20)) list.append(pendingRow(item));
}

let recordsPage = 0;
let visibleRecords = [];
function recordFilters() {
  const filters = { query:$('recordedSearch').value, state:$('recordedFilter').value,rank:$('recordedRank').value,
    partition:$('recordedPartition').value,year:state.year,sort:$('recordedSort').value };
  for (const name of ['difficulty','achievement','seconds']) for (const end of ['Min','Max']) {
    const input=$(name+end);
    filters[name+end] = input.value.trim()==='' ? null : Number(input.value)*(name==='seconds'?60:1);
  }
  return filters;
}

function renderRecorded(data) {
  const list = $('recordedList');
  clear(list);
  const allRecords = data.recorded ?? [];
  clear($('recordsSummary'));
  const rated=allRecords.filter(r=>r.score);
  $('recordsSummary').append(statCard('已记录题目',allRecords.length,'每题最佳有效成绩','primary'),
    statCard('SSS+',rated.filter(r=>r.score.rank==='SSS+').length,'已达单题计分上限'),
    statCard('S 及以上',rated.filter(r=>r.score.achievementShown>=97).length,'完成度 ≥ 97%'),
    statCard('等待难度',allRecords.filter(r=>r.problemRating==null).length,'公布难度并同步后自动计分'));
  clear($('rankDistribution'));
  for(const rank of ['all','SSS+','SSS','SS+','SS','S+','S','other']) {
    const count=rank==='all'?allRecords.length:rated.filter(r=>rank==='other'?r.score.achievementShown<97:r.score.rank===rank).length;
    $('rankDistribution').append(el('button',{class:`btn ${$('recordedRank').value===rank?'btn-primary':'btn-ghost'}`,type:'button',
      'aria-pressed':String($('recordedRank').value===rank),text:`${rank==='all'?'全部评级':rank==='other'?'其他（S 以下）':rank} · ${count}`,
      onclick:()=>{$('recordedRank').value=rank;recordsPage=0;renderRecorded(data);}}));
  }
  let records;
  try { records=queryRecords(allRecords,recordFilters()); $('recordedEmpty').textContent='没有匹配的成绩，试试放宽范围或重置筛选。'; }
  catch(error) { records=[]; $('recordedEmpty').textContent=error.message; }
  visibleRecords=records;
  $('recordsExport').disabled=records.length===0;
  $('recordedSection').hidden = records.length === 0;
  $('recordedEmpty').hidden = records.length > 0 || allRecords.length === 0;
  $('recordedCount').textContent = `${records.length} / ${allRecords.length}`;
  const labels = { waitingRating: '等待题目难度', onBoard: '已上榜', belowCutoff: '未进入 B50', outsideYear: '出题日期晚于所选年度' };
  const size=Number($('recordedPageSize').value),pages=Math.max(1,Math.ceil(records.length/size));
  recordsPage=Math.min(recordsPage,pages-1);
  list.className=$('recordedView').value==='list'?'dx-library-list':'dx-library-grid';
  $('recordsPrev').disabled=recordsPage===0;
  $('recordsNext').disabled=recordsPage>=pages-1;
  $('recordsPagination').textContent=`第 ${recordsPage+1} / ${pages} 页 · 共 ${records.length} 条`;
  for (const item of records.slice(recordsPage*size,(recordsPage+1)*size)) {
    list.append(scoreCard(item, item.state==='waitingRating'&&item.sourceProblemId?'原题未评级':labels[item.state]));
  }
}

/** Shared score cards keep B50 and the library visually consistent. */
function scoreCard(item, statusLabel) {
    const score=item.score;
    return el('article', { class:'dx-library-card dx-card', 'data-rank':score?.rank ?? '', 'aria-label':`${item.problemId} ${item.problemTitle}` },[
      el('div',{class:'dx-library-card-head'},[el('span',{class:'dx-rank',text:score?.rank ?? '待评定'}),el('span',{class:'badge',text:statusLabel})]),
      el('div',{class:'dx-library-title'},[el('span',{class:'dx-pending-id',text:item.problemId}),
        el('h3',{},[item.problemUrl?el('a',{href:item.problemUrl,target:'_blank',rel:'noreferrer',text:item.problemTitle || item.problemId}):el('span',{text:item.problemTitle || item.problemId})])]),
      el('div',{class:'dx-library-metrics'},[
        el('div',{},[el('span',{text:'完成度'}),el('strong',{text:score?score.achievementShown.toFixed(4)+'%':'—'})]),
        el('div',{},[el('span',{text:'单题 Rating'}),el('strong',{text:num1(score?.rating)})]),
        el('div',{},[el('span',{text:'难度'}),el('strong',{text:item.problemRating ?? (item.sourceProblemId?'原题未评级':item.problemUrl?.includes('/group/')?'待核对原题':'待公布')})]),
        el('div',{},[el('span',{text:'最佳用时'}),el('strong',{text:fmtClock(item.recordedSeconds)})]),
      ]),
      el('div',{class:'dx-library-card-foot'},[el('span',{text:`首次 AC ${fmtDate(item.solvedAt)}`}),
        el('button',{class:'btn btn-mini',type:'button',text:'再练一次',onclick:()=>{
          if(timerController.running()) { $('timerRunning').scrollIntoView({behavior:'smooth'}); return; }
          $('timerProblem').value=item.problemId; $('timerKind').value='repeat'; $('timerProblem').dispatchEvent(new Event('input'));
          $('timerForm').scrollIntoView({behavior:'smooth',block:'center'}); $('timerStart').focus();
        }}),
        el('button',{class:'btn btn-ghost btn-mini',type:'button',text:'手动记录',onclick:()=>openModal(item,item.problemTitle || item.problemId)})]),
    ]);
}

function renderEmpty(data) {
  const empty = $('empty');
  if (pageView === 'practice' || pageView === 'history') { empty.hidden = true; return; }
  if (pageView === 'recorded') {
    empty.hidden = (data.recorded ?? []).length > 0;
    $('emptyTitle').textContent = '还没有题目成绩';
    $('emptyBody').textContent = '前往「用时补录」页面，为新做的题填写用时。';
    return;
  }
  const hasAny = data.board.total > 0;
  empty.hidden = hasAny;
  $('placeholder').hidden = true;
  if (hasAny) return;
  empty.hidden = false;
  if (!data.counts.solved) {
    $('emptyTitle').textContent = '这个用户还没有 Codeforces 的 AC 记录';
    $('emptyBody').textContent = '先到「账号管理」绑定 Codeforces 账号并同步，再回来填用时。';
  } else if (!data.counts.recorded) {
    $('emptyTitle').textContent = '从下一次计时练习开始积累成绩';
    $('emptyBody').textContent = '已有 AC 记录会保留，无需补齐过去的用时。准备好题目和 IDE 后，点击「开始计时」即可。';
  } else {
    $('emptyTitle').textContent = '没有可计分的题目';
    $('emptyBody').textContent = '已填用时的记录可能在等待题目难度，或出题日期晚于所选年度。请查看「全部成绩」中的状态。';
  }
}

function setPendingOpen(open) {
  $('pendingList').hidden = !open;
  $('pendingToggle').setAttribute('aria-expanded', String(open));
  $('pendingToggle').querySelector('.caret').textContent = open ? '▾' : '▸';
}

/* ---------- 填写弹窗 ---------- */

let practiceKindRevision = 0;
async function resolvePracticeKind() {
  const target = state.modalTarget;
  if (!target) return 'unknown';
  const revision = ++practiceKindRevision;
  const kind = $('practiceKind').value;
  const hint = $('practiceKindHint');
  if (kind !== 'auto') { hint.textContent = ''; return kind; }
  if ($('practiceManual').checked) { hint.textContent = '手动记录可自行选择练习类型。'; return 'unknown'; }
  const problemId = $('practiceProblem').value.trim();
  const seconds = readDuration().seconds;
  const endedAt = $('practiceDate').value ? new Date($('practiceDate').value).getTime() / 1000 : null;
  if (!problemId || !seconds || endedAt === null) {
    hint.textContent = '填写用时和结束时间后自动识别。'; return 'unknown';
  }
  hint.textContent = '正在识别…';
  try {
    if (target.kindProblem !== problemId || !target.kindLookup) {
      target.kindProblem = problemId;
      target.kindLookup = api('/api/problem', { user: String(target.userId), platform: $('practicePlatform').value.trim(), problemId });
    }
    const body = await target.kindLookup;
    if (state.modalTarget !== target || revision !== practiceKindRevision || $('practiceProblem').value.trim() !== problemId) return 'unknown';
    const inferred = inferPracticeKind(body.items, endedAt, seconds);
    hint.textContent = inferred === 'repeat' ? '已识别：熟题重做。若用了题解或提示，请手动改选。' : '暂无法判断，可手动选择；留空将记为未知。';
    return inferred;
  } catch {
    if (state.modalTarget === target && revision === practiceKindRevision) {
      target.kindLookup = null;
      hint.textContent = '识别暂不可用，可手动选择或保留未知。';
    }
    return 'unknown';
  }
}

let practiceDateRevision = 0;
let practiceDateEdited = false;
let practiceDateProblem = '';

// datetime-local needs local wall time, including seconds (not a UTC ISO string).
function practiceLocalDate(seconds) {
  const d = new Date(seconds * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function prefillPracticeDate() {
  const target = state.modalTarget;
  if (!target) return;
  if ($('practiceManual').checked) { $('practiceDateHint').textContent = '填写实际练习结束时间，不确定可留空。'; return; }
  const revision = ++practiceDateRevision;
  const problemId = $('practiceProblem').value.trim();
  if (problemId !== practiceDateProblem) {
    practiceDateProblem = problemId;
    practiceDateEdited = false;
    $('practiceDate').value = '';
  }
  if (practiceDateEdited) return;
  $('practiceDate').value = '';
  const hint = $('practiceDateHint');
  if ($('practiceOutcome').value !== 'ac' || !problemId) {
    hint.textContent = '已 AC 时自动带入平台 AC 时间；未完成时可手动填写或留空。';
    return;
  }
  hint.textContent = '正在读取本题 AC 时间…';
  try {
    const body = await api('/api/problem', { user: String(target.userId), platform: $('practicePlatform').value.trim(), problemId });
    if (revision !== practiceDateRevision || state.modalTarget !== target || practiceDateEdited
        || $('practiceProblem').value.trim() !== problemId) return;
    const accepted = body.items.filter(row => row.status === 'AC').sort((a, b) => a.submitted_at - b.submitted_at);
    const first = $('practiceKind').value === 'first';
    const record = first ? accepted[0] : accepted.at(-1);
    if (record) {
      $('practiceDate').value = practiceLocalDate(record.submitted_at);
      hint.textContent = `已带入本题${first ? '首次' : '最近一次'} AC 时间，可修改或清空。`;
    } else hint.textContent = '本地暂无该题 AC 记录，可手动填写或留空。';
  } catch {
    if (revision === practiceDateRevision && state.modalTarget === target && !practiceDateEdited)
      hint.textContent = 'AC 时间读取失败，可手动填写或留空。';
  }
}

function openModal(entry, title) {
  state.modalTarget = { ...entry, userId: state.userId, requestId: crypto.randomUUID() };
  $('practicePlatform').value = entry.platform ?? 'codeforces';
  $('practicePlatform').readOnly = !!entry.problemId;
  $('manualPracticeFields').hidden = !!entry.problemId;
  $('practiceManual').checked = !entry.problemId && !!state.meta?.users.find(u => u.id === state.userId)?.is_self;
  $('practiceTitle').value = '';
  $('practiceDifficulty').value = '';
  $('timeSubmit').textContent = '新增练习记录';
  $('timeModalTitle').textContent = '记录一次练习';
  $('timeModalSub').textContent =
    !entry.problemId ? '支持各平台练习；勾选手动记录后，无需同步或绑定平台账号。保存后可在练习历史查看。' : entry.problemRating == null
      ? `${entry.problemId} · ${title}（${entry.sourceProblemId?'原题未评级，可先记录用时':entry.problemUrl?.includes('/group/')?'原题待核对，可先记录用时':'未评定，评级公布并同步后参与 B50 排名'}）`
      : `${entry.problemId} · ${title}（难度 ${entry.problemRating}）`;
  $('practiceProblem').value = entry.problemId ?? '';
  $('practiceProblem').readOnly = !!entry.problemId;
  $('practiceOutcome').value = 'ac';
  $('practiceKind').value = 'auto';
  $('practiceKindHint').textContent = '填写用时和结束时间后自动识别。';
  $('practiceDate').value = '';
  practiceDateEdited = false;
  practiceDateProblem = '';
  state.modalTarget.dateLookup = prefillPracticeDate().then(() => resolvePracticeKind());
  $('timeHours').value = '';
  $('timeMinutes').value = '';
  $('timeSeconds').value = '';
  $('timeVoidWrap').hidden = true;
  $('timeVoid').checked = false;
  $('timeStatus').textContent = '';
  $('timeHint').textContent =
    '填写本次实际用时。日期或练习类型不确定时，可保留未知。';
  $('timeModal').hidden = false;
  // 焦点给「分」：CF 的 T97 大致在 20–40 分钟，绝大多数填法只用到这一格。
  (entry.problemId ? $('timeMinutes') : $('practiceProblem')).focus();
  if (entry.problemId) $('timeMinutes').select();
}

function openEditModal(row) {
  $('practicePlatform').value = row.platform;
  $('practicePlatform').readOnly = true;
  $('manualPracticeFields').hidden = true;
  $('practiceManual').checked = !!row.is_manual;
  practiceDateRevision++;
  practiceKindRevision++;
  state.modalTarget = { userId: state.userId, problemId: row.problem_id, editId: row.id, revision: row.revision };
  $('timeModalTitle').textContent = '修改练习记录';
  $('timeModalSub').textContent = `${row.problem_id} · ${row.problem_title || '题名未知'}`;
  $('practiceProblem').value = row.problem_id;
  $('practiceProblem').readOnly = true;
  $('practiceOutcome').value = row.outcome;
  $('practiceKind').value = row.practice_kind;
  $('practiceKindHint').textContent = '';
  $('practiceDate').value = row.attempted_at === null ? '' : practiceLocalDate(row.attempted_at);
  practiceDateEdited = true;
  practiceDateProblem = row.problem_id;
  $('practiceDateHint').textContent = '保留原有练习日期；不确定时可以清空。';
  $('timeHours').value = Math.floor(row.seconds / 3600);
  $('timeMinutes').value = Math.floor(row.seconds % 3600 / 60);
  $('timeSeconds').value = row.seconds % 60;
  $('timeVoidWrap').hidden = false;
  $('timeVoid').checked = false;
  $('timeSubmit').textContent = '保存修改';
  $('timeStatus').textContent = '';
  $('timeHint').textContent = '更正后会重新计算本题最佳成绩和 Rating。勾选作废仅作废此条记录，不保存其他修改。';
  $('timeModal').hidden = false;
  $('timeMinutes').focus();
  $('timeMinutes').select();
}

function closeModal() {
  practiceDateRevision++;
  $('timeModal').hidden = true;
  state.modalTarget = null;
}

/* ---------- 参考表：各难度 × 各评级需要多快 ---------- */

/**
 * 格子里的 T97 挪到这里来。它是曲线给的参照值，不是用户填的数，
 * 五十个格子各印一遍只会挤掉真正要看的信息 —— 但对照本身有用，所以收进一个按钮后面。
 *
 * 表由服务端 `buildRankTimeTable()` 现算，前端一个数字都不算、也不缓存。
 */
function openRankTable() {
  const table = state.data?.rankTimes;
  if (!table) {
    $('rankTableSub').textContent = '还没读到数据，先等页面加载完。';
    $('rankTableModal').hidden = false;
    return;
  }
  $('rankTableSub').textContent = '各难度达到对应等级的参考用时。';

  const body = $('rankTableBody');
  clear(body);

  const grid = el('table', { class: 'rt-table' });
  grid.append(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '题目 Rating' }),
        ...table.ranks.map((r) => el('th', { text: `${r.rank} ${r.achievement}%` })),
        el('th', { text: 'S→SSS+ 窗口' }),
      ]),
    ]),
  );
  grid.append(
    el('tbody', {},
      table.rows.map((row) =>
        el('tr', {}, [
          el('th', { text: String(row.q) }),
          ...row.seconds.map((s) => el('td', { text: fmtClock(s) })),
          el('td', { class: 'rt-dim', text: fmtClock(row.windowSeconds) }),
        ]),
      ),
    ),
  );
  body.append(el('h4', { class: 'rt-title', text: '压到多少时间能拿到哪一档' }));
  body.append(grid);
  body.append(el('a', { href: '/help.html#scoring', text: '了解评分规则', target: '_blank', rel: 'noopener' }));

  $('rankTableModal').hidden = false;
}

function closeRankTable() {
  $('rankTableModal').hidden = true;
}

/** 「比赛计时」按钮：一键把服务端算好的纯耗时写进 problem_times，然后整页重读。 */
async function autoFillContestTime(item) {
  const seconds = item.autoSeconds;
  if (seconds == null) return;
  const button = document.activeElement;
  const original = button?.textContent;
  if (button?.disabled !== undefined) {
    button.disabled = true;
    button.textContent = '写入中…';
  }
  try {
    await postJson('/api/dx/attempts', {
      userId: state.userId,
      problemId: item.problemId,
      seconds,
      outcome: 'ac', practiceKind: 'unknown', timingSource: 'contest_estimate', attemptedAt: null,
      requestId: crypto.randomUUID(),
    });
    await load();
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
    alert(`写入失败：${error.message}`);
  }
}

async function submitTime(event) {
  event.preventDefault();
  const target = state.modalTarget;
  if (!target) return;
  const voiding = target.editId && $('timeVoid').checked;
  const parsed = readDuration();
  if (!voiding && parsed.error) {
    $('timeStatus').textContent = parsed.error;
    return;
  }
  $('timeStatus').textContent = '保存中…';
  $('timeSubmit').disabled = true;
  try {
    if (voiding) {
      await postJson('/api/dx/attempts/void', { userId: target.userId, id: target.editId, revision: target.revision });
      closeModal();
      await load(true);
      return;
    }
    if ($('practiceProblem').value.trim() !== practiceDateProblem) target.dateLookup = prefillPracticeDate();
    await target.dateLookup;
    if (state.modalTarget !== target) return;
    const practiceKind = await resolvePracticeKind();
    if (state.modalTarget !== target) return;
    await postJson(target.editId ? '/api/dx/attempts/edit' : '/api/dx/attempts', {
      ...(target.editId ? { id: target.editId, revision: target.revision } : {}),
      userId: target.userId,
      problemId: $('practiceProblem').value.trim(),
      platform: $('practicePlatform').value.trim(),
      manual: $('practiceManual').checked,
      ...(!target.editId && $('practiceManual').checked ? {
        ...($('practiceTitle').value.trim() ? { title: $('practiceTitle').value.trim() } : {}),
        difficulty: $('practiceDifficulty').value === '' ? null : Number($('practiceDifficulty').value),
      } : {}),
      seconds: parsed.seconds,
      outcome: $('practiceOutcome').value, practiceKind, timingSource: 'manual',
      attemptedAt: $('practiceDate').value ? Math.floor(new Date($('practiceDate').value).getTime() / 1000) : null,
      requestId: target.requestId,
    });
    closeModal();
    await load(true);
  } catch (error) {
    $('timeStatus').textContent = error.message;
  } finally {
    $('timeSubmit').disabled = false;
  }
}

/* ---------- 载入流程 ---------- */

let practiceOffset = 0;
let previewReport = null;
let previewDownloadUrl = null;
const practiceLabels = { unknown: '类型未知', first: '首次独立', repeat: '熟题重做', assisted: '辅助解题',
  legacy: '旧记录 · 来源未知', manual: '手动计时', timer:'计时器 · AC 自动停止', contest_estimate: '比赛间隔估算', ac: 'AC', unfinished: '未完成' };

let practiceRequestRevision = 0;
async function loadPractice() {
  const revision = ++practiceRequestRevision;
  const user = state.userId;
  const data = await api('/api/dx/attempts', { user: String(user), offset: String(practiceOffset), q: $('practiceSearch').value.trim(), sort: $('practiceSort').value });
  if (user !== state.userId || revision !== practiceRequestRevision) return;
  $('practiceLoadStatus').textContent = '';
  $('practiceEmpty').textContent = $('practiceSearch').value.trim() ? '没有匹配的历史记录，试试其他题号或题名。' : '还没有练习记录，保存第一条用时后会显示在这里。';
  clear($('practiceList'));
  $('practiceSection').hidden = data.total === 0;
  $('practiceEmpty').hidden = data.total !== 0;
  $('practiceCount').textContent = data.total;
  $('practicePagination').textContent = `${data.total ? data.offset + 1 : 0}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}`;
  $('practicePrev').disabled = data.offset === 0;
  $('practiceNext').disabled = data.offset + data.limit >= data.total;
  for (const row of data.rows) {
    const score = row.score;
    const voided = row.voided_at !== null;
    const metric = (label, value) => el('div', {}, [el('span', { text: label }), el('strong', { text: value })]);
    const header = el('div', { class: 'practice-card-heading' }, [
      el('div', { class: 'dx-library-title' }, [
        el('span', { class: 'dx-pending-id', text: `${row.platform} · ${row.problem_id}${row.is_manual ? ' · 手动记录' : ''}` }),
        el('h3', { text: row.problem_title || '题名未知' }),
      ]),
      el('span', { class: 'dx-rank', text: score?.rank ?? (voided ? '已作废' : row.outcome === 'ac' ? 'AC' : '未完成') }),
    ]);
    const metrics = el('div', { class: 'dx-library-metrics practice-card-metrics' }, [
      metric('本次完成度', score ? score.achievementShown.toFixed(4) + '%' : '—'),
      metric('本次用时', fmtClock(row.seconds)),
      metric('单次 Rating', score ? num1(score.rating) : '—'),
      metric('题目难度', row.problem_rating ?? '未填写'),
    ]);
    const performance = score ? el('div', { class: 'practice-performance' }, [
      el('progress', { max: '101', value: String(score.achievementShown), 'aria-label': '本次完成度 ' + score.achievementShown.toFixed(4) + '%' }),
      el('span', { text: 'S 基准用时 ' + fmtClock(score.t97Seconds) }),
    ]) : el('p', { class: 'practice-score-note', text: row.scoreReason || '暂无评分' });
    const footer = el('div', { class: 'practice-card-footer' }, [
      el('div', { class: 'practice-card-meta' }, [
        el('span', { class: 'badge' + (row.outcome === 'ac' && !voided ? ' ac' : ''), text: row.outcome === 'ac' ? 'AC 通过' : '未完成' }),
        el('span', { class: 'badge', text: practiceLabels[row.practice_kind] }),
        el('span', { text: row.edited_at ? '手动修正' : practiceLabels[row.timing_source] }),
        el('time', { text: row.attempted_at === null ? '练习日期未知' : new Date(row.attempted_at * 1000).toLocaleString('zh-CN') }),
      ]),
    ]);
    if (!voided) footer.append(el('button', { class: 'btn btn-ghost btn-small', type: 'button', text: '修改记录', onclick: () => openEditModal(row) }));
    $('practiceList').append(el('article', { class: 'dx-library-card dx-card practice-history-card' + (voided ? ' is-voided' : ''), 'data-rank': score?.rank ?? '' }, [header, metrics, performance, footer]));
  }
}

async function openBacktest() {
  previewReport = null;
  previewDownloadUrl = null;
  $('backtestDownload').disabled = true;
  $('backtestModal').hidden = false;
  clear($('backtestBody'));
  $('backtestBody').append(el('p', { text: '正在本机回测…' }));
  const user = state.userId, year = state.year;
  try {
    const report = await api('/api/dx/backtest', { user: String(user), year: String(year) });
    if (user !== state.userId || year !== state.year || $('backtestModal').hidden) return;
    previewReport = report;
    previewDownloadUrl = '/api/dx/backtest?' + new URLSearchParams({ user: String(user), year: String(year), download: '1' });
    clear($('backtestBody'));
    $('backtestBody').append(el('p', { text: `${report.year} 年出题分区 · ${report.coverage.attempts} 次有效记录 · 日期未知 ${report.coverage.unknownAttemptDate} 次。回测只纳入定数 ${report.models.fitRange.join('–')}，未满 B35/B15 不代表充分训练。` }));
    const pct = value => value === null ? '无可计分记录' : `${(value * 100).toFixed(1)}%`;
    for (const [key, label] of [['currentBest', '当前最佳成绩（含旧记录）'], ['independentManual', '日期明确的独立手动练习'],
      ['firstOnly', '其中：首次独立'], ['repeatOnly', '其中：熟题重做']]) {
      const board = report[key];
      $('backtestBody').append(el('h4', { text: `${label} · B35 ${board.oldCount}/35，B15 ${board.newCount}/15` }));
      for (const row of board.variants) $('backtestBody').append(el('p', {
        text: `${({ 'gentle-decay-v3': '当前缓衰减曲线', 'bounded-tail-v2': '旧反比例曲线', 'linear-clipped-v1': '原截断曲线' })[row.version] || row.version}：100%≤完成度<101% 占 ${pct(row.share100To101)}；101% 占 ${pct(row.shareAt101)}；Rating ${row.rating}`,
      }));
    }
    $('backtestBody').append(el('p', { text: '报告还包含计时来源、练习类型、未完成次数，以及第 25/50/100/200/500 次有日期独立手动记录时的回测结果。未知日期记录不进入训练过程分析；本报告不会更新评分参数。' }));
    $('backtestDownload').disabled = false;
  } catch (error) { clear($('backtestBody')); $('backtestBody').append(el('p', { text: error.message })); }
}

function downloadBacktest() {
  if (!previewReport || !previewDownloadUrl) return;
  const link = el('a', { href: previewDownloadUrl, download: `algorithm-dx-backtest-${previewReport.year}.json` });
  document.body.append(link); link.click(); link.remove();
}

function currentYear() {
  return new Date().getFullYear();
}

async function loadMeta() {
  try {
    const meta = await api('/api/meta');
    state.meta = meta;
    const select = $('userSelect');
    clear(select);
    const users = meta.users ?? [];
    for (const user of users) {
      select.append(el('option', { value: String(user.id), text: user.is_self ? `${user.name}（我）` : user.name }));
    }
    const preferred = users.find(u => u.id === Number(pageParams.get('user'))) ?? users.find((u) => u.is_self) ?? users[0];
    if (preferred) {
      state.userId = preferred.id;
      select.value = String(preferred.id);
    }
    select.disabled = users.length === 0;
  } catch {
    // meta 失败也要让页面把错误显示出来，而不是白屏。
  }
}

function renderYearOptions(years) {
  const select = $('yearSelect');
  clear(select);
  for (const year of years) select.append(el('option', { value: String(year), text: `${year} 年` }));
  if (state.year !== null) select.value = String(state.year);
}

let loadRevision = 0;
async function load(preservePage = false) {
  const requestRevision = ++loadRevision;
  if (state.userId === null) {
    $('placeholder').hidden = true;
    $('empty').hidden = false;
    $('emptyTitle').textContent = '还没有任何用户';
    $('emptyBody').textContent = '先到「做题动态」页的账号管理里建一个用户。';
    return;
  }
  const params = { user: String(state.userId) };
  if (state.year !== null) params.year = String(state.year);
  const data = await api('/api/dx', params);
  if (requestRevision !== loadRevision) return;
  state.data = data;
  state.year = data.year;
  updatePageNavigation();
  renderYearOptions(data.years ?? [data.year]);
  if (pageView === 'board') {
    renderReleaseNotice(data);
    renderSummary(data);
    renderNextStep(data);
    renderGrids(data);
  } else if (pageView === 'recorded') {
    renderRecorded(data);
  } else {
    renderPending(data);
    if (!preservePage) practiceOffset = 0;
    await loadPractice();
  }
  renderEmpty(data);
  $('placeholder').hidden = true;
  $('footInfo').textContent =
    `${data.year} 年 · 更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
}

function setBusy(busy, label = '同步最新数据') {
  const button = $('syncBtn');
  button.disabled = busy;
  button.textContent = busy ? label : '同步最新数据';
}

/** 只重读本机数据（切换用户 / 年度时用）。不碰网络 —— 按钮只留给「同步最新数据」。 */
async function refresh() {
  setBusy(true, '读取中…');
  try {
    await load();
  } catch (error) {
    $('placeholder').hidden = true;
    $('empty').hidden = false;
    $('emptyTitle').textContent = '读取失败';
    $('emptyBody').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

/* ---------- 同步最新数据 ---------- */

/*
 * 这一页的按钮只有一个：**同步最新数据**。它先让服务端去抓 CF 的最新提交，再重新读取本机数据。
 *
 * 为什么不是「刷新」+ 单独的「同步」两个按钮：刷新只重读本机 SQLite，刚在 CF 上切掉的题
 * 根本不在库里，点了也看不到 —— 两个按钮区别不可见，只剩困惑。所以合成一件事：
 * 抓一次、读一次、把结果说出来。
 *
 * 只同步**当前用户绑定的 Codeforces 账号**，不碰洛谷等其他账号：这一页的口径就是 CF。
 */

const SYNC_POLL_MS = 1200;
/** 等待上限。CF 只要一个请求，正常几秒就结束；超时说明后台卡住了，不能让按钮一直转。 */
const SYNC_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setSyncNotice(text, bad = false) {
  const node = $('syncNotice');
  clear(node);
  if (!text) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.className = bad ? 'notice notice-ac is-bad' : 'notice notice-ac';
  node.textContent = text;
}

/** 当前用户在 DX 口径下唯一相关的账号：他绑定的那个 Codeforces。 */
function cfAccountId() {
  const accounts = state.meta?.accounts ?? [];
  const own = accounts.find((a) => !a.is_archived && a.user_id === state.userId && a.platform === 'codeforces');
  return own ? own.id : null;
}

/**
 * 同步回执。
 *
 * 「抓回 43 条、新入库 0 条」是最容易被读成「同步坏了」的一种状态 —— 本机已经是最新时
 * 它长得就是这个样子。所以这里把三种必须分开的情况拆开：
 * 「抓到了新的」「本机已经是最新的」「另有题因为 CF 没公布 Rating 而暂时填不了」。
 */
function describeSync(result, added, missing) {
  const at = new Date().toLocaleTimeString('zh-CN');
  if (!result) return `${at} · CF 同步结束，但没拿到这一轮的结果`;
  if (result.status === 'skipped') return `${at} · CF 同步被跳过（${result.message}）`;
  if (result.status === 'failed') return `${at} · CF 同步失败（${result.message}）`;
  const head = added.length
    ? `抓回 ${result.fetched} 条，近期可补录 ${added.length} 道：${added.slice(0, 3).join('、')}${added.length > 3 ? ' 等' : ''}`
    : `抓回 ${result.fetched} 条，同步完成`;
  const tail = missing > 0 ? `。${missing} 道题尚未公布难度，可以先记录可信用时` : '';
  return `${at} · CF 同步：${head}${tail}`;
}

/** 轮询到本轮任务结束，返回这一轮的结果数组（不再假设「只有一个账号」）。 */
async function waitForSync(jobId) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  for (;;) {
    const body = await api('/api/sync/status', {});
    const job = body.job;
    // 必须认 id：上一次同步跑完后 job 会一直挂在服务端，不认 id 会立刻读成「已完成」。
    if (job && job.id === jobId && !job.running) {
      if (job.error) throw new Error(job.error);
      return job.results ?? [];
    }
    if (Date.now() > deadline) throw new Error('等待同步超时，去「做题动态」页看同步记录');
    await sleep(SYNC_POLL_MS);
  }
}

async function syncLatest() {
  if (state.userId === null) return;
  const accountId = cfAccountId();
  if (accountId === null) {
    setSyncNotice(`用户 #${state.userId} 没有绑定 Codeforces 账号。先到「做题动态」页的账号管理里绑定，再回来同步。`, true);
    return;
  }
  const beforePending = new Set((state.data?.pending ?? []).map((p) => p.problemId));
  const beforeMissing = state.data?.counts?.missingRating ?? 0;

  setBusy(true);
  setSyncNotice('正在从 Codeforces 拉取最新提交…');
  try {
    let attempt = await requestSync(accountId);
    let results = await waitForSync(attempt.jobId);
    let result = results.find((r) => r.accountId === accountId) ?? null;
    let followedNote = '';
    if (attempt.followed) {
      if (result) {
        followedNote = '另一轮同步正在跑（多半是你在「做题动态」页点的那次），跟着它跑完';
      } else {
        // 跟着跑完的那轮没覆盖这个 CF 账号（例如从账号管理发起的单账号回补），自己再抓一次。
        setSyncNotice('刚才那轮同步没有覆盖你的 Codeforces 账号，正在单独再抓一次…');
        attempt = await requestSync(accountId);
        results = await waitForSync(attempt.jobId);
        result = results.find((r) => r.accountId === accountId) ?? null;
      }
    }

    await load();
    const added = (state.data?.pending ?? []).filter((p) => p.reminderGroup==='recent' && !beforePending.has(p.problemId)).map((p) => p.problemId);
    const missing = Math.max(0, (state.data?.counts?.missingRating ?? 0) - beforeMissing);
    const pendingCount = state.data?.counts?.pendingRecent ?? 0;

    // 同步之后**无论有没有新题都摊开清单**。这一页的下半屏就是为「填用时」存在的，
    // 而清单默认是折叠的 —— 「没有新题」不等于「没有事可做」，
    // 藏起来最容易被读成「同步没生效」，然后就真的填不了时间了。
    if (pendingCount > 0 && pageView === 'practice') {
      setPracticeView(false);
      $('pendingScope').value='recent';pendingPage=0;renderPending(state.data);
      setPendingOpen(true);
      $('pendingSection').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
    const tail = pendingCount
      ? `近期有 ${pendingCount} 道题可选补录，${pageView === 'practice' ? '清单已在下方展开' : '可到「用时补录」查看'}`
      : '近期无需补录，历史未计时题不再提醒';
    const receipt = [followedNote, describeSync(result, added, missing), tail].filter(Boolean).join('；') + '。';
    setSyncNotice(receipt, result?.status === 'failed');
  } catch (error) {
    setSyncNotice(`同步失败：${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

/* ---------- 启动 ---------- */

$('syncBtn').addEventListener('click', syncLatest);
$('saveB50Btn').addEventListener('click', async () => {
  if (!state.data) return;
  const button = $('saveB50Btn');
  button.disabled = true;
  button.textContent = '正在生成…';
  $('saveB50Status').textContent = '';
  const data = state.data;
  const name = state.meta?.users.find(user => user.id === state.userId)?.name || '玩家';
  try {
    await saveB50Image(data, name);
    $('saveB50Status').textContent = '图片已生成，请查看浏览器下载。';
  } catch (error) {
    $('saveB50Status').textContent = `保存失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '保存 B50 图片';
  }
});

$('pendingScope').addEventListener('change',()=>{pendingPage=0;if(state.data)renderPending(state.data);});
$('pendingPrev').addEventListener('click',()=>{pendingPage=Math.max(0,pendingPage-1);renderPending(state.data);});
$('pendingNext').addEventListener('click',()=>{pendingPage++;renderPending(state.data);});

const updateRecords=()=>{recordsPage=0;if(state.data)renderRecorded(state.data);};
$('recordsFilters').addEventListener('submit',event=>event.preventDefault());
$('recordsFilters').addEventListener('input',updateRecords);
$('recordsFilters').addEventListener('change',updateRecords);
$('recordsFilters').addEventListener('reset',()=>{setTimeout(updateRecords,0);});
$('recordsPrev').addEventListener('click',()=>{recordsPage=Math.max(0,recordsPage-1);renderRecorded(state.data);});
$('recordsNext').addEventListener('click',()=>{recordsPage++;renderRecorded(state.data);});
$('recordsExport').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([recordsCsv(visibleRecords)],{type:'text/csv;charset=utf-8'}));
  const link=el('a',{href:url,download:`dx-scores-${state.userId}-${state.year}.csv`}); link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('practiceBtn').addEventListener('click', () => {
  if (state.userId === null) return;
  openModal({ problemId: '', problemRating: null, recordedSeconds: null }, '填写已同步题号');
});
$('practicePrev').addEventListener('click', () => { practiceOffset = Math.max(0, practiceOffset - 50); loadPractice().catch(e => alert(e.message)); });
$('practiceNext').addEventListener('click', () => { practiceOffset += 50; loadPractice().catch(e => alert(e.message)); });
$('backtestBtn').addEventListener('click', openBacktest);
$('backtestDownload').addEventListener('click', downloadBacktest);
$('backtestClose').addEventListener('click', () => { $('backtestModal').hidden = true; });
$('backtestModal').addEventListener('click', event => { if (event.target === $('backtestModal')) $('backtestModal').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('backtestModal').hidden = true; });
$('pendingToggle').addEventListener('click', () => setPendingOpen($('pendingList').hidden));
$('timeForm').addEventListener('submit', submitTime);
$('practiceDate').addEventListener('input', () => { practiceDateEdited = true; void resolvePracticeKind(); });
for (const id of ['timeHours', 'timeMinutes', 'timeSeconds']) {
  $(id).addEventListener('input', () => { void resolvePracticeKind(); });
}
for (const id of ['practiceProblem', 'practiceOutcome', 'practiceKind']) {
  $(id).addEventListener('change', () => {
    if (state.modalTarget && !state.modalTarget.editId) state.modalTarget.dateLookup = prefillPracticeDate();
  });
}
$('timeVoid').addEventListener('change', () => { $('timeSubmit').textContent = $('timeVoid').checked ? '确认作废此条' : '保存修改'; });
$('timeCancelBtn').addEventListener('click', closeModal);
$('timeModal').addEventListener('click', (event) => { if (event.target === $('timeModal')) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('timeModal').hidden) closeModal(); });
$('rankTableBtn').addEventListener('click', openRankTable);
$('rankTableCloseBtn').addEventListener('click', closeRankTable);
$('rankTableModal').addEventListener('click', (event) => { if (event.target === $('rankTableModal')) closeRankTable(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('rankTableModal').hidden) closeRankTable(); });
$('userSelect').addEventListener('change', (event) => {
  state.userId = Number(event.target.value);
  state.year = null;
  pendingPage=0;$('pendingActionStatus').textContent='';
  recordsPage=0;
  void timerController.refresh().catch(error=>{$('timerStatus').textContent=error.message;});
  refresh();
});
$('yearSelect').addEventListener('change', (event) => {
  state.year = Number(event.target.value);
  recordsPage=0;
  refresh();
});

updatePageNavigation();
async function focusResultOnBoard({ userId, problemId }) {
  if (userId !== state.userId || !state.data) return;
  const slots = [...state.data.board.old, ...state.data.board.current];
  if (!slots.some(slot => slot.entry?.problemId === problemId)) return;
  if (pageView !== 'board') {
    pageView = 'board';
    const url = new URL(location.href);
    url.searchParams.delete('view');
    history.replaceState(null, '', url);
    updatePageNavigation();
    renderReleaseNotice(state.data);
    renderSummary(state.data);
    renderNextStep(state.data);
    renderGrids(state.data);
    renderEmpty(state.data);
  }
  const card = [...document.querySelectorAll('.dx-b50-grid [data-problem-id]')]
    .find(node => node.dataset.problemId === problemId);
  if (card) await focusB50Card(card, () => state.userId === userId && pageView === 'board');
}
const timerController=initDxTimer({getUser:()=>state.userId,onComplete:()=>load(true),onResultClose:focusResultOnBoard});
await loadMeta();
await timerController.refresh().catch(error=>{$('timerStatus').textContent=error.message;});
renderYearOptions([currentYear()]);
await refresh();
if (pageParams.get('add') === '1' && state.userId !== null) {
  openModal({ problemId: pageParams.get('problem') ?? '', platform: pageParams.get('platform') ?? 'codeforces' }, '记录练习');
}

for (const id of ['practicePlatform', 'practiceManual']) $(id).addEventListener('change', () => {
  practiceDateRevision++;
  practiceKindRevision++;
  if (!state.modalTarget) return;
  state.modalTarget.kindLookup = null;
  practiceDateProblem = '';
  state.modalTarget.dateLookup = prefillPracticeDate().then(() => resolvePracticeKind());
});


let practiceFilterTimer;
function filterPractice() {
  pendingPage=0;
  practiceOffset = 0;
  ++practiceRequestRevision;
  clearTimeout(practiceFilterTimer);
  if (state.data) renderPending(state.data);
  clear($('practiceList'));
  $('practicePrev').disabled = true;
  $('practiceNext').disabled = true;
  $('practiceLoadStatus').textContent = '正在筛选…';
  practiceFilterTimer = setTimeout(() => {
    loadPractice().catch(error => { $('practiceLoadStatus').textContent = '筛选失败：' + error.message; });
  }, 250);
}
$('practiceSearch').addEventListener('input', filterPractice);
$('practiceSort').addEventListener('change', filterPractice);

startAutoSync(() => load(true));
