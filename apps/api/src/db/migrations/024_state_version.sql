-- A counter that moves by one on every change to an item's state: workflow, reading progress, the New marker, opening, which
-- baskets hold it (`basketIds` is part of the copy caches keep), the bulk actions, clear-all, both kinds of Undo and the expiry of
-- New markers. The revision still guards workflow and progress against stale writers and moves only for those; this one tells
-- which of two copies of an item is newer, which neither the revision (marker and basket changes leave it) nor a timestamp (two
-- changes can share a millisecond, and a clock can step back) can. Rows that exist start at 0, which is also where a new item starts.
ALTER TABLE item_state ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
