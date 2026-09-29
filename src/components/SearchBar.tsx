import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, Loader2, X, Zap, ClipboardPaste, History, CheckCircle2 } from 'lucide-react';
import { detectChain, DetectedToken, formatAddress, formatTokenPrice, chainKeyForId } from '../services/chainDetector';
import ChainLogo from './ChainLogo';
import { motion, AnimatePresence } from 'framer-motion';
import { useRateLimiter } from '../hooks/useRateLimiter';

export interface ScanRequest {
  address: string;
  chainId?: number;
  /** Changes on every request so the same address can be re-scanned. */
  nonce: number;
}

interface SearchBarProps {
  onTokenDetected: (token: DetectedToken) => void;
  /** Scan an address chosen elsewhere on the page (trending rail, recents). */
  scanRequest?: ScanRequest | null;
}

type RecentScan = Pick<DetectedToken, 'address' | 'symbol' | 'chainId' | 'imageUrl'>;

const RECENTS_KEY = 'hopr-recent-scans';
const MAX_RECENTS = 6;
const CACHE_TTL_MS = 5 * 60 * 1000;
const detectionCache = new Map<string, { at: number; token: DetectedToken }>();

function readRecents(): RecentScan[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as RecentScan[];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.address === 'string').slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function writeRecents(recents: RecentScan[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Recents are a convenience; ignore blocked storage.
  }
}

function TokenMark({ token, size = 36 }: { token: Pick<DetectedToken, 'imageUrl' | 'chainId' | 'symbol'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (token.imageUrl && !failed) {
    return (
      <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
        <img src={token.imageUrl} alt="" onError={() => setFailed(true)} className="h-full w-full rounded-full bg-gray-800 object-cover" />
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-gray-900"><ChainLogo chainKey={chainKeyForId(token.chainId)} size={Math.round(size * 0.42)} /></span>
      </span>
    );
  }
  return <ChainLogo chainKey={chainKeyForId(token.chainId)} size={size} />;
}

export default function SearchBar({ onTokenDetected, scanRequest }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [detected, setDetected] = useState<DetectedToken | null>(null);
  const [error, setError] = useState('');
  const [rateLimitWarning, setRateLimitWarning] = useState('');
  const [recents, setRecents] = useState<RecentScan[]>(readRecents);
  const [canPaste, setCanPaste] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  const { canMakeRequest, getTimeUntilNextRequest } = useRateLimiter({
    maxRequests: 10,
    windowMs: 60 * 1000,
    onLimitReached: () => {
      const waitTime = getTimeUntilNextRequest();
      setRateLimitWarning(`Rate limit reached. Try again in ${Math.ceil(waitTime / 1000)}s`);
      setTimeout(() => setRateLimitWarning(''), 3000);
    },
  });

  const remember = useCallback((token: DetectedToken) => {
    setRecents((current) => {
      const next = [
        { address: token.address, symbol: token.symbol, chainId: token.chainId, imageUrl: token.imageUrl },
        ...current.filter((item) => item.chainId !== token.chainId || item.address !== token.address),
      ].slice(0, MAX_RECENTS);
      writeRecents(next);
      return next;
    });
  }, []);

  const scan = useCallback(async (raw: string, chainId?: number) => {
    const address = raw.trim();
    if (!address) return;
    const id = ++requestId.current;
    setError('');

    const cacheKey = `${chainId ?? 'auto'}:${address.startsWith('0x') ? address.toLowerCase() : address}`;
    const cached = detectionCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setDetected(cached.token);
      onTokenDetected(cached.token);
      remember(cached.token);
      return;
    }
    if (!canMakeRequest()) return;

    setLoading(true);
    setDetected(null);
    try {
      const result = await detectChain(address, chainId);
      if (id !== requestId.current) return; // a newer scan superseded this one
      if (result) {
        detectionCache.set(cacheKey, { at: Date.now(), token: result });
        setDetected(result);
        onTokenDetected(result);
        remember(result);
      } else {
        setError('Could not detect a supported chain for this address.');
      }
    } catch {
      if (id === requestId.current) setError('Detection failed. Please try again.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [canMakeRequest, onTokenDetected, remember]);

  // Scans requested from elsewhere on the page.
  useEffect(() => {
    if (!scanRequest) return;
    setQuery(scanRequest.address);
    void scan(scanRequest.address, scanRequest.chainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRequest?.nonce]);

  // ⌘K / Ctrl+K or "/" focuses the search from anywhere.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !typing)) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    setCanPaste(typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText));
  }, []);

  const pasteAndScan = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      setQuery(text);
      void scan(text);
    } catch {
      inputRef.current?.focus();
    }
  };

  const clearSearch = () => {
    requestId.current += 1;
    setQuery('');
    setDetected(null);
    setError('');
    setLoading(false);
    inputRef.current?.focus();
  };

  const clearRecents = () => {
    setRecents([]);
    writeRecents([]);
  };

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="w-full">
      <div className="command-ring">
        <div className="relative flex items-center gap-2 rounded-[calc(1.25rem-1px)] bg-gray-900/95 py-1.5 pl-4 pr-1.5 backdrop-blur">
          {loading ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-300" /> : <Search className="h-5 w-5 shrink-0 text-gray-500" />}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && scan(query)}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text').trim();
              if (text && !query) window.setTimeout(() => scan(text), 0);
            }}
            spellCheck={false}
            autoComplete="off"
            aria-label="Token address"
            placeholder="Paste any token address…"
            className="min-w-0 flex-1 bg-transparent py-2.5 font-mono text-sm text-white placeholder:font-sans placeholder-gray-500 focus:outline-none sm:py-3"
          />
          {query && (
            <button onClick={clearSearch} className="pressable rounded-full p-1.5 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Clear search">
              <X className="h-4 w-4" />
            </button>
          )}
          {!query && canPaste && (
            <button onClick={pasteAndScan} className="pressable hidden items-center gap-1.5 rounded-xl border border-gray-800 bg-gray-800/60 px-2.5 py-2 text-xs font-medium text-gray-400 hover:text-white sm:flex" aria-label="Paste from clipboard and scan">
              <ClipboardPaste className="h-3.5 w-3.5" /> Paste
            </button>
          )}
          <kbd className="hidden rounded-md border border-gray-700/70 bg-gray-800/60 px-1.5 py-0.5 font-mono text-[11px] text-gray-500 md:block">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          <button
            onClick={() => scan(query)}
            disabled={loading || !query.trim()}
            className="pressable flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-brand-500 to-brand-400 px-3.5 py-2.5 text-sm font-semibold text-white shadow-[0_6px_20px_-8px_rgba(63,176,170,0.8)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
          >
            <Zap className="h-4 w-4" />
            <span className="hidden sm:inline">Scan</span>
          </button>
        </div>
      </div>

      {/* Recent scans */}
      <div className="mt-2.5 flex min-h-7 items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
        {recents.length ? (
          <>
            <History className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden />
            {recents.map((item) => (
              <button
                key={`${item.chainId}-${item.address}`}
                onClick={() => { setQuery(item.address); void scan(item.address, item.chainId); }}
                className="pressable flex shrink-0 items-center gap-1.5 rounded-full border border-gray-800/70 bg-gray-900/60 py-1 pl-1 pr-2.5 text-xs font-medium text-gray-300 hover:border-brand-400/40 hover:text-white"
                title={item.address}
              >
                <TokenMark token={item} size={18} />
                {item.symbol !== 'UNKNOWN' ? item.symbol : formatAddress(item.address)}
              </button>
            ))}
            <button onClick={clearRecents} className="shrink-0 px-1 text-[11px] text-gray-600 hover:text-gray-300">Clear</button>
          </>
        ) : (
          <p className="text-xs text-gray-500">
            Chain is detected automatically · <span className="text-gray-400">Solana · Base · Arbitrum · BNB · Robinhood · Arc · NEAR</span>
          </p>
        )}
      </div>

      <AnimatePresence>
        {rateLimitWarning && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="mt-2 rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-400">
            {rateLimitWarning}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {(detected || error) && (
          <motion.div key={detected?.address ?? 'error'} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }} className="mt-2">
            {detected ? (
              <div className="flex items-center gap-3 rounded-2xl border border-gray-800/60 bg-gray-900/60 p-3 sm:gap-4">
                <TokenMark token={detected} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-400" aria-hidden />
                    <span className="font-semibold text-white">{detected.symbol !== 'UNKNOWN' ? detected.symbol : detected.name}</span>
                    <span className="truncate text-sm text-gray-400">{detected.name}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${detected.chainColor}22`, color: detected.chainColor }}>
                      {detected.chainName}
                    </span>
                    <span className="truncate font-mono text-xs text-gray-500">{formatAddress(detected.address)}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm font-semibold text-white">{formatTokenPrice(detected.priceUsd)}</div>
                  <div className={`font-mono text-xs font-medium ${detected.change24h >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {detected.change24h >= 0 ? '+' : ''}{detected.change24h.toFixed(2)}%
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-red-700/30 bg-red-900/20 p-3.5 text-sm text-red-400">{error}</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
