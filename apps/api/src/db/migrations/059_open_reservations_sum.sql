-- Every admission and reservation adds up the account's open reservations (storage.ts reservedBytes): those not settled or
-- released that have not expired. The index found them but each one's expiry and size were read from its row, so keeping
-- thousands of items into a basket that makes readable copies, each with its own reservation, took seconds per thousand
-- under a storage limit. With the expiry and size in the index, the sum reads the unexpired ones from the index alone.
DROP INDEX reservations_open;
CREATE INDEX reservations_open ON reservations(account_id, settled_at, released_at, expires_at, bytes);
