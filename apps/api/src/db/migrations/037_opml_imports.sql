-- A list of feeds (OPML) being followed on the server (plan/34), so closing the tab doesn't stop it and the
-- progress is there when the person comes back. One row per import, one per feed in it. A feed whose link
-- carries a secret has no address here: it waits in the secrets folder until it has been followed.
CREATE TABLE opml_imports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  -- Where the sources go: none, a collection per folder of the file, one existing collection, or one new one.
  destination TEXT NOT NULL CHECK (destination IN ('none', 'folders', 'collection', 'new')),
  collection_id TEXT,
  collection_name TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'stopped')),
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX opml_imports_account ON opml_imports(account_id, created_at DESC);

CREATE TABLE opml_import_entries (
  import_id TEXT NOT NULL REFERENCES opml_imports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  host TEXT NOT NULL,
  feed_url TEXT,
  folder TEXT,
  looks_private INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'working', 'followed', 'already', 'failed')),
  message TEXT,
  source_id TEXT,
  PRIMARY KEY (import_id, position)
) STRICT;
