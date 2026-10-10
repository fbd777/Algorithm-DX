/**
 * 段位認定结算页的浏览器 E2E：真的起一个 headless Edge，打开 /dan.html，
 * 把整轮结算那一屏量一遍，顺手出三张图给 paint-probe.py 数像素：
 *
 *   1. 四道都打满（SSS+，达成率全金）—— 版式与着色是否照官方那套
 *   2. 四道达成率故意拉开（金 / 蓝 / 红）—— 分数分色到底有没有落实
 *   3. 一道超时取消 —— 不合格那一屏的占位符与红心
 *
 * 需要本地已经跑着一个服务（默认 `127.0.0.1:8789`，库 `data/dan-ui.sqlite`）：
 *
 *     node scripts/dan-settlement-e2e.mjs
 *     DAN_BASE=http://127.0.0.1:8788 DAN_DB=data/demo-b50.sqlite node scripts/dan-settlement-e2e.mjs
 *
 * 这不是 `node --test` 那套单测（那些不碰浏览器）；这个脚本要 Edge、要一个跑着的服务，
 * 所以不进 CI，只当本地验收用。段位规则本身由 tests/dan.test.ts 覆盖。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.DAN_DB ? resolve(process.env.DAN_DB) : join(REPO, 'data', 'dan-ui.sqlite');
const BASE = process.env.DAN_BASE ?? 'http://127.0.0.1:8789';
const SHOTS = process.env.DAN_SHOTS ?? join(tmpdir(), 'dan-e2e-shots');
const EDGE = process.env.DAN_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const USER = Number(process.env.DAN_USER ?? 1);

/** 结算盘坐标：底图 980×928，逐题行与底部三块都按底图里量出来的位置。 */
const ROW = { left: 267, width: 576, tops: [152, 274, 396, 518] };
const PLATE = { left: 74, top: 672, w: 240, h: 230 };   // 左下段位名牌
const LIFE = { left: 334, top: 690, w: 200, h: 200 };
const TOTAL_LABEL = { left: 503, top: 663, w: 354, h: 52 };   // 底图预留的白格
const DX_ROW = { left: 608, top: 810, w: 360, h: 80 };        // 底图预留的白牌
const RIGHT_EDGE = 945;                                      // 大数字 / DX 数字的右端
const BADGE = { w: 132, h: 52 };
/** 等级 → 素材：官方 `UI_GAM_Rank_*`（游戏内那套单级全套）。 */
const RANK_FILE = {
  'SSS+': 'gam-rank-sssp.png', SSS: 'gam-rank-sss.png', 'SS+': 'gam-rank-ssp.png', SS: 'gam-rank-ss.png',
  'S+': 'gam-rank-sp.png', S: 'gam-rank-s.png', AAA: 'gam-rank-aaa.png', AA: 'gam-rank-aa.png',
  A: 'gam-rank-a.png', BBB: 'gam-rank-bbb.png', BB: 'gam-rank-bb.png', B: 'gam-rank-b.png',
  C: 'gam-rank-c.png', D: 'gam-rank-d.png',
};

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};
const open = () => {
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA busy_timeout = 8000');
  return db;
};
const call = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  return { status: res.status, body: await res.json() };
};
const run = async (path, body) => {
  const res = await call(path, body);
  if (res.status !== 200) throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

if (!existsSync(EDGE)) {
  console.log(`Edge 不在 ${EDGE}，跳过浏览器验收`);
  process.exit(0);
}
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

/** 题目名：先看本人提交里的真名，没有就尽力从 CF 全量清单里查一次，都没有就退回题号。 */
let cfNames = null;
const problemName = async (problemId) => {
  const known = open().prepare(
    "SELECT MAX(problem_title) AS title FROM submissions WHERE platform='codeforces' AND problem_id=?").get(problemId);
  if (known?.title) return known.title;
  if (cfNames === null) {
    cfNames = new Map();
    try {
      const res = await fetch('https://codeforces.com/api/problemset.problems', { signal: AbortSignal.timeout(20000) });
      const body = await res.json();
      for (const p of body?.result?.problems ?? []) cfNames.set(`${p.contestId}:${p.index}`, p.name);
    } catch { /* 离线就用题号，不影响验收 */ }
  }
  return cfNames.get(problemId) ?? problemId;
};

const { secondsForAchievement } = await import(pathToFileURL(join(REPO, 'src', 'dx', 'rating.ts')).href);

/* ---------- 造一轮：四道都按指定达成率通关 ---------- */

const seeded = [];
async function clearRun({ tier, kind, achievements }) {
  seeded.length = 0;
  const started = await run('/api/dan/start', { userId: USER, kind, tier, tz: 480 });
  const sessionId = started.session.id;
  const stageCount = started.session.stageCount;
  for (let round = 1; round <= stageCount; round += 1) {
    await run('/api/dan/claim', { userId: USER, sessionId });
    const timer = open().prepare(
      "SELECT id, problem_id FROM practice_timers WHERE status='running' ORDER BY started_at DESC LIMIT 1").get();
    const stage = open().prepare(
      'SELECT difficulty FROM dan_stages WHERE session_id=? AND stage_index=?').get(sessionId, round);
    const now = Math.floor(Date.now() / 1000);
    const target = achievements[round - 1];
    const seconds = Math.round(secondsForAchievement(stage.difficulty, target).seconds);
    const title = await problemName(timer.problem_id);
    const write = open();
    write.prepare('UPDATE practice_timers SET started_at=? WHERE id=?').run(now - seconds, timer.id);
    write.prepare(`INSERT INTO submissions(account_id,platform,submission_id,problem_id,problem_title,status,submitted_at,difficulty)
      VALUES(?,?,?,?,?,?,?,?)`).run(accountId, 'codeforces', `dan-e2e-${sessionId.slice(0, 6)}-${round}-${now}`,
      timer.problem_id, title, 'AC', now, stage.difficulty);
    write.close();
    seeded.push({ sessionId, index: round, title });
    await run('/api/dan/settle', { userId: USER, tz: 480 });
    if (round < stageCount) await run('/api/dan/next', { userId: USER, tz: 480 });
  }
  const row = (await call(`/api/dan?user=${USER}&tz=480`)).body.history.find((r) => r.id === sessionId);
  return row;
}

// 清场：收掉遗留的活动会话、清掉 dan 记录，从零开始。
const overview = (await call(`/api/dan?user=${USER}&tz=480`)).body;
if (overview.active) await call('/api/dan/abandon', { userId: USER, sessionId: overview.active.id });
{
  const clean = open();
  clean.exec('DELETE FROM dan_stages; DELETE FROM dan_sessions; DELETE FROM practice_timers;');
  clean.close();
}
const accountId = Number(open().prepare(
  "SELECT id FROM accounts WHERE platform='codeforces' AND is_archived=0 ORDER BY id LIMIT 1").get().id);
console.log(`账号 id=${accountId}，库 ${DB}，服务 ${BASE}，截图 ${SHOTS}`);

console.log('\n=== 1) 四道都打满（SSS+） ===');
const perfect = await clearRun({ tier: 'advanced', kind: 'challenge', achievements: [100.8, 100.8, 100.8, 100.8] });
check('这一轮判为 cleared', perfect?.status === 'cleared', `${perfect?.status}`);
check('四道都记了达成率与单题 rating',
  perfect?.stages.every((s) => typeof s.achievement === 'number' && typeof s.rating === 'number'),
  perfect?.stages.map((s) => `${s.difficulty}:${s.achievement.toFixed(2)}%/${s.rating}`).join(' '));
const expectAch = perfect.stages.reduce((sum, s) => sum + s.achievement, 0);
const expectRating = Math.round(perfect.stages.reduce((sum, s) => sum + s.rating, 0) * 10) / 10;
check('本轮总分 = 四道单题 rating 之和', Math.abs(perfect.totalRating - expectRating) < 0.05,
  `${perfect.totalRating} vs ${expectRating}`);

/* ---------- 起浏览器 ---------- */

const dir = mkdtempSync(join(tmpdir(), 'dan-e2e-'));
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1400', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

let cdp = null;
const problems = [];
const badResponses = [];
try {
  for (let i = 0; i < 40 && !cdp; i += 1) {
    await sleep(250);
    try {
      const [port, wsPath] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      cdp = await (await import(pathToFileURL(join(REPO, 'src', 'fetchers', 'cf-browser.ts')).href))
        .Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`);
    } catch { /* Edge 还没起来 */ }
  }
  if (!cdp) throw new Error('没连上 Edge 的 CDP');
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  cdp.socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') {
      problems.push(`异常: ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ''}`);
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      problems.push(`console.${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (message.method === 'Network.responseReceived') {
      const { url, status } = message.params.response;
      if (status >= 400 && url.includes('127.0.0.1')) badResponses.push(`${status} ${url}`);
    }
  });
  for (const domain of ['Runtime', 'Log', 'Page', 'Network']) await cdp.call(`${domain}.enable`, {}, sessionId);
  await cdp.call('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId);

  const evaluate = async (expression) => {
    const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`页面内异常 ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  const openPage = async (url, wait = 3200) => { await cdp.call('Page.navigate', { url }, sessionId); await sleep(wait); };
  const shot = async (name) => {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log(`  截图 → ${join(SHOTS, name)}`);
  };
  /** 只拍结算盘本身（文档插图用，不带上页面下那堆说明）。 */
  const shotDialog = async (name) => {
    const rect = JSON.parse(await evaluate(`(() => {
      const d = document.querySelector('dialog.dan-result');
      if (!d) return 'null';
      const r = d.getBoundingClientRect();
      return JSON.stringify({ x: r.left + window.scrollX, y: r.top + window.scrollY,
        width: r.width, height: r.height });
    })()`));
    if (!rect) return;
    const { data } = await cdp.call('Page.captureScreenshot',
      { format: 'png', clip: { ...rect, scale: 2 }, captureBeyondViewport: true }, sessionId);
    writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log(`  截图 → ${join(SHOTS, name)}`);
  };
  const clickByText = (selector, text) => evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.textContent.includes(${JSON.stringify(text)}));
    if (!node) return 'NOT_FOUND';
    node.click();
    return 'CLICKED';
  })()`);
  /** 打开最新一轮的结算页：认定记录里那条「查看结算」。 */
  const openLatestResult = async () => {
    await openPage(`${BASE}/dan.html`);
    const clicked = await clickByText('.dan-actions .btn', '查看结算');
    await sleep(1500);
    return clicked;
  };
  /** 读结算盘：行内组件用**行底板**做原点，底部组件用底图做原点（都是底图 980×928 那一套坐标）。 */
  const readLayout = () => evaluate(`(() => {
    const dialog = document.querySelector('dialog.dan-result');
    const art = dialog?.querySelector('.dan-result-art');
    if (!art) return JSON.stringify({ open: false, rows: [] });
    const box = art.getBoundingClientRect();
    const relTo = (origin, node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: Math.round(r.left - origin.left), top: Math.round(r.top - origin.top),
        w: Math.round(r.width), h: Math.round(r.height) };
    };
    const rel = (node) => relTo(box, node);
    const text = (root, sel) => root.querySelector(sel)?.textContent ?? null;
    // aria-label 挂在最里面那层 .dan-num 上；选择器可能指的是包着它的容器。
    const numNode = (root, sel) => {
      const node = root.querySelector(sel);
      if (!node) return null;
      return node.classList.contains('dan-num') ? node : node.querySelector('.dan-num');
    };
    const shown = (root, sel) => numNode(root, sel)?.getAttribute('aria-label') ?? null;
    const font = (root, sel) => {
      const node = numNode(root, sel);
      if (!node) return null;
      // 真正上色/上贴图的是里面那两层 <b>：分数族走 background-image（自带颜色），
      // 白字族走 mask + background-color（游戏里就是这样运行时染色的）。
      const fill = node.querySelector('.dan-num-fill');
      const style = getComputedStyle(fill ?? node);
      const cell = node.querySelector('.dan-num-char');
      const cellStyle = cell ? getComputedStyle(cell) : null;
      const advance = cell
        ? cell.getBoundingClientRect().width + (parseFloat(cellStyle.marginRight) || 0) : 0;
      // 图集里没有的字符（「—」这种占位符）走普通文字那条路：颜色落在文字本身上。
      const plain = node.querySelector('.dan-num-plain');
      return {
        fill: plain ? getComputedStyle(plain).color : style.backgroundColor,
        mask: style.maskImage || style.webkitMaskImage,
        atlas: style.backgroundImage,
        outline: Boolean(node.querySelector('.dan-num-outline')),
        label: node.getAttribute('aria-label'),
        height: Math.round(node.getBoundingClientRect().height),
        advance: Math.round(advance * 100) / 100,
        width: Math.round(node.getBoundingClientRect().width),
      };
    };
    return JSON.stringify({
      open: Boolean(dialog?.open),
      plate: { rect: rel(dialog.querySelector('.dan-verdict')), name: text(dialog, '.dan-plate-name'),
        nameLen: dialog.querySelector('.dan-plate-name')?.dataset.len ?? null,
        nameFont: (() => { const n = dialog.querySelector('.dan-plate-name'); if (!n) return null;
          const s = getComputedStyle(n); return { size: s.fontSize, weight: s.fontWeight, fill: s.color }; })(),
        count: text(dialog, '.dan-verdict-count'),
        legacyStamp: Boolean(dialog.querySelector('.dan-verdict-img')),
        nameRect: rel(dialog.querySelector('.dan-plate-name')) },
      life: { rect: rel(dialog.querySelector('.dan-life')), label: shown(dialog, '.dan-life-count'),
        base: dialog.querySelector('.dan-life-base')?.getAttribute('src')?.split('/').pop() ?? null },
      total: { label: text(dialog, '.dan-total-label'), labelRect: rel(dialog.querySelector('.dan-total-label')),
        num: shown(dialog, '.dan-total-num'), rect: rel(dialog.querySelector('.dan-total-num')),
        font: font(dialog, '.dan-total-num') },
      dx: { label: text(dialog, '.dan-dxscore-label'), num: shown(dialog, '.dan-dxscore-num'),
        rect: rel(numNode(dialog, '.dan-dxscore-num')), rowRect: rel(dialog.querySelector('.dan-dxscore-row')),
        labelRect: rel(dialog.querySelector('.dan-dxscore-label')), font: font(dialog, '.dan-dxscore-num') },
      rows: [...dialog.querySelectorAll('.dan-track')].map((track) => {
        const rowBox = track.getBoundingClientRect();
        return {
          rect: rel(track),
          no: text(track, '.dan-track-no'), name: text(track, '.dan-track-name'),
          diff: text(track, '.dan-track-diff'), diffLines: track.querySelectorAll('.dan-track-diff > *').length,
          ach: shown(track, '.dan-track-achvalue'), achFont: font(track, '.dan-track-achvalue'),
          dx: shown(track, '.dan-track-dxnum'), dxFont: font(track, '.dan-track-dxnum'),
          limit: text(track, '.dan-track-limit'), judge: text(track, '.dan-track-judge'),
          badge: track.querySelector('.dan-track-badge')?.getAttribute('src')?.split('/').pop() ?? '',
          badgeRect: rel(track.querySelector('.dan-track-badge')), stamp: rel(track.querySelector('.dan-track-stamp')),
          boxes: ['no', 'jacket', 'dxbox', 'dxnum', 'titlebar', 'name', 'diff', 'achbox', 'achvalue', 'badge', 'limit']
            .map((key) => [key, relTo(rowBox, track.querySelector('.dan-track-' + key))]).filter(([, r]) => r),
        };
      }),
    });
  })()`);

  console.log('\n=== 2) 结算页版式（四道满分成 → 金） ===');
  check('认定记录里点得到「查看结算」', await openLatestResult() === 'CLICKED');
  const page = JSON.parse(await readLayout());
  check('结算页弹出来了', page.open === true);
  const rows = page.rows ?? [];
  check('四道各一张卡', rows.length === 4, `${rows.length} 张`);
  check('四张卡按官方坐标摆：x 267 宽 576，行距 122',
    rows.every((row, i) => Math.abs(row.rect.left - ROW.left) <= 2 && Math.abs(row.rect.w - ROW.width) <= 2
      && Math.abs(row.rect.top - ROW.tops[i]) <= 2),
    rows.map((row) => `${row.rect.top}@${row.rect.w}`).join(' '));
  const outOfRow = [];
  for (const row of rows) {
    for (const [key, rect] of row.boxes) {
      if (rect.left < -2 || rect.top < -2 || rect.left + rect.w > row.rect.w + 2 || rect.top + rect.h > row.rect.h + 2) {
        outOfRow.push(`${row.no}:${key}`);
      }
    }
  }
  check('行内组件都待在底板里', outOfRow.length === 0, outOfRow.join(','));
  check('难度名牌只写名字一行（不再摆 CF 分与分数分组）',
    rows.every((row) => row.diff === '上级' && row.diffLines === 1), rows.map((row) => `${row.diff}/${row.diffLines}`).join(' '));
  check('标题条写题目名，不是「段位認定第 N 道」',
    rows.every((row, i) => row.name && row.name === seeded[i]?.title && !/段位認定第/.test(row.name)),
    rows.map((row) => row.name).join(' | '));
  check('评级徽章是游戏内那套单级素材且放到 132×52（不再拿「A～AAA」区间图充数）',
    rows.every((row) => row.badge === 'gam-rank-sssp.png' && Math.abs(row.badgeRect.w - BADGE.w) <= 2
      && Math.abs(row.badgeRect.h - BADGE.h) <= 2),
    `${rows[0]?.badge} ${rows[0]?.badgeRect?.w}×${rows[0]?.badgeRect?.h}`);
  check('四道达成率都上了官方金色图集',
    rows.every((row) => /num-score-gold/.test(row.achFont?.atlas ?? '')), rows.map((row) => row.achFont?.atlas).join(' | '));
  check('单题 DX 分数不叠描边层（小字要干净）',
    rows.every((row) => row.dxFont?.outline === false && /rgb\(13, 42, 99\)/.test(row.dxFont?.fill ?? '')),
    `描边层 ${rows[0]?.dxFont?.outline} / ${rows[0]?.dxFont?.fill}`);

  check('左下白框里写档位名（不再是合格印）',
    page.plate.name === '上级' && page.plate.legacyStamp === false, `${page.plate.name} · 旧印 ${page.plate.legacyStamp}`);
  check('段位名落在白框里、字重够重',
    page.plate.rect.left === PLATE.left && page.plate.rect.top === PLATE.top
      && page.plate.rect.w === PLATE.w && page.plate.rect.h === PLATE.h && Number(page.plate.nameFont.weight) >= 800,
    `${page.plate.rect.left},${page.plate.rect.top} ${page.plate.rect.w}×${page.plate.rect.h} · ${page.plate.nameFont.size}/${page.plate.nameFont.weight}`);
  check('结论变成名字下面一行小字', /合格 · 4 \/ 4 道通关/.test(page.plate.count ?? ''), page.plate.count);
  check('心放大到 200×200 且用官方绿色底盘，心里写通关道数',
    page.life.rect.w === LIFE.w && page.life.rect.h === LIFE.h
      && page.life.base === 'life-base-green.png' && page.life.label === '4',
    `${page.life.rect.w}×${page.life.rect.h} · ${page.life.base} · ${page.life.label}`);

  check('「总达成率」标签落进底图预留的白格',
    Math.abs(page.total.labelRect.left - TOTAL_LABEL.left) <= 2 && Math.abs(page.total.labelRect.top - TOTAL_LABEL.top) <= 2
      && Math.abs(page.total.labelRect.w - TOTAL_LABEL.w) <= 2 && Math.abs(page.total.labelRect.h - TOTAL_LABEL.h) <= 2,
    `${page.total.labelRect.left},${page.total.labelRect.top} ${page.total.labelRect.w}×${page.total.labelRect.h}`);
  check('总达成率 = 四道达成率之和（官方金色图集）',
    Math.abs(Number(String(page.total.num).replace('%', '')) - expectAch) < 0.01 && /%$/.test(page.total.num ?? ''),
    `${page.total.num} vs ${expectAch.toFixed(4)}%`);
  const totalRight = page.total.rect.left + page.total.rect.w;
  check('大数字落在色带上、右端对齐 x 945',
    Math.abs(totalRight - RIGHT_EDGE) <= 6 && page.total.rect.top >= 700 && page.total.rect.top + page.total.rect.h <= DX_ROW.top,
    `右 ${totalRight} · y ${page.total.rect.top}..${page.total.rect.top + page.total.rect.h}`);
  const glyphs = String(page.total.num).length + 1;
  // 官方是密排：分数族那套图集格宽 74 / 格高 98，密排后每字步进 67 ⇒ 0.68 上下。
  check('数字密排（官方字距，不再一个字一个字分开）',
    page.total.font.advance / page.total.font.height <= 0.69,
    `每字步进 ${page.total.font.advance}px / 字高 ${page.total.font.height} = ${(page.total.font.advance / page.total.font.height).toFixed(3)}（占位 ${glyphs} 个字形，整串宽 ${page.total.font.width}）`);

  check('DX 分数条就是底图预留的那条白牌',
    Math.abs(page.dx.rowRect.left - DX_ROW.left) <= 2 && Math.abs(page.dx.rowRect.top - DX_ROW.top) <= 2
      && Math.abs(page.dx.rowRect.w - DX_ROW.w) <= 2 && Math.abs(page.dx.rowRect.h - DX_ROW.h) <= 2,
    `${page.dx.rowRect.left},${page.dx.rowRect.top} ${page.dx.rowRect.w}×${page.dx.rowRect.h}`);
  check('标签写「DX分数」（照官方，不再自造「合计」）', page.dx.label === 'DX分数', page.dx.label);
  check('DX 分数 = 四道单题 rating 之和（深蓝、不带描边）',
    Math.abs(Number(page.dx.num) - expectRating) < 0.05 && /rgb\(13, 42, 99\)/.test(page.dx.font?.fill ?? '')
      && page.dx.font?.outline === false,
    `${page.dx.num} vs ${expectRating} · ${page.dx.font?.fill} · 描边层 ${page.dx.font?.outline}`);
  check('DX 数字在白牌右半边、且没出牌面',
    page.dx.rect.left >= DX_ROW.left + 120 && page.dx.rect.left + page.dx.rect.w <= DX_ROW.left + DX_ROW.w + 2,
    `${page.dx.rect.left}..${page.dx.rect.left + page.dx.rect.w} 牌面 ${DX_ROW.left}..${DX_ROW.left + DX_ROW.w}`);

  await shot('E-整轮结算页.png');
  await shotDialog('D-结算盘.png');
  // 给 paint-probe.py 数像素用的小图（按底图坐标抠）
  const origin = JSON.parse(await evaluate(`(() => {
    const b = document.querySelector('dialog.dan-result .dan-result-art').getBoundingClientRect();
    return JSON.stringify({ x: b.left + window.scrollX, y: b.top + window.scrollY });
  })()`));
  const row0 = rows[0];
  // 行内那些小图是**行内相对坐标**，抠图要加上第 1 行在底图上的原点，否则会拍错地方。
  const inRow = (rel) => (rel ? { left: rel.left + row0.rect.left, top: rel.top + row0.rect.top, w: rel.w, h: rel.h } : null);
  const rectOf = (key) => inRow((row0.boxes.find(([name]) => name === key) ?? [])[1]);
  const clipTargets = {
    ach: rectOf('achvalue'), score: rectOf('dxnum'), stamp: inRow(row0.stamp), badge: inRow(row0.badgeRect),
    total: page.total.rect, dxtotal: page.dx.rect, life: page.life.rect,
  };
  const rectsOut = {};
  for (const [name, rect] of Object.entries(clipTargets)) {
    if (!rect) continue;
    const clip = { x: origin.x + rect.left, y: origin.y + rect.top, width: rect.w, height: rect.h, scale: 1 };
    rectsOut[name] = clip;
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, sessionId);
    writeFileSync(join(SHOTS, `H-${name}.png`), Buffer.from(data, 'base64'));
  }
  writeFileSync(join(SHOTS, 'H-rects.json'), JSON.stringify(rectsOut, null, 2));

  /* ---------- 3) 达成率拉开：金 / 蓝 / 红 ---------- */

  console.log('\n=== 3) 四道达成率拉开（金 / 蓝 / 红） ===');
  const mixed = await clearRun({ tier: 'advanced', kind: 'challenge', achievements: [100.8, 98.5, 96.0, 92.0] });
  check('这一轮同样判为 cleared（限时内 AC 就算过，跟达成率高低无关）', mixed?.status === 'cleared', `${mixed?.status}`);
  check('四道达成率确实拉开了',
    new Set(mixed.stages.map((s) => Math.round(s.achievement))).size === 4,
    mixed.stages.map((s) => `${s.achievement.toFixed(2)}%`).join(' '));
  await openLatestResult();
  const mixedPage = JSON.parse(await readLayout());
  const tones = mixedPage.rows.map((row) => (/num-score-(\w+)\.png/.exec(row.achFont?.atlas ?? '') ?? [])[1]);
  check('三档颜色都按达成率换：≥100 金、≥97 蓝、<97 红',
    tones.join(',') === 'gold,blue,red,red', `${tones.join(',')} · ${mixed.stages.map((s) => `${s.achievement.toFixed(2)}%`).join(' ')}`);
  check('评级徽章跟着达成率走（逐级对应，不再共用一个区间图）',
    mixedPage.rows.every((row, i) => row.badge === RANK_FILE[mixed.stages[i].rank]),
    mixedPage.rows.map((row, i) => `${mixed.stages[i].rank}=${row.badge}`).join(' '));
  check('总达成率是四道之和 ⇒ 仍然 ≥100% ⇒ 金',
    /num-score-gold/.test(mixedPage.total.font?.atlas ?? '') && /%$/.test(mixedPage.total.num ?? ''),
    `${mixedPage.total.num} · ${mixedPage.total.font?.atlas}`);
  await shot('F-分数分色结算页.png');
  await shotDialog('D-结算盘-分色.png');

  /* ---------- 4) 超时取消 ---------- */

  console.log('\n=== 4) 超时取消那一轮 ===');
  const timedId = `e2e-timeout-${Date.now()}`;
  const timerId = `${timedId}-1`;
  {
    const t = Math.floor(Date.now() / 1000);
    const write = open();
    write.prepare(`INSERT INTO dan_sessions(id,user_id,tier,kind,stage_count,limit_seconds,min_rating,max_rating,status,started_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(timedId, USER, 'beginner', 'challenge', 4, 1800, 800, 1100, 'active', t + 1);
    write.prepare(`INSERT INTO practice_timers(id,user_id,account_id,handle_key,problem_id,practice_kind,status,started_at,ended_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(timerId, USER, accountId, 'dan-e2e', '559:A', 'unknown', 'completed', t - 4000, t - 1000);
    write.prepare(`INSERT INTO dan_stages(session_id,stage_index,problem_id,difficulty,drawn_at,claimed_at,timer_id,limit_seconds)
      VALUES(?,?,?,?,?,?,?,?)`).run(timedId, 1, '559:A', 800, t - 4000, t - 4000, timerId, 1800);
    write.close();
  }
  await call('/api/dan/settle', { userId: USER, tz: 480 });
  const failed = (await call(`/api/dan?user=${USER}&tz=480`)).body.history.find((r) => r.id === timedId);
  check('超时那一道被记为 timeout', failed?.stages[0]?.outcome === 'timeout', `${failed?.stages[0]?.outcome}`);
  check('这一轮判为 failed，且没有继续抽第 2 道', failed?.status === 'failed' && failed?.stages.length === 1,
    `${failed?.status} / ${failed?.stages.length} 道`);
  await openLatestResult();
  const failPage = JSON.parse(await readLayout());
  check('失败那一屏也弹得出来', failPage.open === true);
  check('档位名照样写在白框里，结论是小字「不合格」',
    failPage.plate.name === '初级' && /不合格 · 0 \/ 4 道通关/.test(failPage.plate.count ?? ''),
    `${failPage.plate.name} · ${failPage.plate.count}`);
  check('只有一张卡、没有评级徽章、判定写「超时」',
    failPage.rows.length === 1 && failPage.rows[0].badge === '' && failPage.rows[0].judge === '超时',
    `${failPage.rows.length} 张 / 徽章「${failPage.rows[0]?.badge}」/ 判定「${failPage.rows[0]?.judge}」`);
  check('没有成绩的两处都是占位「—」', failPage.total.num === '—' && failPage.dx.num === '—',
    `${failPage.total.num} / ${failPage.dx.num}`);
  check('占位「—」也染了深蓝（白字族是纯白剪影，白底上会看不见）',
    /rgb\(13, 42, 99\)/.test(failPage.total.font?.fill ?? '') && /rgb\(13, 42, 99\)/.test(failPage.dx.font?.fill ?? ''),
    `${failPage.total.font?.fill} / ${failPage.dx.font?.fill}`);
  check('心换成红色底盘，写 0', failPage.life.base === 'life-base-red.png' && failPage.life.label === '0',
    `${failPage.life.base} / ${failPage.life.label}`);
  await shot('G-不合格结算页.png');

  console.log('\n=== 5) 控制台与请求 ===');
  check('页面没有抛异常 / console.error', problems.length === 0, problems.slice(0, 3).join(' | '));
  check('没有指向本服务的 4xx/5xx', badResponses.length === 0, badResponses.slice(0, 3).join(' | '));
} catch (error) {
  console.log(`\n出错：${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
} finally {
  try { cdp?.socket.close(); } catch { /* 已经关了 */ }
  edge.kill();
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);