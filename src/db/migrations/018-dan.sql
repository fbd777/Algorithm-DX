-- v18：随机抽题、每日一题与段位認定（挑战模式）。
--
-- 为什么单独建表，不复用 practice_timers：
--   计时器只知道「一道题从开始到 AC」，它没有「这是第几道」和「这一轮要几道」的
--   概念。挑战/认定是一组题的**序列**，胜负要靠整轮判定，必须有自己的状态机。
--
-- 为什么 dan_stages 要存 difficulty 快照：
--   CF 的题目评级会变（公布、回填、重评），而这一轮的进展与结算必须可复现 ——
--   与 practice_timers.settlement_json 是同一条理由（见 migrations/015）。
--
-- 为什么 session 行冗余存 stage_count / limit_seconds：
--   这两条规则随档位走（src/dx/dan.ts 的 DAN_TIERS）。存进 session 是为了让
--   **历史记录永远按当时的规则解释** —— 以后调档位区间或限时，不会把旧记录
--   重新解释成另一个结果。
CREATE TABLE IF NOT EXISTS dan_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK(length(tier) > 0),
  kind TEXT NOT NULL CHECK(kind IN ('challenge','single','daily')),
  stage_count INTEGER NOT NULL CHECK(stage_count >= 1),
  limit_seconds INTEGER NOT NULL CHECK(limit_seconds > 0),
  min_rating INTEGER NOT NULL CHECK(min_rating > 0),
  max_rating INTEGER NOT NULL CHECK(max_rating >= min_rating),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cleared','failed','abandoned')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  total_rating REAL,
  settlement_json TEXT
);
CREATE INDEX IF NOT EXISTS dan_session_user ON dan_sessions(user_id, started_at DESC);
-- 一个用户同时只能有一轮进行中的认定，与 practice_timers 的
-- one_running_timer_per_user 同一个理由：并行的两轮无法判定「第几道」。
CREATE UNIQUE INDEX IF NOT EXISTS one_active_dan_per_user ON dan_sessions(user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS dan_stages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES dan_sessions(id) ON DELETE CASCADE,
  stage_index INTEGER NOT NULL CHECK(stage_index >= 1),
  -- 抽到的题：只有服务端知道，任何读接口都不下发（见 src/dx/dan.ts 口径 A）。
  problem_id TEXT NOT NULL CHECK(length(problem_id) > 0),
  difficulty INTEGER NOT NULL CHECK(difficulty > 0),
  drawn_at INTEGER NOT NULL,
  claimed_at INTEGER,
  timer_id TEXT REFERENCES practice_timers(id) ON DELETE SET NULL,
  outcome TEXT CHECK(outcome IN ('cleared','timeout','interrupted')),
  seconds INTEGER,
  score_json TEXT,
  UNIQUE(session_id, stage_index)
);
CREATE INDEX IF NOT EXISTS dan_stage_session ON dan_stages(session_id, stage_index);
PRAGMA user_version = 18;