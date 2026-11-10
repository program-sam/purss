-- Sharing moves onto baskets and collections (plan/19): a basket or collection is shared as a public page
-- and feed of its own items, live, instead of a separately curated list. The separate "shared collections"
-- are removed (owner decision), with any pending confirmations to publish them.
DELETE FROM confirm_tokens WHERE purpose = 'publication-publish';
DROP TABLE publication_items;
DROP TABLE publications;

-- One share per basket or collection. Its title is the basket's or collection's name; `curator_name` is
-- the name the person chose to show. `listed`: search engines may index the page. `taken_down_at`/
-- `takedown_reason`: an administrator took the page down after a report; it can't be published again
-- (or removed) until an administrator restores it.
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('basket', 'collection')),
  target_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  curator_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused')),
  listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1)),
  taken_down_at TEXT,
  takedown_reason TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (target_kind, target_id)
) STRICT;
CREATE INDEX shares_workspace ON shares(workspace_id);

-- The person's public note on one item of one share, shown on its page and in its feed.
CREATE TABLE share_notes (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (share_id, item_id)
) STRICT;
CREATE INDEX share_notes_item ON share_notes(item_id);

-- What a visitor reported about a public page. Only what they typed is kept; no address or session.
CREATE TABLE share_reports (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('copyright', 'illegal', 'spam', 'harassment', 'privacy', 'other')),
  details TEXT NOT NULL,
  contact TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('taken_down', 'dismissed')),
  resolved_by TEXT
) STRICT;
CREATE INDEX share_reports_share ON share_reports(share_id, resolved_at);
