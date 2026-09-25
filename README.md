# Hopr – Hop Across Chains

A high-speed, cross-chain trading system with a **Telegram Bot** and **Web Dashboard** that enables one-tap buys/sells across 6 blockchains with automatic chain detection.

## 🌐 Supported Chains

| Chain | Type | Chain ID | Native Token |
|-------|------|----------|--------------|
| Solana | SVM | 1151111081099710 | SOL |
| Arbitrum One | EVM | 42161 | ETH |
| Base | EVM | 8453 | ETH |
| BNB Smart Chain | EVM | 56 | BNB |
| Robinhood Chain | EVM | 4663 | ETH |
| Arc Chain | EVM | 5042 | USDC |

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│                  Frontend (Vite + React)         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Dashboard │  │ Trade UI │  │ Telegram Bot │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │              │               │           │
│       └──────────────┼───────────────┘           │
│                      │                           │
├──────────────────────┼───────────────────────────┤
│           Cloudflare Workers (API)               │
│  ┌───────────────────┼───────────────────────┐  │
│  │  /api/detect      │ Chain Detection       │  │
│  │  /api/wallet      │ Balance Queries       │  │
│  │  /api/trade/buy   │ LI.FI Integration     │  │
│  │  /api/trade/sell  │ Round-trip Routing    │  │
│  └───────────────────┼───────────────────────┘  │
│                      │                           │
├──────────────────────┼───────────────────────────┤
│  ┌──────────┐  ┌────┴─────┐  ┌──────────────┐  │
│  │ D1 (SQL) │  │ KV Cache │  │ LI.FI API    │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

## 🚀 Deployment (Cloudflare Pages + Workers)

### Prerequisites
- Node.js 18+
- Cloudflare account with Pages & Workers enabled
- Wrangler CLI: `npm install -g wrangler`

### Frontend (Cloudflare Pages)
```bash
# Install dependencies
npm install

# Build
npm run build

# Deploy to Pages
npx wrangler pages deploy dist --project-name=hopr
```

### Backend (Cloudflare Workers)
```bash
# Deploy worker
npx wrangler deploy

# Create D1 database
npx wrangler d1 create hopr-db

# Create KV namespace
npx wrangler kv:namespace create CACHE
```

### Environment Variables
Set these in Cloudflare Dashboard → Workers → Settings → Variables:
- `ENCRYPTION_KEY` – AES-256-GCM key for wallet encryption
- `LIFI_API_KEY` – LI.FI API key for cross-chain routing
- `ENVIRONMENT` – `production` or `staging`

## 🎯 Features

### Auto Chain Detection
- Paste any contract address → system detects chain automatically
- Base58 → Solana SPL Token detection
- 0x... → Multi-chain EVM probing (DexScreener + RPC fallback)

### One-Tap Trading
- Buy tokens on any chain using native tokens from your funding chain
- LI.FI handles cross-chain bridging + swap in single transaction
- Sell returns proceeds to original funding chain automatically

### Dual Wallet Architecture
- EVM keypair shared across Base, Arbitrum, BSC, Robinhood, Arc
- Solana keypair for SVM interactions
- AES-256-GCM encrypted storage, decrypted only during signing

### Telegram Bot
- `/wallet` – View balances across all 6 chains
- `/settings` – Configure funding chain, quick-buy presets
- Paste address → instant token info + buy/sell buttons
- Real-time trade progress updates in chat

## 📁 Project Structure

```
├── src/
│   ├── components/
│   │   ├── SplashScreen.tsx    # Black hole loading animation
│   │   ├── SearchBar.tsx       # Omni-search with auto-detection
│   │   ├── ChartPanel.tsx      # Price chart + volume
│   │   ├── TradeCard.tsx       # Buy/sell interface
│   │   ├── PositionsTable.tsx  # Active positions + PnL
│   │   ├── WalletPanel.tsx     # Multi-chain balances
│   │   ├── TelegramPreview.tsx # Bot UI preview
│   │   └── SettingsModal.tsx   # User configuration
│   ├── services/
│   │   └── chainDetector.ts    # Auto chain resolution engine
│   ├── data/
│   │   └── mockData.ts         # Demo data
│   └── App.tsx                 # Main application
├── workers/
│   └── index.ts                # Cloudflare Worker API
├── public/
│   ├── _headers                # Security headers
│   └── _redirects              # SPA routing
├── wrangler.toml               # Cloudflare config
└── index.html
```

## 🔒 Security

- Private keys encrypted with AES-256-GCM
- Encryption keys stored in Cloudflare Workers secrets
- Keys decrypted in-memory only during transaction signing
- No keys ever logged or transmitted unencrypted
- CORS headers restrict API access

## 📊 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/detect` | Auto-detect token chain |
| GET | `/api/wallet/:address/balances` | Multi-chain balances |
| POST | `/api/trade/buy` | Execute cross-chain buy |
| POST | `/api/trade/sell` | Execute cross-chain sell |
| GET | `/api/trade/:id/status` | Poll trade progress |
| GET | `/health` | Health check |
