-- Keep playback automation conditional on workflow changes alone, and remember which playback
-- session moved an item into progress so a later hand-set state cannot be finished automatically.
ALTER TABLE item_state ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0);
ALTER TABLE item_state ADD COLUMN playback_workflow_session TEXT;
