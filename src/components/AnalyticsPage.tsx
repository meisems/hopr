import { Activity, ArrowRightLeft, BarChart3, CheckCircle2, Layers, Shield, Wallet } from 'lucide-react';
import { formatUsd } from '../services/chainDetector';
import { getNetwork } from '../services/chains';
import { useActivity } from '../services/activity';
import { usePortfolio } from '../hooks/usePortfolio';
import ChainLogo from './ChainLogo';
import PageHeader from './PageHeader';

interface AnalyticsPageProps {
  onBack: () => void;
}

function MetricCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="card-lift bg-gray-900/60 rounded-2xl border border-gray-800/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300">{icon}</span>
        <span className="text-sm text-gray-400">{label}</span>
      </div>
      <div className="font-mono text-2xl font-semibold tracking-tight text-white">{value}</div>
      <div className="text-xs text-gray-500 mt-2">{detail}</div>
    </div>
  );
}

/** Your own trading analytics, computed from the swaps and bridges you signed here. */
export default function AnalyticsPage({ onBack }: AnalyticsPageProps) {
  const activity = useActivity();
  const { totalUsd, rows } = usePortfolio();

  const settled = activity.filter((entry) => entry.status === 'done');
  const volume = activity.reduce((sum, entry) => sum + (entry.amountInUsd ?? 0), 0);
  const last24h = activity.filter((entry) => Date.now() - entry.createdAt < 86_400_000).reduce((sum, entry) => sum + (entry.amountInUsd ?? 0), 0);
  const bridges = activity.filter((entry) => entry.kind === 'bridge').length;
  const finished = activity.filter((entry) => entry.status !== 'pending');
  const successRate = finished.length ? Math.round((settled.length / finished.length) * 100) : null;

  const byChain = new Map<number, { volume: number; count: number }>();
  for (const entry of activity) {
    for (const chainId of new Set([entry.from.chainId, entry.to.chainId])) {
      const current = byChain.get(chainId) ?? { volume: 0, count: 0 };
      current.volume += (entry.amountInUsd ?? 0) / (entry.from.chainId === entry.to.chainId ? 1 : 2);
      current.count += 1;
      byChain.set(chainId, current);
    }
  }
  const chainRows = [...byChain.entries()].sort((a, b) => b[1].volume - a[1].volume);
  const maxVolume = Math.max(1, ...chainRows.map(([, row]) => row.volume));

  const providers = (['lifi', 'ref', 'intents'] as const).map((provider) => ({
    provider,
    label: provider === 'lifi' ? 'LI.FI' : provider === 'ref' ? 'Ref Finance' : 'NEAR Intents',
    count: activity.filter((entry) => entry.provider === provider).length,
  })).filter((item) => item.count > 0);

  return (
    <div className="text-white">
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <PageHeader icon={BarChart3} title="Analytics" subtitle="Your trading activity from this browser — no sample data" onBack={onBack} />

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard icon={<Activity className="h-4 w-4" />} label="Total volume" value={formatUsd(volume)} detail={`${activity.length} trade${activity.length === 1 ? '' : 's'} and bridges`} />
          <MetricCard icon={<BarChart3 className="h-4 w-4" />} label="24h volume" value={formatUsd(last24h)} detail="Signed in the last 24 hours" />
          <MetricCard icon={<Wallet className="h-4 w-4" />} label="Wallet value" value={formatUsd(totalUsd)} detail={`Native balances on ${rows.length} network${rows.length === 1 ? '' : 's'}`} />
          <MetricCard icon={<CheckCircle2 className="h-4 w-4" />} label="Success rate" value={successRate === null ? '—' : `${successRate}%`} detail={`${bridges} bridge${bridges === 1 ? '' : 's'} · ${activity.filter((entry) => entry.status === 'pending').length} pending`} />
        </section>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-gray-800/50 bg-gray-900/60 p-5 lg:col-span-2">
            <div className="mb-4 flex items-center gap-2"><Layers className="h-4 w-4 text-brand-300" /><h2 className="text-sm font-semibold">Volume by chain</h2></div>
            {chainRows.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-500">Trade or bridge to see your chain mix.</p>
            ) : (
              <div className="space-y-3">
                {chainRows.map(([chainId, row]) => {
                  const network = getNetwork(chainId);
                  return (
                    <div key={chainId}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 text-gray-300"><ChainLogo chainKey={network?.key ?? ''} size={16} />{network?.name ?? chainId}</span>
                        <span className="font-mono text-gray-400">{formatUsd(row.volume)} · {row.count}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-gray-800">
                        <div className="h-full rounded-full" style={{ width: `${(row.volume / maxVolume) * 100}%`, background: network?.color ?? '#3fb0aa' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-gray-800/50 bg-gray-900/60 p-5">
            <div className="mb-4 flex items-center gap-2"><ArrowRightLeft className="h-4 w-4 text-brand-300" /><h2 className="text-sm font-semibold">Routes used</h2></div>
            {providers.length === 0 ? <p className="py-8 text-center text-sm text-gray-500">No routes yet.</p> : (
              <ul className="space-y-2 text-sm">
                {providers.map((item) => (
                  <li key={item.provider} className="flex items-center justify-between rounded-xl bg-gray-800/30 px-3 py-2">
                    <span className="text-gray-300">{item.label}</span>
                    <span className="font-mono text-white">{item.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="bg-gray-900/40 rounded-2xl border border-gray-800/50 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-brand-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-white">Where this data comes from</h2>
              <p className="text-sm text-gray-400 mt-1 leading-relaxed">
                Analytics are computed from the swaps and bridges you signed on this dashboard (kept in this browser) and your wallets&apos; live balances.
                USD values are the route&apos;s quoted value at execution. Hopr fees: 0.5% on swaps, 1% on bridges, included in every quote.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
