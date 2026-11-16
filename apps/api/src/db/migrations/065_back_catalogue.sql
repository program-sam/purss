-- What a source already had when it was followed (its back catalogue) can stay out of Home, collection lists and the counts of
-- items not looked at, and still be on the source's own page and in search.
--
-- `sources.start_from` is the choice made when the source was followed: 'now' leaves the whole back catalogue out, 'week' also
-- marks the posts published in the week before the follow as New (and shows them like any New post), 'all' is how every source
-- followed before this choice existed behaves: its back catalogue is shown as ordinary older items. Nothing offers 'all'.
ALTER TABLE sources ADD COLUMN start_from TEXT NOT NULL DEFAULT 'all' CHECK (start_from IN ('all', 'now', 'week'));

-- `items.backlog` = 1: the item arrived as back catalogue of a source followed from now, and the person has not done anything
-- with it. It is set once, when the item is stored, and cleared by the triggers below the first time the person acts on the item
-- (To read or any other state, opening it, reading partway, keeping it, a highlight or note) or it is marked New again, so an
-- item with `backlog = 1` is always in the default state: workflow 'new', not New, never opened, not kept, no annotation. The
-- counts rely on that (services/counts.ts), and a post the person touched is never left out of anything.
ALTER TABLE items ADD COLUMN backlog INTEGER NOT NULL DEFAULT 0;

-- The left-out items are few next to the rest of a PURSS, and almost always asked about per source: this index holds only them
-- (so counting them reads the index alone), and costs the other items nothing.
CREATE INDEX items_backlog ON items(workspace_id, source_id) WHERE backlog = 1;

-- Every list but a source's own page and a search now asks for `backlog = 0` beside its source and date. Counting a collection's items
-- read the source index alone (it holds the item's id); with the mark to check, the planner took an index without it and fetched every
-- row (a collection of 12,000 items took 105 ms instead of 66). With the mark in the index, counting reads the index alone again.
DROP INDEX items_source_sortkey;
CREATE INDEX items_source_sortkey ON items(workspace_id, source_id, (COALESCE(published_at, discovered_at)) DESC, id DESC, backlog);

-- Home and the other lists read items in date order and stop when the page is full. Where most items are left out (a PURSS that just
-- followed hundreds of sources from now), the walk through the whole-PURSS date index goes past every one of them to find the few that
-- show: 245 ms for Home's first page at 100,000 items, 980 ms for four pages. This index holds only the items that can show, in the
-- same order: 4 ms and 14 ms. Where nothing is left out it is the same size as the other one.
CREATE INDEX items_ws_visible_sortkey ON items(workspace_id, (COALESCE(published_at, discovered_at)) DESC, id DESC) WHERE backlog = 0;

CREATE TRIGGER item_backlog_state_changed AFTER UPDATE ON item_state
WHEN NEW.workflow <> 'new' OR NEW.fresh = 1 OR NEW.opened_at IS NOT NULL OR NEW.progress > 0
BEGIN
  UPDATE items SET backlog = 0 WHERE id = NEW.item_id AND backlog = 1;
END;

-- A state stored with its item (an import) cannot leave an item left out that is not in the default state.
CREATE TRIGGER item_backlog_state_stored AFTER INSERT ON item_state
WHEN NEW.workflow <> 'new' OR NEW.fresh = 1 OR NEW.opened_at IS NOT NULL OR NEW.progress > 0
BEGIN
  UPDATE items SET backlog = 0 WHERE id = NEW.item_id AND backlog = 1;
END;

CREATE TRIGGER item_backlog_kept AFTER INSERT ON basket_items
BEGIN
  UPDATE items SET backlog = 0 WHERE id = NEW.item_id AND backlog = 1;
END;

CREATE TRIGGER item_backlog_annotated AFTER INSERT ON annotations
BEGIN
  UPDATE items SET backlog = 0 WHERE id = NEW.item_id AND backlog = 1;
END;
