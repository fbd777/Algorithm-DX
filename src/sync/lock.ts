import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

/** Only reclaim an unexpired lease when its local owning process is proven absent. */
function ownerExited(owner: string): boolean {
  try {
    const parsed = JSON.parse(owner);
    if (parsed?.version !== 1 || parsed.host !== hostname() || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return false;
    try { process.kill(parsed.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch { return false; }
}

export function acquireSyncLock(db: DatabaseSync): string {
  const owner = JSON.stringify({ version: 1, host: hostname(), pid: process.pid, token: randomUUID() });
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT owner,expires_at FROM sync_lock WHERE id=1').get() as {owner:string;expires_at:number} | undefined;
    const now = Number(db.prepare('SELECT unixepoch() AS now').get()!.now);
    if (previous && previous.expires_at > now && !ownerExited(previous.owner)) {
      throw new Error('已有同步任务正在运行；如果刚中止程序，请在约 ' + (previous.expires_at - now) + ' 秒后重试。');
    }
    db.prepare('INSERT INTO sync_lock VALUES (1,?,unixepoch()+90) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(owner);
    db.exec('COMMIT');
    return owner;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
