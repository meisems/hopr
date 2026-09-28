import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '../context/WalletContext';
import { NETWORKS, type Network } from '../services/chains';
import { getAssetBalance, loadIntentsTokens } from '../services/router';
import { formatUnits } from '../services/nearService';

export interface PortfolioRow {
  network: Network;
  address: string;
  balance: bigint;
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
  const [retryTick, setRetryTick] = useState(0);
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const targets = NETWORKS.flatMap((network) => {
      const address = network.vm === 'evm' ? evmAddress : network.vm === 'svm' ? svmAddress : nearAddress;
      return address ? [{ network, address }] : [];
    });
    if (!targets.length) {
      setRows([]);
      return;
    }
    setLoading(true);
    const [prices, balances] = await Promise.all([
      nativePrices(),
      Promise.all(targets.map(async ({ network, address }) => {
        try {
          return { network, address, balance: await getAssetBalance({ chainId: network.id, address: 'native', symbol: network.nativeSymbol, decimals: network.nativeDecimals }, address) };
        } catch {
          return null;
        }
      })),
    ]);
    setRows(balances.filter((row): row is NonNullable<typeof row> => row !== null).map(({ network, address, balance }) => {
      const amount = Number(balance) / 10 ** network.nativeDecimals;
      const price = prices[network.nativeSymbol];
      return { network, address, balance, formatted: formatUnits(balance, network.nativeDecimals, 5), usd: price !== undefined ? amount * price : null };
    }));
    setUpdatedAt(Date.now());
    setLoading(false);
    // A chain that couldn't be read (and has no last-known value yet) is retried shortly.
    if (balances.some((row) => row === null)) window.setTimeout(() => setRetryTick((tick) => (tick < 5 ? tick + 1 : tick)), 8000);
  }, [evmAddress, svmAddress, nearAddress]);

  useEffect(() => {
    if (retryTick) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTick]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const totalUsd = rows.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  return { rows, totalUsd, loading, updatedAt, refresh: load };
}
