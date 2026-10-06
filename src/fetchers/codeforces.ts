import { setTimeout as sleep } from 'node:timers/promises';
import { BaseFetcher, FetchError } from './base.ts';
import type { Cache, Submission, SubmissionStatus } from '../domain.ts';

// Shared across instances in this process. Multiple CLI processes are not coordinated.
let queue: Promise<unknown> = Promise.resolve();
let nextRequest = 0;
function paced<T>(action: () => Promise<T>): Promise<T> {
  const job = queue.then(async () => {
    await sleep(Math.max(0, nextRequest - Date.now()));
    nextRequest = Date.now() + 2100;
    return action();
  });
  queue = job.catch(() => {});
  return job;
}
const statuses: Record<string, SubmissionStatus> = {
  OK:'AC', WRONG_ANSWER:'WA', TIME_LIMIT_EXCEEDED:'TLE', MEMORY_LIMIT_EXCEEDED:'MLE',
  RUNTIME_ERROR:'RE', COMPILATION_ERROR:'CE', TESTING:'PENDING',
};
export function normalize(s: any): Submission {
  const p = s?.problem;
  if (!Number.isSafeInteger(s?.id) || !Number.isSafeInteger(s?.creationTimeSeconds) || !p || typeof p.index !== 'string' || typeof p.name !== 'string') {
    throw new FetchError('Invalid Codeforces submission payload');
  }
  const contest = p.contestId ?? s.contestId;
  const problemId = contest != null ? `${contest}:${p.index}` : `${p.problemsetName ?? 'unknown'}:${p.index}`;
  return {
    platform:'codeforces', submission_id:String(s.id), problem_id:problemId,
    problem_title:p.name,
    problem_url:contest != null ? `https://codeforces.com/${contest >= 100000 ? 'gym' : 'contest'}/${contest}/problem/${encodeURIComponent(p.index)}` : null,
    difficulty:p.rating ?? null, tags:p.tags ?? [],
    status:s.verdict == null ? 'PENDING' : (statuses[s.verdict] ?? 'OTHER'),
    raw_status:s.verdict ?? null, language:s.programmingLanguage ?? null,
    execution_time:s.timeConsumedMillis ?? null, memory:s.memoryConsumedBytes ?? null,
    submitted_at:s.creationTimeSeconds,
  };
}
export class CodeforcesFetcher extends BaseFetcher {
  readonly platform = 'codeforces';
  cache: Cache;
  request: typeof fetch;
  constructor(cache: Cache, request: typeof fetch = fetch) { super(); this.cache = cache; this.request = request; }
  async fetch_recent_submissions(user_handle: string, limit = 100): Promise<Submission[]> {
    const handle = user_handle.trim();
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(handle)) throw new FetchError('Invalid Codeforces handle');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new FetchError('limit must be 1..10000');
    const key = `cf:v1:${handle.toLowerCase()}:${limit}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const url = new URL('https://codeforces.com/api/user.status');
    url.search = new URLSearchParams({ handle, from:'1', count:String(limit) }).toString();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = await paced(async () => {
          const response = await this.request(url, { signal:AbortSignal.timeout(15000) });
          if (!response.ok) throw new FetchError(`Codeforces HTTP ${response.status}`, response.status === 429 || response.status >= 500);
          const body = await response.json();
          if (body.status !== 'OK') throw new FetchError(body.comment ?? 'Codeforces API failed', /limit exceeded/i.test(body.comment ?? ''));
          if (!Array.isArray(body.result)) throw new FetchError('Invalid Codeforces result');
          return body.result.map(normalize);
        });
        this.cache.set(key, rows, 60);
        return rows;
      } catch (error) {
        const transient = error instanceof FetchError ? error.retryable : error instanceof TypeError || (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name));
        if (!transient || attempt === 2) throw error;
        await sleep(2100 * 2 ** attempt);
      }
    }
    throw new FetchError('Retry exhausted');
  }
}
