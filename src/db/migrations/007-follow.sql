-- v7：独立的「关注」标记。
--
-- 为什么 `is_self` 不够：
--   `is_self` 全局只有一个（`one_self` 部分唯一索引），语义是「这是我本人」——
--   它是主视图与 DX 榜的锚点。而「我关注的人」是另一层意思：数量不限，而且允许
--   **存在但不关注**（先建好、以后再看；或者曾经关注过、现在不想让 TA 占版面）。
--   把「关注」压进 `is_self` 就只能在两者里二选一，等于把两层语义塞进一个字段。
--
-- 为什么不拿「users 表里有没有这个人」当「是否已关注」：
--   那样想临时不看某人就只能删用户，而删用户会连带删掉他名下所有账号与提交记录
--   （外键 ON DELETE CASCADE）。关注标记可以随时来回切，删除不可逆 ——
--   「不想看」和「彻底删掉」不该是同一个操作。
--
-- 自己（`is_self=1`）天然算被关注：它是主视图与 DX 榜的锚点，
-- 所以应用层禁止把本人取消关注（见 account-admin.ts 的 setFollowed）。
ALTER TABLE users ADD COLUMN is_followed INTEGER NOT NULL DEFAULT 0 CHECK(is_followed IN (0,1));
-- 迁移前建的用户默认全部置为已关注：他们都是当初专门加进来的，
-- 静默变成「不关注」等于把他们的历史数据从主视图里抹掉 —— 迁移不能改变可见的数据集。
UPDATE users SET is_followed = 1;
PRAGMA user_version = 7;
