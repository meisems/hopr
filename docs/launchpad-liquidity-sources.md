# Launch radar: pool discovery

The dashboard and Telegram `/pools` command share the endpoint
`GET /api/launchpads/pools?source=pump`. This is bounded live discovery, not a
complete launch-history index or a guarantee of swap support. No sample tokens
are inserted when a provider fails.

## Sources

- **NEARPaid** (`nearpaid`): `get_config` and `list_launches` on `nearpaid.near`,
  then `get_pool` on `dclv2.ref-labs.near` and both tokens' `ft_metadata`.
  Pool identity must match the factory record. Reads up to ten live pools among
  the latest twenty launches. Price uses `current_point`, ordering, decimals,
  and Rhea's quote-token USD price. Liquidity values reported pool inventories
  at that price, not executable depth. Cumulative volume is never presented as
  24h volume. References: [NEARPaid](https://nearpaid.com), its public production
  client and contract methods, [Rhea prices](https://api.ref.finance/list-token-price).
- **pons** (`pons`): GeckoTerminal venue IDs `pons-dot-family`, `pons-v2`, and
  `pons-v2-dex` on `robinhood`. Attribution requires the exact venue ID, not a
  symbol or generic Uniswap venue. References: [pons docs](https://docs.ponsfamily.com/),
  [venue registry](https://api.geckoterminal.com/api/v2/networks/robinhood/dexes).
- **Pump.fun** (`pump`): indexed `pump-fun` pools on Solana, including bonding
  curves. **PumpSwap** (`pumpswap`) is separate: a pool there is not proof the
  token launched on Pump.fun. Depleted pools remain visible with reported zero
  liquidity. References: [Pump.fun](https://pump.fun),
  [Solana venue registry](https://api.geckoterminal.com/api/v2/networks/solana/dexes).
- **Tolly** (`tolly`): public
  `https://api.tollylabs.com/tokens?scope=tolly&sort=volume&dir=desc&limit=40&offset=0`.
  Only records explicitly marked `tolly: true` are attributed. v4 liquidity is
  accepted only from `poolmanager-extsload` or `pools-trade-api`, never aggregate
  singleton-manager balances. Reference: [Tolly](https://tollylabs.com) and its
  public market client/API.
- **Argus** (`argus`): GeckoTerminal `argus` on `arc`. v4 pools retain the full
  32-byte ID, not a PoolManager address. References:
  [Argus repository](https://github.com/arguspad/argus-world),
  [Arc venue registry](https://api.geckoterminal.com/api/v2/networks/arc/dexes).
- Additional Solana venues: **LaunchLab** (`raydium-launchlab`), **Moonit**
  (`moonit`), **LetsBonk** (`letsbonk-fun`), **Bags** (`bags-fm`), **Meteora DBC**
  (`meteora-dbc`), from the public Solana venue registry.
- **Flap** (`flap`): GeckoTerminal does not index Flap, so launches are read from
  the Portal contracts' `TokenCreated` events (topic
  `0x504e7f36…7699603`, verified against live logs) on BNB
  (`0xe2cE6ab8…C9De0`), Robinhood (`0x26605f32…aEb09`) and Base
  (`0x0000BC1c…90000`), then priced with one DexScreener
  `tokens/v1/<chain>/<addresses>` batch per chain. The latest 24 launches per chain
  appear seconds after launch; ones DexScreener has not indexed yet show "Price
  pending". Log reads use RPCs that allow `eth_getLogs` ranges (PublicNode, the
  Robinhood RPC) with the pool's other backups behind them. Reference:
  [Flap deployed contracts](https://docs.flap.sh/flap/developers/deployed-contract-addresses).
- **Four.meme** (`four-meme` on `bsc`), **Clanker** (`clanker-robinhood`),
  **Bankr** (`bankr-robinhood`), **Virtuals** (`virtuals-base`,
  `virtuals-unicorn-base`, `virtuals-robinhood`).
- DEX venues, listed for tracking only (a pool there is not a launchpad
  attribution): **Uniswap** (v3/v4 on Robinhood and Base, v3 on Arbitrum),
  **PancakeSwap** (v3 and v2 on BNB), **Aerodrome** (Slipstream and classic on Base).

## Token scanning

Every scan (dashboard, Mini App and bot share `detectChain`) asks DexScreener first
and, if it has not answered within 0.6 s, also runs one GeckoTerminal
`search/pools` request across all networks; the first market found wins. The
deepest pool on a supported chain is used and its venue is named (Flap, Four.meme,
Uniswap v3, PancakeSwap…). Tokens with no market yet are found by `eth_getCode`
on every EVM chain. On-chain reads race each chain's backup RPCs
(`src/services/rpcPool.ts`: up to six verified public endpoints per chain): a
second endpoint is asked if the first has not answered within 0.5 s, and a
failing one hands over immediately.

## Refresh and limitations

Flap refreshes every 20 seconds; NEARPaid and Tolly every 90 seconds; other
sources every 60 seconds, while visible. Sorts apply to the
fetched snapshot, including “newest in feed.” Missing metrics remain unknown,
not zero. Cards link to their actual pool. Token scans preserve the known chain
to avoid identical EVM addresses resolving to a different network.

Worker memory and `CACHE` KV share successful snapshots between web and bot.
Fresh data is reused for the source's refresh interval. Public GeckoTerminal
quotas (about 30 requests a minute per IP) still apply: multi-venue sources such
as Uniswap make one request per venue, and a rate-limited venue yields a partial feed. During outages, snapshots up to one day
old are explicitly marked stale with the original timestamp. Partial venue
failures are marked partial. The fetch time does not imply latest-block data.

## Setup

1. Deploy the Worker with the `CACHE` KV binding in `wrangler.toml`.
2. Build with `VITE_API_URL` pointing to the Worker's HTTPS origin, or route
   same-origin `/api/*` to it. A plain Vite server has no Worker API.
3. Configure `NEAR_RPC_URL` for reliable sustained NEARPaid reads.
4. Run `npm run telegram:configure` with the existing bot/webhook environment
   to register `/pools`. Examples: `/pools nearpaid`, `/pools pons`, `/pools argus`.
5. Run `node --import tsx scripts/verify-launchpads.mjs [source...]` for read-only
   provider checks. Selecting a few sources reduces public API quota use.

No database migration or new npm package is needed for Launch radar. Public
provider quotas still apply; KV caching does not remove those limits.

## Trading coverage

Discovery does not add direct launchpad swap adapters. LI.FI, NEAR Intents or Ref
must return an executable route for the selected token and amount. NEARPaid uses
Rhea DCL, which is different from the existing classic Ref swap plan. Tokens
liquid only on DCL need a compatible aggregator route or a direct DCL adapter.
Pump bonding curves and custom Argus hooks also require router support. Do not
bridge funds to a destination merely because a pool is listed.

No funded mainnet transactions were performed during discovery validation.
## Trading shortcuts and PnL cards

Launch radar supports in-feed name/symbol/contract filtering. Quick buy opens the
selected token's trading panel in place; the amount presets use the existing
wallet signing or Telegram quote/confirm flow. No transaction runs on token
selection. Virtuals (Base) is included using its exact indexed venue IDs.

Telegram /pools now provides token and Quick Buy buttons. Buttons bind the
shown token, chain, funding chain and amount to an immutable, chat-specific KV
snapshot for 15 minutes. Configure CACHE or TELEGRAM_STATE. A changed ranking,
expired snapshot or a different chat cannot redirect that button to another
token. Quick Buy requests a live quote; confirmation remains required.

In Positions, use Share PnL card. The 2880×1800 PNG has an original procedural
space background and the HOPR vector logo. Mobile file sharing is offered where
the browser supports it, with PNG download as a fallback. No wallet address is
included. The card is an estimate from settled, locally recorded dashboard
activity and current wallet valuation, excluding untracked transfers and gas.
Missing costs suppress PnL export. Legacy cross-chain entries without a recorded
recipient cannot safely be assigned to a destination wallet and are excluded.
This does not import historical bot trades or provide audited lifetime PnL.

Source coverage is explicit, not a promise to index every launchpad. A listed
token still needs a supported execution route. Direct DCL and custom bonding
curve execution adapters are not supplied by these UI shortcuts.

Multi-step execution now checks every quoted leg before the first signature.
The bot also checks the final LI.FI token route before offering a NEAR bridge
for confirmation. Quotes can still change during settlement; this check is
not atomic execution and does not guarantee later liquidity.
