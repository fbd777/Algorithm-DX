import { startAutoSync } from './auto-sync.js';
import { difficultyLabel, difficultyClass } from './stat-labels.js';
import { createBackfillController } from './backfill.js';
const $ = id => document.getElementById(id);
const labels = { codeforces:'Codeforces',luogu:'洛谷',atcoder:'AtCoder',leetcode:'LeetCode','leetcode-cn':'力扣中国站',nowcoder:'牛客',matiji:'码蹄集' };
const initial = new URLSearchParams(location.search);
let selected = initial.get('user') || '', includeArchived = initial.get('archived') === '1';
let people = [], accounts = [], next = null, version = 0, lastDay = '', loading = false;
let metaReady = false;
let backfillState = {busy:false,text:''};
const backfill = createBackfillController({
  request: async (path,options={}) => { const res=await fetch(path,{...options,cache:'no-store',signal:AbortSignal.timeout(15000)}); return {status:res.status,body:await res.json()}; },
  notify: state => {
    backfillState=state;
    const notice=$('backfillStatus'); if(notice) {notice.textContent=state.text;notice.hidden=!state.text;}
    for(const button of document.querySelectorAll('.circle-backfill')) button.disabled=state.busy;
  },
  refresh: async()=>{metaReady=false;await refresh();const panel=document.querySelector('.circle-coverage');if(panel)panel.open=true;},
});
window.addEventListener('pagehide',event=>{if(!event.persisted)backfill.stop();});
const date = value => value == null ? '暂无记录' : new Date(value * 1000).toLocaleString('zh-CN', { hour12:false });
function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
function link(text, href) { const a = el('a','btn btn-ghost',text); a.href = href; return a; }
function avatar(person) { const n = el('span','circle-avatar',Array.from(person.name)[0] || '友'); n.style.setProperty('--hue',String((Number(person.id)*67+130)%360)); n.setAttribute('aria-hidden','true'); return n; }
async function get(path) { const res = await fetch(path, {cache:'no-store',signal:AbortSignal.timeout(15000)}); const body = await res.json(); if (!res.ok) throw new Error(body.error || '读取失败'); return body; }
for (const [key, label] of Object.entries(labels)) { const opt = el('option','',label); opt.value = key; $('platform').append(opt); }
$('platform').value = labels[initial.get('platform')] ? initial.get('platform') : '';
$('status').value = ['ac','unac'].includes(initial.get('status')) ? initial.get('status') : 'all';
$('period').value = ['7','30','90'].includes(initial.get('period')) ? initial.get('period') : 'all';
$('query').value = initial.get('q') || '';
function params() {
  const p = new URLSearchParams();
  if (selected) p.set('user',selected);
  if (selected && includeArchived) p.set('archived','1');
  for (const [id,key] of [['platform','platform'],['status','status'],['query','q'],['period','period']]) if ($(id).value && $(id).value !== 'all') p.set(key,$(id).value);
  return p;
}
function renderPeople() {
  $('peopleCount').textContent = `${people.length} 位`;
  $('people').replaceChildren();
  const all = {id:'',name:'全部题友',solved:null};
  const q = $('peopleSearch').value.trim().toLowerCase();
  for (const person of [all,...people.filter(p=>p.name.toLowerCase().includes(q))]) {
    const button = el('button','circle-person'); button.type = 'button'; button.setAttribute('aria-pressed',String(String(person.id)===selected));
    const text = el('span'); text.append(el('strong','',person.name),el('small','',person.solved === null ? '关注的人 · 最新动态' : `${person.solved} 题已通过 · ${person.submissions} 次提交`));
    button.append(avatar(person),text); button.addEventListener('click',()=>choose(String(person.id))); $('people').append(button);
  }
  if (q && !people.some(p=>p.name.toLowerCase().includes(q))) $('people').append(el('p','circle-note','没有找到这位题友'));
}
function choose(id) { selected = id; includeArchived = false; next = null; void refresh(); }
function renderProfile() {
  const host = $('profile'); host.replaceChildren();
  $('feedTitle').textContent = selected ? 'TA 的做题动态' : '题友的新鲜事';
  if (!selected) return;
  const person = people.find(p=>String(p.id)===selected);
  if (!person) { host.append(el('p','circle-empty','这位用户未被关注或已不存在，请从左侧选择题友。')); return; }
  const box = el('section','circle-profile');
  box.append(el('span','circle-eyebrow','题友的个人空间'),el('h2','',person.name),el('p','',`当前账号已收录 ${person.submissions} 次提交，通过 ${person.solved} 道题。最近练习：${date(person.last_at)}`));
  const links = el('div','circle-links'); links.append(link('题目档案',`/?user=${selected}`),link('练习统计与热力图',`/stats.html?user=${selected}`),link('DX 成绩',`/dx.html?user=${selected}`)); box.append(links);
  const owned = accounts.filter(a=>String(a.user_id)===selected);
  const active = owned.filter(a=>!a.is_archived);
  const archived = owned.filter(a=>a.is_archived && a.stored_submissions > 0);
  const attention = owned.filter(a=>!a.is_archived && (a.prerequisite || a.last_error || !a.last_success_at)).length;
  const detail = el('details','circle-coverage');
  if(active.some(a=>a.history?.supported&&!a.history_complete)) {
    const shortcut=el('button','btn btn-ghost','回补历史');shortcut.type='button';
    shortcut.addEventListener('click',()=>{detail.open=true;detail.querySelector('.circle-backfill, .circle-setup')?.focus();});links.append(shortcut);
  }
  const notice=el('p','circle-backfill-status',backfillState.text);notice.id='backfillStatus';notice.hidden=!backfillState.text;notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');box.append(notice);
  const summary = el('summary');
  summary.append(el('span','','平台账号与数据覆盖'),el('span','circle-coverage-count',`${active.length} 个账号`));
  if (attention) summary.append(el('span','circle-coverage-status needs-attention',`${attention} 个待处理`));
  detail.append(summary);
  const oldAccounts = el('details','circle-old-accounts');
  oldAccounts.open = includeArchived;
  oldAccounts.append(el('summary','',`旧账号历史（${archived.length}）`));
  for (const account of [...active,...archived]) {
    const item = el('details','circle-account');
    const heading = el('summary','circle-account-summary');
    const identity = el('span','circle-account-identity');
    identity.append(el('strong','',labels[account.platform] || account.platform),el('span','',account.display_name || account.handle));
    const status = account.is_archived ? '已归档' : account.prerequisite ? '待配置' : account.last_error ? '同步失败' : !account.last_success_at ? '尚未同步' : account.history_complete ? '可见历史已回补' : account.history?.supported ? '历史待回补' : '近期记录';
    const warning = !account.is_archived && (account.prerequisite || account.last_error || !account.last_success_at);
    heading.append(identity,el('span','circle-account-count',`${account.stored_submissions} 次提交 · ${account.stored_solved} 题通过`),el('span',`circle-coverage-status${warning ? ' needs-attention' : ''}`,status));
    item.append(heading);
    const body = el('div','circle-account-body');
    body.append(el('small','',`账号：${account.handle} · 最近同步成功：${date(account.last_success_at)}`));
    if (account.history?.detail) body.append(el('small','',account.history.detail));
    if (account.last_error) body.append(el('small','',`上次同步未完成：${account.last_error}`));
    if (account.prerequisite) body.append(el('small','','请在账号管理中补齐同步配置。'));
    if (account.platform === 'luogu') {
      body.append(el('small','','UID 用于绑定；抓取需你自己的洛谷 Cookie，关注账号共用。仅收录当前登录态可见的提交列表，不含源代码、逐测试点结果，私有或比赛隐藏记录可能不可见。'));
      const guide=el('a','circle-coverage-link','洛谷绑定与数据范围说明'); guide.href='/help.html#luogu'; body.append(guide);
    }
    item.append(body);
    const wrap=el('div','circle-account-wrap');wrap.append(item);
    if(!account.is_archived && account.history?.supported && !account.history_complete) {
      if(account.prerequisite || account.historyPrerequisite) {const setup=link('配置登录后回补','/?admin=1');setup.classList.add('circle-setup');wrap.append(setup);}
      else {
        const button=el('button','btn btn-ghost circle-backfill','回补历史');button.type='button';button.disabled=backfillState.busy;
        button.setAttribute('aria-label',`回补 ${labels[account.platform]||account.platform} ${account.handle} 的历史`);
        button.title='只回补此账号，从上次进度继续';button.addEventListener('click',()=>backfill.start(account));wrap.append(button);
      }
    }
    (account.is_archived ? oldAccounts : detail).append(wrap);
  }
  if (!active.length) detail.append(el('p','circle-note','还没有绑定平台账号，添加账号并同步后就能看到动态。'));
  const footer=el('div','circle-coverage-footer');
  footer.append(el('small','','可见历史已回补 ≠ 全部评测记录。'),link('管理账号与同步', '/?admin=1'));
  detail.append(footer); box.append(detail);
  if (archived.length) {
    const label = el('label','circle-archive'); const input = el('input'); input.type='checkbox'; input.checked=includeArchived;
    input.addEventListener('change',()=>{includeArchived=input.checked; void refresh();}); label.append(input,document.createTextNode(' 在动态中包含旧账号的提交记录')); oldAccounts.append(label); detail.insertBefore(oldAccounts,footer);
    if (includeArchived) detail.open=true;
  }
  box.append(el('p','circle-note','动态包含未通过与重复提交；上方统计仅计当前账号。'));
  host.append(box);
}
function renderItem(row) {
  const day = new Date(row.submitted_at*1000).toLocaleDateString('zh-CN');
  if (day !== lastDay) { $('feed').append(el('h3','circle-day',day)); lastDay = day; }
  const card = el('article','circle-card'); const head = el('div','circle-card-head');
  const name = el('button','circle-name',row.user_name); name.type='button'; name.addEventListener('click',()=>choose(String(row.user_id)));
  const identity = el('div'); identity.append(name,el('div','circle-meta',`${labels[row.platform] || row.platform} · ${date(row.submitted_at)}${row.is_archived ? ' · 归档账号' : ''}`));
  const face = el('button','circle-face'); face.type='button'; face.setAttribute('aria-label',`查看 ${row.user_name} 的个人空间`);
  face.append(avatar({id:row.user_id,name:row.user_name})); face.addEventListener('click',()=>choose(String(row.user_id)));
  head.append(face,identity,el('span',`circle-result${row.status==='AC' ? ' ac' : ''}`,row.status==='AC' ? '通过了 ✓' : row.status==='PENDING' ? '等待判题' : `提交了 · ${row.status}`)); card.append(head);
  let safeUrl = null; try { const url = new URL(row.problem_url); if (['https:','http:'].includes(url.protocol)) safeUrl=url.href; } catch {}
  const problem = el(safeUrl ? 'a':'div','circle-problem',`${row.problem_id} · ${row.problem_title || '未命名题目'}`);
  if (safeUrl) { problem.href=safeUrl; problem.target='_blank'; problem.rel='noopener noreferrer'; problem.title='在原平台打开题目'; } card.append(problem);
  const tags = el('div','circle-tags'); if (row.difficulty != null) tags.append(el('span',difficultyClass(row.platform,row.difficulty),difficultyLabel(row.platform,row.difficulty)));
  let list; try { list=JSON.parse(row.tags_json); } catch { list=[]; } if (Array.isArray(list)) for (const tag of list) if (typeof tag==='string') tags.append(el('span','',tag));
  if (row.language) tags.append(el('span','',row.language)); card.append(tags);
  const details = el('details'); details.append(el('summary','','查看提交详情')); const grid = el('div','circle-detail');
  for (const [key,value] of [['提交编号',row.submission_id],['平台账号',row.handle],['原始判题结果',row.raw_status || row.status],['提交时间',date(row.submitted_at)],['执行时间',row.execution_time == null ? '未提供' : `${row.execution_time} ms`],['内存',row.memory == null ? '未提供' : `${row.memory} bytes`],['得分',row.score ?? '未提供']]) grid.append(el('div','',`${key}：${value}`));
  details.append(grid); card.append(details); $('feed').append(card);
}
async function refresh(append=false) {
  if (append && (loading || !next)) return;
  const current=++version; loading=true; $('more').disabled=true; $('feed').setAttribute('aria-busy','true'); $('message').textContent='正在读取动态…';
  const p=params(); history.replaceState(null,'',`${location.pathname}${p.size ? '?'+p : ''}`);
  if (p.has('period')) {p.set('since',String(Math.floor(Date.now()/1000)-Number(p.get('period'))*86400));p.delete('period');}
  if (append) p.set('cursor',next);
  if (!append) { next=null; lastDay=''; $('feed').replaceChildren(); $('more').hidden=true; renderPeople(); renderProfile(); }
  try {
    const [body,meta] = await Promise.all([get('/api/circle?'+p),metaReady ? Promise.resolve(null) : get('/api/meta')]);
    if (current !== version) return;
    if (meta) { accounts=meta.accounts; metaReady=true; }
    people=body.people; next=body.next; renderPeople(); if (!append) renderProfile();
    for (const item of body.items) renderItem(item);
    if (!$('feed').children.length) {
      const empty=el('div','circle-empty'); empty.append(el('h3','',!people.length ? '从关注一位题友开始' : '这里暂时没有动态'),el('p','',!people.length ? '添加题友的平台账号，同步后就能在这里相遇。' : '试试其他筛选条件；若还没有同步记录，请在账号管理中同步或回补历史。'),link(!people.length ? '＋ 添加题友' : '管理账号与同步','/?admin=1')); $('feed').append(empty);
    }
    $('more').hidden=!next; $('message').textContent=next ? '按提交时间倒序 · 点击题友名字查看个人空间' : body.items.length || append ? '已显示当前筛选下的全部本地记录' : '';
  } catch(error) { if (current===version) { $('message').textContent=`读取失败：${error.message}。请点击“${append ? '查看更多动态' : '刷新动态'}”重试。`; $('more').hidden=!(append && next); } }
  finally { if (current===version) { loading=false; $('more').disabled=false; $('feed').setAttribute('aria-busy','false'); } }
}
$('peopleSearch').addEventListener('input',renderPeople);
let debounce;
$('query').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>refresh(),250);});
for (const id of ['platform','status','period']) $(id).addEventListener('change',()=>refresh());
$('filters').addEventListener('submit',e=>{e.preventDefault();clearTimeout(debounce);void refresh();});
$('filters').addEventListener('reset',e=>{e.preventDefault();clearTimeout(debounce);$('query').value='';$('platform').value='';$('status').value='all';$('period').value='all';void refresh();});
$('more').addEventListener('click',()=>refresh(true));
$('refresh').addEventListener('click',()=>{metaReady=false;void refresh();});
await refresh();
let syncInitialized = false;
startAutoSync(async()=>{
  metaReady=false;
  if (!syncInitialized || !$('feed').children.length) { syncInitialized=true; await refresh(); }
  else $('message').textContent='本地数据已更新，点击“刷新动态”查看；当前阅读位置已保留。';
});
