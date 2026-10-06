-- v8：比赛的时长（秒），用来判定一条提交是不是**比赛内**的。
--
-- 为什么当初没存（v6 注释说「会过期的快照不保留」）但现在要存：
--   首页的「最快用时」= 比赛窗口 [start_time, start_time + duration_seconds) 内最早一次 AC
--   与开赛时间的差。没有右端就没法把「比赛内提交」和「赛后再做（practice）」分开 ——
--   practice 提交的 submitted_at 距开赛可能是几天后，混进去会把最快用时变成垃圾值。
--   而比赛时长和开始时间一样是**既成事实**，比赛办完就不会再变，不属于会过期的快照。
--
-- 可空：旧行在下一轮 contest.list 刷新（≤6 小时）前是 NULL。**duration 为 NULL 的比赛
-- 一律不做「比赛内」判定**（首页不显示最快用时），不猜。
ALTER TABLE contests ADD COLUMN duration_seconds INTEGER;
PRAGMA user_version = 8;
