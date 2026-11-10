-- Hosted Pro (packages/domain/src/plans.ts): 5,000 sources, unlimited collections and Smart filters on the server's Jev key
-- (plan/36). It replaces the separate AI add-on: an account that had the add-on moves to Pro, which includes everything it had.
-- SQLite can't change a column's CHECK, so the plan moves to a new column with the wider check, which takes the old one's name.
ALTER TABLE accounts ADD COLUMN plan_next TEXT CHECK (plan_next IN ('free', 'plus', 'pro', 'unlimited'));
UPDATE accounts SET plan_next = CASE WHEN ai_addon = 1 AND plan IN ('free', 'plus') THEN 'pro' ELSE plan END;
ALTER TABLE accounts DROP COLUMN plan;
ALTER TABLE accounts RENAME COLUMN plan_next TO plan;
ALTER TABLE accounts DROP COLUMN ai_addon;
