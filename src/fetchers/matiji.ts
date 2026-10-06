import { readFileSync, statSync } from 'node:fs';
import { BaseFetcher, FetchError } from './base.ts';
import { optionsOf, identifier, timestamp, statusOf, submission, unique } from './common.ts';
import type { Submission, FetchOptions, FetchBatch } from '../domain.ts';

export function normalizeMatiji(s:any):Submission{
  return submission('matiji',{
    submission_id:identifier(s.submissionId,'submissionId'),problem_id:identifier(s.problemId,'problemId'),
    problem_title:String(s.problemTitle??s.problemName??s.problemId),problem_url:null,
    status:statusOf(s.judgeResultSlug??s.judgeResult),raw_status:s.judgeResultSlug??s.judgeResult??null,
    language:s.languageName??null,submitted_at:timestamp(s.submitTime),
  });
}
// Legacy local snapshot override; normal network sync uses MatijiLiveFetcher.
export class MatijiFetcher extends BaseFetcher{
  readonly platform='matiji';path:string|undefined;
  constructor(path?:string){super();this.path=path;}
  async fetch_recent_submissions(handle:string,limit=100):Promise<Submission[]>{return(await this.fetch_batch(handle,{limit})).submissions;}
  async fetch_batch(handle:string,options:FetchOptions={}):Promise<FetchBatch>{
    const opts=optionsOf(options);
    if(opts.mode==='backfill')throw new FetchError('Matiji currently supports local snapshot import only',false,'UNSUPPORTED');
    if(!this.path)throw new FetchError('Matiji live account feed is not verified. Configure ALGORITHM_DX_MATIJI_SNAPSHOT_<accountId>; see docs/platforms.md',false,'SETUP_REQUIRED');
    let body:any;
    try{
      if(statSync(this.path).size>10*1024*1024)throw new Error('too large');
      body=JSON.parse(readFileSync(this.path,'utf8'));
    }catch{throw new FetchError('Cannot read Matiji snapshot (valid JSON, at most 10 MB required)',false,'INVALID_SNAPSHOT');}
    if(String(body.account_handle)!==handle)throw new FetchError('Matiji snapshot account_handle does not match account',false,'ACCOUNT_MISMATCH');
    if(!Array.isArray(body.records))throw new FetchError('Matiji snapshot requires records array',false,'INVALID_SNAPSHOT');
    const rows=unique(body.records.map(normalizeMatiji)).sort((a,b)=>b.submitted_at-a.submitted_at);
    return{submissions:rows.slice(0,opts.limit),source:'local Matiji snapshot',scope:'recent',acceptedOnly:false,complete:false,nextCursor:null,
      note:'码蹄集本地导入，非自动网络抓取；仅包含文件中的记录。移除旧快照配置并设置登录后可使用网络同步。'};
  }
}
