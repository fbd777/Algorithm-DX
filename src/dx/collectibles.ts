import type { DatabaseSync } from 'node:sqlite';
import type { ProblemRating } from '../domain.ts';
import { danProblemId } from './dan.ts';

export type CollectibleKind = 'achievement'|'title'|'avatar'|'avatar_frame'|'profile_background'|'info_frame'|'b50_theme';
export type CollectibleRarity = 'starter'|'white'|'bronze'|'silver'|'gold'|'rainbow';
export type AvatarSource = 'collectible'|'codeforces'|'atcoder'|'custom';

export interface Collectible {
  id: string;
  kind: CollectibleKind;
  name: string;
  rarity: CollectibleRarity;
  description: string;
  acquisition: string;
  unlockedAt?: number;
  source?: Record<string, unknown>|null;
  unlocked?: boolean;
  image?: string;
}

const STATIC: readonly Collectible[] = [
  { id:'title:newcomer',kind:'title',name:'初来乍到',rarity:'starter',description:'Algorithm DX 的第一枚称号。',acquisition:'创建玩家档案' },
  { id:'avatar:lxns-11',kind:'avatar',name:'舞萌地图头像',rarity:'starter',description:'LXNS 收藏品素材中的预设头像。',acquisition:'创建玩家档案',image:'/assets/collectibles/lxns/icon-11.png' },
  { id:'avatar_frame:newcomer',kind:'avatar_frame',name:'新手头像框',rarity:'starter',description:'清爽的蓝白入门头像框。',acquisition:'创建玩家档案' },
  { id:'profile_background:newcomer',kind:'profile_background',name:'新手背景板',rarity:'starter',description:'默认 DX 玩家信息背景。',acquisition:'创建玩家档案' },
  { id:'profile_background:lxns-frame-11',kind:'profile_background',name:'Re:MASTER 背景',rarity:'starter',description:'使用 LXNS frame 11 原图的玩家信息背景。',acquisition:'创建玩家档案',image:'/assets/collectibles/lxns/frame-11.png' },
  { id:'info_frame:newcomer',kind:'info_frame',name:'新手信息框',rarity:'starter',description:'默认玩家信息框。',acquisition:'创建玩家档案' },
  { id:'info_frame:lxns-plate-11',kind:'info_frame',name:'街景姓名框',rarity:'starter',description:'使用 LXNS plate 11 原图的姓名框。',acquisition:'创建玩家档案',image:'/assets/collectibles/lxns/plate-11.png' },
  { id:'b50_theme:newcomer',kind:'b50_theme',name:'Prism 新手舞台',rarity:'starter',description:'默认 B50 页面与导出背景。',acquisition:'创建玩家档案' },
  { id:'achievement:first-ac',kind:'achievement',name:'FIRST CLEAR',rarity:'white',description:'完成第一道题。',acquisition:'任一平台至少 AC 1 道题' },
  { id:'title:first-ac',kind:'title',name:'第一步',rarity:'white',description:'从一次 AC 开始的旅程。',acquisition:'获得「FIRST CLEAR」成就' },
  { id:'achievement:ten-ac',kind:'achievement',name:'热身完毕',rarity:'bronze',description:'累计完成 10 道不同题目。',acquisition:'累计 AC 10 道不同题目' },
  { id:'avatar_frame:bronze',kind:'avatar_frame',name:'铜色节拍',rarity:'bronze',description:'为稳定练习者准备的铜色头像框。',acquisition:'累计 AC 10 道不同题目' },
  { id:'achievement:fifty-ac',kind:'achievement',name:'题海巡游',rarity:'silver',description:'累计完成 50 道不同题目。',acquisition:'累计 AC 50 道不同题目' },
  { id:'profile_background:result-blue',kind:'profile_background',name:'Result Blue',rarity:'silver',description:'取材于仓库内结算画面的蓝色舞台。',acquisition:'累计 AC 50 道不同题目' },
  { id:'b50_theme:result-blue',kind:'b50_theme',name:'Result Blue',rarity:'silver',description:'带结算画面纹理的 B50 背景。',acquisition:'累计 AC 50 道不同题目' },
  { id:'achievement:dan-clear',kind:'achievement',name:'段位突破',rarity:'gold',description:'完成一次四题挑战。',acquisition:'任一四题挑战合格' },
  { id:'info_frame:dan-gold',kind:'info_frame',name:'段位金框',rarity:'gold',description:'带 SSS 结算徽记的金色信息框。',acquisition:'任一四题挑战合格' },
  { id:'b50_theme:sss',kind:'b50_theme',name:'SSS Celebration',rarity:'gold',description:'使用 SSS 结算贴图点缀的庆典主题。',acquisition:'任一四题挑战合格' },
];

const STARTER_IDS = STATIC.filter(item=>item.rarity==='starter').map(item=>item.id);
const byId = new Map(STATIC.map(item=>[item.id,item]));

function unlock(db:DatabaseSync,userId:number,item:Collectible,source?:Record<string,unknown>):void {
  db.prepare(`INSERT OR IGNORE INTO user_collectibles
    (user_id,collectible_id,kind,name,rarity,description,source_json) VALUES(?,?,?,?,?,?,?)`)
    .run(userId,item.id,item.kind,item.name,item.rarity,item.description,source?JSON.stringify(source):null);
}

function staticUnlocks(db:DatabaseSync,userId:number):void {
  for(const id of STARTER_IDS)unlock(db,userId,byId.get(id)!);
  const solved=Number(db.prepare(`SELECT COUNT(DISTINCT s.platform||char(31)||s.problem_id) n
    FROM submissions s JOIN accounts a ON a.id=s.account_id WHERE a.user_id=? AND s.status='AC'`).get(userId)!.n);
  if(solved>=1)for(const id of ['achievement:first-ac','title:first-ac'])unlock(db,userId,byId.get(id)!);
  if(solved>=10)for(const id of ['achievement:ten-ac','avatar_frame:bronze'])unlock(db,userId,byId.get(id)!);
  if(solved>=50)for(const id of ['achievement:fifty-ac','profile_background:result-blue','b50_theme:result-blue'])unlock(db,userId,byId.get(id)!);
  const dan=Boolean(db.prepare("SELECT 1 FROM dan_sessions WHERE user_id=? AND kind='challenge' AND status='cleared' LIMIT 1").get(userId));
  if(dan)for(const id of ['achievement:dan-clear','info_frame:dan-gold','b50_theme:sss'])unlock(db,userId,byId.get(id)!);
}

/** Award titles only when a complete CF history and a cached complete rated problem list make the claim auditable. */
function contestUnlocks(db:DatabaseSync,userId:number,pool:readonly ProblemRating[]):void {
  const complete=Boolean(db.prepare(`SELECT 1 FROM accounts a JOIN sync_state ss ON ss.account_id=a.id
    WHERE a.user_id=? AND a.platform='codeforces' AND ss.history_complete=1 LIMIT 1`).get(userId));
  if(!complete||!pool.length)return;
  const byContest=new Map<string,string[]>();
  for(const problem of pool){
    if(problem.problemId)continue;
    const id=danProblemId(problem),contest=String(problem.contestId);
    const rows=byContest.get(contest);if(rows)rows.push(id);else byContest.set(contest,[id]);
  }
  const submissions=db.prepare(`SELECT s.problem_id,s.status,s.submitted_at,s.submission_id
    FROM submissions s JOIN accounts a ON a.id=s.account_id
    WHERE a.user_id=? AND s.platform='codeforces' ORDER BY s.submitted_at,s.submission_id`).all(userId) as
    {problem_id:string;status:string;submitted_at:number;submission_id:string}[];
  const rowsByProblem=new Map<string,typeof submissions>();
  for(const row of submissions){const key=row.problem_id.toUpperCase();const rows=rowsByProblem.get(key);if(rows)rows.push(row);else rowsByProblem.set(key,[row]);}
  for(const [contest,problems] of byContest){
    if(problems.length<2||!problems.every(id=>rowsByProblem.get(id.toUpperCase())?.some(row=>row.status==='AC')))continue;
    const contestRow=db.prepare("SELECT name FROM contests WHERE platform='codeforces' AND contest_id=?").get(contest);
    const contestName=String(contestRow?.name??`Codeforces Round ${contest}`);
    unlock(db,userId,{id:`title:cf:${contest}:white`,kind:'title',name:contestName,rarity:'white',
      description:`完成 ${contestName} 全部评级题目。`,acquisition:'该场全部评级题目 AC'}, {contestId:contest,rule:'all-ac'});
    const clean=problems.every(id=>rowsByProblem.get(id.toUpperCase())?.[0]?.status==='AC');
    if(clean)unlock(db,userId,{id:`title:cf:${contest}:silver`,kind:'title',name:contestName,rarity:'silver',
      description:`Clean Solve ${contestName} 全部评级题目。`,acquisition:'该场每题第一次提交均为 AC'}, {contestId:contest,rule:'all-clean-solved'});
  }
}

function rowCollectible(row:Record<string,unknown>):Collectible {
  const known=byId.get(String(row.collectible_id));
  return { id:String(row.collectible_id),kind:String(row.kind) as CollectibleKind,name:String(row.name),
    rarity:String(row.rarity) as CollectibleRarity,description:String(row.description),
    acquisition:known?.acquisition??(String(row.rarity)==='silver'?'该场每题第一次提交均为 AC':'该场全部评级题目 AC'),
    unlockedAt:Number(row.unlocked_at),source:row.source_json?JSON.parse(String(row.source_json)):null,image:known?.image };
}

export function collectibleProfile(db:DatabaseSync,userId:number,cfPool:readonly ProblemRating[]=[]){
  if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))throw new Error('用户不存在');
  staticUnlocks(db,userId);contestUnlocks(db,userId,cfPool);
  db.prepare('INSERT OR IGNORE INTO user_profile_loadouts(user_id) VALUES(?)').run(userId);
  const owned=(db.prepare('SELECT * FROM user_collectibles WHERE user_id=? ORDER BY unlocked_at,collectible_id').all(userId) as Record<string,unknown>[]).map(rowCollectible);
  const ownedIds=new Set(owned.map(item=>item.id));
  const catalog=[...STATIC.map(item=>({...item,unlocked:ownedIds.has(item.id)})),
    ...owned.filter(item=>!byId.has(item.id)).map(item=>({...item,unlocked:true}))];
  const loadout=db.prepare('SELECT * FROM user_profile_loadouts WHERE user_id=?').get(userId) as Record<string,unknown>;
  return { owned,catalog, loadout:{ titleId:String(loadout.title_id),avatarId:String(loadout.avatar_id),
    avatarSource:String(loadout.avatar_source) as AvatarSource,customAvatar:loadout.custom_avatar_data?String(loadout.custom_avatar_data):null,
    avatarFrameId:String(loadout.avatar_frame_id),profileBackgroundId:String(loadout.profile_background_id),
    infoFrameId:String(loadout.info_frame_id),b50ThemeId:String(loadout.b50_theme_id) } };
}

const LOADOUT_FIELDS:Record<CollectibleKind,string|undefined>={achievement:undefined,title:'title_id',avatar:'avatar_id',avatar_frame:'avatar_frame_id',
  profile_background:'profile_background_id',info_frame:'info_frame_id',b50_theme:'b50_theme_id'};

export function equipCollectible(db:DatabaseSync,userId:number,collectibleId:string){
  const item=db.prepare('SELECT kind FROM user_collectibles WHERE user_id=? AND collectible_id=?').get(userId,collectibleId) as {kind:CollectibleKind}|undefined;
  if(!item)throw new Error('这件收藏品尚未获得');
  const field=LOADOUT_FIELDS[item.kind];if(!field)throw new Error('成就徽章不需要装备');
  db.prepare('INSERT OR IGNORE INTO user_profile_loadouts(user_id) VALUES(?)').run(userId);
  db.prepare(`UPDATE user_profile_loadouts SET ${field}=?,updated_at=unixepoch() WHERE user_id=?`).run(collectibleId,userId);
  if(item.kind==='avatar')db.prepare("UPDATE user_profile_loadouts SET avatar_source='collectible' WHERE user_id=?").run(userId);
  return collectibleProfile(db,userId);
}

export function setProfileAvatar(db:DatabaseSync,userId:number,source:AvatarSource,customAvatar?:string){
  if(!['collectible','codeforces','atcoder','custom'].includes(source))throw new Error('头像来源无效');
  if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))throw new Error('用户不存在');
  if(source==='codeforces'&&!db.prepare("SELECT 1 FROM accounts WHERE user_id=? AND platform='codeforces' AND is_archived=0").get(userId))throw new Error('请先绑定 Codeforces 账号');
  if(source==='atcoder'&&!db.prepare("SELECT 1 FROM accounts WHERE user_id=? AND platform='atcoder' AND is_archived=0").get(userId))throw new Error('请先绑定 AtCoder 账号');
  let stored:string|null=null;
  if(source==='custom'){
    if(typeof customAvatar!=='string'||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(customAvatar))throw new Error('自定义头像必须是 PNG、JPEG 或 WebP 图片');
    if(customAvatar.length>360_000)throw new Error('自定义头像太大，请压缩到 256 KB 以内');
    stored=customAvatar;
  }
  db.prepare('INSERT OR IGNORE INTO user_profile_loadouts(user_id) VALUES(?)').run(userId);
  db.prepare('UPDATE user_profile_loadouts SET avatar_source=?,custom_avatar_data=COALESCE(?,custom_avatar_data),updated_at=unixepoch() WHERE user_id=?')
    .run(source,stored,userId);
  return collectibleProfile(db,userId);
}
