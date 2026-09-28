import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../services/api';
import { formatNearAmount, formatUnits, getNearBalance } from '../services/nearService';

export interface NearBalanceView {
  exists: boolean;
  /** Spendable NEAR, formatted (24-decimal yocto → human). */
  near: string;
  /** `balance` is in the token's smallest unit; `formatted` is for display only. */
  tokens: Array<{ id: string; symbol: string; decimals: number; balance: string; formatted: string }>;
}

/**
 * NEAR balances for an account. Prefers the worker API (which uses the
 * operator's keyed NEAR_RPC_URL) and falls back to public RPC from the
 * browser, so balances still load in local development without the worker.
 */
export function useNearBalance(accountId: string | null) {
  const [balance, setBalance] = useState<NearBalanceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!accountId) {
      setBalance(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch(apiUrl(`/api/wallet/${encodeURIComponent(accountId)}/balances`), { signal });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.includes('json')) throw new Error('API unavailable');
      const data = await response.json() as { exists?: boolean; balances?: Array<{ balanceYocto?: string }>; tokens?: NearBalanceView['tokens'] };
      if (!data.balances?.[0]?.balanceYocto) throw new Error('API unavailable');
      setBalance({ exists: data.exists ?? true, near: formatNearAmount(data.balances[0].balanceYocto), tokens: data.tokens ?? [] });
    } catch (apiError) {
      if (signal?.aborted) return;
      try {
        const direct = await getNearBalance(accountId);
        setBalance({
          exists: direct.exists,
          near: formatNearAmount(direct.availableYocto),
          tokens: direct.tokens.map((token) => ({ ...token, formatted: formatUnits(token.balance, token.decimals) })),
        });
      } catch {
        setError(apiError instanceof Error && apiError.message !== 'API unavailable' ? apiError.message : 'NEAR balance unavailable');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return { balance, loading, error, refresh: () => load() };
}
