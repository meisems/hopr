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

export const mockWalletBalances: WalletBalance[] = [];
export const mockPositions: ActivePosition[] = [];
export const mockTradeHistory: TradeHistory[] = [];

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
