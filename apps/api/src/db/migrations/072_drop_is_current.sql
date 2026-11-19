-- `stored_objects.is_current` marked which stored version is an item's current one, for a storage breakdown nothing
-- shows. The flag, the two triggers that kept it and its place in the account index go; the index keeps the columns
-- the storage sums read.
DROP TRIGGER IF EXISTS items_current_version_changed;
DROP TRIGGER IF EXISTS items_current_version_removed;
DROP INDEX IF EXISTS stored_objects_account;
ALTER TABLE stored_objects DROP COLUMN is_current;
CREATE INDEX stored_objects_account ON stored_objects(account_id, released_at, kind, bytes);
