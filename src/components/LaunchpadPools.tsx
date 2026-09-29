import { useEffect, useState } from 'react';
import { ArrowUpRight, RefreshCw, Radar } from 'lucide-react';
import { apiUrl } from '../services/api';
import { LAUNCHPADS, sortPools, type LaunchpadFeed, type LaunchpadId, type PoolSort, type LaunchpadPool } from '../services/launchpads';
import { chainKeyForId, formatTokenPrice, formatUsd, formatAge } from '../services/chainDetector';
import ChainLogo from './ChainLogo';
import LaunchpadTradePanel from './LaunchpadTradePanel';

const snapshots = new Map<LaunchpadId, LaunchpadFeed>();
export default function LaunchpadPools({ onSelect }: { onSelect: (address: string, chainId: number) => void }) {
  const [source, setSource] = useState<LaunchpadId>('pump');
  const [sort, setSort] = useState<PoolSort>('volume');
  const [feed, setFeed] = useState<LaunchpadFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState(8);
  const [query, setQuery] = useState('');
  const [tradingPool, setTradingPool] = useState<LaunchpadPool | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    setFeed(snapshots.get(source) ?? null); setError(''); setVisible(8);
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true; setLoading(true);
      try {
        const response = await fetch(apiUrl(`/api/launchpads/pools?source=${source}`), { signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('The pool feed could not refresh. Check the Worker connection and retry.');
        const next = await response.json() as LaunchpadFeed;
        if (next.source !== source || !Array.isArray(next.pools)) throw new Error('The pool feed returned an invalid response.');
        if (controller.signal.aborted) return;
        snapshots.set(source, next); setFeed(next); setError('');
      } catch (e) {
        if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Pool refresh failed.'); setFeed((old) => old ? { ...old, stale: true } : null); }
      } finally { busy = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 120_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [source, refresh]);
  const selected = LAUNCHPADS.find((pad) => pad.id === source)!;
  const term = query.trim().toLowerCase();
  const pools = sortPools(feed?.pools ?? [], sort).filter((pool) => !term || [pool.symbol, pool.name, pool.tokenAddress].some((v) => v.toLowerCase().includes(term)));
  return <section className="overflow-hidden rounded-2xl border border-gray-800/60 bg-gray-900/50" aria-label="Launchpad pools">
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5">
      <div className="flex items-center gap-2.5"><span className="rounded-xl bg-brand-500/15 p-2"><Radar className="h-4 w-4 text-brand-300" /></span>
        <div><h2 className="text-sm font-semibold text-white">Launch radar</h2><p className="text-xs text-gray-500">Follow the pools behind the tokens</p></div></div>
      <div className="flex items-center gap-2">
        <select aria-label="Sort launchpad pools" value={sort} onChange={(e) => setSort(e.target.value as PoolSort)} className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-2 text-xs text-gray-300">
          <option value="volume">24h volume</option><option value="liquidity">Liquidity</option><option value="newest">Newest in feed</option>
        </select>
        <button disabled={loading} onClick={() => setRefresh((v) => v + 1)} aria-label="Refresh launchpad pools" className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>
    </div>
    <div className="flex gap-1.5 overflow-x-auto px-4 py-4 sm:px-5" aria-label="Launchpad sources">
      {LAUNCHPADS.map((pad) => <button key={pad.id} aria-pressed={source === pad.id} onClick={() => setSource(pad.id)} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors ${source === pad.id ? 'border-brand-400/40 bg-brand-500/15 text-brand-200' : 'border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'}`}>{pad.name}</button>)}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-y border-gray-800/50 bg-gray-950/30 px-4 py-2 text-[11px] text-gray-500 sm:px-5">
      <a href={selected.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-white"><ChainLogo chainKey={chainKeyForId(selected.chainId)} size={13} />{selected.name}<ArrowUpRight className="h-3 w-3" /></a>
      <span role="status">{feed ? `${feed.stale ? 'Last saved' : feed.partial ? 'Partial update' : 'Fetched'} ${new Date(feed.observedAt).toLocaleTimeString()} · ${feed.pools.length} pools` : loading ? 'Reading pools…' : 'Refresh needed'}</span>
    </div>
    <div className="px-4 pb-3"><input aria-label="Find a token in this launchpad feed" placeholder="Find by name, symbol or contract in this feed…" value={query} onChange={(e) => { setQuery(e.target.value); setVisible(8); }} className="w-full rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2 text-sm text-white outline-none focus:border-brand-400" /></div>
    {tradingPool && <LaunchpadTradePanel key={tradingPool.id} pool={tradingPool} onClose={() => setTradingPool(null)} />}
    {error && <p role="status" className="px-5 py-3 text-xs text-amber-400">{error}{feed ? ' Showing the last fetched pools.' : ''}</p>}
    {!feed && loading ? <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-36 rounded-xl" />)}</div>
      : pools.length ? <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {pools.slice(0, visible).map((pool) => <article key={pool.id} className="rounded-xl border border-gray-800/70 bg-gray-950/25 p-3.5 transition-colors hover:border-brand-500/30">
          <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-white" title={pool.name}>{pool.symbol}<span className="ml-1 text-xs font-normal text-gray-500">{pool.quoteSymbol && `/ ${pool.quoteSymbol}`}</span></h3>
            <a href={pool.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-gray-500 hover:text-brand-300" title={pool.poolAddress}>{pool.poolAddress.slice(0, 8)}…{pool.poolAddress.slice(-5)}<ArrowUpRight className="h-3 w-3" /></a></div>
            <span className="text-[10px] text-gray-500">{pool.createdAt ? formatAge(pool.createdAt) : '—'}</span></div>
          <div className="my-3 flex items-center justify-between gap-1"><span className="font-mono text-sm text-gray-200">{pool.priceUsd === null ? 'Price pending' : formatTokenPrice(pool.priceUsd)}</span>
            <span className={`font-mono text-xs ${(pool.change24h ?? 0) < 0 ? 'text-red-400' : 'text-green-400'}`}>{pool.change24h === null ? '—' : `${pool.change24h >= 0 ? '+' : ''}${pool.change24h.toFixed(1)}%`}</span></div>
          <dl className="grid grid-cols-2 gap-2 text-[11px]"><div><dt className="text-gray-500">Pool liquidity</dt><dd className="mt-0.5 font-mono text-gray-300">{pool.liquidityUsd === null ? 'Not reported' : formatUsd(pool.liquidityUsd)}</dd></div><div><dt className="text-gray-500">Volume · 24h</dt><dd className="mt-0.5 font-mono text-gray-300">{pool.volume24h === null ? 'Not indexed' : formatUsd(pool.volume24h)}</dd></div></dl>
          <div className="mt-3 flex gap-2"><button onClick={() => setTradingPool(pool)} className="flex-1 rounded-lg bg-brand-500/20 px-3 py-2 text-xs font-semibold text-brand-200 hover:bg-brand-500/30">Quick buy</button><button onClick={() => onSelect(pool.tokenAddress, pool.chainId)} className="rounded-lg bg-gray-800/70 px-3 py-2 text-xs text-gray-300 hover:text-white">Chart ↗</button></div>
        </article>)}
      </div> : feed && <p className="px-5 py-6 text-sm text-gray-500">{term ? 'No match in this snapshot. Open the launchpad link above to search its full catalogue.' : 'No pools returned by this source yet.'}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-4 text-[10px] text-gray-500">
      <p>{feed?.coverage ?? 'Public market data · refreshes every two minutes'}<br />Pool listings do not guarantee an executable trade. Routing is checked separately.</p>
      {visible < pools.length && <button onClick={() => setVisible((n) => n + 8)} className="rounded-lg border border-gray-800 px-3 py-2 text-xs hover:text-white">Show more pools</button>}
    </div>
  </section>;
}
