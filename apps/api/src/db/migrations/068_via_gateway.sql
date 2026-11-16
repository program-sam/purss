-- A big feed (larger than the engine can read whole in its memory limit) is followed through the feed gateway, which hands the engine
-- a copy with only the newest items (plan/44). `sources.via_gateway` = 1: the engine's subscription for this source points at the gateway.
-- The source's own address (`feed_url`, or the private link in the secrets folder) is not changed: it is what is shown, exported and
-- compared. The flag is set when the follow was decided from the preview, or when the worker moved a subscription the engine could not
-- read to the gateway; it only decides which address the worker gives the engine the next time it subscribes the source.
-- Sources followed before this migration are 0: they work as they did (or are moved by the worker when the engine fails on them).
ALTER TABLE sources ADD COLUMN via_gateway INTEGER NOT NULL DEFAULT 0 CHECK (via_gateway IN (0, 1));
