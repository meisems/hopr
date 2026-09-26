CREATE TABLE IF NOT EXISTS telegram_profiles (
  chat_id INTEGER PRIMARY KEY,
  evm_address TEXT,
  solana_address TEXT,
  funding_chain_id INTEGER,
  slippage_percent REAL NOT NULL DEFAULT 1,
  last_token_address TEXT,
  last_token_chain_id INTEGER,
  last_token_chain_type TEXT,
  last_token_symbol TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
