-- The account's own workflow changes, one row per change (item, from, to, when), so that
-- statistics can be built from history that accumulates from here on. Nothing before this
-- migration is reconstructed. Rows are written in the transaction that changes the workflow,
-- go with their item when it is deleted, and travel in the JSON export.
CREATE TABLE state_log (
  seq INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  from_state TEXT NOT NULL CHECK (from_state IN ('new', 'toread', 'inprogress', 'finished', 'ignored')),
  to_state TEXT NOT NULL CHECK (to_state IN ('new', 'toread', 'inprogress', 'finished', 'ignored')),
  at TEXT NOT NULL
) STRICT;
-- Per-source and per-collection questions join the log to the items in scope, so the log is
-- reachable both from an item and from a time window.
CREATE INDEX state_log_item ON state_log(item_id, at);
CREATE INDEX state_log_workspace ON state_log(workspace_id, at);
