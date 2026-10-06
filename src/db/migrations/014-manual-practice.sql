ALTER TABLE practice_attempts ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0 CHECK(is_manual IN (0,1));
ALTER TABLE practice_attempts ADD COLUMN manual_title TEXT;
ALTER TABLE practice_attempts ADD COLUMN manual_difficulty INTEGER CHECK(manual_difficulty >= 0);
PRAGMA user_version = 14;
