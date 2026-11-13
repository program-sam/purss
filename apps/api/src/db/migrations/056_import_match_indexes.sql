-- An import (and a sync) finds the items an export already has here by original guid (per PURSS: many follow the same feeds), by link, or (an item with neither) by title and
-- date, once per item in the file. Without these, each look scanned every item of the source, so importing a large export
-- into a large source took minutes (one lookup ~100 ms at 100,000 items; with them, well under a millisecond).
CREATE INDEX external_ids_guid ON external_ids(workspace_id, original_guid);
CREATE INDEX items_ws_source_url ON items(workspace_id, source_id, url);
CREATE INDEX items_ws_source_untitled_link ON items(workspace_id, source_id, title, (COALESCE(published_at, ''))) WHERE url IS NULL;
