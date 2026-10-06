import { FetchError } from './base.ts';
import type { HttpClient } from './http.ts';
import { identifier, optionsOf, statusOf, submission, timestamp, unique } from './common.ts';
import type { FetchBatch, FetchOptions, Submission } from '../domain.ts';

const HOST = 'https://leetcode.cn';
// Only metadata is requested: no submission-detail or source-code endpoint.
const PROGRESS = `query($filters: UserProgressQuestionListInput) {
  userProgressQuestionList(filters: $filters) {
    totalNum questions { titleSlug title translatedTitle }
  }
}`;
const SUBMISSIONS = `query($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String!) {
  submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
    hasNext lastKey submissions { id statusDisplay lang timestamp }
  }
}`;
interface Question { slug: string; title: string }
interface Cursor {
  version: 1;
  handle: string;
  // Discover both sets before traversing each question's submissions.
  phase: 0 | 1 | 2;
  skip: number;
  questions: Question[];
  index: number;
  offset: number;
  lastKey: string | null;
  previousIds: string[];
}
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
function decode(raw: string | null | undefined, handle: string): Cursor {
  if (!raw) return { version: 1, handle, phase: 0, skip: 0, questions: [], index: 0, offset: 0, lastKey: null, previousIds: [] };
  try {
    const c = JSON.parse(raw);
    if (c.version !== 1 || c.handle !== handle || ![0, 1, 2].includes(c.phase) ||
        !integer(c.skip) || !integer(c.index) || !integer(c.offset) ||
        !(c.lastKey === null || typeof c.lastKey === 'string') ||
        !Array.isArray(c.previousIds) || !c.previousIds.every((id: unknown) => typeof id === 'string') ||
        !Array.isArray(c.questions) || c.index > c.questions.length ||
        !c.questions.every((q: Question) => q && typeof q.slug === 'string' && /^[\w-]+$/.test(q.slug) && typeof q.title === 'string' && q.title.trim())) throw Error();
    return c;
  } catch { throw new FetchError('力扣历史游标无效，请使用 --backfill --force 重新回补', false, 'INVALID_CURSOR'); }
}

export async function fetchChinaHistory(http: HttpClient, handle: string, cookie: string | undefined, options: FetchOptions): Promise<FetchBatch> {
  const opts = optionsOf(options);
  if (!cookie) throw new FetchError('力扣历史回补需要本人登录 Cookie：ALGO_COOKIE_LEETCODE_CN', false, 'AUTH_REQUIRED');
  const cursor = decode(opts.cursor, handle);
  const csrf = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('csrftoken='))?.slice('csrftoken='.length);
  async function query(document: string, variables: object = {}) {
    opts.signal?.throwIfAborted();
    const response = await http.json(`${HOST}/graphql/`, {
      method: 'POST', signal: opts.signal,
      headers: { 'Content-Type': 'application/json', Referer: HOST, Origin: HOST, Cookie: cookie!, ...(csrf ? { 'x-csrftoken': csrf } : {}) },
      body: JSON.stringify({ query: document, variables }),
    });
    if (response?.errors?.length) throw new FetchError('力扣历史接口拒绝请求，请检查登录状态或接口是否变化', false, 'GRAPHQL_ERROR');
    if (!response?.data) throw new FetchError('力扣历史接口返回格式异常', false, 'SCHEMA_CHANGED');
    return response.data;
  }
  // Authenticated APIs always return the cookie owner's history, never handle's.
  const { userStatus } = await query('query { userStatus { isSignedIn userSlug } }');
  if (userStatus?.isSignedIn !== true) throw new FetchError('力扣登录已失效，请更新 Cookie', false, 'AUTH_REQUIRED');
  if (userStatus.userSlug !== handle) throw new FetchError('力扣 Cookie 所属账号与绑定的主页 slug 不一致；无法回补其他人的历史', false, 'ACCOUNT_MISMATCH');

  const rows: Submission[] = [];
  const limit = Math.min(opts.limit, 20);
  for (let page = 0; page < opts.maxPages; page++) {
    if (cursor.phase < 2) {
      const { userProgressQuestionList: list } = await query(PROGRESS, { filters: {
        skip: cursor.skip, limit, questionStatus: cursor.phase === 0 ? 'SOLVED' : 'ATTEMPTED',
      } });
      if (!list || !integer(list.totalNum) || !Array.isArray(list.questions) || (list.questions.length === 0 && cursor.skip < list.totalNum))
        throw new FetchError('力扣题目进度分页异常，未标记历史完成', false, 'SCHEMA_CHANGED');
      const knownCount = cursor.questions.length;
      for (const q of list.questions) {
        const slug = identifier(q.titleSlug, 'problem slug');
        const title = identifier(q.translatedTitle || q.title, 'problem title');
        if (!/^[\w-]+$/.test(slug)) throw new FetchError('Invalid problem slug', false, 'SCHEMA_CHANGED');
        if (!cursor.questions.some(item => item.slug === slug)) cursor.questions.push({ slug, title });
      }
      if (cursor.skip > 0 && list.questions.length && cursor.questions.length === knownCount)
        throw new FetchError('力扣题目分页未前进，保留原游标以便重试', false, 'PAGINATION_STALLED');
      cursor.skip += list.questions.length;
      if (cursor.skip >= list.totalNum) { cursor.phase++; cursor.skip = 0; }
      continue;
    }
    if (cursor.index >= cursor.questions.length) break;
    const question = cursor.questions[cursor.index];
    const { submissionList: list } = await query(SUBMISSIONS, {
      offset: cursor.offset, limit, lastKey: cursor.lastKey, questionSlug: question.slug,
    });
    if (!list || !Array.isArray(list.submissions) || typeof list.hasNext !== 'boolean' ||
        !(list.lastKey == null || typeof list.lastKey === 'string') ||
        (!list.submissions.length && (list.hasNext || cursor.offset === 0)))
      throw new FetchError('力扣提交分页异常，未标记历史完成', false, 'SCHEMA_CHANGED');
    const ids = list.submissions.map((s: any) => identifier(s.id, 'submission id'));
    if (ids.length && ids.every((id: string) => cursor.previousIds.includes(id)))
      throw new FetchError('力扣提交分页未前进，保留原游标以便重试', false, 'PAGINATION_STALLED');
    for (const s of list.submissions) rows.push(submission('leetcode-cn', {
      submission_id: identifier(s.id, 'submission id'), problem_id: question.slug, problem_title: question.title,
      problem_url: `${HOST}/problems/${encodeURIComponent(question.slug)}/`,
      status: statusOf(s.statusDisplay), raw_status: s.statusDisplay ?? null,
      language: s.lang ?? null, submitted_at: timestamp(s.timestamp),
    }));
    if (list.hasNext) {
      cursor.offset += list.submissions.length;
      cursor.lastKey = list.lastKey || null;
      cursor.previousIds = ids;
    } else {
      cursor.index++; cursor.offset = 0; cursor.lastKey = null; cursor.previousIds = [];
    }
  }
  const complete = cursor.phase === 2 && cursor.index === cursor.questions.length;
  return {
    submissions: unique(rows).filter(s => opts.since === undefined || s.submitted_at >= opts.since).sort((a, b) => b.submitted_at - a.submitted_at),
    source: HOST, scope: 'history', acceptedOnly: false, complete: complete && opts.since === undefined,
    nextCursor: complete ? null : JSON.stringify(cursor),
    note: (complete ? '已遍历本次登录态可见历史' : cursor.phase < 2 ? '正在收集已解决及尝试过的题目，可继续回补' : `历史回补进度：${cursor.index}/${cursor.questions.length} 题，可继续回补`) +
      '；包含失败提交，不获取源码。同步期间新增或状态变化的题目可再次强制回补核对。' + (opts.since !== undefined ? '本次按时间过滤，不代表完整历史。' : ''),
  };
}
