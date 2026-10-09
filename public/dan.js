import { startAutoSync } from './auto-sync.js';
import { cfRatingColor } from './cf-rating-colors.js';

/*
 * 随机抽题 / 每日一题 / 段位認定 的页面逻辑。
 *
 * 这一页刻意**不缓存、不预取**任何题目信息：服务端在下发时就不给未开始的题号与链接
 * （见 src/dx/dan.ts 的口径 A），所以这里也没有任何「提前藏起来」的东西可以做 ——
 * 唯一的入口是 beginStage()，它在 claim 成功之后才拿到 url 并立刻跳转。
 * 自定义抽题（难度范围 + 标签）走同一条链：条件在 start 时发给服务端，
 * 题目照样只在服务端抽，页面在这之前拿不到它是哪一道。
 *
 * 结算是两层的，和街机原作一致：
 *   - 每道题做完 → 单题结算（复用 public/dx-result.css 那套，与普通计时结算同一张皮）；
 *   - 四道打完 → 段位認定结算页（`合格`/`不合格` 印章 + 逐题卡 + 合计）。
 * 轮询只调 /api/dan/settle（只结算不抽题），所以出了成绩会停在结算上；
 * 下一道由用户在单题结算上点「抽选下一题」才抽（/api/dan/next）。
 */

const $ = (id) => document.getElementById(id);
const KIND_LABEL = { challenge: '段位認定', single: '随机抽题', daily: '每日一题' };
const STATUS_LABEL = { active: '进行中', cleared: '通过', failed: '未通过', abandoned: '已放弃' };
const OUTCOME_LABEL = { cleared: '通关', timeout: '超时', interrupted: '中断' };
const STATUS_CLASS = { active: 'idle', cleared: 'ok', failed: 'bad', abandoned: 'bad' };
/** 结算页的印章文字：对齐原作的「合格 / 不合格」。 */
const VERDICT_TEXT = { cleared: '合格', failed: '不合格', abandoned: '中断' };
/** 页面加载时，结束在这个秒数以内的一轮会把结算补弹一次（只补一次，不反复弹旧成绩）。 */
const FRESH_RUN_SECONDS = 90;

const tz = -new Date().getTimezoneOffset();
let userId = null;
let board = null;
let clockOffset = 0;
let pollTimer = null;
let tickTimer = null;
let lastActiveId = null;
let busy = false;
/** 已经弹过结算的那几道题（`sessionId:index`），避免轮询反复弹窗。 */
let shownStages = null;
/** 待展示的单题结算；有值就弹。 */
let pendingSheet = null;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const field = (root, selector) => root.querySelector(selector);

function setMessage(text, isError = false) {
  $('message').textContent = text || '';
  $('message').classList.toggle('error', Boolean(isError));
}

async function request(path, options = {}) {
  const res = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000), ...options });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error(body?.error || `请求失败（HTTP ${res.status}）`);
  return body ?? {};
}
const get = (path) => request(path);
const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const serverNow = () => Date.now() / 1000 + clockOffset;
const fmtClock = (seconds) => {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const fmtLimit = (seconds) => `${Math.round(seconds / 60)} 分钟`;
const fmtDuration = (seconds) => (seconds == null ? '—'
  : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : `${seconds} 秒`);
const fmtHMS = (seconds) => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
  .map((n) => String(n).padStart(2, '0')).join(':');
const signed = (value, digits = 1) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

function difficultyNode(value, caption) {
  const wrap = el('div', 'dan-difficulty');
  wrap.append(document.createTextNode(String(value)), el('small', '', caption));
  return wrap;
}

/** DX Rating 的分段数字（与 dx-timer.js 同一套 class，样式来自 dx-result.css）。 */
function ratingDigits(text) {
  const host = el('strong');
  host.setAttribute('aria-label', text);
  for (const character of text.padStart(Math.max(6, text.length), ' ')) {
    const node = el('span', character === '.' ? 'dx-rating-point' : 'dx-rating-digit');
    node.dataset.empty = String(character === ' ');
    node.setAttribute('aria-hidden', 'true');
    if (character === ' ') node.textContent = '\u00a0'; else node.textContent = character;
    host.append(node);
  }
  return host;
}

async function boot() {
  const meta = await get('/api/meta');
  const users = meta.users ?? [];
  // 抽题/认定必须绑在本人身上：计时器要拿本人绑定的 CF 账号去核对 AC。
  const self = users.find((user) => user.is_self) ?? users[0];
  if (!self) {
    setMessage('还没有用户。请先在「账号管理」里创建「我」并绑定 Codeforces 账号。', true);
    return;
  }
  userId = self.id;
  await refresh();
}

async function refresh() {
  const data = await get(`/api/dan?user=${userId}&tz=${tz}`);
  board = data;
  clockOffset = data.serverNow - Date.now() / 1000;
  render();
}

function render() {
  if (!board) return;
  detectFinished();
  renderIdle();
  renderActive();
  renderHistory();
  if (!board.poolReady) setMessage('本地还没有题库缓存。点任意一个档位会自动抓一次全量题目（约 1.5 MB，之后 6 小时内复用）。');
  schedule();
  drainSheet();
}

/**
 * 找出「刚刚结算」的那道题。
 * 第一次渲染只建立基线，不弹窗 —— 否则中途刷新页面会把旧成绩全部弹一遍。
 */
/** 已结束的一轮要弹哪一屏：有成绩就弹最后一道的单题结算，按钮上给「查看本轮结算」。 */
function sheetFor(run, finished) {
  const last = run.stages.filter((stage) => stage.outcome).at(-1) ?? null;
  return last ? { session: run, stage: last, finished, run } : { session: run, stage: null, finished, run };
}

function detectFinished() {
  const session = board.active;
  const settled = new Set();
  if (session) {
    for (const stage of session.stages) if (stage.outcome) settled.add(`${session.id}:${stage.index}`);
    // 记下来：下一帧 active 消失时就靠它判断「刚刚结束的是哪一轮」。
    lastActiveId = session.id;
  }

  if (shownStages === null) {
    shownStages = settled;
    // 页面加载时这一轮其实已经打完了（服务端的同步任务常常比刷新更快把 AC 结算掉）：
    // 把结果补给你，但只补刚结束不久的那一轮，避免每次打开页面都把旧成绩弹一遍。
    if (!session) {
      const run = (board.history ?? []).find((row) => row.finishedAt !== null && serverNow() - row.finishedAt < FRESH_RUN_SECONDS);
      if (run) {
        for (const stage of run.stages) shownStages.add(`${run.id}:${stage.index}`);
        pendingSheet = sheetFor(run, true);
      }
    }
    return;
  }

  if (session) {
    const fresh = session.stages.filter((stage) => stage.outcome && !shownStages.has(`${session.id}:${stage.index}`));
    shownStages = settled;
    if (fresh.length) pendingSheet = { session, stage: fresh[fresh.length - 1], finished: false };
    return;
  }

  // 进行中的那一轮消失了：刚打完（或刚被放弃）。
  if (lastActiveId) {
    const finished = (board.history ?? []).find((run) => run.id === lastActiveId);
    lastActiveId = null;
    if (finished) {
      const key = finished.stages.map((stage) => `${finished.id}:${stage.index}`).filter((k) => !shownStages.has(k));
      for (const stage of finished.stages) shownStages.add(`${finished.id}:${stage.index}`);
      setMessage(`本轮已结束：${STATUS_LABEL[finished.status] ?? finished.status}${finished.totalRating === null ? '' : ` · 总分 ${finished.totalRating.toFixed(1)}`}`, finished.status !== 'cleared');
      // 最后一道的单题结算先弹，按钮上给「查看本轮结算」；没有可弹的就直接弹整轮。
      pendingSheet = key.length ? sheetFor(finished, true) : { session: finished, stage: null, finished: true, run: finished };
    }
  }
}

function tierButton(tier, kind) {
  const button = el('button', 'dan-tier');
  button.type = 'button';
  button.append(el('strong', '', tier.name));
  // 随机段位的限时随抽到的难度走，报不出一个确定的数字，就照实说。
  const timing = tier.perStageLimit
    ? '限时按当题难度'
    : kind === 'challenge' ? `每道限时 ${fmtLimit(tier.limitSeconds)}` : `限时 ${fmtLimit(tier.limitSeconds)}`;
  button.append(el('small', '', `${tier.minRating}–${tier.maxRating} · ${timing}`));
  if (tier.draw === 'problem') button.append(el('small', 'dan-tier-warn', '按题目均匀 · 不保证难度分布'));
  else if (tier.perStageLimit) button.append(el('small', 'dan-tier-warn', '按 rating 均匀 · 每个难度等概率'));
  button.disabled = busy;
  button.addEventListener('click', () => startRun(kind, tier.key));
  return button;
}

function renderIdle() {
  const session = board.active;
  $('idle').hidden = Boolean(session);
  if (session) return;

  $('dailyDate').textContent = board.dateKey ?? '';
  // 每日一题的难度带按水平定：把带子说出去，用户才知道「今天的难度为什么是这个」。
  const bandNote = $('dailyBandNote');
  const band = board.dailyBand;
  if (band?.center !== null && band?.center !== undefined) {
    bandNote.textContent = `按你的水平定带：等效 Rating ${Math.round(band.equivalentRating)} → ${band.minRating}–${band.maxRating}。同一天怎么刷新都是同一道。`;
  } else {
    bandNote.textContent = '还没有可以定带的成绩（B50 里没有带用时的 AC），先从 800–2600 全段抽。';
  }
  const dailyHost = $('dailyDifficulty');
  dailyHost.replaceChildren();
  if (board.daily) dailyHost.append(difficultyNode(board.daily.difficulty, '今日难度 · CF 官方 Rating'));
  else dailyHost.append(el('p', 'dan-note', board.poolReady ? '这个难度带里今天已经没有你没做过的题了。' : '题库缓存未就绪。'));
  $('dailyStart').disabled = busy || !board.daily;

  const singles = $('singleTiers');
  singles.replaceChildren(...(board.tiers ?? []).map((tier) => tierButton(tier, 'single')));
  const challenges = $('challengeTiers');
  challenges.replaceChildren(...(board.tiers ?? []).map((tier) => tierButton(tier, 'challenge')));
  const randoms = $('randomTiers');
  randoms.replaceChildren(...(board.randomTiers ?? []).map((tier) => tierButton(tier, 'challenge')));
  renderTagCloud();
}

/** 选中的标签存在这里（Set），点标签切换；空集 = 不限标签。 */
const pickedTags = new Set();

/** 计数器要说清两件事：选了几个、多个标签之间是「含任一」而不是「全含」。 */
function syncTagCount() {
  $('tagCount').textContent = pickedTags.size ? `已选 ${pickedTags.size} 个 · 含任一` : '不限标签';
}

function renderTagCloud() {
  const host = $('tagCloud');
  host.replaceChildren();
  const tags = board.tags ?? [];
  const known = new Set(tags.map((tag) => tag.name));
  // 缓存刷新后个别标签可能消失：留在选择集里只会让服务端拒一次，先清掉。
  for (const name of pickedTags) if (!known.has(name)) pickedTags.delete(name);
  if (!tags.length) {
    host.append(el('span', 'dan-note', board.poolReady ? '题库没有标签数据（缓存是老版本，点一次抽题后会自动刷新）。' : '题库缓存未就绪。'));
  } else {
    for (const tag of tags) {
      const chip = el('button', 'dan-tag');
      chip.type = 'button';
      chip.append(document.createTextNode(tag.name), el('small', '', String(tag.count)));
      chip.classList.toggle('on', pickedTags.has(tag.name));
      chip.addEventListener('click', () => {
        if (pickedTags.has(tag.name)) pickedTags.delete(tag.name); else pickedTags.add(tag.name);
        chip.classList.toggle('on', pickedTags.has(tag.name));
        syncTagCount();
      });
      host.append(chip);
    }
  }
  syncTagCount();
}

function progressBar(session) {
  const bar = el('div', 'dan-progress');
  for (let index = 1; index <= session.stageCount; index += 1) {
    const stage = session.stages.find((row) => row.index === index);
    const cls = !stage ? '' : stage.outcome === 'cleared' ? 'done' : stage.outcome ? 'fail' : 'now';
    bar.append(el('span', `dan-pip ${cls}`.trim()));
  }
  return bar;
}

function stageCard(session, stage) {
  const card = el('div', 'dan-stage');
  const head = el('div', 'dan-stage-head');
  head.append(el('strong', '', `第 ${stage.index} / ${session.stageCount} 道`));
  if (stage.claimed && stage.deadlineAt) {
    const clock = el('span', 'dan-clock');
    clock.dataset.deadline = String(stage.deadlineAt);
    head.append(clock);
  } else {
    head.append(el('span', 'dan-chip', '还没开始'));
  }
  card.append(head);
  card.append(difficultyNode(stage.difficulty, '题目难度 · CF 官方 Rating'));

  const actions = el('div', 'dan-actions');
  if (!stage.claimed) {
    card.append(el('p', 'dan-note', '这道题的题号与链接现在不在这个页面的任何地方 —— 点下去才开始揭题并起计时。'));
    const start = el('button', 'btn btn-primary', '开始做题');
    start.type = 'button';
    start.disabled = busy;
    start.addEventListener('click', () => beginStage(session));
    actions.append(start);
  } else {
    const go = el('a', 'btn btn-primary', '回到 Codeforces');
    go.href = stage.problemUrl ?? '#';
    go.rel = 'noreferrer noopener';
    actions.append(go);
    const done = el('button', 'btn btn-ghost', '立即检查 AC');
    done.type = 'button';
    done.disabled = busy;
    done.addEventListener('click', () => settleNow());
    actions.append(done);
    if (stage.problemId) actions.append(el('span', 'dan-chip', stage.problemId));
  }
  card.append(actions);
  return card;
}

function renderActive() {
  const host = $('active');
  host.replaceChildren();
  const session = board.active;
  host.hidden = !session;
  if (!session) return;

  const head = el('div', 'dan-active-head');
  head.append(el('h2', '', `${session.tierName} · ${KIND_LABEL[session.kind] ?? session.kind}`));
  head.append(el('span', `dan-badge ${STATUS_CLASS[session.status] ?? 'idle'}`, STATUS_LABEL[session.status] ?? session.status));
  // 逐题限时的模式报不出确定的数，就照实说（与档位按钮同一句话）。
  head.append(el('span', 'dan-chip', session.perStageLimit ? '限时按当题难度' : `限时 ${fmtLimit(session.limitSeconds)} / 道`));
  head.append(el('span', 'dan-chip', `${session.minRating}–${session.maxRating}`));
  if (session.tags?.length) head.append(el('span', 'dan-chip', `标签：${session.tags.join('、')}`));
  host.append(head);
  host.append(progressBar(session));

  const current = session.stages.find((stage) => !stage.outcome);
  if (current) host.append(stageCard(session, current));
  else if (session.stages.some((stage) => stage.outcome)) {
    // 出了成绩就停在这儿，等用户点了「抽选下一题」再抽。
    const last = session.stages.filter((stage) => stage.outcome).at(-1);
    host.append(el('p', 'dan-note', `第 ${last.index} 道已结算，正在等你看结算 —— 点结算页上的按钮才会抽下一道。`));
  }
  if (session.stages.some((stage) => stage.outcome)) {
    const review = el('button', 'btn btn-ghost', '再看一次上一道结算');
    review.type = 'button';
    review.addEventListener('click', () => { pendingSheet = { session, stage: session.stages.filter((s) => s.outcome).at(-1), finished: false }; drainSheet(); });
    const actions0 = el('div', 'dan-actions');
    actions0.append(review);
    host.append(actions0);
  }

  const settled = session.stages.filter((row) => row.outcome);
  if (settled.length) {
    const list = el('div', 'dan-run-list');
    for (const stage of settled) list.append(settledLine(stage));
    host.append(list);
  }

  const actions = el('div', 'dan-actions');
  const abandon = el('button', 'btn btn-ghost', '放弃这一轮');
  abandon.type = 'button';
  abandon.disabled = busy;
  abandon.addEventListener('click', () => abandonRun(session.id));
  actions.append(abandon);
  host.append(actions);
}

function settledLine(stage) {
  const row = el('div', 'dan-run-row');
  row.append(el('span', '', `#${stage.index}`));
  const middle = el('span');
  middle.append(document.createTextNode(`${stage.difficulty} 分`));
  if (stage.rank) middle.append(document.createTextNode(` · ${stage.rank} ${stage.achievement?.toFixed(2) ?? ''}%`));
  if (stage.rating !== null) middle.append(document.createTextNode(` · ${stage.rating.toFixed(1)} 分`));
  middle.append(document.createTextNode(` · ${OUTCOME_LABEL[stage.outcome] ?? stage.outcome}`));
  row.append(middle);
  row.append(el('span', '', stage.problemId ?? '—'));
  return row;
}

function renderHistory() {
  const host = $('history');
  host.replaceChildren();
  const runs = board.history ?? [];
  if (!runs.length) {
    host.append(el('p', 'dan-note', '还没有记录。上面抽一道，做完就会留在这里。'));
    return;
  }
  for (const run of runs) host.append(runCard(run));
}

function runCard(run) {
  const card = el('article', 'dan-run');
  const head = el('div', 'dan-run-head');
  head.append(el('strong', '', `${run.tierName} · ${KIND_LABEL[run.kind] ?? run.kind}`));
  head.append(el('span', `dan-badge ${STATUS_CLASS[run.status] ?? 'idle'}`, STATUS_LABEL[run.status] ?? run.status));
  head.append(el('span', 'dan-chip', new Date(run.startedAt * 1000).toLocaleString('zh-CN', { hour12: false })));
  if (run.tags?.length) head.append(el('span', 'dan-chip', `标签：${run.tags.join('、')}`));
  if (run.totalRating !== null) head.append(el('span', 'dan-total', `总分 ${run.totalRating.toFixed(1)}`));
  card.append(head);

  const list = el('div', 'dan-run-list');
  for (const stage of run.stages) {
    const row = el('div', 'dan-run-row');
    row.append(el('span', '', `#${stage.index}`));
    const middle = el('span');
    middle.append(document.createTextNode(`${stage.difficulty} 分`));
    if (stage.rank) middle.append(document.createTextNode(` · ${stage.rank}`));
    if (stage.achievement !== null) middle.append(document.createTextNode(` · ${stage.achievement.toFixed(2)}%`));
    if (stage.seconds !== null) middle.append(document.createTextNode(` · ${fmtDuration(stage.seconds)}`));
    if (stage.outcome) middle.append(document.createTextNode(` · ${OUTCOME_LABEL[stage.outcome] ?? stage.outcome}`));
    row.append(middle);
    if (stage.problemUrl) {
      const link = el('a', '', stage.problemId);
      link.href = stage.problemUrl;
      link.rel = 'noreferrer noopener';
      row.append(link);
    } else {
      row.append(el('span', '', '—'));
    }
    list.append(row);
  }
  card.append(list);

  const actions = el('div', 'dan-actions');
  const open = el('button', 'btn btn-ghost', '查看结算');
  open.type = 'button';
  open.addEventListener('click', () => openRunResult(run));
  actions.append(open);
  card.append(actions);
  return card;
}

/* ---------------- 单题结算（与普通计时结算同一张皮） ---------------- */

let stageDialog = null;
function buildStageDialog() {
  const dialog = el('dialog', 'dx-result');
  dialog.setAttribute('aria-labelledby', 'danResultTitle');
  dialog.innerHTML = `<div class="dx-result-sheet">
    <button class="dx-result-close" type="button" aria-label="关闭结算">×</button>
    <div class="dx-result-kicker">STAGE <b></b><span></span></div>
    <h2 id="danResultTitle" class="dx-result-clear"></h2>
    <div class="dx-result-track"><div class="dx-result-track-icon" aria-hidden="true">DX<span>✦</span></div>
      <div class="dx-result-track-content"><div class="dx-result-track-heading"><span class="dx-result-kind"></span><span class="dx-result-problem"></span><i>DX</i></div>
        <h3 class="dx-result-name"></h3></div>
      <div class="dx-result-level"><small>LEVEL</small><strong></strong></div></div>
    <section class="dx-result-achievement-section" aria-label="达成率结算">
      <div class="dx-result-achievement-top"><div class="dx-result-achievement-label">达成率 <span>›››✦</span></div>
        <div class="dx-result-best"><span>此前最佳 <b></b></span><span class="dx-result-achievement-delta"></span></div></div>
      <div class="dx-result-achievement"><span class="dx-result-achievement-value"></span></div>
      <span class="dx-result-record" hidden>NEW RECORD</span></section>
    <div class="dx-result-main"><div class="dx-result-performance">
        <div class="dx-result-rank" aria-label="本次评级"></div>
        <div class="dx-result-badges"><div class="dx-result-award"><span class="dx-result-medal" aria-label="accepted"><b>AC</b><small>Accepted</small></span></div>
          <div class="dx-result-award dx-result-award-cs"><span class="dx-result-medal dx-result-medal-cs" aria-label="clean solve"><b>CS</b><small>Clean Solve</small></span></div></div></div>
      <div class="dx-result-detail"><div class="dx-result-time"><small>PLAY TIME</small><strong></strong><small class="dx-result-limit"></small></div>
        <div class="dx-result-verdicts" aria-label="本次提交判定"></div>
        <div class="dx-result-rating"><small>Rating</small><strong></strong><span class="dx-result-single-delta"></span></div></div></div>
    <div class="dx-result-bottom"><div class="dx-result-total"><div class="dx-result-total-label"><b>DX</b><span>RATING</span></div>
      <div class="dx-result-total-score"></div><span class="dx-result-total-delta"></span></div></div>
    <div class="dan-sheet-strip"></div>
    <div class="dx-result-footer"><button class="dx-result-next" type="button"></button></div></div>`;
  document.body.append(dialog);
  field(dialog, '.dx-result-close').addEventListener('click', () => dialog.close());
  return dialog;
}

function showStageSheet(pending) {
  const { session, stage, finished } = pending;
  if (!stage) { openRunResult(pending.run ?? session); return; }
  stageDialog ??= buildStageDialog();
  const dialog = stageDialog;
  const score = stage.comparison?.currentScore ?? null;
  const comparison = stage.comparison ?? null;

  field(dialog, '.dx-result-kicker b').textContent = String(stage.index).padStart(2, '0');
  field(dialog, '.dx-result-kicker span').textContent = `${session.tierName} · ${session.stageCount} 道中的第 ${stage.index} 道`;
  field(dialog, '#danResultTitle').textContent = stage.outcome === 'cleared' ? 'CLEAR!' : stage.outcome === 'timeout' ? 'TIME UP' : 'INTERRUPTED';
  field(dialog, '.dx-result-kind').textContent = KIND_LABEL[session.kind] ?? session.kind;
  field(dialog, '.dx-result-problem').textContent = stage.problemId ?? '';
  field(dialog, '.dx-result-name').textContent = stage.title ?? stage.problemId ?? '';
  field(dialog, '.dx-result-level strong').textContent = String(stage.difficulty);

  const achievement = field(dialog, '.dx-result-achievement-value');
  achievement.textContent = stage.achievement === null ? (stage.outcome === 'cleared' ? '已通关' : '没有成绩') : `${stage.achievement.toFixed(4)}%`;
  const previous = comparison?.previousScore ?? null;
  const delta = field(dialog, '.dx-result-achievement-delta');
  if (previous && score) {
    const improvement = score.achievementShown - previous.achievementShown;
    delta.textContent = `${signed(improvement, 4)}%`;
    delta.dataset.direction = improvement < 0 ? 'down' : 'up';
  } else {
    delta.textContent = previous ? '暂无对比' : '首次通过';
    delta.dataset.direction = 'up';
  }
  field(dialog, '.dx-result-best b').textContent = previous ? `${previous.achievementShown.toFixed(4)}%` : '—';
  field(dialog, '.dx-result-record').hidden = !(previous && score && score.achievementShown > previous.achievementShown);

  field(dialog, '.dx-result-rank').textContent = stage.rank ?? (stage.outcome === 'timeout' ? '—' : '');
  field(dialog, '.dx-result-time strong').textContent = stage.seconds === null ? '—' : fmtHMS(stage.seconds);
  field(dialog, '.dx-result-limit').textContent = `限时 ${Math.round(stage.limitSeconds / 60)}:00`;
  field(dialog, '.dx-result-rating strong').textContent = String(stage.difficulty);
  field(dialog, '.dx-result-rating').lastElementChild.textContent = previous && score ? signed(score.rating - previous.rating, 1) : '';

  // AC / CS 勋章
  const verdicts = stage.verdicts ?? {};
  const cleanSolve = (verdicts.AC ?? 0) > 0 && Object.entries(verdicts).every(([verdict, count]) => verdict === 'AC' || count === 0);
  field(dialog, '.dx-result-award-cs').hidden = !cleanSolve;
  const verdictHost = field(dialog, '.dx-result-verdicts');
  verdictHost.replaceChildren();
  for (const verdict of ['AC', 'WA', 'TLE', 'RE', 'CE', 'MLE', 'OTHER']) {
    const count = verdicts[verdict] ?? 0;
    if (!count && !['AC', 'WA'].includes(verdict)) continue;
    const tag = el('div', `dx-result-verdict dx-result-verdict-${verdict.toLowerCase()}`);
    tag.append(el('span', '', verdict), el('strong', '', String(count)));
    verdictHost.append(tag);
  }

  const totalHost = field(dialog, '.dx-result-total-score');
  totalHost.replaceChildren();
  const totalFrame = field(dialog, '.dx-result-total');
  if (comparison) {
    const totalText = Number(comparison.ratingAfter).toFixed(1);
    totalHost.append(ratingDigits(totalText));
    field(dialog, '.dx-result-total-delta').textContent = signed(Number(comparison.ratingDelta), 1);
    const color = cfRatingColor(Number(comparison.ratingAfter));
    totalFrame.dataset.ratingTone = color.tone;
    totalFrame.title = `DX Rating · ${color.label}（${color.range}）`;
  } else {
    totalHost.append(ratingDigits('—'));
    field(dialog, '.dx-result-total-delta').textContent = '—';
    delete totalFrame.dataset.ratingTone;
    totalFrame.title = '本次没有生成 B50 对比（超时或中断不计分）';
  }

  const done = session.stages.filter((row) => row.outcome);
  const accumulated = done.reduce((sum, row) => sum + (row.rating ?? 0), 0);
  const strip = field(dialog, '.dan-sheet-strip');
  strip.replaceChildren(
    el('span', '', `本轮 ${done.length} / ${session.stageCount} 完成`),
    el('span', '', `已累计 ${accumulated.toFixed(1)} 分`),
    el('span', '', finished || done.length >= session.stageCount ? '本轮已打完'
      // 随机段位下一道还没抽出来，限时是多少现在还不知道 —— 不编一个数字。
      : session.perStageLimit ? '下一道限时按当题难度'
        : `下一道仍是${session.tierName}，限时 ${fmtLimit(session.limitSeconds)}`),
  );

  const next = field(dialog, '.dx-result-next');
  const isLast = finished || done.length >= session.stageCount;
  next.textContent = isLast ? '查看本轮结算 ›' : '抽选下一题 ›';
  next.onclick = () => { dialog.close(); if (isLast) openRunResult(pending.run ?? session); else settleThenDraw(); };

  if (!dialog.open) dialog.showModal();
}

/** 轮询/按钮触发的「只结算」：不抽题。 */
async function settleNow() {
  if (busy) return;
  busy = true;
  try {
    const data = await post('/api/dan/settle', { userId, tz });
    clockOffset = data.serverNow - Date.now() / 1000;
    await refresh();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

/** 「抽选下一题」：这一步才真的抽。 */
async function settleThenDraw() {
  if (busy) return;
  busy = true;
  setMessage('正在抽下一道…');
  try {
    const data = await post('/api/dan/next', { userId, tz });
    clockOffset = data.serverNow - Date.now() / 1000;
    if (data.poolEmpty) setMessage('这个档位已经没有你没做过的题了，换一个档位吧。', true);
    else setMessage('');
    await refresh();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

function drainSheet() {
  if (!pendingSheet) return;
  if (stageDialog?.open) return;
  const pending = pendingSheet;
  pendingSheet = null;
  showStageSheet(pending);
}

/* ---------------- 段位認定结算页（对齐原作 UI_DNM_Result_* 的构成） ---------------- */

/** 难度色号 → 逐曲卡的渐变（与 CF 分色同一套边界；violet 是原作 MASTER 的紫）。 */
const TRACK_TONE = {
  red: ['#e8564f', '#a3211c'], orange: ['#f08c3a', '#a85a12'],
  violet: ['#8b6cf0', '#4a2fb0'], blue: ['#4a7fe0', '#1e3f96'],
  cyan: ['#3fa8c4', '#166b83'], green: ['#4aa85c', '#1d6b30'],
  gray: ['#7b8391', '#3f4652'], unrated: ['#7b8391', '#3f4652'],
};

let resultDialog = null;
function buildResultDialog() {
  const dialog = el('dialog', 'dan-result');
  dialog.setAttribute('aria-labelledby', 'danRunTitle');
  dialog.innerHTML = `<div class="dan-result-sheet">
    <button class="dan-result-close" type="button" aria-label="关闭结算">×</button>
    <div class="dan-result-body">
      <div class="dan-result-art">
        <h2 class="dan-result-title" id="danRunTitle">段位認定</h2>
        <p class="dan-result-sub"></p>
        <ol class="dan-result-tracks"></ol>
        <div class="dan-result-bottomrow">
          <div class="dan-result-verdict">
            <img class="dan-result-verdict-img" alt="">
            <small class="dan-result-verdict-count"></small>
          </div>
          <div class="dan-result-life"><span></span></div>
          <div class="dan-result-totalblock">
            <span class="dan-total-label">总达成率</span>
            <strong class="dan-total-ach dan-gold"></strong>
            <span class="dan-total-score"><small>DX分数</small><b></b></span>
          </div>
        </div>
      </div>
      <p class="dan-result-note"></p>
      <div class="dan-result-actions">
        <button class="dan-result-again" type="button"></button>
        <button class="dan-result-ok" type="button">好</button>
      </div>
    </div></div>`;
  document.body.append(dialog);
  field(dialog, '.dan-result-close').addEventListener('click', () => dialog.close());
  field(dialog, '.dan-result-ok').addEventListener('click', () => dialog.close());
  return dialog;
}

/** `.dan-gold` 要两层（描边 ::before + 渐变填充 ::after），两层都读 `data-text`。 */
function goldNode(cls, text) {
  const node = el('strong', cls, text);
  node.dataset.text = text;
  return node;
}

function openRunResult(run) {
  resultDialog ??= buildResultDialog();
  const dialog = resultDialog;
  const verdict = run.status === 'cleared' ? 'cleared' : run.status === 'failed' ? 'failed' : 'abandoned';
  const cleared = run.stages.filter((stage) => stage.outcome === 'cleared');
  const scored = cleared.filter((stage) => stage.achievement !== null);

  dialog.dataset.verdict = verdict;
  // 底图用原作素材，按模式选：档位挑战是「段位認定」那一版，
  // 小/大随机段位是「ランダム段位認定」那一版（原作本来就把这两件事分成两块屏）。
  // 页头文字与两侧水引都烘焙在底图里，所以标题 h2 只留给读屏。
  field(dialog, '.dan-result-art').dataset.art =
    run.tier === 'small_random' || run.tier === 'big_random' ? 'random' : 'dani';
  const verdictImg = field(dialog, '.dan-result-verdict-img');
  verdictImg.src = run.status === 'cleared' ? '/assets/maimai/verdict-clear.png' : '/assets/maimai/verdict-fail.png';
  verdictImg.alt = VERDICT_TEXT[run.status] ?? '中断';
  field(dialog, '.dan-result-verdict-count').textContent = `${cleared.length} / ${run.stageCount} 道通关`;

  const limitText = run.perStageLimit ? '每道限时按当题难度' : `每道限时 ${fmtLimit(run.limitSeconds)}`;
  field(dialog, '.dan-result-sub').textContent =
    `${run.tierName} · ${run.minRating}–${run.maxRating} · 共 ${run.stageCount} 道 · ${limitText}`
    + ` · ${run.draw === 'problem' ? '按题目均匀' : '按 rating 均匀'}`
    + (run.tags?.length ? ` · 标签 ${run.tags.join('、')}` : '');

  const tracks = field(dialog, '.dan-result-tracks');
  tracks.replaceChildren();
  for (const stage of run.stages) {
    const tone = TRACK_TONE[cfRatingColor(stage.difficulty).tone] ?? TRACK_TONE.violet;
    const item = el('li', 'dan-track');
    item.dataset.outcome = stage.outcome ?? 'pending';
    // 可 / 不可 用原作那两枚印（UI_DNM_Icon_Result_01/02），不再用 CSS 画。
    const stamp = el('img', 'dan-track-stamp');
    stamp.src = stage.outcome === 'cleared' ? '/assets/maimai/stamp-clear.png' : '/assets/maimai/stamp-fail.png';
    stamp.alt = stage.outcome === 'cleared' ? '通过' : '未通过';
    item.append(stamp);

    const card = el('div', 'dan-track-card');
    card.style.setProperty('--tc1', tone[0]);
    card.style.setProperty('--tc2', tone[1]);

    // 「封面」那一格放题号：我们抽的是 CF 题、没有曲绘，放题号比放装饰诚实。
    const [contest, index] = (stage.problemId ?? '').split(':');
    const jacket = el('div', 'dan-track-jacket');
    jacket.append(el('b', '', index || '?'), el('small', '', contest || '未开始'));
    card.append(jacket);

    const info = el('div', 'dan-track-info');
    const head = el('div', 'dan-track-head');
    head.append(el('span', 'dan-track-no', `STAGE ${String(stage.index).padStart(2, '0')}`));
    head.append(el('span', 'dan-track-diff', `${stage.difficulty} 分`));
    head.append(el('span', 'dan-track-name', stage.title ?? '—'));
    info.append(head);

    const achievement = el('div', 'dan-track-ach');
    achievement.append(el('span', 'dan-track-achlabel', '达成率'));
    // 没有成绩时别套金色描边数字：6px 描边会把一个破折号画成一根小横杠。
    achievement.append(stage.achievement === null
      ? goldNode('dan-track-achvalue', '—')
      : goldNode('dan-track-achvalue dan-gold', `${stage.achievement.toFixed(4)}%`));
    achievement.append(el('span', 'dan-track-judge',
      stage.outcome === 'cleared' ? (stage.rank ?? '通关')
        : stage.outcome === 'timeout' ? '超时' : stage.outcome === 'interrupted' ? '中断' : '未开始'));
    info.append(achievement);
    card.append(info);

    const side = el('div', 'dan-track-side');
    side.append(el('span', 'dan-track-lv', String(stage.difficulty)));
    const score = el('span', 'dan-track-score');
    score.append(el('small', '', 'DX分数'), el('b', '', stage.rating === null ? '—' : stage.rating.toFixed(1)));
    side.append(score);
    side.append(el('small', 'dan-track-limit', `限时 ${fmtLimit(stage.limitSeconds)}`));
    card.append(side);
    item.append(card);
    tracks.append(item);
  }

  // 原作这一格是显示剩余生命的心；我们没有生命值，用「通关几道」占这一格。
  const life = field(dialog, '.dan-result-life');
  life.dataset.state = run.status === 'cleared' ? 'ok' : 'bad';
  field(dialog, '.dan-result-life span').replaceChildren(
    document.createTextNode(String(cleared.length)), el('small', '', `/${run.stageCount}`));

  // 原作的「总达成率」是四首歌达成率之和、「DX分数」是四首 DX 分数之和；
  // 这里对应各道达成率之和与各道单题 rating 之和。
  const totalAchievement = scored.reduce((sum, stage) => sum + stage.achievement, 0);
  const totalText = scored.length ? `${totalAchievement.toFixed(4)}%` : '—';
  const totalNode = field(dialog, '.dan-total-ach');
  totalNode.textContent = totalText;
  totalNode.dataset.text = totalText;
  // 同理：四道全没成绩时这里是一个破折号，套上金色描边会变成一根横杠。
  totalNode.classList.toggle('dan-gold', scored.length > 0);
  field(dialog, '.dan-total-score b').textContent = run.totalRating === null ? '—' : run.totalRating.toFixed(1);

  const deltas = run.stages.map((stage) => stage.comparison?.ratingDelta).filter((value) => typeof value === 'number');
  let note = run.status === 'cleared'
    ? `${run.stageCount} 道都在限时内解出。每道题的成绩已经作为单题记录存进练习记录，并计入 B50。`
    : run.status === 'failed'
      ? `有一道超出了限时，本轮就此结束。超时那道没有成绩（计时器被取消、不生成练习记录）；已经通过的 ${cleared.length} 道照样计入 B50。`
      : `这一轮被中断或放弃，没有生成总成绩。已经通过的 ${cleared.length} 道照样计入 B50。`;
  // 大随机段位不保证难度分布，这是它的定义而不是抽题出了 bug —— 必须说清楚。
  if (run.draw === 'problem') {
    note += ' 这一轮是大随机段位：抽题按题目均匀，难度分布就是题库的真实分布，'
      + '所以「连着好几道都是同一个难度」是正常结果。';
  }
  if (deltas.length) note += ` 本轮对 B50 总分的影响：${signed(Math.round(deltas.reduce((sum, value) => sum + value, 0) * 10) / 10)}。`;
  field(dialog, '.dan-result-note').textContent = note;

  const again = field(dialog, '.dan-result-again');
  again.textContent = `再来一轮 · ${run.tierName}`;
  again.onclick = () => {
    dialog.close();
    if (run.kind === 'challenge') startRun('challenge', run.tier);
    // 自定义轮次的「再来」要带上当时的条件，否则变成全段乱抽。
    else if (run.tier === 'custom') startRun('single', 'custom',
      { minRating: run.minRating, maxRating: run.maxRating, tags: run.tags ?? [] });
    else startRun('single', run.tier);
  };

  if (!dialog.open) dialog.showModal();
}

/* ---------------- 动作 ---------------- */

async function startRun(kind, tier, extra = {}) {
  if (busy) return;
  busy = true;
  setMessage(kind === 'daily' ? '正在抽今天的题…' : '正在抽题…');
  render();
  try {
    await post('/api/dan/start', { userId, kind, tier, tz, ...extra });
    await refresh();
    setMessage('');
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

async function beginStage(session) {
  if (busy) return;
  busy = true;
  setMessage('正在锁题并起计时…');
  try {
    const claimed = await post('/api/dan/claim', { userId, sessionId: session.id });
    // 链接唯一的出口：这一跳之前，题目从没进过这个页面。
    window.location.href = claimed.url;
  } catch (error) {
    setMessage(error.message, true);
    busy = false;
    await refresh();
  }
}

async function abandonRun(sessionId) {
  if (busy || !window.confirm('放弃这一轮？本轮会记为「已放弃」，不计入成绩。')) return;
  busy = true;
  try {
    await post('/api/dan/abandon', { userId, sessionId });
    await refresh();
    setMessage('已放弃这一轮。');
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

/**
 * 做了题就轮询。这里调的是 **settle 而不是 next**：只结算、不抽题，
 * 所以出了成绩会停在结算页上，等用户自己点「抽选下一题」。没在计时就不轮询。
 */
function schedule() {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  const session = board?.active;
  const current = session?.stages.find((stage) => !stage.outcome);
  if (session && current?.claimed) {
    pollTimer = setTimeout(async () => {
      try {
        const data = await post('/api/dan/settle', { userId, tz });
        clockOffset = data.serverNow - Date.now() / 1000;
        await refresh();
      } catch {
        schedule();
      }
    }, 5000);
  }
  tickTimer = setInterval(() => {
    for (const node of document.querySelectorAll('.dan-clock[data-deadline]')) tick(node);
  }, 1000);
  for (const node of document.querySelectorAll('.dan-clock[data-deadline]')) tick(node);
}

function tick(node) {
  const left = Number(node.dataset.deadline) - serverNow();
  node.textContent = left > 0 ? `剩 ${fmtClock(left)}` : '已超时';
  node.classList.toggle('urgent', left > 0 && left <= 60);
}

$('dailyStart').addEventListener('click', () => startRun('daily'));
$('customStart').addEventListener('click', () => {
  const min = Number($('customMin').value), max = Number($('customMax').value);
  // 本地先拦一道明显的错（非数字、区间反了），省一次网络往返；真正的口径校验在服务端。
  if (!Number.isFinite(min) || !Number.isFinite(max)) { setMessage('难度上下限要是数字。', true); return; }
  if (min > max) { setMessage('难度下限不能大于上限。', true); return; }
  startRun('single', 'custom', { minRating: min, maxRating: max, tags: [...pickedTags] });
});
$('refresh').addEventListener('click', () => refresh().catch((error) => setMessage(error.message, true)));

boot()
  .then(() => startAutoSync(() => refresh()))
  .catch((error) => setMessage(error.message, true));