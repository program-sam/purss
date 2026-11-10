-- Connected apps (plan/24): the mobile app and the browser extension connect with an
-- authorization code + PKCE and then use a device token. Only SHA-256 hashes are stored.
CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mobile', 'extension')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL       -- coarse (hourly); the token stops working 90 days after this
) STRICT;
CREATE INDEX device_tokens_account ON device_tokens(account_id);

-- One-time codes from an approved connection, waiting to be exchanged. Deleted when used or expired.
CREATE TABLE connect_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mobile', 'extension')),
  redirect_uri TEXT,               -- NULL for a code the person types into the app
  code_challenge TEXT NOT NULL,    -- S256 of the app's code_verifier
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

-- Duplicate-aware keeping and lookup: the comparison key of items.url (services/url-key.ts).
-- purss_url_key is that same function, registered on every connection by the Database class.
ALTER TABLE items ADD COLUMN url_key TEXT;
UPDATE items SET url_key = purss_url_key(url) WHERE url IS NOT NULL;
CREATE INDEX items_ws_url_key ON items(workspace_id, url_key) WHERE url_key IS NOT NULL;
