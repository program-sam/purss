-- Sign-in enrollment, bounded setup permission, shared-computer sessions, and signup capacity.

ALTER TABLE sessions ADD COLUMN session_class TEXT NOT NULL DEFAULT 'persistent'
  CHECK (session_class IN ('persistent', 'shared'));
ALTER TABLE sessions ADD COLUMN setup_permission_expires_at TEXT;
ALTER TABLE sessions ADD COLUMN setup_permission_used_at TEXT;

CREATE TABLE account_enrollment (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK (recovery_generation >= 0),
  recovery_acknowledged_generation INTEGER,
  durable_method_exists INTEGER NOT NULL DEFAULT 0 CHECK (durable_method_exists IN (0, 1))
) STRICT;

INSERT INTO account_enrollment (account_id, recovery_generation, recovery_acknowledged_generation, durable_method_exists)
SELECT a.id,
       CASE WHEN EXISTS (SELECT 1 FROM sign_in_methods m WHERE m.account_id = a.id AND m.kind = 'recovery') THEN 1 ELSE 0 END,
       NULL,
       CASE WHEN EXISTS (SELECT 1 FROM sign_in_methods m WHERE m.account_id = a.id AND m.kind IN ('passkey', 'password', 'oidc')) THEN 1 ELSE 0 END
FROM accounts a;

-- The address is installation-keyed before it reaches this table; rows are retained only
-- long enough to enforce the rolling per-address account creation limit.
CREATE TABLE signup_creations (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  address_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX signup_creations_address_time ON signup_creations(address_hash, created_at);
