-- NEAR Protocol support.
--
-- Custody tables gain a NEAR implicit account (64-hex id) and its ed25519
-- private key, stored only as AES-256-GCM output from
-- walletService.encryptPrivateKey() ("<salt>.<iv>.<ciphertext>"), exactly like
-- the EVM and Solana keys. Existing users get a NEAR key generated lazily the
-- first time they use NEAR (see workers/trading.ts ensureNearWallet).
--
-- user_trades has no chain CHECK constraint: NEAR trades are stored with
-- target_chain_id / funding_chain_id = '397' (NEAR's SLIP-44 coin type).
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; apply this migration exactly once.

ALTER TABLE wallet_accounts ADD COLUMN near_address TEXT;
ALTER TABLE wallet_accounts ADD COLUMN near_encrypted_key TEXT;

ALTER TABLE user_wallets ADD COLUMN near_address TEXT;
ALTER TABLE user_wallets ADD COLUMN near_encrypted_key TEXT;

-- Read-only public NEAR account linked with /setwallet near <account>.
ALTER TABLE telegram_profiles ADD COLUMN near_address TEXT;

CREATE INDEX IF NOT EXISTS idx_wallet_accounts_near_address ON wallet_accounts(near_address);
CREATE INDEX IF NOT EXISTS idx_user_wallets_near_address ON user_wallets(near_address);
CREATE INDEX IF NOT EXISTS idx_user_trades_user_chain ON user_trades(user_id, target_chain_id);
