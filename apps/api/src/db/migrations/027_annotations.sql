-- Annotations: the person's own highlights and notes on items (plan/26). Separate from workflow,
-- reading progress, collection and basket membership, and retention. IDs are made by the client so
-- a highlight can be created offline; writes are last-write-wins on updated_at. A removed annotation
-- becomes a tombstone (deleted_at set, its text cleared) so a late, older write can't bring it back.
CREATE TABLE annotations (
  seq INTEGER PRIMARY KEY,         -- annotations_fts rowid
  id TEXT NOT NULL UNIQUE,         -- ann_<26>, chosen by the client
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL CHECK (kind IN ('highlight', 'note')),
  -- Text-quote selector over the reader's whitespace-collapsed text, plus a position hint.
  quote_exact TEXT,
  quote_prefix TEXT,
  quote_suffix TEXT,
  pos_start INTEGER,
  pos_end INTEGER,
  -- The text the highlight was made on: a readable-text capture or an item version. Not a
  -- reference that keeps it: the quote above is what survives when that text is released.
  target_kind TEXT CHECK (target_kind IN ('capture', 'version')),
  target_id TEXT,
  body TEXT,                       -- the person's comment (highlight) or note text
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (deleted_at IS NOT NULL OR kind = 'note' OR quote_exact IS NOT NULL),
  CHECK (deleted_at IS NOT NULL OR kind = 'highlight' OR body IS NOT NULL)
) STRICT;
CREATE INDEX annotations_item ON annotations(item_id, updated_at);
CREATE INDEX annotations_workspace ON annotations(workspace_id, updated_at);

-- Search over the person's own words and the passages they marked. Tombstones are not indexed.
CREATE VIRTUAL TABLE annotations_fts USING fts5(
  quote, body,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);
