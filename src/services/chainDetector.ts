// Chain Detection Engine
// Automatically resolves which blockchain a token address belongs to.
//
// Solana: base58 address, verified against DexScreener.
// EVM: 0x-address, resolved via DexScreener first (fast path for indexed
// tokens), falling back to concurrent eth_getCode probes across every
// supported EVM chain for freshly-deployed tokens DexScreener hasn't
// indexed yet, then reading symbol()/name()/decimals() on the chain that
// returns bytecode.
// NEAR: NEP-141 contract id (`token.near` or a 64-hex implicit id), resolved
// via DexScreener / GeckoTerminal with decimals read from ft_metadata. NEAR is
// not a LI.FI chain, so it lives outside SUPPORTED_CHAINS (see NEAR_CHAIN).

import { getTokenMetadata, isNearAccountId, NEAR_CHAIN, NEAR_CHAIN_ID } from './nearService';
import { jsonRpcRace } from './rpcPool';
import { firstHit, launchpadFromVenue, venueName } from './venues';

export { NEAR_CHAIN, NEAR_CHAIN_ID };

export interface ChainInfo {
  id: number;
  name: string;
  key: string; // LI.FI chain key
  type: 'EVM' | 'SVM';
  nativeToken: string;
  nativeSymbol: string;
  color: string;
  rpcUrl: string;
}

// Public fallback RPCs. Override per-chain via VITE_RPC_<KEY> at build time
// or RPC_<KEY> worker secrets for production traffic.
export const SUPPORTED_CHAINS: ChainInfo[] = [
  { id: 1151111081099710, name: 'Solana', key: 'sol', type: 'SVM', nativeToken: 'SOL', nativeSymbol: 'SOL', color: '#9945FF', rpcUrl: 'https://api.mainnet-beta.solana.com' },
  { id: 42161, name: 'Arbitrum One', key: 'arb', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#28A0F0', rpcUrl: 'https://arb1.arbitrum.io/rpc' },
  { id: 8453, name: 'Base', key: 'bas', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#0052FF', rpcUrl: 'https://mainnet.base.org' },
  { id: 56, name: 'BNB Chain', key: 'bsc', type: 'EVM', nativeToken: 'BNB', nativeSymbol: 'BNB', color: '#F0B90B', rpcUrl: 'https://bsc-dataseed.binance.org' },
  { id: 4663, name: 'Robinhood Chain', key: 'rhc', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#00C853', rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' },
  { id: 5042, name: 'Arc Chain', key: 'arc', type: 'EVM', nativeToken: 'USDC', nativeSymbol: 'USDC', color: '#FF6D00', rpcUrl: 'https://rpc.mainnet.arc.io' },
];

export interface DetectedToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  chainId: number;
  chainType: 'EVM' | 'SVM' | 'NEAR';
  chainName: string;
  chainColor: string;
  priceUsd: number;
  liquidity: number;
  volume24h: number;
  fdv: number;
  change24h: number;
  /** DexScreener pool used to request real OHLCV history. */
  pairAddress?: string;
  geckoNetwork?: string;
  /** true if resolved via bytecode probing rather than an indexed DexScreener pair */
  freshDeployment: boolean;
  /** Data source used for the displayed pool/liquidity metrics. */
  liquiditySource?: string;
  /** Launchpad or pool family when the source exposes one. */
  launchpad?: string;
  pairedAsset?: { address?: string; symbol: string; name?: string };
  /** Token icon from the market data provider, when listed. */
  imageUrl?: string;
  /** Price change by timeframe (percent). */
  priceChanges?: { m5?: number; h1?: number; h6?: number; h24?: number };
  /** Buy and sell transaction counts over 24h. */
  txns24h?: { buys: number; sells: number };
  /** Pool creation time (ms since epoch). */
  pairCreatedAt?: number;
  /** DexScreener pair page. */
  pairUrl?: string;
  /**
   * How complete the market numbers are: 'live' (pool data), 'partial' (a
   * price, but no indexed pool yet), 'stale' (last known, providers busy) or
   * 'none' (no market data). Zero values are unknown unless status is 'live'.
   */
  marketStatus?: 'live' | 'partial' | 'stale' | 'none';
  /** Provider the market numbers came from (DexScreener, GeckoTerminal, Jupiter, DefiLlama). */
  marketSource?: string;
  /** When stale numbers were last read live (ms since epoch). */
  marketObservedAt?: number;
  /** Holder count, when the provider reports it (Jupiter). */
  holders?: number;
  /** Solana mint confirmed on-chain even though no market answered. */
  onChain?: boolean;
}

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function isBase58(str: string): boolean {
  if (str.length < 32 || str.length > 44) return false;
  return [...str].every((c) => BASE58_CHARS.includes(c));
}

function isEvmAddress(str: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(str);
}

interface DexScreenerPair {
  chainId: string;
  pairAddress?: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name: string; symbol: string };
  priceUsd?: string;
  /** Base token price in quote-token units (used to price a token scanned on the quote side). */
  priceNative?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
  marketCap?: number;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  dexId?: string;
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
  url?: string;
  info?: { imageUrl?: string };
}

/** Activity and presentation fields shared by every DexScreener-backed token. */
function pairExtras(pair: DexScreenerPair, scannedIsBase: boolean): Pick<DetectedToken, 'imageUrl' | 'priceChanges' | 'txns24h' | 'pairCreatedAt' | 'pairUrl'> {
  return {
    // DexScreener's icon and price changes describe the pair's base token.
    imageUrl: scannedIsBase ? pair.info?.imageUrl : undefined,
    priceChanges: scannedIsBase ? pair.priceChange : undefined,
    txns24h: pair.txns?.h24 ? { buys: pair.txns.h24.buys ?? 0, sells: pair.txns.h24.sells ?? 0 } : undefined,
    pairCreatedAt: pair.pairCreatedAt,
    pairUrl: pair.url,
  };
}

/** Every scan lookup gets this long; a slow provider falls through to the next source instead of stalling the scan. */
const SCAN_TIMEOUT_MS = 4_000;

// Market APIs sit behind bot protection; an identified JSON client is far less likely to be challenged
// (Cloudflare Workers send no User-Agent by default).
const SCAN_HEADERS = { Accept: 'application/json', 'User-Agent': 'HoprBot/1.0 (+https://t.me/hopr)' };

function scanFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...SCAN_HEADERS, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(SCAN_TIMEOUT_MS) });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET JSON with one retry on throttling, server errors and timeouts (a busy provider is not "no market"). */
async function scanJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await scanFetch(url);
      if (response.ok) return await response.json() as T;
      if (response.status !== 429 && response.status < 500 && response.status !== 403) return null;
    } catch {
      // timeout or network error: retry once
    }
    if (attempt === 0) await sleep(400);
  }
  return null;
}

async function fetchDexScreener(address: string): Promise<DexScreenerPair[]> {
  const data = await scanJson<{ pairs?: DexScreenerPair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  return data?.pairs ?? [];
}

// Maps DexScreener's chainId slugs to our numeric chain ids for the chains we support.
const DEXSCREENER_CHAIN_SLUGS: Record<string, number> = {
  solana: 1151111081099710,
  arbitrum: 42161,
  base: 8453,
  bsc: 56,
  robinhood: 4663,
  arc: 5042,
};

const GECKO_NETWORKS: Record<string, string> = {
  solana: 'solana',
  arbitrum: 'arbitrum',
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
  arc: 'arc',
};

const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const PONS_GET_LAUNCHED_TOKEN_SELECTOR = '0x3cf28b5a';

/** Read Pons V2's selected quote asset before a launch graduates into a pool. */
async function fetchPonsPairToken(tokenAddress: string): Promise<{ address: string; symbol: string; name: string } | null> {
  const data = `${PONS_GET_LAUNCHED_TOKEN_SELECTOR}${tokenAddress.slice(2).padStart(64, '0')}`;
  try {
    const encoded = await jsonRpcRace<string>(4663, 'eth_call', [{ to: PONS_V2_FACTORY, data }, 'latest'], { validate: isHex });
    if (!encoded.startsWith('0x') || encoded.length < 2 + 32 * 12 * 2) return null;
    const word = (index: number) => encoded.slice(2 + index * 64, 2 + (index + 1) * 64);
    if (!word(11).endsWith('1')) return null;
    const pairedAddress = `0x${word(2).slice(24)}`;
    if (/^0x0+$/.test(pairedAddress)) return null;
    const metadata = await readErc20Metadata(4663, pairedAddress);
    return { address: pairedAddress, symbol: metadata?.symbol ?? 'QUOTE', name: metadata?.name ?? 'Quote asset' };
  } catch {
    return null;
  }
}

function pairToDetectedToken(pair: DexScreenerPair, chainId: number, chainInfo: ChainInfo, scannedAddress: string): DetectedToken {
  const source = pair.dexId ? venueName(pair.dexId) : 'DexScreener';
  const scanned = scannedAddress.toLowerCase();
  const isQuote = pair.quoteToken?.address.toLowerCase() === scanned && pair.baseToken.address.toLowerCase() !== scanned;
  const token = isQuote && pair.quoteToken ? pair.quoteToken : pair.baseToken;
  const paired = isQuote ? pair.baseToken : pair.quoteToken;
  const robinhoodDefaultPair = chainInfo.id === 4663 && !paired ? { symbol: 'WETH', name: 'Wrapped Ether' } : undefined;
  // DexScreener prices the pair's base token. Scanned on the quote side, the token's price is
  // base price ÷ base-per-quote rate, and the pair's FDV belongs to the other token.
  const basePrice = Number(pair.priceUsd ?? 0);
  const native = Number(pair.priceNative ?? 0);
  const priceUsd = isQuote ? (basePrice > 0 && native > 0 ? basePrice / native : 0) : basePrice;
  return {
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    decimals: chainInfo.type === 'SVM' ? 9 : 18, // refined by on-chain call where available
    chainId,
    chainType: chainInfo.type,
    chainName: chainInfo.name,
    chainColor: chainInfo.color,
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
    liquidity: pair.liquidity?.usd ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    fdv: isQuote ? 0 : pair.fdv ?? pair.marketCap ?? 0,
    change24h: isQuote ? 0 : pair.priceChange?.h24 ?? 0,
    pairAddress: pair.pairAddress,
    geckoNetwork: GECKO_NETWORKS[pair.chainId.toLowerCase()],
    freshDeployment: false,
    liquiditySource: source,
    launchpad: launchpadFromVenue(pair.dexId),
    pairedAsset: paired ? { address: paired.address, name: paired.name, symbol: paired.symbol } : robinhoodDefaultPair,
    marketStatus: 'live',
    marketSource: 'DexScreener',
    ...pairExtras(pair, !isQuote),
  };
}

const GECKO_NETWORK_SLUGS: Record<string, string> = {
  sol: 'solana',
  arb: 'arbitrum',
  bas: 'base',
  bsc: 'bsc',
  rhc: 'robinhood',
  arc: 'arc',
};

interface GeckoPoolMarket {
  address: string;
  name: string;
  source: string;
  symbol: string;
  priceUsd: number;
  liquidity: number;
  volume24h: number;
  fdv: number;
  pairAddress: string;
  pairedAsset?: { symbol: string; name?: string };
  priceChanges?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns24h?: { buys: number; sells: number };
  pairCreatedAt?: number;
  launchpad?: string;
}

/**
 * GeckoTerminal is the fallback for fresh launchpad pools that are not yet
 * present in DexScreener. Its public API reads indexed on-chain pool state,
 * including reserve_in_usd and volume_usd.h24.
 */
type GeckoPool = { id?: string; attributes?: Record<string, unknown>; relationships?: { dex?: { data?: { id?: string } }; base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } };

/** One GeckoTerminal pool as market data for the scanned token (either side of the pair). */
function geckoPoolToMarket(pool: GeckoPool, address: string): GeckoPoolMarket | null {
  if (!pool.attributes) return null;
  const attrs = pool.attributes;
  const reserve = Number(attrs.reserve_in_usd ?? 0);
  if (!Number.isFinite(reserve) || reserve <= 0) return null;
  const volume = attrs.volume_usd as { h24?: number } | undefined;
  const poolName = String(attrs.name ?? 'Launchpad token');
  const pairSymbols = poolName.split(' / ').map((part) => part.replace(/\s+\d+(?:\.\d+)?%$/, '').trim());
  const fdv = Number(attrs.fdv_usd ?? attrs.market_cap_usd ?? 0);
  const poolId = pool.id?.split('_').pop() ?? '';
  const source = venueName(pool.relationships?.dex?.data?.id ?? 'GeckoTerminal');
  const baseId = pool.relationships?.base_token?.data?.id?.split('_').pop()?.toLowerCase();
  const quoteId = pool.relationships?.quote_token?.data?.id?.split('_').pop()?.toLowerCase();
  const scannedIsQuote = quoteId === address.toLowerCase() && baseId !== address.toLowerCase();
  const tokenName = scannedIsQuote ? pairSymbols[1] : pairSymbols[0];
  const tokenSymbol = scannedIsQuote ? pairSymbols[1] : String(attrs.base_token_symbol ?? pairSymbols[0] ?? 'UNKNOWN');
  const pairedSymbol = scannedIsQuote ? pairSymbols[0] : pairSymbols[1];
  return {
    address,
    name: String(tokenName || attrs.base_token_name || 'Token'),
    symbol: String(tokenSymbol || 'UNKNOWN'),
    source,
    priceUsd: Number((scannedIsQuote ? attrs.quote_token_price_usd : attrs.base_token_price_usd) ?? attrs.token_price_usd ?? 0),
    liquidity: reserve,
    volume24h: Number(volume?.h24 ?? 0),
    fdv: Number.isFinite(fdv) ? fdv : 0,
    pairAddress: poolId,
    pairedAsset: pairedSymbol ? { symbol: pairedSymbol } : undefined,
    launchpad: launchpadFromVenue(pool.relationships?.dex?.data?.id),
    ...geckoActivity(attrs, !scannedIsQuote),
  };
}

async function fetchGeckoTerminalMarket(address: string, chain: ChainInfo): Promise<GeckoPoolMarket | null> {
  const network = GECKO_NETWORK_SLUGS[chain.key];
  if (!network) return null;
  const payload = await scanJson<{ data?: GeckoPool[] }>(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`);
  // The deepest pool, not merely the first one listed.
  const pool = [...(payload?.data ?? [])].sort((left, right) => Number(right.attributes?.reserve_in_usd ?? 0) - Number(left.attributes?.reserve_in_usd ?? 0))[0];
  return pool ? geckoPoolToMarket(pool, address) : null;
}

/**
 * One GeckoTerminal request across every network (instead of one per chain):
 * the deepest pool on a Hopr chain that holds the scanned token on either side.
 */
async function fetchGeckoSearchMarket(address: string): Promise<{ market: GeckoPoolMarket; chain: ChainInfo } | null> {
  try {
    const payload = await scanJson<{ data?: GeckoPool[] }>(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(address)}`);
    if (!payload) return null;
    const evm = address.startsWith('0x');
    const matches = (tokenRef: string | undefined, network: string) => !!tokenRef
      && (evm ? tokenRef.toLowerCase() === `${network}_${address.toLowerCase()}` : tokenRef === `${network}_${address}`);
    const hits = (payload.data ?? []).flatMap((pool) => {
      const network = pool.relationships?.base_token?.data?.id?.split('_')[0] ?? '';
      const chainId = DEXSCREENER_CHAIN_SLUGS[network];
      const chain = SUPPORTED_CHAINS.find((item) => item.id === chainId);
      if (!chain || !(matches(pool.relationships?.base_token?.data?.id, network) || matches(pool.relationships?.quote_token?.data?.id, network))) return [];
      const market = geckoPoolToMarket(pool, address);
      return market ? [{ market, chain }] : [];
    });
    return hits.sort((left, right) => right.market.liquidity - left.market.liquidity)[0] ?? null;
  } catch {
    return null;
  }
}

/** Timeframe changes (base side only), 24h buy/sell counts and pool age from a GeckoTerminal pool. */
function geckoActivity(attrs: Record<string, unknown>, scannedIsBase: boolean): Pick<GeckoPoolMarket, 'priceChanges' | 'txns24h' | 'pairCreatedAt'> {
  const toNumber = (value: unknown) => (value === undefined || value === null || value === '' ? undefined : Number(value));
  const changes = attrs.price_change_percentage as Record<string, unknown> | undefined;
  const txns = (attrs.transactions as { h24?: { buys?: number; sells?: number } } | undefined)?.h24;
  const created = typeof attrs.pool_created_at === 'string' ? Date.parse(attrs.pool_created_at) : NaN;
  return {
    priceChanges: scannedIsBase && changes ? { m5: toNumber(changes.m5), h1: toNumber(changes.h1), h6: toNumber(changes.h6), h24: toNumber(changes.h24) } : undefined,
    txns24h: txns ? { buys: txns.buys ?? 0, sells: txns.sells ?? 0 } : undefined,
    pairCreatedAt: Number.isFinite(created) ? created : undefined,
  };
}

/** Launchpad behind a venue id or name (Flap, Four.meme, Pump.fun, Clanker…); undefined for plain DEXes. */
export function detectLaunchpad(source: string): string | undefined {
  return launchpadFromVenue(source);
}

function geckoMarketToToken(market: GeckoPoolMarket, chain: ChainInfo, fallbackAddress: string): DetectedToken {
  return {
    address: fallbackAddress,
    name: market.name,
    symbol: market.symbol,
    decimals: chain.type === 'SVM' ? 9 : 18,
    chainId: chain.id,
    chainType: chain.type,
    chainName: chain.name,
    chainColor: chain.color,
    priceUsd: market.priceUsd,
    liquidity: market.liquidity,
    volume24h: market.volume24h,
    fdv: market.fdv,
    change24h: market.priceChanges?.h24 ?? 0,
    priceChanges: market.priceChanges,
    txns24h: market.txns24h,
    pairCreatedAt: market.pairCreatedAt,
    pairAddress: market.pairAddress,
    geckoNetwork: GECKO_NETWORK_SLUGS[chain.key],
    freshDeployment: true,
    liquiditySource: market.source,
    launchpad: market.launchpad ?? detectLaunchpad(market.source),
    pairedAsset: market.pairedAsset,
    marketStatus: 'live',
    marketSource: 'GeckoTerminal',
  };
}

// ---------------------------------------------------------------------------
// Backup market sources from other providers, so one throttled API never
// turns a real token into "$0 everything" or "no market found".
// ---------------------------------------------------------------------------

type JupiterToken = {
  id: string; name?: string; symbol?: string; decimals?: number; icon?: string; usdPrice?: number; fdv?: number; mcap?: number;
  liquidity?: number; holderCount?: number; stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number; numBuys?: number; numSells?: number };
  stats1h?: { priceChange?: number }; stats5m?: { priceChange?: number }; stats6h?: { priceChange?: number }; firstPool?: { createdAt?: string };
};

/** Solana market data from Jupiter's token index: price, FDV, liquidity, 24h volume and holders. */
async function fetchJupiterToken(mint: string): Promise<DetectedToken | null> {
  const tokens = await scanJson<JupiterToken[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`);
  const token = tokens?.find((item) => item.id === mint);
  if (!token || !(Number(token.usdPrice) > 0)) return null;
  const solana = SUPPORTED_CHAINS.find((chain) => chain.key === 'sol')!;
  const created = token.firstPool?.createdAt ? Date.parse(token.firstPool.createdAt) : NaN;
  return {
    address: mint,
    name: token.name ?? 'Solana token',
    symbol: token.symbol ?? 'UNKNOWN',
    decimals: token.decimals ?? 9,
    chainId: solana.id,
    chainType: 'SVM',
    chainName: solana.name,
    chainColor: solana.color,
    priceUsd: Number(token.usdPrice),
    liquidity: Number(token.liquidity ?? 0),
    volume24h: Number(token.stats24h?.buyVolume ?? 0) + Number(token.stats24h?.sellVolume ?? 0),
    fdv: Number(token.fdv ?? token.mcap ?? 0),
    change24h: Number(token.stats24h?.priceChange ?? 0),
    priceChanges: { m5: token.stats5m?.priceChange, h1: token.stats1h?.priceChange, h6: token.stats6h?.priceChange, h24: token.stats24h?.priceChange },
    txns24h: token.stats24h?.numBuys !== undefined ? { buys: token.stats24h.numBuys ?? 0, sells: token.stats24h.numSells ?? 0 } : undefined,
    pairCreatedAt: Number.isFinite(created) ? created : undefined,
    imageUrl: token.icon,
    holders: token.holderCount,
    geckoNetwork: 'solana',
    freshDeployment: false,
    liquiditySource: 'Jupiter',
    marketStatus: Number(token.liquidity ?? 0) > 0 ? 'live' : 'partial',
    marketSource: 'Jupiter',
  };
}

/** DefiLlama chain slugs (Robinhood Chain is not covered). */
const LLAMA_CHAINS: Record<number, string> = { 8453: 'base', 42161: 'arbitrum', 56: 'bsc', 5042: 'arc', 1151111081099710: 'solana', [NEAR_CHAIN_ID]: 'near' };

type LlamaPrice = { chainId: number; price: number; symbol?: string; decimals?: number };

/** Prices for one address on several chains in one DefiLlama request; confident quotes only. */
async function fetchLlamaPrices(address: string, chainIds: number[]): Promise<LlamaPrice[]> {
  const keys = chainIds.filter((id) => LLAMA_CHAINS[id]).map((id) => `${LLAMA_CHAINS[id]}:${address}`);
  if (!keys.length) return [];
  const data = await scanJson<{ coins?: Record<string, { price?: number; symbol?: string; decimals?: number; confidence?: number }> }>(`https://coins.llama.fi/prices/current/${keys.join(',')}`);
  return Object.entries(data?.coins ?? {}).flatMap(([key, coin]) => {
    const chainId = Number(Object.entries(LLAMA_CHAINS).find(([, slug]) => key.startsWith(`${slug}:`))?.[0]);
    return Number(coin.price) > 0 && (coin.confidence ?? 1) >= 0.8 && Number.isFinite(chainId)
      ? [{ chainId, price: Number(coin.price), symbol: coin.symbol, decimals: coin.decimals }] : [];
  });
}

/** ERC-20 totalSupply() in whole tokens (for FDV when a source has only a price). */
async function readTotalSupply(chainId: number, address: string, decimals: number): Promise<number | null> {
  try {
    const supply = await jsonRpcRace<string>(chainId, 'eth_call', [{ to: address, data: '0x18160ddd' }, 'latest'], { validate: isHex, timeoutMs: 2_500 });
    if (!supply || supply === '0x') return null;
    const units = BigInt(supply);
    const base = 10n ** BigInt(decimals);
    return Number(units / base) + Number(units % base) / Number(base);
  } catch {
    return null;
  }
}

/**
 * Fill what the primary source left empty: a price (and FDV from the
 * on-chain supply) from DefiLlama for tokens no DEX indexer answered for,
 * and FDV for quote-side scans.
 */
export async function enrichMarket(token: DetectedToken): Promise<DetectedToken> {
  const hasPrice = token.priceUsd > 0;
  if (hasPrice && token.fdv > 0) return token;
  const enriched = { ...token };
  if (!hasPrice) {
    const [llama] = await fetchLlamaPrices(token.address, [token.chainId]).catch(() => []);
    if (!llama) return { ...token, marketStatus: token.marketStatus === 'live' ? 'live' : 'none' };
    enriched.priceUsd = llama.price;
    enriched.marketStatus = token.liquidity > 0 ? 'live' : 'partial';
    enriched.marketSource = token.marketSource ?? 'DefiLlama';
    if (token.symbol === 'UNKNOWN' && llama.symbol) enriched.symbol = llama.symbol.toUpperCase();
    if (llama.decimals !== undefined) enriched.decimals = llama.decimals;
  }
  if (!(enriched.fdv > 0) && token.chainType === 'EVM') {
    const supply = await readTotalSupply(token.chainId, token.address, enriched.decimals);
    if (supply) enriched.fdv = supply * enriched.priceUsd;
  } else if (!(enriched.fdv > 0) && token.chainType === 'SVM') {
    const jupiter = await fetchJupiterToken(token.address).catch(() => null);
    if (jupiter?.fdv) enriched.fdv = jupiter.fdv;
  }
  return enriched;
}

/** Hex result of a read-only call, raced across the chain's backup RPCs. */
const isHex = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value);

/** eth_getCode probe on `chainId`: true if `address` has deployed bytecode (backup RPCs raced). */
async function hasBytecode(chainId: number, address: string): Promise<boolean> {
  try {
    const code = await jsonRpcRace<string>(chainId, 'eth_getCode', [address, 'latest'], { validate: isHex });
    return code !== '0x';
  } catch {
    return false;
  }
}

async function readErc20Metadata(
  chainId: number,
  address: string
): Promise<{ name: string; symbol: string; decimals: number } | null> {
  // Function selectors for name(), symbol(), decimals() with no args.
  const calls = [
    { sig: '0x06fdde03', key: 'name' as const },
    { sig: '0x95d89b41', key: 'symbol' as const },
    { sig: '0x313ce567', key: 'decimals' as const },
  ];

  try {
    const results = await Promise.all(
      // A revert (no such method) reads as empty, like a missing field.
      calls.map(({ sig }) => jsonRpcRace<string>(chainId, 'eth_call', [{ to: address, data: sig }, 'latest'], { validate: isHex }).catch(() => '0x')),
    );

    const decodeString = (hex: string): string => {
      if (!hex || hex === '0x') return '';
      const clean = hex.slice(2);
      // ABI-encoded dynamic string: skip offset (32 bytes) + length (32 bytes) header
      const lenHex = clean.slice(64, 128);
      const len = parseInt(lenHex, 16) || 0;
      const strHex = clean.slice(128, 128 + len * 2);
      const bytes = strHex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [];
      return new TextDecoder().decode(new Uint8Array(bytes));
    };

    const name = decodeString(results[0]) || 'Unknown Token';
    const symbol = decodeString(results[1]) || 'UNKNOWN';
    const decimals = parseInt(results[2], 16) || 18;

    return { name, symbol, decimals };
  } catch {
    return null;
  }
}

/**
 * Probe every supported EVM chain concurrently for deployed bytecode at
 * `address`, and read ERC-20 metadata from whichever chain answers first
 * with non-empty code.
 */
async function probeEvmChains(address: string): Promise<DetectedToken | null> {
  const evmChains = SUPPORTED_CHAINS.filter((c) => c.type === 'EVM');

  const probes = await Promise.all(
    evmChains.map(async (chain) => ({
      chain,
      found: await hasBytecode(chain.id, address),
    }))
  );

  const hit = probes.find((p) => p.found);
  if (!hit) return null;

  const metadata = await readErc20Metadata(hit.chain.id, address);

  return {
    address,
    name: metadata?.name ?? 'Unknown Token',
    symbol: metadata?.symbol ?? 'UNKNOWN',
    decimals: metadata?.decimals ?? 18,
    marketStatus: 'none',
    chainId: hit.chain.id,
    chainType: 'EVM',
    chainName: hit.chain.name,
    chainColor: hit.chain.color,
    priceUsd: 0,
    liquidity: 0,
    volume24h: 0,
    fdv: 0,
    change24h: 0,
    freshDeployment: true,
  };
}

interface GeckoNearPool {
  address: string;
  priceUsd: number;
  liquidity: number;
  volume24h: number;
  fdv: number;
  change24h: number;
  name: string;
  dex: string;
}

/** Deepest GeckoTerminal pool for a NEAR token — also the pool id charts use. */
async function fetchGeckoNearPool(tokenId: string): Promise<GeckoNearPool | null> {
  try {
    const response = await scanFetch(`https://api.geckoterminal.com/api/v2/networks/near/tokens/${encodeURIComponent(tokenId)}/pools?page=1`);
    if (!response.ok) return null;
    const payload = await response.json() as { data?: Array<{ attributes?: Record<string, unknown>; relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } } }> };
    const pools = (payload.data ?? []).filter((pool) => Number(pool.attributes?.reserve_in_usd ?? 0) > 0);
    pools.sort((left, right) => Number(right.attributes?.reserve_in_usd ?? 0) - Number(left.attributes?.reserve_in_usd ?? 0));
    const pool = pools[0];
    if (!pool?.attributes) return null;
    const attrs = pool.attributes;
    const isBase = pool.relationships?.base_token?.data?.id === `near_${tokenId}`;
    const changes = attrs.price_change_percentage as { h24?: string } | undefined;
    return {
      address: String(attrs.address ?? ''),
      priceUsd: Number((isBase ? attrs.base_token_price_usd : attrs.quote_token_price_usd) ?? 0),
      liquidity: Number(attrs.reserve_in_usd ?? 0),
      volume24h: Number((attrs.volume_usd as { h24?: string } | undefined)?.h24 ?? 0),
      fdv: Number(attrs.fdv_usd ?? attrs.market_cap_usd ?? 0),
      change24h: isBase ? Number(changes?.h24 ?? 0) : 0,
      name: String(attrs.name ?? ''),
      dex: String(pool.relationships?.dex?.data?.id ?? 'ref-finance'),
    };
  } catch {
    return null;
  }
}

async function detectNearToken(tokenId: string): Promise<DetectedToken | null> {
  const [pairs, geckoPool, metadata] = await Promise.all([
    fetchDexScreener(tokenId).catch(() => [] as DexScreenerPair[]),
    fetchGeckoNearPool(tokenId),
    getTokenMetadata(tokenId).catch(() => null),
  ]);
  const pair = pairs
    .filter((item) => item.chainId === 'near' && (item.baseToken.address === tokenId || item.quoteToken?.address === tokenId))
    .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0))[0];
  if (!pair && !geckoPool && !metadata) return null;

  const isBase = pair ? pair.baseToken.address === tokenId : true;
  const token = pair ? (isBase ? pair.baseToken : pair.quoteToken!) : undefined;
  const paired = pair ? (isBase ? pair.quoteToken : pair.baseToken) : undefined;
  const source = pair?.dexId ? venueName(pair.dexId) : geckoPool ? venueName(geckoPool.dex) : 'Ref Finance';
  return {
    address: tokenId,
    name: token?.name ?? metadata?.name ?? tokenId,
    symbol: token?.symbol ?? metadata?.symbol ?? 'UNKNOWN',
    decimals: metadata?.decimals ?? 18,
    chainId: NEAR_CHAIN_ID,
    chainType: 'NEAR',
    chainName: NEAR_CHAIN.name,
    chainColor: NEAR_CHAIN.color,
    // DexScreener prices a pair's base token; GeckoTerminal covers quote-side scans.
    priceUsd: pair && isBase ? Number(pair.priceUsd ?? 0) : geckoPool?.priceUsd ?? 0,
    liquidity: pair?.liquidity?.usd ?? geckoPool?.liquidity ?? 0,
    volume24h: pair?.volume?.h24 ?? geckoPool?.volume24h ?? 0,
    fdv: pair?.fdv ?? geckoPool?.fdv ?? 0,
    change24h: pair && isBase ? pair.priceChange?.h24 ?? 0 : geckoPool?.change24h ?? 0,
    pairAddress: geckoPool?.address || undefined,
    geckoNetwork: geckoPool?.address ? 'near' : undefined,
    freshDeployment: !pair && !geckoPool,
    liquiditySource: source,
    pairedAsset: paired ? { address: paired.address, name: paired.name, symbol: paired.symbol } : undefined,
    marketStatus: pair || geckoPool ? 'live' : 'none',
    marketSource: pair ? 'DexScreener' : geckoPool ? 'GeckoTerminal' : undefined,
    ...(pair ? pairExtras(pair, isBase) : {}),
  };
}

/**
 * The DexScreener pair to describe the scanned token with, on a Hopr chain.
 * Pairs where the token is the base are preferred (their price, FDV and
 * changes describe the token itself); a quote-side pair is used only when it
 * is far deeper or nothing else exists, and its price is then inverted.
 */
function bestPair(pairs: DexScreenerPair[], address: string, allow: (chainId: number) => boolean = () => true): DexScreenerPair | undefined {
  const evm = isEvmAddress(address);
  const same = (candidate?: string) => !!candidate && (evm ? candidate.toLowerCase() === address.toLowerCase() : candidate === address);
  const eligible = pairs
    .filter((pair) => {
      const chainId = DEXSCREENER_CHAIN_SLUGS[pair.chainId.toLowerCase()];
      return chainId !== undefined && allow(chainId) && (same(pair.baseToken.address) || same(pair.quoteToken?.address));
    })
    .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0));
  const deepest = eligible[0];
  const deepestBase = eligible.find((pair) => same(pair.baseToken.address));
  if (!deepest || !deepestBase || deepestBase === deepest) return deepestBase ?? deepest;
  // A base-side pool with real depth wins; otherwise the (much deeper) quote-side pool.
  return (deepestBase.liquidity?.usd ?? 0) >= Math.min(1_000, (deepest.liquidity?.usd ?? 0) * 0.01) ? deepestBase : deepest;
}

/** GeckoTerminal is asked this long after DexScreener if DexScreener has not answered yet. */
const GECKO_HEDGE_MS = 600;
const SOLANA_ID = 1151111081099710;

/** A Solana mint that exists on-chain (its account is owned by a token program). */
async function solanaMintExists(mint: string): Promise<boolean> {
  try {
    const account = await jsonRpcRace<{ value: { owner?: string } | null }>(SOLANA_ID, 'getAccountInfo', [mint, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }], {
      timeoutMs: 3_000, validate: (value) => value !== undefined && value !== null && 'value' in value,
    });
    return Boolean(account.value?.owner && /^Token/.test(account.value.owner));
  } catch {
    return false;
  }
}

/** Every detection ends here: fill gaps from backup sources and label how complete the market data is. */
async function finalize(token: DetectedToken | null): Promise<DetectedToken | null> {
  if (!token) return null;
  const labelled: DetectedToken = { ...token, marketStatus: token.marketStatus ?? (token.freshDeployment && !(token.priceUsd > 0) ? 'none' : 'live') };
  return enrichMarket(labelled).catch(() => labelled);
}

async function solanaFallback(address: string): Promise<DetectedToken | null> {
  const solChain = SUPPORTED_CHAINS.find((c) => c.key === 'sol')!;
  // Neither DEX indexer nor Jupiter answered: a mint that exists on-chain is still a real token.
  const exists = await solanaMintExists(address);
  if (!exists) return null;
  return {
    address,
    name: 'Unverified SPL Token',
    symbol: 'UNKNOWN',
    decimals: 9,
    chainId: solChain.id,
    chainType: 'SVM',
    chainName: solChain.name,
    chainColor: solChain.color,
    priceUsd: 0,
    liquidity: 0,
    volume24h: 0,
    fdv: 0,
    change24h: 0,
    freshDeployment: true,
    onChain: true,
    marketStatus: 'none',
  };
}

export async function detectChain(address: string, chainHint?: number): Promise<DetectedToken | null> {
  return finalize(await detectChainRaw(address, chainHint));
}

async function detectChainRaw(address: string, chainHint?: number): Promise<DetectedToken | null> {
  // Pool discovery knows the chain. Do not let the same EVM address on another chain win.
  if (chainHint !== undefined) {
    if (chainHint === NEAR_CHAIN_ID) return isNearAccountId(address) ? detectNearToken(address) : null;
    const chain = SUPPORTED_CHAINS.find((c) => c.id === chainHint);
    if (!chain || (chain.type === 'EVM' ? !isEvmAddress(address) : !isBase58(address))) return null;
    // Every market source at once; whichever finds the token first answers.
    const indexed = await firstHit<DetectedToken>([
      { delayMs: 0, run: async () => {
        const market = await fetchGeckoTerminalMarket(address, chain);
        return market ? geckoMarketToToken(market, chain, address) : null;
      } },
      { delayMs: 0, run: async () => {
        const pair = bestPair(await fetchDexScreener(address), address, (id) => id === chainHint);
        return pair ? pairToDetectedToken(pair, chain.id, chain, address) : null;
      } },
      ...(chain.type === 'SVM' ? [{ delayMs: 300, run: () => fetchJupiterToken(address) }] : []),
    ]);
    if (indexed) return indexed;
    if (chain.type === 'EVM') {
      const metadata = await readErc20Metadata(chain.id, address);
      if (!metadata) return null;
      return { address, ...metadata, chainId: chain.id, chainName: chain.name, chainType: 'EVM', chainColor: chain.color,
        priceUsd: 0, liquidity: 0, volume24h: 0, fdv: 0, change24h: 0, freshDeployment: true };
    }
    return solanaFallback(address);
  }
  const nearId = address.trim().toLowerCase();
  if (!isEvmAddress(address) && !isBase58(address) && isNearAccountId(nearId)) {
    return detectNearToken(nearId);
  }

  if (isBase58(address)) {
    const solChain = SUPPORTED_CHAINS.find((c) => c.key === 'sol')!;
    const indexed = await firstHit<DetectedToken>([
      { delayMs: 0, run: async () => {
        const pair = bestPair(await fetchDexScreener(address), address, (id) => id === SOLANA_ID);
        return pair ? pairToDetectedToken(pair, solChain.id, solChain, address) : null;
      } },
      // Jupiter indexes every tradable Solana token (pump.fun included) and is a different provider.
      { delayMs: 300, run: () => fetchJupiterToken(address) },
      { delayMs: GECKO_HEDGE_MS, run: async () => {
        const market = await fetchGeckoTerminalMarket(address, solChain);
        return market ? geckoMarketToToken(market, solChain, address) : null;
      } },
    ]);
    return indexed ?? solanaFallback(address);
  }

  if (isEvmAddress(address)) {
    // A token with no market yet is found on-chain; start that probe if the markets are slow.
    let probe: Promise<DetectedToken | null> | null = null;
    const probeTimer = setTimeout(() => { probe = probeEvmChains(address).catch(() => null); }, GECKO_HEDGE_MS + 400);
    const indexed = await firstHit<DetectedToken>([
      // DexScreener first: it covers Uniswap, PancakeSwap, Aerodrome and launchpads like Flap and Four.meme.
      { delayMs: 0, run: async () => {
        const indexedPair = bestPair(await fetchDexScreener(address), address, (id) => id !== SOLANA_ID);
        if (!indexedPair) return null;
        const chainId = DEXSCREENER_CHAIN_SLUGS[indexedPair.chainId.toLowerCase()];
        const chainInfo = SUPPORTED_CHAINS.find((c) => c.id === chainId);
        if (!chainInfo) return null;
        if (chainId === 4663) {
          // PonsFamily can launch against a tokenized stock quote. Prefer the
          // canonical GeckoTerminal pool name on Robinhood so AAPL/GOOGL is
          // retained instead of being flattened to USD by another indexer.
          const [canonicalPool, ponsPair] = await Promise.all([fetchGeckoTerminalMarket(address, chainInfo), fetchPonsPairToken(address)]);
          if (canonicalPool) return geckoMarketToToken(canonicalPool, chainInfo, address);
          const detected = pairToDetectedToken(indexedPair, chainId, chainInfo, address);
          if (ponsPair) detected.pairedAsset = ponsPair;
          return detected;
        }
        return pairToDetectedToken(indexedPair, chainId, chainInfo, address);
      } },
      // One GeckoTerminal search across every chain (launchpad pools DexScreener hasn't indexed).
      { delayMs: GECKO_HEDGE_MS, run: async () => {
        const hit = await fetchGeckoSearchMarket(address);
        return hit && hit.chain.type === 'EVM' ? geckoMarketToToken(hit.market, hit.chain, address) : null;
      } },
    ]);
    clearTimeout(probeTimer);
    if (indexed) return indexed;

    // Not indexed by a DEX tracker (fresh deployment, or the trackers are busy): find the chain by
    // its bytecode and, at the same time, ask DefiLlama which chain prices it.
    const evmIds = SUPPORTED_CHAINS.filter((c) => c.type === 'EVM').map((c) => c.id);
    const [freshToken, prices] = await Promise.all([
      probe ?? probeEvmChains(address).catch(() => null),
      fetchLlamaPrices(address, evmIds).catch(() => [] as LlamaPrice[]),
    ]);
    const priced = prices.find((item) => item.chainId === freshToken?.chainId) ?? prices[0];
    let token = freshToken;
    if (priced && (!token || token.chainId !== priced.chainId)) {
      const chain = SUPPORTED_CHAINS.find((c) => c.id === priced.chainId)!;
      const metadata = await readErc20Metadata(chain.id, address);
      token = { address, name: metadata?.name ?? priced.symbol ?? 'Token', symbol: metadata?.symbol ?? priced.symbol?.toUpperCase() ?? 'UNKNOWN',
        decimals: metadata?.decimals ?? priced.decimals ?? 18, chainId: chain.id, chainType: 'EVM', chainName: chain.name, chainColor: chain.color,
        priceUsd: 0, liquidity: 0, volume24h: 0, fdv: 0, change24h: 0, freshDeployment: true };
    }
    if (token && priced && token.chainId === priced.chainId) {
      token = { ...token, priceUsd: priced.price, marketStatus: 'partial', marketSource: 'DefiLlama' };
    }
    if (token && token.chainId === 4663) {
      const ponsPair = await fetchPonsPairToken(address);
      if (ponsPair) token.pairedAsset = ponsPair;
    }
    return token;
  }

  return null;
}

const CHAIN_LOGO_KEYS: Record<number, string> = {
  1151111081099710: 'sol',
  42161: 'arb',
  8453: 'base',
  56: 'bsc',
  4663: 'rhc',
  5042: 'arc',
  [NEAR_CHAIN_ID]: 'near',
};

const TOKEN_EXPLORERS: Record<number, string> = {
  1151111081099710: 'https://solscan.io/token/',
  42161: 'https://arbiscan.io/token/',
  8453: 'https://basescan.org/token/',
  56: 'https://bscscan.com/token/',
  [NEAR_CHAIN_ID]: 'https://nearblocks.io/token/',
};

/** Block-explorer page for a token, when the chain has a known explorer. */
export function tokenExplorerUrl(chainId: number, address: string): string | undefined {
  const base = TOKEN_EXPLORERS[chainId];
  return base ? `${base}${encodeURIComponent(address)}` : undefined;
}

/** Human pool age: 45m, 7h, 12d, 1.5y. */
export function formatAge(createdAtMs: number | undefined): string | undefined {
  if (!createdAtMs || !Number.isFinite(createdAtMs)) return undefined;
  const minutes = Math.max(0, (Date.now() - createdAtMs) / 60_000);
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 525_600) return `${Math.floor(minutes / 1440)}d`;
  return `${(minutes / 525_600).toFixed(1).replace(/\.0$/, '')}y`;
}

/** ChainLogo key for a chain id (falls back to the generic chain mark). */
export function chainKeyForId(chainId: number): string {
  return CHAIN_LOGO_KEYS[chainId] ?? 'unknown';
}

export function getChainById(chainId: number): ChainInfo | undefined {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId);
}

export function getChainByKey(key: string): ChainInfo | undefined {
  return SUPPORTED_CHAINS.find((c) => c.key === key);
}

export function formatAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * A real decimal with `digits` significant figures — never scientific notation.
 * 0.000651234 → "0.0006512", 0.00000001234 → "0.00000001234".
 */
export function formatSignificant(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.min(20, Math.max(0, digits - magnitude - 1));
  const text = value.toFixed(decimals);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** Format a displayed numeric value, compacting large values and keeping small ones as real decimals. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0.00';

  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  if (absolute >= 0.01) return value.toFixed(2);
  return formatSignificant(value, 3);
}

export function formatUsd(value: number): string {
  const formatted = formatNumber(value);
  return formatted === '—' ? formatted : `$${formatted}`;
}

/** Token price as a real decimal: $2,657.51, $1.2345, $0.004213, $0.0000006512. */
export function formatTokenPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value >= 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (value >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${formatSignificant(value, 4)}`;
}
