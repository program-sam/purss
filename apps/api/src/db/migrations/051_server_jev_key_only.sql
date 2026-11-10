-- Smart filters run only on the server's Jev key, which an administrator sets; people no longer keep a key of their own on the
-- server. Usage is counted per account and month, on that key only, and the mark of a refused personal key goes.
CREATE TABLE ai_usage_next (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  month TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
) STRICT;
INSERT INTO ai_usage_next (account_id, month, input_tokens, requests)
  SELECT account_id, month, input_tokens, requests FROM ai_usage WHERE route = 'server';
DROP TABLE ai_usage;
ALTER TABLE ai_usage_next RENAME TO ai_usage;
ALTER TABLE workspaces DROP COLUMN ai_key_rejected;
