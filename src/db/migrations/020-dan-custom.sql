-- 自定义单题抽题：把用户选的标签存进轮次。
--
-- 只加一列。NULL = 这一轮没有标签条件（四个档位、两个随机段位与每日一题都是），
-- 历史记录的解释不变。
--
-- 难度范围不用加列：dan_sessions 本来就有 min_rating / max_rating，
-- 自定义抽题直接复用这两列，tier 记 'custom'。
ALTER TABLE dan_sessions ADD COLUMN tags_json TEXT;
PRAGMA user_version = 20;
