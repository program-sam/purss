-- Hosted plans (packages/domain/src/plans.ts) limit the sources an account follows and the
-- collections it has. Only hosted installs use them; there, an account without a plan starts on
-- 'free' when the API starts. Administrators are unlimited whatever their plan says.
ALTER TABLE accounts ADD COLUMN plan TEXT CHECK (plan IN ('free', 'plus', 'unlimited'));
