-- Indexes for lookups that scanned a whole table (they only matter once an account holds
-- thousands of items; see the size gate in plan/13), and two columns the sync fixes need.

-- Which item currently shows a version.
CREATE INDEX items_current_version ON items(current_version_id);

-- Which baskets keep a version (storage classification, upstream edits, superseded versions).
CREATE INDEX basket_items_version ON basket_items(version_id);

-- A source's items by source (and link), with their ids: the per-source counts in the source list and the collection
-- counts read them without opening the item rows, and a sync finds an item it already knows by its link.
CREATE INDEX items_source_url ON items(source_id, url, id);

-- An item's workflow and New marker by item id: the counts above join every item to its state, and this answers
-- each lookup from the index alone.
CREATE INDEX item_state_item ON item_state(item_id, workflow, fresh);

-- Which collections follow a source (the source list shows them for every source).
CREATE INDEX collection_sources_source ON collection_sources(source_id);

-- The feed's full text was too large to store, so the version holds its summary only.
ALTER TABLE item_versions ADD COLUMN content_omitted INTEGER NOT NULL DEFAULT 0;

-- Sync runs that failed one after another; the next run waits longer each time (a success resets it).
ALTER TABLE sync_checkpoints ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
