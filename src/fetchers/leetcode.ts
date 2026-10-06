import { BaseFetcher, FetchError, type ProbeResult } from './base.ts';
import { HttpClient } from './http.ts';
import { optionsOf, identifier, timestamp, statusOf, submission } from './common.ts';
import type { Submission, FetchOptions, FetchBatch } from '../domain.ts';
import { fetchChinaHistory } from './leetcode-history.ts';

export class LeetCodeFetcher extends BaseFetcher {
  platform: string;
  http: HttpClient;
  cookie?: string;
  constructor(http: HttpClient, china = false, cookie?: string) { super(); this.http=http; this.platform=china?'leetcode-cn':'leetcode'; this.cookie=cookie; }
  async fetch_recent_submissions(handle: string, limit = 100): Promise<Submission[]> {
    return (await this.fetch_batch(handle,{limit})).submissions;
  }
  /**
   * 绑定前探测：只查 `matchedUser`，不抓提交列表 —— 探测应该是最省的那一次请求。
   *
   * **中国站不探测**：它的公开接口 `recentACSubmissions` 在「用户不存在」与
   * 「用户开了隐私」时都回空列表，两者分不开。宁可报 unknown，也不把开了隐私的人
   * 误判成不存在。
   */
  async probe_handle(handle: string): Promise<ProbeResult> {
    if (this.platform === 'leetcode-cn') {
      return { status: 'unknown', reason: '中国站的公开接口分不清「用户不存在」与「用户设了隐私」，跳过探测' };
    }
    const query = 'query($username: String!) { matchedUser(username: $username) { username } }';
    try {
      const body = await this.http.json('https://leetcode.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com' },
        body: JSON.stringify({ query, variables: { username: handle } }),
      });
      if (body?.errors?.length || !body?.data?.matchedUser) return { status: 'missing', reason: 'LeetCode 上没有这个用户' };
      return { status: 'found', displayName: body.data.matchedUser?.username ?? null };
    } catch (error) {
      return { status: 'unknown', reason: error instanceof Error ? error.message : 'LeetCode 探测请求失败' };
    }
  }
  async fetch_batch(handle: string, options: FetchOptions = {}): Promise<FetchBatch> {
    const opts=optionsOf(options);
    if (!/^[\w-]{1,60}$/.test(handle)) throw new FetchError('Invalid LeetCode username/slug');
    if (opts.mode==='backfill') {
      if (this.platform==='leetcode-cn') return fetchChinaHistory(this.http,handle,this.cookie,options);
      throw new FetchError('LeetCode public feeds do not expose full history',false,'UNSUPPORTED');
    }
    const china=this.platform==='leetcode-cn';
    const host=china?'https://leetcode.cn':'https://leetcode.com';
    const query=china
      ? 'query($userSlug: String!) { recentACSubmissions(userSlug: $userSlug) { submissionId submitTime lang question { title titleSlug translatedTitle } } }'
      : 'query($username: String!, $limit: Int!) { matchedUser(username: $username) { username } recentSubmissionList(username: $username, limit: $limit) { id title titleSlug timestamp statusDisplay lang } }';
    const body=await this.http.json(host+(china?'/graphql/noj-go/':'/graphql'),{method:'POST',headers:{'Content-Type':'application/json',Referer:host},body:JSON.stringify({query,variables:china?{userSlug:handle}:{username:handle,limit:Math.min(opts.limit,20)}})});
    if (body.errors?.length) throw new FetchError('LeetCode GraphQL rejected the request; username or API schema may have changed',false,'GRAPHQL_ERROR');
    if (!china && !body.data?.matchedUser) throw new FetchError('LeetCode user not found',false,'NOT_FOUND');
    const raw=china?body.data?.recentACSubmissions:body.data?.recentSubmissionList;
    if (!Array.isArray(raw)) throw new FetchError('Invalid LeetCode submission list',false,'SCHEMA_CHANGED');
    const rows=raw.slice(0,Math.min(opts.limit,20)).map(s=>{
      const slug=identifier(china?s.question?.titleSlug:s.titleSlug,'problem slug');
      return submission(this.platform,{
        submission_id:identifier(china?s.submissionId:s.id,'submission id'),problem_id:slug,
        problem_title:identifier(china?(s.question?.translatedTitle||s.question?.title):s.title,'problem title'),
        problem_url:`${host}/problems/${encodeURIComponent(slug)}/`,
        status:china?'AC':statusOf(s.statusDisplay),raw_status:china?'Accepted':s.statusDisplay??null,
        language:s.lang??null,submitted_at:timestamp(china?s.submitTime:s.timestamp),
      });
    });
    return {submissions:rows,source:host,scope:'recent',acceptedOnly:china,complete:false,nextCursor:null,
      note:china?'中国站公开近期 AC，最多保留 20 条；不包含失败尝试，空列表也可能是隐私设置或用户不存在。':'国际站公开近期提交，最多请求 20 条；不代表完整历史。'};
  }
}
