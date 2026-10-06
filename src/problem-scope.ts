/**
 * 「一道题」的口径 —— 全项目唯一的定义处。
 *
 * 背景：洛谷的同一道题会在记录列表里出现两次。比赛期间的临时编号形如 `T1234567`（T + 数字），
 * 赛后公开的练习编号形如 `B4521`，两者**题名完全相同**。2026-09-17 实测：
 * 库里 653 条提交里，语言月赛的同一道题被算成两题，AC 题数因此从 217 虚高到 230。
 *
 * 约定（Ryan 2026-09-17 定）：
 * - **计入题目数量口径的只有练习编号**；比赛内编号（`T…`）不计入 AC 题数、不计入题目卡片统计。
 * - **提交明细照常保留** —— 那次比赛提交确实发生过，只是不该被当成一道新题。
 *
 * 只有洛谷使用这种编号，`platform = 'luogu'` 这个条件保证其他平台不受影响。
 *
 * ⚠️ 这两个常量是 SQL 片段，**依赖调用处的表里有 `platform` 与 `problem_id` 两列**，
 * 且不允许加表别名（写成 `s.platform` 会让 `FROM f` 之类的场景失效）。
 * 需要修改口径时只改这里一处。
 */

/** 匹配「比赛内编号」的 SQL 条件。 */
export const CONTEST_SCOPED_PROBLEM = "(platform = 'luogu' AND problem_id GLOB 'T[0-9]*')";

/** 匹配「练习编号」（题目数量口径真正计入的部分）的 SQL 条件。 */
export const PRACTICE_PROBLEM = `NOT ${CONTEST_SCOPED_PROBLEM}`;

/** 与 SQL 片段等价的 JS 判断，供需要逐行过滤的地方使用。 */
export function isContestScopedProblem(platform: string, problemId: string): boolean {
  return platform === 'luogu' && /^T\d/.test(problemId);
}
