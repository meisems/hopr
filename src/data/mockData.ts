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
