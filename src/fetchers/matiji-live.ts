import { BaseFetcher, FetchError, hintCredential } from './base.ts';
import { HttpClient } from './http.ts';
import { identifier, optionsOf, statusOf, submission } from './common.ts';
import type { FetchBatch, FetchOptions, Submission } from '../domain.ts';

const ENDPOINT = 'https://www.matiji.net/exam-back/api/queryOtherUserBrushOjProblemLog.do';
const schema = () => new FetchError('码蹄集记录格式变化，未保存本轮数据', false, 'SCHEMA_CHANGED');
function epoch(value: unknown): number {
  let time: number;
  if (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) {
    time = Number(value); if (time > 1e12) time /= 1000;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    let date = value.replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(date)) date += '+08:00';
    time = Date.parse(date) / 1000;
  } else throw schema();
  if (!Number.isFinite(time) || time <= 0) throw schema();
  return Math.floor(time);
}
function localDate(seconds: number): string {
  return new Date(seconds * 1000 + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
export function normalizeMatijiLive(row: any, handle: string): Submission {
  if (!row || typeof row !== 'object') throw schema();
  if (row.userId != null && String(row.userId) !== handle) throw new FetchError('码蹄集返回了其他用户的记录', false, 'ACCOUNT_MISMATCH');
  const raw = row.judgeResultSlug ?? row.judgeResult;
  if (typeof raw !== 'string' || !raw) throw schema();
  const aliases: Record<string, string> = { 'Time Limit Exceed': 'TLE', 'Memory Limit Exceed': 'MLE', 'Compile Error': 'CE' };
  const resource = (v: unknown, multiplier = 1) => {
    if (v == null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw schema();
    return v * multiplier;
  };
  return submission('matiji', {
    // Never manufacture an ID from a timestamp: two submissions can share a second.
    submission_id: identifier(row.submissionId ?? row.id, 'submission id'),
    problem_id: identifier(row.problemId, 'problem id'),
    problem_title: identifier(row.ojProblemEntity?.problemName ?? row.problemName, 'problem name'),
    submitted_at: epoch(row.submitTime), status: statusOf(aliases[raw] ?? raw), raw_status: raw,
    language: row.ojLanguage?.languageName ?? row.languageName ?? null,
    execution_time: resource(row.usedTime), memory: resource(row.usedMemory, 1024),
  });
}

export class MatijiLiveFetcher extends BaseFetcher {
  readonly platform = 'matiji';
  http: HttpClient;
  cookie?: string;
  constructor(http: HttpClient, cookie?: string) { super(); this.http = http; this.cookie = cookie; }
  async currentAccount(): Promise<{ handle: string; displayName: string | null }> {
    if (!this.cookie) throw new FetchError('请先在下方填写码蹄集登录 Cookie，再识别我的账号', false, 'AUTH_REQUIRED');
    // Official getUserInfo action reads data.id from this read-only POST.
    const body = await this.http.json('https://www.matiji.net/exam-back/api/queryUserInfo.do', {
      method: 'POST', headers: { Cookie: this.cookie, Accept: 'application/json' },
    }).catch(error => hintCredential(error, 'ALGORITHM_DX_COOKIE_MATIJI', '码蹄集'));
    if (String(body?.error_no) === '2') throw new FetchError('码蹄集登录已失效，请更新 Cookie 后重试', false, 'AUTH_REQUIRED');
    if (String(body?.error_no) !== '0') throw new FetchError('码蹄集暂时无法识别登录账号，请稍后重试', false, 'API_ERROR');
    const id = body.data?.id;
    if ((typeof id !== 'string' && typeof id !== 'number') || !/^[1-9]\d*$/.test(String(id)) ||
        typeof id === 'number' && !Number.isSafeInteger(id)) throw schema();
    return { handle: String(id), displayName: typeof body.data.nickname === 'string' ? body.data.nickname.slice(0, 120) : null };
  }
  async fetch_recent_submissions(handle: string, limit = 100): Promise<Submission[]> { return (await this.fetch_batch(handle, { limit })).submissions; }
  async fetch_batch(handle: string, options: FetchOptions = {}): Promise<FetchBatch> {
    const opts = optionsOf(options), backfill = opts.mode === 'backfill';
    if (!/^[1-9]\d*$/.test(handle)) throw new FetchError('请在账号管理填写登录 Cookie 并点击「识别我的账号」获取数字 ID；旧文件账号仍可手动导入', false, 'HANDLE_INVALID');
    if (!this.cookie) throw new FetchError('请在账号管理填写一次码蹄集登录 Cookie', false, 'AUTH_REQUIRED');
    const now = Math.floor(Date.now() / 1000);
    let cursor = { version: 1, user: handle, start: 0, since: backfill ? 0 : opts.since ?? Math.max(0, now - 365 * 86400), until: now };
    if (backfill && opts.cursor) {
      try { cursor = JSON.parse(opts.cursor); } catch { throw schema(); }
      if (cursor?.version !== 1 || cursor.user !== handle || !Number.isSafeInteger(cursor.start) || cursor.start < 0 ||
          !Number.isSafeInteger(cursor.since) || cursor.since < 0 || !Number.isSafeInteger(cursor.until) || cursor.until < cursor.since || cursor.until > now) throw schema();
    }
    const rows: Submission[] = [], seen = new Set<string>();
    let complete = false;
    for (let page = 0; page < opts.maxPages; page++) {
      opts.signal?.throwIfAborted();
      const limit = backfill ? 50 : Math.min(50, opts.limit - rows.length);
      const params = new URLSearchParams({ userId: handle, start: String(cursor.start), limit: String(limit), startDate: localDate(cursor.since), endDate: localDate(cursor.until) });
      const body = await this.http.json(ENDPOINT, { method: 'POST', headers: { Cookie: this.cookie, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params.toString(), signal: opts.signal })
        .catch(error => hintCredential(error, 'ALGORITHM_DX_COOKIE_MATIJI', '码蹄集'));
      if (String(body?.error_no) === '2') throw new FetchError('码蹄集登录已失效，请在账号管理更新登录 Cookie', false, 'AUTH_REQUIRED');
      if (String(body?.error_no) !== '0') throw new FetchError('码蹄集拒绝了记录查询，请检查登录状态或稍后重试', false, 'API_ERROR');
      const data = body.data;
      if (!Array.isArray(data?.datas) || !Number.isSafeInteger(data.total) || data.total < 0 || data.datas.length > limit) throw schema();
      if (!data.datas.length && cursor.start < data.total) throw schema();
      for (const raw of data.datas) {
        const row = normalizeMatijiLive(raw, handle);
        if (seen.has(row.submission_id)) throw new FetchError('码蹄集分页重复，请重新同步；未保存本轮数据', false, 'PAGINATION_STALLED');
        seen.add(row.submission_id); rows.push(row);
      }
      cursor.start += data.datas.length;
      if (cursor.start >= data.total) { complete = true; break; }
      if (!backfill && rows.length >= opts.limit) break;
    }
    return { submissions: rows, source: ENDPOINT, scope: backfill ? 'history' : 'recent', acceptedOnly: false,
      complete: backfill && complete, nextCursor: backfill && !complete ? JSON.stringify(cursor) : null,
      note: '码蹄集网站当前可见的用户刷题记录；按日期和偏移分页，不包含网站未公开的记录。' };
  }
}
