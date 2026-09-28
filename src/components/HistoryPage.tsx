import { useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, CheckCircle2, Clock, Download, ExternalLink, Loader2, RotateCcw, Search, XCircle } from 'lucide-react';
import { formatUsd } from '../services/chainDetector';
import { explorerTxLink, getNetwork } from '../services/chains';
import { formatUnits } from '../services/nearService';
import { useActivity, type ActivityEntry } from '../services/activity';
import ChainLogo from './ChainLogo';
import PageHeader from './PageHeader';

type Filter = 'all' | 'buy' | 'sell' | 'bridge';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const STATUS = {
  done: { icon: CheckCircle2, label: 'Completed', className: 'text-green-400' },
  pending: { icon: Loader2, label: 'Pending', className: 'text-yellow-400' },
  failed: { icon: XCircle, label: 'Failed', className: 'text-red-400' },
  refunded: { icon: RotateCcw, label: 'Refunded', className: 'text-orange-300' },
} as const;

function kindOf(entry: ActivityEntry): Exclude<Filter, 'all'> {
  return entry.kind === 'bridge' ? 'bridge' : entry.side ?? 'buy';
}

function exportCsv(entries: ActivityEntry[]) {
  const header = ['time', 'type', 'from_chain', 'from_amount', 'from_symbol', 'to_chain', 'to_amount_est', 'to_symbol', 'usd', 'status', 'provider', 'tx'];
  const rows = entries.map((entry) => [
    new Date(entry.createdAt).toISOString(), kindOf(entry),
    getNetwork(entry.from.chainId)?.name ?? entry.from.chainId, formatUnits(entry.from.amount, entry.from.decimals, 8).replace(/,/g, ''), entry.from.symbol,
    getNetwork(entry.to.chainId)?.name ?? entry.to.chainId, formatUnits(entry.to.amount, entry.to.decimals, 8).replace(/,/g, ''), entry.to.symbol,
    entry.amountInUsd?.toFixed(2) ?? '', entry.status, entry.provider, entry.txHash,
  ]);
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `hopr-history-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Every swap and bridge executed from this browser, with live cross-chain status. */
export default function HistoryPage({ onBack }: { onBack: () => void }) {
  const activity = useActivity();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => activity.filter((entry) => {
    if (filter !== 'all' && kindOf(entry) !== filter) return false;
    if (!query) return true;
    const needle = query.toLowerCase();
    return [entry.from.symbol, entry.to.symbol, entry.txHash, entry.to.address].some((value) => value.toLowerCase().includes(needle));
  }), [activity, filter, query]);

  const counts = {
    all: activity.length,
    buy: activity.filter((entry) => kindOf(entry) === 'buy').length,
    sell: activity.filter((entry) => kindOf(entry) === 'sell').length,
    bridge: activity.filter((entry) => entry.kind === 'bridge').length,
  };
  const pending = activity.filter((entry) => entry.status === 'pending').length;

  return (
    <div className="text-white">
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <PageHeader
          icon={Clock}
          title="Trade History"
          subtitle="Every swap and bridge signed from this browser"
          onBack={onBack}
          actions={activity.length > 0 && (
            <button onClick={() => exportCsv(filtered)} className="pressable flex items-center gap-1.5 rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 text-xs font-medium text-gray-300 hover:text-white">
              <Download className="h-3.5 w-3.5" /> Export CSV
            </button>
          )}
        />

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Total', value: counts.all },
            { label: 'Buys', value: counts.buy },
            { label: 'Sells', value: counts.sell },
            { label: 'Pending', value: pending },
          ].map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-gray-800/50 bg-gray-900/60 p-4">
              <div className="text-xs text-gray-500">{stat.label}</div>
              <div className="mt-1 font-mono text-xl font-semibold text-white">{stat.value}</div>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-1 rounded-xl border border-gray-800/60 bg-gray-900/50 p-1">
            {(['all', 'buy', 'sell', 'bridge'] as const).map((option) => (
              <button key={option} onClick={() => setFilter(option)} className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize ${filter === option ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>
                {option} <span className="text-gray-500">{counts[option]}</span>
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search token or tx" className="w-full rounded-xl border border-gray-800 bg-gray-900/60 py-2 pl-9 pr-3 text-sm text-white placeholder-gray-500 focus:border-brand-500/50 focus:outline-none sm:w-64" />
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-gray-800/50 bg-gray-900/60">
          {filtered.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <Clock className="mx-auto mb-3 h-10 w-10 text-gray-600" />
              <p className="text-sm text-gray-400">{activity.length ? 'No trades match this filter.' : 'No trades yet.'}</p>
              <p className="mt-1 text-xs text-gray-500">Swaps and bridges you sign on the dashboard appear here with live status.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-800/50">
              {filtered.map((entry) => {
                const kind = kindOf(entry);
                const status = STATUS[entry.status];
                const StatusIcon = status.icon;
                const fromNet = getNetwork(entry.from.chainId);
                const toNet = getNetwork(entry.to.chainId);
                const receiving = entry.receivingTxHash ? explorerTxLink(entry.to.chainId, entry.receivingTxHash) : undefined;
                return (
                  <li key={entry.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${kind === 'buy' ? 'bg-green-500/10 text-green-400' : kind === 'sell' ? 'bg-red-500/10 text-red-400' : 'bg-brand-500/10 text-brand-300'}`}>
                        {kind === 'buy' ? <ArrowDownToLine className="h-4 w-4" /> : kind === 'sell' ? <ArrowUpFromLine className="h-4 w-4" /> : <ArrowRightLeft className="h-4 w-4" />}
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-white">
                          <span className="capitalize">{kind}</span>
                          <span className="font-mono text-gray-300">{formatUnits(entry.from.amount, entry.from.decimals, 5)} {entry.from.symbol}</span>
                          <span className="text-gray-500">→</span>
                          <span className="font-mono text-gray-300">≈ {formatUnits(entry.to.amount, entry.to.decimals, 5)} {entry.to.symbol}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                          <ChainLogo chainKey={fromNet?.key ?? ''} size={14} /> {fromNet?.shortName}
                          {entry.from.chainId !== entry.to.chainId && <><span>→</span><ChainLogo chainKey={toNet?.key ?? ''} size={14} /> {toNet?.shortName}</>}
                          <span>· {timeAgo(entry.createdAt)} · {entry.provider === 'lifi' ? 'LI.FI' : entry.provider === 'ref' ? 'Ref Finance' : 'NEAR Intents'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-4 sm:justify-end">
                      {entry.amountInUsd ? <span className="font-mono text-sm text-gray-300">{formatUsd(entry.amountInUsd)}</span> : null}
                      <span className={`flex items-center gap-1 text-xs font-medium ${status.className}`} title={entry.statusDetail}>
                        <StatusIcon className={`h-3.5 w-3.5 ${entry.status === 'pending' ? 'animate-spin' : ''}`} /> {status.label}
                      </span>
                      <span className="flex items-center gap-2">
                        {entry.explorerUrl && <a href={entry.explorerUrl} target="_blank" rel="noreferrer" className="text-gray-500 hover:text-white" title="Source transaction"><ExternalLink className="h-4 w-4" /></a>}
                        {receiving && <a href={receiving} target="_blank" rel="noreferrer" className="text-brand-300 hover:text-brand-200" title="Destination transaction"><ExternalLink className="h-4 w-4" /></a>}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
