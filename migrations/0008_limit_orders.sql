-- Limit sell, take profit and stop loss orders. The worker's cron trigger checks
-- active orders every minute and sells automatically when one triggers.
CREATE TABLE IF NOT EXISTS limit_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_id TEXT,                      -- signing wallet (wallet_accounts.id); NULL = the active wallet
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- limit | tp | sl
  trigger_price_usd REAL NOT NULL,     -- limit / tp: sell at or above; sl: sell at or below
  reference_price_usd REAL NOT NULL,   -- price when the order was placed
  sell_percent INTEGER NOT NULL,       -- share of the wallet's balance sold when triggered
  slippage REAL NOT NULL,              -- fraction, e.g. 0.01
  status TEXT NOT NULL DEFAULT 'active', -- active | executing | filled | failed | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  triggered_price_usd REAL,
  tx_hash TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_limit_orders_status ON limit_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_limit_orders_user ON limit_orders(user_id, status);
