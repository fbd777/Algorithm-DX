import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
/**
 * 账号与用户的写操作 —— 唯一实现。
 *
 * 命令行（`npm run algo -- account add …`）与 Dashboard 面板共用这一段逻辑。
 * 理由跟 `problem-scope.ts` 一样：**规则只能有一处出处**。否则「面板能绑、命令绑不上」
 * 或者「面板的校验比命令行松」这类分叉迟早会出现，而且没人会去对账。
 *
 * 这里只管数据库与 .env 的写入，不做任何 HTTP 相关的事；面板的鉴权在 server.ts。
 *
 * 错误一律带 `code`：命令行直接打印英文 message（脚本里 grep 得动），
 * 面板按 code 翻成中文（api.ts 的 ADMIN_MESSAGES），两边都不必解析对方的文案。
 */
import type { DatabaseSync } from 'node:sqlite';
import { Repository } from './db/database.ts';
import { refreshBestTime } from './dx/practice.ts';

function restoreManualTimes(db: DatabaseSync, userId: number, platform: string) {
  const rows = db.prepare('SELECT DISTINCT problem_id FROM practice_attempts WHERE user_id=? AND platform=? AND is_manual=1 AND archived_at IS NULL').all(userId, platform);
  for (const row of rows) refreshBestTime(db, userId, platform, String(row.problem_id));
}
import { credentialKey, credentialPlatforms, createFactory, platforms, validateAccount } from './fetchers/registry.ts';
import { assertSafeEnvValue, upsertEnvVar, type EnvWriteOutcome } from './credentials.ts';
import { type ProbeResult } from './fetchers/base.ts';
import { HttpClient } from './fetchers/http.ts';
import { LuoguFetcher } from './fetchers/luogu.ts';

export type AdminErrorCode =
  | 'USER_NOT_FOUND'
  | 'USER_NAME_INVALID'
  | 'SELF_ALREADY_SET'
  | 'PLATFORM_UNKNOWN'
  | 'CREDENTIAL_NOT_APPLICABLE'
  | 'CREDENTIAL_INVALID'
  | 'HANDLE_INVALID'
  | 'ACCOUNT_EXISTS'
  | 'ACCOUNT_OWNED_BY_OTHER'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_ON_PLATFORM'
  | 'HANDLE_TAKEN'
  | 'SELF_CANNOT_UNFOLLOW'
  | 'USER_MISSING'
  | 'IDENTITY_CONFIRM_REQUIRED' | 'STABLE_ID' | 'ACCOUNT_ARCHIVED' | 'SYNC_BUSY';

export class AdminError extends Error {
  code: AdminErrorCode;
  constructor(code: AdminErrorCode, message: string) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
  }
}

export interface BindInput {
  userId: number;
  platform: string;
  handle: string;
  /** 平台登录凭据。给值才写 .env；不给就只绑账号。 */
  cookie?: string | null;
  /** .env 路径。CLI 与面板都指向项目根目录下的 .env。 */
  envFile: string;
  /**
   * 命中「平台 + handle」已存在的账号时，是复用还是报错。
   *
   * 两处调用有意不同：
   * - 命令行传 false（除非带了 --cookie）：脚本里重复绑同一个 handle 多半是写错了 user id，
   *   静默变成无操作比报错更糟。
   * - 面板传 true：界面上点「绑定」时右侧就是已绑定列表，复用是明确意图，报错只是白挡一次。
   */
  reuseExisting: boolean;
  /** 是否解析洛谷公开昵称（需要联网）。失败不阻断绑定。 */
  resolveProfile?: boolean;
  /**
   * 是否在入库前先探一次「平台上真有这个人」。默认开。
   *
   * 关掉它的理由只有两个：离线环境，或者你就是要绑一个暂时查不到的账号。
   * 探不到（unknown）不阻断绑定 —— 那是「这次没探到」，不是「没有这个人」。
   */
  probe?: boolean;
}

export interface BindOutcome {
  id: number;
  existing: boolean;
  credential: { variable: string; file: string; action: EnvWriteOutcome } | null;
  /**
   * 绑定前的探测结果。`missing` 不会出现在这里 —— 那种情况直接抛错，不会绑定成功。
   * `null` = 本次没探测（调用方关掉了）。
   */
  probe: ProbeResult | null;
  displayName?: string;
  slogan?: string;
  registeredAt?: string;
  displayNameWarning?: string;
}

export interface UnbindOutcome {
  deleted: number;
  /** 连带删除的提交条数。解绑不可逆，把代价显式报出来。 */
  submissions: number;
}

export interface RenameOutcome {
  id: number;
  platform: string;
  from: string;
  to: string;
  /** 改名后**保留下来**的提交条数。用来证明「改标识 ≠ 删号重来」。 */
  submissions: number;
}

function requireUser(db: DatabaseSync, userId: number): void {
  const row = db.prepare('SELECT id FROM users WHERE id=?').get(userId);
  if (!row) throw new AdminError('USER_NOT_FOUND', `User ${userId} does not exist; create the user first`);
}

/**
 * 绑定一个平台账号。可选地顺手把平台登录凭据写进 .env。
 *
 * 探测之后在事务内检查归属并建账号，再保存凭据；写入失败回滚，提交失败恢复凭据。
 */
export async function bindAccount(db: DatabaseSync, input: BindInput): Promise<BindOutcome> {
  const platform = input.platform.trim();
  const handle = input.handle.trim();
  // 「平台不存在」和「handle 格式不对」是两件事，validateAccount 用同一句话报出来，
  // 所以先自己判一次平台，免得面板把未知平台说成「洛谷要填数字 ID」。
  if (!(platforms as readonly string[]).includes(platform)) {
    throw new AdminError('PLATFORM_UNKNOWN', `Platform must be one of: ${platforms.join(', ')}`);
  }
  // 其余校验器来自上游模块（registry / credentials），报错文案是英文且被命令行测试盯着，
  // 所以不改造它们，只在这里补一个 code，让面板能翻成中文。
  try {
    validateAccount(platform, handle);
  } catch (error) {
    throw new AdminError('HANDLE_INVALID', error instanceof Error ? error.message : 'Invalid handle');
  }
  requireUser(db, input.userId);

  const repo = new Repository(db);
  const archived = repo.findAccount(platform, handle);
  if (archived && db.prepare('SELECT is_archived FROM accounts WHERE id=?').get(archived.id)?.is_archived) {
    throw new AdminError('ACCOUNT_ARCHIVED', 'This handle belongs to an archived account');
  }
  const raw = input.cookie === undefined || input.cookie === null ? '' : String(input.cookie).trim();

  // 凭据先只**校验**、不落盘：探测可能在落盘之前就拒绝这次绑定，
  // 那时不该留下一个已经被改过的 .env —— 绑定没成，副作用也不该留下。
  let pending: { key: string; value: string } | null = null;
  if (raw) {
    if (!(credentialPlatforms as readonly string[]).includes(platform)) {
      throw new AdminError('CREDENTIAL_NOT_APPLICABLE', `--cookie only applies to: ${credentialPlatforms.join(', ')}`);
    }
    const key = credentialKey(platform);
    try {
      pending = { key, value: assertSafeEnvValue(key, raw) };
    } catch (error) {
      throw new AdminError('CREDENTIAL_INVALID', error instanceof Error ? error.message : 'Invalid credential value');
    }
  }

  // 探测：确认平台上真有这个人再往下走。
  // unknown 不阻断 —— 「这次没探到」不是「没有这个人」，那是本项目的一条老规矩。
  let probe: ProbeResult | null = null;
  if (input.probe !== false) {
    probe = await probeAccount(db, platform, handle);
    if (probe.status === 'missing') {
      throw new AdminError('ACCOUNT_NOT_ON_PLATFORM', probe.reason);
    }
  }

  let credential: BindOutcome['credential'] = null;
  let existing: ReturnType<Repository['findAccount']>;
  let accountId: number;
  let original: Buffer | null = null;
  let credentialWritten = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    requireUser(db, input.userId);
    existing = repo.findAccount(platform, handle);
    if (existing && db.prepare('SELECT is_archived FROM accounts WHERE id=?').get(existing.id)?.is_archived)
      throw new AdminError('ACCOUNT_ARCHIVED', 'Account is archived');
    if (existing && existing.user_id !== input.userId)
      throw new AdminError('ACCOUNT_OWNED_BY_OTHER', 'That handle is already bound to another user');
    if (existing && !input.reuseExisting)
      throw new AdminError('ACCOUNT_EXISTS', 'Already bound: this account exists');
    accountId = existing ? existing.id : repo.addAccount(input.userId, platform, handle);
    if (pending) {
      original = existsSync(input.envFile) ? readFileSync(input.envFile) : null;
      credential = { variable: pending.key, file: input.envFile, action: upsertEnvVar(input.envFile, pending.key, pending.value) };
      credentialWritten = true;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (credentialWritten) {
      if (original === null) unlinkSync(input.envFile);
      else writeFileSync(input.envFile, original);
    }
    throw error;
  }
  const outcome: BindOutcome = { id: accountId, existing: Boolean(existing), credential, probe };

  // 洛谷只认数字 uid，裸数字看不出绑的是谁；顺手解析公开昵称，让「只填 uid」也能自证身份。
  // 已有账号缺昵称时也补一次 —— 早先版本的库没有这个字段。
  const needsName = platform === 'luogu' && input.resolveProfile !== false && (!existing || !existing.display_name);
  if (needsName) {
    // 探测已经把昵称带回来了就直接用，不必为同一件事再请求一次。
    const probed = probe?.status === 'found' ? probe.displayName : null;
    try {
      if (probed) {
        repo.setDisplayName(accountId, probed);
        outcome.displayName = probed;
      } else {
        const profile = await new LuoguFetcher(new HttpClient(db)).fetch_profile(handle);
        repo.setDisplayName(accountId, profile.name);
        outcome.displayName = profile.name;
        if (profile.slogan) outcome.slogan = profile.slogan;
        if (profile.registerTime) outcome.registeredAt = new Date(profile.registerTime * 1000).toISOString().slice(0, 10);
      }
    } catch (error) {
      // The binding already committed; optional profile enrichment is only a warning.
      outcome.displayNameWarning = error instanceof Error ? error.message : 'Luogu profile lookup failed';
    }
  }

  return outcome;
}

/**
 * 探测一个 handle 在平台上是否真实存在。
 *
 * 走 `createFactory` 而不是在这里 switch 平台：哪个平台由哪个 fetcher 负责只有一处出处。
 * 探测账号本身没有 id（还没入库），这里给 0 —— 探测只用到 platform 与 handle，
 * 不碰任何与 id 相关的东西（凭据解析对「探测」这个动作也没有意义）。
 */
async function probeAccount(db: DatabaseSync, platform: string, handle: string): Promise<ProbeResult> {
  try {
    const factory = createFactory(db);
    return await factory({ id: 0, user_id: 0, platform, handle }).probe_handle(handle);
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Probe failed' };
  }
}

/**
 * 解绑账号。submissions / sync_state / sync_runs 上的外键都是 ON DELETE CASCADE，
 * 所以删一行会连带删掉该账号的全部记录 —— 调用方必须先确认（命令行要 --yes，面板要二次确认）。
 */
export function unbindAccount(db: DatabaseSync, accountId: number): UnbindOutcome {
  return changeIdentity(db, () => {
    const account = db.prepare('SELECT user_id,platform FROM accounts WHERE id=?').get(accountId);
    if (!account) throw new AdminError('ACCOUNT_NOT_FOUND', 'ID does not exist');
    const before = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE account_id=?').get(accountId) as { n: number };
    const result = db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
    // Prevent retained per-user history from being inherited by a later, unrelated binding.
    db.prepare(`UPDATE practice_attempts SET archived_at=unixepoch() WHERE user_id=? AND platform=? AND archived_at IS NULL AND is_manual=0
      AND NOT EXISTS (SELECT 1 FROM submissions s JOIN accounts a ON a.id=s.account_id
        WHERE a.user_id=practice_attempts.user_id AND a.is_archived=0 AND s.platform=practice_attempts.platform
          AND s.problem_id=practice_attempts.problem_id AND (practice_attempts.outcome!='ac' OR s.status='AC'))`)
      .run(account.user_id, account.platform);
    db.prepare(`DELETE FROM problem_times WHERE user_id=? AND platform=? AND NOT EXISTS
      (SELECT 1 FROM submissions s JOIN accounts a ON a.id=s.account_id WHERE a.user_id=problem_times.user_id
        AND a.is_archived=0 AND s.platform=problem_times.platform AND s.problem_id=problem_times.problem_id AND s.status='AC')`)
      .run(account.user_id, account.platform);
    restoreManualTimes(db, account.user_id, account.platform);
    return { deleted: Number(result.changes), submissions: Number(before.n) };
  });
}

/** Identity changes are serialized with sync and committed atomically. */
function changeIdentity<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM sync_lock WHERE expires_at>=unixepoch()').get())
      throw new AdminError('SYNC_BUSY', 'Wait for the current sync to finish');
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function identityInput(db: DatabaseSync, accountId: number, handle: string) {
  const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as
    { id: number; user_id: number; platform: string; handle: string; is_archived: number } | undefined;
  if (!row) throw new AdminError('ACCOUNT_NOT_FOUND', 'Account does not exist');
  if (row.is_archived) throw new AdminError('ACCOUNT_ARCHIVED', 'Account is archived');
  const clean = String(handle ?? '').trim();
  try { validateAccount(row.platform, clean); }
  catch (error) { throw new AdminError('HANDLE_INVALID', error instanceof Error ? error.message : 'Invalid handle'); }
  const clash = new Repository(db).findAccount(row.platform, clean);
  if (clean === row.handle || (clash && clash.id !== accountId))
    throw new AdminError('HANDLE_TAKEN', 'Handle is already bound (including archived accounts)');
  return { row, clean };
}

export function renameAccount(db: DatabaseSync, accountId: number, handle: string, sameIdentity = false): RenameOutcome {
  return changeIdentity(db, () => {
    const { row, clean } = identityInput(db, accountId, handle);
    if (['luogu', 'nowcoder'].includes(row.platform))
      throw new AdminError('STABLE_ID', 'Numeric user IDs cannot be renamed; replace the account instead');
    if (!sameIdentity) throw new AdminError('IDENTITY_CONFIRM_REQUIRED', 'Confirm this is the same platform account');
    new Repository(db).renameAccount(accountId, row.platform, clean);
    const kept = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE account_id=?').get(accountId)!;
    return { id: accountId, platform: row.platform, from: row.handle, to: clean, submissions: Number(kept.n) };
  });
}

/** Archive the source; the replacement gets a fresh ID and no sync state. */
export function replaceAccount(db: DatabaseSync, accountId: number, handle: string) {
  return changeIdentity(db, () => {
    const { row, clean } = identityInput(db, accountId, handle);
    if (new Repository(db).findAccount(row.platform, clean))
      throw new AdminError('HANDLE_TAKEN', 'Replacement must be a different platform account');
    db.prepare('UPDATE accounts SET is_archived=1 WHERE id=?').run(accountId);
    db.prepare(`UPDATE practice_attempts SET archived_at=unixepoch() WHERE user_id=? AND platform=? AND archived_at IS NULL AND is_manual=0
      AND NOT EXISTS (SELECT 1 FROM submissions s JOIN accounts a ON a.id=s.account_id
        WHERE a.user_id=practice_attempts.user_id AND a.is_archived=0 AND s.platform=practice_attempts.platform
          AND s.problem_id=practice_attempts.problem_id AND (practice_attempts.outcome!='ac' OR s.status='AC'))`)
      .run(row.user_id, row.platform);
    db.prepare(`INSERT INTO archived_problem_times
      SELECT ?, pt.platform, pt.problem_id, pt.seconds, pt.created_at, pt.updated_at
      FROM problem_times pt WHERE pt.user_id=? AND pt.platform=? AND EXISTS
      (SELECT 1 FROM submissions s WHERE s.account_id=? AND s.problem_id=pt.problem_id AND s.status='AC')`)
      .run(accountId, row.user_id, row.platform, accountId);
    db.prepare(`DELETE FROM problem_times WHERE user_id=? AND platform=?
      AND problem_id IN (SELECT problem_id FROM archived_problem_times WHERE account_id=?)
      AND NOT EXISTS (SELECT 1 FROM submissions s JOIN accounts a ON a.id=s.account_id
        WHERE a.user_id=problem_times.user_id AND a.is_archived=0 AND s.platform=problem_times.platform
        AND s.problem_id=problem_times.problem_id AND s.status='AC')`)
      .run(row.user_id, row.platform, accountId);
    restoreManualTimes(db, row.user_id, row.platform);
    const id = new Repository(db).addAccount(row.user_id, row.platform, clean);
    return { id, archivedId: accountId, platform: row.platform, from: row.handle, to: clean };
  });
}

export function createUser(db: DatabaseSync, name: string, isSelf = false, isFollowed = true): number {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 40) {
    throw new AdminError('USER_NAME_INVALID', 'User name must be 1 to 40 characters');
  }
  if (isSelf) {
    // one_self 是「至多一个 is_self=1」的部分唯一索引，这里翻译成人话再抛。
    const taken = db.prepare('SELECT name FROM users WHERE is_self=1').get() as { name: string } | undefined;
    if (taken) throw new AdminError('SELF_ALREADY_SET', `A user is already marked as self (${taken.name})`);
  }
  return new Repository(db).createUser(clean, isSelf, isFollowed);
}

/**
 * 切换「是否关注这个人」。
 *
 * 关注与「是本人」是**两层**，不能互相替代：
 * - `is_self` 全局只有一个，是主视图与 DX 榜的锚点；
 * - `is_followed` 不限数量，只决定「他出不出在主视图里」。
 *
 * 所以「存在但不关注」是合法状态：可以先建好、以后再看，也可以随时让它不占版面 ——
 * 而**删掉**是不可逆的（会连带删掉名下账号与提交），两者不该绑成一个操作。
 * 本人不能取消关注：取消了自己还看谁。
 */
export function setFollowed(db: DatabaseSync, userId: number, followed: boolean): { id: number; is_followed: boolean } {
  const row = db.prepare('SELECT id, is_self FROM users WHERE id=?').get(userId) as
    | { id: number; is_self: number }
    | undefined;
  if (!row) throw new AdminError('USER_NOT_FOUND', `User ${userId} does not exist`);
  if (!followed && Number(row.is_self) === 1) {
    throw new AdminError('SELF_CANNOT_UNFOLLOW', 'Cannot unfollow yourself; the self user anchors the dashboard');
  }
  db.prepare('UPDATE users SET is_followed=? WHERE id=?').run(Number(followed), userId);
  return { id: userId, is_followed: followed };
}

/** 删用户会连带删掉其名下所有账号与提交记录。 */
export function removeUser(db: DatabaseSync, userId: number): { deleted: number; accounts: number } {
  const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id=?').get(userId) as { n: number };
  const result = db.prepare('DELETE FROM users WHERE id=?').run(userId);
  if (!result.changes) throw new AdminError('USER_MISSING', 'ID does not exist');
  return { deleted: Number(result.changes), accounts: Number(accounts.n) };
}
