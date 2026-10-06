import type { DatabaseSync } from 'node:sqlite';
import type { SyncJobRunner } from './sync-job.ts';
import { reconcileTimers } from '../dx/timer.ts';

/** Poll only accounts with active timers, including while the browser is closed. */
export function createTimerSync(readDb: DatabaseSync, openWrite: () => DatabaseSync, jobs: SyncJobRunner) {
  const checkedAt = new Map<number, number>();
  return (now = Date.now()) => {
    if (!readDb.prepare("SELECT 1 FROM practice_timers WHERE status='running' LIMIT 1").get()) return;
    reconcileTimers(openWrite());
    const rows = readDb.prepare("SELECT DISTINCT account_id FROM practice_timers WHERE status='running' ORDER BY started_at").all();
    for (const row of rows) {
      const accountId = Number(row.account_id);
      if (now - (checkedAt.get(accountId) ?? -Infinity) < 15_000) continue;
      checkedAt.set(accountId,now);
      void jobs.checkTimer(accountId);
      break;
    }
  };
}
