-- A count over a PURSS's items that no narrower index answers (a filter collection's counts) walks all of them. With only the
-- wider workspace indexes to walk, the planner took one in title or source order and fetched each item's row from wherever it
-- lies: at 100,000 items most of the time went into those fetches. This index holds the workspace and the row id alone, so such
-- a walk reads the rows in the order they are stored.
CREATE INDEX items_ws ON items(workspace_id);
