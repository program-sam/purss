-- Outgoing email (plan/27). An account may have one contact address for account messages
-- (confirming it, resetting a password). It is never an identifier: sign-in, linking and the
-- administrator role never look at it, and several accounts may share one.
ALTER TABLE accounts ADD COLUMN email TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;

-- Single-use links sent by email. Only the SHA-256 of the token is stored; `email` is the address
-- the link went to, so a link stops working when the account's address changes.
CREATE TABLE email_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;
CREATE INDEX email_tokens_account ON email_tokens(account_id, purpose);

-- What was sent, never the message: kind, a masked recipient (a•••@example.com), outcome and a
-- short error code. Kept 90 days.
CREATE TABLE mail_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  error TEXT
) STRICT;
CREATE INDEX mail_log_at ON mail_log(at);
