import type { DatabaseSync } from 'node:sqlite';
import type { FetchBatch } from '../domain.ts';
import { Repository } from '../db/database.ts';
import { CodeforcesSyncFetcher } from '../fetchers/codeforces-sync.ts';
import { HttpClient } from '../fetchers/http.ts';
import { reconcileTimers } from '../dx/timer.ts';
import { redactSecrets } from '../credentials.ts';

export class TimerSubmissionChecker {
  private checks = new Map<number, { running: boolean; error: string | null; startedAt: number }>();
  constructor(privateDb: () => DatabaseSync, changed: () => void,
    fetchPublic?: (handle: string) => Promise<FetchBatch>) {
    this.getDb = privateDb; this.changed = changed;
    this.fetchPublic = fetchPublic ?? (async handle => {
      const db = this.getDb();
      const fetcher = new CodeforcesSyncFetcher(new Repository(db), new HttpClient(db));
      return fetchTimerWindow(fetcher, handle, Number(db.prepare(`SELECT MIN(t.started_at) AS started
        FROM practice_timers t JOIN accounts a ON a.id=t.account_id
        WHERE t.status='running' AND a.handle=? AND a.platform='codeforces'`).get(handle)?.started ?? 0));
    });
  }
  private getDb: () => DatabaseSync;
  private changed: () => void;
  private fetchPublic: (handle: string) => Promise<FetchBatch>;
  state(accountId: number) { return this.checks.get(accountId) ?? null; }
  async check(accountId: number) {
    const previous = this.checks.get(accountId);
    if (previous?.running || (previous && Date.now() - previous.startedAt < 3000)) return;
    const db = this.getDb();
    const account = db.prepare("SELECT * FROM accounts WHERE id=? AND platform='codeforces' AND is_archived=0").get(accountId);
    if (!account) return;
    const state = { running: true, error: null as string | null, startedAt: Date.now() };
    this.checks.set(accountId, state);
    try {
      const batch = await this.fetchPublic(String(account.handle));
      const current = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
      if (!current || current.is_archived || current.handle_key !== account.handle_key || current.user_id !== account.user_id) return;
      // No network awaits inside this transaction; group sync can keep fetching independently.
      db.exec('SAVEPOINT timer_public_check');
      try {
        new Repository(db).saveSubmissions(accountId, batch.submissions);
        reconcileTimers(db);
        db.exec('RELEASE timer_public_check');
      } catch (error) {
        db.exec('ROLLBACK TO timer_public_check; RELEASE timer_public_check');
        throw error;
      }
      this.changed();
    } catch (error) {
      state.error = redactSecrets(error instanceof Error ? error.message : '公开提交检查失败');
    } finally { state.running = false; }
  }
}

/** Use a small response when it covers the session; expand before counting verdicts. */
export async function fetchTimerWindow(fetcher: Pick<CodeforcesSyncFetcher, 'fetch_batch'>, handle: string, startedAt: number): Promise<FetchBatch> {
  const recent = await fetcher.fetch_batch(handle, { mode: 'recent', limit: 10, maxPages: 1 });
  if (recent.submissions.length < 10 || Math.min(...recent.submissions.map(row => row.submitted_at)) <= startedAt) return recent;
  return fetcher.fetch_batch(handle, { mode: 'recent', limit: 100, maxPages: 1 });
}
