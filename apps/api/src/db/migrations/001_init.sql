-- Initial product schema. Every product row is scoped to an account and workspace.
-- Times are ISO-8601 UTC strings. IDs come from @purss/domain newId().

CREATE TABLE installation (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE role_grants (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('admin')),
  granted_at TEXT NOT NULL,
  granted_by TEXT,
  PRIMARY KEY (account_id, role)
) STRICT;

CREATE TABLE sign_in_methods (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('passkey', 'recovery', 'oidc')),
  label TEXT,
  credential_id TEXT UNIQUE,       -- passkey (base64url)
  public_key BLOB,                 -- passkey
  counter INTEGER,                 -- passkey
  transports TEXT,                 -- passkey JSON
  issuer TEXT,                     -- oidc
  subject TEXT,                    -- oidc
  secret_hash TEXT,                -- recovery code (scrypt)
  used_at TEXT,                    -- recovery code single use
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (issuer, subject)
) STRICT;
CREATE INDEX sign_in_methods_account ON sign_in_methods(account_id, kind);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,             -- sha256 of the cookie token
  account_id TEXT NOT NULL REFERENCES accounts(id),
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  auth_at TEXT NOT NULL,           -- last strong authentication, for step-up
  method TEXT NOT NULL,
  user_agent TEXT
) STRICT;
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  account_id TEXT,
  challenge TEXT NOT NULL,
  data TEXT,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE invites (
  id TEXT PRIMARY KEY,             -- sha256 of the invite code
  created_by TEXT NOT NULL REFERENCES accounts(id),
  note TEXT,
  allocation_bytes INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_account_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  detail TEXT
) STRICT;
CREATE INDEX audit_events_at ON audit_events(at);

-- Engine (FreshRSS) identities, scoped per account.
CREATE TABLE engine_users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  username TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'error')),
  engine_identity TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sync_checkpoints (
  engine_user_id TEXT PRIMARY KEY REFERENCES engine_users(id),
  engine_identity TEXT,
  continuation TEXT,
  newest_crawl_usec TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT
) STRICT;

CREATE TABLE applied_batches (
  idempotency_key TEXT PRIMARY KEY,
  engine_user_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  result TEXT NOT NULL
) STRICT;

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('feed', 'youtube', 'podcast', 'publication', 'private', 'manual')),
  title TEXT NOT NULL,
  origin TEXT NOT NULL,
  site_url TEXT,
  feed_url TEXT,                   -- NULL when private (secret kept outside the database)
  is_private INTEGER NOT NULL DEFAULT 0,
  curator TEXT,
  hue INTEGER NOT NULL DEFAULT 210,
  followed INTEGER NOT NULL DEFAULT 1,   -- 0 after unfollow; kept items keep attribution
  paused INTEGER NOT NULL DEFAULT 0,
  notify TEXT NOT NULL DEFAULT 'default' CHECK (notify IN ('default', 'on', 'muted')),
  engine_stream_id TEXT,
  health TEXT NOT NULL DEFAULT 'pending',
  health_text TEXT,
  last_success_at TEXT,
  last_item_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, engine_stream_id)
) STRICT;
CREATE INDEX sources_workspace ON sources(workspace_id, followed);

CREATE TABLE items (
  seq INTEGER PRIMARY KEY,         -- FTS rowid
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_id TEXT REFERENCES sources(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  author TEXT,
  excerpt TEXT,
  image_url TEXT,
  duration_seconds INTEGER,
  read_minutes INTEGER,
  doi TEXT,
  curator_note TEXT,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  current_version_id TEXT,
  enclosures TEXT,                 -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX items_ws_time ON items(workspace_id, discovered_at DESC, id DESC);
CREATE INDEX items_ws_source ON items(workspace_id, source_id, discovered_at DESC);
CREATE INDEX items_ws_published ON items(workspace_id, published_at DESC, id DESC);

-- Immutable content versions. A kept item pins the version current at keep time.
CREATE TABLE item_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  url TEXT,
  summary_html TEXT,
  content_html TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX item_versions_item ON item_versions(item_id);

CREATE TABLE external_ids (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  engine_user_id TEXT NOT NULL REFERENCES engine_users(id),
  external_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  original_guid TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (engine_user_id, external_id)
) STRICT;
CREATE INDEX external_ids_item ON external_ids(item_id);

-- Permanently deleted engine entries are never re-imported.
CREATE TABLE item_tombstones (
  engine_user_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (engine_user_id, external_id)
) STRICT;

CREATE TABLE reconciliation_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  engine_user_id TEXT NOT NULL,
  entry TEXT NOT NULL,             -- JSON SyncEntry
  candidate_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'new', 'dismissed')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE item_state (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  workflow TEXT NOT NULL DEFAULT 'new' CHECK (workflow IN ('new', 'toread', 'inprogress', 'finished', 'ignored')),
  fresh INTEGER NOT NULL DEFAULT 1,
  progress REAL NOT NULL DEFAULT 0,
  opened_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX item_state_ws ON item_state(workspace_id, workflow, fresh);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  emoji TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('sources', 'manual', 'query')),
  view TEXT NOT NULL DEFAULT 'list',
  query TEXT,                      -- JSON QueryNode for query mode
  show_on_home INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE collection_sources (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY (collection_id, source_id)
) STRICT;

CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, item_id)
) STRICT;

CREATE TABLE saved_queries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE baskets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  capture_mode TEXT NOT NULL DEFAULT 'text' CHECK (capture_mode IN ('metadata', 'text')),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE basket_items (
  basket_id TEXT NOT NULL REFERENCES baskets(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version_id TEXT NOT NULL REFERENCES item_versions(id),
  kept_at TEXT NOT NULL,
  PRIMARY KEY (basket_id, item_id)
) STRICT;
CREATE INDEX basket_items_item ON basket_items(item_id);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL CHECK (kind IN ('fulltext')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  title TEXT,
  text TEXT,
  html TEXT,
  final_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX captures_item ON captures(item_id);

-- Logical storage ledger (plan/17).
CREATE TABLE storage_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  allocation_bytes INTEGER,        -- NULL = unallocated self-host account
  paused_reason TEXT
) STRICT;

CREATE TABLE stored_objects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('item_version', 'capture', 'record')),
  ref_id TEXT NOT NULL,            -- item_versions.id, captures.id, or a record key
  item_id TEXT,
  source_id TEXT,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL,
  released_at TEXT
) STRICT;
CREATE UNIQUE INDEX stored_objects_live ON stored_objects(kind, ref_id) WHERE released_at IS NULL;
CREATE INDEX stored_objects_account ON stored_objects(account_id, released_at);
CREATE INDEX stored_objects_item ON stored_objects(item_id);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  object_id TEXT,
  delta_bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  purpose TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  released_at TEXT
) STRICT;
CREATE INDEX reservations_open ON reservations(account_id, settled_at, released_at);

-- Durable jobs and outbox commands.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'done', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  run_after TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  result TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX jobs_ready ON jobs(status, run_after);

CREATE TABLE preferences (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  item_id TEXT,
  source_id TEXT,
  dedup_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE (workspace_id, dedup_key)
) STRICT;

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  basket_id TEXT NOT NULL,
  kept_at TEXT NOT NULL,
  for_date TEXT NOT NULL,          -- local date the reminder belongs to
  status TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown', 'hidden', 'snoozed')),
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, item_id, for_date)
) STRICT;

CREATE TABLE undo_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ops TEXT NOT NULL,               -- JSON list of inverse operations
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE discovery_results (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate TEXT NOT NULL,         -- JSON (feed URL kept server side)
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE confirm_tokens (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

-- Shareable collections: a separate, explicitly selected public projection.
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  curator_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE publication_items (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,  -- stable public GUID, not the internal item id
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT,
  source_title TEXT,
  published_at TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (publication_id, item_id)
) STRICT;

CREATE VIRTUAL TABLE items_fts USING fts5(
  title, excerpt, author, body,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
