import { useState, useRef, useEffect } from 'react';
import { Search, Loader2, X, Zap } from 'lucide-react';
import { detectChain, DetectedToken, formatAddress } from '../services/chainDetector';
import { motion, AnimatePresence } from 'framer-motion';

interface SearchBarProps {
  onTokenDetected: (token: DetectedToken) => void;
}

const QUICK_TOKENS = [
  { label: 'MPEPE', address: '0x946102eA7Df8c2652a1B3a96e23B8b0a703410a5' },
  { label: 'RHT', address: '0x1234567890abcdef1234567890abcdef12345678' },
  { label: 'ARC', address: '0xabcdef1234567890abcdef1234567890abcdef12' },
  { label: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
];

export default function SearchBar({ onTokenDetected }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [detected, setDetected] = useState<DetectedToken | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    setDetected(null);

    try {
      const result = await detectChain(query.trim());
      if (result) {
        setDetected(result);
        onTokenDetected(result);
      } else {
        setError('Could not detect chain for this address');
      }
    } catch {
      setError('Detection failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickToken = async (address: string) => {
    setQuery(address);
    setLoading(true);
    setError('');
    try {
      const result = await detectChain(address);
      if (result) {
        setDetected(result);
        onTokenDetected(result);
      }
    } finally {
      setLoading(false);
    }
  };

  const clearSearch = () => {
    setQuery('');
    setDetected(null);
    setError('');
  };

  return (
    <div className="w-full">
      <div className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Paste any token address or contract (auto-detects chain...)"
            className="w-full pl-12 pr-20 py-4 bg-gray-900/80 border border-gray-700/50 rounded-2xl text-white placeholder-gray-500 focus:outline-none focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20 transition-all text-sm"
          />
          {query && (
            <button onClick={clearSearch} className="absolute right-14 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-700 rounded-full transition-colors">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          )}
          <button
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium text-sm flex items-center gap-2 transition-all"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Detect
          </button>
        </div>
        <div className="hidden md:flex items-center gap-1 px-3 py-2 bg-gray-800/60 rounded-xl border border-gray-700/30">
          <kbd className="text-xs text-gray-400 font-mono">⌘K</kbd>
        </div>
      </div>

      {/* Quick tokens */}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <span className="text-xs text-gray-500">Quick:</span>
        {QUICK_TOKENS.map((t) => (
          <button
            key={t.address}
            onClick={() => handleQuickToken(t.address)}
            className="px-3 py-1 text-xs bg-gray-800/60 hover:bg-gray-700/60 border border-gray-700/30 rounded-lg text-gray-300 hover:text-white transition-all"
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Detection result */}
      <AnimatePresence>
        {(detected || error) && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="mt-3"
          >
            {detected ? (
              <div className="flex items-center gap-4 p-4 bg-gray-900/60 border border-gray-700/30 rounded-2xl">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold" style={{ backgroundColor: detected.chainColor + '22', color: detected.chainColor }}>
                  {detected.symbol.slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">{detected.symbol}</span>
                    <span className="text-gray-400 text-sm">{detected.name}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: detected.chainColor + '22', color: detected.chainColor }}>
                      {detected.chainName}
                    </span>
                    <span className="text-xs text-gray-500 font-mono">{formatAddress(detected.address)}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-white">${detected.priceUsd < 0.01 ? detected.priceUsd.toFixed(8) : detected.priceUsd.toFixed(4)}</div>
                  <div className={`text-xs font-medium ${detected.change24h >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {detected.change24h >= 0 ? '+' : ''}{detected.change24h.toFixed(2)}%
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-red-900/20 border border-red-700/30 rounded-2xl text-red-400 text-sm">
                {error}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
