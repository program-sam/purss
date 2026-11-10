-- Saved media (plan/25): a server copy of a publisher's audio or video file (an RSS enclosure),
-- stored as a file under <data>/media/<account_id>/<id> and counted once against the account's
-- storage as a 'media' stored object. One copy per item. Playback positions are kept per item,
-- separate from reading progress, workflow and basket membership.

CREATE TABLE saved_media (
  id TEXT PRIMARY KEY,             -- also the file name; a new save gets a new id
  item_id TEXT NOT NULL UNIQUE REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,               -- the publisher's file that was asked for
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'source')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  content_type TEXT,
  bytes INTEGER,
  sha256 TEXT,
  error TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX saved_media_account ON saved_media(account_id, status);

CREATE TABLE playback_positions (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  position_seconds REAL NOT NULL CHECK (position_seconds >= 0),
  duration_seconds REAL,
  updated_at TEXT NOT NULL
) STRICT;

-- Per-source automatic saving: 'new' saves each episode published after save_media_since.
ALTER TABLE sources ADD COLUMN save_media TEXT NOT NULL DEFAULT 'off' CHECK (save_media IN ('off', 'new'));
ALTER TABLE sources ADD COLUMN save_media_since TEXT;

-- The ledger learns the 'media' kind. SQLite can't alter a CHECK constraint, so the table is
-- rebuilt with every column it has by now (is_current, 022) and its indexes as 022 left them.
-- Nothing references stored_objects by foreign key; the two triggers 022 put on items write to it,
-- so they are dropped for the rebuild and created again exactly as 022 made them.
DROP TRIGGER items_current_version_changed;
DROP TRIGGER items_current_version_removed;
CREATE TABLE stored_objects_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('item_version', 'capture', 'record', 'media')),
  ref_id TEXT NOT NULL,            -- item_versions.id, captures.id, saved_media.id, or a record key
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
