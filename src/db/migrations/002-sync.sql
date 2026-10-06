CREATE TABLE sync_state (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  history_cursor TEXT,
  history_complete INTEGER NOT NULL DEFAULT 0,
  coverage_json TEXT
);
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','success','failed','interrupted')),
  mode TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  message TEXT,
  coverage_json TEXT
);
CREATE INDEX idx_sync_runs_account ON sync_runs(account_id, id DESC);
CREATE TABLE sync_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE request_slots (origin TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
CREATE TABLE response_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
PRAGMA user_version = 2;
