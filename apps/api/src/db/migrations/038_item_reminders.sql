-- "Remind me" on a kept item (plan/34): a day and an optional note, one per item. The day is the
-- person's own calendar day in their time zone ("2026-12-12"), not an instant. notified_at is when
-- the bell (and email, if chosen) was told, so a day is announced once however often the check runs.
CREATE TABLE item_reminders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  remind_on TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  UNIQUE (workspace_id, item_id)
) STRICT;
CREATE INDEX item_reminders_day ON item_reminders(workspace_id, remind_on);

-- A sign-up attempt, so pressing the button twice, or again after closing the page, finds the account
-- it already made instead of making a second one and sending a second confirmation. Only the hash of
-- the browser's random attempt id is kept.
CREATE TABLE signup_attempts (
  attempt_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  -- The session the sign-up started; the attempt can be picked up again only while that session still holds its setup permission.
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
