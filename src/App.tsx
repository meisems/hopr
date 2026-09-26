import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Zap, Shield, Activity, Menu, X, Github, MessageCircle, Search, Rocket, BarChart3, RefreshCw, ArrowRightLeft, Coins, BookOpen } from 'lucide-react';
import SearchBar from './components/SearchBar';
import ChartPanel from './components/ChartPanel';
import TradeCard from './components/TradeCard';
import PositionsTable from './components/PositionsTable';
import WalletPanel from './components/WalletPanel';
import SettingsModal from './components/SettingsModal';
import TelegramPreview from './components/TelegramPreview';
import SplashScreen from './components/SplashScreen';
import ChainLogo from './components/ChainLogo';
import DocsPage from './components/DocsPage';
import { DetectedToken } from './services/chainDetector';

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [currentPage, setCurrentPage] = useState<'dashboard' | 'docs'>('dashboard');
  const [selectedToken, setSelectedToken] = useState<DetectedToken | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSplashComplete = () => {
    setShowSplash(false);
  };

  // If on docs page, render it instead of dashboard
  if (currentPage === 'docs') {
    return <DocsPage onBack={() => setCurrentPage('dashboard')} />;
  }

  return (
    <>
      {/* Splash Screen */}
      <AnimatePresence>
        {showSplash && <SplashScreen onComplete={handleSplashComplete} />}
      </AnimatePresence>

      {/* Main App */}
      <div className={`min-h-screen bg-[#0a0b0f] text-white transition-opacity duration-700 ${showSplash ? 'opacity-0' : 'opacity-100'}`}>
      {/* Background gradient */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-600/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-blue-600/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-600/3 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-gray-800/50 bg-gray-900/30 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-gradient-to-br from-purple-500 to-blue-600 rounded-xl flex items-center justify-center">
                <Zap className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">
                  Hopr
                </h1>
                <p className="text-[10px] text-gray-500 -mt-0.5">Hop Across Chains</p>
              </div>
            </div>

            {/* Nav */}
            <nav className="hidden md:flex items-center gap-1">
              <a href="#" className="px-3 py-2 text-sm text-white bg-gray-800/50 rounded-lg font-medium">Dashboard</a>
              <a href="#" className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">Positions</a>
              <a href="#" className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">History</a>
              <a href="#" className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">Bridge</a>
              <button
                onClick={() => setCurrentPage('docs')}
                className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all flex items-center gap-1.5"
              >
                <BookOpen className="w-4 h-4" />
                Docs
              </button>
            </nav>

            {/* Right actions */}
            <div className="flex items-center gap-2">
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-full">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span className="text-xs text-green-400 font-medium">Connected</span>
              </div>
              <button
                onClick={() => setSettingsOpen(true)}
                className="p-2 hover:bg-gray-800 rounded-xl transition-colors"
              >
                <Settings className="w-5 h-5 text-gray-400" />
              </button>
              <a href="#" className="hidden sm:flex p-2 hover:bg-gray-800 rounded-xl transition-colors">
                <MessageCircle className="w-5 h-5 text-gray-400" />
              </a>
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="md:hidden p-2 hover:bg-gray-800 rounded-xl transition-colors"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="md:hidden border-t border-gray-800/50 bg-gray-900/90 backdrop-blur-xl"
          >
            <div className="px-4 py-3 space-y-1">
              <a href="#" className="block px-3 py-2 text-sm text-white bg-gray-800/50 rounded-lg">Dashboard</a>
              <a href="#" className="block px-3 py-2 text-sm text-gray-400 rounded-lg">Positions</a>
              <a href="#" className="block px-3 py-2 text-sm text-gray-400 rounded-lg">History</a>
              <a href="#" className="block px-3 py-2 text-sm text-gray-400 rounded-lg">Bridge</a>
              <button
                onClick={() => { setCurrentPage('docs'); setMobileMenuOpen(false); }}
                className="block w-full text-left px-3 py-2 text-sm text-gray-400 rounded-lg hover:bg-gray-800/30"
              >
                Docs
              </button>
            </div>
          </motion.div>
        )}
      </header>

      {/* Main content */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Search bar section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <SearchBar onTokenDetected={setSelectedToken} />
        </motion.section>

        {/* Stats bar */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        >
          <StatCard icon={<Activity className="w-4 h-4" />} label="24h Volume" value="$12.4M" change="+18.3%" positive />
          <StatCard icon={<Shield className="w-4 h-4" />} label="Trades Today" value="1,847" change="+24.1%" positive />
          <StatCard icon={<Zap className="w-4 h-4" />} label="Avg Speed" value="28s" change="-12%" positive />
          <StatCard icon={<Activity className="w-4 h-4" />} label="Active Users" value="3,421" change="+8.7%" positive />
        </motion.section>

        {/* Main trading area */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="grid grid-cols-1 lg:grid-cols-3 gap-6"
        >
          {/* Chart - takes 2 columns */}
          <div className="lg:col-span-2 min-h-[500px]">
            <ChartPanel token={selectedToken} />
          </div>

          {/* Trade card + Wallet */}
          <div className="space-y-4">
            <TradeCard token={selectedToken} />
            <WalletPanel />
          </div>
        </motion.section>

        {/* Positions table */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <PositionsTable />
        </motion.section>

        {/* Telegram Bot Preview + How it works */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="grid grid-cols-1 lg:grid-cols-2 gap-6"
        >
          <TelegramPreview />
          
          {/* How it works */}
          <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
            <h3 className="text-lg font-semibold text-white mb-4">How It Works</h3>
            <div className="space-y-4">
              {[
                { step: '1', title: 'Paste Any Address', desc: 'Paste a token contract address from any supported chain. Our engine auto-detects the chain instantly.', icon: Search },
                { step: '2', title: 'One-Tap Buy', desc: 'Click your desired amount. The system routes through LI.FI to bridge and swap in a single transaction.', icon: Rocket },
                { step: '3', title: 'Auto Track', desc: 'Your position is tracked with round-trip routing. Sell anytime and proceeds return to your original funding chain.', icon: BarChart3 },
                { step: '4', title: 'Dual Interface', desc: 'Trade via Telegram bot or this web dashboard. Both share the same wallet and positions.', icon: RefreshCw },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.step} className="flex gap-3">
                    <div className="flex-shrink-0 w-10 h-10 bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-purple-500/20 rounded-xl flex items-center justify-center">
                      <Icon className="w-5 h-5 text-purple-400" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-white">{item.title}</div>
                      <div className="text-xs text-gray-400 mt-0.5 leading-relaxed">{item.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Architecture note */}
            <div className="mt-6 p-3 bg-gray-800/40 rounded-xl border border-gray-700/30">
              <div className="text-xs text-gray-400 leading-relaxed">
                <span className="text-purple-400 font-medium">Architecture:</span> Powered by LI.FI cross-chain API with automatic chain resolution via DexScreener + multi-chain RPC probing. Supports Solana (SVM) and 5 EVM chains including Robinhood Chain and Arc Chain.
              </div>
            </div>
          </div>
        </motion.section>

        {/* Supported chains */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="bg-gray-900/40 rounded-2xl border border-gray-800/50 p-6"
        >
          <h3 className="text-sm font-semibold text-gray-400 mb-4">Supported Chains</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { name: 'Solana', symbol: 'SOL', key: 'sol', status: 'Active' },
              { name: 'Arbitrum', symbol: 'ETH', key: 'arb', status: 'Active' },
              { name: 'Base', symbol: 'ETH', key: 'base', status: 'Active' },
              { name: 'BNB Chain', symbol: 'BNB', key: 'bsc', status: 'Active' },
              { name: 'Robinhood', symbol: 'ETH', key: 'rhc', status: 'Active' },
              { name: 'Arc Chain', symbol: 'USDC', key: 'arc', status: 'Active' },
            ].map((chain) => (
              <div key={chain.name} className="flex items-center gap-2 p-3 bg-gray-800/30 rounded-xl border border-gray-800/30 hover:border-gray-700/50 transition-all">
                <ChainLogo chainKey={chain.key} size={28} />
                <div>
                  <div className="text-xs font-medium text-white">{chain.name}</div>
                  <div className="text-[10px] text-gray-500">{chain.symbol} • {chain.status}</div>
                </div>
              </div>
            ))}
          </div>
        </motion.section>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-gray-800/50 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-purple-400" />
              <span className="text-sm text-gray-400">Hopr – Powered by LI.FI</span>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => setCurrentPage('docs')} className="text-xs text-gray-500 hover:text-white transition-colors">Docs</button>
              <a href="#" className="text-xs text-gray-500 hover:text-white transition-colors">API</a>
              <a href="#" className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors">
                <Github className="w-3 h-3" /> GitHub
              </a>
              <a href="#" className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors">
                <MessageCircle className="w-3 h-3" /> Telegram Bot
              </a>
            </div>
          </div>
        </div>
      </footer>

      {/* Settings Modal */}
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
    </>
  );
}

function StatCard({ icon, label, value, change, positive }: { icon: React.ReactNode; label: string; value: string; change: string; positive: boolean }) {
  return (
    <div className="bg-gray-900/60 rounded-xl border border-gray-800/50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-purple-400">{icon}</span>
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <div className="flex items-end justify-between">
        <span className="text-xl font-bold text-white">{value}</span>
        <span className={`text-xs font-medium ${positive ? 'text-green-400' : 'text-red-400'}`}>{change}</span>
      </div>
    </div>
  );
}

export default App;
