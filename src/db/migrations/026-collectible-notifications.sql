-- v26: persistent delivery state for site-wide collectible unlock notifications.
ALTER TABLE user_collectibles ADD COLUMN notified_at INTEGER;

-- Existing unlocks predate the notification UI and must not flood the first page load.
UPDATE user_collectibles SET notified_at=unlocked_at;

PRAGMA user_version = 26;
