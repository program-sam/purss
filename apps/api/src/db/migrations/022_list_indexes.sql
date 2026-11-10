-- Indexes for the counts behind the source list, the collection list and the totals of item lists (plan/13, size gate).

-- The items of a workspace that are not in the default state (workflow "new" and not New), by state, with the item. The
-- counts read the few items a person has acted on, and the New ones, straight from here and join only those to their
-- source; the bulk of the items is never touched. It holds only those rows, so it stays small.
CREATE INDEX item_state_rare ON item_state(workspace_id, workflow, fresh, item_id) WHERE NOT (workflow = 'new' AND fresh = 0);

-- Whether a stored version is its item's current version. The storage summary splits an account's objects into kept, feed
-- and other, and "still the current version" was a lookup in `items` for every object; with the flag the split is one pass
-- over an index that holds everything it reads. The two writers of stored objects state the flag when they insert (the
-- item row is written first, so the answer is known). The database keeps it right when an item switches to another
-- version or is removed, whoever does it; `recountCurrentFlags` puts it right wherever it ever drifts.
-- (Triggers on insert would cover every writer too, but cost about a third of the sync's insert speed.)
ALTER TABLE stored_objects ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0;
UPDATE stored_objects SET is_current = 1
  WHERE kind = 'item_version' AND released_at IS NULL AND EXISTS (SELECT 1 FROM items i WHERE i.current_version_id = stored_objects.ref_id);

CREATE TRIGGER items_current_version_changed AFTER UPDATE OF current_version_id ON items
BEGIN
  UPDATE stored_objects SET is_current = 0 WHERE kind = 'item_version' AND ref_id = OLD.current_version_id AND released_at IS NULL;
  UPDATE stored_objects SET is_current = 1 WHERE kind = 'item_version' AND ref_id = NEW.current_version_id AND released_at IS NULL;
END;
CREATE TRIGGER items_current_version_removed AFTER DELETE ON items
BEGIN
  UPDATE stored_objects SET is_current = 0 WHERE kind = 'item_version' AND ref_id = OLD.current_version_id AND released_at IS NULL;
END;

-- The account's live objects by kind and flag with their sizes, from the index alone (also the sum of an account's bytes).
DROP INDEX stored_objects_account;
CREATE INDEX stored_objects_account ON stored_objects(account_id, released_at, kind, is_current, bytes);

-- A workspace's items in title order (the title column of the table view), so a page of them is read in order from the
-- index instead of sorting every item first.
CREATE INDEX items_ws_title ON items(workspace_id, lower(title), id);
