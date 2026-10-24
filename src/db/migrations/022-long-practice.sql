-- Preserve actual elapsed time when a failed challenge continues past one day.
CREATE TABLE practice_attempts_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK(seconds > 0),
  outcome TEXT NOT NULL CHECK(outcome IN ('ac','unfinished')),
  practice_kind TEXT NOT NULL CHECK(practice_kind IN ('unknown','first','repeat','assisted')),
  timing_source TEXT NOT NULL CHECK(timing_source IN ('legacy','manual','contest_estimate')),
  attempted_at INTEGER,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  voided_at INTEGER,
  archived_at INTEGER,
  request_id TEXT UNIQUE,
  revision INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  is_manual INTEGER NOT NULL DEFAULT 0 CHECK(is_manual IN (0,1)),
  manual_title TEXT,
  manual_difficulty INTEGER CHECK(manual_difficulty >= 0)
);
INSERT INTO practice_attempts_new SELECT * FROM practice_attempts;
DROP TABLE practice_attempts;
ALTER TABLE practice_attempts_new RENAME TO practice_attempts;
CREATE INDEX idx_practice_user_problem ON practice_attempts(user_id, platform, problem_id);
PRAGMA user_version = 22;
