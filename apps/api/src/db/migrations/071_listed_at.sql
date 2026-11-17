-- An item's time in lists (`items.listed_at`): when it reached the PURSS for a post that came after its source was followed, and its
-- publication date (else its arrival) for everything else. Publishers date posts before they put them in their feeds (a journal adds the
-- day's papers in the afternoon, a feed dates posts by day only, a site puts an old story back in its feed), so a post dated by its
-- publisher would arrive already hours old and be listed below posts that came before it. The publication date stays in `published_at`
-- and is what the item view and the Published date filter show.
--
-- The writers give it when they insert: services/items.ts insertItem (which the sync gives the arrival rule, services/sync.ts listedAtOf)
-- and the import. Items stored before: a feed item published after its source was followed (or arriving after the source settled its
-- back catalogue) is listed at its arrival, as the sync would have listed it; an item added from the reconciliation review is not.
ALTER TABLE items ADD COLUMN listed_at TEXT NOT NULL DEFAULT '';
UPDATE items SET listed_at = CASE
  WHEN EXISTS (SELECT 1 FROM external_ids x WHERE x.item_id = items.id)
    AND NOT EXISTS (SELECT 1 FROM reconciliation_queue r WHERE r.candidate_item_id = items.id AND r.status = 'new')
    AND EXISTS (SELECT 1 FROM sources s WHERE s.id = items.source_id
      AND (items.published_at >= s.created_at OR (s.backlog_settled_at IS NOT NULL AND items.discovered_at >= s.backlog_settled_at)))
  THEN discovered_at
  ELSE COALESCE(published_at, discovered_at)
END;

-- The date orders read these indexes as they read the ones over the publication date before.
DROP INDEX items_ws_sortkey;
DROP INDEX items_source_sortkey;
DROP INDEX items_ws_source_title;
CREATE INDEX items_ws_sortkey ON items(workspace_id, listed_at DESC, id DESC);
CREATE INDEX items_source_sortkey ON items(workspace_id, source_id, listed_at DESC, id DESC);
CREATE INDEX items_ws_source_title ON items(workspace_id, (source_title || char(1) || listed_at), id);

-- A source's newest item time is its newest item's time in lists.
UPDATE sources SET last_item_at = (SELECT MAX(listed_at) FROM items WHERE source_id = sources.id) WHERE id IN (SELECT source_id FROM items);
