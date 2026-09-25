import { DetectedToken } from '../services/chainDetector';

export interface WalletBalance {
  chainId: number;
  chainName: string;
  chainColor: string;
  nativeSymbol: string;
  balance: number;
  usdValue: number;
}

export interface ActivePosition {
  id: string;
  token: DetectedToken;
  amount: number;
  avgBuyPrice: number;
  currentPrice: number;
  fundingChain: string;
  fundingSymbol: string;
  tradeId: string;
  timestamp: number;
  pnlPercent: number;
  pnlUsd: number;
}

export interface TradeHistory {
  id: string;
  type: 'BUY' | 'SELL';
  token: string;
  symbol: string;
  amount: number;
  price: number;
  chain: string;
  timestamp: number;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  txHash: string;
}

export const mockWalletBalances: WalletBalance[] = [
  { chainId: 1151111081099710, chainName: 'Solana', chainColor: '#9945FF', nativeSymbol: 'SOL', balance: 45.82, usdValue: 8175.43 },
  { chainId: 42161, chainName: 'Arbitrum', chainColor: '#28A0F0', nativeSymbol: 'ETH', balance: 1.234, usdValue: 4123.56 },
  { chainId: 8453, chainName: 'Base', chainColor: '#0052FF', nativeSymbol: 'ETH', balance: 0.892, usdValue: 2978.12 },
  { chainId: 56, chainName: 'BNB Chain', chainColor: '#F0B90B', nativeSymbol: 'BNB', balance: 3.45, usdValue: 2070.00 },
  { chainId: 4663, chainName: 'Robinhood', chainColor: '#00C853', nativeSymbol: 'ETH', balance: 0.567, usdValue: 1892.34 },
  { chainId: 5042, chainName: 'Arc Chain', chainColor: '#FF6D00', nativeSymbol: 'USDC', balance: 5234.56, usdValue: 5234.56 },
];

export const mockPositions: ActivePosition[] = [
  {
    id: 'pos-1',
    token: {
      address: '0x946102eA7Df8c2652a1B3a96e23B8b0a703410a5',
      name: 'Moon Pepe',
      symbol: 'MPEPE',
      decimals: 18,
      chainId: 8453,
      chainType: 'EVM',
      chainName: 'Base',
      chainColor: '#0052FF',
      priceUsd: 0.0000123,
      liquidity: 890000,
      fdv: 1230000,
      change24h: 42.5,
    },
    amount: 50000000,
    avgBuyPrice: 0.0000089,
    currentPrice: 0.0000123,
    fundingChain: 'Solana',
    fundingSymbol: 'SOL',
    tradeId: 'trade-001',
    timestamp: Date.now() - 3600000 * 2,
    pnlPercent: 38.2,
    pnlUsd: 170.00,
  },
  {
    id: 'pos-2',
    token: {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      name: 'Robinhood Token',
      symbol: 'RHT',
      decimals: 18,
      chainId: 4663,
      chainType: 'EVM',
      chainName: 'Robinhood Chain',
      chainColor: '#00C853',
      priceUsd: 0.00234,
      liquidity: 1250000,
      fdv: 2340000,
      change24h: 15.7,
    },
    amount: 250000,
    avgBuyPrice: 0.00198,
    currentPrice: 0.00234,
    fundingChain: 'Arbitrum',
    fundingSymbol: 'ETH',
    tradeId: 'trade-002',
    timestamp: Date.now() - 3600000 * 5,
    pnlPercent: 18.18,
    pnlUsd: 90.00,
  },
  {
    id: 'pos-3',
    token: {
      address: '0xabcdef1234567890abcdef1234567890abcdef12',
      name: 'Arc Protocol',
      symbol: 'ARC',
      decimals: 18,
      chainId: 5042,
      chainType: 'EVM',
      chainName: 'Arc Chain',
      chainColor: '#FF6D00',
      priceUsd: 0.087,
      liquidity: 3400000,
      fdv: 8700000,
      change24h: -2.4,
    },
    amount: 5000,
    avgBuyPrice: 0.095,
    currentPrice: 0.087,
    fundingChain: 'BNB Chain',
    fundingSymbol: 'BNB',
    tradeId: 'trade-003',
    timestamp: Date.now() - 3600000 * 12,
    pnlPercent: -8.42,
    pnlUsd: -40.00,
  },
  {
    id: 'pos-4',
    token: {
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      name: 'Bonk',
      symbol: 'BONK',
      decimals: 5,
      chainId: 1151111081099710,
      chainType: 'SVM',
      chainName: 'Solana',
      chainColor: '#9945FF',
      priceUsd: 0.0000234,
      liquidity: 12000000,
      fdv: 1800000000,
      change24h: 8.3,
    },
    amount: 150000000,
    avgBuyPrice: 0.0000198,
    currentPrice: 0.0000234,
    fundingChain: 'Base',
    fundingSymbol: 'ETH',
    tradeId: 'trade-004',
    timestamp: Date.now() - 3600000 * 1,
    pnlPercent: 18.18,
    pnlUsd: 54.00,
  },
];

export const mockTradeHistory: TradeHistory[] = [
  { id: 'th-1', type: 'BUY', token: '0x946102eA7Df8c2652a1B3a96e23B8b0a703410a5', symbol: 'MPEPE', amount: 0.5, price: 0.0000089, chain: 'Base', timestamp: Date.now() - 3600000 * 2, status: 'COMPLETED', txHash: '0xabc...def' },
  { id: 'th-2', type: 'BUY', token: '0x1234567890abcdef1234567890abcdef12345678', symbol: 'RHT', amount: 0.3, price: 0.00198, chain: 'Robinhood', timestamp: Date.now() - 3600000 * 5, status: 'COMPLETED', txHash: '0x123...456' },
  { id: 'th-3', type: 'SELL', token: '0xabcdef1234567890abcdef1234567890abcdef12', symbol: 'ARC', amount: 2500, price: 0.091, chain: 'Arc', timestamp: Date.now() - 3600000 * 8, status: 'COMPLETED', txHash: '0x789...012' },
  { id: 'th-4', type: 'BUY', token: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', amount: 1.2, price: 0.0000198, chain: 'Solana', timestamp: Date.now() - 3600000 * 1, status: 'PENDING', txHash: '0xdef...789' },
];

export function generateChartData(days: number = 30) {
  const data = [];
  const now = Date.now();
  let price = 0.0000089;
  
  for (let i = days; i >= 0; i--) {
    const timestamp = now - i * 86400000;
    price = price * (1 + (Math.random() - 0.45) * 0.08);
    data.push({
      timestamp,
      price: price,
      volume: Math.random() * 500000 + 100000,
      high: price * (1 + Math.random() * 0.05),
      low: price * (1 - Math.random() * 0.05),
    });
  }
  return data;
}
