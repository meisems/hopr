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
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
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

async function fetchDexScreener(address: string): Promise<DexScreenerPair[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { pairs?: DexScreenerPair[] };
  return data.pairs ?? [];
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
    const response = await fetch('https://rpc.mainnet.chain.robinhood.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: PONS_V2_FACTORY, data }, 'latest'] }),
    });
    const payload = await response.json() as { result?: string };
    const encoded = payload.result ?? '';
    if (!encoded.startsWith('0x') || encoded.length < 2 + 32 * 12 * 2) return null;
    const word = (index: number) => encoded.slice(2 + index * 64, 2 + (index + 1) * 64);
    if (!word(11).endsWith('1')) return null;
    const pairedAddress = `0x${word(2).slice(24)}`;
    if (/^0x0+$/.test(pairedAddress)) return null;
    const metadata = await readErc20Metadata(SUPPORTED_CHAINS.find((chain) => chain.id === 4663)!.rpcUrl, pairedAddress);
    return { address: pairedAddress, symbol: metadata?.symbol ?? 'QUOTE', name: metadata?.name ?? 'Quote asset' };
  } catch {
    return null;
  }
}

function pairToDetectedToken(pair: DexScreenerPair, chainId: number, chainInfo: ChainInfo, scannedAddress: string): DetectedToken {
  const source = pair.dexId ? formatLiquiditySource(pair.dexId) : 'DexScreener';
  const scanned = scannedAddress.toLowerCase();
  const isQuote = pair.quoteToken?.address.toLowerCase() === scanned && pair.baseToken.address.toLowerCase() !== scanned;
  const token = isQuote && pair.quoteToken ? pair.quoteToken : pair.baseToken;
  const paired = isQuote ? pair.baseToken : pair.quoteToken;
  const robinhoodDefaultPair = chainInfo.id === 4663 && !paired ? { symbol: 'WETH', name: 'Wrapped Ether' } : undefined;
  return {
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    decimals: chainInfo.type === 'SVM' ? 9 : 18, // refined by on-chain call where available
    chainId,
    chainType: chainInfo.type,
    chainName: chainInfo.name,
    chainColor: chainInfo.color,
    priceUsd: Number(pair.priceUsd ?? 0),
    liquidity: pair.liquidity?.usd ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    fdv: pair.fdv ?? 0,
    change24h: pair.priceChange?.h24 ?? 0,
    pairAddress: pair.pairAddress,
    geckoNetwork: GECKO_NETWORKS[pair.chainId.toLowerCase()],
    freshDeployment: false,
    liquiditySource: source,
    launchpad: detectLaunchpad(source),
    pairedAsset: paired ? { address: paired.address, name: paired.name, symbol: paired.symbol } : robinhoodDefaultPair,
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
}

/**
 * GeckoTerminal is the fallback for fresh launchpad pools that are not yet
 * present in DexScreener. Its public API reads indexed on-chain pool state,
 * including reserve_in_usd and volume_usd.h24.
 */
async function fetchGeckoTerminalMarket(address: string, chain: ChainInfo): Promise<GeckoPoolMarket | null> {
  const network = GECKO_NETWORK_SLUGS[chain.key];
  if (!network) return null;
  try {
    const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`);
    if (!response.ok) return null;
    const payload = await response.json() as {
      data?: Array<{ id?: string; attributes?: Record<string, unknown>; relationships?: { dex?: { data?: { id?: string } }; base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } }>;
    };
    const pool = payload.data?.find((item) => Number(item.attributes?.reserve_in_usd ?? 0) > 0) ?? payload.data?.[0];
    if (!pool?.attributes) return null;
    const attrs = pool.attributes;
    const reserve = Number(attrs.reserve_in_usd ?? 0);
    if (!Number.isFinite(reserve) || reserve <= 0) return null;
    const volume = attrs.volume_usd as { h24?: number } | undefined;
    const poolName = String(attrs.name ?? 'Launchpad token');
    const pairSymbols = poolName.split(' / ').map((part) => part.replace(/\s+\d+(?:\.\d+)?%$/, '').trim());
    const fdv = Number(attrs.fdv_usd ?? attrs.market_cap_usd ?? 0);
    const poolId = pool.id?.split('_').pop() ?? '';
    const source = formatLiquiditySource(pool.relationships?.dex?.data?.id?.split('_').pop() ?? 'GeckoTerminal');
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
      ...geckoActivity(attrs, !scannedIsQuote),
    };
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

function formatLiquiditySource(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function detectLaunchpad(source: string): string | undefined {
  const normalized = source.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.includes('pump')) return 'Pump.fun';
  if (normalized.includes('stonk')) return 'StonkFun';
  if (normalized.includes('argus')) return 'ArgusWorld';
  if (normalized.includes('tolly')) return 'TollyLabs';
  if (normalized.includes('pons')) return 'PonsFamily';
  return undefined;
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
    launchpad: detectLaunchpad(market.source),
    pairedAsset: market.pairedAsset,
  };
}

/** eth_getCode probe: returns true if `address` has deployed bytecode on `rpcUrl`. */
async function hasBytecode(rpcUrl: string, address: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { result?: string };
    return !!data.result && data.result !== '0x';
  } catch {
    return false;
  }
}

async function readErc20Metadata(
  rpcUrl: string,
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
      calls.map(async ({ sig }) => {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: address, data: sig }, 'latest'],
          }),
        });
        const data = (await res.json()) as { result?: string };
        return data.result ?? '0x';
      })
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
      found: await hasBytecode(chain.rpcUrl, address),
    }))
  );

  const hit = probes.find((p) => p.found);
  if (!hit) return null;

  const metadata = await readErc20Metadata(hit.chain.rpcUrl, address);

  return {
    address,
    name: metadata?.name ?? 'Unknown Token',
    symbol: metadata?.symbol ?? 'UNKNOWN',
    decimals: metadata?.decimals ?? 18,
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
    const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/near/tokens/${encodeURIComponent(tokenId)}/pools?page=1`);
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
  const source = pair?.dexId ? formatLiquiditySource(pair.dexId) : geckoPool ? formatLiquiditySource(geckoPool.dex) : 'Ref Finance';
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
    ...(pair ? pairExtras(pair, isBase) : {}),
  };
}

export async function detectChain(address: string): Promise<DetectedToken | null> {
  const nearId = address.trim().toLowerCase();
  if (!isEvmAddress(address) && !isBase58(address) && isNearAccountId(nearId)) {
    return detectNearToken(nearId);
  }

  if (isBase58(address)) {
    const pairs = await fetchDexScreener(address);
    const solPair = pairs.find((p) => p.chainId === 'solana' && (p.baseToken.address === address || p.quoteToken?.address === address));
    const solChain = SUPPORTED_CHAINS.find((c) => c.key === 'sol')!;
    if (solPair) return pairToDetectedToken(solPair, solChain.id, solChain, address);

    const launchpadMarket = await fetchGeckoTerminalMarket(address, solChain);
    if (launchpadMarket) return geckoMarketToToken(launchpadMarket, solChain, address);

    // Not indexed yet — we can't probe Solana bytecode the same way as EVM,
    // so report it as a fresh/unverified Solana mint pending indexing.
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
    };
  }

  if (isEvmAddress(address)) {
    const pairs = await fetchDexScreener(address);
    const indexedPair = pairs.find((p) => {
      const sameChain = p.chainId.toLowerCase() in DEXSCREENER_CHAIN_SLUGS && p.chainId.toLowerCase() !== 'solana';
      const scanned = address.toLowerCase();
      return sameChain && (p.baseToken.address.toLowerCase() === scanned || p.quoteToken?.address.toLowerCase() === scanned);
    });
    if (indexedPair) {
      const chainId = DEXSCREENER_CHAIN_SLUGS[indexedPair.chainId.toLowerCase()];
      const chainInfo = SUPPORTED_CHAINS.find((c) => c.id === chainId);
      if (chainInfo) {
        // PonsFamily can launch against a tokenized stock quote. Prefer the
        // canonical GeckoTerminal pool name on Robinhood so AAPL/GOOGL is
        // retained instead of being flattened to USD by another indexer.
        if (chainId === 4663) {
          const canonicalPool = await fetchGeckoTerminalMarket(address, chainInfo);
          if (canonicalPool) return geckoMarketToToken(canonicalPool, chainInfo, address);
        }
        const detected = pairToDetectedToken(indexedPair, chainId, chainInfo, address);
        const ponsPair = await fetchPonsPairToken(address);
        if (ponsPair) detected.pairedAsset = ponsPair;
        return detected;
      }
    }

    const launchpadMarkets = await Promise.all(
      SUPPORTED_CHAINS.filter((chain) => chain.type === 'EVM').map(async (chain) => ({
        chain,
        market: await fetchGeckoTerminalMarket(address, chain),
      }))
    );
    const launchpadHit = launchpadMarkets.find((item) => item.market);
    if (launchpadHit?.market) return geckoMarketToToken(launchpadHit.market, launchpadHit.chain, address);

    // Not indexed (fresh deployment, or a chain DexScreener doesn't cover,
    // e.g. Robinhood Chain / Arc) — fall back to bytecode probing.
    const freshToken = await probeEvmChains(address);
    if (freshToken && freshToken.chainId === 4663) {
      const ponsPair = await fetchPonsPairToken(address);
      if (ponsPair) freshToken.pairedAsset = ponsPair;
    }
    return freshToken;
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
