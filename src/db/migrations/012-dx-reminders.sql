-- Reminder preferences never alter submissions, attempts or scores.
CREATE TABLE dx_time_reminders (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(account_id,problem_id)
);
PRAGMA user_version = 12;
