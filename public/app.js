import { openCfGroups } from './cf-groups.js';
import { openMatijiImport } from './matiji-import.js';
import { startAutoSync } from './auto-sync.js';
/**
 * Algorithm DX · Phase 3 Dashboard 前端。
 *
 * 纯原生 DOM，无框架、无构建步骤、不加载任何外部资源。
 * 所有用户可见文本一律通过 textContent / createElement 写入，不用 innerHTML 拼接，
 * 避免题库标题里可能出现的尖括号被当作标记解析。
 *
 * 读与写的边界：浏览、筛选、展开明细全是 GET；只有「账号管理」面板里的
 * 绑定 / 解绑 / 建用户 / 同步走 POST。凭据一旦写进输入框就直接发给本机服务端，
 * 不留在前端状态里（提交后立刻清空输入框，也不回填）。
 */


import { languageLabel, difficultyLabel, difficultyClass } from './stat-labels.js';
const PLATFORM_LABELS = {
  codeforces: 'Codeforces',
  leetcode: 'LeetCode',
  'leetcode-cn': '力扣中国站',
  atcoder: 'AtCoder',
  luogu: '洛谷',
  matiji: '码蹄集',
  nowcoder: '牛客',
};

/**
 * 各平台「账号标识」填什么 —— 这里最容易填错：洛谷和码蹄集要的是数字 ID 而不是昵称，
 * 洛谷填昵称会直接报错。文案与 docs/platforms.md 的表格保持一致。
 */
const HANDLE_HINTS = {
  codeforces: '打开个人主页，填写 /profile/ 后的 handle（不是个人资料中的姓名）。例如 /profile/tourist 填 tourist。',
  leetcode: '打开 leetcode.com 个人主页，填写 /u/ 后的用户名，不要粘贴整个网址。',
  'leetcode-cn': '打开 leetcode.cn 个人主页，填写 /u/ 后、下一个 / 前的那段字符；它可能不同于显示昵称。',
  atcoder: '填写个人主页 /users/ 后的用户名，不是资料中的显示名称。',
  luogu: '打开洛谷个人主页，例如 /user/123456，填写 123456；不要填昵称或整个网址。',
  nowcoder: '请填写牛客用户 ID（纯数字，不是昵称）。打开个人主页，复制网址 /users/ 或 /profile/ 后面的数字。同步公开编程练习记录，无需 Cookie。',
  matiji: '绑定自己：填昵称或留空，保存时自动识别；已有登录配置无需再填 Cookie。也可粘贴自己的个人主页链接。绑定他人请填数字 ID 或他人主页链接。',
};

const STATUS_LABELS = {
  AC: 'AC 通过',
  WA: 'WA 答案错误',
  TLE: 'TLE 超时',
  MLE: 'MLE 内存超限',
  RE: 'RE 运行错误',
  CE: 'CE 编译错误',
  PENDING: '判题中',
  OTHER: '其他',
};

const STATUS_TONE = {
  AC: 'ac',
  WA: 'warn',
  TLE: 'bad',
  MLE: 'bad',
  RE: 'bad',
  CE: 'bad',
  PENDING: 'warn',
  OTHER: '',
};

const PAGE_SIZE = 24;

const state = {
  meta: null,
  offset: 0,
  limit: PAGE_SIZE,
  items: [],
  total: 0,
  filters: { platforms: [], user: 'all', status: 'all', q: '' },
  detailOpen: new Set(),
  detailCache: new Map(),
  unacOpen: false,
  loading: false,
  adminOpen: false,
  adminBusy: false,
  syncWatching: false,
  syncTimer: null,
  /** 顶栏「同步最新数据」是否在跑，防重复点击。 */
  syncing: false,
};

/* ---------- DOM 助手 ---------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('不要使用 html 注入');
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const $ = (id) => document.getElementById(id);

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ---------- 格式化 ---------- */

const pad2 = (n) => String(n).padStart(2, '0');

function fmtDateTime(seconds) {
  if (!seconds) return '—';
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDate(seconds) {
  if (!seconds) return '—';
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtRelative(seconds) {
  if (!seconds) return '';
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} 个月前`;
  return `${(diff / 86400 / 365).toFixed(1)} 年前`;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 秒 → `m:ss` / `h:mm:ss`。与 DX 页的 fmtClock 同一口径，纯显示用。 */
function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function fmtMemory(bytes) {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const num = (n) => Number(n ?? 0).toLocaleString('zh-CN');

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * 账号在两处的展示名：数字 UID 平台（洛谷）的 handle 本身看不出是谁，
 * 所以解析到昵称时把昵称放前面、UID 留在括号里，既能认人也不丢真实标识。
 */
function accountLabel(account) {
  const id = account.display_name ? `${account.display_name}（${account.handle}）` : account.handle;
  return `${platformLabel(account.platform)}/${id}`;
}

function shortAccountLabel(item) {
  return item.display_name ? `${item.display_name}（${item.handle}）` : item.handle;
}

/**
 * 被跳过的同步结果 -> 一行说明。
 * 账号信息从 meta 里找（同步结果只带 accountId），找不到就退回编号 ——
 * 不该因为列表刚好没刷新就显示成空白。
 */
function skipLabel(result) {
  const account = (state.meta?.accounts ?? []).find((a) => a.id === result.accountId);
  const who = account ? accountLabel(account) : `账号 ${result.accountId}`;
  const variable = result.prerequisite?.variable;
  return variable ? `${who} 缺 ${variable}` : `${who} —— ${result.message}`;
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
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

/**
 * 写接口。content-type 必须是 application/json —— 服务端据此拒绝表单式跨站提交
 * （HTML 表单发不出这个类型，而带它的跨站请求会先触发预检，本服务不应答预检）。
 */
async function postJson(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && body.error) || `请求失败（HTTP ${res.status}）`;
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return body;
}

/**
 * 发起一轮同步。**已经在跑的那一轮不算失败** —— 服务端会把它的 job 一起回过来。
 *
 * 两个页面共用一个后台同步器，所以「首页点了全平台同步、还没跑完又去 DX 页点同步」
 * 是很自然会撞上的顺序。与其让人 retry，不如跟着那轮跑到完 ——
 * 使用者关心的是数据有没有到，不关心这一轮是誰发起的。
 */
async function requestSync(payload) {
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 202) return { jobId: body.job.id, followed: false };
  if (res.status === 409 && body && body.job && body.job.id) return { jobId: body.job.id, followed: true };
  throw new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
}

function filterParams() {
  const params = {};
  if (state.filters.platforms.length) params.platform = state.filters.platforms.join(',');
  if (state.filters.user !== 'all') params.user = String(state.filters.user);
  if (state.filters.status !== 'all') params.status = state.filters.status;
  if (state.filters.q) params.q = state.filters.q;
  return params;
}

/* ---------- 顶栏与地址状态 ---------- */

function renderMeta(meta, background = false) {
  $('dbChip').textContent = '本地记录';
  $('dbChip').title = `读取中的数据库：${meta.dbPath}`;

  clear($('userSelect'));
  $('userSelect').append(el('option', { value: 'all', text: '全部用户' }));
  for (const user of meta.users) {
    $('userSelect').append(
      el('option', { value: String(user.id), text: user.is_self ? `${user.name}（我）` : user.name }),
    );
  }
  if (state.legacySelfFilter) {
    state.filters.user = String(meta.users.find(user => user.is_self)?.id ?? 'all');
    state.legacySelfFilter = false;
  }
  const wanted = state.filters.user === 'all' ? 'all' : String(state.filters.user);
  // 用户被删掉后，筛选条件里那个 id 就不存在了 —— 回落到「全部」，
  // 否则下拉变成空选，列表会莫名其妙全空。
  const stillThere = [...$('userSelect').options].some((option) => option.value === wanted);
  state.filters.user = stillThere ? wanted : 'all';
  $('userSelect').value = state.filters.user;

  const counts = new Map(meta.platforms_present.map((p) => [p.platform, p.submissions]));
  clear($('platformChips'));
  for (const platform of Object.keys(PLATFORM_LABELS)) {
    const total = counts.get(platform);
    const on = state.filters.platforms.includes(platform);
    const chip = el('button', {
      class: `chip${on ? ' is-on' : ''}`,
      type: 'button',
      'data-platform': platform,
      title: total ? `${platformLabel(platform)}：库中共 ${num(total)} 条提交` : `${platformLabel(platform)}：库中暂无记录`,
      onclick: () => togglePlatform(platform),
    }, [platformLabel(platform)]);
    if (total) chip.append(el('span', { class: 'chip-n', text: num(total) }));
    $('platformChips').append(chip);
  }

  renderCoverageNotice(meta);
  if (!background) renderAdmin(meta);
  else { renderAccountList(meta); renderUserList(meta); }
}

/* ---------- 账号管理 ---------- */

function credentialState(meta, platform) {
  const entry = (meta.credentials ?? []).find((item) => item.platform === platform);
  return entry ?? null;
}

function renderAdmin(meta) {
  renderAccountList(meta);
  renderUserList(meta);
  renderBindForm(meta);
}

function setAdminStatus(text, tone) {
  const node = $('adminStatus');
  node.className = `form-status${tone ? ` is-${tone}` : ''}`;
  node.textContent = text ?? '';
  node.hidden = !text;
}

/** 按归属展示账号；刷新同步状态时保留用户展开的分组。 */
function renderAccountList(meta) {
  const cfAccounts = meta.accounts.filter(a => a.platform === 'codeforces' && !a.is_archived);
  const select = $('cfGroupAccount');
  const signature = JSON.stringify(cfAccounts.map(a => [a.id, a.user_name, a.handle]));
  if (select.dataset.accounts !== signature) {
    const previous = select.value;
    select.replaceChildren(...cfAccounts.map(a => el('option', { value: String(a.id), text: a.user_name + ' · ' + a.handle })));
    if (cfAccounts.some(a => String(a.id) === previous)) select.value = previous;
    select.dataset.accounts = signature;
  }
  select.disabled = cfAccounts.length === 0;
  $('cfGroupSetup').disabled = cfAccounts.length === 0;
  $('cfGroupNoAccount').hidden = cfAccounts.length !== 0;
  const box = $('accountList');
  const expanded = new Set([...box.querySelectorAll('.account-owner[open]')].map(node => node.dataset.owner));
  clear(box);
  const activeAccounts = meta.accounts.filter(a => !a.is_archived);
  const archivedAccounts = meta.accounts.filter(a => a.is_archived && a.stored_submissions > 0);
  if (!activeAccounts.length && !archivedAccounts.length) {
    box.append(el('p', { class: 'field-hint', text: '还没有绑定任何账号。右侧表单填一个就行。' }));
  }

  const owners = [...meta.users].sort((a, b) => Number(b.is_self) - Number(a.is_self));
  for (const user of owners) {
    const accounts = activeAccounts.filter(account => account.user_id === user.id);
    const archived = archivedAccounts.filter(account => account.user_id === user.id);
    if (!accounts.length && !archived.length) continue;
    const group = el('details', { class: 'account-owner' });
    group.dataset.owner = String(user.id);
    group.open = expanded.has(String(user.id));
    const needsAttention = accounts.filter(account => account.prerequisite || account.last_error).length;
    const identity = el('span', { class: 'account-owner-identity' }, [
      el('strong', { text: user.is_self ? `${user.name}（我）` : user.name }),
      el('span', { class: 'account-owner-platforms', text: [...new Set(accounts.map(account => platformLabel(account.platform)))].join(' · ') || '仅保留旧账号历史' }),
    ]);
    const summary = el('summary', {}, [
      el('span', { class: 'account-owner-avatar', text: [...user.name][0] || '?' }),
      identity,
      el('span', { class: 'account-owner-count', text: `${accounts.length} 个账号` }),
    ]);
    if (needsAttention) summary.append(el('span', { class: 'badge warn', text: `${needsAttention} 项待处理` }));
    group.append(summary);
    const content = el('div', { class: 'account-owner-content' });
    group.append(content);
    box.append(group);

  for (const account of accounts) {
    const row = el('div', { class: 'account-row' }, [
      el('span', { class: 'badge platform', text: platformLabel(account.platform) }),
      el('span', { class: 'who', text: shortAccountLabel(account) }),
    ]);

    const stats = [];
    stats.push(`提交 ${num(account.stored_submissions)}`);
    if (account.stored_contest_problems) stats.push(`比赛内编号 ${num(account.stored_contest_problems)}`);
    row.append(el('span', { class: 'grow', text: stats.join(' · ') }));

    // 前置条件没配齐时，这个账号的同步状态本身就是「待配置」，而不是「失败」。
    // 此时连 last_error 也不显示：那条红字多半正是「还没配」被误记成「抓取失败」的产物。
    if (account.retired) {
      row.append(el('span', { class: 'badge', text: '已停止支持，数据保留' }));
    } else if (account.prerequisite) {
      const p = account.prerequisite;
      row.append(
        el('span', {
          class: 'badge warn',
          text: p.kind === 'snapshot' ? '等待导入记录' : '待配置登录凭据',
          title: p.kind === 'snapshot' ? '点击「导入记录」上传码蹄集 JSON 文件。' : `${p.detail}。可在绑定时填写凭据。`,
        }),
      );
    } else if (account.last_error) {
      row.append(el('span', { class: 'badge bad', text: '上次抓取失败', title: account.last_error }));
    } else if (!account.history?.supported && account.last_success_at) {
      row.append(el('span', { class: 'badge', text: account.platform === 'matiji' ? '已导入' : '近期记录已同步', title: account.history?.detail }));
    } else if (account.history_complete) {
      row.append(el('span', { class: 'badge ac', text: '可见历史已回补', title: '已遍历数据源当前可见的历史，不保证包含账号的全部评测记录。洛谷私有或比赛隐藏记录可能不可见。' }));
    } else if (account.stored_submissions) {
      row.append(el('span', { class: 'badge warn', text: '未回补完' }));
    } else {
      row.append(el('span', { class: 'badge warn', text: '尚未同步' }));
    }

    // 上面那条「待配置」已经点名了变量，这里不再重复一遍「凭据未配」。
    const cred = account.prerequisite ? null : credentialState(meta, account.platform);
    if (cred) {
      row.append(
        el('span', {
          class: `badge${cred.configured ? ' ac' : ''}`,
          text: cred.configured ? '凭据已配' : '凭据未配',
          title: cred.configured
            ? `${cred.variable} 已配置（值不会显示在这里）`
            : `未配置 ${cred.variable}；逐条记录需要它`,
        }),
      );
    }

    if (['matiji', 'leetcode-cn'].includes(account.platform)) row.append(el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => openAccountSetup(account) }, ['设置登录']));
    if (account.platform === 'matiji') row.append(el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => openMatijiImport(account, () => refreshAll()) }, ['导入文件（备用）']));

    if (account.platform === 'codeforces') row.append(el('button', {class:'btn btn-ghost btn-small',type:'button',onclick:()=>openCfGroups(account,()=>refreshAll())}, ['自建比赛']));

    // 只有可变 handle 支持同一账号改名。
    if (!['luogu', 'matiji', 'nowcoder'].includes(account.platform))
    row.append(el('button', {
      class: 'btn btn-ghost btn-small',
      type: 'button',
      title: '仅用于同一平台账号修改用户名；历史与同步进度保持不变',
      onclick: () => renameAccount(account),
    }, ['同一账号改名']));
    row.append(el('button', { class: 'btn btn-ghost btn-small', type: 'button',
      onclick: () => replaceAccount(account) }, ['换绑账号']));

    row.append(el('button', {
      class: 'btn btn-ghost btn-small',
      type: 'button',
      onclick: () => unbindAccount(account),
    }, ['解绑']));

    content.append(row);
  }
  if (archived.length) {
    const history = el('details', { class: 'account-history' }, [
      el('summary', { text: `旧账号历史（${archived.length}）` }),
      el('p', { class: 'field-hint', text: '仅保留已抓取的记录，不参与当前同步和统计。' }),
    ]);
    for (const account of archived) history.append(el('div', { class: 'account-row' }, [
      el('span', { class: 'badge platform', text: platformLabel(account.platform) }),
      el('span', { class: 'who', text: shortAccountLabel(account) }),
      el('span', { text: `${account.user_name} · ${num(account.stored_submissions)} 次提交` }),
    ]));
    content.append(history);
  }
  }
}

function renderUserList(meta) {
  const box = $('userList');
  clear(box);
  for (const user of meta.users) {
    const row = el('div', { class: 'account-row' }, [
      el('span', { class: 'who', text: user.is_self ? `${user.name}（我）` : user.name }),
      el('span', { class: 'grow', text: `${num(user.account_count)} 个账号` }),
    ]);
    // 关注与「是本人」是两层。不关注只是**不出现在主视图里**，一条数据都不删；
    // 而删除会连带删掉名下账号与提交记录。所以「不想看他」和「彻底删掉」是两个按钮。
    if (user.is_self) {
      row.append(el('span', {
        class: 'badge ac',
        text: '本人',
        title: '本人是主视图与 DX 榜的锚点，不能取消关注',
      }));
    } else {
      if (user.is_followed) row.append(el('a', {
        class: 'btn btn-ghost btn-small',
        href: `/circle.html?user=${user.id}`,
        text: '个人空间',
      }));
      row.append(el('button', {
        class: 'btn btn-ghost btn-small',
        type: 'button',
        title: user.is_followed
          ? '取消关注只是把 TA 从主视图里移出去，账号与提交记录都还在'
          : '关注之后 TA 才会出现在主视图里',
        onclick: () => toggleFollow(user),
      }, [user.is_followed ? '已关注' : '关注']));
    }

    // 只剩一个用户时不给删：账号必须挂在某个用户名下，全删光等于把数据一起清掉。
    if (meta.users.length > 1) {
      row.append(el('button', {
        class: 'btn btn-ghost btn-small',
        type: 'button',
        onclick: () => removeUser(user),
      }, ['删除']));
    }
    box.append(row);
  }
}

function renderBindForm(meta) {
  const userSelect = $('bindUser');
  const previous = userSelect.value;
  clear(userSelect);
  for (const user of meta.users) {
    userSelect.append(el('option', { value: String(user.id), text: user.is_self ? `${user.name}（我）` : user.name }));
  }
  userSelect.append(el('option', { value: 'new', text: '＋ 添加一个人（本地名称）…' }));
  if ([...userSelect.options].some((option) => option.value === previous)) userSelect.value = previous;

  const platformSelect = $('bindPlatform');
  if (!platformSelect.options.length) {
    for (const platform of Object.keys(PLATFORM_LABELS)) {
      platformSelect.append(el('option', { value: platform, text: platformLabel(platform) }));
    }
  }
  syncBindForm();
}

/** 按「归属用户是否新建」和「平台是否要凭据」切换表单里几块的显隐。 */
function syncBindForm() {
  const meta = state.meta;
  if (!meta) return;
  const creating = $('bindUser').value === 'new';
  $('bindNameField').hidden = !creating;
  $('bindSelfField').hidden = !creating;
  $('bindUserName').required = creating;

  const platform = $('bindPlatform').value;
  $('matijiIdentityField').hidden = platform !== 'matiji';
  const needsCredential = (meta.credentialPlatforms ?? []).includes(platform);
  $('bindHandleHint').textContent = HANDLE_HINTS[platform] ?? '';
  $('luoguScopeHint').hidden = platform !== 'luogu';
  $('bindHandle').placeholder = ['luogu', 'matiji', 'nowcoder'].includes(platform) ? '数字 ID' : '昵称或用户名';
  $('bindHandleLabel').textContent = platform === 'nowcoder' ? '牛客用户 ID' : '平台用户名 / 用户 ID';
  if (platform === 'nowcoder') $('bindHandle').placeholder = '请输入牛客用户 ID（纯数字）';
  if (platform === 'matiji') $('bindHandle').placeholder = '昵称 / 主页链接 / 数字 ID；留空识别自己';

  const cred = credentialState(meta, platform);
  $('bindCookieField').hidden = !needsCredential;
  $('cookieGuide').hidden = !needsCredential;
  $('localNameHint').hidden = !creating;
  if (!needsCredential) {
    $('bindCookieHint').textContent = '这个平台走公开接口，不需要登录凭据。';
    return;
  }
  $('bindCookieHint').textContent = cred && cred.configured
    ? `凭据已配置（${cred.variable}）。留空即沿用现有值；填新的会覆盖它。`
    : `留空也能绑定，但逐条记录抓不到。填了会写进本机 .env 的 ${cred ? cred.variable : ''}，不会存进数据库。`;
  if (platform === 'matiji') $('bindCookieHint').textContent = cred?.configured ? '码蹄集登录已配置，留空沿用。失效后在这里粘贴新的 Cookie 即可。' : '在码蹄集登录后复制一次 Cookie 并粘贴到这里，多个码蹄集账号共用，无需准备记录文件。';
  if (platform === 'leetcode-cn') $('bindCookieHint').textContent = '可选：填写本人力扣登录 Cookie 后，可回补全部可见历史及失败提交，不获取源码。Cookie 必须与绑定的主页 slug 对应；留空仍可同步公开近期 AC。';
  if (platform === 'luogu') $('bindCookieHint').textContent = cred && cred.configured
    ? '已配置洛谷 Cookie，留空沿用；填新的会覆盖所有关注洛谷账号共用的配置。请使用你自己的登录 Cookie，有效性以同步结果为准。'
    : '请填写你自己的洛谷登录 Cookie，无需好友的 Cookie。一份配置供所有关注的洛谷账号使用；留空只能绑定，暂时无法抓取提交记录。';
}

/**
 * 同一账号改名保留历史；更换身份必须走独立换绑入口。
 */
async function renameAccount(account) {
  const label = accountLabel(account);
  const kept = account.stored_submissions
    ? `这个账号已有的 ${num(account.stored_submissions)} 条提交记录会全部保留。`
    : '这个账号在本地还没有提交记录。';
  const next = window.prompt(`把 ${label} 的账号标识改成：\n\n${kept}`, account.handle);
  if (next === null) return;
  const clean = next.trim();
  if (!clean || clean === account.handle) return;
  if (!window.confirm('请确认：这是同一平台账号修改了用户名，身份没有变化。\n如果是另一个账号或原来绑错了人，请取消并使用「换绑账号」。')) return;
  setAdminStatus('');
  try {
    const result = await postJson('/api/accounts/rename', { id: account.id, handle: clean, sameIdentity: true });
    setAdminStatus(`已改成 ${result.platform}/${result.to}，${num(result.submissions)} 条提交记录原样保留。`, 'ok');
    await refreshAll();
  } catch (error) {
    setAdminStatus(`改标识失败：${error.message}`, 'bad');
  }
}

async function replaceAccount(account) {
  const next = window.prompt('填写新的账号标识（仍归属于 ' + account.user_name + '）：');
  if (!next?.trim()) return;
  if (!window.confirm('旧账号将归档，保留历史但退出统计和同步。新账号从空记录开始。\n如果新账号属于另一个人，请取消，先新建用户再绑定。')) return;
  try {
    const result = await postJson('/api/accounts/replace', { id: account.id, handle: next.trim(), confirm: true });
    setAdminStatus('已换绑为 ' + result.platform + '/' + result.to + '，后续同步使用新账号。', 'ok');
    await refreshAll();
  } catch (error) { setAdminStatus('换绑失败：' + error.message, 'bad'); }
}

async function unbindAccount(account) {
  const label = accountLabel(account);
  const detail = account.stored_submissions
    ? `\n\n会同时删除该账号在本地库里的 ${num(account.stored_submissions)} 条提交记录和同步历史。`
    : '\n\n该账号在本地还没有提交记录。';
  if (!window.confirm(`解绑 ${label}？${detail}\n\n此操作不可撤销。同一账号修改用户名请使用「同一账号改名」；更换账号请使用「换绑账号」保留旧历史。`)) return;
  setAdminStatus('');
  try {
    await postJson('/api/accounts/unbind', { id: account.id, confirm: true });
    setAdminStatus(`已解绑 ${label}。`, 'ok');
    await refreshAll();
  } catch (error) {
    setAdminStatus(`解绑失败：${error.message}`, 'bad');
  }
}

async function toggleFollow(user) {
  const followed = !user.is_followed;
  setAdminStatus('');
  try {
    await postJson('/api/users/follow', { id: user.id, followed });
    setAdminStatus(
      followed
        ? `已关注「${user.name}」。`
        : `已取消关注「${user.name}」—— 账号与提交记录都还在，只是不出现在主视图里。`,
      'ok',
    );
    await refreshAll();
  } catch (error) {
    setAdminStatus(`${followed ? '关注' : '取消关注'}失败：${error.message}`, 'bad');
  }
}

async function removeUser(user) {
  if (!window.confirm(`删除用户「${user.name}」？\n\n名下 ${num(user.account_count)} 个账号及其全部提交记录会一起删除。\n\n此操作不可撤销。`)) return;
  setAdminStatus('');
  try {
    await postJson('/api/users/remove', { id: user.id, confirm: true });
    setAdminStatus(`已删除用户「${user.name}」。`, 'ok');
    await refreshAll();
  } catch (error) {
    setAdminStatus(`删除失败：${error.message}`, 'bad');
  }
}

async function submitBind(event) {
  event.preventDefault();
  if (state.adminBusy) return;
  const status = $('bindStatus');
  status.className = 'form-status';
  status.textContent = '正在绑定…';

  state.adminBusy = true;
  $('bindSubmit').disabled = true;
  try {
    const creating = $('bindUser').value === 'new';
    let userId;
    if (creating) {
      const name = $('bindUserName').value.trim();
      if (!name) throw new Error('请填写新用户名称');
      const created = await postJson('/api/users', { name, isSelf: $('bindUserSelf').checked });
      userId = created.id;
    } else {
      userId = Number($('bindUser').value);
    }

    const platform = $('bindPlatform').value;
    let handle = $('bindHandle').value.trim();
    if (!handle && platform !== 'matiji') throw new Error('请填写账号标识');
    const cookie = $('bindCookie').value.trim();

    if (platform === 'matiji') status.textContent = '正在确认码蹄集账号并保存…';
    const result = await postJson('/api/accounts', { userId, platform, handle, cookie });

    // 凭据进了请求就丢，不留在前端状态里，也不回填。
    $('bindCookie').value = '';
    $('bindUserName').value = '';
    $('bindUserSelf').checked = false;
    $('bindHandle').value = '';

    const parts = [result.existing ? '账号已存在，本次只更新了凭据。' : '已绑定。'];
    // 探测结果有三种，必须分开说：探到了 / 探不到 / 平台上确实没有（最后一种走 catch，到不了这里）。
    if (result.probe?.status === 'found') {
      parts.push(`已确认平台上确有此账号${result.probe.displayName ? `（${result.probe.displayName}）` : ''}。`);
    } else if (result.probe?.status === 'unknown') {
      parts.push(`没能确认这个账号是否存在（${result.probe.reason}），仍然照常绑定了。`);
    }
    if (result.displayName) parts.push(`昵称解析为「${result.displayName}」。`);
    if (platform === 'matiji') parts.push(`用户 ID：${result.handle}。`);
    if (result.displayNameWarning) parts.push(`昵称解析失败（不影响绑定）：${result.displayNameWarning}`);
    if (result.credential) parts.push('登录信息已保存在本机，以后无需重复填写。');
    if (platform === 'matiji' && !result.credentials?.find(c => c.platform === 'matiji')?.configured) {
      parts.push('账号已保存；在「设置登录」中粘贴一次码蹄集 Cookie 后即可获取记录。');
    } else if (platform === 'leetcode-cn' && cookie) {
      try {
        const sync = await requestSync({ accountId: result.id, mode: 'backfill', force: false });
        state.syncWatching = true;
        pollSync();
        parts.push(sync.followed ? '已有回补任务正在运行，请结束后继续回补本账号。' : '已开始回补此力扣账号的历史记录，可继续浏览或取消获取。');
      } catch (error) { parts.push(`登录信息已保存，回补暂未启动：${error.message}。`); }
    } else if (platform === 'matiji') {
      try {
        const sync = await requestSync({ accountId: result.id, mode: 'recent', force: true });
        state.syncWatching = true;
        pollSync();
        parts.push(sync.followed ? '已有获取任务正在进行，本账号可稍后点击「重试同步」或顶部「同步最新数据」。' : '已开始获取近期记录，完成后自动显示；更早的记录可点击「回补历史」。');
      } catch (error) { parts.push(`账号已保存，暂未开始获取：${error.message}。可点击顶部「同步最新数据」重试。`); }
    } else parts.push('获取近期记录请点击页面顶部的「同步最新数据」；补充以前的记录请点击下方「回补历史」（仅支持历史抓取的平台可用）。');
    status.textContent = parts.join(' ');
    status.classList.add('is-ok');

    await refreshAll();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('is-bad');
  } finally {
    state.adminBusy = false;
    $('bindSubmit').disabled = false;
  }
}

function credentialActionLabel(action) {
  return { updated: '覆盖了原有值', uncommented: '替换了模板里的注释行', appended: '新增了一行' }[action] ?? action;
}

/* ---------- 同步 ---------- */

function setSyncStatus(text, tone) {
  const node = $('syncStatus');
  node.className = `form-status${tone ? ` is-${tone}` : ''}`;
  node.textContent = text ?? '';
  node.hidden = !text;
}

function setSyncBusy(busy) {
  // 保留回补入口：服务端会中止近期获取，重复回补则跟随已有任务。
  $('syncBackfillBtn').disabled = false;
}

function renderRuns(runs) {
  const box = $('syncRuns');
  clear(box);
  if (!runs || !runs.length) return;
  box.append(el('h3', { text: '最近同步', style: 'margin:12px 0 6px' }));
  for (const run of runs.slice(0, 5)) {
    const tone = run.status === 'success' ? 'ac' : run.status === 'running' ? 'warn' : 'bad';
    const when = run.finished_at ?? run.started_at;
    box.append(el('div', { class: 'account-row' }, [
      el('span', { class: `badge ${tone}`, text: run.status }),
      el('span', { text: `${run.platform}/${run.handle}` }),
      el('span', { class: 'grow', text: `抓 ${num(run.fetched)} · 新增 ${num(run.inserted)}` }),
      el('span', { class: 'field-hint', text: fmtRelative(when), title: fmtDateTime(when) }),
    ]));
    if (run.message) box.append(el('p', { class: 'field-hint', text: run.message }));
  }
}

async function startSync(mode, account = null) {
  if (mode === 'backfill' && account?.historyPrerequisite) { openAccountSetup(account); return; }
  if (mode === 'backfill' && !window.confirm('回补历史会抓取支持该功能的平台；仅提供近期记录或文件导入的平台会跳过（洛谷这种量级要几分钟）。\n\n继续？')) return;
  setSyncStatus('');
  setSyncBusy(true);
  try {
    // 已经在跑的那一轮（比如另一个页面刚点过）不当失败：跟着它跑到完就行。
    const started = await requestSync({ mode, accountId: account?.id ?? null, force: false });
    state.syncWatching = true;
    setSyncStatus(started.followed ? '已经有一轮同步在跑，跟着它跑完…' : '同步已开始，正在后台抓取…');
    pollSync();
  } catch (error) {
    setSyncBusy(false);
    setSyncStatus(`启动失败：${error.message}`, 'bad');
  }
}

async function pollSync() {
  clearTimeout(state.syncTimer);
  try {
    const body = await api('/api/sync/status', {});
    renderRuns(body.runs);
    const job = body.job;
    if (job && job.running) {
      const label = job.mode === 'backfill' ? '回补历史' : '同步最新数据';
      const scope = job.accountId === null ? '全部账号' : `账号 ${job.accountId}`;
      setSyncStatus(`${label}进行中（${scope}，已跑 ${fmtRelative(job.startedAt)}）…`);
      setSyncBusy(true);
      state.syncTimer = setTimeout(pollSync, 1500);
      return;
    }

    setSyncBusy(false);
    // 只在「刚才确实在跑」时收尾并刷新，避免每次开面板都刷一遍数据。
    if (!state.syncWatching) return;
    state.syncWatching = false;
    if (job?.cancelled) {
      setSyncStatus('已取消获取，已保存的数据会保留。');
    } else if (job && job.error) {
      setSyncStatus(`同步失败：${job.error}`, 'bad');
    } else if (job && job.results) {
      // 「跳过」和「失败」必须分开报：跳过是前置条件没配齐（一个请求都没发出），
      // 失败是试过了但挂了。把前者渲染成红字会让人以为凭据坏了，实际只是还没填。
      const failed = job.results.filter((r) => r.status === 'failed');
      const skipped = job.results.filter((r) => r.status === 'skipped');
      const fetched = job.results.reduce((sum, r) => sum + r.fetched, 0);
      const inserted = job.results.reduce((sum, r) => sum + r.inserted, 0);
      const parts = [`同步完成：抓取 ${num(fetched)} 条，新增 ${num(inserted)} 条。`];
      if (skipped.length) {
        parts.push(
          `跳过 ${num(skipped.length)} 个账号（前置条件没配齐，一个请求都没发出）：${skipped.map(skipLabel).join('；')}。`,
        );
      }
      if (failed.length) {
        parts.push(`${num(failed.length)} 个账号抓取失败：${failed.map((r) => r.message).join('；')}。`);
      }
      setSyncStatus(parts.join(' '), failed.length ? 'bad' : skipped.length ? 'warn' : 'ok');
    }
    await refreshAll();
  } catch (error) {
    setSyncBusy(false);
    state.syncWatching = false;
    setSyncStatus(`读取同步状态失败：${error.message}`, 'bad');
  }
}

/** 重新拉 meta（账号、用户、凭据状态）与动态数据。写操作之后必须走一遍。 */
async function refreshAll(background = false) {
  try {
    const meta = await api('/api/meta', {});
    state.meta = meta;
    renderMeta(meta, background);
    $('footInfo').textContent = `数据库：${meta.dbPath} · 读取时间 ${fmtDateTime(meta.generatedAt)}`;
    await reload({ background });
  } catch (error) {
    if (background) throw error;
    setAdminStatus(`刷新失败：${error.message}`, 'bad');
  }
}

/* ---------- 顶栏「同步最新数据」 ---------- */

/*
 * 顶栏那个按钮是**同步**，不是「重新读取」—— 这一页显示的是本机 SQLite，而本机库里
 * 不会有刚刚在 CF / 洛谷上交的题。所以点击 = 抓一次 → 重绘，并把结果说出来。
 * 两个动作分开摆只会让人困惑（点了「刷新」什么都没变），所以合成一件事。
 *
 * 与「账号管理」里那两个按钮的分工：
 *  - 顶栏：**全部账号**、最近窗口。日常用这个。
 *  - 账号管理：按单个账号回补全部历史（唯一入口，藏在那里是刻意的）。
 * 两者都走同一个 POST /api/sync，服务端同一时刻只允许一个任务，撞上会得到 409。
 */

const SYNC_POLL_MS = 1200;
/** 等待上限。洛谷要翻好几页（每页限速 2.1 秒），给到 3 分钟。 */
const SYNC_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `tone`：ok（默认绿）/ warn（待配置那种中性黄）/ bad（红）。 */
function setSyncNotice(text, tone) {
  const node = $('syncNotice');
  clear(node);
  if (!text) {
    node.hidden = true;
    return;
  }
  const base = tone === 'warn' ? 'notice notice-warn' : 'notice notice-ac';
  node.className = tone === 'bad' ? `${base} is-bad` : base;
  node.textContent = text;
}

/** 轮询到本轮任务结束，返回这一轮的结果数组。 */
async function waitForSync(jobId) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  for (;;) {
    const body = await api('/api/sync/status', {});
    const job = body.job;
    // 必须认 id：上一轮跑完后 job 会一直挂在服务端，不认 id 会立刻读成「已完成」。
    if (job && job.id === jobId && !job.running) {
      if (job.error) throw new Error(job.error);
      return job.results ?? [];
    }
    if (Date.now() > deadline) throw new Error('等待同步超时，去「账号管理」看同步记录');
    await sleep(SYNC_POLL_MS);
  }
}

/** 同步结果 → 一行回执。跳过与失败分开报，理由与「账号管理」里的一致。 */
function describeSync(results) {
  const at = new Date().toLocaleTimeString('zh-CN');
  if (!results.length) return `${at} · 同步结束：没有需要抓取的账号。`;
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const fetched = results.reduce((sum, r) => sum + r.fetched, 0);
  const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
  const parts = [`${at} · 同步完成：抓取 ${num(fetched)} 条，新增 ${num(inserted)} 条。`];
  if (skipped.length) {
    parts.push(`跳过 ${num(skipped.length)} 个账号（前置条件没配齐，一个请求都没发出）：${skipped.map(skipLabel).join('；')}。`);
  }
  if (failed.length) parts.push(`${num(failed.length)} 个账号抓取失败：${failed.map((r) => r.message).join('；')}。`);
  return parts.join(' ');
}

async function syncLatest() {
  if (state.syncing) return;
  state.syncing = true;
  $('syncBtn').disabled = true;
  $('syncBtn').textContent = '同步中…';
  setSyncNotice('正在从各平台拉取最新数据…', 'warn');
  try {
    const started = await requestSync({ mode: 'recent' });
    const results = await waitForSync(started.jobId);
    const failed = results.filter((r) => r.status === 'failed');
    const skipped = results.filter((r) => r.status === 'skipped');
    const note = started.followed ? '另一轮同步正在跑，跟着它跑完了 —— ' : '';
    setSyncNotice(note + describeSync(results), failed.length ? 'bad' : skipped.length ? 'warn' : 'ok');
    await refreshAll();
  } catch (error) {
    setSyncNotice(`同步失败：${error.message}`, 'bad');
  } finally {
    state.syncing = false;
    $('syncBtn').disabled = false;
    $('syncBtn').textContent = '同步最新数据';
  }
}

function setAdminOpen(open) {
  state.adminOpen = open;
  document.body.classList.toggle('account-page', open);
  document.title = `Algorithm DX · ${open ? '账号管理' : 'AC 记录'}`;
  const heading = document.querySelector('.ac-page-heading');
  heading.querySelector('h2').textContent = open ? '账号管理' : '每一次通过，都值得记录';
  heading.querySelector('.stats-eyebrow').textContent = open ? 'ACCOUNTS & SYNC' : 'PRACTICE JOURNAL';
  heading.querySelector('p').textContent = open ? '管理平台账号、登录配置和历史同步。' : '汇集各平台的解题足迹，回看尝试，也发现下一步。';
  for (const link of document.querySelectorAll('.site-header .nav a')) {
    const active = link.getAttribute('href') === (open ? '/?admin=1' : '/');
    link.classList.toggle('btn-primary', active);
    link.classList.toggle('btn-ghost', !active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('adminPanel').hidden = !open;
  $('adminBtn').setAttribute('aria-expanded', String(open));
  // 把开关也写进地址栏：等于给了一个「直接打开账号管理」的书签链接。
  syncUrl();
}

function openAccountSetup(account) {
  setAdminOpen(true);
  $('bindUser').value = String(account.user_id);
  $('bindPlatform').value = account.platform;
  syncBindForm();
  $('bindHandle').value = account.handle;
  $('adminPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setAdminStatus('为这个已有账号填写登录凭据，然后点击「保存账号」更新；已有记录会保留。');
  if (account.platform === 'leetcode-cn') setAdminStatus('力扣近期 AC 无需登录，历史记录需要本人登录 Cookie。粘贴后点击「保存账号」，会自动开始回补；已有记录和回补进度会保留。');
  $('bindCookie').focus();
}

function renderCoverageNotice(meta) {
  const notice = $('coverageNotice');
  clear(notice);
  const accounts = meta.accounts.filter(a => !a.is_archived);
  const fixture = /(^|[\\/_.-])fixture([\\/_.-]|$)/i.test(meta.dbPath);
  notice.classList.toggle('notice-danger', fixture);
  const add = (text, action, label) => notice.append(el('div', {}, [
    el('span', { text }), action ? el('button', { class: 'btn btn-ghost btn-small', type: 'button', text: label, onclick: action }) : null,
  ]));
  if (fixture) add('当前为测试数据，不是真实练习记录。');
  for (const account of accounts) {
    const label = accountLabel(account);
    if (account.retired) continue;
    if (account.prerequisite) {
      add(label + (account.prerequisite.kind === 'snapshot' ? '：等待导入记录文件。' : '：需要登录凭据才能同步。'), () => openAccountSetup(account), account.prerequisite.kind === 'snapshot' ? '导入记录' : '填写登录凭据');
    } else if (account.history?.supported && !account.history_complete && account.historyPrerequisite) {
      add(label + '：回补历史需要本人登录 Cookie；未配置时只同步公开近期 AC。', () => openAccountSetup(account), '配置登录并回补');
    } else if (account.last_error) {
      add(label + '：上次同步失败。' + account.last_error, () => syncLatest(), '重试同步');
    } else if (!account.last_success_at) {
      add(label + '：尚未同步。', () => syncLatest(), '同步最新数据');
    } else if (account.history?.supported && !account.history_complete) {
      add(label + '：历史尚未回补完整，目前数量只代表已抓取的记录。', () => startSync('backfill', account), '继续回补');
    }
  }
  const limited = accounts.filter(a => a.last_success_at && !a.prerequisite && !a.history?.supported);
  if (limited.length) {
    const details = el('details', {}, [el('summary', { text: '数据覆盖范围（' + limited.length + ' 个账号）' })]);
    for (const a of limited) details.append(el('p', { text: accountLabel(a) + '：' + a.history.detail }));
    notice.append(details);
  }
  const actionable = fixture || accounts.some(a => a.prerequisite || a.last_error || !a.last_success_at || (a.history?.supported && !a.history_complete));
  notice.classList.toggle('notice-neutral', !actionable);
  notice.hidden = !notice.childElementCount;
}

/* ---------- 统计 ---------- */

let platformStrip = null;

function renderStats(stats) {
  const row = $('statRow');
  clear(row);

  const card = (label, value, sub, tone) =>
    el('div', { class: `stat${tone ? ` ${tone}` : ''}` }, [
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-value', text: value }),
      sub ? el('div', { class: 'stat-sub', text: sub }) : null,
    ]);

  // 洛谷的比赛内编号（T…）与同名练习编号是同一道题，不计入题目数量口径。
  // 这里把「排除了多少」显式写出来，不做静默过滤。
  const contest = stats.contest_only ?? { submissions: 0, problems: 0, solved: 0 };

  row.append(
    card(
      '提交次数',
      num(stats.submissions),
      contest.submissions ? `含 WA/TLE 等全部尝试 · 含 ${num(contest.submissions)} 次比赛内提交` : '含 WA/TLE 等全部尝试',
      'is-sub',
    ),
    card(
      '尝试题数',
      num(stats.attempted),
      contest.problems ? `按（平台, 题号）去重 · 已排除 ${num(contest.problems)} 个洛谷比赛内编号` : '按（平台, 题号）去重',
    ),
    card('已 AC 题数', num(stats.solved), stats.attempted ? `占尝试题数 ${((stats.solved / stats.attempted) * 100).toFixed(1)}%` : '', 'is-ac'),
    card(
      '未 AC 题数',
      num(stats.unsolved),
      stats.partial_credit ? `至少提交过一次但未通过 · 其中 ${num(stats.partial_credit)} 次提交有部分分` : '至少提交过一次但未通过',
      'is-unac',
    ),
    card('活跃天数', num(stats.active_days), '按本地时区折算'),
    card(
      '记录区间',
      stats.first_at ? `${fmtDate(stats.first_at)}` : '—',
      stats.last_at ? `最近 ${fmtDate(stats.last_at)}` : '本地暂无记录',
    ),
  );

  if (!platformStrip) {
    platformStrip = el('div', { class: 'ac-platform-strip', 'aria-label': '各平台练习概览' });
    $('statRow').insertAdjacentElement('afterend', platformStrip);
  }
  clear(platformStrip);
  for (const p of stats.by_platform) {
    platformStrip.append(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-label', text: platformLabel(p.platform) }),
        el('div', { class: 'stat-value', text: `${num(p.solved)} AC` }),
        el('div', {
          class: 'stat-sub',
          text: `尝试 ${num(p.attempted)} 题 · ${num(p.submissions)} 次提交 · 活跃 ${p.active_days} 天`,
        }),
      ]),
    );
  }
  platformStrip.hidden = stats.by_platform.length === 0;
}

/* ---------- Feed ---------- */

function acCard(item) {
  const card = el('div', { class: 'card is-ac' });

  const title = el('h3', { class: 'card-title' });
  const url = safeUrl(item.problem_url);
  if (url) title.append(el('a', { href: url, target: '_blank', rel: 'noreferrer noopener', text: item.problem_title }));
  else title.append(document.createTextNode(item.problem_title));

  card.append(
    el('div', { class: 'card-top' }, [
      title,
      el('span', { class: 'badge ac', text: 'AC' }),
    ]),
    metaRow(item),
    acStats(item),
    cardFoot(item, true),
  );
  return card;
}

function unacCard(item) {
  const card = el('div', { class: 'card is-unac' });

  const title = el('h3', { class: 'card-title' });
  const url = safeUrl(item.problem_url);
  if (url) title.append(el('a', { href: url, target: '_blank', rel: 'noreferrer noopener', text: item.problem_title }));
  else title.append(document.createTextNode(item.problem_title));

  const lastDetail = `${fmtRelative(item.last_at)}尝试 · ${item.attempts} 次提交`;

  const stats = el('div', { class: 'card-stats' }, [
    el('span', {}, [el('span', { class: 'k', text: '尝试 ' }), el('span', { class: 'v', text: `${item.attempts} 次` })]),
  ]);
  // 洛谷的部分分：状态码只到 OTHER，看不出「差多远」，最高分才有信息量。
  if (item.best_score !== null) {
    stats.append(el('span', {}, [el('span', { class: 'k', text: '最高 ' }), el('span', { class: 'v', text: `${item.best_score} 分` })]));
  }
  if (item.latest_score !== null && item.latest_score !== item.best_score) {
    stats.append(el('span', {}, [el('span', { class: 'k', text: '最近 ' }), el('span', { class: 'v', text: `${item.latest_score} 分` })]));
  }

  card.append(
    el('div', { class: 'card-top' }, [
      title,
      el('span', { class: 'badge warn', text: '未 AC' }),
    ]),
    metaRow(item),
    stats,
    cardFoot(item, false, lastDetail),
  );
  return card;
}

function metaRow(item) {
  const row = el('div', { class: 'card-meta' }, [
    el('span', { class: 'badge platform', text: platformLabel(item.platform) }),
    el('span', { class: 'badge', text: item.problem_id }),
  ]);
  // 洛谷的比赛内编号与同名练习编号是同一道题，仍在动态里显示，但不计入 AC 题数。
  if (item.contest_scoped) {
    row.append(
      el('span', {
        class: 'badge contest',
        text: '比赛内编号',
        title: '洛谷比赛期间的临时编号，与同名的练习编号是同一道题。保留在动态里，但不计入 AC 题数。',
      }),
    );
  }
  if (item.difficulty !== null) row.append(el('span', { class: `badge diff ${difficultyClass(item.platform, item.difficulty)}`, text: difficultyLabel(item.platform, item.difficulty) }));
  else if(item.rating_state)row.append(el('span',{class:'badge',text:item.rating_state==='unrated'?'原题未评级':'待核对原题'}));
  if(item.source_url)row.append(el('a',{class:'badge',href:item.source_url,target:'_blank',rel:'noopener',text:'原题 '+item.source_problem_id}));
  const identity = el('div', { class: 'ac-card-identity', text: `${item.user_name} · ${shortAccountLabel(item)}` });
  if (item.ac_count > 1) row.append(el('span', { class: 'badge', text: `AC ${item.ac_count} 次` }));
  const tags = el('div', { class: 'ac-card-tags' });
  for (const tag of item.tags.slice(0, 4)) tags.append(el('span', { class: 'badge', text: tag }));
  return el('div', { class: 'ac-card-context' }, [row, tags, identity]);
}

function acStats(item) {
  const parts = [];
  const push = (k, v, title) => parts.push(el('span', title ? { title } : {}, [
    el('span', { class: 'k', text: `${k} ` }),
    el('span', { class: 'v', text: v }),
  ]));

  push('通过时间', fmtDateTime(item.ac ? item.ac.submitted_at : item.last_ac_at));
  // 最快用时只在「比赛窗口内的 AC」存在时有值：开赛 → 最早 AC 的差，范围内谁快算谁的。
  // duration 没刷新 / gym / 纯 practice 解掉的题不显示 —— 没有可靠数据就不编。
  if (item.fastest_solve_seconds !== null && item.fastest_solve_seconds !== undefined) {
    const who = item.fastest_user ? `（${item.fastest_user}）` : '';
    push('最快用时', `${fmtClock(item.fastest_solve_seconds)}${who}`,
      '比赛开始到最早一次 AC 的时长（范围内最快的人）；赛后再做的不算');
  }
  if (item.ac) {
    const dur = fmtDuration(item.ac.execution_time);
    const mem = fmtMemory(item.ac.memory);
    if (dur) push('运行耗时', dur);
    if (mem) push('内存', mem);
    if (item.ac.language) push('语言', languageLabel(item.ac.language));
  }
  return el('div', { class: 'card-stats' }, parts);
}

function cardFoot(item, solved, overrideText) {
  const left = el('span', {}, [
    el('span', { text: overrideText ?? (item.failed_count > 0 ? `另有 ${item.failed_count} 次未通过记录` : '当前记录均已通过') }),
  ]);
  const failed = item.failed_count;
  const label = solved
    ? failed > 0
      ? `尝试 ${item.attempts} 次（含 ${failed} 次未通过）`
      : `提交 ${item.attempts} 次`
    : `展开 ${item.attempts} 次提交`;

  const btn = el('button', {
    class: 'expand-btn',
    type: 'button',
    'aria-expanded': 'false',
    onclick: (event) => toggleDetail(item, event.currentTarget),
    title: label,
  }, [el('span', { class: 'caret', text: '▸' }), `提交详情 · ${item.attempts} 次`]);

  return el('div', { class: 'card-foot' }, [left, btn]);
}

function problemKey(item) {
  return `${item.platform}\u0000${item.problem_id}`;
}

async function toggleDetail(item, button) {
  const key = problemKey(item);
  const card = button.closest('.card');
  const existing = card.querySelector('.timeline');

  if (existing) {
    existing.remove();
    button.setAttribute('aria-expanded', 'false');
    button.querySelector('.caret').textContent = '▸';
    state.detailOpen.delete(key);
    return;
  }

  button.setAttribute('aria-expanded', 'true');
  button.querySelector('.caret').textContent = '▾';
  state.detailOpen.add(key);

  const holder = el('div', { class: 'timeline' }, [el('div', { class: 'tl-loading', text: '正在读取提交记录…' })]);
  card.append(holder);

  try {
    let rows = state.detailCache.get(key);
    if (!rows) {
      const body = await api('/api/problem', {
        ...filterParams(),
        platform: item.platform,
        problemId: item.problem_id,
      });
      rows = body.items;
      state.detailCache.set(key, rows);
    }
    clear(holder);
    if (!rows.length) holder.append(el('div', { class: 'tl-loading', text: '没有匹配当前筛选条件的提交。' }));
    for (const row of rows) holder.append(timelineRow(row));
    const self = state.meta?.users.find(u => u.is_self);
    const ownAccounts = new Set((state.meta?.accounts ?? []).filter(a => a.user_id === self?.id && a.platform === item.platform && !a.is_archived).map(a => a.handle));
    if (self && rows.some(r => ownAccounts.has(r.handle))) {
      const params = new URLSearchParams({ view: 'history', add: '1', user: String(self.id), platform: item.platform, problem: item.problem_id });
      holder.append(el('a', { class: 'btn btn-ghost', href: `/dx.html?${params}`, text: '添加我的练习用时 ↗' }));
    }
  } catch (error) {
    clear(holder);
    holder.append(el('div', { class: 'tl-error', text: `读取失败：${error.message}` }));
  }
}

function timelineRow(row) {
  const badge = el('span', {
    class: `badge ${STATUS_TONE[row.status] ?? ''}`.trim(),
    text: row.status,
    title: STATUS_LABELS[row.status] ?? row.status,
  });
  const detail = [
    row.score === null || row.score === undefined ? null : `${row.score} 分`,
    fmtDuration(row.execution_time),
    fmtMemory(row.memory),
    row.language ? languageLabel(row.language) : null,
    row.raw_status,
  ]
    .filter(Boolean)
    .join(' · ');
  return el('div', { class: 'tl-row' }, [
    el('span', { class: 'tl-time', text: fmtDateTime(row.submitted_at), title: row.submission_id }),
    el('span', { class: 'tl-detail', text: detail || '—' }),
    badge,
  ]);
}

function renderFeed() {
  const solved = state.items.filter((i) => i.solved);
  const unsolved = state.items.filter((i) => !i.solved);

  const acCards = $('acCards');
  const unacCards = $('unacCards');
  clear(acCards);
  clear(unacCards);

  const showAc = state.filters.status !== 'unac';
  const showUnac = state.filters.status !== 'ac';

  $('acSection').hidden = !showAc;
  $('unacSection').hidden = !showUnac;

  for (const item of solved) acCards.append(acCard(item));
  for (const item of unsolved) unacCards.append(unacCard(item));

  $('acCount').textContent = solved.length ? `${solved.length}` : '';
  $('unacCount').textContent = unsolved.length ? `${unsolved.length}` : '';

  if (showAc) {
    $('acHint').textContent = state.filters.status === 'all'
      ? `本轮取回 ${solved.length} 个已 AC 题目`
      : `共 ${state.total} 个已 AC 题目，已显示 ${solved.length} 个`;
  }
  if (showUnac) {
    $('unacHint').textContent = state.filters.status === 'unac'
      ? `共 ${state.total} 个未 AC 题目，已显示 ${unsolved.length} 个`
      : `${unsolved.length} 个（默认收起）`;
  }

  if (showUnac) setUnacOpen(state.filters.status === 'unac' ? true : state.unacOpen);

  const pager = $('pager');
  pager.hidden = state.items.length >= state.total || state.total === 0;
  $('pagerHint').textContent = `已显示 ${state.items.length} / ${state.total}`;
  $('moreBtn').disabled = state.loading;

  $('empty').hidden = state.total !== 0;
  if (state.total === 0) renderEmpty();
}

function renderEmpty() {
  const meta = state.meta;
  const noData = meta && meta.problems.attempted === 0;
  $('emptyTitle').textContent = noData ? '本地数据库还没有提交记录' : '这个筛选条件下没有记录';
  $('emptyBody').textContent = noData
    ? '先绑定平台账号并同步一次，数据就会出现在这里。'
    : '尝试放宽平台、用户或状态筛选。';
  $('emptyHint').textContent = noData ? `数据库：${meta.dbPath}` : '';
}

function setUnacOpen(open) {
  state.unacOpen = open;
  $('unacToggle').setAttribute('aria-expanded', String(open));
  $('unacCards').hidden = !open;
}

/* ---------- 载入流程 ---------- */

function showPlaceholder(show) {
  $('placeholder').hidden = !show;
  if (show) {
    $('placeholder').querySelector('p').textContent = '正在读取本地数据…';
    $('empty').hidden = true;
  }
}

async function reload({ append = false, background = false } = {}) {
  if (state.loading) { state.reloadPending = true; return; }
  state.loading = true;
  $('moreBtn').disabled = true;
  if (!append && !background) {

    showPlaceholder(true);
    state.offset = 0;
    state.items = [];
    state.detailCache.clear();
    state.detailOpen.clear();
  }

  try {
    const params = filterParams();
    const feedPromise = background ? (async () => {
      const wanted = Math.max(state.limit, state.offset);
      const first = await api('/api/feed', { ...params, limit: Math.min(200, wanted), offset: 0 });
      while (first.items.length < Math.min(wanted, first.total)) {
        const next = await api('/api/feed', { ...params, limit: Math.min(200, wanted - first.items.length), offset: first.items.length });
        if (!next.items.length) break;
        first.items.push(...next.items);
        first.total = next.total;
      }
      return first;
    })() : api('/api/feed', { ...params, limit: state.limit, offset: state.offset });
    const statsPromise = append ? Promise.resolve(null) : api('/api/stats', params);
    const [feed, stats] = await Promise.all([feedPromise, statsPromise]);

    if (stats) renderStats(stats.stats);
    state.items = append ? state.items.concat(feed.items) : feed.items;
    state.total = feed.total;
    state.offset = state.items.length;
    showPlaceholder(false);
    renderFeed();
    syncUrl();
  } catch (error) {

    showPlaceholder(false);
    if (background) throw error;
    clear($('acCards'));
    clear($('unacCards'));
    $('acSection').hidden = true;
    $('unacSection').hidden = true;
    $('pager').hidden = true;
    $('empty').hidden = false;
    $('emptyTitle').textContent = '读取失败';
    $('emptyBody').textContent = error.message;
    $('emptyHint').textContent = '';
  } finally {
    state.loading = false;
    $('moreBtn').disabled = false;
    if (state.reloadPending) { state.reloadPending = false; reload(); }
  }
}

function syncUrl() {
  const search = new URLSearchParams();

  if (state.filters.platforms.length) search.set('platform', state.filters.platforms.join(','));
  search.set('user', String(state.filters.user));
  if (state.filters.status !== 'all') search.set('status', state.filters.status);
  if (state.filters.q) search.set('q', state.filters.q);
  if (state.adminOpen) search.set('admin', '1');
  const qs = search.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function readUrl() {
  const search = new URLSearchParams(location.search);
  const platforms = (search.get('platform') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => PLATFORM_LABELS[s]);
  state.filters.platforms = platforms;
  state.filters.user = search.get('user') ?? 'all';
  state.legacySelfFilter = !search.has('user') || (state.filters.user === 'all' && search.get('scope') === 'me');
  const status = search.get('status');
  state.filters.status = status === 'ac' || status === 'unac' ? status : 'all';
  state.filters.q = search.get('q') ?? '';
  state.adminOpen = search.get('admin') === '1';
}

/* ---------- 事件绑定 ---------- */

function togglePlatform(platform) {
  const list = state.filters.platforms;
  const index = list.indexOf(platform);
  if (index >= 0) list.splice(index, 1);
  else list.push(platform);
  renderPlatformChipsOnly();
  reload();
}

function renderPlatformChipsOnly() {
  for (const chip of $('platformChips').children) {
    chip.classList.toggle('is-on', state.filters.platforms.includes(chip.dataset.platform));
  }
}

function bindEvents() {
  $('cfGroupSetup').addEventListener('click', () => {
    const account = state.meta?.accounts.find(a => String(a.id) === $('cfGroupAccount').value && a.platform === 'codeforces' && !a.is_archived);
    if (account) openCfGroups(account, () => refreshAll());
  });
  $('matijiIdentityBtn').addEventListener('click', async () => {
    const button = $('matijiIdentityBtn');
    button.disabled = true;
    const originalHandle = $('bindHandle').value;
    setAdminStatus('正在识别码蹄集登录账号…');
    try {
      const identity = await postJson('/api/accounts/matiji/identity', { cookie: $('bindCookie').value.trim() });
      if ($('bindPlatform').value !== 'matiji' || $('bindHandle').value !== originalHandle) return;
      $('bindHandle').value = identity.handle;
      setAdminStatus(`已识别 ${identity.displayName || '码蹄集账号'}（ID：${identity.handle}），请核对归属用户，再点击「保存账号」。`);
    } catch (error) { setAdminStatus(`识别失败：${error.message}`, 'bad'); }
    finally { button.disabled = false; }
  });
  $('syncBtn').addEventListener('click', syncLatest);

  $('adminBtn').addEventListener('click', () => setAdminOpen(!state.adminOpen));
  $('adminCloseBtn').addEventListener('click', () => setAdminOpen(false));
  $('bindUser').addEventListener('change', syncBindForm);
  $('bindPlatform').addEventListener('change', syncBindForm);
  $('bindForm').addEventListener('submit', submitBind);
  $('syncBackfillBtn').addEventListener('click', () => startSync('backfill'));

  $('userSelect').addEventListener('change', (event) => {
    state.filters.user = event.target.value;
    reload();
  });

  for (const tab of $('statusTabs').querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of $('statusTabs').querySelectorAll('.tab')) {
        other.classList.remove('is-active');
        other.setAttribute('aria-selected', String(other === tab));
      }
      tab.classList.add('is-active');
      state.filters.status = tab.dataset.status;
      reload();
    });
  }

  let searchTimer = null;
  $('resetFilters').addEventListener('click', () => {
    clearTimeout(searchTimer);
    const self = String(state.meta?.users.find(user => user.is_self)?.id ?? 'all');
    state.filters = { platforms: [], user: self, status: 'all', q: '' };
    $('userSelect').value = self;
    $('searchInput').value = '';
    renderPlatformChipsOnly();
    for (const tab of $('statusTabs').querySelectorAll('.tab')) {
      const active = tab.dataset.status === 'all';
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    reload();
  });
  $('searchInput').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = value.trim();
      reload();
    }, 280);
  });

  $('unacToggle').addEventListener('click', () => setUnacOpen(!state.unacOpen));

  $('moreBtn').addEventListener('click', () => reload({ append: true }));
}

/* ---------- 启动 ---------- */

async function boot() {
  // 平台 chips 需要 dataset.platform 才能单独切换高亮，这里在构建后补上。
  bindEvents();
  readUrl();
  setAdminOpen(state.adminOpen);
  $('searchInput').value = state.filters.q;
  for (const tab of $('statusTabs').querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.status === state.filters.status);
  }

  showPlaceholder(true);
  try {
    const meta = await api('/api/meta', {});
    state.meta = meta;
    renderMeta(meta);
    $('footInfo').textContent = `数据库：${meta.dbPath} · 读取时间 ${fmtDateTime(meta.generatedAt)}`;
    await reload();
    // 上一次同步可能还在后台跑（比如刚刷新过页面），把进度接上。
    pollSync();
  } catch (error) {
    showPlaceholder(false);
    $('empty').hidden = false;
    $('emptyTitle').textContent = '无法连接本地服务';
    $('emptyBody').textContent = error.message;
    $('emptyHint').textContent = '请确认 npm run dashboard 仍在运行。';
  }
}

boot().finally(() => startAutoSync(async () => { state.detailCache.clear(); await refreshAll(true); }));
