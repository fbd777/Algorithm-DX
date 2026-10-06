/**
 * 「每题完成用时」的写操作 —— 唯一实现。
 *
 * 与 `account-admin.ts` 同一条规矩：规则只有一处出处，命令行与面板共用。
 * 这里只管校验与落库，不做 HTTP 相关的事。
 *
 * 为什么写之前非要确认「这题真的 AC 了」：
 * 用时是手填的，一旦允许给没 AC 的题填时间，榜上就会出现一道根本没做出来的题，
 * 而且是靠一个数字混进去的 —— 事后没人能看出哪条是错的。宁可在写入时就顶回去。
 *
 * 错误一律带 `code`：命令行打印英文 message，面板按 code 翻中文（见 server/api.ts）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { DX_PLATFORM } from './dx/rating.ts';
import { clearPracticeBest, recordPractice } from './dx/practice.ts';

export type DxTimeErrorCode = 'USER_NOT_FOUND' | 'PLATFORM_UNSUPPORTED' | 'PROBLEM_NOT_SOLVED' | 'TIME_INVALID';

export class DxTimeError extends Error {
  code: DxTimeErrorCode;
  constructor(code: DxTimeErrorCode, message: string) {
    super(message);
    this.name = 'DxTimeError';
    this.code = code;
  }
}

/** 允许的用时范围：1 秒到 24 小时。上限只为拦住手滑（比如把毫秒填进来）。 */
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 24 * 60 * 60;

export interface DxTimeInput {
  userId: number;
  platform: string;
  problemId: string;
  seconds: number;
}

function assertUser(db: DatabaseSync, userId: number): void {
  const row = db.prepare('SELECT id FROM users WHERE id=?').get(userId);
  if (!row) throw new DxTimeError('USER_NOT_FOUND', `user ${userId} does not exist`);
}

function assertSolved(db: DatabaseSync, input: DxTimeInput): void {
  const row = db
    .prepare(
      `SELECT 1 FROM submissions s JOIN accounts a ON a.id = s.account_id
       WHERE a.is_archived=0 AND a.user_id=? AND s.platform=? AND s.problem_id=? AND s.status='AC' LIMIT 1`,
    )
    .get(input.userId, input.platform, input.problemId);
  if (!row) {
    throw new DxTimeError(
      'PROBLEM_NOT_SOLVED',
      `${input.platform} ${input.problemId} is not an accepted problem for user ${input.userId}`,
    );
  }
}

function assertSeconds(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    throw new DxTimeError('TIME_INVALID', `seconds must be an integer in [${MIN_SECONDS}, ${MAX_SECONDS}]`);
  }
}

/** 写入 / 覆盖一道题的完成用时。返回是否新建。 */
export function setProblemTime(db: DatabaseSync, input: DxTimeInput): { seconds: number; created: boolean } {
  if (input.platform !== DX_PLATFORM) {
    throw new DxTimeError('PLATFORM_UNSUPPORTED', `dx rating currently only covers ${DX_PLATFORM}`);
  }
  assertUser(db, input.userId);
  assertSeconds(input.seconds);
  assertSolved(db, input);
  const existing = db
    .prepare('SELECT seconds FROM problem_times WHERE user_id=? AND platform=? AND problem_id=?')
    .get(input.userId, input.platform, input.problemId);
  recordPractice(db, { ...input, outcome: 'ac', practiceKind: 'unknown', timingSource: 'manual', attemptedAt: null }, true);
  return { seconds: input.seconds, created: existing === undefined };
}

/** 清掉一道题的用时（用于填错了重来）。返回是否真的删掉了东西。 */
export function clearProblemTime(
  db: DatabaseSync,
  input: Omit<DxTimeInput, 'seconds'>,
): { cleared: boolean } {
  return clearPracticeBest(db, input.userId, input.platform, input.problemId);
}
