import { viewFunction, type NearRpcOptions } from './nearService';
import { jsonRpc } from './rpcPool';

export type LaunchpadId =
  | 'nearpaid' | 'pons' | 'pump' | 'tolly' | 'argus' | 'pumpswap' | 'launchlab' | 'moonit' | 'letsbonk' | 'virtuals'
  | 'flap' | 'fourmeme' | 'clanker' | 'bankr' | 'bags' | 'meteoradbc'
  | 'uniswap' | 'pancakeswap' | 'aerodrome';

/** One GeckoTerminal venue: a DEX id on a network. */
export interface GeckoVenue { network: string; chainId: number; dex: string }

export interface Launchpad {
  id: LaunchpadId;
  name: string;
  /** 'launchpad': tokens here launched here. 'dex': a trading venue, listed for tracking only. */
  kind: 'launchpad' | 'dex';
  /** Primary network (for the source's logo and link). */
  network: string;
  chainId: number;
  website: string;
  /** GeckoTerminal venue ids on the primary network. */
  dexes: readonly string[];
  /** Venues on other networks too (multi-chain sources). */
  markets?: readonly GeckoVenue[];
}

const venuePage = (network: string, dex: string) => `https://www.geckoterminal.com/${network}/${dex}/pools`;

/** Venue IDs verified against the providers' public registries. Never infer origin from a ticker. */
export const LAUNCHPADS: readonly Launchpad[] = [
  { id: 'nearpaid', name: 'NEARPaid', kind: 'launchpad', network: 'near', chainId: 397, website: 'https://nearpaid.com', dexes: [] },
  { id: 'flap', name: 'Flap', kind: 'launchpad', network: 'bsc', chainId: 56, website: 'https://flap.sh', dexes: [] },
  { id: 'fourmeme', name: 'Four.meme', kind: 'launchpad', network: 'bsc', chainId: 56, website: 'https://four.meme', dexes: ['four-meme'] },
  { id: 'pons', name: 'pons', kind: 'launchpad', network: 'robinhood', chainId: 4663, website: 'https://www.ponsfamily.com/launchpad', dexes: ['pons-dot-family', 'pons-v2', 'pons-v2-dex'] },
  { id: 'pump', name: 'Pump.fun', kind: 'launchpad', network: 'solana', chainId: 1151111081099710, website: 'https://pump.fun', dexes: ['pump-fun'] },
  { id: 'clanker', name: 'Clanker', kind: 'launchpad', network: 'robinhood', chainId: 4663, website: 'https://www.clanker.world', dexes: ['clanker-robinhood'] },
  { id: 'bankr', name: 'Bankr', kind: 'launchpad', network: 'robinhood', chainId: 4663, website: 'https://bankr.bot', dexes: ['bankr-robinhood'] },
  { id: 'tolly', name: 'Tolly', kind: 'launchpad', network: 'arc', chainId: 5042, website: 'https://tollylabs.com', dexes: [] },
  { id: 'argus', name: 'Argus', kind: 'launchpad', network: 'arc', chainId: 5042, website: 'https://argus.world', dexes: ['argus'] },
  { id: 'pumpswap', name: 'PumpSwap', kind: 'launchpad', network: 'solana', chainId: 1151111081099710, website: 'https://swap.pump.fun', dexes: ['pumpswap'] },
  { id: 'launchlab', name: 'LaunchLab', kind: 'launchpad', network: 'solana', chainId: 1151111081099710, website: 'https://raydium.io', dexes: ['raydium-launchlab'] },
  { id: 'letsbonk', name: 'LetsBonk', kind: 'launchpad', network: 'solana', chainId: 1151111081099710, website: 'https://letsbonk.fun', dexes: ['letsbonk-fun'] },
  { id: 'bags', name: 'Bags', kind: 'launchpad', network: 'solana', chainId: 1151111081099710, website: 'https://bags.fm', dexes: ['bags-fm'] },
  { id: 'meteoradbc', name: 'Meteora DBC', kind: 'launchpad', network: 'solana', chainId: 1151111081099710, website: venuePage('solana', 'meteora-dbc'), dexes: ['meteora-dbc'] },
  { id: 'moonit', name: 'Moonit', kind: 'launchpad', network: 'solana', chainId: 1151111081099710, website: 'https://moon.it', dexes: ['moonit'] },
  { id: 'virtuals', name: 'Virtuals', kind: 'launchpad', network: 'base', chainId: 8453, website: 'https://app.virtuals.io', dexes: ['virtuals-base', 'virtuals-unicorn-base'],
    markets: [{ network: 'robinhood', chainId: 4663, dex: 'virtuals-robinhood' }] },
  { id: 'uniswap', name: 'Uniswap', kind: 'dex', network: 'robinhood', chainId: 4663, website: 'https://app.uniswap.org', dexes: ['uniswap-v3-robinhood', 'uniswap-v4-robinhood'],
    markets: [
      { network: 'base', chainId: 8453, dex: 'uniswap-v3-base' },
      { network: 'base', chainId: 8453, dex: 'uniswap-v4-base' },
      { network: 'arbitrum', chainId: 42161, dex: 'uniswap_v3_arbitrum' },
    ] },
  { id: 'pancakeswap', name: 'PancakeSwap', kind: 'dex', network: 'bsc', chainId: 56, website: 'https://pancakeswap.finance', dexes: ['pancakeswap-v3-bsc', 'pancakeswap_v2'] },
  { id: 'aerodrome', name: 'Aerodrome', kind: 'dex', network: 'base', chainId: 8453, website: 'https://aerodrome.finance', dexes: ['aerodrome-slipstream', 'aerodrome-base'] },
];

/** Every GeckoTerminal venue a source reads: its primary-network dexes plus any other markets. */
export function sourceVenues(source: Launchpad): GeckoVenue[] {
  return [...source.dexes.map((dex) => ({ network: source.network, chainId: source.chainId, dex })), ...(source.markets ?? [])];
}

/** How long a snapshot is served before refetching. Flap reads fresh launches, so it refreshes fastest. */
export function feedRefreshMs(id: LaunchpadId): number {
  return id === 'flap' ? 20_000 : id === 'nearpaid' || id === 'tolly' ? 90_000 : 60_000;
}
export type PoolSort = 'volume' | 'liquidity' | 'newest';
export interface LaunchpadPool {
  id: string;
  source: LaunchpadId;
  venue: string;
  chainId: number;
  network: string;
  poolAddress: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  quoteSymbol: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  change24h: number | null;
  createdAt: number | null;
  observedAt: number;
  url: string;
}
export interface LaunchpadFeed {
  source: LaunchpadId;
  pools: LaunchpadPool[];
  observedAt: number;
  stale: boolean;
  partial: boolean;
  /** Listings are a bounded provider snapshot, not a complete historical index. */
  coverage: string;
}
type Json = Record<string, any>;
export const launchpadById = (id: string) => LAUNCHPADS.find((source) => source.id === id);
export function metric(value: unknown, signed = false): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && (signed || n >= 0) ? n : null;
}
const identity = (address: string, chainId: number) => chainId === 1151111081099710 ? address : address.toLowerCase();
function validToken(address: string, chainId: number): boolean {
  return chainId === 397 ? /^[a-z0-9][a-z0-9._-]{1,63}$/.test(address)
    : chainId === 1151111081099710 ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[0-9a-f]{40}$/i.test(address);
}
function validPool(address: string, chainId: number): boolean {
  return chainId === 397 ? address.length > 0 && address.length < 200
    : chainId === 1151111081099710 ? validToken(address, chainId) : /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(address);
}
export function uniquePools(pools: LaunchpadPool[]): LaunchpadPool[] {
  return [...new Map(pools.map((pool) => [pool.id, pool])).values()];
}
export function sortPools(pools: LaunchpadPool[], sort: PoolSort): LaunchpadPool[] {
  const field = sort === 'newest' ? 'createdAt' : sort === 'liquidity' ? 'liquidityUsd' : 'volume24h';
  return [...pools].sort((a, b) => (b[field] ?? -1) - (a[field] ?? -1) || a.id.localeCompare(b.id));
}
export function parseGeckoPools(payload: Json, source: Pick<Launchpad, 'id' | 'network' | 'chainId'>, dex: string, now = Date.now()): LaunchpadPool[] {
  if (!Array.isArray(payload.data)) throw new Error('Invalid pool response');
  const tokens = new Map((payload.included ?? []).map((t: Json) => [t.id, t.attributes])) as Map<string, Json>;
  return payload.data.flatMap((row: Json) => {
    const a = row.attributes ?? {};
    // A shared Uniswap venue is not evidence that a launch came from a specific launchpad.
    if (row.relationships?.dex?.data?.id !== dex) return [];
    const tokenRef = row.relationships?.base_token?.data?.id ?? '';
    if (!tokenRef.startsWith(`${source.network}_`)) return [];
    const tokenAddress = tokenRef.slice(source.network.length + 1);
    const poolAddress = String(a.address ?? '');
    if (!validToken(tokenAddress, source.chainId) || !validPool(poolAddress, source.chainId)) return [];
    const token = tokens.get(tokenRef);
    const quote = tokens.get(row.relationships?.quote_token?.data?.id);
    const symbols = String(a.name ?? '').split(' / ');
    return [{ id: `${source.chainId}:${identity(poolAddress, source.chainId)}`, source: source.id,
      venue: dex, network: source.network, chainId: source.chainId, poolAddress, tokenAddress,
      symbol: String(token?.symbol ?? symbols[0] ?? 'Token'), name: String(token?.name ?? symbols[0] ?? 'Token'),
      quoteSymbol: String(quote?.symbol ?? symbols[1] ?? '').replace(/\s+\d+(?:\.\d+)?%$/, ''),
      priceUsd: metric(a.base_token_price_usd), liquidityUsd: metric(a.reserve_in_usd),
      volume24h: metric(a.volume_usd?.h24), change24h: metric(a.price_change_percentage?.h24, true),
      createdAt: metric(Date.parse(a.pool_created_at)), observedAt: now,
      url: `https://www.geckoterminal.com/${source.network}/pools/${encodeURIComponent(poolAddress)}` }];
  });
}
export function parseTollyPools(payload: Json, now = Date.now()): LaunchpadPool[] {
  if (!Array.isArray(payload.tokens)) throw new Error('Invalid Tolly response');
  return payload.tokens.flatMap((t: Json) => {
    if (t.tolly !== true || !validToken(t.address ?? '', 5042) || !validPool(t.pool ?? '', 5042)) return [];
    const v4 = t.pool.length === 66;
    // Never use a singleton PoolManager's aggregate balance as a pool's TVL.
    const trustedLiquidity = !v4 || ['poolmanager-extsload', 'pools-trade-api'].includes(t.liquiditySource);
    return [{ id: `5042:${t.pool.toLowerCase()}`, source: 'tolly' as const, venue: 'Tolly', chainId: 5042, network: 'arc',
      poolAddress: t.pool, tokenAddress: t.address, symbol: String(t.symbol || 'Token'), name: String(t.name || t.symbol || 'Token'),
      quoteSymbol: '', priceUsd: metric(t.price), liquidityUsd: trustedLiquidity ? metric(t.liquidity) : null,
      volume24h: metric(t.volume24h), change24h: metric(t.change24h, true), createdAt: metric(t.created_ts) === null ? null : Number(t.created_ts) * 1000,
      observedAt: now, url: `https://www.geckoterminal.com/arc/pools/${encodeURIComponent(t.pool)}` }];
  });
}

async function json(url: string): Promise<Json> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7_000) });
  if (!response.ok) throw new Error(`Market provider HTTP ${response.status}`);
  return response.json();
}

export function nearPoolPrice(pool: Json, token: string, tokenDecimals: number, quoteDecimals: number, quoteUsd: number | null): number | null {
  if (quoteUsd === null || !Number.isInteger(pool.current_point)) return null;
  const rawYPerX = Math.pow(1.0001, pool.current_point);
  const ratio = pool.token_x === token ? rawYPerX : pool.token_y === token ? 1 / rawYPerX : NaN;
  return metric(ratio * 10 ** (tokenDecimals - quoteDecimals) * quoteUsd);
}

async function nearpaidPools(options?: NearRpcOptions): Promise<{ pools: LaunchpadPool[]; partial: boolean }> {
  const config = await viewFunction<Json>('nearpaid.near', 'get_config', {}, options);
  if (!Number.isSafeInteger(config.total_launches) || config.total_launches < 0 || config.dcl !== 'dclv2.ref-labs.near') throw new Error('NEARPaid registry changed');
  const launches = await viewFunction<Json[]>('nearpaid.near', 'list_launches', { from_index: Math.max(0, config.total_launches - 20), limit: 20 }, options);
  if (!Array.isArray(launches)) throw new Error('Invalid NEARPaid launches');
  const prices: Json = await json('https://api.ref.finance/list-token-price').catch(() => ({}));
  const live = launches.filter((l) => l.status === 'live').reverse().slice(0, 10);
  const results: PromiseSettledResult<LaunchpadPool>[] = [];
  // Bounded batches avoid exhausting public NEAR RPC and Worker subrequest limits.
  for (let i = 0; i < live.length; i += 2) results.push(...await Promise.allSettled(live.slice(i, i + 2).map(async (l) => {
    if (!validToken(l.token, 397) || !validToken(l.quote, 397)) throw new Error('Invalid launch');
    const [pool, meta, quote] = await Promise.all([
      viewFunction<Json>('dclv2.ref-labs.near', 'get_pool', { pool_id: l.pool_id }, options),
      viewFunction<Json>(l.token, 'ft_metadata', {}, options), viewFunction<Json>(l.quote, 'ft_metadata', {}, options),
    ]);
    if (pool.pool_id !== l.pool_id || ![pool.token_x, pool.token_y].includes(l.token) || ![pool.token_x, pool.token_y].includes(l.quote)
      || pool.state !== 'Running' || !Number.isInteger(meta.decimals) || !Number.isInteger(quote.decimals)
      || meta.decimals < 0 || meta.decimals > 36 || quote.decimals < 0 || quote.decimals > 36) throw new Error('Pool identity or metadata mismatch');
    const quoteUsd = metric(prices[l.quote]?.price);
    const priceUsd = nearPoolPrice(pool, l.token, meta.decimals, quote.decimals, quoteUsd);
    const tokenAmount = metric(pool.token_x === l.token ? pool.total_x : pool.total_y);
    const quoteAmount = metric(pool.token_x === l.token ? pool.total_y : pool.total_x);
    const liquidityUsd = priceUsd !== null && quoteUsd !== null && tokenAmount !== null && quoteAmount !== null
      ? metric(tokenAmount / 10 ** meta.decimals * priceUsd + quoteAmount / 10 ** quote.decimals * quoteUsd) : null;
    return { id: `397:dclv2.ref-labs.near:${l.pool_id}`, source: 'nearpaid' as const, venue: 'Rhea DCL', chainId: 397, network: 'near',
      poolAddress: l.pool_id, tokenAddress: l.token, symbol: String(meta.symbol || l.symbol), name: String(meta.name || l.name), quoteSymbol: String(quote.symbol),
      priceUsd, liquidityUsd, volume24h: null, change24h: null, createdAt: metric(l.created_at_ms), observedAt: Date.now(),
      url: `https://dex.rhea.finance/poolV2/${encodeURIComponent(l.pool_id)}` };
  })));
  const pools = results.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
  if (live.length && !pools.length) throw new Error('NEARPaid pool reads failed');
  return { pools, partial: results.some((r) => r.status === 'rejected') };
}

// ---------------------------------------------------------------------------
// Flap (flap.sh): GeckoTerminal does not index it, so launches are read straight
// from the Portal's TokenCreated events and priced with one DexScreener batch
// per chain. A launch shows up seconds after it happens, before any indexer.
// Addresses: https://docs.flap.sh/flap/developers/deployed-contract-addresses
// ---------------------------------------------------------------------------

/** keccak256("TokenCreated(uint256,address,uint256,address,string,string,string)") — verified against live Portal logs. */
export const FLAP_TOKEN_CREATED = '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603';

export const FLAP_PORTALS = [
  // Log-capable RPCs first (the default BSC/Base endpoints refuse or cap eth_getLogs); the pool's other backups follow.
  { chainId: 56, network: 'bsc', portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0', blocks: 1500, logRpcs: ['https://bsc-rpc.publicnode.com'] },
  { chainId: 4663, network: 'robinhood', portal: '0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09', blocks: 8000, logRpcs: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'] },
  { chainId: 8453, network: 'base', portal: '0x0000BC1c4fD15Dd79029AF8F5d77D68ae4490000', blocks: 5000, logRpcs: ['https://base-rpc.publicnode.com'] },
] as const;

const FLAP_LAUNCHES_PER_CHAIN = 24;

/** Decode TokenCreated data: (uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta). */
export function decodeFlapTokenCreated(data: string): { ts: number; token: string; name: string; symbol: string } | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length < 64 * 7 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const word = (index: number) => hex.slice(index * 64, (index + 1) * 64);
  const text = (offsetWord: number) => {
    const offset = Number.parseInt(word(offsetWord), 16) * 2;
    const length = Number.parseInt(hex.slice(offset, offset + 64), 16);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length > 256 || offset + 64 + length * 2 > hex.length) return '';
    const bytes = hex.slice(offset + 64, offset + 64 + length * 2).match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
    return new TextDecoder().decode(new Uint8Array(bytes)).replace(/[\u0000-\u001f]/g, '').trim();
  };
  const ts = Number.parseInt(word(0), 16);
  const token = `0x${word(3).slice(24)}`;
  if (!Number.isSafeInteger(ts) || !validToken(token, 1)) return null;
  return { ts, token, name: text(4), symbol: text(5) };
}

async function flapChainPools(chain: typeof FLAP_PORTALS[number], now: number): Promise<LaunchpadPool[]> {
  const head = Number.parseInt(await jsonRpc<string>(chain.chainId, 'eth_blockNumber', [], { extra: [...chain.logRpcs], timeoutMs: 5000 }), 16);
  if (!Number.isSafeInteger(head)) throw new Error('Invalid block number');
  const logs = await jsonRpc<Array<{ data: string; topics: string[] }>>(chain.chainId, 'eth_getLogs', [{
    address: chain.portal,
    topics: [FLAP_TOKEN_CREATED],
    fromBlock: `0x${Math.max(0, head - chain.blocks).toString(16)}`,
    toBlock: `0x${head.toString(16)}`,
  }], { extra: [...chain.logRpcs], timeoutMs: 6000, validate: (value) => Array.isArray(value) });
  const seen = new Set<string>();
  const launches = logs.slice().reverse().flatMap((log) => {
    const launch = decodeFlapTokenCreated(log.data);
    if (!launch || seen.has(launch.token.toLowerCase())) return [];
    seen.add(launch.token.toLowerCase());
    return [launch];
  }).slice(0, FLAP_LAUNCHES_PER_CHAIN);
  if (!launches.length) return [];

  // One DexScreener request prices up to 30 tokens (bonding-curve `flapsh` pools and migrated DEX pools alike).
  const pairs = await json(`https://api.dexscreener.com/tokens/v1/${chain.network}/${launches.map((launch) => launch.token).join(',')}`)
    .then((payload) => (Array.isArray(payload) ? payload : []) as Json[])
    .catch(() => [] as Json[]);
  const best = new Map<string, Json>();
  for (const pair of pairs) {
    const key = String(pair.baseToken?.address ?? '').toLowerCase();
    if (key && (pair.liquidity?.usd ?? 0) >= (best.get(key)?.liquidity?.usd ?? -1)) best.set(key, pair);
  }
  return launches.map((launch) => {
    const pair = best.get(launch.token.toLowerCase());
    const poolAddress = pair && validPool(String(pair.pairAddress ?? ''), chain.chainId) ? String(pair.pairAddress) : launch.token;
    return {
      id: `${chain.chainId}:${poolAddress.toLowerCase()}`, source: 'flap' as const, venue: pair?.dexId ? String(pair.dexId) : 'flapsh',
      chainId: chain.chainId, network: chain.network, poolAddress, tokenAddress: launch.token,
      symbol: String(pair?.baseToken?.symbol || launch.symbol || 'Token').slice(0, 40), name: String(pair?.baseToken?.name || launch.name || launch.symbol || 'Token').slice(0, 80),
      quoteSymbol: String(pair?.quoteToken?.symbol ?? ''),
      priceUsd: metric(pair?.priceUsd), liquidityUsd: metric(pair?.liquidity?.usd), volume24h: metric(pair?.volume?.h24),
      change24h: metric(pair?.priceChange?.h24, true), createdAt: launch.ts * 1000, observedAt: now,
      url: String(pair?.url ?? `https://dexscreener.com/${chain.network}/${launch.token}`),
    };
  });
}

async function flapPools(): Promise<{ pools: LaunchpadPool[]; partial: boolean }> {
  const now = Date.now();
  const results = await Promise.allSettled(FLAP_PORTALS.map((chain) => flapChainPools(chain, now)));
  if (results.every((result) => result.status === 'rejected')) throw new Error('Flap launches could not be read');
  return {
    pools: results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
    partial: results.some((result) => result.status === 'rejected'),
  };
}

export async function fetchLaunchpadFeed(id: LaunchpadId, nearOptions?: NearRpcOptions): Promise<LaunchpadFeed> {
  const source = launchpadById(id);
  if (!source) throw new Error('Unknown launchpad');
  let pools: LaunchpadPool[]; let partial = false;
  if (id === 'nearpaid') ({ pools, partial } = await nearpaidPools(nearOptions));
  else if (id === 'flap') ({ pools, partial } = await flapPools());
  else if (id === 'tolly') pools = parseTollyPools(await json('https://api.tollylabs.com/tokens?scope=tolly&sort=volume&dir=desc&limit=40&offset=0'));
  else {
    // Every venue (and network) of the source at once; one failing venue leaves a partial feed.
    const results = await Promise.allSettled(sourceVenues(source).map(async (venue) => parseGeckoPools(
      await json(`https://api.geckoterminal.com/api/v2/networks/${venue.network}/dexes/${venue.dex}/pools?include=base_token,quote_token`),
      { id: source.id, network: venue.network, chainId: venue.chainId }, venue.dex)));
    if (results.every((r) => r.status === 'rejected')) throw new Error('Pool provider could not refresh');
    partial = results.some((r) => r.status === 'rejected');
    pools = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
  }
  return { source: id, pools: uniquePools(pools), partial, stale: false, observedAt: Date.now(),
    coverage: id === 'nearpaid' ? 'Up to 10 live pools from the latest 20 launches · on-chain reads · 24h history not indexed'
      : id === 'flap' ? `Latest ${FLAP_LAUNCHES_PER_CHAIN} launches per chain (BNB · Robinhood · Base) · read from Flap's on-chain Portal events · priced by DexScreener`
      : id === 'tolly' ? 'Top 40 Tolly listings by volume · Tolly market API'
      : source.kind === 'dex' ? 'Top indexed pools per venue and chain · GeckoTerminal · a DEX listing is not a launchpad attribution'
      : 'Top indexed pools per venue · GeckoTerminal · includes pools with depleted liquidity' };
}
