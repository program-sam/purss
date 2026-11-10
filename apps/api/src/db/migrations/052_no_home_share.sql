-- Sources no longer have a share of Home (More, Normal, "Only in its own page"): Home lists every source in a collection shown
-- on Home, or in none while "Other sources" is shown.
ALTER TABLE sources DROP COLUMN home_share;
