-- Coming back to the workspace: when the person last visited, which New markers have expired,
-- how a busy source shares Home, pausing for a while, and notifications that wait for a digest.

-- A visit starts when activity resumes after 30 minutes of quiet. `visit_started_at` is the start of the
-- current visit and `last_visit_at` the start of the one before it, so "since your last visit" stays the
-- same for the whole of a visit. Existing workspaces take their last session activity as the visit before.
ALTER TABLE workspaces ADD COLUMN last_visit_at TEXT;
ALTER TABLE workspaces ADD COLUMN visit_started_at TEXT;
ALTER TABLE workspaces ADD COLUMN last_activity_at TEXT;
UPDATE workspaces SET
  last_visit_at = (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = workspaces.account_id),
  visit_started_at = (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = workspaces.account_id),
  last_activity_at = (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = workspaces.account_id);

-- How much room a source takes on Home: 'normal', 'fewer' (at most two items per box) or 'own' (only in its
-- own page, never on Home or in the unified feed). `paused_until` ends a pause for a week or a month by itself.
-- `subscribed_at` is when the engine confirmed the subscription (its first fetch is done). `backlog_settled_at` is set
-- when a sync walk that began after that has finished, even if the feed was empty: until then, entries the source
-- already had are the back catalogue and are not New. `sync_checkpoints.last_walk_done_at` is where the last walk ended,
-- so the next one is known to have begun after it, across batches, retries and restarts. `posts_per_day` is the
-- source's recent rate (published in the last 7 days), refreshed hourly, behind the "busy" hint. The `problem_*`
-- columns remember which failure of a source was told about, so it is told once, however old notifications are pruned.
ALTER TABLE sources ADD COLUMN home_share TEXT NOT NULL DEFAULT 'normal' CHECK (home_share IN ('normal', 'fewer', 'own'));
ALTER TABLE sources ADD COLUMN paused_until TEXT;
ALTER TABLE sources ADD COLUMN backlog_settled_at TEXT;
ALTER TABLE sources ADD COLUMN posts_per_day REAL;
ALTER TABLE sources ADD COLUMN subscribed_at TEXT;
ALTER TABLE sources ADD COLUMN problem_notified_for TEXT;
ALTER TABLE sources ADD COLUMN problem_notified_at TEXT;
ALTER TABLE sync_checkpoints ADD COLUMN last_walk_done_at TEXT;
UPDATE sources SET subscribed_at = created_at WHERE engine_stream_id IS NOT NULL;
UPDATE sources SET backlog_settled_at = created_at WHERE EXISTS (SELECT 1 FROM items i WHERE i.source_id = sources.id);
UPDATE sync_checkpoints SET last_walk_done_at = last_success_at;
CREATE INDEX sources_paused_until ON sources(paused_until) WHERE paused = 1 AND paused_until IS NOT NULL;

-- Notifications: arrivals of one source within the hour share a row, so it keeps its count.
ALTER TABLE notifications ADD COLUMN data TEXT;
CREATE INDEX notifications_workspace ON notifications(workspace_id, created_at);
CREATE INDEX notifications_source ON notifications(source_id) WHERE source_id IS NOT NULL;

-- Where each workspace's digests stand: the end of the last digest window. It moves in the same transaction that
-- makes the digest, and is not a notification, so pruning notifications can never cause a digest to be sent again.
CREATE TABLE notification_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  window_end TEXT NOT NULL
) STRICT;

-- The New markers still standing, found without going through every item (expiry, Home's summary, Start fresh).
CREATE INDEX item_state_fresh ON item_state(workspace_id) WHERE fresh = 1;
-- Recently opened items that are not finished, for Continue on Home.
CREATE INDEX item_state_opened ON item_state(workspace_id, opened_at DESC) WHERE opened_at IS NOT NULL;
-- The order every list uses by default, so a page of Home or a collection reads its first rows from the index.
CREATE INDEX items_ws_sortkey ON items(workspace_id, (COALESCE(published_at, discovered_at)) DESC, id DESC);

-- A source's items one source at a time, in list order: Home takes a bounded slice of each source in turn.
CREATE INDEX items_source_sortkey ON items(workspace_id, source_id, (COALESCE(published_at, discovered_at)) DESC, id DESC);

-- Background activity: copies being fetched, and the ones that finished or failed lately. `failure_notified_for` holds the
-- `completed_at` of the failure that was told about: a new attempt that fails has a new one, and is told about again.
ALTER TABLE captures ADD COLUMN failure_notified_for TEXT;
CREATE INDEX captures_pending ON captures(workspace_id) WHERE status = 'pending';
CREATE INDEX captures_completed ON captures(workspace_id, completed_at) WHERE completed_at IS NOT NULL;

-- "Off" is now a frequency of its own; the delivery mode only says where notifications show.
UPDATE preferences SET value = json_set(value, '$.notifications.frequency', 'off', '$.notifications.mode', 'inapp')
  WHERE json_extract(value, '$.notifications.mode') = 'off';
