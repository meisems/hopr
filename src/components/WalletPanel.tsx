import { useState } from 'react';
import { Wallet, ChevronDown, ChevronUp, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { mockWalletBalances } from '../data/mockData';
import { formatUsd } from '../services/chainDetector';
import { motion, AnimatePresence } from 'framer-motion';

export default function WalletPanel() {
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const totalBalance = mockWalletBalances.reduce((sum, b) => sum + b.usdValue, 0);

  const handleRefresh = async () => {
    setRefreshing(true);
    await new Promise(r => setTimeout(r, 1500));
    setRefreshing(false);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const evmAddress = '0x7a3B...9f2E';
  const solAddress = '7xKX...pQ4m';

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-gray-800/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-purple-400" />
            <h3 className="font-semibold text-white">Portfolio</h3>
          </div>
          <button
            onClick={handleRefresh}
            className={`p-1.5 rounded-lg hover:bg-gray-800 transition-colors ${refreshing ? 'animate-spin' : ''}`}
          >
            <RefreshCw className="w-4 h-4 text-gray-400" />
          </button>
        </div>
        <div className="mt-2">
          <div className="text-2xl font-bold text-white">{formatUsd(totalBalance)}</div>
          <div className="text-xs text-gray-500">Across 6 chains</div>
        </div>
      </div>

      {/* Wallet addresses */}
      <div className="px-4 py-3 border-b border-gray-800/30 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">EVM:</span>
            <span className="text-xs text-gray-300 font-mono">{evmAddress}</span>
          </div>
          <button onClick={() => handleCopy('0x7a3B...9f2E')} className="p-1 hover:bg-gray-800 rounded transition-colors">
            {copied === '0x7a3B...9f2E' ? <span className="text-xs text-green-400">✓</span> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">SOL:</span>
            <span className="text-xs text-gray-300 font-mono">{solAddress}</span>
          </div>
          <button onClick={() => handleCopy('7xKX...pQ4m')} className="p-1 hover:bg-gray-800 rounded transition-colors">
            {copied === '7xKX...pQ4m' ? <span className="text-xs text-green-400">✓</span> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
      </div>

      {/* Chain balances */}
      <div className="px-4 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-between w-full py-2 text-xs text-gray-400 hover:text-white transition-colors"
        >
          <span>Chain Breakdown</span>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-2 pb-2">
                {mockWalletBalances.map((balance) => (
                  <div key={balance.chainId} className="flex items-center justify-between py-2 px-3 bg-gray-800/30 rounded-xl">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs" style={{ backgroundColor: balance.chainColor + '22', color: balance.chainColor }}>
                        {balance.nativeSymbol.slice(0, 1)}
                      </div>
                      <div>
                        <div className="text-xs font-medium text-white">{balance.chainName}</div>
                        <div className="text-xs text-gray-500">{balance.balance.toFixed(4)} {balance.nativeSymbol}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-medium text-white">{formatUsd(balance.usdValue)}</div>
                      <div className="text-xs text-gray-500">{((balance.usdValue / totalBalance) * 100).toFixed(1)}%</div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-800/30">
        <button className="w-full py-2 text-xs text-purple-400 hover:text-purple-300 flex items-center justify-center gap-1 transition-colors">
          <ExternalLink className="w-3 h-3" /> Open in Telegram Bot
        </button>
      </div>
    </div>
  );
}
