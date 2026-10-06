-- Preserve existing selected times without inventing a practice date or provenance.
CREATE TABLE practice_attempts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK(seconds BETWEEN 1 AND 86400),
  outcome TEXT NOT NULL CHECK(outcome IN ('ac','unfinished')),
  practice_kind TEXT NOT NULL CHECK(practice_kind IN ('unknown','first','repeat','assisted')),
  timing_source TEXT NOT NULL CHECK(timing_source IN ('legacy','manual','contest_estimate')),
  attempted_at INTEGER,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  voided_at INTEGER,
  archived_at INTEGER,
  request_id TEXT UNIQUE
);
CREATE INDEX idx_practice_user_problem ON practice_attempts(user_id, platform, problem_id);
INSERT INTO practice_attempts(user_id,platform,problem_id,seconds,outcome,practice_kind,timing_source,recorded_at)
  SELECT user_id,platform,problem_id,seconds,'ac','unknown','legacy',updated_at FROM problem_times;
PRAGMA user_version = 10;
