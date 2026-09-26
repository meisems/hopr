import { useState } from 'react';
import { ArrowLeft, BookOpen, Code2, Shield, Server, Layers, FileCode, ExternalLink, Lock, CheckCircle2, Zap, Globe, Link2, DollarSign, CreditCard, Target, Rocket, TrendingDown, Settings, BarChart3, Search, RefreshCw, MapPin, Menu, X } from 'lucide-react';
import { PUBLIC_DOC_FILES, PRIVATE_DOC_FILES } from '../data/docFiles';
import ChainLogo from './ChainLogo';
import DeploymentGuide from './DeploymentGuide';
import ThemeToggle from './ThemeToggle';

interface DocsPageProps {
  onBack: () => void;
}

type Section = 'overview' | 'architecture' | 'chains' | 'api' | 'security' | 'deployment' | 'files';

export default function DocsPage({ onBack }: DocsPageProps) {
  const [activeSection, setActiveSection] = useState<Section>('overview');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const sections = [
    { id: 'overview' as Section, label: 'Overview', icon: BookOpen },
    { id: 'architecture' as Section, label: 'Architecture', icon: Layers },
    { id: 'chains' as Section, label: 'Supported Chains', icon: Globe },
    { id: 'api' as Section, label: 'API Reference', icon: Server },
    { id: 'security' as Section, label: 'Security', icon: Shield },
    { id: 'deployment' as Section, label: 'Deployment', icon: Code2 },
    { id: 'files' as Section, label: 'File Browser', icon: FileCode },
  ];

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur-xl safe-area-top">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
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
                <BookOpen className="w-4 h-4 sm:w-5 sm:h-5 text-purple-400" />
                <h1 className="text-base sm:text-lg font-semibold text-white">Documentation</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <span className="text-xs text-gray-500 hidden sm:inline">v1.0.0</span>
              <div className="hidden sm:flex items-center gap-1 px-2 py-1 bg-green-500/10 border border-green-500/20 rounded-full">
                <div className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                <span className="text-xs text-green-400">Public</span>
              </div>
              {/* Mobile menu button */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="lg:hidden p-2 hover:bg-gray-800 rounded-lg transition-colors"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile navigation */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-gray-800/50 bg-gray-900/95 backdrop-blur-xl">
            <nav className="px-4 py-3 space-y-1">
              {sections.map((section) => {
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    onClick={() => {
                      setActiveSection(section.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      activeSection === section.id
                        ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {section.label}
                  </button>
                );
              })}
            </nav>
          </div>
        )}
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex gap-8">
          {/* Sidebar - Desktop only */}
          <aside className="hidden lg:block w-64 flex-shrink-0">
            <nav className="sticky top-24 space-y-1">
              {sections.map((section) => {
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      activeSection === section.id
                        ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {section.label}
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0">
            {activeSection === 'overview' && <OverviewSection />}
            {activeSection === 'architecture' && <ArchitectureSection />}
            {activeSection === 'chains' && <ChainsSection />}
            {activeSection === 'api' && <ApiSection />}
            {activeSection === 'security' && <SecuritySection />}
            {activeSection === 'deployment' && <DeploymentGuide />}
            {activeSection === 'files' && (
              <FilesSection
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function OverviewSection() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white mb-4">Welcome to Hopr</h2>
        <p className="text-lg text-gray-400 leading-relaxed">
          Hopr is a cross-chain trading system that enables one-tap buys and sells across 6 blockchains. 
          Paste any token contract address, and the system automatically detects which chain it belongs to, 
          routes the trade through LI.FI, and delivers the tokens to your wallet.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InfoCard
          icon={<Zap className="w-5 h-5" />}
          title="Zero-Config Chain Detection"
          description="Paste any contract address – Solana, Arbitrum, Base, BSC, Robinhood Chain, or Arc Chain. The system auto-detects the chain instantly."
        />
        <InfoCard
          icon={<Rocket className="w-5 h-5" />}
          title="One-Tap Trading"
          description="Buy tokens on any chain using native tokens from your funding chain. LI.FI handles cross-chain bridging and swapping in a single transaction."
        />
        <InfoCard
          icon={<RefreshCw className="w-5 h-5" />}
          title="Round-Trip Routing"
          description="When you sell, proceeds automatically return to the exact chain and token you used to buy. No manual chain switching required."
        />
        <InfoCard
          icon={<Globe className="w-5 h-5" />}
          title="Dual Interface"
          description="Trade via Telegram bot or web dashboard. Both share the same wallet, positions, and settings."
        />
      </div>

      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Quick Start</h3>
        <div className="space-y-3">
          <Step number={1} text="Paste any token contract address in the search bar" />
          <Step number={2} text="System auto-detects the chain and shows token info" />
          <Step number={3} text="Click your desired buy amount – trade executes instantly" />
          <Step number={4} text="Track your position in the Active Positions table" />
          <Step number={5} text="Sell anytime – proceeds return to your funding chain" />
        </div>
      </div>
    </div>
  );
}

function ArchitectureSection() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white mb-4">Architecture</h2>
        <p className="text-gray-400 leading-relaxed">
          Hopr uses a modern stack optimized for speed and security. The frontend is built with React and Vite, 
          deployed on Cloudflare Pages. The backend runs on Cloudflare Workers with D1 database and KV cache.
        </p>
      </div>

      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <h3 className="text-lg font-semibold text-white mb-4">System Overview</h3>
        <pre className="text-xs text-gray-300 overflow-x-auto font-mono leading-relaxed">
{`┌─────────────────────────────────────────────────┐
│           Frontend (React + Vite)               │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Dashboard │  │ Trade UI │  │ Telegram Bot │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       └──────────────┼───────────────┘           │
├──────────────────────┼───────────────────────────┤
│      Cloudflare Workers (API)                    │
│  ┌───────────────────┼───────────────────────┐  │
│  │  /api/detect      │ Chain Detection       │  │
│  │  /api/wallet      │ Balance Queries       │  │
│  │  /api/trade/buy   │ LI.FI Integration     │  │
│  │  /api/trade/sell  │ Round-trip Routing    │  │
│  └───────────────────┼───────────────────────┘  │
├──────────────────────┼───────────────────────────┤
│  ┌──────────┐  ┌────┴─────┐  ┌──────────────┐  │
│  │ D1 (SQL) │  │ KV Cache │  │ LI.FI API    │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘`}
        </pre>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <InfoCard
          icon={<Layers className="w-5 h-5" />}
          title="Frontend"
          description="React + Vite + Tailwind CSS. Deployed on Cloudflare Pages for global edge delivery."
        />
        <InfoCard
          icon={<Server className="w-5 h-5" />}
          title="Backend"
          description="Cloudflare Workers with TypeScript. Handles API routes, chain detection, and trade execution."
        />
        <InfoCard
          icon={<Link2 className="w-5 h-5" />}
          title="Cross-Chain"
          description="LI.FI API handles all cross-chain bridging and swapping. Supports 6 chains with automatic routing."
        />
      </div>

      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Chain Detection Flow</h3>
        <div className="space-y-4">
          <FlowStep
            number={1}
            title="Address Format Check"
            description="Regex validation: Base58 (32-44 chars) → Solana, 0x + 40 chars → EVM"
          />
          <FlowStep
            number={2}
            title="DexScreener Query"
            description="Single API call to https://api.dexscreener.com/latest/dex/tokens/{address} returns chain, price, liquidity, and FDV"
          />
          <FlowStep
            number={3}
            title="Fallback RPC Probing"
            description="If DexScreener returns no pairs (new token), concurrent eth_getCode queries to all EVM chains"
          />
          <FlowStep
            number={4}
            title="Cache Result"
            description="Resolved metadata cached in KV for 5 minutes to reduce API calls"
          />
        </div>
      </div>
    </div>
  );
}

function ChainsSection() {
  const chains = [
    { key: 'sol', name: 'Solana', type: 'SVM', chainId: '1151111081099710', native: 'SOL', color: '#9945FF' },
    { key: 'arb', name: 'Arbitrum One', type: 'EVM', chainId: '42161', native: 'ETH', color: '#28A0F0' },
    { key: 'base', name: 'Base', type: 'EVM', chainId: '8453', native: 'ETH', color: '#0052FF' },
    { key: 'bsc', name: 'BNB Smart Chain', type: 'EVM', chainId: '56', native: 'BNB', color: '#F0B90B' },
    { key: 'rhc', name: 'Robinhood Chain', type: 'EVM', chainId: '4663', native: 'ETH', color: '#00C853' },
    { key: 'arc', name: 'Arc Chain', type: 'EVM', chainId: '5042', native: 'USDC', color: '#FF6D00' },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white mb-4">Supported Chains</h2>
        <p className="text-gray-400 leading-relaxed">
          Hopr supports 6 blockchains with automatic chain detection. You can trade tokens on any of these chains 
          using native tokens from your preferred funding chain.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {chains.map((chain) => (
          <div key={chain.key} className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
            <div className="flex items-start gap-4">
              <ChainLogo chainKey={chain.key} size={48} />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-lg font-semibold text-white">{chain.name}</h3>
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: chain.color + '22', color: chain.color }}>
                    {chain.type}
                  </span>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Chain ID</span>
                    <span className="text-gray-300 font-mono">{chain.chainId}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Native Token</span>
                    <span className="text-gray-300">{chain.native}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500">Status</span>
                    <span className="text-green-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Active
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApiSection() {
  const endpoints = [
    {
      method: 'POST',
      path: '/api/detect',
      description: 'Auto-detect which chain a token address belongs to',
      body: '{ "address": "0x..." }',
      response: '{ "chainId": 42161, "chainName": "Arbitrum", "symbol": "TOKEN", ... }',
    },
    {
      method: 'GET',
      path: '/api/wallet/:address/balances',
      description: 'Get native token balances across all 6 chains',
      body: null,
      response: '{ "address": "0x...", "balances": [{ "chainId": 42161, "balance": "1.5" }, ...] }',
    },
    {
      method: 'POST',
      path: '/api/trade/buy',
      description: 'Execute a cross-chain buy via LI.FI',
      body: '{ "userId": "...", "tokenAddress": "0x...", "amount": "0.5", "fundingChain": "sol", "slippage": 3 }',
      response: '{ "tradeId": "uuid", "status": "PENDING", "message": "Trade initiated..." }',
    },
    {
      method: 'POST',
      path: '/api/trade/sell',
      description: 'Execute a cross-chain sell with auto-return to funding chain',
      body: '{ "userId": "...", "tokenAddress": "0x...", "percentage": 100 }',
      response: '{ "tradeId": "uuid", "status": "PENDING", "message": "Sell initiated..." }',
    },
    {
      method: 'GET',
      path: '/api/trade/:id/status',
      description: 'Poll trade execution status',
      body: null,
      response: '{ "tradeId": "uuid", "status": "COMPLETED", "steps": [...] }',
    },
    {
      method: 'GET',
      path: '/health',
      description: 'Health check endpoint',
      body: null,
      response: '{ "status": "ok", "timestamp": 1234567890 }',
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white mb-4">API Reference</h2>
        <p className="text-gray-400 leading-relaxed">
          Hopr exposes a REST API for chain detection, wallet queries, and trade execution. 
          All endpoints are deployed on Cloudflare Workers at the edge.
        </p>
      </div>

      <div className="space-y-4">
        {endpoints.map((endpoint, idx) => (
          <div key={idx} className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
            <div className="flex items-start gap-4 mb-4">
              <span className={`px-3 py-1 rounded-lg text-xs font-bold ${
                endpoint.method === 'GET' ? 'bg-blue-500/20 text-blue-400' : 'bg-green-500/20 text-green-400'
              }`}>
                {endpoint.method}
              </span>
              <div className="flex-1">
                <code className="text-sm text-white font-mono">{endpoint.path}</code>
                <p className="text-sm text-gray-400 mt-1">{endpoint.description}</p>
              </div>
            </div>

            {endpoint.body && (
              <div className="mb-3">
                <div className="text-xs text-gray-500 mb-1">Request Body</div>
                <pre className="text-xs text-gray-300 bg-gray-800/50 rounded-lg p-3 overflow-x-auto font-mono">
                  {endpoint.body}
                </pre>
              </div>
            )}

            <div>
              <div className="text-xs text-gray-500 mb-1">Response</div>
              <pre className="text-xs text-gray-300 bg-gray-800/50 rounded-lg p-3 overflow-x-auto font-mono">
                {endpoint.response}
              </pre>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SecuritySection() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white mb-4">Security</h2>
        <p className="text-gray-400 leading-relaxed">
          Hopr implements industry-standard security practices to protect user funds and private keys.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InfoCard
          icon={<Shield className="w-5 h-5" />}
          title="AES-256-GCM Encryption"
          description="All private keys are encrypted at rest using AES-256-GCM. Encryption keys are stored in Cloudflare Workers secrets, never in code."
        />
        <InfoCard
          icon={<Lock className="w-5 h-5" />}
          title="In-Memory Decryption"
          description="Private keys are decrypted in memory only for the sub-second duration needed to sign transactions. Never logged or transmitted."
        />
        <InfoCard
          icon={<Server className="w-5 h-5" />}
          title="Edge Deployment"
          description="Deployed on Cloudflare Workers at the edge. No centralized servers to compromise. All data encrypted in transit and at rest."
        />
        <InfoCard
          icon={<CheckCircle2 className="w-5 h-5" />}
          title="Dual Wallet Architecture"
          description="Separate keypairs for EVM and Solana. EVM key shared across 5 chains, Solana key for SVM. Minimized attack surface."
        />
      </div>

      <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-2xl p-6">
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-semibold text-yellow-400 mb-2">Security Best Practices</h3>
            <ul className="space-y-2 text-sm text-yellow-400/80">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Never share your private keys or seed phrases</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Use hardware wallets for large amounts</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Verify contract addresses before trading</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Start with small test amounts on new chains</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}



function FilesSection({ selectedFile, onSelectFile }: { selectedFile: string | null; onSelectFile: (id: string | null) => void }) {
  const publicFiles = PUBLIC_DOC_FILES;
  const privateFiles = PRIVATE_DOC_FILES;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white mb-4">File Browser</h2>
        <p className="text-gray-400 leading-relaxed">
          Browse the public source code files. For transparency, we also show which files are kept private 
          and why.
        </p>
      </div>

      {/* Public files */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle2 className="w-5 h-5 text-green-400" />
          <h3 className="text-lg font-semibold text-white">Public Files ({publicFiles.length})</h3>
        </div>
        <div className="space-y-2">
          {publicFiles.map((file) => (
            <button
              key={file.id}
              onClick={() => onSelectFile(selectedFile === file.id ? null : file.id)}
              className={`w-full text-left bg-gray-900/60 rounded-xl border p-4 transition-all ${
                selectedFile === file.id
                  ? 'border-purple-500/50 bg-purple-500/5'
                  : 'border-gray-800/50 hover:border-gray-700/50'
              }`}
            >
              <div className="flex items-start gap-3">
                <FileCode className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-white">{file.name}</span>
                    <span className="text-xs text-gray-500 font-mono">{file.path}</span>
                  </div>
                  <p className="text-xs text-gray-400">{file.description}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Private files */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Lock className="w-5 h-5 text-red-400" />
          <h3 className="text-lg font-semibold text-white">Private Files ({privateFiles.length})</h3>
        </div>
        <div className="space-y-2">
          {privateFiles.map((file) => (
            <div
              key={file.id}
              className="bg-gray-900/60 rounded-xl border border-gray-800/50 p-4 opacity-60"
            >
              <div className="flex items-start gap-3">
                <Lock className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-gray-400">{file.name}</span>
                    <span className="text-xs px-2 py-0.5 bg-red-500/10 text-red-400 rounded-full">Private</span>
                  </div>
                  <p className="text-xs text-gray-500">{file.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Helper components
function InfoCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
      <div className="flex items-start gap-3">
        <div className="text-purple-400">{icon}</div>
        <div>
          <h3 className="text-sm font-semibold text-white mb-1">{title}</h3>
          <p className="text-xs text-gray-400 leading-relaxed">{description}</p>
        </div>
      </div>
    </div>
  );
}

function Step({ number, text }: { number: number; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-shrink-0 w-6 h-6 bg-purple-500/20 border border-purple-500/30 rounded-full flex items-center justify-center">
        <span className="text-xs font-bold text-purple-400">{number}</span>
      </div>
      <p className="text-sm text-gray-300 pt-0.5">{text}</p>
    </div>
  );
}

function FlowStep({ number, title, description }: { number: number; title: string; description: string }) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-shrink-0 w-8 h-8 bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-purple-500/30 rounded-xl flex items-center justify-center">
        <span className="text-sm font-bold text-purple-400">{number}</span>
      </div>
      <div className="flex-1">
        <h4 className="text-sm font-semibold text-white mb-1">{title}</h4>
        <p className="text-xs text-gray-400 leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

function EnvVar({ name, description }: { name: string; description: string }) {
  return (
    <div className="flex items-center gap-3 p-3 bg-gray-800/40 rounded-xl">
      <code className="text-sm text-purple-400 font-mono">{name}</code>
      <span className="text-xs text-gray-500">–</span>
      <span className="text-xs text-gray-400">{description}</span>
    </div>
  );
}
