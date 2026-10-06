CREATE TABLE cf_group_rating_sources (
 problem_id TEXT PRIMARY KEY, source_problem_id TEXT, source_url TEXT, rating INTEGER,
 method TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
PRAGMA user_version = 16;
