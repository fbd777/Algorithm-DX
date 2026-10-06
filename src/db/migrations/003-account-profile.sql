-- v3：保存平台解析出的显示名。
--
-- 与 handle 分开存放是有意的：handle 是抓取用的标识，也是 (platform, handle_key) 唯一键的组成部分，
-- 不能随意改动；display_name 只是给人看的公开昵称，平台随时可能改名，缺失或过期都不影响抓取。
-- 数字 UID 平台（例如洛谷）尤其需要它，否则面板上只能看到一个裸数字。
ALTER TABLE accounts ADD COLUMN display_name TEXT;
-- 记录解析时间，便于判断昵称是否过期；NULL 表示从未解析过。
ALTER TABLE accounts ADD COLUMN display_name_at INTEGER;
PRAGMA user_version = 3;
