-- Referral program v2: rewards are a share of the platform fee, and Telegram
-- users (bot + Mini App) take part as one identity.
--
-- * Referrers earn REFERRAL_SHARE (25%) of the Hopr platform fee each
--   referred trade actually paid (0.5% on trades, 1% on bridges), measured
--   from the route provider's own records.
-- * A Telegram user is the identity `tg:<telegram user id>`: it can own a
--   referral code (same code in the bot and the Mini App) and be bound to a
--   referrer via /start ref_<code> or a Mini App startapp link. Wallets used
--   by that Telegram user (custodial or connected in the Mini App) inherit
--   the binding, recorded in referral_bindings.telegram_user_id.

ALTER TABLE referral_trades ADD COLUMN fee_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE referral_bindings ADD COLUMN telegram_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_referral_bindings_telegram ON referral_bindings(telegram_user_id);
