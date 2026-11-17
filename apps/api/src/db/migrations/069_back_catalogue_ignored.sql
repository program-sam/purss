-- What a source followed from now already had (its back catalogue) is stored as Ignored (sources.start_from, migration 065), not marked
-- with `items.backlog`. Ignored items are hidden from lists, left out of Home, the counts and the digests, and found by search, so the
-- back catalogue stays findable without taking space or attention, and nothing but the workflow state says so.
--
-- An item with `backlog = 1` was in the default state when it was marked (workflow 'new', not New, never opened, not kept, no note: the
-- triggers cleared the mark the first time the person did anything with it), so it becomes Ignored without touching anything the person did.
-- The triggers go first: they clear the mark when an item's state changes, which this does.
DROP TRIGGER item_backlog_state_changed;
DROP TRIGGER item_backlog_state_stored;
DROP TRIGGER item_backlog_kept;
DROP TRIGGER item_backlog_annotated;

-- The copies that caches and the offline pack keep tell which of two is newer by `state_version`, so it moves; the revision, which
-- guards a person's own writes against stale ones, stays where it is. The change is not the person's, so the state log does not hear of it.
UPDATE item_state SET workflow = 'ignored', state_version = state_version + 1
WHERE workflow = 'new' AND item_id IN (SELECT id FROM items WHERE backlog = 1);

-- Nothing is left that reads the mark: the indexes that held it go, and the source index is what it was before 065.
DROP INDEX items_backlog;
DROP INDEX items_ws_visible_sortkey;
DROP INDEX items_source_sortkey;
CREATE INDEX items_source_sortkey ON items(workspace_id, source_id, (COALESCE(published_at, discovered_at)) DESC, id DESC);

ALTER TABLE items DROP COLUMN backlog;
