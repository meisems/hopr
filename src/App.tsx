import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { Settings, Shield, Menu, X, Github, Send, Search, BarChart3, BookOpen, Wallet, ArrowRight } from 'lucide-react';
import SearchBar, { type ScanRequest } from './components/SearchBar';
import TrendingRail from './components/TrendingRail';
import LaunchpadPools from './components/LaunchpadPools';
import ChainLogo from './components/ChainLogo';
import ThemeToggle from './components/ThemeToggle';
import { ThemeProvider } from './context/ThemeContext';
import { BlackHoleSettingsProvider, useBlackHoleSettings } from './context/BlackHoleContext';
import { DetectedToken } from './services/chainDetector';
import TelegramTradeCard from './components/TelegramTradeCard';
import BotPreview from './components/BotPreview';
import BrandLogo from './components/BrandLogo';
import { useTelegramBotUrl } from './services/telegramLinks';

// Page chunks are split for a fast first paint, then warmed in the background
// (and on hover) so switching pages never shows a loading state in practice.
const loaders = {
  splash: () => import('./components/SplashScreen'),
  chart: () => import('./components/ChartPanel'),
  docs: () => import('./components/DocsPage'),
  settings: () => import('./components/SettingsPage'),
};

const SplashScreen = lazy(loaders.splash);
const ChartPanel = lazy(loaders.chart);
const DocsPage = lazy(loaders.docs);
const SettingsPage = lazy(loaders.settings);

// The website is a read-only viewer: scan, charts, trending and launch radar.
// Trading, wallets and portfolio live in the Telegram bot.
type Page = 'dashboard' | 'docs' | 'settings';
const PAGE_PATHS: Record<Page, string> = { dashboard: '/', docs: '/docs', settings: '/settings' };
const PAGE_TITLES: Record<Page, string> = { dashboard: 'Dashboard', docs: 'Documentation', settings: 'Settings' };
const NAV_ITEMS: { page: Page; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'settings', label: 'Settings' },
  { page: 'docs', label: 'Docs' },
];
const SPLASH_SEEN_KEY = 'hopr-splash-seen';

function pageFromPath(pathname: string): Page {
  const match = (Object.entries(PAGE_PATHS) as [Page, string][]).find(([, path]) => path === pathname);
  // Retired pages (/bridge, /wallets, /rewards…) land on the dashboard.
  return match?.[0] ?? 'dashboard';
}

function prefetch(page: Page) {
  if (page !== 'dashboard') void loaders[page]().catch(() => undefined);
}

/** The intro plays once per browser session, on the dashboard, unless turned off in Settings. */
function shouldPlaySplash(initialPage: Page, intro: string): boolean {
  if (initialPage !== 'dashboard' || intro === 'off') return false;
  try {
    return sessionStorage.getItem(SPLASH_SEEN_KEY) !== '1';
  } catch {
    return true;
  }
}

function IntroSplash({ isExiting, onExitStart, onExitComplete }: { isExiting: boolean; onExitStart: () => void; onExitComplete: () => void }) {
  const { settings } = useBlackHoleSettings();
  return (
    <Suspense fallback={<div className="preloader-overlay" aria-label="Loading" />}>
      <SplashScreen
        style={settings.intro === 'blackhole' ? 'blackhole' : 'hop'}
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
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { delay, duration: 0.55, ease: [0.16, 1, 0.3, 1] },
});

const CHAINS = [
  { name: 'Solana', key: 'sol' },
  { name: 'Base', key: 'base' },
  { name: 'Arbitrum', key: 'arb' },
  { name: 'BNB Chain', key: 'bsc' },
  { name: 'Robinhood', key: 'rhc' },
  { name: 'Arc', key: 'arc' },
  { name: 'NEAR', key: 'near' },
];

const STEPS = [
  { title: 'Scan a token', desc: 'Paste any EVM, Solana or NEAR address — the chain is resolved for you.', icon: Search },
  { title: 'Check the market', desc: 'Live chart, liquidity, FDV, volume and buy pressure. No wallet needed.', icon: BarChart3 },
  { title: 'Open the bot', desc: 'One tap opens the token in Hopr, where your encrypted wallet pays from any chain.', icon: Wallet },
  { title: 'Confirm the quote', desc: 'LI.FI, Ref Finance or NEAR Intents — you see the live quote before anything is signed.', icon: Shield },
];

function Dashboard({ botUrl }: { botUrl: string }) {
  const [selectedToken, setSelectedToken] = useState<DetectedToken | null>(null);
  const [scanRequest, setScanRequest] = useState<ScanRequest | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // The chain is known here (trending / pools / positions), so the scan skips chain detection.
  const scanFromRail = useCallback((address: string, chainId?: number) => {
    setScanRequest({ address, chainId, nonce: Date.now() });
    searchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-6 space-y-6 sm:pt-12">
      {/* Hero: scan on the left, the bot it hands off to on the right */}
      <section className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)] lg:gap-12">
        <motion.div ref={searchRef} {...sectionMotion(0.04)} className="min-w-0 scroll-mt-24">
          <span className="eyebrow">
            <span className="flex h-5 items-center rounded-full bg-mint-400/15 px-2 text-[10px] font-semibold uppercase tracking-wider text-mint-300">Live</span>
            Trading bot on Telegram · 7 chains
          </span>
          <h1 className="hero-title mt-5 text-4xl font-extrabold leading-[1.05] tracking-[-0.035em] sm:text-5xl lg:text-[3.4rem]">
            Scan it. Route it.<br />Trade it.
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-gray-400">
            Check any token on Solana, Base, Arbitrum, BNB, Robinhood, Arc or NEAR — then trade it from the Hopr bot, paying from whichever chain you hold.
          </p>
          <div className="mt-7">
            <SearchBar onTokenDetected={setSelectedToken} scanRequest={scanRequest} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-500">
            {['Routes via LI.FI · Ref · NEAR Intents', 'Quote first — you confirm', 'Keys AES-256 encrypted'].map((label) => (
              <span key={label} className="flex items-center gap-1.5"><span className="h-1 w-1 rounded-full bg-brand-400" />{label}</span>
            ))}
          </div>
        </motion.div>

        <motion.div {...sectionMotion(0.14)} className="hidden lg:block">
          <BotPreview botUrl={botUrl} />
        </motion.div>
      </section>

      {/* Live trending tokens across supported chains */}
      <motion.div {...sectionMotion(0.2)}>
        <TrendingRail onSelect={scanFromRail} />
      </motion.div>

      {/* Market view + hand-off to the bot */}
      <motion.section {...sectionMotion(0.26)} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 min-h-[500px]">
          <Suspense fallback={<div className="skeleton h-full min-h-[500px] rounded-2xl border border-gray-800/50" aria-label="Loading chart" />}>
            <ChartPanel token={selectedToken} />
          </Suspense>
        </div>
        <div className="space-y-4">
          <TelegramTradeCard token={selectedToken} />
        </div>
      </motion.section>

      <LaunchpadPools onSelect={scanFromRail} />

      {/* How it works */}
      <motion.section {...sectionMotion(0.3)} className="panel p-6 sm:p-8" aria-labelledby="how-it-works">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">How it works</p>
            <h2 id="how-it-works" className="mt-2 text-xl font-bold tracking-tight text-white sm:text-2xl">From address to filled order in four taps</h2>
          </div>
          {botUrl && (
            <a href={botUrl} target="_blank" rel="noreferrer" className="pressable group inline-flex items-center gap-1.5 text-sm font-medium text-brand-300 hover:text-brand-200">
              Start in Telegram <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
          )}
        </div>
        <ol className="relative mt-7 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
          {/* Connector line behind the step badges (desktop) */}
          <span aria-hidden className="absolute left-5 right-5 top-5 hidden h-px bg-gradient-to-r from-brand-500/60 via-brand-400/25 to-mint-400/50 lg:block" />
          {STEPS.map((item, index) => {
            const Icon = item.icon;
            return (
              <li key={item.title} className="relative">
                <span className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-brand-400/30 bg-gray-900 ring-4 ring-gray-900">
                  <Icon className="h-[18px] w-[18px] text-brand-300" />
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 font-mono text-[9px] font-bold text-white">{index + 1}</span>
                </span>
                <h3 className="mt-4 text-sm font-semibold text-white">{item.title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-gray-400">{item.desc}</p>
              </li>
            );
          })}
        </ol>
      </motion.section>

      {/* Supported chains */}
      <motion.section {...sectionMotion(0.34)} className="flex flex-col gap-4 rounded-2xl border border-gray-800/50 bg-gray-900/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Supported chains">
        <div className="flex shrink-0 items-center gap-2.5 text-sm text-gray-400">
          <span className="live-dot" />
          <span><span className="font-semibold text-white">7 chains live</span> · one wallet</span>
        </div>
        <ul className="flex flex-wrap gap-2">
          {CHAINS.map((chain) => (
            <li key={chain.key} className="card-lift flex items-center gap-2 rounded-full border border-gray-800/70 bg-gray-900/60 py-1 pl-1 pr-3 text-xs font-medium text-gray-300 hover:border-brand-400/40">
              <ChainLogo chainKey={chain.key} size={20} />
              {chain.name}
            </li>
          ))}
        </ul>
      </motion.section>
    </main>
  );
}

function AppContent() {
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    return pageFromPath(window.location.pathname);
  });
  const { settings: introSettings } = useBlackHoleSettings();
  const [preloaderPhase, setPreloaderPhase] = useState<'loading' | 'exiting' | 'ready'>(() => shouldPlaySplash(currentPage, introSettings.intro) ? 'loading' : 'ready');
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
    const warm = () => NAV_ITEMS.forEach(({ page }) => prefetch(page));
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

  const botUrl = useTelegramBotUrl();

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
      <IntroSplash
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
      case 'settings': return <SettingsPage onBack={goHome} onPreviewBlackHole={previewBlackHole} />;
      default: return <Dashboard botUrl={botUrl} />;
    }
  };

  const dashboardClassName = `app-page${preloaderPhase !== 'loading' ? ' app-page--ready' : ''}`;

  return (
    <>
      {preloader}

      <div className={`${dashboardClassName} relative min-h-screen text-white`}>
        <div className="app-backdrop" aria-hidden />

        {/* Header */}
        <header className={`glass-header sticky top-0 z-40 border-b safe-area-top transition-[border-color,box-shadow] duration-300 ${scrolled ? 'border-gray-800/70 shadow-[0_8px_30px_-18px_rgba(0,0,0,0.45)]' : 'border-transparent'}`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-16 gap-3">
              {/* Logo */}
              <button onClick={goHome} className="pressable flex items-center gap-2.5 rounded-xl pr-2" aria-label="Hopr dashboard">
                <BrandLogo data-brand-logo className="h-9 w-9 rounded-[22%] shadow-[0_6px_20px_-6px_var(--brand-glow)]" />
                <div className="text-left">
                  <span className="block text-[19px] font-extrabold leading-none tracking-[-0.04em] text-white">hopr</span>
                  <span className="mt-0.5 hidden whitespace-nowrap text-[10px] font-medium tracking-wide text-gray-500 min-[360px]:block">Hop across chains</span>
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
                          className="absolute inset-0 -z-10 rounded-lg border border-brand-400/25 bg-brand-500/15"
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
                {botUrl && (
                  <a href={botUrl} target="_blank" rel="noreferrer" className="btn-primary pressable hidden sm:flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold">
                    <Send className="w-4 h-4" /> Open the bot
                  </a>
                )}
                <div className="hidden xl:flex items-center gap-2 rounded-full border border-mint-400/20 bg-mint-400/10 px-3 py-1.5">
                  <span className="live-dot" />
                  <span className="text-xs font-medium text-mint-300">Online</span>
                </div>
                <button
                  onClick={() => navigate('settings')}
                  onMouseEnter={() => prefetch('settings')}
                  className="settings-trigger pressable hidden sm:flex p-2 rounded-xl hover:bg-gray-800/70"
                  aria-label="Open settings"
                >
                  <Settings className="w-5 h-5 text-gray-400 transition-transform duration-300" />
                </button>
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
        <footer className="relative z-10 mt-14 border-t border-gray-800/50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 safe-area-bottom">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <img src="/brand/logo-full-light.svg" alt="hopr" className="hidden h-7 w-auto dark:block" />
                <img src="/brand/logo-full.svg" alt="hopr" className="h-7 w-auto dark:hidden" />
                <p className="mt-2 text-xs text-gray-500">Cross-chain trading on Telegram · routed by LI.FI, Ref Finance &amp; NEAR Intents</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => navigate('docs')} className="pressable rounded-lg px-3 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-800/60 hover:text-white">Docs</button>
                <a href="https://github.com/meisems/hopr" target="_blank" rel="noreferrer" className="pressable flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-800/60 hover:text-white">
                  <Github className="h-3.5 w-3.5" /> GitHub
                </a>
                {botUrl && (
                  <a href={botUrl} target="_blank" rel="noreferrer" className="pressable flex items-center gap-1.5 rounded-lg border border-brand-400/25 bg-brand-500/10 px-3 py-1.5 text-xs font-semibold text-brand-200 hover:bg-brand-500/20">
                    <Send className="h-3.5 w-3.5" /> Telegram bot
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
        <BlackHoleSettingsProvider>
          <AppContent />
        </BlackHoleSettingsProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
