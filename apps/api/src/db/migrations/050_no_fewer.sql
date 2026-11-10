-- A source's share of Home is Normal, More or "Only in its own page"; sources set to Fewer go back to Normal. The posting rate
-- behind the "busy" hint, which only suggested Fewer, goes too. SQLite cannot change a CHECK in place, so the column is replaced
-- as in 036.
ALTER TABLE sources ADD COLUMN home_share_next TEXT NOT NULL DEFAULT 'normal' CHECK (home_share_next IN ('normal', 'more', 'own'));
UPDATE sources SET home_share_next = CASE home_share WHEN 'fewer' THEN 'normal' ELSE home_share END;
ALTER TABLE sources DROP COLUMN home_share;
ALTER TABLE sources RENAME COLUMN home_share_next TO home_share;
ALTER TABLE sources DROP COLUMN posts_per_day;
