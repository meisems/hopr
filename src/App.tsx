import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Settings, Shield, Menu, X, Github, MessageCircle, Search, BarChart3, BookOpen, Wallet } from 'lucide-react';
import SearchBar from './components/SearchBar';
import TradeCard from './components/TradeCard';
import PositionsTable from './components/PositionsTable';
import WalletPanel from './components/WalletPanel';
import ChainLogo from './components/ChainLogo';
import ThemeToggle from './components/ThemeToggle';
import { ThemeProvider } from './context/ThemeContext';
import { BlackHoleSettingsProvider, useBlackHoleSettings } from './context/BlackHoleContext';
import { WalletProvider } from './context/WalletContext';
import { DetectedToken } from './services/chainDetector';

const SplashScreen = lazy(() => import('./components/SplashScreen'));
const ChartPanel = lazy(() => import('./components/ChartPanel'));
const DocsPage = lazy(() => import('./components/DocsPage'));
const PositionsPage = lazy(() => import('./components/PositionsPage'));
const HistoryPage = lazy(() => import('./components/HistoryPage'));
const BridgePage = lazy(() => import('./components/BridgePage'));
const AnalyticsPage = lazy(() => import('./components/AnalyticsPage'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
const WalletsPage = lazy(() => import('./components/WalletsPage'));

type Page = 'dashboard' | 'analytics' | 'positions' | 'history' | 'bridge' | 'docs' | 'settings' | 'wallets';
const PAGE_PATHS: Record<Page, string> = { dashboard: '/', analytics: '/analytics', positions: '/positions', history: '/history', bridge: '/bridge', docs: '/docs', settings: '/settings', wallets: '/wallets' };
const PAGE_TITLES: Record<Page, string> = { dashboard: 'Dashboard', analytics: 'Analytics', positions: 'Active Positions', history: 'Trade History', bridge: 'Bridge', docs: 'Documentation', settings: 'Settings', wallets: 'Wallet Vault' };

function pageFromPath(pathname: string): Page {
  const match = (Object.entries(PAGE_PATHS) as [Page, string][]).find(([, path]) => path === pathname);
  return match?.[0] ?? 'dashboard';
}

function BlackHoleSplash({ isExiting, onExitStart, onExitComplete }: { isExiting: boolean; onExitStart: () => void; onExitComplete: () => void }) {
  const { settings } = useBlackHoleSettings();
  return (
    <Suspense fallback={<div className="preloader-overlay" aria-label="Loading black-hole animation" />}>
      <SplashScreen
        isExiting={isExiting}
        onExitStart={onExitStart}
        onExitComplete={onExitComplete}
        spin={settings.spin}
        inclination={settings.inclination}
      />
    </Suspense>
  );
}

function PageLoading() {
  return <div className="min-h-[45vh] flex items-center justify-center text-sm text-gray-500" role="status">Loading page…</div>;
}

function AppContent() {
  const [preloaderPhase, setPreloaderPhase] = useState<'loading' | 'exiting' | 'ready'>('loading');
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    return pageFromPath(window.location.pathname);
  });
  const [selectedToken, setSelectedToken] = useState<DetectedToken | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [splashRun, setSplashRun] = useState(0);

  useEffect(() => {
    document.title = `${PAGE_TITLES[currentPage]} · Hopr`;
    window.history.replaceState({ page: currentPage }, '', PAGE_PATHS[currentPage]);
    localStorage.setItem('hopr-page', currentPage);
  }, [currentPage]);

  useEffect(() => {
    const handlePopState = () => setCurrentPage(pageFromPath(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const previewBlackHole = () => {
    setSplashRun((run) => run + 1);
    setPreloaderPhase('loading');
  };

  const preloader = preloaderPhase === 'ready' ? null : (
    <div className="preloader-layer" aria-hidden={preloaderPhase === 'exiting'}>
      <BlackHoleSplash
        key={splashRun}
        isExiting={preloaderPhase === 'exiting'}
        onExitStart={() => setPreloaderPhase('exiting')}
        onExitComplete={() => setPreloaderPhase('ready')}
      />
    </div>
  );

  const dashboardClassName = `app-page${preloaderPhase !== 'loading' ? ' app-page--ready' : ''}`;

  // If on docs page, render it instead of dashboard
  if (currentPage === 'docs') {
    return <Suspense fallback={<PageLoading />}><DocsPage onBack={() => setCurrentPage('dashboard')} /></Suspense>;
  }

  if (currentPage === 'positions') return <Suspense fallback={<PageLoading />}><PositionsPage onBack={() => setCurrentPage('dashboard')} /></Suspense>;
  if (currentPage === 'history') return <Suspense fallback={<PageLoading />}><HistoryPage onBack={() => setCurrentPage('dashboard')} /></Suspense>;
  if (currentPage === 'bridge') return <Suspense fallback={<PageLoading />}><BridgePage onBack={() => setCurrentPage('dashboard')} /></Suspense>;
  if (currentPage === 'analytics') return <Suspense fallback={<PageLoading />}><AnalyticsPage onBack={() => setCurrentPage('dashboard')} /></Suspense>;
  if (currentPage === 'settings') return <Suspense fallback={<PageLoading />}><SettingsPage onBack={() => setCurrentPage('dashboard')} onOpenWallets={() => setCurrentPage('wallets')} onPreviewBlackHole={previewBlackHole} /></Suspense>;
  if (currentPage === 'wallets') return <Suspense fallback={<PageLoading />}><WalletsPage onBack={() => setCurrentPage('dashboard')} /></Suspense>;

  return (
    <>
      {preloader}

      {/* Main App */}
      <div className={`${dashboardClassName} min-h-screen bg-[#0a0b0f] text-white`}>
      {/* Background gradient */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-brand-500/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-brand-400/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-brand-600/3 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <header className="navbar-dark relative z-10 border-b border-gray-800/50 bg-gray-900/30 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 flex items-center justify-center">
                <img src="/brand/logo-icon.png" alt="Hopr" className="w-full h-full object-contain drop-shadow-[0_0_10px_rgba(63,176,170,0.45)]" />
              </div>
              <div>
                <h1 className="text-lg font-bold gradient-text">
                  hopr
                </h1>
                <p className="text-[10px] text-gray-500 -mt-0.5">Hop Across Chains</p>
              </div>
            </div>

            {/* Nav */}
            <nav className="hidden md:flex items-center gap-1">
              <button onClick={() => setCurrentPage('dashboard')} className="px-3 py-2 text-sm text-white bg-gray-800/50 rounded-lg font-medium">Dashboard</button>
              <button onClick={() => setCurrentPage('analytics')} className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">Analytics</button>
              <button onClick={() => setCurrentPage('positions')} className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">Positions</button>
              <button onClick={() => setCurrentPage('history')} className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">History</button>
              <button onClick={() => setCurrentPage('bridge')} className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">Bridge</button>
              <button onClick={() => setCurrentPage('wallets')} className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">Wallets</button>
              <button onClick={() => setCurrentPage('settings')} className="px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/30 rounded-lg transition-all">Settings</button>
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
              <ThemeToggle />
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-full">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span className="text-xs text-green-400 font-medium">Dashboard online</span>
              </div>
              <button
                onClick={() => setCurrentPage('settings')}
                className="settings-trigger p-2 rounded-xl transition-all duration-200 hover:bg-gray-800 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300/70"
                aria-label="Open settings"
              >
                <Settings className="w-5 h-5 text-gray-400 transition-transform duration-300 group-hover:rotate-45" />
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
            className="navbar-drawer subnav-dark md:hidden border-t border-gray-800/50 bg-gray-900/95 backdrop-blur-xl"
          >
            <div className="px-4 py-3 space-y-1">
              <button onClick={() => { setCurrentPage('dashboard'); setMobileMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-sm text-white bg-gray-800/50 rounded-lg">Dashboard</button>
              <button onClick={() => { setCurrentPage('analytics'); setMobileMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-sm text-gray-400 rounded-lg">Analytics</button>
              <button onClick={() => { setCurrentPage('positions'); setMobileMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-sm text-gray-400 rounded-lg">Positions</button>
              <button onClick={() => { setCurrentPage('history'); setMobileMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-sm text-gray-400 rounded-lg">History</button>
              <button onClick={() => { setCurrentPage('bridge'); setMobileMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-sm text-gray-400 rounded-lg">Bridge</button>
              <button onClick={() => { setCurrentPage('wallets'); setMobileMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-sm text-gray-400 rounded-lg">Wallets</button>
              <button onClick={() => { setCurrentPage('settings'); setMobileMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-sm text-gray-400 rounded-lg">Settings</button>
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

        {/* Main trading area */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="grid grid-cols-1 lg:grid-cols-3 gap-6"
        >
          {/* Chart - takes 2 columns */}
          <div className="lg:col-span-2 min-h-[500px]">
            <Suspense fallback={<div className="h-full min-h-[500px] rounded-2xl border border-gray-800/50 bg-gray-900/40" aria-label="Loading chart" />}>
              <ChartPanel token={selectedToken} />
            </Suspense>
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

        {/* How it works */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="grid grid-cols-1 gap-6"
        >
          <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
            <h3 className="text-lg font-semibold text-white mb-4">How It Works</h3>
            <div className="space-y-4">
              {[
                { step: '1', title: 'Scan a Token', desc: 'Paste any supported EVM or Solana token address to resolve its chain and market data.', icon: Search },
                { step: '2', title: 'Review Token Data', desc: 'Inspect the live chart, liquidity, FDV, volume, and price movement without connecting a wallet.', icon: BarChart3 },
                { step: '3', title: 'Connect Only to Buy', desc: 'Connect an EVM wallet only when you are ready to request a buy quote and confirm a transaction.', icon: Wallet },
                { step: '4', title: 'Confirm in Wallet', desc: 'Review the fresh LI.FI route, then approve the transaction in your browser wallet.', icon: Shield },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.step} className="flex gap-3">
                    <div className="flex-shrink-0 w-10 h-10 bg-gradient-to-br from-brand-500/20 to-brand-400/20 border border-brand-500/20 rounded-xl flex items-center justify-center">
                      <Icon className="w-5 h-5 text-brand-400" />
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
                <span className="text-brand-400 font-medium">Architecture:</span> Powered by LI.FI cross-chain API with automatic chain resolution via DexScreener + multi-chain RPC probing. Supports Solana (SVM) and 5 EVM chains including Robinhood Chain and Arc Chain.
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
              <img src="/brand/logo-icon.png" alt="Hopr" className="w-4 h-4 object-contain" />
              <span className="text-sm text-gray-400">hopr – Powered by LI.FI</span>
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
    </div>
    </>
  );
}


export default function App() {
  return (
      <ThemeProvider>
      <WalletProvider>
      <BlackHoleSettingsProvider>
        <AppContent />
      </BlackHoleSettingsProvider>
      </WalletProvider>
    </ThemeProvider>
  );
}
