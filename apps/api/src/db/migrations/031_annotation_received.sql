-- Annotations (plan/26): when the server last accepted a write to each one, in server time. Device
-- clocks decide which write wins (updated_at); this one decides how long a tombstone is remembered and
-- tells offline copies that an item's annotations changed (items' annotatedAt). Existing rows take the
-- best time known.
ALTER TABLE annotations ADD COLUMN received_at TEXT NOT NULL DEFAULT '';
UPDATE annotations SET received_at = COALESCE(deleted_at, updated_at);
CREATE INDEX annotations_tombstones ON annotations(received_at) WHERE deleted_at IS NOT NULL;
