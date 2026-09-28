import { useCallback, useEffect, useState } from 'react';
import { Flame, RefreshCw } from 'lucide-react';
import { chainKeyForId, formatTokenPrice, NEAR_CHAIN_ID } from '../services/chainDetector';
import ChainLogo from './ChainLogo';

/** GeckoTerminal network ids for the chains Hopr can trade. */
const TRENDING_NETWORKS: Record<string, number> = {
  solana: 1151111081099710,
  base: 8453,
  arbitrum: 42161,
  bsc: 56,
  robinhood: 4663,
  near: NEAR_CHAIN_ID,
};

const CACHE_KEY = 'hopr-trending-v1';
const CACHE_TTL_MS = 2 * 60 * 1000;

export interface TrendingToken {
  address: string;
  chainId: number;
  symbol: string;
  imageUrl?: string;
  priceUsd: number;
  change24h: number;
  change1h?: number;
  volume24h: number;
}

type GeckoPool = {
  attributes?: Record<string, unknown>;
  relationships?: { base_token?: { data?: { id?: string } }; network?: { data?: { id?: string } } };
};
type GeckoResponse = {
  data?: GeckoPool[];
  included?: Array<{ id?: string; attributes?: { symbol?: string; image_url?: string } }>;
};

function parsePools(payload: GeckoResponse): TrendingToken[] {
  const tokens = new Map((payload.included ?? []).map((item) => [item.id, item.attributes]));
  return (payload.data ?? []).flatMap((pool) => {
    const network = pool.relationships?.network?.data?.id ?? '';
    const chainId = TRENDING_NETWORKS[network];
    const tokenRef = pool.relationships?.base_token?.data?.id ?? '';
    const address = tokenRef.slice(network.length + 1);
    if (!chainId || !address) return [];
    const attrs = pool.attributes ?? {};
    const token = tokens.get(tokenRef);
    const changes = attrs.price_change_percentage as { h1?: string; h24?: string } | undefined;
    const image = token?.image_url && token.image_url !== 'missing.png' ? token.image_url : undefined;
    return [{
      address,
      chainId,
      symbol: token?.symbol ?? String(attrs.name ?? '').split(' / ')[0] ?? 'TOKEN',
      imageUrl: image,
      priceUsd: Number(attrs.base_token_price_usd ?? 0),
      change24h: Number(changes?.h24 ?? 0),
      change1h: changes?.h1 !== undefined ? Number(changes.h1) : undefined,
      volume24h: Number((attrs.volume_usd as { h24?: string } | undefined)?.h24 ?? 0),
    }];
  });
}

async function fetchTrending(signal?: AbortSignal): Promise<TrendingToken[]> {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null') as { at: number; tokens: TrendingToken[] } | null;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.tokens.length) return cached.tokens;
  } catch {
    // Storage unavailable: fetch fresh.
  }
  // Global trending covers every network; Base is added explicitly as Hopr's default funding chain.
  const urls = [
    'https://api.geckoterminal.com/api/v2/networks/trending_pools?include=base_token&duration=24h',
    'https://api.geckoterminal.com/api/v2/networks/base/trending_pools?include=base_token',
  ];
  const results = await Promise.allSettled(urls.map(async (url) => {
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parsePools(await response.json() as GeckoResponse);
  }));
  const seen = new Set<string>();
  const tokens = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .filter((token) => {
      const key = `${token.chainId}:${token.address.toLowerCase()}`;
      if (seen.has(key) || token.priceUsd <= 0) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 18);
  if (!tokens.length) throw new Error('Trending data unavailable');
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), tokens }));
  } catch {
    // Non-critical cache.
  }
  return tokens;
}

function TokenAvatar({ token }: { token: TrendingToken }) {
  const [failed, setFailed] = useState(false);
  if (token.imageUrl && !failed) {
    return <img src={token.imageUrl} alt="" loading="lazy" onError={() => setFailed(true)} className="h-8 w-8 rounded-full bg-gray-800 object-cover" />;
  }
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-500/40 to-brand-700/40 text-xs font-bold text-brand-100">
      {token.symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

function TrendingCard({ token, rank, onSelect, duplicate }: { token: TrendingToken; rank: number; onSelect: (address: string) => void; duplicate?: boolean }) {
  const up = token.change24h >= 0;
  return (
    <button
      onClick={() => onSelect(token.address)}
      title={`Scan ${token.symbol}`}
      tabIndex={duplicate ? -1 : undefined}
      className="trend-card pressable group relative flex w-[204px] shrink-0 items-center gap-2.5 rounded-xl border border-gray-800/60 bg-gray-900/60 px-3 py-2.5 text-left hover:border-brand-400/40"
    >
      <span className="absolute left-2 top-1.5 font-mono text-[9px] text-gray-600">#{rank}</span>
      <span className="relative mt-1">
        <TokenAvatar token={token} />
        <span className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-gray-900"><ChainLogo chainKey={chainKeyForId(token.chainId)} size={14} /></span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white group-hover:text-brand-200">{token.symbol}</span>
        <span className="block truncate font-mono text-[11px] text-gray-500">{formatTokenPrice(token.priceUsd)}</span>
      </span>
      <span className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ${up ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
        {up ? '+' : ''}{Math.abs(token.change24h) >= 100 ? token.change24h.toFixed(0) : token.change24h.toFixed(1)}%
      </span>
    </button>
  );
}

/**
 * Live "what's moving" strip across Hopr's chains (GeckoTerminal trending
 * pools — organic activity, not paid boosts). Scrolls as a slow marquee that
 * pauses on hover/focus; clicking a token scans it on the dashboard.
 */
export default function TrendingRail({ onSelect }: { onSelect: (address: string) => void }) {
  const [tokens, setTokens] = useState<TrendingToken[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false, signal?: AbortSignal) => {
    if (force) {
      try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    }
    setRefreshing(true);
    try {
      setTokens(await fetchTrending(signal));
      setFailed(false);
    } catch {
      if (!signal?.aborted) setFailed(true);
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  if (failed && !tokens) return null;

  return (
    <section aria-label="Trending tokens" className="rounded-2xl border border-gray-800/50 bg-gray-900/40 py-3">
      <div className="mb-2.5 flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-orange-500/15"><Flame className="h-3.5 w-3.5 text-orange-400" /></span>
          <h2 className="text-sm font-semibold text-white">Trending now</h2>
          <span className="hidden text-xs text-gray-500 sm:inline">· across Hopr chains · GeckoTerminal</span>
        </div>
        <button onClick={() => load(true)} className="pressable rounded-lg p-1.5 text-gray-500 hover:bg-gray-800/70 hover:text-white" aria-label="Refresh trending tokens">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="trend-viewport relative overflow-hidden">
        {tokens ? (
          <div className="trend-track flex w-max pl-4" style={{ ['--trend-duration' as string]: `${Math.max(30, tokens.length * 4)}s` }}>
            {/* Rendered twice for a seamless loop; the copy is hidden from assistive tech. */}
            {[0, 1].map((copy) => (
              <div key={copy} className="flex gap-2.5 pr-2.5" aria-hidden={copy === 1 || undefined}>
                {tokens.map((token, index) => (
                  <TrendingCard key={`${copy}-${token.chainId}-${token.address}`} token={token} rank={index + 1} onSelect={onSelect} duplicate={copy === 1} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-2.5 px-4">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton h-[52px] w-[204px] shrink-0 rounded-xl" />)}
          </div>
        )}
      </div>
    </section>
  );
}
