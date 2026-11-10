-- Smart filter use is counted per ISO week (Monday to Sunday, UTC, as YYYY-Www) instead of per calendar month, so the hosted
-- allowance resets weekly. Monthly totals don't divide into weeks, so counting starts afresh with the current week.
DROP TABLE ai_usage;
CREATE TABLE ai_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  week TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, week)
) STRICT;
