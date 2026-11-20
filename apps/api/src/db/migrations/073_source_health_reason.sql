-- Why a source's follow failed, as a code: the one retry through the feed gateway is chosen by it, not by the words shown.
-- Sources that failed because the site didn't answer get the code from the words that failure was stored with.
ALTER TABLE sources ADD COLUMN health_reason TEXT;
UPDATE sources SET health_reason = 'unavailable'
  WHERE health = 'error' AND health_text IN ('The site isn''t answering right now; we''ll keep trying.', 'The site didn''t answer, so this source couldn''t be set up. Try again later.');
-- A source waiting for its first items, or one whose feed had nothing yet, shows the catalog's words for its state and stores none.
UPDATE sources SET health_text = NULL
  WHERE health = 'pending' OR (health = 'quiet' AND health_text = 'No posts yet. Still following; new posts will appear here.');
