-- Wallet tracking alerts and copy trading. The worker's cron trigger reads the
-- tracked wallets' new on-chain activity every minute, alerts the users who
-- track them and, when copy trading is on, mirrors their buys (and sells).
CREATE TABLE IF NOT EXISTS tracked_wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  address TEXT NOT NULL,               -- lowercased for EVM / NEAR, as-is for Solana
  kind TEXT NOT NULL,                  -- evm | svm | near
  label TEXT NOT NULL,
  alerts INTEGER NOT NULL DEFAULT 1,
  copy_mode TEXT NOT NULL DEFAULT 'off', -- off | buy | buysell
  copy_amount_usd REAL,                -- spent per copied buy (in the token chain's coin)
  copy_wallet_id TEXT,                 -- the user's signing wallet; NULL = the active wallet
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, address)
);
CREATE INDEX IF NOT EXISTS idx_tracked_wallets_address ON tracked_wallets(address);

-- One row per copied trade; the unique key makes every leader trade copy at most once.
CREATE TABLE IF NOT EXISTS copy_trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tracked_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,                  -- buy | sell
  leader_tx TEXT NOT NULL,
  status TEXT NOT NULL,                -- executing | filled | failed | skipped
  tx_hash TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, leader_tx, token_address, side)
);
CREATE INDEX IF NOT EXISTS idx_copy_trades_user ON copy_trades(user_id, created_at);
