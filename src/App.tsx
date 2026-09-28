import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { Settings, Shield, Menu, X, Github, MessageCircle, Search, BarChart3, BookOpen, Wallet } from 'lucide-react';
import SearchBar, { type ScanRequest } from './components/SearchBar';
import TrendingRail from './components/TrendingRail';
import TradeCard from './components/TradeCard';
import PositionsTable from './components/PositionsTable';
import WalletPanel from './components/WalletPanel';
import ConnectWalletModal from './components/ConnectWalletModal';
import WalletButton from './components/WalletButton';
import { OPEN_TOKEN_KEY } from './components/PositionsTable';
import ChainLogo from './components/ChainLogo';
import ThemeToggle from './components/ThemeToggle';
import { ThemeProvider } from './context/ThemeContext';
import { BlackHoleSettingsProvider, useBlackHoleSettings } from './context/BlackHoleContext';
import { WalletProvider } from './context/WalletContext';
import { DetectedToken } from './services/chainDetector';
import { TELEGRAM_BOT_URL } from './services/api';

// Page chunks are split for a fast first paint, then warmed in the background
// (and on hover) so switching pages never shows a loading state in practice.
const loaders = {
  splash: () => import('./components/SplashScreen'),
  chart: () => import('./components/ChartPanel'),
  docs: () => import('./components/DocsPage'),
  positions: () => import('./components/PositionsPage'),
  history: () => import('./components/HistoryPage'),
  bridge: () => import('./components/BridgePage'),
  analytics: () => import('./components/AnalyticsPage'),
  settings: () => import('./components/SettingsPage'),
  wallets: () => import('./components/WalletsPage'),
  rewards: () => import('./components/RewardsPage'),
};

const SplashScreen = lazy(loaders.splash);
const ChartPanel = lazy(loaders.chart);
const DocsPage = lazy(loaders.docs);
const PositionsPage = lazy(loaders.positions);
const HistoryPage = lazy(loaders.history);
const BridgePage = lazy(loaders.bridge);
const AnalyticsPage = lazy(loaders.analytics);
const SettingsPage = lazy(loaders.settings);
const WalletsPage = lazy(loaders.wallets);
const RewardsPage = lazy(loaders.rewards);

type Page = 'dashboard' | 'analytics' | 'positions' | 'history' | 'bridge' | 'docs' | 'settings' | 'wallets' | 'rewards';
const PAGE_PATHS: Record<Page, string> = { dashboard: '/', analytics: '/analytics', positions: '/positions', history: '/history', bridge: '/bridge', docs: '/docs', settings: '/settings', wallets: '/wallets', rewards: '/rewards' };
const PAGE_TITLES: Record<Page, string> = { dashboard: 'Dashboard', analytics: 'Analytics', positions: 'Active Positions', history: 'Trade History', bridge: 'Bridge', docs: 'Documentation', settings: 'Settings', wallets: 'Wallet Vault', rewards: 'Rewards' };
const NAV_ITEMS: { page: Page; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'analytics', label: 'Analytics' },
  { page: 'positions', label: 'Positions' },
  { page: 'history', label: 'History' },
  { page: 'bridge', label: 'Bridge' },
  { page: 'rewards', label: 'Rewards' },
  { page: 'wallets', label: 'Wallets' },
  { page: 'settings', label: 'Settings' },
  { page: 'docs', label: 'Docs' },
];
const SPLASH_SEEN_KEY = 'hopr-splash-seen';

function pageFromPath(pathname: string): Page {
  const match = (Object.entries(PAGE_PATHS) as [Page, string][]).find(([, path]) => path === pathname);
  return match?.[0] ?? 'dashboard';
}

function prefetch(page: Page) {
  if (page !== 'dashboard') void loaders[page]().catch(() => undefined);
}

/** The black-hole intro plays once per browser session, on the dashboard. */
function shouldPlaySplash(initialPage: Page): boolean {
  if (initialPage !== 'dashboard') return false;
  try {
    return sessionStorage.getItem(SPLASH_SEEN_KEY) !== '1';
  } catch {
    return true;
  }
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
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-4" role="status" aria-label="Loading page">
      <div className="skeleton h-4 w-32 rounded-lg" />
      <div className="skeleton h-9 w-64 rounded-xl" />
      <div className="skeleton h-48 w-full rounded-2xl" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="skeleton h-28 rounded-2xl" />
        <div className="skeleton h-28 rounded-2xl" />
        <div className="skeleton h-28 rounded-2xl" />
      </div>
    </div>
  );
}

const sectionMotion = (delay: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { delay, duration: 0.45, ease: [0.22, 1, 0.36, 1] },
});

function Dashboard({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const [selectedToken, setSelectedToken] = useState<DetectedToken | null>(null);
  const [scanRequest, setScanRequest] = useState<ScanRequest | null>(null);
  const searchRef = useRef<HTMLElement>(null);

  const scanFromRail = useCallback((address: string) => {
    setScanRequest({ address, nonce: Date.now() });
    searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // A token opened from the Positions page ("Trade") loads straight into the trade card.
  useEffect(() => {
    try {
      const address = sessionStorage.getItem(OPEN_TOKEN_KEY);
      if (!address) return;
      sessionStorage.removeItem(OPEN_TOKEN_KEY);
      setScanRequest({ address, nonce: Date.now() });
    } catch {
      // Storage unavailable: nothing to open.
    }
  }, []);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Hero + command search */}
      <motion.section ref={searchRef} {...sectionMotion(0.05)} className="scroll-mt-24">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="hero-title text-2xl font-bold tracking-tight sm:text-3xl">Scan it. Route it. Trade it.</h1>
            <p className="mt-1 text-sm text-gray-500">Any token on 7 chains — auto-detected, quoted live, confirmed by you.</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
            {['LI.FI routing', 'Ref Finance', 'Telegram synced'].map((label) => (
              <span key={label} className="rounded-full border border-gray-800/70 bg-gray-900/60 px-2.5 py-1 text-gray-400">{label}</span>
            ))}
          </div>
        </div>
        <SearchBar onTokenDetected={setSelectedToken} scanRequest={scanRequest} />
      </motion.section>

      {/* Live trending tokens across supported chains */}
      <motion.div {...sectionMotion(0.09)}>
        <TrendingRail onSelect={scanFromRail} />
      </motion.div>

      {/* Main trading area */}
      <motion.section {...sectionMotion(0.12)} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart - takes 2 columns */}
        <div className="lg:col-span-2 min-h-[500px]">
          <Suspense fallback={<div className="skeleton h-full min-h-[500px] rounded-2xl border border-gray-800/50" aria-label="Loading chart" />}>
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
      <motion.section {...sectionMotion(0.18)}>
        <PositionsTable onOpenToken={scanFromRail} />
      </motion.section>

      {/* How it works */}
      <motion.section {...sectionMotion(0.24)} className="grid grid-cols-1 gap-6">
        <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
          <h3 className="text-lg font-semibold tracking-tight text-white mb-5">How It Works</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { step: '1', title: 'Scan a Token', desc: 'Paste any EVM, Solana or NEAR token address to resolve its chain and market data.', icon: Search },
              { step: '2', title: 'Review Token Data', desc: 'Inspect the live chart, liquidity, FDV, volume, and price movement without connecting a wallet.', icon: BarChart3 },
              { step: '3', title: 'Connect Your Wallets', desc: 'Connect EVM, Solana and NEAR wallets — pay from any chain and receive on the token’s chain in one tap.', icon: Wallet },
              { step: '4', title: 'Sign in Your Wallet', desc: 'Hopr picks the route (LI.FI, Ref Finance or NEAR Intents); you approve it in your own wallet. Keys never leave it.', icon: Shield },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.step} className="card-lift relative rounded-xl border border-gray-800/60 bg-gray-800/30 p-4">
                  <span className="absolute right-4 top-4 font-mono text-[11px] font-medium text-gray-600">0{item.step}</span>
                  <div className="w-10 h-10 bg-gradient-to-br from-brand-500/20 to-brand-400/10 border border-brand-500/25 rounded-xl flex items-center justify-center">
                    <Icon className="w-5 h-5 text-brand-300" />
                  </div>
                  <div className="mt-3 text-sm font-semibold text-white">{item.title}</div>
                  <div className="text-xs text-gray-400 mt-1 leading-relaxed">{item.desc}</div>
                </div>
              );
            })}
          </div>

          {/* Architecture note */}
          <div className="mt-5 p-3 bg-gray-800/40 rounded-xl border border-gray-700/30">
            <div className="text-xs text-gray-400 leading-relaxed">
              <span className="text-brand-300 font-medium">Architecture:</span> Powered by LI.FI cross-chain API with automatic chain resolution via DexScreener + multi-chain RPC probing. Supports Solana (SVM), 5 EVM chains including Robinhood Chain and Arc Chain, and NEAR Protocol via Ref Finance.
            </div>
          </div>
        </div>
      </motion.section>

      {/* Supported chains */}
      <motion.section {...sectionMotion(0.3)} className="bg-gray-900/40 rounded-2xl border border-gray-800/50 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-400">Supported Chains</h3>
          <button onClick={() => onNavigate('bridge')} onMouseEnter={() => prefetch('bridge')} className="pressable text-xs font-medium text-brand-300 hover:text-brand-200">Bridge assets →</button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { name: 'Solana', symbol: 'SOL', key: 'sol', status: 'Active' },
            { name: 'Arbitrum', symbol: 'ETH', key: 'arb', status: 'Active' },
            { name: 'Base', symbol: 'ETH', key: 'base', status: 'Active' },
            { name: 'BNB Chain', symbol: 'BNB', key: 'bsc', status: 'Active' },
            { name: 'Robinhood', symbol: 'ETH', key: 'rhc', status: 'Active' },
            { name: 'Arc Chain', symbol: 'USDC', key: 'arc', status: 'Active' },
            { name: 'NEAR', symbol: 'NEAR', key: 'near', status: 'Active' },
          ].map((chain) => (
            <div key={chain.name} className="card-lift flex items-center gap-2.5 p-3 bg-gray-800/30 rounded-xl border border-gray-800/40 hover:border-brand-400/30">
              <ChainLogo chainKey={chain.key} size={28} />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-white">{chain.name}</div>
                <div className="flex items-center gap-1 text-[10px] text-gray-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                  {chain.symbol} · {chain.status}
                </div>
              </div>
            </div>
          ))}
        </div>
      </motion.section>
    </main>
  );
}

function AppContent() {
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    return pageFromPath(window.location.pathname);
  });
  const [preloaderPhase, setPreloaderPhase] = useState<'loading' | 'exiting' | 'ready'>(() => shouldPlaySplash(currentPage) ? 'loading' : 'ready');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [splashRun, setSplashRun] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const firstRender = useRef(true);

  useEffect(() => {
    document.title = `${PAGE_TITLES[currentPage]} · Hopr`;
    try {
      localStorage.setItem('hopr-page', currentPage);
    } catch {
      // Storage may be blocked; navigation still works.
    }
  }, [currentPage]);

  useEffect(() => {
    window.history.replaceState({ page: currentPage }, '', PAGE_PATHS[currentPage]);
    const handlePopState = () => {
      setCurrentPage(pageFromPath(window.location.pathname));
      setMobileMenuOpen(false);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Warm every page chunk once the browser is idle.
  useEffect(() => {
    const warm = () => (Object.keys(PAGE_PATHS) as Page[]).forEach(prefetch);
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(warm) : window.setTimeout(warm, 1500);
    return () => {
      if (!idle) window.clearTimeout(handle);
    };
  }, []);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [currentPage]);

  const navigate = useCallback((page: Page) => {
    setMobileMenuOpen(false);
    setCurrentPage((current) => {
      if (current !== page) window.history.pushState({ page }, '', PAGE_PATHS[page]);
      return page;
    });
  }, []);

  const goHome = useCallback(() => navigate('dashboard'), [navigate]);

  const previewBlackHole = () => {
    setSplashRun((run) => run + 1);
    setPreloaderPhase('loading');
  };

  const finishSplash = () => {
    setPreloaderPhase('ready');
    try {
      sessionStorage.setItem(SPLASH_SEEN_KEY, '1');
    } catch {
      // Without storage the intro simply plays again next load.
    }
  };

  const preloader = preloaderPhase === 'ready' ? null : (
    <div className="preloader-layer" aria-hidden={preloaderPhase === 'exiting'}>
      <BlackHoleSplash
        key={splashRun}
        isExiting={preloaderPhase === 'exiting'}
        onExitStart={() => setPreloaderPhase('exiting')}
        onExitComplete={finishSplash}
      />
    </div>
  );

  const renderPage = () => {
    switch (currentPage) {
      case 'docs': return <DocsPage onBack={goHome} />;
      case 'positions': return <PositionsPage onBack={goHome} />;
      case 'history': return <HistoryPage onBack={goHome} />;
      case 'bridge': return <BridgePage onBack={goHome} />;
      case 'analytics': return <AnalyticsPage onBack={goHome} />;
      case 'settings': return <SettingsPage onBack={goHome} onOpenWallets={() => navigate('wallets')} onPreviewBlackHole={previewBlackHole} />;
      case 'wallets': return <WalletsPage onBack={goHome} />;
      case 'rewards': return <RewardsPage onBack={goHome} />;
      default: return <Dashboard onNavigate={navigate} />;
    }
  };

  const dashboardClassName = `app-page${preloaderPhase !== 'loading' ? ' app-page--ready' : ''}`;

  return (
    <>
      {preloader}
      <ConnectWalletModal />

      <div className={`${dashboardClassName} relative min-h-screen text-white`}>
        <div className="app-backdrop" aria-hidden />

        {/* Header */}
        <header className={`glass-header sticky top-0 z-40 border-b safe-area-top transition-[border-color,box-shadow] duration-300 ${scrolled ? 'border-gray-800/70 shadow-[0_8px_30px_-18px_rgba(0,0,0,0.45)]' : 'border-transparent'}`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-16 gap-3">
              {/* Logo */}
              <button onClick={goHome} className="pressable flex items-center gap-2.5 rounded-xl pr-2" aria-label="Hopr dashboard">
                <div className="w-9 h-9 flex items-center justify-center">
                  <img src="/brand/logo-icon.png" alt="" className="w-full h-full object-contain drop-shadow-[0_0_10px_rgba(63,176,170,0.45)]" />
                </div>
                <div className="text-left">
                  <span className="block text-lg font-bold leading-tight tracking-tight gradient-text">hopr</span>
                  <span className="block text-[10px] text-gray-500 -mt-0.5">Hop Across Chains</span>
                </div>
              </button>

              {/* Nav */}
              <nav className="hidden lg:flex items-center gap-0.5 rounded-xl border border-gray-800/60 bg-gray-900/50 p-1" aria-label="Main">
                {NAV_ITEMS.map(({ page, label }) => {
                  const active = currentPage === page;
                  return (
                    <button
                      key={page}
                      onClick={() => navigate(page)}
                      onMouseEnter={() => prefetch(page)}
                      onFocus={() => prefetch(page)}
                      aria-current={active ? 'page' : undefined}
                      className={`relative px-3 py-1.5 text-sm rounded-lg font-medium transition-colors duration-200 flex items-center gap-1.5 ${active ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                    >
                      {active && (
                        <motion.span
                          layoutId="nav-active-pill"
                          className="absolute inset-0 -z-10 rounded-lg border border-gray-700/60 bg-gray-800"
                          transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                        />
                      )}
                      {page === 'docs' && <BookOpen className="w-4 h-4" />}
                      {label}
                    </button>
                  );
                })}
              </nav>

              {/* Right actions */}
              <div className="flex items-center gap-2">
                <ThemeToggle />
                <WalletButton />
                <div className="hidden xl:flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-full">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
                  </span>
                  <span className="text-xs text-green-400 font-medium">Online</span>
                </div>
                <button
                  onClick={() => navigate('settings')}
                  onMouseEnter={() => prefetch('settings')}
                  className="settings-trigger pressable hidden sm:flex p-2 rounded-xl hover:bg-gray-800/70"
                  aria-label="Open settings"
                >
                  <Settings className="w-5 h-5 text-gray-400 transition-transform duration-300" />
                </button>
                {TELEGRAM_BOT_URL && (
                  <a href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer" className="pressable hidden sm:flex p-2 hover:bg-gray-800/70 rounded-xl" aria-label="Open the Telegram bot">
                    <MessageCircle className="w-5 h-5 text-gray-400" />
                  </a>
                )}
                <button
                  onClick={() => setMobileMenuOpen((open) => !open)}
                  className="pressable lg:hidden p-2 hover:bg-gray-800/70 rounded-xl"
                  aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
                  aria-expanded={mobileMenuOpen}
                >
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={mobileMenuOpen ? 'close' : 'open'}
                      initial={{ opacity: 0, rotate: -45 }}
                      animate={{ opacity: 1, rotate: 0 }}
                      exit={{ opacity: 0, rotate: 45 }}
                      transition={{ duration: 0.15 }}
                      className="block"
                    >
                      {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                    </motion.span>
                  </AnimatePresence>
                </button>
              </div>
            </div>
          </div>

          {/* Mobile menu */}
          <AnimatePresence initial={false}>
            {mobileMenuOpen && (
              <motion.div
                key="mobile-menu"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                className="lg:hidden overflow-hidden border-t border-gray-800/60"
              >
                <nav className="grid grid-cols-2 gap-1.5 px-4 py-3 sm:grid-cols-4" aria-label="Mobile">
                  {NAV_ITEMS.map(({ page, label }, index) => {
                    const active = currentPage === page;
                    return (
                      <motion.button
                        key={page}
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.02 * index, duration: 0.2 }}
                        onClick={() => navigate(page)}
                        aria-current={active ? 'page' : undefined}
                        className={`pressable w-full text-left px-3 py-2.5 text-sm rounded-xl border ${active ? 'border-brand-400/30 bg-brand-500/15 text-white font-medium' : 'border-transparent text-gray-400 hover:bg-gray-800/60 hover:text-white'}`}
                      >
                        {label}
                      </motion.button>
                    );
                  })}
                </nav>
              </motion.div>
            )}
          </AnimatePresence>
        </header>

        {/* Enter-only transition: the next page mounts immediately (no waiting on an exit animation). */}
        <div key={currentPage} className="page-enter relative z-10">
          <Suspense fallback={<PageLoading />}>{renderPage()}</Suspense>
        </div>

        {/* Footer */}
        <footer className="relative z-10 border-t border-gray-800/50 mt-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 safe-area-bottom">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <img src="/brand/logo-icon.png" alt="" className="w-4 h-4 object-contain" />
                <span className="text-sm text-gray-400">hopr – Powered by LI.FI</span>
              </div>
              <div className="flex items-center gap-4">
                <button onClick={() => navigate('docs')} className="text-xs text-gray-500 hover:text-white transition-colors">Docs</button>
                <a href="https://github.com/meisems/hopr" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors">
                  <Github className="w-3 h-3" /> GitHub
                </a>
                {TELEGRAM_BOT_URL && (
                  <a href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors">
                    <MessageCircle className="w-3 h-3" /> Telegram Bot
                  </a>
                )}
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <WalletProvider>
          <BlackHoleSettingsProvider>
            <AppContent />
          </BlackHoleSettingsProvider>
        </WalletProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
