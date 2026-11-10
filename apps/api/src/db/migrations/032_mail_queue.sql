-- Outgoing email waiting to be sent (plan/27), so a restart, a shutdown or a mail server that is down
-- never drops a message. The message is sealed (AES-256-GCM) with a key kept in the secrets folder:
-- its links are credentials, and the database alone never holds a usable one. A row goes once the
-- message is sent, refused, or a day old; mail_log keeps each attempt's outcome as before.
CREATE TABLE mail_queue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL
) STRICT;
CREATE INDEX mail_queue_due ON mail_queue(next_attempt_at);
