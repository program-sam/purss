-- The counts of items by source and state (services/counts.ts) read the items that are not in the default state from a partial index of
-- `item_state`, and joined each one to its item to learn its source. That was cheap while those were few; a source followed from now
-- arrives Ignored, which is most of the items of a PURSS that has just followed many sources, and the join was then the whole cost
-- (300 ms for 80,000 Ignored items among 100,000, on every load of the source list). The state row now carries its item's source
-- (an item's source never changes, and both writers of the row state it when they insert it), and the index holds it, so the counts
-- read the index alone: 39 ms.
ALTER TABLE item_state ADD COLUMN source_id TEXT;
UPDATE item_state SET source_id = (SELECT i.source_id FROM items i WHERE i.id = item_state.item_id);

DROP INDEX item_state_rare;
CREATE INDEX item_state_rare ON item_state(workspace_id, workflow, fresh, source_id) WHERE NOT (workflow = 'new' AND fresh = 0);
