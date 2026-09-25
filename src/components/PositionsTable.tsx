import { useState } from 'react';
import { ArrowRight, TrendingUp, TrendingDown, Loader2, CheckCircle2, ExternalLink } from 'lucide-react';
import { mockPositions } from '../data/mockData';
import { formatUsd, formatAddress } from '../services/chainDetector';
import ChainLogo from './ChainLogo';
import { motion, AnimatePresence } from 'framer-motion';

function getChainKey(chainId: number): string {
  const map: Record<number, string> = {
    1151111081099710: 'sol',
    42161: 'arb',
    8453: 'base',
    56: 'bsc',
    4663: 'rhc',
    5042: 'arc',
  };
  return map[chainId] || 'sol';
}

export default function PositionsTable() {
  const [sellingId, setSellingId] = useState<string | null>(null);
  const [soldIds, setSoldIds] = useState<Set<string>>(new Set());

  const handleSell = async (positionId: string) => {
    setSellingId(positionId);
    await new Promise(r => setTimeout(r, 3000));
    setSellingId(null);
    setSoldIds(prev => new Set([...prev, positionId]));
  };

  const totalPnl = mockPositions.reduce((sum, p) => sum + p.pnlUsd, 0);
  const totalValue = mockPositions.reduce((sum, p) => sum + (p.amount * p.currentPrice), 0);

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-gray-800/50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Active Positions</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {mockPositions.length} positions across {new Set(mockPositions.map(p => p.token.chainName)).size} chains
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-gray-500">Total Value</div>
              <div className="text-sm font-semibold text-white">{formatUsd(totalValue)}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">Total PnL</div>
              <div className={`text-sm font-semibold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {totalPnl >= 0 ? '+' : ''}{formatUsd(totalPnl)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800/30">
              <th className="text-left px-4 py-3 font-medium">Token</th>
              <th className="text-left px-4 py-3 font-medium">Chain</th>
              <th className="text-right px-4 py-3 font-medium">Holdings</th>
              <th className="text-right px-4 py-3 font-medium">Value</th>
              <th className="text-right px-4 py-3 font-medium">Avg Buy</th>
              <th className="text-right px-4 py-3 font-medium">PnL</th>
              <th className="text-right px-4 py-3 font-medium">Funded Via</th>
              <th className="text-right px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence>
              {mockPositions.map((position) => (
                <motion.tr
                  key={position.id}
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="border-b border-gray-800/20 hover:bg-gray-800/20 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center">
                        <ChainLogo chainKey={getChainKey(position.token.chainId)} size={28} />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-white">{position.token.symbol}</div>
                        <div className="text-xs text-gray-500 font-mono">{formatAddress(position.token.address)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: position.token.chainColor + '22', color: position.token.chainColor }}>
                      {position.token.chainName}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="text-sm text-white">{position.amount.toLocaleString()}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="text-sm text-white">{formatUsd(position.amount * position.currentPrice)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="text-sm text-gray-300">{formatUsd(position.avgBuyPrice)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className={`text-sm font-medium flex items-center justify-end gap-1 ${position.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {position.pnlPercent >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {position.pnlPercent >= 0 ? '+' : ''}{position.pnlPercent.toFixed(1)}%
                    </div>
                    <div className={`text-xs ${position.pnlUsd >= 0 ? 'text-green-400/70' : 'text-red-400/70'}`}>
                      {position.pnlUsd >= 0 ? '+' : ''}{formatUsd(position.pnlUsd)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1 text-xs text-gray-400">
                      <span>{position.fundingChain}</span>
                      <ArrowRight className="w-3 h-3" />
                      <span>{position.fundingSymbol}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {soldIds.has(position.id) ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-400">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Sold
                      </span>
                    ) : sellingId === position.id ? (
                      <span className="inline-flex items-center gap-1 text-xs text-purple-400">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Selling...
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSell(position.id)}
                        className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-500/30 text-red-400 text-xs font-medium rounded-lg transition-all active:scale-95"
                      >
                        Sell & Return
                      </button>
                    )}
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-gray-800/30 flex items-center justify-between">
        <span className="text-xs text-gray-500">All proceeds auto-routed back to original funding chain</span>
        <button className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors">
          <ExternalLink className="w-3 h-3" /> View on Explorer
        </button>
      </div>
    </div>
  );
}
