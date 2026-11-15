-- An item's number: short, counted per workspace and never given twice, for the item's short link (/app/i/<number>).
-- The workspace's counter only goes up, so deleting an item never frees its number for another item. The triggers number
-- every item stored without one, whichever code stores it; an import that keeps an item's number (portability.ts) moves the
-- counter past it.
ALTER TABLE workspaces ADD COLUMN next_item_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE items ADD COLUMN number INTEGER;
UPDATE items SET number = r.n
  FROM (SELECT seq, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY seq) AS n FROM items) AS r
  WHERE r.seq = items.seq;
UPDATE workspaces SET next_item_number = COALESCE((SELECT MAX(number) FROM items WHERE workspace_id = workspaces.id), 0) + 1;
CREATE UNIQUE INDEX items_ws_number ON items(workspace_id, number);

CREATE TRIGGER items_number_given AFTER INSERT ON items
WHEN NEW.number IS NULL
BEGIN
  UPDATE workspaces SET next_item_number = next_item_number + 1 WHERE id = NEW.workspace_id;
  UPDATE items SET number = (SELECT next_item_number - 1 FROM workspaces WHERE id = NEW.workspace_id) WHERE seq = NEW.seq;
END;
CREATE TRIGGER items_number_kept AFTER INSERT ON items
WHEN NEW.number IS NOT NULL
BEGIN
  UPDATE workspaces SET next_item_number = MAX(next_item_number, NEW.number + 1) WHERE id = NEW.workspace_id;
END;
