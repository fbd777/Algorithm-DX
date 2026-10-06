// One controller per document. Refreshing data never starts another sync.
export function createSyncController({ request, refresh, notice = () => {}, onJob = () => {} }) {
  let busy = false, pendingStart = false, revision;
  return async function check(start = false) {
    pendingStart ||= start;
    if (busy) return;
    busy = true;
    try {
      let status = await request('/api/sync/status');
      if (revision !== status.revision) {
        await refresh();
        revision = status.revision;
      }
      if (pendingStart) {
        // Consume before POST: a lost response must not cause a duplicate retry.
        pendingStart = false;
        if (!status.job?.running && Date.now() >= (status.nextAutoAt || 0)) {
          const result = await request('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'recent', automatic: true }) });
          status = { ...status, job: result.job };
        }
      }
      const job = status.job;
      onJob(job);
      if (job?.cancelling && job.running) notice('正在取消获取…');
      else if (job?.running) notice(job.mode === 'backfill' ? '正在回补历史…' : '正在后台更新…');
      else if (job?.cancelled) notice('已取消获取');
      else if (job?.error) notice('自动更新未完成，可点击同步重试');
      else if (job?.results?.some(r => r.status === 'failed')) notice('部分平台更新失败：'+(job.results.find(r=>r.status==='failed')?.message||'请查看同步记录'));
      else notice('');
    } catch {
      notice('暂时无法更新，稍后自动检查');
    } finally { busy = false; }
  };
}

export function startAutoSync(refresh = async () => {}) {
  const node = document.createElement('span');
  node.className = 'auto-sync-status';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  const syncBar = document.createElement('div');
  syncBar.className = 'global-sync-bar';
  syncBar.append(node);
  (document.querySelector('header') || document.body).append(syncBar);
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn btn-ghost';
  cancelButton.textContent = '取消获取';
  cancelButton.hidden = true;
  syncBar.append(cancelButton);
  let activeJob;
  cancelButton.addEventListener('click', async () => {
    if (!activeJob?.running) return;
    cancelButton.disabled = true;
    try {
      const response = await fetch('/api/sync/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: activeJob.id }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('取消失败');
      await check();
    } catch { node.hidden = false; node.textContent = '取消未确认，请重试'; cancelButton.disabled = false; }
  });
  const check = createSyncController({
    onJob: job => { activeJob = job; cancelButton.hidden = !job?.running; cancelButton.disabled = Boolean(job?.cancelling); },
    refresh,
    notice: text => { node.textContent = text; node.hidden = !text; },
    request: async (path, options = {}) => {
      const response = await fetch(path, { ...options, cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok && !(response.status === 409 && body.job?.running)) throw new Error('更新失败');
      return body;
    },
  });
  let timer, generation = 0;
  const tick = async (start = false) => {
    const current = ++generation;
    clearTimeout(timer);
    if (navigator.onLine !== false) await check(start);
    else { node.hidden = false; node.textContent = '网络已断开，联网后自动更新'; }
    if (current !== generation) return;
    timer = setTimeout(tick, document.hidden ? 15000 : 2500);
  };
  window.addEventListener('online', () => tick(true));
  window.addEventListener('pageshow', event => { if (event.persisted) tick(true); });
  window.addEventListener('pagehide', () => { ++generation; clearTimeout(timer); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  void tick(true);
}
