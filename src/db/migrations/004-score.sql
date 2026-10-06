-- v4：保存平台的原始得分。
--
-- 起因：洛谷的 status=14（"Unaccepted"）只说明「判完了但没拿满分」，不区分是 WA、TLE 还是
-- 部分分。这类记录 2026-09-17 实测占 322/653，全都落在 OTHER 里彼此无法区分。
-- 而载荷里本来就带着 score（例如 25），存下来才能把「部分分」和「完全没分」分开。
--
-- ⚠️ 满分由题目决定，**不是固定的 100**：2026-09-17 抽样 40 道题，fullScore 出现 30 与 100 两种，
-- 全库最大 score 实测到 809。所以这里只存原始 score，不折算成百分比 —— 折算需要 fullScore，
-- 而 fullScore 目前没有入库（要的话得再开一列）。别在展示层假设分母是 100。
--
-- 可空是刻意的：Codeforces / AtCoder / 力扣等平台不给分数字段，那里保持 NULL，
-- 不要用 0 冒充「零分」，否则会把「平台不提供」误读成「考了 0 分」。
ALTER TABLE submissions ADD COLUMN score INTEGER;
PRAGMA user_version = 4;
