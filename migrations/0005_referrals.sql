-- Referral program.
--
-- A referrer owns a code tied to one wallet address (payouts only ever go to
-- that wallet). A referred wallet is bound to the first code it arrives with
-- (first touch, permanent). Each trade a referred wallet makes is recorded
-- once (tx_hash is unique), verified server-side against the route provider
-- (LI.FI status API / NEAR Intents status API), and earns the referrer
-- REFERRAL_RATE (0.1%) of the verified USD volume.

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL UNIQUE,
  owner_vm TEXT NOT NULL,              -- evm | svm | near
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_bindings (
  wallet TEXT PRIMARY KEY,             -- referred wallet (normalized)
  code TEXT NOT NULL REFERENCES referral_codes(code),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referral_bindings_code ON referral_bindings(code);

CREATE TABLE IF NOT EXISTS referral_trades (
  id TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL REFERENCES referral_codes(code),
  wallet TEXT NOT NULL,
  provider TEXT NOT NULL,              -- lifi | intents | ref
  chain_id INTEGER NOT NULL,
  deposit_address TEXT,                -- NEAR Intents routes
  volume_usd REAL NOT NULL DEFAULT 0,
  reward_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | verified | rejected | ineligible
  status_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referral_trades_code ON referral_trades(code, status);

CREATE TABLE IF NOT EXISTS referral_payouts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES referral_codes(code),
  amount_usd REAL NOT NULL,
  payout_wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested', -- requested | paid | rejected
  payout_tx TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referral_payouts_code ON referral_payouts(code, status);
