-- The email address is the account's sign-in identity: one account per address, compared without regard to case. Usernames
-- are gone; the internal account id stays the stable key. An address is NULL only once an account's data has been removed.

-- Where several accounts share an address, the one that confirmed it first (else the oldest) keeps it; the others lose it
-- and get one from the operator (cli.ts set-email).
UPDATE accounts SET email = NULL, email_verified_at = NULL
WHERE email IS NOT NULL AND EXISTS (
  SELECT 1 FROM accounts o
  WHERE o.id <> accounts.id AND lower(o.email) = lower(accounts.email)
    AND (coalesce(o.email_verified_at, '9999') < coalesce(accounts.email_verified_at, '9999')
      OR (coalesce(o.email_verified_at, '9999') = coalesce(accounts.email_verified_at, '9999')
        AND (o.created_at < accounts.created_at OR (o.created_at = accounts.created_at AND o.id < accounts.id))))
);
CREATE UNIQUE INDEX accounts_email ON accounts(lower(email)) WHERE email IS NOT NULL;

DROP INDEX sign_in_methods_username;
UPDATE sign_in_methods SET label = NULL WHERE kind = 'password';

-- An invitation is for one address, typed by the administrator; `emailed_at` says its code was delivered there (and only
-- there), so using it proves the address. Unused invitations made without an address end.
ALTER TABLE invites ADD COLUMN email TEXT;
ALTER TABLE invites ADD COLUMN emailed_at TEXT;
DELETE FROM invites WHERE used_at IS NULL;

-- Open sign-up starts with the address: a single-use link goes there, and the account is made only when it is used, so
-- an address nobody confirmed never holds an account. Only the SHA-256 of the token is stored.
CREATE TABLE signup_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;
CREATE INDEX signup_requests_expiry ON signup_requests(expires_at);
