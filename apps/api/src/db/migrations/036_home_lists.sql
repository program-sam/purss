-- Home's lists (plan/34).
--
-- "More" joins Normal, Fewer and "Only in its own page" as a source's share of Home. The column's CHECK names the allowed
-- values and SQLite cannot change a CHECK in place, so the column is replaced: the new one is filled from the old, the old
-- one dropped (its own CHECK goes with it) and the new one given the old name.
ALTER TABLE sources ADD COLUMN home_share_next TEXT NOT NULL DEFAULT 'normal' CHECK (home_share_next IN ('normal', 'more', 'fewer', 'own'));
UPDATE sources SET home_share_next = home_share;
ALTER TABLE sources DROP COLUMN home_share;
ALTER TABLE sources RENAME COLUMN home_share_next TO home_share;
