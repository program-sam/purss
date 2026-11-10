-- Captured text honesty and pictures in kept copies (plan/34).
--
-- A readable-text capture is checked before it is called the full text. `quality` says what the check found:
-- 'full' passed, 'partial' is only part of the page (a sign-in or subscription wall, a list of references, less
-- than the feed already gave) and `partial_reason` says which. NULL: not checked (browser captures, which the
-- person's own browser made, and server captures from before the check, which are checked at start-up).
ALTER TABLE captures ADD COLUMN quality TEXT CHECK (quality IN ('full', 'partial'));
ALTER TABLE captures ADD COLUMN partial_reason TEXT CHECK (partial_reason IN ('gated', 'references', 'short'));
CREATE INDEX captures_unchecked ON captures(id) WHERE quality IS NULL AND kind = 'fulltext' AND status = 'done';
-- Whether the person asked for this copy (Keep in a basket that keeps text, "Keep readable text too" on a link, Try again)
-- as against a source's full-articles setting making it. A failed copy is told about only where text was asked for.
ALTER TABLE captures ADD COLUMN requested INTEGER NOT NULL DEFAULT 0 CHECK (requested IN (0, 1));

-- Pictures of an item kept in a basket that keeps readable text: the item's own picture and the pictures in its
-- text, fetched through the same address rules as every other fetch and stored here, one row per picture, counted
-- once in the account's storage (a 'image' stored object per row). `role` says where the picture was found.
-- The reader shows the stored copy when there is one and the original address when not.
CREATE TABLE item_images (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,               -- the address it was saved from, exactly as the item's text names it
  role TEXT NOT NULL CHECK (role IN ('cover', 'inline')),
  content_type TEXT NOT NULL,      -- from the bytes, never from the publisher's header
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX item_images_url ON item_images(item_id, url);
CREATE INDEX item_images_workspace ON item_images(workspace_id);

-- The ledger learns the 'image' kind. SQLite can't alter a CHECK constraint, so the table is rebuilt with every
-- column it has by now and its indexes as 026 left them; the two triggers 022 put on items write to it, so they
-- are dropped for the rebuild and created again exactly as 026 made them.
DROP TRIGGER items_current_version_changed;
DROP TRIGGER items_current_version_removed;
CREATE TABLE stored_objects_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('item_version', 'capture', 'record', 'media', 'image')),
  ref_id TEXT NOT NULL,            -- item_versions.id, captures.id, saved_media.id, item_images.id, or a record key
  item_id TEXT,
  source_id TEXT,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL,
  released_at TEXT,
  is_current INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO stored_objects_new (id, account_id, workspace_id, kind, ref_id, item_id, source_id, bytes, created_at, released_at, is_current)
  SELECT id, account_id, workspace_id, kind, ref_id, item_id, source_id, bytes, created_at, released_at, is_current FROM stored_objects;
DROP TABLE stored_objects;
ALTER TABLE stored_objects_new RENAME TO stored_objects;
CREATE UNIQUE INDEX stored_objects_live ON stored_objects(kind, ref_id) WHERE released_at IS NULL;
CREATE INDEX stored_objects_account ON stored_objects(account_id, released_at, kind, is_current, bytes);
CREATE INDEX stored_objects_item ON stored_objects(item_id);
CREATE TRIGGER items_current_version_changed AFTER UPDATE OF current_version_id ON items
BEGIN
  UPDATE stored_objects SET is_current = 0 WHERE kind = 'item_version' AND ref_id = OLD.current_version_id AND released_at IS NULL;
  UPDATE stored_objects SET is_current = 1 WHERE kind = 'item_version' AND ref_id = NEW.current_version_id AND released_at IS NULL;
END;
CREATE TRIGGER items_current_version_removed AFTER DELETE ON items
BEGIN
  UPDATE stored_objects SET is_current = 0 WHERE kind = 'item_version' AND ref_id = OLD.current_version_id AND released_at IS NULL;
END;
