-- The server keeps no audio or video files for users. What an earlier version saved is released here:
-- its ledger entries, used bytes, open reservations and queued downloads. The files themselves are
-- deleted when the API starts (services/media-folder.ts). Playback positions stay.
--
-- The stored_objects table keeps 'media' in its kind CHECK (SQLite can't change one without
-- rebuilding the table); nothing writes that kind any more.

-- Release the saved files' ledger entries the way releaseObject does: a usage event per object.
INSERT INTO usage_events (id, account_id, idempotency_key, object_id, delta_bytes, reason, at)
  SELECT 'use_' || lower(hex(randomblob(13))), account_id, 'release:' || id, id, -bytes, 'saved media removed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM stored_objects WHERE kind = 'media' AND released_at IS NULL;

-- The account's used-bytes total drops by exactly what those objects held (accounts without saved files are not touched).
UPDATE storage_accounts SET used_bytes = used_bytes - (
    SELECT SUM(o.bytes) FROM stored_objects o WHERE o.account_id = storage_accounts.account_id AND o.kind = 'media' AND o.released_at IS NULL)
  WHERE account_id IN (SELECT account_id FROM stored_objects WHERE kind = 'media' AND released_at IS NULL);

UPDATE stored_objects SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE kind = 'media' AND released_at IS NULL;

-- Room reserved for downloads that will never run.
UPDATE reservations SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purpose = 'media' AND settled_at IS NULL AND released_at IS NULL;

DELETE FROM jobs WHERE kind = 'media.save';

DROP TABLE saved_media;
ALTER TABLE sources DROP COLUMN save_media;
ALTER TABLE sources DROP COLUMN save_media_since;
