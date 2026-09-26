# Changed / new files for meisems/hopr custodial trading (v2)

## What changed from the previous pass
- Buy is now a single tap: Buy 0.1/0.5/1.0 quotes AND executes in one call, no separate Confirm step.
- Sell 25/50/100% now resolves the user's actual open position for that token (via user_trades) and
  executes the reverse route, instead of stubbing out.
- Added /exportkeys — decrypts and DMs the user's raw EVM + Solana private keys, with a big inline
  warning, and best-effort auto-deletes the message ~60s later.
- Added /importkey <evm|solana> <key> — lets a user bring their own wallet instead of the bot-generated
  one; upserts into user_wallets (re-encrypted with AES-256-GCM, never stored or logged in plaintext).
- "Create trading wallet" flow and /help text updated to say plainly that Buy/Sell execute immediately.

## Files
- src/services/walletService.ts   — keygen, import, AES-256-GCM encrypt/decrypt (unchanged from last pass)
- src/services/lifiTrader.ts      — LI.FI quote + sign/submit execution (unchanged from last pass)
- src/services/chainDetector.ts   — real DexScreener + eth_getCode probing (unchanged from last pass)
- workers/trading.ts              — custodial wallet + prepareBuy/prepareSell/confirmTrade (unchanged)
- workers/index.ts                — buy/sell now call prepareX() + confirmTrade() back-to-back in one
                                     handler (no user-facing confirm step); added /exportkeys, /importkey,
                                     wallet:export and wallet:import callbacks
- package.json                    — ethers, @solana/web3.js, bs58 (unchanged from last pass)
- migrations/0002_trade_history.sql — user_trades + user_wallets (unchanged from last pass)

## Still worth knowing
- Nothing here blocks a trade before it signs — the amount is whatever preset the user tapped, at
  whatever slippage is in their /settings. There's no minimum-liquidity check, no per-trade cap, and no
  cooldown between taps. If you want any of those as a backstop against fat-finger taps or bot loops,
  say so and I'll add them — they're additive and don't reintroduce a confirmation prompt.
- /exportkeys sends real private keys into the Telegram chat. Telegram chat history is not secure
  long-term storage; treat any export as "now assume this key is semi-public" and rotate (re-import a
  fresh wallet) if that's not acceptable.
- Typechecks clean (`npx tsc --noEmit`) and the keygen/encrypt/decrypt round-trip was sanity-tested.
  Sell path (prepareSell + reverse LI.FI route) has not been run against a live position end-to-end.

## Before deploying
1. `npx wrangler d1 execute hopr-db --file=migrations/0002_trade_history.sql`
2. `npx wrangler secret put ENCRYPTION_KEY` (32+ random bytes) if not already set
3. `npm install`
