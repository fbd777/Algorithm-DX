-- Freeze the before/after comparison at completion; later practice must not rewrite it.
ALTER TABLE practice_timers ADD COLUMN settlement_json TEXT;
PRAGMA user_version = 15;
