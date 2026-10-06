import { FetchError } from './base.ts';
import type { Submission, SubmissionStatus, FetchOptions } from '../domain.ts';

export function optionsOf(options: FetchOptions = {}) {
  const result = {limit:100,maxPages:10,mode:'recent' as const,...options};
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 10000) throw new FetchError('limit must be 1..10000');
  if (!Number.isInteger(result.maxPages) || result.maxPages < 1 || result.maxPages > 100) throw new FetchError('maxPages must be 1..100');
  if (result.since !== undefined && (!Number.isSafeInteger(result.since) || result.since < 0)) throw new FetchError('since must be UTC epoch seconds >= 0');
  return result;
}
export function identifier(value: unknown, field: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) throw new FetchError(`Missing ${field}`,false,'SCHEMA_CHANGED');
  return String(value);
}
export function timestamp(value: unknown): number {
  const n = Number(value);
  if (value == null || value === '' || !Number.isSafeInteger(n) || n < 0) throw new FetchError('Invalid submission timestamp',false,'SCHEMA_CHANGED');
  return n > 1e12 ? Math.floor(n/1000) : n;
}
export function statusOf(value: unknown): SubmissionStatus {
  const map: Record<string,SubmissionStatus> = {AC:'AC',Accepted:'AC',WA:'WA','Wrong Answer':'WA',WrongAnswer:'WA',TLE:'TLE','Time Limit Exceeded':'TLE',TimeLimitExceeded:'TLE',MLE:'MLE','Memory Limit Exceeded':'MLE',MemoryLimitExceeded:'MLE',RE:'RE','Runtime Error':'RE',RuntimeError:'RE',CE:'CE','Compile Error':'CE','Compilation Error':'CE',CompileError:'CE',WJ:'PENDING',WR:'PENDING',PD:'PENDING',Pending:'PENDING',Judging:'PENDING',Waiting:'PENDING'};
  return value == null ? 'PENDING' : (map[String(value)] ?? 'OTHER');
}
export function submission(platform: string, fields: Partial<Submission>): Submission {
  return {platform,submission_id:'',problem_id:'',problem_title:'',problem_url:null,difficulty:null,tags:[],status:'OTHER',raw_status:null,language:null,execution_time:null,memory:null,score:null,submitted_at:0,...fields};
}
export function unique(rows: Submission[]): Submission[] {
  return [...new Map(rows.map(s=>[s.submission_id,s])).values()];
}
