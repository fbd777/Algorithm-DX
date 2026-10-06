import { cfExtensionBridge } from './cf-extension.ts';
import { CodeforcesGroupWebFetcher } from './codeforces-group-web.ts';
import { CodeforcesGroupFetcher, parseGroupLinks, fetchGroupReleases } from './codeforces-group.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Account } from '../domain.ts';
import { Repository } from '../db/database.ts';
import { FetchError, BaseFetcher } from './base.ts';
import { HttpClient } from './http.ts';
import { CodeforcesSyncFetcher } from './codeforces-sync.ts';
import { LeetCodeFetcher } from './leetcode.ts';
import { AtCoderFetcher } from './atcoder.ts';
import { LuoguFetcher } from './luogu.ts';
import { MatijiLiveFetcher } from './matiji-live.ts';
import { NowcoderFetcher } from './nowcoder.ts';
import { MatijiFetcher } from './matiji.ts';

export const platforms=['codeforces','leetcode','leetcode-cn','atcoder','luogu','matiji','nowcoder'] as const;
/** 接受登录凭据的平台。力扣中国站仅历史回补需要凭据。 */
export const credentialPlatforms=['luogu','matiji','leetcode-cn'] as const;
export function validateAccount(platform:string,handle:string):void{
  if(!(platforms as readonly string[]).includes(platform))throw new Error(`Platform must be one of: ${platforms.join(', ')}`);
  const patterns:Record<string,RegExp>={nowcoder:/^[1-9]\d{0,19}$/,codeforces:/^[A-Za-z0-9_.-]{3,24}$/,leetcode:/^[\w-]{1,60}$/,'leetcode-cn':/^[\w-]{1,60}$/,atcoder:/^[A-Za-z0-9_]{1,32}$/,luogu:/^[1-9]\d*$/,matiji:/^[A-Za-z0-9_-]{1,80}$/};
  if(!patterns[platform].test(handle))throw new Error('Invalid platform handle; Luogu and Nowcoder require numeric user IDs');
}
/**
 * 登录凭据的变量名按「平台」生成，而不是按「被观测账号」。
 * 凭据代表的是**观测者身份**：一份洛谷登录 Cookie 就能查该平台任意公开账号的记录，
 * 所以新增被观测账号时不需要再配一份 Cookie。
 */
export function credentialKey(platform:string):string{
  return `ALGO_COOKIE_${platform.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}`;
}
/**
 * 取某个平台要用的凭据。
 * 优先 `ALGO_COOKIE_<平台>`（一份服务该平台全部账号）；找不到再回退到旧写法
 * `ALGO_COOKIE_<本地账号ID>`，让已经配好的 .env 继续可用。
 */
export function resolveCredential(env:NodeJS.ProcessEnv,account:Pick<Account,'id'|'platform'>):string|undefined{
  const perPlatform=env[credentialKey(account.platform)];
  if(typeof perPlatform==='string'&&perPlatform.trim())return perPlatform.trim();
  const perAccount=env[`ALGO_COOKIE_${account.id}`];
  return typeof perAccount==='string'&&perAccount.trim()?perAccount.trim():undefined;
}
/**
 * 平台前置条件：**抓取之前**必须先配好的东西。
 *
 * 缺它**不等于抓取失败** —— 是一次都没试过。两件事必须分开记，否则「还没配 Cookie」
 * 会以「抓取失败」的身份写进 `sync_runs` 与 `sync_state.last_error`，让面板一直挂着红字，
 * 而实际上一个请求都没发出。
 */
export interface PlatformPrerequisite{
  /** credential = 登录凭据；snapshot = 本地快照文件。 */
  kind:'credential'|'snapshot';
  /** 该填进 .env 的变量名。 */
  variable:string;
  /** 缺的是什么。不含平台显示名 —— 平台名由前端查表拼，避免第二份平台名映射。 */
  detail:string;
}
/**
 * 这个账号缺哪个前置条件；齐了返回 null。
 *
 * 与 `credentialPlatforms` 放在一起是刻意的：「哪些平台要凭据」只有这一处出处，
 * 面板上的「凭据已配」徽标读的是同一份清单，否则会出现「徽标说配了、同步说没配」。
 */
export function missingPrerequisite(env:NodeJS.ProcessEnv,account:Pick<Account,'id'|'platform'>,mode:'recent'|'backfill'='recent'):PlatformPrerequisite|null{
  if(account.platform==='leetcode-cn'&&mode==='recent')return null;
  if(account.platform==='matiji'&&String(env[`ALGO_MATIJI_SNAPSHOT_${account.id}`]??'').trim())return null;
  if((credentialPlatforms as readonly string[]).includes(account.platform)&&!resolveCredential(env,account)){
    return{kind:'credential',variable:credentialKey(account.platform),detail:'没有配置登录凭据，这次没有发起抓取'};
  }
  return null;
}
export function createFactory(db:DatabaseSync,env:NodeJS.ProcessEnv=process.env,http=new HttpClient(db)){
  return(account:Account):BaseFetcher=>{
    const cookie=resolveCredential(env,account);
    switch(account.platform){
      case 'codeforces': {
        const groups=parseGroupLinks(env['ALGO_CF_GROUPS_'+account.id]??'');
        if(groups.length && env['ALGO_CF_GROUP_MODE_'+account.id]!=='api'){
          const fetcher=new CodeforcesGroupWebFetcher(new Repository(db),http,groups,env['ALGO_CF_GROUP_MODE_'+account.id]==='browser'?undefined:cfExtensionBridge.read.bind(cfExtensionBridge));
          if(env.ALGO_CF_API_KEY&&env.ALGO_CF_API_SECRET)fetcher.metadata=signal=>fetchGroupReleases(http,groups,env.ALGO_CF_API_KEY!,env.ALGO_CF_API_SECRET!,signal);
          return fetcher;
        }
        return groups.length ? new CodeforcesGroupFetcher(new Repository(db),http,groups,env.ALGO_CF_API_KEY??'',env.ALGO_CF_API_SECRET??'') : new CodeforcesSyncFetcher(new Repository(db),http);
      }
      case 'leetcode':return new LeetCodeFetcher(http);
      case 'leetcode-cn':return new LeetCodeFetcher(http,true,cookie);
      case 'nowcoder':return new NowcoderFetcher(http);
      case 'atcoder':return new AtCoderFetcher(http);
      case 'luogu':return new LuoguFetcher(http,cookie);
      // 显式的旧快照配置保持原行为；网页导入不设置此配置。
      case 'matiji':return env[`ALGO_MATIJI_SNAPSHOT_${account.id}`] ? new MatijiFetcher(env[`ALGO_MATIJI_SNAPSHOT_${account.id}`]) : new MatijiLiveFetcher(http,cookie);
      default:throw new FetchError('Unsupported platform',false,'UNSUPPORTED');
    }
  };
}

/** Current adapter coverage, independent of whether an account has synced. */
export function historyCapability(platform: string): { supported: boolean; detail: string } {
  if (['codeforces', 'luogu', 'atcoder', 'nowcoder'].includes(platform)) return { supported: true, detail: '支持历史回补' };
  if (platform === 'matiji') return { supported: true, detail: '配置登录 Cookie 后可分页回补网站可见历史；已实测登录账号识别和近期记录获取' };
  if (platform === 'leetcode-cn') return { supported: true, detail: '本人登录 Cookie 可分页回补可见历史（含失败提交，不含源码）；其他账号仍仅支持公开近期 AC' };
  if (platform === 'leetcode') return { supported: false, detail: '公开接口仅提供近期最多 20 条提交，无法回补完整历史' };
  return { supported: false, detail: '当前适配器仅支持近期同步，暂不支持历史回补' };
}
