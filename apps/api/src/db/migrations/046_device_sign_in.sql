-- A phone app's connection is a full sign-in (owner's decision: the app does everything the browser does).
-- auth_at is its last real authentication, for "confirm it's you" (step-up), like sessions.auth_at;
-- auth_method how the connection was made ('signup' counts as authenticated only after a step-up).
-- Connections from before this have no recent authentication: the first sensitive action asks to confirm.
ALTER TABLE device_tokens ADD COLUMN auth_at TEXT;
ALTER TABLE device_tokens ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'connect';
