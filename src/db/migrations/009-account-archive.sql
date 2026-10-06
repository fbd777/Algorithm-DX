ALTER TABLE accounts ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1));
CREATE TABLE archived_problem_times (
 account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 platform TEXT NOT NULL, problem_id TEXT NOT NULL, seconds INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,platform,problem_id)
);
PRAGMA user_version = 9;
