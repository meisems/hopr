import { useCallback, useEffect, useMemo, useState } from 'react';
import { useActivity } from '../services/activity';
import { useWallet } from '../context/WalletContext';
import { getNetwork } from '../services/chains';
import { detectChain, type DetectedToken } from '../services/chainDetector';
import { getAssetBalance } from '../services/router';

export interface Position {
  key: string;
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  holdings: bigint | null;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  investedUsd: number;
  realizedUsd: number;
  pnlUsd: number | null;
  pnlPercent: number | null;
  change24h: number | null;
  token: DetectedToken | null;
  lastTradeAt: number;
}

/**
 * Open positions built from the user's own buys on this dashboard, sized by
 * what the connected wallet actually holds right now and valued at live
 * market prices. PnL = current value + sale proceeds − amount invested.
 */
export function usePositions() {
  const activity = useActivity();
  const { addressFor } = useWallet();
  const [live, setLive] = useState<Record<string, { holdings: bigint | null; token: DetectedToken | null }>>({});
  const [loading, setLoading] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, { chainId: number; address: string; symbol: string; decimals: number; investedUsd: number; realizedUsd: number; lastTradeAt: number }>();
    for (const entry of activity) {
      if (entry.kind !== 'swap' || entry.status === 'failed' || entry.status === 'refunded') continue;
      const token = entry.side === 'sell' ? entry.from : entry.to;
      const key = `${token.chainId}:${token.address.toLowerCase()}`;
      const group = map.get(key) ?? { chainId: token.chainId, address: token.address, symbol: token.symbol, decimals: token.decimals, investedUsd: 0, realizedUsd: 0, lastTradeAt: 0 };
      if (entry.side === 'sell') group.realizedUsd += entry.amountOutUsd ?? 0;
      else group.investedUsd += entry.amountInUsd ?? 0;
      group.lastTradeAt = Math.max(group.lastTradeAt, entry.createdAt);
      map.set(key, group);
    }
    return [...map.entries()];
  }, [activity]);

  const refresh = useCallback(async () => {
    if (!groups.length) return;
    setLoading(true);
    const results = await Promise.all(groups.map(async ([key, group]) => {
      const network = getNetwork(group.chainId);
      const owner = network ? addressFor(network.vm) : null;
      const [holdings, token] = await Promise.all([
        owner ? getAssetBalance({ chainId: group.chainId, address: group.address, symbol: group.symbol, decimals: group.decimals }, owner).catch(() => null) : Promise.resolve(null),
        detectChain(group.address).catch(() => null),
      ]);
      return [key, { holdings, token }] as const;
    }));
    setLive(Object.fromEntries(results));
    setLoading(false);
  }, [groups, addressFor]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const positions: Position[] = groups.map(([key, group]) => {
    const state = live[key];
    const holdings = state?.holdings ?? null;
    const amount = holdings === null ? null : Number(holdings) / 10 ** group.decimals;
    const priceUsd = state?.token?.priceUsd ?? null;
    const valueUsd = amount !== null && priceUsd !== null ? amount * priceUsd : null;
    const pnlUsd = valueUsd !== null && group.investedUsd > 0 ? valueUsd + group.realizedUsd - group.investedUsd : null;
    return {
      key,
      ...group,
      holdings,
      amount,
      priceUsd,
      valueUsd,
      pnlUsd,
      pnlPercent: pnlUsd !== null && group.investedUsd > 0 ? (pnlUsd / group.investedUsd) * 100 : null,
      change24h: state?.token?.change24h ?? null,
      token: state?.token ?? null,
    };
  }).filter((position) => position.holdings === null || position.holdings > 0n)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || b.lastTradeAt - a.lastTradeAt);

  const totals = positions.reduce((sum, position) => ({
    value: sum.value + (position.valueUsd ?? 0),
    pnl: sum.pnl + (position.pnlUsd ?? 0),
  }), { value: 0, pnl: 0 });

  return { positions, totals, loading, refresh };
}
