-- New challenges use a shared time bank; NULL preserves v0.2.0 rounds.
ALTER TABLE dan_sessions ADD COLUMN rules_json TEXT;
ALTER TABLE dan_stages ADD COLUMN life_json TEXT;
PRAGMA user_version = 21;
