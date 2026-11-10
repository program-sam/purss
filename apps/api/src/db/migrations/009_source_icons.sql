-- Source icons: a small square WebP found from the source's feed, channel or website by the
-- worker, re-encoded before it is stored. One per source; a refresh replaces it and a failed
-- refresh keeps it. Re-derivable metadata, so it is neither exported nor counted as quota.
CREATE TABLE source_icons (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  bytes BLOB NOT NULL,
  digest TEXT NOT NULL,            -- sha256 hex of bytes; versions the icon address
  found_url TEXT NOT NULL,         -- address the original image came from
  updated_at TEXT NOT NULL
) STRICT;

-- When the worker last looked for an icon (found or not); NULL means look soon.
ALTER TABLE sources ADD COLUMN icon_checked_at TEXT;
