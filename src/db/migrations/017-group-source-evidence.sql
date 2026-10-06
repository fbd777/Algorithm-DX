ALTER TABLE cf_group_rating_sources ADD COLUMN source_title TEXT;
ALTER TABLE cf_group_rating_sources ADD COLUMN source_released_at INTEGER;
ALTER TABLE cf_group_rating_sources ADD COLUMN source_tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cf_group_rating_sources ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cf_group_rating_sources ADD COLUMN candidates_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cf_group_rating_sources ADD COLUMN check_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE cf_group_rating_sources ADD COLUMN last_error TEXT;
-- A title alone identifies a candidate, not a verified copy. The next Group sync
-- verifies these rows before using their inferred rating again.
PRAGMA user_version = 17;
