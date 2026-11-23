-- The PURSS product database. Every product row belongs to one account.
-- Times are ISO-8601 UTC strings. IDs come from @purss/domain newId().

CREATE TABLE installation (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  assistant_access INTEGER NOT NULL DEFAULT 0 CHECK (assistant_access IN (0, 1)),
  email TEXT,
  email_verified_at TEXT,
  plan TEXT CHECK (plan IN ('free', 'plus', 'pro', 'unlimited')),
  last_visit_at TEXT,
  visit_started_at TEXT,
  last_activity_at TEXT,
  next_item_number INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE role_grants (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('admin')),
  granted_at TEXT NOT NULL,
  granted_by TEXT,
  PRIMARY KEY (account_id, role)
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,             -- sha256 of the cookie token
  account_id TEXT NOT NULL REFERENCES accounts(id),
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  auth_at TEXT NOT NULL,           -- last strong authentication, for step-up
  method TEXT NOT NULL,
  user_agent TEXT,
  session_class TEXT NOT NULL DEFAULT 'persistent'
  CHECK (session_class IN ('persistent', 'shared'))) STRICT;

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
  used_by TEXT,
  email TEXT,
  emailed_at TEXT
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

CREATE TABLE engine_users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
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
  last_error TEXT,
  pending_engine_identity TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_walk_done_at TEXT
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
  created_at TEXT NOT NULL, icon_checked_at TEXT, full_text INTEGER NOT NULL DEFAULT 0 CHECK (full_text IN (0, 1)), paused_until TEXT, backlog_settled_at TEXT, subscribed_at TEXT, problem_notified_for TEXT, problem_notified_at TEXT, feed_key TEXT, builtin TEXT CHECK (builtin IN ('news')), start_from TEXT NOT NULL DEFAULT 'all' CHECK (start_from IN ('all', 'now', 'week')), via_gateway INTEGER NOT NULL DEFAULT 0 CHECK (via_gateway IN (0, 1)), health_reason TEXT, discovery_route TEXT, discovery_entry TEXT, unfollowed_at TEXT,
  UNIQUE (account_id, engine_stream_id)
) STRICT;

CREATE TABLE items (
  seq INTEGER PRIMARY KEY,         -- FTS rowid
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
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
  updated_at TEXT NOT NULL,
  url_key TEXT,
  link_key TEXT,
  kept_key TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  number INTEGER,
  embed_tries INTEGER NOT NULL DEFAULT 0,
  embed_at TEXT,
  listed_at TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE TABLE item_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  url TEXT,
  summary_html TEXT,
  content_html TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_omitted INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE external_ids (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  engine_user_id TEXT NOT NULL REFERENCES engine_users(id),
  external_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  original_guid TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (engine_user_id, external_id)
) STRICT;

CREATE TABLE item_tombstones (
  engine_user_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (engine_user_id, external_id)
) STRICT;

CREATE TABLE reconciliation_queue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  engine_user_id TEXT NOT NULL,
  entry TEXT NOT NULL,             -- JSON SyncEntry
  candidate_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'new', 'dismissed')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE item_state (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workflow TEXT NOT NULL DEFAULT 'undecided' CHECK (workflow IN ('undecided', 'toread', 'inprogress', 'finished', 'ignored')),
  is_new INTEGER NOT NULL DEFAULT 1,
  progress REAL NOT NULL DEFAULT 0,
  opened_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0),
  playback_workflow_session TEXT,
  source_id TEXT
) STRICT;

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  emoji TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('sources', 'filter')),
  view TEXT NOT NULL DEFAULT 'list',
  query TEXT,                      -- JSON QueryNode for filter mode
  show_on_home INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE collection_sources (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY (collection_id, source_id)
) STRICT;

CREATE TABLE baskets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  capture_mode TEXT NOT NULL DEFAULT 'text' CHECK (capture_mode IN ('metadata', 'text')),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  view TEXT NOT NULL DEFAULT 'list' CHECK (view IN ('list', 'cards', 'timeline'))
) STRICT;

CREATE TABLE basket_items (
  basket_id TEXT NOT NULL REFERENCES baskets(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  version_id TEXT NOT NULL REFERENCES item_versions(id),
  kept_at TEXT NOT NULL,
  PRIMARY KEY (basket_id, item_id)
) STRICT;

CREATE TABLE storage_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  allocation_bytes INTEGER,        -- NULL = unallocated self-host account
  paused_reason TEXT,
  used_bytes INTEGER NOT NULL DEFAULT 0
) STRICT;

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

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT,
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

CREATE TABLE preferences (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  item_id TEXT,
  source_id TEXT,
  dedup_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT, data TEXT, changed_at TEXT,
  UNIQUE (account_id, dedup_key)
) STRICT;

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  basket_id TEXT NOT NULL,
  kept_at TEXT NOT NULL,
  for_date TEXT NOT NULL,          -- local date the reminder belongs to
  status TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown', 'hidden', 'snoozed')),
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, item_id, for_date)
) STRICT;

CREATE TABLE undo_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  ops TEXT NOT NULL,               -- JSON list of inverse operations
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE confirm_tokens (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE items_fts USING fts5(
  title, excerpt, author, body,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE import_stages (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,           -- JSON ImportPreview, shown again if the preview is reopened
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE state_log (
  seq INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  from_state TEXT NOT NULL CHECK (from_state IN ('undecided', 'toread', 'inprogress', 'finished', 'ignored')),
  to_state TEXT NOT NULL CHECK (to_state IN ('undecided', 'toread', 'inprogress', 'finished', 'ignored')),
  at TEXT NOT NULL
) STRICT;

CREATE TABLE source_icons (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  bytes BLOB NOT NULL,
  digest TEXT NOT NULL,            -- sha256 hex of bytes; versions the icon address
  found_url TEXT NOT NULL,         -- address the original image came from
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE assistant_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT,                 -- NULL = no expiry
  last_used_at TEXT
) STRICT;

CREATE TABLE account_deletions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  request_id TEXT NOT NULL UNIQUE,          -- one per request; sign-in cancel tokens bind to it
  requested_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'purging')),
  phase1_done INTEGER NOT NULL DEFAULT 0 CHECK (phase1_done IN (0, 1)),
  files TEXT,                               -- JSON list of data-directory files to remove, set when purging starts
  engine_attempted_at TEXT,                 -- set before the first engine delete-user call
  engine_removed_at TEXT,                   -- the engine user is confirmed gone (by the worker or an administrator)
  engine_review_at TEXT                     -- gone after an unconfirmed attempt: an administrator has to confirm
) STRICT;

CREATE TABLE notification_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  window_end TEXT NOT NULL
) STRICT;

CREATE TABLE search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,   -- items.seq up to which this rebuild has been done
  target INTEGER NOT NULL DEFAULT 0,
  annotation_cursor INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE signup_creations (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  address_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mobile', 'extension')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,       -- coarse (hourly); the token stops working 90 days after this
  auth_at TEXT,
  auth_method TEXT NOT NULL DEFAULT 'connect'
) STRICT;

CREATE TABLE playback_positions (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  position_seconds REAL NOT NULL CHECK (position_seconds >= 0),
  duration_seconds REAL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE annotations (
  seq INTEGER PRIMARY KEY,         -- annotations_fts rowid
  id TEXT NOT NULL UNIQUE,         -- ann_<26>, chosen by the client
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL CHECK (kind IN ('highlight', 'note')),
  -- Text-quote selector over the reader's whitespace-collapsed text, plus a position hint.
  quote_exact TEXT,
  quote_prefix TEXT,
  quote_suffix TEXT,
  pos_start INTEGER,
  pos_end INTEGER,
  -- The text the highlight was made on: a readable-text capture or an item version. Not a
  -- reference that keeps it: the quote above is what survives when that text is released.
  target_kind TEXT CHECK (target_kind IN ('capture', 'version')),
  target_id TEXT,
  body TEXT,                       -- the person's comment (highlight) or note text
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT, received_at TEXT NOT NULL DEFAULT '',
  CHECK (deleted_at IS NOT NULL OR kind = 'note' OR quote_exact IS NOT NULL),
  CHECK (deleted_at IS NOT NULL OR kind = 'highlight' OR body IS NOT NULL)
) STRICT;

CREATE VIRTUAL TABLE annotations_fts USING fts5(
  quote, body,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE email_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE TABLE mail_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  error TEXT
) STRICT;

CREATE TABLE "connect_codes" (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mobile', 'extension', 'oauth')),
  client_id TEXT,                  -- OAuth only
  redirect_uri TEXT,               -- NULL for a code the person types into the app
  code_challenge TEXT NOT NULL,    -- S256 of the client's code_verifier
  label TEXT NOT NULL,
  scope TEXT,                      -- OAuth only: 'read' or 'write'
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK ((kind = 'oauth') = (client_id IS NOT NULL)),
  CHECK (kind <> 'oauth' OR (scope IN ('read', 'write') AND redirect_uri IS NOT NULL))
) STRICT;

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  resource TEXT NOT NULL,          -- the /mcp address the tokens are for (RFC 8707)
  code_hash TEXT NOT NULL UNIQUE,  -- the code it came from
  refresh_hash TEXT NOT NULL,      -- the current refresh token
  refresh_generation INTEGER NOT NULL CHECK (refresh_generation >= 0), -- 0 from the code, one more per refresh
  refresh_key_id TEXT NOT NULL,    -- which refresh key signs its tokens (secrets/oauth-refresh-key)
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,      -- coarse (per minute)
  expires_at TEXT NOT NULL         -- moves with every refresh
) STRICT;

CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE oauth_refreshes (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,          -- not a foreign key: a revoked grant's refreshes still count for its account
  at TEXT NOT NULL
) STRICT;

CREATE TABLE "captures" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
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
  failure_notified_for TEXT,
  quality TEXT CHECK (quality IN ('full', 'partial')),
  partial_reason TEXT CHECK (partial_reason IN ('gated', 'references', 'short')),
  requested INTEGER NOT NULL DEFAULT 0 CHECK (requested IN (0, 1))
) STRICT;

CREATE TABLE mail_queue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL
) STRICT;

CREATE TABLE item_images (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  url TEXT NOT NULL,               -- the address it was saved from, exactly as the item's text names it
  role TEXT NOT NULL CHECK (role IN ('cover', 'inline')),
  content_type TEXT NOT NULL,      -- from the bytes, never from the publisher's header
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE "stored_objects" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('item_version', 'capture', 'record', 'media', 'image')),
  ref_id TEXT NOT NULL,            -- item_versions.id, captures.id, saved_media.id, item_images.id, or a record key
  item_id TEXT,
  source_id TEXT,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL,
  released_at TEXT) STRICT;

CREATE TABLE opml_imports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  -- Where the sources go: none, a collection per folder of the file, one existing collection, or one new one.
  destination TEXT NOT NULL CHECK (destination IN ('none', 'folders', 'collection', 'new')),
  collection_id TEXT,
  collection_name TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'stopped')),
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

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

CREATE TABLE item_reminders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  remind_on TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  UNIQUE (account_id, item_id)
) STRICT;

CREATE TABLE discovery_sources (
  key TEXT PRIMARY KEY,            -- urlKey() of the feed address
  feed_url TEXT NOT NULL,
  title TEXT NOT NULL,
  host TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('feed', 'youtube', 'podcast')),
  followers INTEGER NOT NULL       -- never sent to a browser; suggestions show no counts
) STRICT;

CREATE TABLE discovery_pairs (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  together INTEGER NOT NULL,
  PRIMARY KEY (a, b)
) STRICT, WITHOUT ROWID;

CREATE TABLE discovery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  built_at TEXT,
  dirty INTEGER NOT NULL DEFAULT 0  -- someone stopped (or started) sharing: rebuild soon instead of at the next interval
) STRICT;

CREATE TABLE discovery_dismissed (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE ai_filters (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
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

CREATE TABLE ai_filter_verdicts (
  filter_id TEXT NOT NULL REFERENCES ai_filters(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  version INTEGER NOT NULL,
  keep_probability REAL NOT NULL,
  dropped INTEGER NOT NULL,
  applied_revision INTEGER,
  judged_at TEXT NOT NULL,
  PRIMARY KEY (filter_id, item_id)
) STRICT;

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('basket', 'collection')),
  target_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  curator_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused')),
  listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1)),
  taken_down_at TEXT,
  takedown_reason TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (target_kind, target_id)
) STRICT;

CREATE TABLE share_notes (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (share_id, item_id)
) STRICT;

CREATE TABLE share_reports (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('copyright', 'illegal', 'spam', 'harassment', 'privacy', 'other')),
  details TEXT NOT NULL,
  contact TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('taken_down', 'dismissed')),
  resolved_by TEXT
) STRICT;

CREATE TABLE push_devices (
  device_id TEXT PRIMARY KEY REFERENCES device_tokens(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  relay TEXT NOT NULL,             -- the relay the handle belongs to; pushes go only while it is the configured one
  handle TEXT NOT NULL,            -- opaque relay handle (rh_…); wakes the phone, carries nothing
  fetch_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the fetch credential (purss_push_…)
  shown_until TEXT NOT NULL,       -- notifications changed up to this moment have been handed to the phone
  created_at TEXT NOT NULL,
  pushed_at TEXT                   -- last time the relay was asked to wake the phone
) STRICT;

CREATE TABLE news_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,              -- as the administrator wrote it: paragraphs, "- " lists, [links](https://…), **bold**
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  author_account_id TEXT REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
) STRICT;

CREATE TABLE news_deliveries (
  post_id TEXT NOT NULL REFERENCES news_posts(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  item_id TEXT,                    -- the account's copy; it may since have been deleted
  delivered_at TEXT NOT NULL,
  revised_at TEXT NOT NULL DEFAULT '',   -- the post's updated_at the copy carries; an older one is brought up to date
  PRIMARY KEY (post_id, account_id)
) STRICT;

CREATE TABLE discovery_misses (
  day TEXT NOT NULL,       -- UTC date, YYYY-MM-DD
  site TEXT NOT NULL,
  reason TEXT NOT NULL,    -- the discovery failure: nofeed, unsupported, unreachable or timeout
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (day, site, reason)
) STRICT;

CREATE TABLE ai_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  week TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, week)
) STRICT;

CREATE TABLE "sign_in_methods" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('passkey', 'oidc', 'password')),
  label TEXT,                      -- passkey name, or password username
  credential_id TEXT UNIQUE,       -- passkey (base64url)
  public_key BLOB,                 -- passkey
  counter INTEGER,                 -- passkey
  transports TEXT,                 -- passkey JSON
  issuer TEXT,                     -- oidc
  subject TEXT,                    -- oidc
  secret_hash TEXT,                -- password (scrypt)
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (issuer, subject)
) STRICT;

CREATE TABLE signup_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE TABLE discovery_routes (
  day TEXT NOT NULL,       -- UTC date, YYYY-MM-DD
  entry TEXT NOT NULL,     -- how the person got to the lookup: paste, site-search, podcast-search, …
  route TEXT NOT NULL,     -- which way discovery found the candidate: alternate-link, known:github, page-list, …
  offered INTEGER NOT NULL DEFAULT 0 CHECK (offered >= 0),
  followed INTEGER NOT NULL DEFAULT 0 CHECK (followed >= 0),
  PRIMARY KEY (day, entry, route)
) STRICT;

CREATE INDEX sessions_account ON sessions(account_id);

CREATE INDEX audit_events_at ON audit_events(at);

CREATE INDEX sources_account ON sources(account_id, followed);

CREATE INDEX items_account_time ON items(account_id, discovered_at DESC, id DESC);

CREATE INDEX items_account_source ON items(account_id, source_id, discovered_at DESC);

CREATE INDEX items_account_published ON items(account_id, published_at DESC, id DESC);

CREATE INDEX item_versions_item ON item_versions(item_id);

CREATE INDEX external_ids_item ON external_ids(item_id);

CREATE INDEX item_state_account ON item_state(account_id, workflow, is_new);

CREATE INDEX basket_items_item ON basket_items(item_id);

CREATE INDEX jobs_ready ON jobs(status, run_after);

CREATE INDEX import_stages_account ON import_stages(account_id);

CREATE INDEX basket_items_kept ON basket_items(account_id, kept_at);

CREATE INDEX reminders_account_date ON reminders(account_id, for_date);

CREATE INDEX reconciliation_queue_open ON reconciliation_queue(account_id, status, created_at);

CREATE INDEX jobs_status_updated ON jobs(status, updated_at);

CREATE INDEX state_log_item ON state_log(item_id, at);

CREATE INDEX state_log_account ON state_log(account_id, at);

CREATE INDEX assistant_tokens_account ON assistant_tokens(account_id);

CREATE INDEX items_current_version ON items(current_version_id);

CREATE INDEX basket_items_version ON basket_items(version_id);

CREATE INDEX items_source_url ON items(source_id, url, id);

CREATE INDEX item_state_item ON item_state(item_id, workflow, is_new);

CREATE INDEX collection_sources_source ON collection_sources(source_id);

CREATE INDEX sources_paused_until ON sources(paused_until) WHERE paused = 1 AND paused_until IS NOT NULL;

CREATE INDEX notifications_account ON notifications(account_id, created_at);

CREATE INDEX notifications_source ON notifications(source_id) WHERE source_id IS NOT NULL;

CREATE INDEX item_state_new ON item_state(account_id) WHERE is_new = 1;

CREATE INDEX item_state_opened ON item_state(account_id, opened_at DESC) WHERE opened_at IS NOT NULL;

CREATE INDEX signup_creations_address_time ON signup_creations(address_hash, created_at);

CREATE INDEX items_account_title ON items(account_id, lower(title), id);

CREATE INDEX device_tokens_account ON device_tokens(account_id);

CREATE INDEX items_account_url_key ON items(account_id, url_key) WHERE url_key IS NOT NULL;

CREATE INDEX annotations_item ON annotations(item_id, updated_at);

CREATE INDEX annotations_account ON annotations(account_id, updated_at);

CREATE INDEX email_tokens_account ON email_tokens(account_id, purpose);

CREATE INDEX mail_log_at ON mail_log(at);

CREATE INDEX oauth_grants_account ON oauth_grants(account_id);

CREATE INDEX oauth_access_tokens_grant ON oauth_access_tokens(grant_id);

CREATE INDEX oauth_refreshes_grant ON oauth_refreshes(grant_id, at);

CREATE INDEX oauth_refreshes_account ON oauth_refreshes(account_id, at);

CREATE INDEX captures_item ON captures(item_id);

CREATE INDEX captures_pending ON captures(account_id) WHERE status = 'pending';

CREATE INDEX captures_completed ON captures(account_id, completed_at) WHERE completed_at IS NOT NULL;

CREATE UNIQUE INDEX captures_browser_item ON captures(item_id) WHERE kind = 'browser';

CREATE INDEX annotations_tombstones ON annotations(received_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX mail_queue_due ON mail_queue(next_attempt_at);

CREATE INDEX captures_unchecked ON captures(id) WHERE quality IS NULL AND kind = 'fulltext' AND status = 'done';

CREATE UNIQUE INDEX item_images_url ON item_images(item_id, url);

CREATE INDEX item_images_account ON item_images(account_id);

CREATE UNIQUE INDEX stored_objects_live ON stored_objects(kind, ref_id) WHERE released_at IS NULL;

CREATE INDEX stored_objects_item ON stored_objects(item_id);

CREATE INDEX opml_imports_account ON opml_imports(account_id, created_at DESC);

CREATE INDEX item_reminders_day ON item_reminders(account_id, remind_on);

CREATE INDEX sources_feed_key ON sources(account_id, feed_key) WHERE feed_key IS NOT NULL;

CREATE INDEX ai_filters_account ON ai_filters(account_id);

CREATE INDEX ai_filter_verdicts_item ON ai_filter_verdicts(item_id);

CREATE INDEX ai_filter_verdicts_account ON ai_filter_verdicts(account_id);

CREATE INDEX shares_account ON shares(account_id);

CREATE INDEX share_notes_item ON share_notes(item_id);

CREATE INDEX share_reports_share ON share_reports(share_id, resolved_at);

CREATE INDEX push_devices_account ON push_devices(account_id);

CREATE INDEX news_posts_published ON news_posts(status, published_at DESC);

CREATE UNIQUE INDEX sources_builtin ON sources(account_id, builtin) WHERE builtin IS NOT NULL;

CREATE INDEX news_deliveries_account ON news_deliveries(account_id);

CREATE INDEX sign_in_methods_account ON sign_in_methods(account_id, kind);

CREATE UNIQUE INDEX sign_in_methods_password_account ON sign_in_methods(account_id) WHERE kind = 'password';

CREATE UNIQUE INDEX accounts_email ON accounts(lower(email)) WHERE email IS NOT NULL;

CREATE INDEX signup_requests_expiry ON signup_requests(expires_at);

CREATE INDEX external_ids_guid ON external_ids(account_id, original_guid);

CREATE INDEX items_account_source_url ON items(account_id, source_id, url);

CREATE INDEX items_account_source_untitled_link ON items(account_id, source_id, title, (COALESCE(published_at, ''))) WHERE url IS NULL;

CREATE INDEX items_account_source_link_key ON items(account_id, source_id, link_key, discovered_at) WHERE link_key IS NOT NULL;

CREATE INDEX items_source_title_published ON items(source_id, title, published_at);

CREATE INDEX items_account_kept ON items(account_id, kept_key, id);

CREATE INDEX reservations_open ON reservations(account_id, settled_at, released_at, expires_at, bytes);

CREATE INDEX items_account ON items(account_id);

CREATE UNIQUE INDEX items_account_number ON items(account_id, number);

CREATE INDEX items_embed_todo ON items(discovered_at) WHERE kind = 'post' AND image_url IS NULL AND embed_tries < 3;

CREATE INDEX item_state_rare ON item_state(account_id, workflow, is_new, source_id) WHERE NOT (workflow = 'undecided' AND is_new = 0);

CREATE INDEX items_account_sortkey ON items(account_id, listed_at DESC, id DESC);

CREATE INDEX items_source_sortkey ON items(account_id, source_id, listed_at DESC, id DESC);

CREATE INDEX items_account_source_title ON items(account_id, (source_title || char(1) || listed_at), id);

CREATE INDEX stored_objects_account ON stored_objects(account_id, released_at, kind, bytes);

CREATE TRIGGER sources_title_changed AFTER UPDATE OF title ON sources
WHEN NEW.title IS NOT OLD.title
BEGIN
  UPDATE items SET source_title = NEW.title WHERE source_id = NEW.id;
END;

CREATE TRIGGER items_source_title_moved AFTER UPDATE OF source_id ON items
BEGIN
  UPDATE items SET source_title = COALESCE((SELECT title FROM sources WHERE id = NEW.source_id), '') WHERE seq = NEW.seq;
END;

CREATE TRIGGER items_number_given AFTER INSERT ON items
WHEN NEW.number IS NULL
BEGIN
  UPDATE accounts SET next_item_number = next_item_number + 1 WHERE id = NEW.account_id;
  UPDATE items SET number = (SELECT next_item_number - 1 FROM accounts WHERE id = NEW.account_id) WHERE seq = NEW.seq;
END;

CREATE TRIGGER items_number_kept AFTER INSERT ON items
WHEN NEW.number IS NOT NULL
BEGIN
  UPDATE accounts SET next_item_number = MAX(next_item_number, NEW.number + 1) WHERE id = NEW.account_id;
END;

INSERT INTO search_index_state (id, version, cursor) VALUES (1, 0, 0);

INSERT INTO discovery_state (id) VALUES (1);
