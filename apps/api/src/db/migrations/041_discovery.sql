-- Discover (hosted installations only): suggestions of sources from what other readers here follow together.
-- The three discovery_* aggregate tables hold counts only, never an account or workspace: they are rebuilt from the
-- followed public sources of accounts that share them (preference `discoveryShare`, on unless switched off), and a
-- source or pair of sources enters them only when enough different accounts follow it (services/discover.ts).
CREATE TABLE discovery_sources (
  key TEXT PRIMARY KEY,            -- urlKey() of the feed address
  feed_url TEXT NOT NULL,
  title TEXT NOT NULL,
  host TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('feed', 'youtube', 'podcast')),
  followers INTEGER NOT NULL       -- never sent to a browser; suggestions show no counts
) STRICT;

-- Both directions are stored, so a lookup from either source reads one index range.
CREATE TABLE discovery_pairs (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  together INTEGER NOT NULL,
  PRIMARY KEY (a, b)
) STRICT, WITHOUT ROWID;

CREATE TABLE discovery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  built_at TEXT,
  dirty INTEGER NOT NULL DEFAULT 0  -- someone stopped (or started) sharing: rebuild soon instead of at the next interval
) STRICT;
INSERT INTO discovery_state (id) VALUES (1);

-- Suggestions a person said they aren't interested in; theirs alone, gone with the account.
CREATE TABLE discovery_dismissed (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
) STRICT, WITHOUT ROWID;
