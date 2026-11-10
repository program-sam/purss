-- An account's used bytes (the sizes of its live stored objects added up), kept by the code that admits and releases
-- the objects, in the same transactions. The quota check ran on every admitted object and re-added every live byte each
-- time: about 25 ms per item at 100,000 items, so a backlog sync after a long absence crawled. `reconcile` compares the
-- total with a recount and puts it right.
ALTER TABLE storage_accounts ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0;

-- Backfilled from a recount (an account that has objects but no row gets one; it has no allocation).
INSERT INTO storage_accounts (account_id, used_bytes)
  SELECT account_id, SUM(bytes) FROM stored_objects WHERE released_at IS NULL GROUP BY account_id
  ON CONFLICT(account_id) DO UPDATE SET used_bytes = excluded.used_bytes;
