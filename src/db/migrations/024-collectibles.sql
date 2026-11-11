-- v24: user-owned cosmetics, equipped profile/B50 appearance, and exact problem selection.
CREATE TABLE user_collectibles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collectible_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('achievement','title','avatar_frame','profile_background','info_frame','b50_theme')),
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK(rarity IN ('starter','white','bronze','silver','gold','rainbow')),
  description TEXT NOT NULL,
  source_json TEXT,
  unlocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(user_id, collectible_id)
);

CREATE TABLE user_profile_loadouts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL DEFAULT 'title:newcomer',
  avatar_frame_id TEXT NOT NULL DEFAULT 'avatar_frame:newcomer',
  profile_background_id TEXT NOT NULL DEFAULT 'profile_background:newcomer',
  info_frame_id TEXT NOT NULL DEFAULT 'info_frame:newcomer',
  b50_theme_id TEXT NOT NULL DEFAULT 'b50_theme:newcomer',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE dan_sessions ADD COLUMN selected_problem_id TEXT;
PRAGMA user_version = 24;
