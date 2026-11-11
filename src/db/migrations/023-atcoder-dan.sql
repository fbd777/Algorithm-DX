-- v23: random practice and dan sessions are platform-scoped.
-- Existing sessions remain Codeforces sessions; new AtCoder stages snapshot their
-- native metadata so history does not depend on a later cache refresh.
ALTER TABLE dan_sessions ADD COLUMN platform TEXT NOT NULL DEFAULT 'codeforces'
  CHECK(platform IN ('codeforces','atcoder'));
ALTER TABLE dan_stages ADD COLUMN problem_url TEXT;
ALTER TABLE dan_stages ADD COLUMN problem_title TEXT;
ALTER TABLE dan_stages ADD COLUMN native_difficulty INTEGER;
PRAGMA user_version = 23;
