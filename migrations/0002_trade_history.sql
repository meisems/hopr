-- Trade history: persists the funding side of every buy so a later sell
-- can automatically reverse the route back to the user's original asset.

CREATE TABLE IF NOT EXISTS user_trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_token_address TEXT NOT NULL,
  target_chain_id TEXT NOT NULL,
  purchased_amount TEXT NOT NULL,
  funding_chain_id TEXT NOT NULL,
  funding_token_address TEXT NOT NULL,
  funding_amount TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SUBMITTED | CONFIRMED | FAILED | SOLD
  tx_hash TEXT,
  sell_tx_hash TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_trades_user_id ON user_trades(user_id);
CREATE INDEX IF NOT EXISTS idx_user_trades_status ON user_trades(status);

-- Per-user encrypted wallet material. Never store plaintext keys here —
-- only the AES-256-GCM output from walletService.encryptPrivateKey(),
-- packed as "<salt>.<iv>.<ciphertext>" (all base64).
CREATE TABLE IF NOT EXISTS user_wallets (
  user_id TEXT PRIMARY KEY,
  evm_address TEXT NOT NULL,
  evm_encrypted_key TEXT NOT NULL,
  solana_address TEXT NOT NULL,
  solana_encrypted_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
