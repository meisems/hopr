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

export interface ChartDataOptions {
  points: number;
  intervalMs: number;
  currentPrice: number;
  tokenKey: string;
}

/**
 * Creates a stable price series for one selected token and one interval.
 * The old implementation generated a new 30-day random series for every
 * token, which made short ranges meaningless and could visually carry one
 * token's history into another. Fresh tokens without a market price return no
 * history rather than displaying invented data.
 */
export function generateChartData({ points, intervalMs, currentPrice, tokenKey }: ChartDataOptions) {
  if (currentPrice <= 0 || points < 1) return [];

  let seed = [...tokenKey].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 2166136261);
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const prices = [currentPrice];
  for (let index = 1; index < points; index += 1) {
    const volatility = 0.012 + nextRandom() * 0.018;
    const movement = (nextRandom() - 0.5) * volatility;
    prices.unshift(prices[0] / (1 + movement));
  }

  const now = Date.now();
  return prices.map((price, index) => ({
    timestamp: now - (points - 1 - index) * intervalMs,
    price,
    volume: (0.35 + nextRandom() * 0.65) * 500000,
    high: price * (1 + nextRandom() * 0.02),
    low: price * (1 - nextRandom() * 0.02),
  }));
}
