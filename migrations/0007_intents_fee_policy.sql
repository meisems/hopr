-- Preserve the fee agreement used when each executable 1Click quote was made.
-- Never infer historical revenue from today's API-key configuration.
CREATE TABLE IF NOT EXISTS intents_fee_quotes (
  deposit_address TEXT PRIMARY KEY,
  refund_wallet TEXT NOT NULL,
  fee_account TEXT NOT NULL,
  requested_bps INTEGER NOT NULL,
  hopr_bps INTEGER NOT NULL,
  policy TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  credited_trade_id TEXT
);
-- Existing verified rewards are not rewritten. Reconcile historical payouts
-- against provider statements before paying balances created by older code.
