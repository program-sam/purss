-- Browser-assisted capture (plan/32): readable text that the person's own browser extracted from
-- the page as they saw it, sent by the browser extension. Stored as a capture of kind 'browser',
-- next to the server-fetched 'fulltext' captures, and counted against storage like them.
-- SQLite can't alter a CHECK constraint, so the table is rebuilt with every column it has by now
-- (failure_notified_for, 019) and its indexes (019's too); nothing references captures (annotations
-- name a capture by id without a foreign key), so dropping the old table cascades nowhere.
CREATE TABLE captures_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL CHECK (kind IN ('fulltext', 'browser')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  title TEXT,
  text TEXT,
  html TEXT,
  final_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failure_notified_for TEXT
) STRICT;
INSERT INTO captures_new (id, workspace_id, item_id, kind, status, title, text, html, final_url, error, created_at, completed_at, failure_notified_for)
  SELECT id, workspace_id, item_id, kind, status, title, text, html, final_url, error, created_at, completed_at, failure_notified_for FROM captures;
DROP TABLE captures;
ALTER TABLE captures_new RENAME TO captures;
CREATE INDEX captures_item ON captures(item_id);
CREATE INDEX captures_pending ON captures(workspace_id) WHERE status = 'pending';
CREATE INDEX captures_completed ON captures(workspace_id, completed_at) WHERE completed_at IS NOT NULL;
-- At most one browser capture per item: capturing again replaces its text in place.
CREATE UNIQUE INDEX captures_browser_item ON captures(item_id) WHERE kind = 'browser';
