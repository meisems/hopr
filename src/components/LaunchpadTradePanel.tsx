import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { detectChain, type DetectedToken } from '../services/chainDetector';
import { launchpadById, type LaunchpadPool } from '../services/launchpads';
import TradeCard from './TradeCard';

/** Selection only loads metadata. Signing stays behind the user's explicit buy action. */
export default function LaunchpadTradePanel({ pool, onClose }: { pool: LaunchpadPool; onClose: () => void }) {
  const [token, setToken] = useState<DetectedToken | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setToken(null); setError('');
    panel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    void detectChain(pool.tokenAddress, pool.chainId).then((result) => {
      if (!active) return;
      if (!result || result.chainId !== pool.chainId) throw new Error('Token metadata could not refresh. Retry before trading.');
      setToken(result);
    }).catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Token lookup failed'); });
    return () => { active = false; };
  }, [pool.chainId, pool.tokenAddress, retry]);
  return <div ref={panel} className="mx-4 mb-4 rounded-2xl border border-brand-400/30 p-3 sm:p-4" aria-label="Launchpad trading panel">
    <div className="mb-3 flex items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold text-white">Trade {pool.symbol}</h3>
        <p className="text-xs text-gray-400">Listed on {launchpadById(pool.source)?.name} · choose your pay-from chain and tap a buy amount</p>
        <p className="mt-1 break-all font-mono text-[10px] text-gray-500">{pool.tokenAddress}</p></div>
      <button onClick={onClose} aria-label="Close launchpad trading panel" className="rounded-lg p-2 text-gray-400 hover:bg-gray-800"><X className="h-4 w-4" /></button>
    </div>
    <div className="mx-auto max-w-xl">{error ? <div role="status" className="p-3 text-sm text-amber-400">{error}<button className="ml-3 underline" onClick={() => setRetry((n) => n + 1)}>Retry</button></div>
      : token ? <TradeCard key={`${token.chainId}:${token.address}`} token={token} />
      : <p role="status" className="flex items-center gap-2 p-5 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Reading token on {pool.network}…</p>}</div>
  </div>;
}
