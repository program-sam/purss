-- A basket opens in the view last chosen on it (list, cards or timeline), as a collection does.
ALTER TABLE baskets ADD COLUMN view TEXT NOT NULL DEFAULT 'list' CHECK (view IN ('list', 'cards', 'timeline'));
