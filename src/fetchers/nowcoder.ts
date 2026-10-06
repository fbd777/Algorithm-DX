import { BaseFetcher, FetchError, type ProbeResult } from './base.ts';
import { HttpClient } from './http.ts';
import { optionsOf, submission, unique } from './common.ts';
import type { Submission, SubmissionStatus, FetchOptions, FetchBatch } from '../domain.ts';

const origin = 'https://ac.nowcoder.com';
const invalid = () => new FetchError('牛客练习页无法识别，可能访问受限或页面格式已变化', false, 'SCHEMA_CHANGED');
function plain(value: string): string {
  const entities: Record<string,string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? all;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  }).trim();
}
const statuses: Record<string,SubmissionStatus> = { '答案正确':'AC','答案错误':'WA','运行超时':'TLE','内存超限':'MLE','运行错误':'RE','编译错误':'CE','正在评测':'PENDING','等待评测':'PENDING','排队中':'PENDING','格式错误':'WA' };
export function parseNowcoder(html: string): { rows: Submission[]; pages: number } {
  const table = html.match(/<table\b[^>]*>[\s\S]*?运行ID[\s\S]*?<\/table>/i)?.[0];
  if (!table || !table.includes('提交时间') || !table.includes('使用语言')) throw invalid();
  // The real empty page omits </tbody>, which HTML permits before </table>.
  const body = table.match(/<tbody\b[^>]*>([\s\S]*?)(?:<\/tbody>|<\/table>)/i)?.[1];
  if (body === undefined) throw invalid();
  const rows: Submission[] = [];
  for (const match of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length === 1 && /暂无|没有.*记录|没有找到你想要的内容/.test(plain(cells[0]))) continue;
    if (cells.length !== 9) throw invalid();
    const id = cells[0].match(/submissionId=(\d+)/)?.[1];
    const path = cells[1].match(/href=["'](\/acm\/problem\/\d+)["']/)?.[1];
    const date = plain(cells[8]);
    if (!id || !path || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) throw invalid();
    const time = Date.parse(date.replace(' ', 'T') + '+08:00') / 1000;
    if (!Number.isSafeInteger(time) || time < 0) throw invalid();
    const numeric = (cell: string) => { const v = plain(cell); return /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : null; };
    const raw = plain(cells[2]);
    rows.push(submission('nowcoder', { submission_id:id, problem_id:path.split('/').at(-1)!,
      problem_title:plain(cells[1]), problem_url:origin+path, status:statuses[raw] ?? 'OTHER', raw_status:raw,
      score:numeric(cells[3]), execution_time:numeric(cells[4]), memory:numeric(cells[5]),
      language:plain(cells[7]) || null, submitted_at:time }));
  }
  const pages = Number(html.match(/data-total=["'](\d+)["']/)?.[1] ?? 1);
  if (!Number.isSafeInteger(pages) || pages < 0) throw invalid();
  return { rows, pages:Math.max(1,pages) };
}
export class NowcoderFetcher extends BaseFetcher {
  readonly platform = 'nowcoder';
  http: HttpClient;
  constructor(http: HttpClient) { super(); this.http = http; }
  private url(handle: string, page = 1, ascending = false): URL {
    if (!/^[1-9]\d{0,19}$/.test(handle)) throw new FetchError('牛客账号请填写个人主页中的数字 ID');
    const url = new URL(origin + '/acm/contest/profile/' + handle + '/practice-coding');
    url.search = new URLSearchParams({page:String(page),pageSize:'10',orderType:ascending?'ASC':'DESC',statusTypeFilter:'-1',languageCategoryFilter:'-1'}).toString();
    return url;
  }
  async probe_handle(handle: string): Promise<ProbeResult> {
    try {
      const response = await this.http.peek(this.url(handle));
      if (response.status === 404) return {status:'missing',reason:'牛客上没有这个用户'};
      if (response.status !== 200) return {status:'unknown',reason:'暂时无法访问牛客个人练习页'};
      parseNowcoder(response.text);
      return {status:'found',displayName:null};
    } catch { return {status:'unknown',reason:'暂时无法确认牛客账号，请核对数字 ID'}; }
  }
  async fetch_recent_submissions(handle: string, limit = 100): Promise<Submission[]> {
    return (await this.fetch_batch(handle,{limit})).submissions;
  }
  async fetch_batch(handle: string, options: FetchOptions = {}): Promise<FetchBatch> {
    const opts = optionsOf(options), backfill = opts.mode === 'backfill';
    let page = backfill ? Number(opts.cursor ?? 1) : 1;
    if (!Number.isSafeInteger(page) || page < 1) throw new FetchError('Invalid Nowcoder cursor');
    const rows: Submission[] = [], seen = new Set<string>();
    let complete = false;
    for (let count = 0; count < opts.maxPages; count++) {
      const parsed = parseNowcoder(await this.http.text(this.url(handle,page,backfill)));
      if (page > parsed.pages) throw new FetchError('牛客记录页数发生变化，请重新回补历史',false,'PAGINATION_STALLED');
      const signature = parsed.rows.map(r=>r.submission_id).join(',');
      if (seen.has(signature) || (!parsed.rows.length && page < parsed.pages)) throw new FetchError('牛客分页未前进，请稍后重试',false,'PAGINATION_STALLED');
      seen.add(signature);
      rows.push(...parsed.rows);
      complete = page >= parsed.pages;
      page++;
      if (complete || (!backfill && (rows.length >= opts.limit || (opts.since !== undefined && parsed.rows.some(r=>r.submitted_at < opts.since))))) break;
    }
    const all = unique(rows).sort((a,b)=>b.submitted_at-a.submitted_at);
    return { submissions:backfill?all:all.filter(r=>opts.since===undefined || r.submitted_at>=opts.since).slice(0,opts.limit),
      source:origin+'/acm/contest/profile/'+handle+'/practice-coding',scope:backfill?'history':'recent',acceptedOnly:false,
      complete:complete && (backfill || (all.length<=opts.limit && opts.since===undefined)),nextCursor:backfill&&!complete?String(page):null,
      note:all.length ? '牛客竞赛站公开编程练习记录；不含选择题、非公开记录。题目难度暂不提供。' : '牛客公开编程练习页目前没有返回记录；不代表整个账号从未做题，比赛提交及其他题库可能不在此列表。' };
  }
}
