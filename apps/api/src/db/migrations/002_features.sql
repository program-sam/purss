-- Feature tables and indexes added after the core schema: staged imports and the
-- indexes that rediscovery, reconciliation review, sharing and the admin job list use.

-- A verified export archive waiting for the owner to confirm the import. The archive itself
-- lives in <data>/staging/import-<token>.json (not in the database, not in the account quota).
CREATE TABLE import_stages (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,           -- JSON ImportPreview, shown again if the preview is reopened
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX import_stages_workspace ON import_stages(workspace_id);

CREATE INDEX basket_items_kept ON basket_items(workspace_id, kept_at);
CREATE INDEX reminders_workspace_date ON reminders(workspace_id, for_date);
CREATE INDEX reconciliation_queue_open ON reconciliation_queue(workspace_id, status, created_at);
CREATE INDEX publications_workspace ON publications(workspace_id);
CREATE INDEX publication_items_item ON publication_items(item_id);
CREATE INDEX jobs_status_updated ON jobs(status, updated_at);
