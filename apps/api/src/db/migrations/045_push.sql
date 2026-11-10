-- Phone notifications (plan/37). A connected phone app registers the handle the push relay gave it; the
-- workspace asks that relay to wake the phone when something new is in the bell, and the phone fetches the
-- texts with its own narrow credential (only its SHA-256 is stored). A row goes with its device token.
CREATE TABLE push_devices (
  device_id TEXT PRIMARY KEY REFERENCES device_tokens(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  relay TEXT NOT NULL,             -- the relay the handle belongs to; pushes go only while it is the configured one
  handle TEXT NOT NULL,            -- opaque relay handle (rh_…); wakes the phone, carries nothing
  fetch_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the fetch credential (purss_push_…)
  shown_until TEXT NOT NULL,       -- notifications changed up to this moment have been handed to the phone
  created_at TEXT NOT NULL,
  pushed_at TEXT                   -- last time the relay was asked to wake the phone
) STRICT;
CREATE INDEX push_devices_account ON push_devices(account_id);

-- A notification that grows ("3 new from …") is new to a phone again: when its text last changed.
ALTER TABLE notifications ADD COLUMN changed_at TEXT;
