-- v25: selectable avatar sources and image-backed player-card collectibles.
CREATE TABLE user_collectibles_v25 (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collectible_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('achievement','title','avatar','avatar_frame','profile_background','info_frame','b50_theme')),
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK(rarity IN ('starter','white','bronze','silver','gold','rainbow')),
  description TEXT NOT NULL,
  source_json TEXT,
  unlocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, collectible_id)
);

INSERT INTO user_collectibles_v25
SELECT user_id,collectible_id,kind,name,rarity,description,source_json,unlocked_at FROM user_collectibles;
DROP TABLE user_collectibles;
ALTER TABLE user_collectibles_v25 RENAME TO user_collectibles;

ALTER TABLE user_profile_loadouts ADD COLUMN avatar_id TEXT NOT NULL DEFAULT 'avatar:lxns-11';
ALTER TABLE user_profile_loadouts ADD COLUMN avatar_source TEXT NOT NULL DEFAULT 'collectible'
  CHECK(avatar_source IN ('collectible','codeforces','atcoder','custom'));
ALTER TABLE user_profile_loadouts ADD COLUMN custom_avatar_data TEXT;

PRAGMA user_version = 25;
