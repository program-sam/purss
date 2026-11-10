-- Password sign-in: a 'password' method holds the account's username (label, lower case)
-- and an scrypt hash. SQLite can't alter a CHECK constraint, so the table is rebuilt.
CREATE TABLE sign_in_methods_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('passkey', 'recovery', 'oidc', 'password')),
  label TEXT,                      -- passkey name, recovery tag, or password username
  credential_id TEXT UNIQUE,       -- passkey (base64url)
  public_key BLOB,                 -- passkey
  counter INTEGER,                 -- passkey
  transports TEXT,                 -- passkey JSON
  issuer TEXT,                     -- oidc
  subject TEXT,                    -- oidc
  secret_hash TEXT,                -- recovery code or password (scrypt)
  used_at TEXT,                    -- recovery code single use
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (issuer, subject)
) STRICT;
INSERT INTO sign_in_methods_new SELECT id, account_id, kind, label, credential_id, public_key, counter, transports, issuer, subject, secret_hash, used_at, created_at, last_used_at FROM sign_in_methods;
DROP TABLE sign_in_methods;
ALTER TABLE sign_in_methods_new RENAME TO sign_in_methods;
CREATE INDEX sign_in_methods_account ON sign_in_methods(account_id, kind);
-- One password per account, and usernames are unique across the installation.
CREATE UNIQUE INDEX sign_in_methods_password_account ON sign_in_methods(account_id) WHERE kind = 'password';
CREATE UNIQUE INDEX sign_in_methods_username ON sign_in_methods(label) WHERE kind = 'password';
