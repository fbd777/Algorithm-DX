-- v19：随机段位認定（小随机 / 大随机）。
--
-- 为什么需要「逐题限时」这一列：
--   四个难度档的区间互不重叠，一个档位配一个统一限时是合理的。但随机段位**不分段**，
--   抽到的题横跨 800-2600 —— 给 800 分的题 60 分钟、给 2600 分的题也 60 分钟，
--   两头都不公平。所以限时随题走，落在 stage 上。
--
-- 为什么 NULL 是合法的：
--   019 之前抽出来的行没有这个值，它们属于「档位统一限时」那一套规则。
--   NULL = 沿用 session.limit_seconds，于是旧记录的解释一个字都不用改。
--
-- 没有重建 dan_sessions：随机段位沿用 kind='challenge'，靠 tier 区分
--   （small_random / big_random，见 src/dx/dan.ts 的 DAN_RANDOM_TIERS）。
--   加一个 kind 值要重建整张表（SQLite 改不了 CHECK），而 tier 已经能表达这件事。
ALTER TABLE dan_stages ADD COLUMN limit_seconds INTEGER;

PRAGMA user_version = 19;