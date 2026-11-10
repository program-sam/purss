-- AI filters (plan/36, packages/domain/src/ai-filters.ts). A filter belongs to one source or one collection and says, in the
-- person's words, which posts to keep. `version` goes up when the words change, so an answer to an older version is not used.
CREATE TABLE ai_filters (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_id TEXT UNIQUE REFERENCES sources(id),
  collection_id TEXT UNIQUE REFERENCES collections(id),
  keep_text TEXT NOT NULL,
  drop_text TEXT,
  when_unsure TEXT NOT NULL DEFAULT 'keep' CHECK (when_unsure IN ('keep', 'drop')),
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((source_id IS NULL) <> (collection_id IS NULL))
) STRICT;
CREATE INDEX ai_filters_workspace ON ai_filters(workspace_id);

-- One answer per filter and post. `applied_revision`, the same on all of a post's answers, is the post's state revision right
-- after a filter last changed its workflow (NULL when none has). While the revision is still that (or 0 when no filter changed
-- it), nobody else has touched the post, and a filter may change it again; the person's own change is their last word on it.
CREATE TABLE ai_filter_verdicts (
  filter_id TEXT NOT NULL REFERENCES ai_filters(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL,
  keep_probability REAL NOT NULL,
  dropped INTEGER NOT NULL,
  applied_revision INTEGER,
  judged_at TEXT NOT NULL,
  PRIMARY KEY (filter_id, item_id)
) STRICT;
CREATE INDEX ai_filter_verdicts_item ON ai_filter_verdicts(item_id);
CREATE INDEX ai_filter_verdicts_workspace ON ai_filter_verdicts(workspace_id);

-- Jev input tokens used, per account, calendar month (UTC) and key: the person's own ('own') or the server's ('server', which on
-- hosted installs is the AI add-on's).
CREATE TABLE ai_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  month TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('own', 'server')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month, route)
) STRICT;

-- Hosted installs: the AI add-on, granted by an administrator. Keys (the person's own, the server's) live in the secrets folder,
-- not here; `ai_key_rejected` remembers that Jev refused the person's key, until a new one is added.
ALTER TABLE accounts ADD COLUMN ai_addon INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN ai_key_rejected INTEGER NOT NULL DEFAULT 0;
