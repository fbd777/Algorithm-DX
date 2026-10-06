-- v6：比赛的开始时间，也就是题目的「出题日期」，供 DX Rating 判定「本年度新题」。
--
-- 为什么必须单独存：
--   b15 区按**出题日期**分桶，不是按 AC 时间。2026 年切掉一道 2013 年的老题
--   （例如 339:A，Codeforces Round 197），它属于旧题区 b35；只有本年度新举办的
--   比赛里的题才进 b15。而 CF 的提交载荷里**没有**这个日期 ——
--   `user.status` 只给 contestId 与 rating，日期只有 `contest.list` 的 startTimeSeconds 提供。
--
-- 为什么不从 problem_id 前缀现算：
--   前缀（`339:A` → 339）只给出比赛 id，日期仍然得另取一次，所以这里存的就是
--   「比赛 id → 开始时间」的映射。按 platform 隔离，别的平台将来有自己的来源。
--
-- 只存判定所需的最小字段：不存 durationSeconds / phase / relativeTimeSeconds，
-- 那些是抓取时刻的快照，会过期，而本项目不保留会过期的副本。
-- `fetched_at` 记的是**这一行最后一次写入的时间**，用于「多久没刷新过」的 TTL 判断。
CREATE TABLE IF NOT EXISTS contests (
  platform TEXT NOT NULL CHECK(length(platform) > 0),
  contest_id INTEGER NOT NULL,
  name TEXT,
  start_time INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (platform, contest_id)
);
CREATE INDEX IF NOT EXISTS idx_contest_start ON contests(platform, start_time);
PRAGMA user_version = 6;
