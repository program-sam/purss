-- OAuth for assistants (plan/33): cloud assistants that only accept OAuth connect to /mcp. Only
-- SHA-256 hashes of codes and tokens are stored.

-- One-time codes now also carry OAuth approvals: kind 'oauth', the client's id (its metadata
-- document URL) and the approved access level. device_name becomes label (an app's device name, or
-- the OAuth client's name). Codes live five minutes; pending ones are copied over.
CREATE TABLE connect_codes_new (
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
INSERT INTO connect_codes_new (code_hash, account_id, kind, redirect_uri, code_challenge, label, created_at, expires_at)
  SELECT code_hash, account_id, kind, redirect_uri, code_challenge, device_name, created_at, expires_at FROM connect_codes;
DROP TABLE connect_codes;
ALTER TABLE connect_codes_new RENAME TO connect_codes;

-- Grants and tokens. A grant keeps just its current refresh token and that token's generation;
-- earlier refresh tokens are recognised by their signature (oauth/grants.ts), so a grant's storage
-- stays the same however long it keeps renewing.

-- An assistant the person approved. Ends when revoked, when its refresh token goes unused past
-- expires_at, or when a used code or an earlier refresh token is presented again.
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
CREATE INDEX oauth_grants_account ON oauth_grants(account_id);

-- Access tokens, an hour each; deleted once expired.
CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX oauth_access_tokens_grant ON oauth_access_tokens(grant_id);

-- Refreshes of the last hour, so the hourly limits per grant and per account hold across processes
-- and restarts. Recorded in the refresh's own transaction; older rows are purged.
CREATE TABLE oauth_refreshes (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,          -- not a foreign key: a revoked grant's refreshes still count for its account
  at TEXT NOT NULL
) STRICT;
CREATE INDEX oauth_refreshes_grant ON oauth_refreshes(grant_id, at);
CREATE INDEX oauth_refreshes_account ON oauth_refreshes(account_id, at);
