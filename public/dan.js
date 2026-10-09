import { startAutoSync } from './auto-sync.js';

/*
 * 随机抽题 / 每日一题 / 段位認定 的页面逻辑。
 *
 * 这一页刻意**不缓存、不预取**任何题目信息：服务端在下发时就不给未开始的题号与链接
 * （见 src/dx/dan.ts 的口径 A），所以这里也没有任何「提前藏起来」的东西可以做 ——
 * 唯一的入口是 beginStage()，它在 claim 成功之后才拿到 url 并立刻跳转。
 */

const $ = (id) => document.getElementById(id);
const KIND_LABEL = { challenge: '段位認定', single: '随机抽题', daily: '每日一题' };
const STATUS_LABEL = { active: '进行中', cleared: '通过', failed: '未通过', abandoned: '已放弃' };
const OUTCOME_LABEL = { cleared: '通关', timeout: '超时', interrupted: '中断' };
const STATUS_CLASS = { active: 'idle', cleared: 'ok', failed: 'bad', abandoned: 'bad' };

const tz = -new Date().getTimezoneOffset();
let userId = null;
let board = null;
let clockOffset = 0;
let pollTimer = null;
let tickTimer = null;
let lastActiveId = null;
let busy = false;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

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

function difficultyNode(value, caption) {
  const wrap = el('div', 'dan-difficulty');
  wrap.append(document.createTextNode(String(value)), el('small', '', caption));
  return wrap;
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
  // 刚结束的那一轮：把结果说出来，而不是让进行中的面板静默消失。
  if (lastActiveId && !board.active) {
    const finished = (board.history ?? []).find((run) => run.id === lastActiveId);
    if (finished) setMessage(`本轮已结束：${STATUS_LABEL[finished.status] ?? finished.status}${finished.totalRating === null ? '' : ` · 总分 ${finished.totalRating.toFixed(1)}`}`, finished.status !== 'cleared');
    lastActiveId = null;
  } else if (board.active) {
    lastActiveId = board.active.id;
  }
  renderIdle();
  renderActive();
  renderHistory();
  if (!board.poolReady) setMessage('本地还没有题库缓存。点任意一个档位会自动抓一次全量题目（约 1.5 MB，之后 6 小时内复用）。');
  schedule();
}

function tierButton(tier, kind) {
  const button = el('button', 'dan-tier');
  button.type = 'button';
  button.append(el('strong', '', tier.name));
  button.append(el('small', '', `${tier.minRating}–${tier.maxRating} · ${kind === 'challenge' ? `每道限时 ${fmtLimit(tier.limitSeconds)}` : `限时 ${fmtLimit(tier.limitSeconds)}`}`));
  button.disabled = busy;
  button.addEventListener('click', () => startRun(kind, tier.key));
  return button;
}

function renderIdle() {
  const session = board.active;
  $('idle').hidden = Boolean(session);
  if (session) return;

  $('dailyDate').textContent = board.dateKey ?? '';
  const dailyHost = $('dailyDifficulty');
  dailyHost.replaceChildren();
  if (board.daily) dailyHost.append(difficultyNode(board.daily.difficulty, '今日难度 · CF 官方 Rating'));
  else dailyHost.append(el('p', 'dan-note', board.poolReady ? '今天已经没有你没做过的题了。' : '题库缓存未就绪。'));
  $('dailyStart').disabled = busy || !board.daily;

  const singles = $('singleTiers');
  singles.replaceChildren(...(board.tiers ?? []).map((tier) => tierButton(tier, 'single')));
  const challenges = $('challengeTiers');
  challenges.replaceChildren(...(board.tiers ?? []).map((tier) => tierButton(tier, 'challenge')));
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
    const done = el('button', 'btn btn-ghost', '已 AC，抽下一道');
    done.type = 'button';
    done.disabled = busy;
    done.addEventListener('click', () => advance());
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
  head.append(el('span', 'dan-chip', `限时 ${fmtLimit(session.limitSeconds)} / 道`));
  head.append(el('span', 'dan-chip', `${session.minRating}–${session.maxRating}`));
  host.append(head);
  host.append(progressBar(session));

  const current = session.stages.find((stage) => !stage.outcome);
  if (current) host.append(stageCard(session, current));

  for (const stage of session.stages.filter((row) => row.outcome)) {
    const line = el('p', 'dan-note', `第 ${stage.index} 道 ${stage.difficulty} 分 · ${OUTCOME_LABEL[stage.outcome] ?? stage.outcome}`
      + (stage.rank ? ` · ${stage.rank} ${stage.achievement?.toFixed(2) ?? ''}%` : '')
      + (stage.rating !== null ? ` · ${stage.rating.toFixed(1)} 分` : ''));
    host.append(line);
  }

  const actions = el('div', 'dan-actions');
  const abandon = el('button', 'btn btn-ghost', '放弃这一轮');
  abandon.type = 'button';
  abandon.disabled = busy;
  abandon.addEventListener('click', () => abandonRun(session.id));
  actions.append(abandon);
  host.append(actions);
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
  return card;
}

async function startRun(kind, tier) {
  if (busy) return;
  busy = true;
  setMessage(kind === 'daily' ? '正在抽今天的题…' : '正在抽题…');
  render();
  try {
    await post('/api/dan/start', { userId, kind, tier, tz });
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

async function advance() {
  if (busy) return;
  busy = true;
  try {
    const data = await post('/api/dan/next', { userId, tz });
    clockOffset = data.serverNow - Date.now() / 1000;
    if (data.poolEmpty) setMessage('这个档位已经没有你没做过的题了，换一个档位吧。', true);
    await refresh();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    busy = false;
    render();
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

/** 做了题就轮询：等后台同步发现 CF 上的 AC，服务端结算后自动抽下一道。没在计时就不轮询。 */
function schedule() {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  const session = board?.active;
  const current = session?.stages.find((stage) => !stage.outcome);
  if (session && current?.claimed) {
    pollTimer = setTimeout(async () => {
      try {
        const data = await post('/api/dan/next', { userId, tz });
        clockOffset = data.serverNow - Date.now() / 1000;
        if (data.poolEmpty) setMessage('这个档位已经没有你没做过的题了，换一个档位吧。', true);
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
$('refresh').addEventListener('click', () => refresh().catch((error) => setMessage(error.message, true)));

boot()
  .then(() => startAutoSync(() => refresh()))
  .catch((error) => setMessage(error.message, true));