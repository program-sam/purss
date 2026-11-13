-- A list sorted by when its items were kept, or by source, computed every item's sort key (the latest keep from the item's
-- memberships, the source's title from its row) and sorted the whole PURSS for one page: seconds at 100,000 items, on the
-- API's thread. Both keys are now stored with the item and indexed the way the lists sort, so a page is read in order from
-- an index like the date orders.

-- When the item was last kept (the latest `kept_at` of its memberships), '' when no basket keeps it. Every change to which
-- baskets hold an item goes through state.ts markMembershipChanged, which stores it again in the same transaction.
-- (A trigger on the memberships would cover every writer too, but makes each keep pay for a statement journal: keeping
-- 5,000 items took most of a second longer.)
ALTER TABLE items ADD COLUMN kept_key TEXT NOT NULL DEFAULT '';
UPDATE items SET kept_key = (SELECT MAX(b.kept_at) FROM basket_items b WHERE b.item_id = items.id) WHERE id IN (SELECT item_id FROM basket_items);
CREATE INDEX items_ws_kept ON items(workspace_id, kept_key, id);

-- The title of the item's source, '' for an item without one. The two writers of items (services/items.ts insertItem and the
-- import) give it when they insert, as they do `stored_objects.is_current` (018, which explains why not a trigger on insert).
-- The database keeps it right when a source is renamed or an item moves to another source, whoever does it.
ALTER TABLE items ADD COLUMN source_title TEXT NOT NULL DEFAULT '';
UPDATE items SET source_title = (SELECT s.title FROM sources s WHERE s.id = items.source_id) WHERE source_id IS NOT NULL;
CREATE INDEX items_ws_source_title ON items(workspace_id, (source_title || char(1) || COALESCE(published_at, discovered_at)), id);

CREATE TRIGGER sources_title_changed AFTER UPDATE OF title ON sources
WHEN NEW.title IS NOT OLD.title
BEGIN
  UPDATE items SET source_title = NEW.title WHERE source_id = NEW.id;
END;
CREATE TRIGGER items_source_title_moved AFTER UPDATE OF source_id ON items
BEGIN
  UPDATE items SET source_title = COALESCE((SELECT title FROM sources WHERE id = NEW.source_id), '') WHERE seq = NEW.seq;
END;
