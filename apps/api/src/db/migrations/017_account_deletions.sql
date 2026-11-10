-- Account deletion (owner-requested). A row means the account is being deleted: 'pending' for the
-- grace period (signing in offers to keep the account), then 'purging' once removal started.
-- The accounts table itself is not changed. Removal runs in two phases: the API deletes the
-- product data and files (phase1_done), then the worker removes the engine user and asks the API
-- to finalize, which deletes this row with the account.
CREATE TABLE account_deletions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  request_id TEXT NOT NULL UNIQUE,          -- one per request; sign-in cancel tokens bind to it
  requested_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'purging')),
  phase1_done INTEGER NOT NULL DEFAULT 0 CHECK (phase1_done IN (0, 1)),
  files TEXT,                               -- JSON list of data-directory files to remove, set when purging starts
  engine_attempted_at TEXT,                 -- set before the first engine delete-user call
  engine_removed_at TEXT,                   -- the engine user is confirmed gone (by the worker or an administrator)
  engine_review_at TEXT                     -- gone after an unconfirmed attempt: an administrator has to confirm
) STRICT;
