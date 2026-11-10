-- The search index is rebuilt in the background when the way search folds text changes (020). The rebuild's progress belongs to the
-- version it is rebuilding for: `target` says which, so progress made for an earlier version is never taken for the current one
-- (the rebuild starts again when the target differs). The person's notes have their own index and their own progress
-- (`annotation_cursor`, annotations.seq up to which they have been indexed again).
ALTER TABLE search_index_state ADD COLUMN target INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_index_state ADD COLUMN annotation_cursor INTEGER NOT NULL DEFAULT 0;
