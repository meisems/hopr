export interface DocFile {
  id: string;
  name: string;
  path: string;
  description: string;
  category: 'overview' | 'architecture' | 'api' | 'security' | 'deployment' | 'components';
  language: string;
  public: boolean;
}

// Only files safe to show publicly - no secrets, no private keys, no internal config
export const PUBLIC_DOC_FILES: DocFile[] = [
  {
    id: 'readme',
    name: 'README.md',
    path: 'README.md',
    description: 'Project overview, architecture diagram, and deployment guide',
    category: 'overview',
    language: 'markdown',
    public: true,
  },
  {
    id: 'chain-detector',
    name: 'chainDetector.ts',
    path: 'src/services/chainDetector.ts',
    description: 'Auto chain resolution engine – detects which blockchain a token belongs to',
    category: 'architecture',
    language: 'typescript',
    public: true,
  },
  {
    id: 'chain-logo',
    name: 'ChainLogo.tsx',
    path: 'src/components/ChainLogo.tsx',
    description: 'Real SVG logos for each supported blockchain',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'splash-screen',
    name: 'SplashScreen.tsx',
    path: 'src/components/SplashScreen.tsx',
    description: 'Black hole loading animation – logo consumed by event horizon',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'search-bar',
    name: 'SearchBar.tsx',
    path: 'src/components/SearchBar.tsx',
    description: 'Omni-search with auto chain detection for any contract address',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'trade-card',
    name: 'TradeCard.tsx',
    path: 'src/components/TradeCard.tsx',
    description: 'One-tap buy/sell interface with LI.FI cross-chain routing',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'chart-panel',
    name: 'ChartPanel.tsx',
    path: 'src/components/ChartPanel.tsx',
    description: 'Live price chart with volume, liquidity, and market cap stats',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'positions-table',
    name: 'PositionsTable.tsx',
    path: 'src/components/PositionsTable.tsx',
    description: 'Active positions with PnL tracking and instant sell-and-return',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'wallet-panel',
    name: 'WalletPanel.tsx',
    path: 'src/components/WalletPanel.tsx',
    description: 'Multi-chain portfolio view across all 6 supported networks',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'telegram-preview',
    name: 'TelegramPreview.tsx',
    path: 'src/components/TelegramPreview.tsx',
    description: 'Interactive preview of the Telegram bot trading interface',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'settings-modal',
    name: 'SettingsModal.tsx',
    path: 'src/components/SettingsModal.tsx',
    description: 'User configuration for funding chain, slippage, and quick-buy presets',
    category: 'components',
    language: 'typescript',
    public: true,
  },
  {
    id: 'app',
    name: 'App.tsx',
    path: 'src/App.tsx',
    description: 'Main dashboard layout – search, chart, trade, positions, chains',
    category: 'overview',
    language: 'typescript',
    public: true,
  },
];

// Files that exist but are NOT public (shown as redacted entries for transparency)
export const PRIVATE_DOC_FILES: DocFile[] = [
  {
    id: 'worker',
    name: 'workers/index.ts',
    path: 'workers/index.ts',
    description: 'Cloudflare Worker API – contains API keys and internal routing logic',
    category: 'api',
    language: 'typescript',
    public: false,
  },
  {
    id: 'wrangler',
    name: 'wrangler.toml',
    path: 'wrangler.toml',
    description: 'Cloudflare deployment config – contains environment variable references',
    category: 'deployment',
    language: 'toml',
    public: false,
  },
];
