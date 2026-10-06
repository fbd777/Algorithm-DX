-- Epoch timestamps are UTC seconds. Execution time is ms; memory is bytes.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  is_self INTEGER NOT NULL DEFAULT 0 CHECK(is_self IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS one_self ON users(is_self) WHERE is_self = 1;
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(length(platform) > 0),
  handle TEXT NOT NULL CHECK(length(trim(handle)) > 0),
  handle_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(platform, handle_key),
  UNIQUE(id, platform)
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  problem_title TEXT NOT NULL,
  problem_url TEXT,
  difficulty INTEGER,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('AC','WA','TLE','MLE','RE','CE','PENDING','OTHER')),
  raw_status TEXT,
  language TEXT,
  execution_time INTEGER CHECK(execution_time >= 0),
  memory INTEGER CHECK(memory >= 0),
  submitted_at INTEGER NOT NULL,
  FOREIGN KEY(account_id, platform) REFERENCES accounts(id, platform) ON DELETE CASCADE,
  UNIQUE(account_id, submission_id)
);
CREATE INDEX IF NOT EXISTS idx_submission_feed ON submissions(submitted_at DESC);
CREATE INDEX IF NOT EXISTS submission_account_status ON submissions(account_id,status,problem_id);
-- Derive user_id from accounts to prevent conflicting ownership.
CREATE VIEW IF NOT EXISTS submission_feed AS
SELECT s.*, a.user_id FROM submissions s JOIN accounts a ON a.id = s.account_id;
CREATE TABLE IF NOT EXISTS fetch_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
PRAGMA user_version = 1;
