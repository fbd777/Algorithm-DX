import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, Repository, SCHEMA_VERSION } from '../src/db/database.ts';
import { HttpClient } from '../src/fetchers/http.ts';
import { BaseFetcher, FetchError } from '../src/fetchers/base.ts';
import { CodeforcesSyncFetcher } from '../src/fetchers/codeforces-sync.ts';
import { LeetCodeFetcher } from '../src/fetchers/leetcode.ts';
import { AtCoderFetcher } from '../src/fetchers/atcoder.ts';
import { LuoguFetcher, parseLuogu, parseLuoguProfile, normalizeLuogu } from '../src/fetchers/luogu.ts';
import { MatijiFetcher } from '../src/fetchers/matiji.ts';
import { createFactory, credentialKey, resolveCredential } from '../src/fetchers/registry.ts';
import { assertSafeEnvValue, redactSecrets, upsertEnvVar } from '../src/credentials.ts';
import { submission } from '../src/fetchers/common.ts';
import { SyncService } from '../src/sync/service.ts';
import { watchSync } from '../src/sync/scheduler.ts';
import type { FetchBatch, FetchOptions, Submission } from '../src/domain.ts';

const row=submission('codeforces',{submission_id:'1',problem_id:'4:A',problem_title:'Watermelon',status:'AC',submitted_at:1700000000});
const batch:FetchBatch={submissions:[row],source:'fixture',scope:'recent',acceptedOnly:false,complete:false,nextCursor:null,note:'Fixture recent records'};
const fast=async()=>{};

test('legacy schema versions migrate forward to the current version without data loss',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-migration-')),path=join(dir,'test.sqlite');
  const old=new DatabaseSync(path);
  old.exec(readFileSync(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
  // 用裸 SQL 模拟 v1 时代的写入，**连建用户/建账号也是**。不能用当前的 Repository ——
  // 它认识后加的列（v4 的 score、v7 的 is_followed …），写进 v1 库会直接报
  // "no column named …"，那样测的就不是迁移而是「新代码写旧库」了。
  old.prepare('INSERT INTO users(name,is_self) VALUES (?,1)').run('Me');
  const user=Number(old.prepare('SELECT id FROM users WHERE name=?').get('Me')!.id);
  old.prepare('INSERT INTO accounts(user_id,platform,handle,handle_key) VALUES (?,?,?,?)').run(user,'codeforces','tourist','tourist');
  const account=Number(old.prepare('SELECT id FROM accounts WHERE handle=?').get('tourist')!.id);
  old.prepare(`INSERT INTO submissions
    (account_id,platform,submission_id,problem_id,problem_title,problem_url,difficulty,tags_json,status,raw_status,language,execution_time,memory,submitted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      account,row.platform,row.submission_id,row.problem_id,row.problem_title,row.problem_url,row.difficulty,
      JSON.stringify(row.tags),row.status,row.raw_status,row.language,row.execution_time,row.memory,row.submitted_at);
  old.close();
  try{
    for(let i=0;i<2;i++){
      const db=openDatabase(path);
      try{
        assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,SCHEMA_VERSION);
        assert.equal(db.prepare('SELECT count(*) n FROM submissions').get()!.n,1);
        // v3 新增的显示名列必须存在且对旧数据保持为 NULL，不能凭空填值。
        assert.equal(db.prepare('SELECT display_name FROM accounts WHERE id=?').get(account)!.display_name,null);
        // v4 新增的 score 列同理：旧数据没有分数，只能是 NULL。
        // 用 0 冒充「零分」会把「平台不提供分数」误读成「考了 0 分」。
        assert.equal(db.prepare('SELECT score FROM submissions').get()!.score,null);
      }
      finally{db.close();}
    }
  }finally{rmSync(dir,{recursive:true});}
});

test('HTTP retries 429/503, rejects auth and HTML, reserves DB rate slots, honors Retry-After',async()=>{
  const db=openDatabase(':memory:');
  try{
    let calls=0;const waits:number[]=[];
    const http=new HttpClient(db,async()=>{
      calls++;return calls===1?new Response('',{status:429,headers:{'Retry-After':'3'}}):Response.json({ok:true});
    },async(ms)=>{waits.push(ms);});
    assert.deepEqual(await http.json('https://example.test/feed'),{ok:true});assert.equal(calls,2);assert.ok(waits.includes(3000));
    assert.ok(Number(db.prepare('SELECT next_at FROM request_slots').get()!.next_at)>Date.now());
    await assert.rejects(new HttpClient(db,async()=>new Response('',{status:401}),fast).json('https://example.test'),(e:FetchError)=>e.code==='AUTH_REQUIRED');
    await assert.rejects(new HttpClient(db,async()=>new Response('<html>login</html>'),fast).json('https://example.test'),(e:FetchError)=>e.code==='SCHEMA_CHANGED');
  }finally{db.close();}
});

test('LeetCode global and China use separate endpoints, statuses and coverage',async()=>{
  const db=openDatabase(':memory:');
  try{
    const http=new HttpClient(db,async(url,init)=>{
      const q=JSON.parse(String(init?.body));
      if(String(url).includes('noj-go')){
        assert.equal(q.variables.userSlug,'tester');
        return Response.json({data:{recentACSubmissions:[{submissionId:9,submitTime:1700000000,lang:'Java',question:{title:'Two Sum',translatedTitle:'两数之和',titleSlug:'two-sum'}}]}});
      }
      assert.equal(q.variables.limit,20);
      return Response.json({data:{matchedUser:{username:'tester'},recentSubmissionList:[{id:'8',timestamp:'1700000000',title:'Two Sum',titleSlug:'two-sum',statusDisplay:'Wrong Answer',lang:'cpp'}]}});
    },fast);
    const global=await new LeetCodeFetcher(http).fetch_batch('tester');
    assert.equal(global.submissions[0].status,'WA');assert.equal(global.acceptedOnly,false);assert.equal(global.complete,false);
    const cn=await new LeetCodeFetcher(http,true).fetch_batch('tester');
    assert.equal(cn.submissions[0].problem_title,'两数之和');assert.equal(cn.acceptedOnly,true);
    await assert.rejects(new LeetCodeFetcher(http).fetch_batch('tester',{mode:'backfill'}),/full history/);
    const bad=new HttpClient(db,async()=>Response.json({errors:[{message:'bad query'}]}),fast);
    await assert.rejects(new LeetCodeFetcher(bad).fetch_batch('tester'),(e:FetchError)=>e.code==='GRAPHQL_ERROR');
  }finally{db.close();}
});

test('Codeforces history has a resumable overlapping cursor and normalizes records',async()=>{
  const db=openDatabase(':memory:');
  try{
    const http=new HttpClient(db,async(url)=>{
      const from=Number(new URL(String(url)).searchParams.get('from'));
      assert.equal(new URL(String(url)).searchParams.get('count'),'1000');
      const raw=from===1?Array.from({length:1000},(_,i)=>({id:1000-i,creationTimeSeconds:1700000000-i,problem:{contestId:4,index:'A',name:'Watermelon'},verdict:'OK'})):[];
      return Response.json({status:'OK',result:raw});
    },fast);
    const adapter=new CodeforcesSyncFetcher(new Repository(db),http);
    const first=await adapter.fetch_batch('tourist',{mode:'backfill',maxPages:1});
    assert.equal(first.nextCursor,'1000');assert.equal(first.complete,false);assert.equal(first.submissions.length,1000);
    const next=await adapter.fetch_batch('tourist',{mode:'backfill',cursor:first.nextCursor,maxPages:1});
    assert.equal(next.complete,true);assert.equal(next.nextCursor,null);
  }finally{db.close();}
});

test('AtCoder overlaps timestamp boundary and protects against stalled pages',async()=>{
  const db=openDatabase(':memory:');
  try{
    const raw=(id:number,time:number)=>({id,epoch_second:time,problem_id:'abc001_1',contest_id:'abc001',result:'AC',language:'C++',execution_time:2});
    let calls=0;const seen:number[]=[];
    const adapter=new AtCoderFetcher(new HttpClient(db,async(url)=>{
      const from=Number(new URL(String(url)).searchParams.get('from_second'));seen.push(from);calls++;
      return Response.json(calls===1?Array.from({length:500},(_,i)=>raw(i,i===499?20:10)):[raw(499,20),raw(500,20)]);
    },fast));
    const result=await adapter.fetch_batch('tester',{mode:'backfill',maxPages:2});
    assert.deepEqual(seen,[0,20]);assert.equal(result.submissions.length,501);assert.equal(result.complete,true);
    const stuck=new AtCoderFetcher(new HttpClient(db,async()=>Response.json(Array.from({length:500},(_,i)=>raw(i,10))),fast));
    await assert.rejects(stuck.fetch_batch('tester',{mode:'backfill',cursor:'10'}),(e:FetchError)=>e.code==='PAGINATION_STALLED');
  }finally{db.close();}
});

test('Luogu parses current HTML and legacy JSON, verifies user and maps resource units',async()=>{
  const db=openDatabase(':memory:');
  try{
    // 字段名照抄 2026-09-17 实测的真实载荷：problem 用 name，没有 title。
    const raw={id:1,user:{uid:123},problem:{pid:'P1001',name:'A+B',type:'P',difficulty:1,fullScore:100},status:12,submitTime:1700000000,time:10,memory:64,language:3};
    const records={count:1,result:[raw]};
    assert.equal(parseLuogu(JSON.stringify({currentData:{records}})).count,1);
    const html=`<script id="lentille-context" type="application/json">${JSON.stringify({status:200,data:{records}})}</script>`;
    const f=new LuoguFetcher(new HttpClient(db,async()=>new Response(html),fast),'fixture-cookie');
    assert.equal((await f.fetch_batch('123')).submissions[0].memory,64*1024);
    assert.equal(normalizeLuogu({...raw,status:14}).status,'OTHER');
    // 这条断言存在的唯一目的：防止再次把字段名猜错。真实载荷是 problem.name，
    // 只有 title 的载荷必须直接报错，而不是悄悄写进一个空标题（2026-09-17 就是这里挂的）。
    assert.throws(()=>normalizeLuogu({...raw,problem:{pid:'P1001',title:'A+B',difficulty:1}}),/problem name/);
    await assert.rejects(f.fetch_batch('456'),(e:FetchError)=>e.code==='ACCOUNT_MISMATCH');
    await assert.rejects(new LuoguFetcher(new HttpClient(db)).fetch_batch('123'),(e:FetchError)=>e.code==='AUTH_REQUIRED');
    assert.throws(()=>parseLuogu('<html>challenge</html>'));
  }finally{db.close();}
});

test('Luogu challenge cookie is replayed and the public nickname resolves from lentille-context',async()=>{
  const db=openDatabase(':memory:');
  try{
    const profileHtml=`<script id="lentille-context" type="application/json">${JSON.stringify({currentData:{user:{uid:1000001,name:'tester',slogan:'示例签名',registerTime:1761317027}}})}</script>`;
    const cookieOf=(init?:RequestInit)=>init?.headers instanceof Headers?(init.headers.get('cookie')??''):'';
    let calls=0;const seen:string[]=[];
    const http=new HttpClient(db,async(url,init)=>{
      calls++;seen.push(cookieOf(init));
      // 洛谷对非浏览器客户端先回 302 并只在 Set-Cookie 里下发挑战值。
      if(calls===1)return new Response('',{status:302,headers:{location:String(url),'set-cookie':'C3VK=abc; Path=/'}});
      return new Response(profileHtml,{status:200});
    },fast);
    const profile=await new LuoguFetcher(http).fetch_profile('1000001');
    assert.equal(calls,2);assert.equal(profile.uid,'1000001');assert.equal(profile.name,'tester');
    assert.equal(profile.registerTime,1761317027);assert.equal(profile.slogan,'示例签名');
    assert.equal(seen[0],'');assert.ok(seen[1].includes('C3VK=abc'),'challenge cookie must be replayed');
    // 挑战值按域名缓存：后续请求直接带值，不再多走一轮重定向。
    await new LuoguFetcher(http).fetch_profile('1000001');
    assert.equal(calls,3);assert.ok(seen[2].includes('C3VK=abc'));
    await assert.rejects(new LuoguFetcher(http).fetch_profile('999'),(e:FetchError)=>e.code==='ACCOUNT_MISMATCH');
    // 永远只重定向、却不给挑战值的站点必须明确失败，而不是无限重试。
    const stubborn=new HttpClient(db,async()=>new Response('',{status:302}),fast);
    await assert.rejects(new LuoguFetcher(stubborn).fetch_profile('1'),(e:FetchError)=>e.code==='CHALLENGE_FAILED');
    assert.throws(()=>parseLuoguProfile('<html>challenge</html>'));
    // 记录列表同时带登录 Cookie 与挑战值时，两者必须共存——覆盖掉登录态会让抓取全部失败。
    const recordsHtml=`<script id="lentille-context" type="application/json">${JSON.stringify({data:{records:{count:1,perPage:20,result:[{id:1,user:{uid:1000001},problem:{pid:'P1001',name:'A+B',type:'P',difficulty:1,fullScore:100},status:12,submitTime:1700000000,time:10,memory:64,language:3}]}}})}</script>`;
    let combined='';
    const both=new HttpClient(db,async(_url,init)=>{
      const cookie=cookieOf(init);
      if(!cookie.includes('C3VK'))return new Response('',{status:302,headers:{'set-cookie':'C3VK=xyz'}});
      combined=cookie;return new Response(recordsHtml,{status:200});
    },fast);
    const batch=await new LuoguFetcher(both,'__client_id=login-value').fetch_batch('1000001');
    assert.equal(batch.submissions.length,1);
    assert.ok(combined.includes('__client_id=login-value')&&combined.includes('C3VK=xyz'));
    // 401 出现在「已经带上 Cookie」之后，说明凭据本身有问题。
    // 光报域名 + 状态码看不出该改哪里，所以报错必须点到确切的变量名。
    const stale=new HttpClient(db,async(_url,init)=>{
      const cookie=cookieOf(init);
      if(!cookie.includes('C3VK'))return new Response('',{status:302,headers:{'set-cookie':'C3VK=zzz'}});
      return new Response('',{status:401});
    },fast);
    await assert.rejects(new LuoguFetcher(stale,'__client_id=stale-value').fetch_batch('1000001'),
      (e:FetchError)=>e.code==='AUTH_REQUIRED'&&/ALGO_COOKIE_LUOGU/.test(e.message));
  }finally{db.close();}
});


test('Matiji snapshot import deduplicates, rejects owner mismatch and exposes manual coverage',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-matiji-')),path=join(dir,'records.json');
  try{
    const r={submissionId:1,problemId:'MT1001',judgeResultSlug:'Accepted',submitTime:1700000000000,languageName:'C++'};
    writeFileSync(path,JSON.stringify({account_handle:'123',records:[r,r]}));
    const f=new MatijiFetcher(path),result=await f.fetch_batch('123');
    assert.equal(result.submissions.length,1);assert.equal(result.submissions[0].submitted_at,1700000000);assert.match(result.note,/非自动/);
    await assert.rejects(f.fetch_batch('other'),(e:FetchError)=>e.code==='ACCOUNT_MISMATCH');
    await assert.rejects(new MatijiFetcher().fetch_batch('123'),(e:FetchError)=>e.code==='SETUP_REQUIRED');
  }finally{rmSync(dir,{recursive:true});}
});

class FakeFetcher extends BaseFetcher{
  readonly platform='codeforces';getBatch:(o:FetchOptions)=>Promise<FetchBatch>;
  constructor(getBatch:(o:FetchOptions)=>Promise<FetchBatch>){super();this.getBatch=getBatch;}
  async fetch_recent_submissions():Promise<Submission[]>{return(await this.getBatch({})).submissions;}
  override fetch_batch(_handle:string,o:FetchOptions={}):Promise<FetchBatch>{return this.getBatch(o);}
}

test('sync is idempotent, isolates failures, caches, supports force and atomically rolls back bad batches',async()=>{
  const db=openDatabase(':memory:');
  try{
    const repo=new Repository(db),user=repo.createUser('Me'),a=repo.addAccount(user,'codeforces','tourist'),b=repo.addAccount(user,'luogu','123');
    let calls=0,bad=false;
    // 显式给洛谷备一份凭据环境：否则 b 会在前置条件那一步被跳过（skipped），
    // 这个用例要验的是「真的抓了但挂了」的失败隔离，两件事不能混。
    const service=new SyncService(db,account=>new FakeFetcher(async()=>{
      calls++;if(account.id===b)throw new FetchError('login required',false,'AUTH_REQUIRED');
      return bad?{...batch,submissions:[{...row,submission_id:'2'},{...row,submission_id:'3',platform:'wrong'}]}:batch;
    }),{ALGO_COOKIE_LUOGU:'__client_id=test'});
    const first=await service.sync();assert.deepEqual(first.map(r=>r.status),['success','failed']);assert.equal(first[0].inserted,1);
    const second=await service.sync(a);assert.equal(second[0].inserted,0);assert.equal(calls,2);
    bad=true;const third=await service.sync(a,{force:true});assert.equal(third[0].status,'failed');
    assert.equal(db.prepare('SELECT count(*) n FROM submissions').get()!.n,1);
    assert.ok(db.prepare('SELECT last_success_at FROM sync_state WHERE account_id=?').get(a)!.last_success_at);
    assert.equal(db.prepare('SELECT count(*) n FROM sync_lock').get()!.n,0);
  }finally{db.close();}
});

test('unrated problems get their difficulty backfilled from the platform problemset on sync',async()=>{
  const db=openDatabase(':memory:');
  try{
    const repo=new Repository(db),user=repo.createUser('Me');
    const cf=repo.addAccount(user,'codeforces','tourist');
    // 模拟「比赛刚打完、CF 还没公布评级」的那次抓取：difficulty 是 NULL。
    // recent 模式只刷近期提交，这题一旦滑出窗口就永远补不上 —— 所以得靠 problemset 回填。
    const unrated=submission('codeforces',{submission_id:'9',problem_id:'2263:A',problem_title:'Fresh',status:'AC',submitted_at:1760000000});
    let ratingCalls=0;
    class RatedFetcher extends FakeFetcher{
      override async fetch_problem_ratings(){ratingCalls++;return[{contestId:2263,index:'A',rating:800}];}
    }
    const service=new SyncService(db,()=>new RatedFetcher(async()=>({...batch,submissions:[unrated]})),{});
    const first=await service.sync(cf);
    assert.equal(first[0].status,'success');
    assert.match(first[0].message,/题目评级补齐 1 条/);
    assert.equal(db.prepare('SELECT difficulty FROM submissions WHERE problem_id=?').get('2263:A')!.difficulty,800);
    // 回填之后不再有 NULL：下一次同步不该再去碰 problemset。
    const second=await service.sync(cf);
    assert.equal(second[0].status,'success');
    assert.equal(ratingCalls,1,'no NULL difficulty left, no extra problemset fetch');
  }finally{db.close();}
});

test('missing prerequisites are skipped, not failed: nothing is fetched and no run is recorded',async()=>{
  const db=openDatabase(':memory:');
  try{
    const repo=new Repository(db),user=repo.createUser('Me');
    const cf=repo.addAccount(user,'codeforces','tourist');
    const lq=repo.addAccount(user,'luogu','123');
    const mj=repo.addAccount(user,'matiji','snapshot-user');
    let calls=0;
    // 空环境：洛谷缺 Cookie、码蹄集缺本地快照，只有 codeforces 该被真的抓一次。
    const service=new SyncService(db,()=>new FakeFetcher(async()=>{calls++;return batch;}),{});
    const results=await service.sync();
    assert.deepEqual(results.map(r=>r.status),['success','skipped','skipped']);
    // 关键：跳过的账号连适配器都没碰到 —— 「跳过」必须是「一个请求都没发出」。
    assert.equal(calls,1, 'skipped accounts must not reach the fetcher');
    const byId=new Map(results.map(r=>[r.accountId,r]));
    assert.equal(byId.get(lq)!.prerequisite!.kind,'credential');
    assert.equal(byId.get(lq)!.prerequisite!.variable,'ALGO_COOKIE_LUOGU');
    assert.equal(byId.get(mj)!.prerequisite!.kind,'credential');
    assert.equal(byId.get(mj)!.prerequisite!.variable,'ALGO_COOKIE_MATIJI');
    assert.ok(!byId.get(cf)!.prerequisite,'a fetched account has no prerequisite gap');
    // 跳过不写 sync_runs、不写 sync_state：「抓取尝试」这三个字是这些字段的全部含义。
    assert.deepEqual(db.prepare('SELECT account_id FROM sync_runs ORDER BY id').all().map(r=>r.account_id),[cf]);
    assert.equal(db.prepare('SELECT count(*) n FROM sync_state WHERE account_id IN (?,?)').get(lq,mj)!.n,0);
    // 配好前置条件之后应当照常抓取，而不是被永久跳过。
    // FakeFetcher 固定报 codeforces，而 saveSubmissions 会拒绝平台对不上的提交，
    // 所以这里按账号换一份提交行 —— 否则测的是「平台校验」而不是「跳过可恢复」。
    const fixed=new SyncService(db,(account)=>new FakeFetcher(async()=>({...batch,submissions:[{...row,platform:account.platform}]})),
      {ALGO_COOKIE_LUOGU:'__client_id=x',[`ALGO_MATIJI_SNAPSHOT_${mj}`]:'/tmp/snapshot.json'});
    const fixedResults=await fixed.sync();
    assert.deepEqual(fixedResults.map(r=>r.status),['success','success','success'],'prerequisites are not permanent: once configured, the account is fetched');
    assert.ok(!fixedResults.some(r=>r.prerequisite),'no prerequisite gap remains after configuring');
    assert.deepEqual([...new Set(db.prepare("SELECT account_id FROM sync_runs WHERE status='success'").all().map(r=>Number(r.account_id)))].sort((x,y)=>x-y),
      [Number(cf),Number(lq),Number(mj)],'every account ends up with a recorded successful fetch');
  }finally{db.close();}
});

test('history cursor and records commit together; sync rejects concurrent callers and recovers stale locks',async()=>{
  const db=openDatabase(':memory:');
  try{
    const repo=new Repository(db),user=repo.createUser('Me'),a=repo.addAccount(user,'codeforces','tourist');
    const seen:Array<string|null|undefined>=[];
    const s=new SyncService(db,()=>new FakeFetcher(async o=>{seen.push(o.cursor);return{...batch,scope:'history',nextCursor:'100'};}));
    await s.sync(a,{mode:'backfill'});await s.sync(a,{mode:'backfill'});assert.deepEqual(seen,[null,'100']);
    let release!:()=>void;
    const slow=new SyncService(db,()=>new FakeFetcher(async()=>{await new Promise<void>(r=>release=r);return batch;}));
    const running=slow.sync(a,{force:true});
    await assert.rejects(s.sync(a),/已有同步任务正在运行/);release();await running;
    db.prepare("INSERT INTO sync_lock VALUES (1,'crashed',0)").run();
    db.prepare("INSERT INTO sync_runs(account_id,status,mode) VALUES (?,'running','recent')").run(a);
    await s.sync(a);
    assert.equal(db.prepare("SELECT count(*) n FROM sync_runs WHERE status='interrupted'").get()!.n,1);
  }finally{db.close();}
});

test('scheduler runs sequentially and stops after abort without another cycle',async()=>{
  const c=new AbortController();let active=0,max=0,count=0;
  await watchSync(async()=>{active++;max=Math.max(max,active);await Promise.resolve();active--;if(++count===3)c.abort();},60,c.signal,fast);
  assert.equal(count,3);assert.equal(max,1);
  await assert.rejects(watchSync(async()=>{},0,new AbortController().signal),/interval/);
});

test('CLI binds account, imports records, exposes status and refuses accidental deletion',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-cli-')),path=join(dir,'db.sqlite'),snapshot=join(dir,'matiji.json');
  const entry=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const env={...process.env,ALGO_DB_PATH:path,ALGO_MATIJI_SNAPSHOT_1:snapshot};
  const run=(...args:string[])=>execFileSync(process.execPath,[entry,...args],{cwd:dir,env,encoding:'utf8'});
  try{
    writeFileSync(snapshot,JSON.stringify({account_handle:'123',records:[{submissionId:1,problemId:'MT1001',judgeResultSlug:'Accepted',submitTime:1700000000}]}));
    assert.equal(JSON.parse(run('user','add','我','--self')).id,1);
    assert.equal(JSON.parse(run('account','add','1','matiji','123')).id,1);
    assert.equal(JSON.parse(run('sync'))[0].inserted,1);
    const status=JSON.parse(run('status'))[0];assert.equal(status.stored_submissions,1);assert.equal(status.stored_solved,1);
    assert.match(status.coverage_json,/local Matiji snapshot/);
    const refused=spawnSync(process.execPath,[entry,'account','remove','1'],{cwd:dir,env,encoding:'utf8'});assert.equal(refused.status,1);
    assert.equal(JSON.parse(run('account','list')).length,1);
    run('account','remove','1','--yes');assert.equal(JSON.parse(run('status')).length,0);
  }finally{rmSync(dir,{recursive:true});}
});

test('CLI 改标识保住历史、关注只是显示开关：两条命令都不删数据',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-cli-')),path=join(dir,'db.sqlite'),snapshot=join(dir,'matiji.json');
  const entry=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const env={...process.env,ALGO_DB_PATH:path,ALGO_MATIJI_SNAPSHOT_1:snapshot};
  const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[entry,...args],{cwd:dir,env,encoding:'utf8'}));
  const fail=(...args:string[])=>spawnSync(process.execPath,[entry,...args],{cwd:dir,env,encoding:'utf8'});
  try{
    writeFileSync(snapshot,JSON.stringify({account_handle:'123',records:[{submissionId:1,problemId:'MT1001',judgeResultSlug:'Accepted',submitTime:1700000000}]}));
    run('user','add','我','--self');
    assert.equal(run('account','add','1','matiji','123').id,1);
    run('sync');
    // 改标识：只换 handle，账号 id 与提交都不动 —— 回执里的 submissions 就是证据。
    const renamed=run('account','rename','1','456','--same-identity');
    assert.deepEqual([renamed.from,renamed.to,renamed.submissions],['123','456',1]);
    assert.equal(JSON.parse(execFileSync(process.execPath,[entry,'status'],{cwd:dir,env,encoding:'utf8'}))[0].stored_submissions,1);
    // 改成和现在一样 / 改成别人占用的，都要被挡住。
    assert.equal(fail('account','rename','1','456').status,1);
    // 关注：取消关注只改标记，不删人也不删数据。
    assert.equal(run('user','add','路人').id,2);
    assert.equal(run('user','follow','2','--off').is_followed,false);
    assert.equal(run('user','list').find((u:{id:number})=>u.id===2).is_followed,0);
    assert.equal(run('user','follow','2').is_followed,true);
    // 本人不能取消关注：他是主视图与 DX 榜的锚点。
    assert.equal(fail('user','follow','1','--off').status,1);
    assert.equal(JSON.parse(execFileSync(process.execPath,[entry,'status'],{cwd:dir,env,encoding:'utf8'})).length,1);
    assert.equal(fail('account','replace','1','789').status,1);
    const replaced=run('account','replace','1','789','--yes');
    assert.equal(replaced.archivedId,1);
    assert.notEqual(replaced.id,1);
    const accounts=run('account','list');
    assert.equal(accounts.find((a:{id:number})=>a.id===1).is_archived,1);
    assert.equal(accounts.find((a:{id:number})=>a.id===replaced.id).is_archived,0);
  }finally{rmSync(dir,{recursive:true});}
});

test('one platform credential serves every account on that platform, and legacy per-account names still work',()=>{
  const db=openDatabase(':memory:');
  try{
    assert.equal(credentialKey('luogu'),'ALGO_COOKIE_LUOGU');
    assert.equal(credentialKey('matiji'),'ALGO_COOKIE_MATIJI');
    // 平台名带连字符时不能直接当变量名，必须规整成下划线。
    assert.equal(credentialKey('leetcode-cn'),'ALGO_COOKIE_LEETCODE_CN');
    const env={ALGO_COOKIE_LUOGU:'  __client_id=abc; _uid=1000001  ',ALGO_COOKIE_7:'legacy-cookie'};
    const self={id:2,user_id:1,platform:'luogu',handle:'1000001'};
    const friend={id:9,user_id:1,platform:'luogu',handle:'1'};
    // 前后空白要清掉，否则拼进请求头会变成畸形 Cookie。
    assert.equal(resolveCredential(env,self),'__client_id=abc; _uid=1000001');
    // 关键：同一份 Cookie 也要服务「被观察的他人」，不能要求每人配一份。
    assert.equal(resolveCredential(env,friend),'__client_id=abc; _uid=1000001');
    // 旧写法（按账号 ID）继续可用，但优先级低于按平台写法。
    assert.equal(resolveCredential(env,{...friend,id:7}),'__client_id=abc; _uid=1000001');
    assert.equal(resolveCredential({ALGO_COOKIE_7:'legacy-cookie'},{...friend,id:7}),'legacy-cookie');
    assert.equal(resolveCredential({ALGO_COOKIE_LUOGU:'   ',ALGO_COOKIE_7:'legacy-cookie'},{...friend,id:7}),'legacy-cookie');
    assert.equal(resolveCredential({},friend),undefined);
    // 工厂真的要把它交给适配器，而不是只算出来不用。
    const factory=createFactory(db,env,new HttpClient(db,async()=>new Response(''),fast));
    assert.equal((factory(friend) as LuoguFetcher).cookie,'__client_id=abc; _uid=1000001');
    assert.ok(factory({id:1,user_id:1,platform:'codeforces',handle:'tester'}) instanceof CodeforcesSyncFetcher);
  }finally{db.close();}
});

test('loadEnvFile strips the surrounding quotes our .env template documents',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-env-')),path=join(dir,'.env');
  try{
    writeFileSync(path,'# 注释行\nALGO_COOKIE_LUOGU="__client_id=abc123; _uid=1000001"\n');
    process.loadEnvFile(path);
    // .env 模板教用户给值加双引号，这里确认引号不会混进 Cookie 值里。
    assert.equal(process.env.ALGO_COOKIE_LUOGU,'__client_id=abc123; _uid=1000001');
  }finally{delete process.env.ALGO_COOKIE_LUOGU;rmSync(dir,{recursive:true,force:true});}
});

test('a credential value cannot smuggle new variables or quotes into .env',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-envwrite-')),file=join(dir,'.env');
  try{
    // 换行最危险：它能凭空造出一个新变量，把「填 Cookie」变成「改写程序配置」。
    assert.throws(()=>assertSafeEnvValue('ALGO_COOKIE_LUOGU','abc\nALGO_DB_PATH=/tmp/evil'),/line breaks/);
    assert.throws(()=>assertSafeEnvValue('ALGO_COOKIE_LUOGU','abc"def'),/line breaks/);
    assert.throws(()=>assertSafeEnvValue('ALGO_COOKIE_LUOGU','   '),/empty/);
    assert.equal(assertSafeEnvValue('ALGO_COOKIE_LUOGU','  __client_id=abc; _uid=1  '),'__client_id=abc; _uid=1');

    writeFileSync(file,'# 注释\nALGO_DB_PATH=data/x.sqlite\n# ALGO_COOKIE_LUOGU="模板"\n\n');
    // 命中注释模板行时替换它，而不是留下一份过期说明再另加一行。
    assert.equal(upsertEnvVar(file,'ALGO_COOKIE_LUOGU','__client_id=abc'),'uncommented');
    let text=readFileSync(file,'utf8');
    assert.ok(text.includes('ALGO_COOKIE_LUOGU="__client_id=abc"')&&!text.includes('模板'));
    // 其余行与注释必须原样保留。
    assert.ok(text.includes('# 注释')&&text.includes('ALGO_DB_PATH=data/x.sqlite'));
    // 已有活动行时是就地更新，不会追加第二行。
    assert.equal(upsertEnvVar(file,'ALGO_COOKIE_LUOGU','__client_id=def'),'updated');
    text=readFileSync(file,'utf8');
    assert.equal(text.match(/^ALGO_COOKIE_LUOGU=/gm)!.length,1);
    assert.ok(text.includes('__client_id=def')&&!text.includes('__client_id=abc'));
    // 全新变量追加到末尾，且结尾只留一个换行。
    assert.equal(upsertEnvVar(file,'ALGO_COOKIE_MATIJI','x=1'),'appended');
    assert.ok(readFileSync(file,'utf8').endsWith('ALGO_COOKIE_MATIJI="x=1"\n'));
    // 文件不存在时直接创建。
    const fresh=join(dir,'fresh.env');
    assert.equal(upsertEnvVar(fresh,'ALGO_COOKIE_LUOGU','v=1'),'appended');
    assert.equal(readFileSync(fresh,'utf8'),'ALGO_COOKIE_LUOGU="v=1"\n');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('sync failures are redacted before they are persisted',async()=>{
  const db=openDatabase(':memory:');
  try{
    // 直接验脱敏规则本身。
    assert.equal(redactSecrets('__client_id=SECRETVALUE'),'__client_id=[redacted]');
    assert.equal(redactSecrets('Authorization: Bearer TOKEN123'),'Authorization: [redacted]');
    assert.equal(redactSecrets('plain failure'),'plain failure');
    const repo=new Repository(db),user=repo.createUser('Me'),a=repo.addAccount(user,'luogu','123');
    const leak='Luogu failed: cookie: __client_id=SECRETVALUE; _uid=123, Authorization: Bearer TOKEN123';
    // 同上：洛谷要先过前置条件检查，才会走到「抓取失败并脱敏入库」这一步。
    await new SyncService(db,()=>new FakeFetcher(async()=>{throw new Error(leak);}),{ALGO_COOKIE_LUOGU:'__client_id=test'}).sync(a);
    const state=db.prepare('SELECT last_error FROM sync_state WHERE account_id=?').get(a)!;
    const run=db.prepare('SELECT message FROM sync_runs WHERE account_id=? ORDER BY id DESC LIMIT 1').get(a)!;
    // last_error 会出现在面板上，message 会随 npm run backup --csv 导出，两处都不能带凭据。
    for(const text of [String(state.last_error),String(run.message)]){
      assert.ok(!text.includes('SECRETVALUE')&&!text.includes('TOKEN123'),'credential must never be persisted');
      assert.match(text,/\[redacted\]/);
    }
  }finally{db.close();}
});

test('account add --cookie writes the credential into .env and never echoes it back',()=>{
  const dir=mkdtempSync(join(tmpdir(),'algo-cookie-')),path=join(dir,'db.sqlite');
  const entry=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const env={...process.env,ALGO_DB_PATH:path};
  const run=(...args:string[])=>execFileSync(process.execPath,[entry,...args],{cwd:dir,env,encoding:'utf8'});
  const fail=(...args:string[])=>spawnSync(process.execPath,[entry,...args],{cwd:dir,env,encoding:'utf8'});
  try{
    run('user','add','我','--self');
    // 该测试绑定不会解析昵称，所以这条用例不依赖网络。
    const out=JSON.parse(run('account','add','1','matiji','12345','--cookie','__client_id=abc123; _uid=12345'));
    assert.deepEqual(out.credential,{variable:'ALGO_COOKIE_MATIJI',file:'.env',action:'appended'});
    assert.ok(!JSON.stringify(out).includes('abc123'),'the credential itself must not be echoed');
    assert.ok(readFileSync(join(dir,'.env'),'utf8').includes('ALGO_COOKIE_MATIJI="__client_id=abc123; _uid=12345"'));
    // 同一平台再配一次凭据是就地更新：两个不同 handle 会各自建账号，但 .env 里只该有一行。
    const again=JSON.parse(run('account','add','1','matiji','67890','--cookie','__client_id=def456'));
    assert.equal(again.credential.action,'updated');
    assert.equal(readFileSync(join(dir,'.env'),'utf8').match(/^ALGO_COOKIE_MATIJI=/gm)!.length,1);
    assert.equal(JSON.parse(run('account','list')).length,2);
    // 对已绑定的账号再跑一次 --cookie：只更新凭据，不重复建账号、也不报约束冲突。
    const rebound=JSON.parse(run('account','add','1','matiji','12345','--cookie','__client_id=ghi789'));
    assert.equal(rebound.existing,true);assert.equal(rebound.id,out.id);assert.equal(rebound.credential.action,'updated');
    assert.equal(JSON.parse(run('account','list')).length,2);
    // 该 handle 已经属于别的用户时要明确拒绝，而不是悄悄接管。
    run('user','add','别人');
    const stolen=fail('account','add','2','matiji','12345','--cookie','x=1');
    assert.equal(stolen.status,1);assert.match(stolen.stderr,/another user/);
    // 不需要凭据的平台要明确拒绝，而不是把 Cookie 写进一个用不上的变量名。
    const wrong=fail('account','add','1','atcoder','test','--cookie','x');
    assert.equal(wrong.status,1);assert.match(wrong.stderr,/only applies to/);
    // 带引号的值会破坏 .env 的引号包裹，必须挡住，且不得留下半个账号。
    const before=JSON.parse(run('account','list')).length;
    const quoted=fail('account','add','1','matiji','999','--cookie','ab"cd');
    assert.equal(quoted.status,1);assert.match(quoted.stderr,/line breaks/);
    assert.equal(JSON.parse(run('account','list')).length,before);
    // user add 不认识这个选项，要报错而不是静默忽略。
    assert.equal(fail('user','add','X','--cookie','y').status,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
