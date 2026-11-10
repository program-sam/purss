-- A private source has no feed address in the database (its link is in the secrets folder), so a second look at the
-- same link could not tell it was already followed. `feed_key` is a keyed hash (HMAC-SHA-256 with a key kept in the
-- secrets folder) of the normalised link: it finds the same link again without storing it, and can't be used to test
-- a guessed link by anyone who has only the database. Only private sources have one.
ALTER TABLE sources ADD COLUMN feed_key TEXT;
CREATE INDEX sources_feed_key ON sources(workspace_id, feed_key) WHERE feed_key IS NOT NULL;
