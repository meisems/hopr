import { useMemo, useState } from 'react';
import { ArrowLeft, Clock, CheckCircle2, XCircle, Loader2, ExternalLink, ArrowDownToLine, ArrowUpFromLine, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { mockTradeHistory } from '../data/mockData';
import { formatAddress, formatUsd } from '../services/chainDetector';
import ThemeToggle from './ThemeToggle';

interface HistoryPageProps {
  onBack: () => void;
}

type FilterType = 'ALL' | 'BUY' | 'SELL';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${Math.max(1, Math.floor(diff / 60000))}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const STATUS_STYLES: Record<string, { icon: typeof CheckCircle2; className: string }> = {
  COMPLETED: { icon: CheckCircle2, className: 'text-green-400' },
  PENDING: { icon: Loader2, className: 'text-yellow-400' },
  FAILED: { icon: XCircle, className: 'text-red-400' },
};

export default function HistoryPage({ onBack }: HistoryPageProps) {
  const [filter, setFilter] = useState<FilterType>('ALL');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    return mockTradeHistory.filter((t) => {
      if (filter !== 'ALL' && t.type !== filter) return false;
      if (query && !t.symbol.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [filter, query]);

  const totalBuys = mockTradeHistory.filter((t) => t.type === 'BUY').length;
  const totalSells = mockTradeHistory.filter((t) => t.type === 'SELL').length;

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Header */}
      <header className="navbar-dark sticky top-0 z-40 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur-xl safe-area-top">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2 sm:gap-4">
              <button
                onClick={onBack}
                className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-2 text-xs sm:text-sm text-gray-400 hover:text-white hover:bg-gray-800/50 rounded-lg transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Back to Dashboard</span>
              </button>
              <div className="h-6 w-px bg-gray-800 hidden sm:block" />
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 sm:w-5 sm:h-5 text-brand-400" />
                <h1 className="text-base sm:text-lg font-semibold text-white">Trade History</h1>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-gray-900/60 rounded-xl border border-gray-800/50 p-4">
            <div className="text-xs text-gray-500 mb-1">Total Trades</div>
            <div className="text-xl font-bold text-white">{mockTradeHistory.length}</div>
          </div>
          <div className="bg-gray-900/60 rounded-xl border border-gray-800/50 p-4">
            <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><ArrowDownToLine className="w-3 h-3 text-green-400" /> Buys</div>
            <div className="text-xl font-bold text-green-400">{totalBuys}</div>
          </div>
          <div className="bg-gray-900/60 rounded-xl border border-gray-800/50 p-4">
            <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><ArrowUpFromLine className="w-3 h-3 text-red-400" /> Sells</div>
            <div className="text-xl font-bold text-red-400">{totalSells}</div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div className="flex gap-1.5">
            {(['ALL', 'BUY', 'SELL'] as FilterType[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                  filter === f
                    ? 'bg-brand-500/20 border-brand-500/40 text-brand-300'
                    : 'bg-gray-800/30 border-gray-800/30 text-gray-400 hover:text-white hover:bg-gray-800/50'
                }`}
              >
                {f === 'ALL' ? 'All' : f === 'BUY' ? 'Buys' : 'Sells'}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-56">
            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by symbol..."
              className="w-full pl-8 pr-3 py-2 bg-gray-900/60 border border-gray-800/50 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500/40"
            />
          </div>
        </div>

        {/* Desktop table */}
        <div className="hidden sm:block bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px]">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-800/30">
                  <th className="text-left px-4 py-3 font-medium">Type</th>
                  <th className="text-left px-4 py-3 font-medium">Token</th>
                  <th className="text-left px-4 py-3 font-medium">Chain</th>
                  <th className="text-right px-4 py-3 font-medium">Amount</th>
                  <th className="text-right px-4 py-3 font-medium hidden sm:table-cell">Price</th>
                  <th className="text-right px-4 py-3 font-medium">Status</th>
                  <th className="text-right px-4 py-3 font-medium hidden md:table-cell">When</th>
                  <th className="text-right px-4 py-3 font-medium">Tx</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {filtered.map((t) => {
                    const status = STATUS_STYLES[t.status];
                    const StatusIcon = status.icon;
                    return (
                      <motion.tr
                        key={t.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="border-b border-gray-800/20 hover:bg-gray-800/20 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                            t.type === 'BUY' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                          }`}>
                            {t.type === 'BUY' ? <ArrowDownToLine className="w-3 h-3" /> : <ArrowUpFromLine className="w-3 h-3" />}
                            {t.type}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-white">{t.symbol}</div>
                          <div className="text-xs text-gray-500 font-mono">{formatAddress(t.token)}</div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{t.chain}</td>
                        <td className="px-4 py-3 text-right text-sm text-white">{t.amount}</td>
                        <td className="px-4 py-3 text-right text-sm text-gray-300 hidden sm:table-cell">{formatUsd(t.price)}</td>
                        <td className="px-4 py-3 text-right">
                          <span className={`inline-flex items-center gap-1 text-xs font-medium ${status.className}`}>
                            <StatusIcon className={`w-3.5 h-3.5 ${t.status === 'PENDING' ? 'animate-spin' : ''}`} />
                            {t.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-xs text-gray-500 hidden md:table-cell">{timeAgo(t.timestamp)}</td>
                        <td className="px-4 py-3 text-right">
                          <a href="#" className="inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 font-mono">
                            {t.txHash} <ExternalLink className="w-3 h-3" />
                          </a>
                        </td>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <div className="p-10 text-center text-sm text-gray-500">No trades match this filter.</div>
          )}
        </div>

        {/* Mobile cards: keep token, amount, status, and transaction readable without horizontal scrolling. */}
        <div className="sm:hidden bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden divide-y divide-gray-800/30">
          {filtered.length === 0 ? <div className="p-10 text-center text-sm text-gray-500">No trades match this filter.</div> : filtered.map((t) => {
            const status = STATUS_STYLES[t.status];
            const StatusIcon = status.icon;
            return (
              <div key={t.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2"><span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${t.type === 'BUY' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>{t.type}</span><span className="text-sm font-medium text-white">{t.symbol}</span></div>
                    <div className="text-xs text-gray-500 font-mono mt-1">{formatAddress(t.token)}</div>
                  </div>
                  <span className={`inline-flex items-center gap-1 text-xs font-medium ${status.className}`}><StatusIcon className={`w-3.5 h-3.5 ${t.status === 'PENDING' ? 'animate-spin' : ''}`} />{t.status}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs"><div><div className="text-gray-500">Chain</div><div className="text-gray-300 mt-0.5">{t.chain}</div></div><div><div className="text-gray-500">Amount</div><div className="text-white mt-0.5">{t.amount}</div></div><div><div className="text-gray-500">Price</div><div className="text-gray-300 mt-0.5">{formatUsd(t.price)}</div></div><div><div className="text-gray-500">When</div><div className="text-gray-300 mt-0.5">{timeAgo(t.timestamp)}</div></div></div>
                <a href="#" className="inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 font-mono break-all">{t.txHash} <ExternalLink className="w-3 h-3 shrink-0" /></a>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
