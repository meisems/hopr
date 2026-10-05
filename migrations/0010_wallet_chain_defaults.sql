-- Per-chain default wallets. Each chain (evm, solana, near) trades from the
-- wallet whose default_for lists it, so an imported key can be a wallet of its
-- own chain only and become that chain's default without touching the others.
-- Without this column the worker falls back to the single active wallet.
ALTER TABLE wallet_accounts ADD COLUMN default_for TEXT;

-- Today's active wallet stays the default for every chain it holds.
UPDATE wallet_accounts SET default_for = 'evm,solana,near' WHERE is_active = 1;
