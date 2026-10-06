ALTER TABLE practice_attempts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE practice_attempts ADD COLUMN edited_at INTEGER;
PRAGMA user_version = 13;
