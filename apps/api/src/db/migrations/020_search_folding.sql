-- Search compares text in a folded form (Arabic vowel marks, stretched letters, alef variants and the
-- leading "al-" are ignored; see services/search-text.ts), so every item must be indexed again that way.
-- The index is derived data and its contents depend on code, not on SQL: the application records here which
-- version of the fold the index was built with, rebuilds it in the background when it is behind, and
-- remembers how far it got. 0 means "built before the fold existed".
CREATE TABLE search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0   -- items.seq up to which this rebuild has been done
) STRICT;
INSERT INTO search_index_state (id, version, cursor) VALUES (1, 0, 0);
