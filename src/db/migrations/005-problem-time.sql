-- v5：记录用户在每道题上花掉的完成用时，供 DX Rating 换算使用。
--
-- 为什么单独开一张表，而不是往 submissions 上加一列：
--   1. 用时是**人填的**，不是平台给的。submissions.execution_time 是判题耗时（毫秒），
--      两者语义完全不同，混在一张表里迟早被误读（"为什么这题跑了 1200000 ms？"）。
--   2. 同一个用户在同一道题上可能提交很多次，而「完成用时」是**每题一个**的量：
--      键取 (user_id, platform, problem_id)，重填即覆盖。
--   3. 面板要能列出「已 AC 但还没填用时」的题，用 LEFT JOIN 天然查得到，不必改 submissions。
--
-- 只存原始秒数，**不存换算后的 rating**：曲线一改（`npm run study:export-dx`）所有读数都得跟着变，
-- 落库就多出一个真相来源。AC 时间也不在这里重复存 —— 入榜与否、算旧题还是本年度新题，
-- 一律以 submissions 里该题最早的 AC 时间为准。
--
-- 不设 problem_title / problem_rating 快照：这两样都能从 submissions 联出来，
-- 而 CF 的题目 Rating 是抓取时的官方值，本来就不是历史快照。
CREATE TABLE IF NOT EXISTS problem_times (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(length(platform) > 0),
  problem_id TEXT NOT NULL CHECK(length(problem_id) > 0),
  seconds INTEGER NOT NULL CHECK(seconds > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, platform, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_problem_time_user ON problem_times(user_id, platform);
PRAGMA user_version = 5;
