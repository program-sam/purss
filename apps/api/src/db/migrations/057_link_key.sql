-- A feed sync looks for an item it already has under another id: by link key (a feed reissuing a post) and, for an
-- entry with no link, by title and date. Both looked through every recent item of the source row by row, inside the
-- sync's transaction on the API's thread, so a source with many items held the API for seconds per entry. The link key
-- (services/url-key.ts linkKey) is now stored and both looks are indexed.
ALTER TABLE items ADD COLUMN link_key TEXT;
UPDATE items SET link_key = purss_link_key(url) WHERE url IS NOT NULL;
CREATE INDEX items_ws_source_link_key ON items(workspace_id, source_id, link_key, discovered_at) WHERE link_key IS NOT NULL;
CREATE INDEX items_source_title_published ON items(source_id, title, published_at);
