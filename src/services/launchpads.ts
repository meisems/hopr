import { viewFunction, type NearRpcOptions } from './nearService';

/** Venue IDs verified against the providers' public registries. Never infer origin from a ticker. */
export const LAUNCHPADS = [
  { id: 'nearpaid', name: 'NEARPaid', network: 'near', chainId: 397, website: 'https://nearpaid.com', dexes: [] },
  { id: 'pons', name: 'pons', network: 'robinhood', chainId: 4663, website: 'https://www.ponsfamily.com/launchpad', dexes: ['pons-dot-family', 'pons-v2', 'pons-v2-dex'] },
  { id: 'pump', name: 'Pump.fun', network: 'solana', chainId: 1151111081099710, website: 'https://pump.fun', dexes: ['pump-fun'] },
  { id: 'tolly', name: 'Tolly', network: 'arc', chainId: 5042, website: 'https://tollylabs.com', dexes: [] },
  { id: 'argus', name: 'Argus', network: 'arc', chainId: 5042, website: 'https://argus.world', dexes: ['argus'] },
  { id: 'pumpswap', name: 'PumpSwap', network: 'solana', chainId: 1151111081099710, website: 'https://swap.pump.fun', dexes: ['pumpswap'] },
  { id: 'launchlab', name: 'LaunchLab', network: 'solana', chainId: 1151111081099710, website: 'https://raydium.io', dexes: ['raydium-launchlab'] },
  { id: 'moonit', name: 'Moonit', network: 'solana', chainId: 1151111081099710, website: 'https://moon.it', dexes: ['moonit'] },
  { id: 'letsbonk', name: 'LetsBonk', network: 'solana', chainId: 1151111081099710, website: 'https://letsbonk.fun', dexes: ['letsbonk-fun'] },
  { id: 'virtuals', name: 'Virtuals', network: 'base', chainId: 8453, website: 'https://app.virtuals.io', dexes: ['virtuals-base', 'virtuals-unicorn-base'] },
] as const;
export type LaunchpadId = typeof LAUNCHPADS[number]['id'];
export type Launchpad = typeof LAUNCHPADS[number];
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
export function parseGeckoPools(payload: Json, source: Launchpad, dex: string, now = Date.now()): LaunchpadPool[] {
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
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
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

export async function fetchLaunchpadFeed(id: LaunchpadId, nearOptions?: NearRpcOptions): Promise<LaunchpadFeed> {
  const source = launchpadById(id);
  if (!source) throw new Error('Unknown launchpad');
  let pools: LaunchpadPool[]; let partial = false;
  if (id === 'nearpaid') ({ pools, partial } = await nearpaidPools(nearOptions));
  else if (id === 'tolly') pools = parseTollyPools(await json('https://api.tollylabs.com/tokens?scope=tolly&sort=volume&dir=desc&limit=40&offset=0'));
  else {
    const results = await Promise.allSettled(source.dexes.map(async (dex) => parseGeckoPools(
      await json(`https://api.geckoterminal.com/api/v2/networks/${source.network}/dexes/${dex}/pools?include=base_token,quote_token`), source, dex)));
    if (results.every((r) => r.status === 'rejected')) throw new Error('Pool provider could not refresh');
    partial = results.some((r) => r.status === 'rejected');
    pools = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
  }
  return { source: id, pools: uniquePools(pools), partial, stale: false, observedAt: Date.now(),
    coverage: id === 'nearpaid' ? 'Up to 10 live pools from the latest 20 launches · on-chain reads · 24h history not indexed'
      : id === 'tolly' ? 'Top 40 Tolly listings by volume · Tolly market API'
      : 'Top indexed pools per venue · GeckoTerminal · includes pools with depleted liquidity' };
}
