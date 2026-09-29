import { useEffect, useState } from 'react';
import { useWallet } from '../context/WalletContext';
import { NETWORKS, type Network } from '../services/chains';
import { getTrackedAssetBalance, loadIntentsTokens } from '../services/router';
import { formatUnits } from '../services/nearService';

export interface PortfolioRow {
  network: Network;
  address: string;
  balance: bigint | null;
  stale: boolean;
  observedAt: number | null;
  formatted: string;
  usd: number | null;
}

/** Live USD prices of native assets (ETH, BNB, SOL, NEAR, USDC) from the NEAR Intents token list. */
async function nativePrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = { USDC: 1 };
  try {
    for (const token of await loadIntentsTokens()) {
      const symbol = token.symbol.toUpperCase() === 'WNEAR' ? 'NEAR' : token.symbol.toUpperCase();
      if (token.price && !prices[symbol]) prices[symbol] = token.price;
    }
  } catch {
    // Balances still render without USD values.
  }
  return prices;
}

/**
 * Native balances of every connected wallet across every network it can use:
 * the EVM address on all EVM chains, the Solana address on Solana, the NEAR
 * account on NEAR. Real RPC reads — no placeholder rows.
 */
export function usePortfolio() {
  const { evm, svm, near, telegramWallet } = useWallet();
  // Browser wallets first; in the Telegram Mini App the Hopr (bot) wallet fills in.
  const evmAddress = evm?.address ?? telegramWallet?.evmAddress;
  const svmAddress = svm?.address ?? telegramWallet?.solanaAddress;
  const nearAddress = near?.address ?? telegramWallet?.nearAddress ?? undefined;
  const [refreshTick, setRefreshTick] = useState(0);
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let failures = 0;
    const targets = NETWORKS.flatMap((network) => {
      const address = network.vm === 'evm' ? evmAddress : network.vm === 'svm' ? svmAddress : nearAddress;
      return address ? [{ network, address }] : [];
    });
    setRows([]); setUpdatedAt(null);
    if (!targets.length) { setLoading(false); return; }
    const load = async () => {
    setLoading(true);
    const [prices, balances] = await Promise.all([
      nativePrices(),
      Promise.all(targets.map(async ({ network, address }) => {
        const reading = await getTrackedAssetBalance({ chainId: network.id, address: 'native', symbol: network.nativeSymbol, decimals: network.nativeDecimals }, address);
        return { network, address, balance: reading.value, stale: reading.stale, observedAt: reading.at };
      })),
    ]);
    if (!active) return;
    setRows(balances.map(({ network, address, balance, stale, observedAt }) => {
      const amount = balance === null ? null : Number(balance) / 10 ** network.nativeDecimals;
      const price = prices[network.nativeSymbol];
      return { network, address, balance, stale, observedAt, formatted: balance === null ? 'Syncing…' : formatUnits(balance, network.nativeDecimals, 5), usd: price !== undefined && amount !== null ? amount * price : null };
    }));
    setUpdatedAt(Date.now());
    setLoading(false);
    const needsRetry = balances.some((row) => row.balance === null || row.stale);
    failures = needsRetry ? failures + 1 : 0;
    timer = window.setTimeout(() => void load(), needsRetry && failures <= 3 ? 8000 : 60_000);
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [evmAddress, svmAddress, nearAddress, refreshTick]);

  // Hide the previous account's results immediately, even before effect cleanup runs.
  const currentRows = rows.filter((row) => row.address === (row.network.vm === 'evm' ? evmAddress : row.network.vm === 'svm' ? svmAddress : nearAddress));
  const totalUsd = currentRows.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  const incomplete = currentRows.some((row) => row.usd === null || row.stale);
  return { rows: currentRows, totalUsd, incomplete, loading, updatedAt, refresh: () => setRefreshTick((n) => n + 1) };
}
