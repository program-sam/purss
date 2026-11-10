-- Per-source full articles: when on, each new item from the source gets a readable-text
-- capture of its page (the same capture a "Keep readable text too" basket makes).
ALTER TABLE sources ADD COLUMN full_text INTEGER NOT NULL DEFAULT 0 CHECK (full_text IN (0, 1));
