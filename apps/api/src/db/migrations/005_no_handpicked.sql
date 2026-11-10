-- Hand-picked collections are gone: a basket is how individual items are gathered.
-- Collections are only 'sources' or 'query' now. No data is converted (none existed).
-- The CHECK on collections.mode still lists 'manual'. Rebuilding the table would mean dropping
-- a table that collection_sources references, which cascades wherever foreign keys are enforced,
-- and nothing writes that value any more: the API only accepts 'sources' and 'query'.
DROP TABLE collection_items;
DELETE FROM collections WHERE mode = 'manual';
