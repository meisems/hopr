import { ArrowLeft, Activity, BarChart3, DollarSign, Shield, Users, Zap } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

interface AnalyticsPageProps {
  onBack: () => void;
}

function MetricCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-brand-400">{icon}</span>
        <span className="text-sm text-gray-400">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-gray-500 mt-2">{detail}</div>
    </div>
  );
}

export default function AnalyticsPage({ onBack }: AnalyticsPageProps) {
  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      <header className="navbar-dark sticky top-0 z-40 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur-xl safe-area-top">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2 sm:gap-4">
              <button onClick={onBack} className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-2 text-xs sm:text-sm text-gray-400 hover:text-white hover:bg-gray-800/50 rounded-lg transition-all">
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Back to Dashboard</span>
              </button>
              <div className="h-6 w-px bg-gray-800 hidden sm:block" />
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 sm:w-5 sm:h-5 text-brand-400" />
                <h1 className="text-base sm:text-lg font-semibold text-white">Analytics</h1>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <section>
          <p className="text-sm text-gray-400">Platform activity and volume, separate from token market data.</p>
          <h2 className="text-2xl font-bold text-white mt-1">Platform overview</h2>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-2 gap-4" aria-label="Platform volume">
          <MetricCard icon={<Activity className="w-5 h-5" />} label="24h Volume" value="$0.00" detail="No completed platform trades yet" />
          <MetricCard icon={<BarChart3 className="w-5 h-5" />} label="Total Volume" value="$0.00" detail="All-time completed platform trades" />
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-label="Platform analytics">
          <MetricCard icon={<Users className="w-5 h-5" />} label="Active Users" value="—" detail="Analytics source not connected" />
          <MetricCard icon={<DollarSign className="w-5 h-5" />} label="Platform Fees" value="$0.00" detail="No completed platform trades yet" />
          <MetricCard icon={<Zap className="w-5 h-5" />} label="Fee Policy" value="1% / 0.5%" detail="Bridge / token swap" />
        </section>

        <section className="bg-gray-900/40 rounded-2xl border border-gray-800/50 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-brand-400 mt-0.5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-white">Analytics scope</h2>
              <p className="text-sm text-gray-400 mt-1 leading-relaxed">These cards track Hopr platform activity. Token price, liquidity, 24h pool volume, and chart history remain on the dashboard after a token is scanned, so market data is not duplicated here.</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
