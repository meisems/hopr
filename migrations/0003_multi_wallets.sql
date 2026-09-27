-- Multi-wallet custody. Private keys remain encrypted at rest and are never stored in plaintext.
CREATE TABLE IF NOT EXISTS wallet_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'generated', -- generated | imported
  evm_address TEXT,
  evm_encrypted_key TEXT,
  solana_address TEXT,
  solana_encrypted_key TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallet_accounts_user_id ON wallet_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_accounts_user_evm ON wallet_accounts(user_id, evm_address);

-- Preserve wallets created before multi-wallet support and make them the active default.
INSERT OR IGNORE INTO wallet_accounts (
  id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active, created_at
)
SELECT
  'legacy:' || user_id, user_id, 'Primary wallet', 'generated', evm_address, evm_encrypted_key,
  solana_address, solana_encrypted_key, 1, created_at
FROM user_wallets;
