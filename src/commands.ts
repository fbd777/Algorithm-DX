import { openDatabase, Repository, SCHEMA_VERSION } from './db/database.ts';
// 题目数量口径（洛谷比赛内编号不计入）只有一处定义，见 src/problem-scope.ts。
import { CONTEST_SCOPED_PROBLEM, PRACTICE_PROBLEM } from './problem-scope.ts';
// 账号/用户的写操作只有一处实现：面板走同一份，见 src/account-admin.ts。
import { bindAccount, createUser, removeUser, renameAccount, replaceAccount, setFollowed, unbindAccount } from './account-admin.ts';
import { createFactory, platforms, credentialPlatforms } from './fetchers/registry.ts';
import { CodeforcesSyncFetcher } from './fetchers/codeforces-sync.ts';
import { HttpClient } from './fetchers/http.ts';
import { SyncService } from './sync/service.ts';
import { watchSync } from './sync/scheduler.ts';

export const help=`Algorithm DX · Phase 2
  init
  user add <name> [--self] | user list | user remove <id> --yes | user follow <id> [--off]
  account add <userId> <platform> <handle> [--cookie "<login cookie>"] [--no-probe] | account list
    | account rename <id> <new-handle> --same-identity
    | account replace <id> <new-handle> --yes | account remove <id> --yes
  fetch <codeforces-handle> [limit]
  sync [accountId] [--limit 100] [--pages 10] [--since <UTC-seconds>] [--backfill] [--force]
  watch [--interval 300] [--limit 100] [--pages 10]
  status | runs [accountId]
Platforms: ${platforms.join(', ')}
Luogu and Nowcoder use a numeric user ID; Luogu's public nickname is resolved automatically on add.
Luogu fetching needs your own login Cookie in .env (ALGO_COOKIE_LUOGU).
  Pass it to account add with --cookie to write that line for you, or edit .env yourself.
  Re-running account add --cookie on a bound account only rewrites the credential.
  One Cookie covers every account on that platform, so friends you watch need no extra credential.
Deleting a user/account also deletes its submissions and sync history.
account add probes the platform first and refuses handles that do not exist (--no-probe skips; unreachable != absent).
account rename --same-identity keeps history only for the same platform identity.
account replace --yes archives the old account and starts a fresh account for the same local user.
user follow/unfollow is a display flag only -- unfollowing hides a user from the main view, it deletes nothing.
--force bypasses recent cache / restarts history. Ctrl+C stops watch after the current sync.
Matiji: local snapshot import only; see docs/platforms.md.`;
/** cli.ts 也按相对路径加载 .env，两处必须一致。 */
const ENV_FILE='.env';
function id(value:string|undefined):number{
  const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new Error('Expected a positive integer ID');return n;
}
function flags(args:string[],allowed:Record<string,'value'|'boolean'>){
  const values:Record<string,string|boolean>={},positional:string[]=[];
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(!arg.startsWith('--')){positional.push(arg);continue;}
    if(!allowed[arg]||values[arg]!==undefined)throw new Error(`Unknown or repeated option: ${arg}`);
    if(allowed[arg]==='boolean')values[arg]=true;
    else{if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value: ${arg}`);values[arg]=args[++i];}
  }
  return{values,positional};
}
function print(value:unknown){console.log(JSON.stringify(value,null,2));}

export async function runCommand(args:string[]):Promise<void>{
  const command=args.shift();
  if(!command||command==='help'||command==='--help'){console.log(help);return;}
  const db=openDatabase(process.env.ALGO_DB_PATH);
  try{
    const repo=new Repository(db);
    if(command==='init'){if(args.length)throw new Error('init takes no arguments');console.log(`SQLite schema v${SCHEMA_VERSION} initialized.`);}
    else if(command==='user'||command==='account'){
      const action=args.shift();
      const {values,positional:p}=flags(args,{'--self':'boolean','--yes':'boolean','--cookie':'value',
        '--same-identity':'boolean','--off':'boolean','--no-probe':'boolean'});
      const table=command==='user'?'users':'accounts';
      // 关注是一个独立标记：取消关注不删人、不删数据，只是不出在主视图里。
      if(action==='follow'&&command==='user'){
        if(p.length!==1||values['--yes']||values['--self']||values['--cookie']!==undefined)throw new Error('Usage: user follow <userId> [--off]');
        print(setFollowed(db,id(p[0]),!values['--off']));
      }else if(action==='rename'&&command==='account'){
        if(p.length!==2||Object.keys(values).some(k=>k!=='--same-identity'))throw new Error('Usage: account rename <accountId> <new-handle>');
        print(renameAccount(db,id(p[0]),p[1],values['--same-identity']===true));
      }else if(action==='replace'&&command==='account'){
        if(p.length!==2||values['--yes']!==true||Object.keys(values).some(k=>k!=='--yes'))throw new Error('Usage: account replace <accountId> <new-handle> --yes');
        print(replaceAccount(db,id(p[0]),p[1]));
      }else if(action==='list'){
        if(p.length||Object.keys(values).length)throw new Error('list takes no arguments');
        print(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
      }else if(action==='add'&&command==='user'){
        if(p.length!==1||values['--yes']||values['--cookie']!==undefined)throw new Error('Usage: user add <name> [--self]');
        print({id:createUser(db,p[0],Boolean(values['--self']))});
      }else if(action==='add'&&command==='account'){
        const cookie=values['--cookie'];
        if(p.length!==3||Object.keys(values).some(k=>k!=='--cookie'&&k!=='--no-probe'))throw new Error('Usage: account add <userId> <platform> <handle> [--cookie "<platform login cookie>"] [--no-probe]');
        // 带 --cookie 时允许账号已存在：重复执行只是更新凭据，方便给已绑定的账号补配凭据。
        // 没带 --cookie 时保持严格 —— 脚本里重复绑同一个 handle 多半是写错了 user id。
        print(await bindAccount(db,{userId:id(p[0]),platform:p[1],handle:p[2],
          cookie:cookie===undefined?null:String(cookie),envFile:ENV_FILE,reuseExisting:cookie!==undefined,
          // 探测依赖外网；脚本里重放绑定时用 --no-probe 跳过。
          probe:!values['--no-probe']}));
      }else if(action==='remove'){
        if(p.length!==1||!values['--yes']||values['--self'])throw new Error('Deletion includes all associated submissions. Supply <id> --yes.');
        print(command==='user'?removeUser(db,id(p[0])):unbindAccount(db,id(p[0])));
      }else throw new Error(help);
    }else if(command==='fetch'){
      if(args.length<1||args.length>2)throw new Error('Usage: fetch <handle> [limit]');
      print(await new CodeforcesSyncFetcher(repo,new HttpClient(db)).fetch_recent_submissions(args[0],args[1]?Number(args[1]):100));
    }else if(command==='sync'||command==='watch'){
      const {values:v,positional:p}=flags(args,{'--limit':'value','--pages':'value','--since':'value','--backfill':'boolean','--force':'boolean','--interval':'value'});
      if(p.length>(command==='sync'?1:0))throw new Error('Unexpected positional argument');
      if(command==='sync'&&v['--interval'])throw new Error('--interval is only for watch');
      if(command==='watch'&&(v['--backfill']||v['--force']||v['--since']))throw new Error('watch runs recent sync only; run history backfill separately');
      const options={limit:Number(v['--limit']??100),maxPages:Number(v['--pages']??10),mode:v['--backfill']?'backfill' as const:'recent' as const,
        force:Boolean(v['--force']),since:v['--since']===undefined?undefined:Number(v['--since'])};
      const service=new SyncService(db,createFactory(db));
      const execute=async()=>{const results=await service.sync(p[0]?id(p[0]):undefined,options);print(results);return results;};
      if(command==='sync'){if((await execute()).some(r=>r.status==='failed'))process.exitCode=1;}
      else{
        const controller=new AbortController(),stop=()=>controller.abort();
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
        try{await watchSync(async()=>{try{await execute();}catch(e){console.error(e instanceof Error?e.message:'Sync failed');}},Number(v['--interval']??300),controller.signal);}
        finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
      }
    }else if(command==='status'){
      if(args.length)throw new Error('status takes no arguments');
      print(db.prepare(`SELECT a.id,a.platform,a.handle,u.name,ss.last_attempt_at,ss.last_success_at,ss.last_error,
        ss.history_cursor,ss.history_complete,ss.coverage_json,
        (SELECT count(*) FROM submissions WHERE account_id=a.id) AS stored_submissions,
        (SELECT count(DISTINCT problem_id) FROM submissions WHERE account_id=a.id AND status='AC' AND ${PRACTICE_PROBLEM}) AS stored_solved,
        (SELECT count(DISTINCT problem_id) FROM submissions WHERE account_id=a.id AND ${CONTEST_SCOPED_PROBLEM}) AS stored_contest_problems
        FROM accounts a JOIN users u ON u.id=a.user_id LEFT JOIN sync_state ss ON ss.account_id=a.id ORDER BY a.id`).all());
    }else if(command==='runs'){
      if(args.length>1)throw new Error('Usage: runs [accountId]');
      print(args[0]?db.prepare('SELECT * FROM sync_runs WHERE account_id=? ORDER BY id DESC LIMIT 20').all(id(args[0])):db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all());
    }else throw new Error(help);
  }finally{db.close();}
}
