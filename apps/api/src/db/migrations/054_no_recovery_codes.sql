-- Single-use recovery codes are gone, and so is what only they needed: the "setup permission" that let a new account add its
-- first way to sign in, and the record of whether its codes were saved.
DELETE FROM sign_in_methods WHERE kind = 'recovery';

-- SQLite can't alter a CHECK constraint or drop a column that has one, so the table is rebuilt without the 'recovery' kind
-- and its single-use mark.
CREATE TABLE sign_in_methods_new (
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
INSERT INTO sign_in_methods_new (id, account_id, kind, label, credential_id, public_key, counter, transports, issuer, subject, secret_hash, created_at, last_used_at)
  SELECT id, account_id, kind, label, credential_id, public_key, counter, transports, issuer, subject, secret_hash, created_at, last_used_at FROM sign_in_methods;
DROP TABLE sign_in_methods;
ALTER TABLE sign_in_methods_new RENAME TO sign_in_methods;
CREATE INDEX sign_in_methods_account ON sign_in_methods(account_id, kind);
-- One password per account, and usernames are unique across the installation.
CREATE UNIQUE INDEX sign_in_methods_password_account ON sign_in_methods(account_id) WHERE kind = 'password';
CREATE UNIQUE INDEX sign_in_methods_username ON sign_in_methods(label) WHERE kind = 'password';

DROP TABLE account_enrollment;
ALTER TABLE sessions DROP COLUMN setup_permission_expires_at;
ALTER TABLE sessions DROP COLUMN setup_permission_used_at;
DROP TABLE signup_attempts;
