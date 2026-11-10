-- Assistant access (MCP): an installation switch (installation key 'assistant_access'), a
-- per-account switch, and personal access tokens. Only a token's SHA-256 is stored.
ALTER TABLE accounts ADD COLUMN assistant_access INTEGER NOT NULL DEFAULT 0 CHECK (assistant_access IN (0, 1));

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
CREATE INDEX assistant_tokens_account ON assistant_tokens(account_id);
