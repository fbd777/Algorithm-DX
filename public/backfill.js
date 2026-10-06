// Account-scoped backfill: preserve the saved cursor and never treat another job as ours.
export function createBackfillController({ request, notify, refresh, schedule = setTimeout, cancel = clearTimeout }) {
  let busy = false, timer, stopped = false;
  const update = text => { if (!stopped) notify({ busy, text }); };
  async function poll(jobId, account) {
    try {
      const { body, status } = await request('/api/sync/status');
      if (status >= 400) throw new Error(body.error || '读取进度失败');
      const job = body.job;
      if (!job || job.id !== jobId || job.accountId !== account.id || job.mode !== 'backfill') {
        busy = false; update('当前任务已变化，请刷新数据后查看覆盖状态。'); await refresh(); return;
      }
      if (job.running) {
        update(`${account.handle}：正在回补历史…记录较多时需要几分钟，可继续浏览。`);
        if (!stopped) timer = schedule(() => void poll(jobId, account), 1500);
        return;
      }
      busy = false;
      if (job.cancelled) { update(`${account.handle}：已取消回补，已保存的数据会保留。`); await refresh(); return; }
      const result = job.results?.find(r => r.accountId === account.id);
      if (job.error) throw new Error(job.error);
      if (!result || result.status !== 'success') throw new Error(result?.message || '未完成，请重试');
      update(`${account.handle}：本轮回补完成，读取 ${result.fetched} 条，新增 ${result.inserted} 条。若仍显示“历史待回补”，可继续回补。`);
      await refresh();
    } catch (error) { busy = false; update(`回补状态未确认：${error.message}。可刷新数据查看，已有记录会保留。`); }
  }
  return {
    async start(account) {
      if (busy || stopped) return;
      busy = true; update(`${account.handle}：正在启动历史回补…`);
      try {
        const { status, body } = await request('/api/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({accountId:account.id,mode:'backfill',force:false}) });
        if (status === 409) throw new Error('已有同步任务正在运行，本次回补尚未启动，请等待结束后重试');
        if (status >= 400 || !body.job) throw new Error(body.error || '无法启动回补');
        await poll(body.job.id, account);
      } catch (error) { busy = false; update(`回补未启动：${error.message}`); }
    },
    stop() { stopped = true; cancel(timer); },
  };
}
