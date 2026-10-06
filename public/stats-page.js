import { startAutoSync } from './auto-sync.js';
import { initAnalytics, initHeatmap } from './analytics.js';
import { saveStatisticsImage } from './stat-charts.js';
import { renderToday } from './today.js';

const labels = { codeforces: 'Codeforces', leetcode: 'LeetCode', 'leetcode-cn': '力扣中国站', atcoder: 'AtCoder', luogu: '洛谷', nowcoder:'牛客',matiji: '码蹄集' };
const user = document.getElementById('statsUser');
const platform = document.getElementById('statsPlatform');
const url = new URLSearchParams(location.search);
const analytics = initAnalytics(() => refresh(false));
const heatmap = initHeatmap(document.getElementById('heatmapHost'), syncUrl);
let revision = 0;
let heatRevision = 0;
let detailReady = false, heatReady = false;
const saveButton = document.getElementById('saveStatsImage');
const updateSave = () => { saveButton.disabled = !detailReady || !heatReady; };
saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  const message = document.getElementById('exportStatus'); message.textContent = '正在生成统计图片…';
  try { await saveStatisticsImage(); message.textContent = 'PNG 已生成，已发起下载。'; }
  catch(error) { message.textContent = `保存失败：${error.message}`; }
  finally { updateSave(); }
});

function peopleParams() {
  if (user.value === 'me') return { scope: 'me' };
  if (user.value !== 'all') return { user: user.value };
  return { scope: 'all' };
}
function syncUrl() {
  const params = new URLSearchParams(peopleParams());
  if (platform.value) params.set('platform', platform.value);
  analytics.syncUrl(params);
  if (heatmap.selection() !== 'recent') params.set('heatYear', heatmap.selection());
  history.replaceState(null, '', `${location.pathname}?${params}`);
}
async function get(path, params = {}) {
  const query = new URLSearchParams({ ...params, tz: String(-new Date().getTimezoneOffset()) });
  const response = await fetch(`${path}?${query}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '读取失败');
  return body;
}
async function refresh(includeHeat = true, background = false) {
  const current = ++revision;
  detailReady = false;
  if (includeHeat) heatReady = false;
  updateSave();
  if (!background) analytics.loading();
  const params = { ...peopleParams(), ...analytics.params() };
  if (platform.value) params.platform = platform.value;
  const detail = get('/api/stats', params).then(body => {
    if (current !== revision) return;
    analytics.render(body.analytics);
    renderToday(body.today);
    detailReady = true; updateSave();
    syncUrl();
  }).catch(error => { if (background) throw error; if (current === revision) { analytics.error(); document.getElementById('todayHost').textContent='今日数据读取失败，请刷新重试。'; } });
  if (includeHeat) {
    const heatCurrent = ++heatRevision;
    await Promise.all([detail, get('/api/stats', peopleParams()).then(body => {
      if (heatCurrent !== heatRevision) return;
      heatmap.render(body.analytics);
      heatReady = true; updateSave();
      syncUrl();
    }).catch(error => { if (background) throw error; if (heatCurrent === heatRevision) heatmap.error(); })]);
  } else await detail;
}

async function boot() {
  try {
    const meta = await get('/api/meta');
    for (const item of meta.users) {
      const option = document.createElement('option'); option.value = String(item.id); option.textContent = item.name; user.append(option);
    }
    for (const [value, label] of Object.entries(labels)) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; platform.append(option);
    }
    const requestedUser = url.get('user') || (url.get('scope') === 'all' ? 'all' : 'me');
    user.value = [...user.options].some(o => o.value === requestedUser) ? requestedUser : 'me';
    platform.value = labels[url.get('platform')] ? url.get('platform') : '';
    user.addEventListener('change', () => refresh(true));
    platform.addEventListener('change', () => refresh(false));
    await refresh();
  } catch (error) {
    document.getElementById('statsCoverage').textContent = `无法读取本地数据：${error.message}`;
    heatmap.error(); analytics.error();
  }
}
boot().finally(() => startAutoSync(() => refresh(true, true)));
// An open dashboard must move to the new local day even without new submissions.
let displayedDay = new Date().toLocaleDateString();
setInterval(() => {
  const day = new Date().toLocaleDateString();
  if (day !== displayedDay && !document.hidden) { displayedDay = day; void refresh(true); }
}, 30000);
