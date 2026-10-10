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
  // 盘面是一张 980×928 的固定设计尺寸舞台，里面所有组件都用**官方预制体量出来的像素坐标**
  // （见 dan.css 顶部注释）。窄屏横向滚动，不做响应式重排 —— 重排就还原不出来了。
  dialog.innerHTML = `<div class="dan-result-sheet">
    <button class="dan-result-close" type="button" aria-label="关闭结算">×</button>
    <div class="dan-result-body">
      <div class="dan-result-art">
        <div class="dan-result-stage">
          <h2 class="dan-result-title" id="danRunTitle">段位認定</h2>
          <ol class="dan-result-tracks"></ol>
          <div class="dan-bottom">
            <!-- 左下那格：原版是段位名牌（十段/皆伝…）。我们发的是档位不是段位名，
                 所以照原版的字重与描边把**档位名**写在里面，而不是盖一枚合格印。 -->
            <div class="dan-verdict">
              <span class="dan-plate-name"></span>
              <small class="dan-verdict-count"></small>
            </div>
            <div class="dan-life">
              <img class="dan-life-base" alt="">
              <span class="dan-life-count"></span>
            </div>
            <!-- 原作这两块的**位置**写在底图的预留白格里（见 dan.css）：标签进白格，
                 大数字落在色带上，下面是官方那个白底的「DX分数」条。 -->
            <div class="dan-total-row">
              <span class="dan-total-label">总达成率</span>
              <span class="dan-total-num"></span>
            </div>
            <div class="dan-dxscore-row">
              <span class="dan-dxscore-label">DX分数</span>
              <span class="dan-dxscore-num"></span>
            </div>
          </div>
        </div>
      </div>
      <p class="dan-result-sub"></p>
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

/* ---------- 官方数字字体（图集逐格切） ----------
 * 图集是规整的 4×4 网格，每格的位置由素材包里同名的 Sprite 给出
 * （UI_CMN_Num_90p_0 … _14），不用自己量。
 * 「下标 → 字符」是拿对照表一张张看出来的：
 *   白字族（UI_CMN_Num_26p/90p）0-9 · [10]'+' · [11]'-' · [12]',' · [13]'.' · [14]'%'
 *   分数族（UI_NUM_Score_0001111_*）0-9 · [10]'+' · [11]'/' · [12]'%' · [13]'.'
 * 白字族各带一层 _Outline（同布局的实心剪影）—— 官方就是这么叠出描边数字的：
 * 两个背景层同一位置，填充层画在描边层之上。
 */
const NUM_INDEX = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '+': 10, '-': 11, ',': 12, '.': 13, '%': 14,
};
const SCORE_INDEX = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '+': 10, '/': 11, '%': 12, '.': 13,
};
/**
 * 图集每格留了空白边（90p 那格 89px 宽、字形只有 63px），照格宽排字会读起来「一个字一个字
 * 分开」。官方是等距密排（字与字几乎贴上），所以每格按 `advance` 收回去一点，见 numText。
 */
const NUM_FONTS = {
  // `ink` 是那几格**窄字形**的墨迹（左空 + 墨宽 + 步进），单位是图集像素 —— 图集按格宽排字
  // 会把小数点两侧各空出 20/74 格，看着就是「403 ・ 1998」中间断了一截。
  // `baseline` 是数字墨迹底线在格高里的比例，画小数点方块时按它贴底。
  n26: { fill: 'num-26p', outline: 'num-26p-outline', atlas: [136, 160], cell: [34, 40], advance: 24, baseline: 0.825, dot: 'drawn', chars: NUM_INDEX, ink: { '.': [14, 8, 16] } },
  n90: { fill: 'num-90p', outline: 'num-90p-outline', atlas: [356, 420], cell: [89, 105], advance: 67, baseline: 0.886, dot: 'drawn', chars: NUM_INDEX, ink: { '.': [32, 24, 32] } },
  // 分数数字是**三套**同布局不同颜色的图集（自带颜色，不再叠描边层）：
// blue / gold / red，按达成率高低换。官方还有一张 `UI_NUM_Score_0001111_Base`，
// 但那是一张**空图集**（整张几乎全透明，量下来 16 格一个字形都没有），不能用；
// 「%」字形也正好只有蓝/金/红三张 —— 所以官方的档位就是三档，不是四档。
'score-blue': { fill: 'num-score-blue', outline: '', atlas: [296, 392], cell: [74, 98], advance: 67, baseline: 0.836, dot: 'atlas', chars: SCORE_INDEX, ink: { '.': [21, 33, 36] } },
  'score-gold': { fill: 'num-score-gold', outline: '', atlas: [296, 392], cell: [74, 98], advance: 67, baseline: 0.836, dot: 'atlas', chars: SCORE_INDEX, ink: { '.': [21, 33, 36] } },
  'score-red': { fill: 'num-score-red', outline: '', atlas: [296, 392], cell: [74, 98], advance: 67, baseline: 0.836, dot: 'atlas', chars: SCORE_INDEX, ink: { '.': [21, 33, 36] } },
};
const NUM_COLS = 4;
/** 达成率末尾那个大「%」字形：官方按分数分色，蓝/金/红三张。 */
const PERCENT_ART = { gold: 'score-per-gold.png', blue: 'score-per-blue.png', red: 'score-per-red.png' };

/**
 * 达成率取哪一档颜色 —— 原作就是按分数换 `UI_NUM_Score_0001111_*` 那一套。
 * 官方那套只有三色（Base 是空图集，「%」字形也只有三张），所以档位就是三档，
 * 边界取原作评级：100% 以上（SSS/SSS+）金、97% 以上（S～SS+）蓝、再低红。
 */
function scoreTone(achievement) {
  if (achievement >= 100) return 'gold';
  if (achievement >= 97) return 'blue';
  return 'red';
}

/** 达成率数字 + 官方「%」字形。 */
function achievementNumber(achievement, height) {
  const tone = scoreTone(achievement);
  const art = PERCENT_ART[tone];
  const text = achievement.toFixed(4);
  const wrap = numText(text, `score-${tone}`, height);
  // 「%」是独立字形（img 的 alt 为空），读屏那行 aria-label 要把它补回去。
  wrap.setAttribute('aria-label', `${text}%`);
  const percent = el('img', 'dan-per');
  percent.src = `/assets/maimai/${art}`;
  percent.alt = '';
  // 官方那个「%」跟数字差不多高，而且**贴着**最后一个数字。`score-per-*` 是 80×80 的方图、
  // 四周留白（墨迹 x 8..70 / y 10..69），直排会在数字和 % 之间多出一截空隙，所以放大一点
  // 再把左边那圈留白用负边距抵掉。
  percent.style.height = `${Math.round(height * 1.1)}px`;
  percent.style.marginLeft = `${-Math.round(height * 0.16)}px`;
  wrap.append(percent);
  return wrap;
}

/** DX 分数（其实是单题 rating）用的深蓝：和边框里的标题条、标签同一个色 —— 不走分数色，
 * 那套三色专门留给达成率。 */
const DX_NUM_COLOR = '#0d2a63';

/**
 * 把一串字符渲染成官方数字贴图。`height` 是字高（px，按 980×928 的设计尺寸）。
 * 每格拆成两个叠起来的层：官方 `_Outline` 剪影上深色（描边）+ 官方填充图集。
 * 之所以要两个真元素而不是两个 background 层：图集是**纯白剪影**（游戏运行时才上色），
 * background 层没法单独染色，而伪元素又只能画在宿主背景之上（描边会盖住填充）。
 * `color` 给定时就用图集当**遮罩**把数字染成这个颜色 —— 这正是游戏里给白字族上色的做法
 * （分数族自带颜色，不走这条路；注意 `UI_NUM_Score_0001111_Base` 是张空图集，不能用）。
 * 字体里没有的字符（例如数字族没有 '/'）退回普通文字，不会静默丢字符。
 *
 * `opts.outline === false`：**不叠描边层**。小号的 DX 分数在官方那里是干净的深蓝数字，
 * 叠一层 4px 描边会糊成一团 —— 小字一律不用描边。
 * `opts.trim === false`：不收紧字距（留给需要等宽对齐的场景）。
 */
const NUM_OUTLINE_COLOR = '#2b3350';
function numText(text, fontKey, height, color, opts = {}) {
  const font = NUM_FONTS[fontKey];
  const scale = height / font.cell[1];
  const wrap = el('span', `dan-num dan-num-${fontKey}`);
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', text);
  wrap.style.height = `${height}px`;
  const chars = [...text];
  chars.forEach((ch, index) => {
    const cell = el('i', 'dan-num-char');
    cell.style.height = `${height}px`;
    if (index === chars.length - 1) cell.classList.add('dan-num-last');
    // 白字族图集里的小数点是个**居中的方块**（26p 那张只有 8×8、y 18..25，正在字高中间），
    // 小字号下读起来像断字符。这两个字号自己画一个贴底的方块当小数点。
    if (ch === '.' && font.dot === 'drawn') {
      const dot = Math.max(3, Math.round(height * 0.19));
      const step = Math.round(height * 0.3);
      cell.classList.add('dan-num-dot');
      cell.style.width = `${dot}px`;
      cell.style.setProperty('--dan-num-trim', `${dot - step}px`);
      const ink = el('span', 'dan-num-dotink');
      ink.style.width = `${dot}px`;
      ink.style.height = `${dot}px`;
      ink.style.background = color ?? NUM_OUTLINE_COLOR;
      ink.style.marginBottom = `${Math.round(height * (1 - font.baseline))}px`;
      cell.append(ink);
      wrap.append(cell);
      return;
    }
    const idx = font.chars[ch];
    if (idx === undefined) {
      cell.textContent = ch;
      cell.classList.add('dan-num-plain');
      if (color) cell.style.color = color;
      wrap.append(cell);
      return;
    }
    // 窄字形（小数点、逗号）按**墨迹**裁格：格宽取墨宽、背景左移掉左空，步进另给一个小的，
    // 不然格子里那 20px 空白会整个变成字距。其余字形保持格宽，字距只按 advance 收。
    const box = font.ink?.[ch];
    const inkLeft = box ? box[0] : 0;
    const inkWidth = box ? box[1] : font.cell[0];
    const advance = box ? box[2] : (font.advance ?? font.cell[0]);
    const sx = (idx % NUM_COLS) * font.cell[0];
    const sy = Math.floor(idx / NUM_COLS) * font.cell[1];
    const size = `${font.atlas[0] * scale}px ${font.atlas[1] * scale}px`;
    const pos = `${-(sx + inkLeft) * scale}px ${-sy * scale}px`;
    cell.style.width = `${inkWidth * scale}px`;
    if (opts.trim !== false) {
      // 每格右边收回 (格宽 − 步进)：官方数字是密排的，留白会把一串数字读散。
      // 注意是**负**边距 —— 这里给的是「要收回多少」，CSS 里带负号用。
      cell.style.setProperty('--dan-num-trim', `${(inkWidth - advance) * scale}px`);
    }
    if (font.outline && opts.outline !== false) {
      const outline = el('b', 'dan-num-outline');
      const url = `url(/assets/maimai/${font.outline}.png)`;
      outline.style.setProperty('background-color', NUM_OUTLINE_COLOR);
      for (const prop of ['mask-image', '-webkit-mask-image']) outline.style.setProperty(prop, url);
      for (const prop of ['mask-size', '-webkit-mask-size']) outline.style.setProperty(prop, size);
      for (const prop of ['mask-position', '-webkit-mask-position']) outline.style.setProperty(prop, pos);
      for (const prop of ['mask-repeat', '-webkit-mask-repeat']) outline.style.setProperty(prop, 'no-repeat');
      cell.append(outline);
    }
    const fill = el('b', 'dan-num-fill');
    const fillUrl = `url(/assets/maimai/${font.fill}.png)`;
    if (color) {
      // 白字族是纯白剪影：当遮罩 + 纯色背景 = 想染什么色就什么色（游戏里也是运行时染色）。
      fill.style.setProperty('background-color', color);
      for (const prop of ['mask-image', '-webkit-mask-image']) fill.style.setProperty(prop, fillUrl);
      for (const prop of ['mask-size', '-webkit-mask-size']) fill.style.setProperty(prop, size);
      for (const prop of ['mask-position', '-webkit-mask-position']) fill.style.setProperty(prop, pos);
      for (const prop of ['mask-repeat', '-webkit-mask-repeat']) fill.style.setProperty(prop, 'no-repeat');
    } else {
      fill.style.backgroundImage = fillUrl;
      fill.style.backgroundSize = size;
      fill.style.backgroundPosition = pos;
    }
    cell.append(fill);
    wrap.append(cell);
  });
  return wrap;
}

/**
 * 官方评级徽章：`UI_GAM_Rank_*` —— 游戏内那套**单级全套**（D/C/B/BB/BBB/A/AA/AAA/S/S+/SS/SS+/SSS/SSS+）。
 *
 * 之前用的是 `UI_CMN_TabTitle_Rank_*`，但那是**页签标题**用的区间图：AAA 那张画的是
 * 「A～AAA」、BBB 那张是「～BBB」，摆在逐题卡片上根本不是那一级的评级（而且没有
 * D/C/B/BB/A/AA 这些级，低分全挤到同一张牌上）。换成游戏内那套之后 14 级各有一张。
 */
const RANK_ART = {
  'SSS+': 'gam-rank-sssp.png', SSS: 'gam-rank-sss.png', 'SS+': 'gam-rank-ssp.png', SS: 'gam-rank-ss.png',
  'S+': 'gam-rank-sp.png', S: 'gam-rank-s.png',
  AAA: 'gam-rank-aaa.png', AA: 'gam-rank-aa.png', A: 'gam-rank-a.png',
  BBB: 'gam-rank-bbb.png', BB: 'gam-rank-bb.png', B: 'gam-rank-b.png',
  C: 'gam-rank-c.png', D: 'gam-rank-d.png',
};

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
  const clearedRun = run.status === 'cleared';
  // 左下那格是原版的段位名牌：照原版写**名字**（我们发档位不发段位名），不盖合格印。
  // 通关几道另起一行小字放在名字下面，别把名字挤掉。
  const plateName = field(dialog, '.dan-plate-name');
  plateName.textContent = run.tierName;
  plateName.dataset.len = String([...run.tierName].length);
  // 结论（合格/不合格/中断）从原来那枚印改成名字下面的小字：印让位给段位名，
  // 但「到底过没过」这句话还是得留着。
  field(dialog, '.dan-verdict-count').textContent =
    `${VERDICT_TEXT[run.status] ?? '中断'} · ${cleared.length} / ${run.stageCount} 道通关`;

  const limitText = run.perStageLimit ? '每道限时按当题难度' : `每道限时 ${fmtLimit(run.limitSeconds)}`;
  field(dialog, '.dan-result-sub').textContent =
    `${run.tierName} · ${run.minRating}–${run.maxRating} · 共 ${run.stageCount} 道 · ${limitText}`
    + ` · ${run.draw === 'problem' ? '按题目均匀' : '按 rating 均匀'}`
    + (run.tags?.length ? ` · 标签 ${run.tags.join('、')}` : '');

  const tracks = field(dialog, '.dan-result-tracks');
  tracks.replaceChildren();
  for (const stage of run.stages) {
    const color = cfRatingColor(stage.difficulty);
    const tone = TRACK_TONE[color.tone] ?? TRACK_TONE.violet;
    const item = el('li', 'dan-track');
    item.dataset.outcome = stage.outcome ?? 'pending';
    // 逐题行的纵向节距是官方的 122px（见 dan.css）。
    item.style.top = `${152 + 122 * (stage.index - 1)}px`;
    // 底色变量挂在这一行上：乐曲边框和 LV 块都读它（边框官方是难度色烘死的，我们按自己的分档上色）。
    item.style.setProperty('--tc1', tone[0]);
    item.style.setProperty('--tc2', tone[1]);

    // 可 / 不可 用原作那两枚印（UI_DNM_Icon_Result_01/02）。
    const stamp = el('img', 'dan-track-stamp');
    stamp.src = stage.outcome === 'cleared' ? '/assets/maimai/stamp-clear.png' : '/assets/maimai/stamp-fail.png';
    stamp.alt = stage.outcome === 'cleared' ? '通过' : '未通过';
    item.append(stamp);

    // 行底板还是原作那张（UI_DNM_Result_musicBase_01）；边框比它小一圈，四角会露出底板。
    item.append(el('div', 'dan-track-plate'));

    // 乐曲边框：照原作 UI_CMN_RSL_KopMBase_* 的版式画一层 ——
    // 外圈浅色环 + 主色场 + 底部浅色带 + 左侧白曲绘槽 + 深蓝标题条 + 白色达成率框。
    // 官方那五张（BSC/ADV/EXP/MST/MST_Re）颜色与难度名都烘死在图里，套不上我们的 CF 分档。
    const frame = el('div', 'dan-track-frame');
    frame.append(el('span', 'dan-track-titlebar'));
    const achBox = el('div', 'dan-track-achbox');
    // 官方白框左上角那行小字（原作烘在边框贴图里，我们画边框所以自己写）。
    // 用原版那三个字：`達成率` —— 别自己写英文，官方结算这一行就是日文。
    achBox.append(el('small', 'dan-track-achlabel', '達成率'));
    // 官方分数图集（按分数分色）+ 官方彩色「%」字形 —— 这是这一行最大的一块数字。
    // 没有成绩时用白字族的「—」，**染深蓝**：白字族是纯白剪影，落在达成率那个白框上会看不见
    // （numText 里没这个字形，会退回普通文字，不会静默丢字符）。
    const achValue = stage.achievement === null
      ? numText('—', 'n90', 44, DX_NUM_COLOR)
      : achievementNumber(stage.achievement, 44);
    achValue.classList.add('dan-track-achvalue');
    achBox.append(achValue);
    frame.append(achBox);
    // 官方的 でらっくスコア 那一格改成**跟着题目放左边**（右边那一列只剩评级与限时）。
    const dxBox = el('div', 'dan-track-dxbox');
    dxBox.append(el('small', 'dan-track-dxlabel', 'DX分数'));
    // 这一格是**小字**：不叠描边层 —— 官方那处也是干净的深蓝数字，叠上去只会糊。
    const dx = stage.rating === null
      ? numText('—', 'n26', 16, DX_NUM_COLOR, { outline: false })
      : numText(String(stage.rating.toFixed(1)), 'n26', 16, DX_NUM_COLOR, { outline: false });
    dx.classList.add('dan-track-dxnum');
    dxBox.append(dx);
    item.append(frame);
    item.append(dxBox);

    // 官方的 JacketImage_S 那一格：我们抽的是 CF 题、没有曲绘，槽里放按档位色上色的题号。
    const [contest, index] = (stage.problemId ?? '').split(':');
    const jacket = el('div', 'dan-track-jacket');
    jacket.append(el('b', '', index || '?'), el('small', '', contest || '未开始'));
    item.append(jacket);

    // 官方的 JaketTrack 那一格（行首那块小牌）：放第几道。
    // **排在曲绘槽之后 append**：官方那张小牌就在 MusicJacket_Base 里、压在曲绘槽左上角上。
    item.append(el('span', 'dan-track-no', `STAGE ${String(stage.index).padStart(2, '0')}`));

    // 官方的难度名牌那一格烘的是难度名（MASTER 大師…）。我们这边对应的是**档位名**：
    // 这一格原来写「CF 分 + 分数分组」两行，可这题的成绩旁边已经写了达成率与单题分，
    // 再把 1700 / 1600–1899 摆上来只是重复，所以只留名字一行。
    const diffTab = el('span', 'dan-track-diff');
    diffTab.append(el('b', '', run.tierName));
    item.append(diffTab);

    // 题目名写在标题条上（两者坐标相同，都是边框内坐标）。抽到的题在本人提交里还没有
    // 记录时，退回题号 —— 空着比写「—」更难看，题号至少能对上。
    frame.append(el('span', 'dan-track-name', stage.title ?? stage.problemId ?? '—'));

    // 评级用官方徽章；超时／中断／未开始没有评级，退回文字。
    if (stage.outcome === 'cleared' && RANK_ART[stage.rank]) {
      const badge = el('img', 'dan-track-badge');
      badge.src = `/assets/maimai/${RANK_ART[stage.rank]}`;
      badge.alt = stage.rank;
      item.append(badge);
    } else {
      item.append(el('span', 'dan-track-judge',
        stage.outcome === 'timeout' ? '超时' : stage.outcome === 'interrupted' ? '中断' : '未开始'));
    }

    // 右边一列只留两件：评级（上面）与限时（下面，用官方 DerakkuScore_NUM 那格的白牌）。
    // CF 难度分挪进了难度名牌，所以这里不再单独占一格。
    item.append(el('small', 'dan-track-limit', `限时 ${fmtLimit(stage.limitSeconds)}`));

    tracks.append(item);
  }

  // 原作这一格是显示剩余生命的心；我们没有生命值，用心里的那个数字表示「四道里过了几道」。
  // 不写 4/4：数字图集里没有「/」这个字形，退回普通文字会被两边数字的描边吃掉看不见；
  // 过没过、过几道，白框名字下面那行小字写得更清楚。
  const life = field(dialog, '.dan-life');
  life.dataset.state = run.status === 'cleared' ? 'ok' : 'bad';
  field(dialog, '.dan-life-base').src = clearedRun
    ? '/assets/maimai/life-base-green.png' : '/assets/maimai/life-base-red.png';
  field(dialog, '.dan-life-base').alt = clearedRun ? '通关' : '未通关';
  field(dialog, '.dan-life-count').replaceChildren(numText(String(cleared.length), 'n26', 46));

  // 原作的「总达成率」是四首歌达成率之和、「でらっくスコア」是四首单曲 DX 分数之和。
  // 我们这边对应：各道达成率之和，以及**各道单题 rating 之和**（同一道题进 B50 用的就是
  // 这个单题 rating；之和只是展示，不等于 B50 总分真的涨这么多）。
  const totalAchievement = scored.reduce((sum, stage) => sum + stage.achievement, 0);
  field(dialog, '.dan-total-num').replaceChildren(
    scored.length ? achievementNumber(totalAchievement, 60) : numText('—', 'n90', 60, DX_NUM_COLOR));
  field(dialog, '.dan-dxscore-num').replaceChildren(
    numText(run.totalRating === null ? '—' : String(run.totalRating.toFixed(1)), 'n90', 30, DX_NUM_COLOR, { outline: false }));

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
    else startRun(run.kind === 'daily' ? 'daily' : 'single', run.tier);
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
  node.textContent = left > 0 ? `剩 ${fmtClock(left)}` : '限时已到 · 等待同步判定';
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