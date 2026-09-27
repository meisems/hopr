# Launchpad liquidity sources

Verified references used by the launchpad liquidity fallback:

- Pump.fun bonding curve: https://pump.fun/docs/bonding-curve
  - Pump.fun launches begin on an on-chain constant-product bonding curve and can later graduate to PumpSwap.
- StonkFun developer page: https://www.stonkfun.xyz/developers
  - StonkFun tokens use pools and may migrate from bonding-curve liquidity to post-migration pools.
- PonsFamily integration docs: https://docs.ponsfamily.com/
  - Pons launches are on Robinhood Chain (chain ID 4663), paired with WETH, with the canonical pool and liquidity state exposed on-chain.
- GeckoTerminal API docs: https://apiguide.geckoterminal.com/
  - Public token-pools data exposes `reserve_in_usd`, `volume_usd.h24`, `base_token_price_usd`, and pool metadata.
- Tolly Labs market page: https://tollylabs.com/
  - Public market listings visibly include market cap, liquidity, and 24-hour volume for Arc launchpad markets.

Implementation uses GeckoTerminal token-pool lookup as a fallback after DexScreener, covering supported Solana, Arc, Robinhood Chain, Base, Arbitrum, and BNB networks. It is read-only and does not depend on private launchpad API keys.
