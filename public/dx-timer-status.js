export function timerSyncNotice(status, timer) {
  const job = status.job;
  if (job?.running && (job.accountId == null || job.accountId === timer.account_id)) {
    return '正在检查最新提交，确认对应 AC 后会自动停止并保存。';
  }
  const run = status.runs?.find(run => run.account_id === timer.account_id && run.started_at >= timer.started_at);
  if (run?.status === 'failed') {
    if (run.error_code === 'CF_EXTENSION_REQUIRED') {
      return '无法检查 AC：Edge 扩展未连接。请打开已登录的 CF 标签页，在 Algorithm DX 扩展点击“连接”，再点“检查 AC”。恢复后按实际 AC 提交时间保存用时。';
    }
    return `提交同步失败：${run.message || '请检查同步状态后重试'}。恢复同步后会自动检查 AC。`;
  }
  if (job?.error && job.startedAt >= timer.started_at && (job.accountId == null || job.accountId === timer.account_id)) {
    return `提交同步失败：${job.error}。恢复同步后会自动检查 AC。`;
  }
  return '等待对应题目的 AC 判定；仅提交或尚未通过时，计时会继续。';
}
