import { useState } from 'react';
import { ArrowRight, TrendingUp, TrendingDown, Loader2, CheckCircle2, ExternalLink } from 'lucide-react';
import { mockPositions } from '../data/mockData';
import { formatNumber, formatUsd, formatAddress } from '../services/chainDetector';
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

      {/* Desktop table */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800/30">
              <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Token</th>
              <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Chain</th>
              <th className="text-right px-4 py-3 font-medium whitespace-nowrap">Holdings</th>
              <th className="text-right px-4 py-3 font-medium whitespace-nowrap">Value</th>
              <th className="text-right px-4 py-3 font-medium whitespace-nowrap hidden sm:table-cell">Avg Buy</th>
              <th className="text-right px-4 py-3 font-medium whitespace-nowrap">PnL</th>
              <th className="text-right px-4 py-3 font-medium whitespace-nowrap hidden md:table-cell">Funded Via</th>
              <th className="text-right px-4 py-3 font-medium whitespace-nowrap">Action</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence>
              {mockPositions.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-500">No active positions yet. Search for a token and complete a trade to see it here.</td></tr>
              ) : mockPositions.map((position) => (
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
                    <div className="text-sm text-white">{formatNumber(position.amount)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="text-sm text-white">{formatUsd(position.amount * position.currentPrice)}</div>
                  </td>
                  <td className="px-4 py-3 text-right hidden sm:table-cell">
                    <div className="text-sm text-gray-300">{formatUsd(position.avgBuyPrice)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className={`text-sm font-medium flex items-center justify-end gap-1 ${position.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {position.pnlPercent >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {position.pnlPercent >= 0 ? '+' : ''}{formatNumber(position.pnlPercent)}%
                    </div>
                    <div className={`text-xs ${position.pnlUsd >= 0 ? 'text-green-400/70' : 'text-red-400/70'}`}>
                      {position.pnlUsd >= 0 ? '+' : ''}{formatUsd(position.pnlUsd)}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right hidden md:table-cell">
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

      {/* Mobile cards: keep the complete position readable without horizontal scrolling. */}
      <div className="sm:hidden divide-y divide-gray-800/30">
        {mockPositions.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-500">No active positions yet.</div>
        ) : mockPositions.map((position) => (
          <motion.div key={position.id} initial={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <ChainLogo chainKey={getChainKey(position.token.chainId)} size={28} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white truncate">{position.token.symbol}</div>
                  <div className="text-xs text-gray-500 font-mono truncate">{formatAddress(position.token.address)}</div>
                </div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full shrink-0" style={{ backgroundColor: position.token.chainColor + '22', color: position.token.chainColor }}>{position.token.chainName}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><div className="text-gray-500">Holdings</div><div className="text-sm text-white mt-0.5">{formatNumber(position.amount)}</div></div>
              <div><div className="text-gray-500">Value</div><div className="text-sm text-white mt-0.5">{formatUsd(position.amount * position.currentPrice)}</div></div>
              <div><div className="text-gray-500">Avg Buy</div><div className="text-sm text-gray-300 mt-0.5">{formatUsd(position.avgBuyPrice)}</div></div>
              <div><div className="text-gray-500">PnL</div><div className={`text-sm mt-0.5 ${position.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>{position.pnlPercent >= 0 ? '+' : ''}{formatNumber(position.pnlPercent)}%</div></div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">{position.fundingChain} → {position.fundingSymbol}</span>
              {soldIds.has(position.id) ? <span className="text-xs text-green-400">Sold</span> : sellingId === position.id ? <span className="text-xs text-purple-400">Selling…</span> : <button onClick={() => handleSell(position.id)} className="px-3 py-1.5 bg-red-600/20 border border-red-500/30 text-red-400 text-xs font-medium rounded-lg">Sell & Return</button>}
            </div>
          </motion.div>
        ))}
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
