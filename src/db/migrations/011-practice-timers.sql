-- A timer belongs to an account identity and survives browser/server restarts.
CREATE TABLE practice_timers (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  handle_key TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  practice_kind TEXT NOT NULL CHECK(practice_kind IN ('unknown','first','repeat','assisted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','cancelled','expired')),
  attempt_id INTEGER UNIQUE REFERENCES practice_attempts(id) ON DELETE SET NULL,
  submission_id TEXT
);
CREATE UNIQUE INDEX one_running_timer_per_user ON practice_timers(user_id) WHERE status='running';
CREATE INDEX timer_account_status ON practice_timers(account_id,status);
PRAGMA user_version = 11;
