-- One-tap buys across chains: after step 1 (a bridge) is sent, its step 2 is
-- queued here and the worker's every-minute cron runs it once the coins have
-- arrived, then messages the user. A row is claimed before it runs, so
-- overlapping cron runs never execute a step twice.
CREATE TABLE IF NOT EXISTS auto_steps (
  id TEXT PRIMARY KEY,          -- the continuation id from step 1
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_auto_steps_created ON auto_steps(created_at);
