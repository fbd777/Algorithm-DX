import type { DatabaseSync } from 'node:sqlite';
import { Repository } from './db/database.ts';
import { normalizeMatiji } from './fetchers/matiji.ts';
import { acquireSyncLock } from './sync/lock.ts';

export function importMatiji(db: DatabaseSync, accountId: number, snapshot: unknown, commit = false) {
  const account = db.prepare("SELECT * FROM accounts WHERE id=? AND platform='matiji' AND is_archived=0").get(accountId);
  if (!account) throw new Error('请选择已绑定的码蹄集账号');
  if (Buffer.byteLength(JSON.stringify(snapshot) ?? '') > 10*1024*1024) throw new Error('文件超过 10 MB，请拆分后导入');
  const body = snapshot as any;
  if (!body || typeof body !== 'object' || Array.isArray(body) || String(body.account_handle ?? '') !== account.handle)
    throw new Error('文件中的 account_handle 与所选账号不一致，请核对账号');
  if (!Array.isArray(body.records) || body.records.length === 0 || body.records.length > 100000)
    throw new Error('文件需要包含 1～100000 条 records 记录');
  const rows = new Map<string, ReturnType<typeof normalizeMatiji>>();
  for (const [index, source] of body.records.entries()) {
    try {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error();
      if (!['string','number'].includes(typeof source.submitTime)) throw Error();
      for (const key of ['submissionId','problemId','problemTitle','problemName','judgeResultSlug','judgeResult','languageName']) {
        if (source[key] !== undefined && source[key] !== null && !['string','number'].includes(typeof source[key])) throw Error();
        if (String(source[key] ?? '').length > 1000) throw Error();
      }
      if (!String(source.judgeResultSlug ?? source.judgeResult ?? '').trim()) throw Error();
      const row = normalizeMatiji(source);
      if (row.submitted_at > Math.floor(Date.now()/1000) || row.submission_id.length > 200 || row.problem_id.length > 200) throw Error();
      const previous = rows.get(row.submission_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw Error();
      rows.set(row.submission_id,row);
    } catch { throw new Error('第 ' + (index+1) + ' 条记录格式错误或提交编号冲突，请检查后重新导入'); }
  }
  const normalized = [...rows.values()];
  const report = { total:body.records.length, unique:normalized.length, duplicates:body.records.length-normalized.length,
    accepted:normalized.filter(r=>r.status==='AC').length, unknown:normalized.filter(r=>r.status==='OTHER').length,
    sample:normalized.slice(0,5).map(r=>({problem:r.problem_title,status:r.status})), inserted:0, existing:0, imported:false };
  const inspect = () => {
    const find = db.prepare('SELECT problem_id,submitted_at FROM submissions WHERE account_id=? AND submission_id=?');
    report.existing=0;
    for (const row of normalized) {
      const old = find.get(accountId,row.submission_id);
      if (old && (old.problem_id !== row.problem_id || old.submitted_at !== row.submitted_at)) throw new Error('提交编号与已有记录冲突，未导入任何记录');
      if (old) report.existing++;
    }
  };
  if (!commit) { inspect(); return report; }
  const owner=acquireSyncLock(db);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current=db.prepare("SELECT handle FROM accounts WHERE id=? AND platform='matiji' AND is_archived=0").get(accountId);
      if (!current || current.handle !== account.handle) throw new Error('账号已更改，请重新选择账号');
      inspect();
      new Repository(db).saveSubmissions(accountId,normalized);
      report.inserted=normalized.length-report.existing;
      const note='网页文件导入，共 '+normalized.length+' 条记录';
      const coverage=JSON.stringify({source:'web Matiji import',scope:'recent',acceptedOnly:false,complete:false,note});
      db.prepare('INSERT INTO sync_state(account_id,last_attempt_at,last_success_at,coverage_json) VALUES(?,unixepoch(),unixepoch(),?) ON CONFLICT(account_id) DO UPDATE SET last_attempt_at=unixepoch(),last_success_at=unixepoch(),last_error=NULL,coverage_json=excluded.coverage_json').run(accountId,coverage);
      db.prepare("INSERT INTO sync_runs(account_id,status,mode,finished_at,fetched,inserted,message,coverage_json) VALUES(?,'success','import',unixepoch(),?,?,?,?)").run(accountId,normalized.length,report.inserted,note,coverage);
      db.exec('COMMIT'); report.imported=true;
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.prepare('DELETE FROM sync_lock WHERE id=1 AND owner=?').run(owner); }
  return report;
}
