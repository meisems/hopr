// Balance tracking for the Telegram bot.
//
// Reads go through the shared RPC failover pool (src/services/rpcPool.ts).
// Every successful read is stored in KV; if all endpoints for a chain are
// down, the last known balance is shown with its time instead of
// "unavailable". USD values come from NEAR Intents' price list (native
// coins) and DexScreener (tokens).

import { jsonRpc } from '../src/services/rpcPool';
import { getNearBalance, NEAR_CHAIN_ID, viewFunction, getTokenMetadata, type NearRpcOptions } from '../src/services/nearService';

export const SOLANA_CHAIN_ID = 1151111081099710;

export interface BalanceEnv {
  TELEGRAM_STATE?: KVNamespace;
  CACHE?: KVNamespace;
}

export interface TrackedAmount {
  value: bigint;
  /** Set when every RPC failed and this is the last known value. */
  cachedAt?: number;
}

const kv = (env: BalanceEnv) => env.TELEGRAM_STATE ?? env.CACHE;
const CACHE_TTL = 30 * 24 * 60 * 60;

/** Read through `reader`, remembering the result; fall back to the last known value. */
export async function tracked(env: BalanceEnv, key: string, reader: () => Promise<bigint>): Promise<TrackedAmount | null> {
  const store = kv(env);
  try {
    const value = await reader();
    await store?.put(`bal:v1:${key}`, JSON.stringify({ value: value.toString(), at: Date.now() }), { expirationTtl: CACHE_TTL }).catch(() => undefined);
    return { value };
  } catch {
    const raw = await store?.get(`bal:v1:${key}`).catch(() => null);
    if (!raw) return null;
    try {
      const cached = JSON.parse(raw) as { value: string; at: number };
      if (!/^\d+$/.test(cached.value) || !Number.isFinite(cached.at) || Date.now() - cached.at > CACHE_TTL * 1000) return null;
      return { value: BigInt(cached.value), cachedAt: cached.at };
    } catch { return null; }
  }
}

/** Native balance in smallest units (wei / lamports / yoctoNEAR available). */
export async function readNativeBalance(chainId: number, address: string, near?: NearRpcOptions): Promise<bigint> {
  if (chainId === SOLANA_CHAIN_ID) return BigInt((await jsonRpc<{ value: number }>(SOLANA_CHAIN_ID, 'getBalance', [address, { commitment: 'confirmed' }], {
    validate: (result) => Number.isSafeInteger(result?.value) && result.value >= 0,
  })).value);
  if (chainId === NEAR_CHAIN_ID) {
    const balance = await getNearBalance(address, [], near);
    return balance.exists ? BigInt(balance.availableYocto) : 0n;
  }
  return BigInt(await jsonRpc<string>(chainId, 'eth_getBalance', [address, 'latest'], { validate: (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) }));
}

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Token balance and decimals for `owner` on any supported chain. */
export async function readTokenBalance(chainId: number, token: string, owner: string, near?: NearRpcOptions): Promise<{ amount: bigint; decimals: number }> {
  if (chainId === SOLANA_CHAIN_ID) {
    const result = await jsonRpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }> }>(
      SOLANA_CHAIN_ID, 'getTokenAccountsByOwner', [owner, { mint: token }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    );
    let amount = 0n;
    let decimals = 0;
    for (const account of result.value) {
      amount += BigInt(account.account.data.parsed.info.tokenAmount.amount);
      decimals = account.account.data.parsed.info.tokenAmount.decimals;
    }
    return { amount, decimals };
  }
  if (chainId === NEAR_CHAIN_ID) {
    const [amount, metadata] = await Promise.all([
      viewFunction<string>(token, 'ft_balance_of', { account_id: owner }, near),
      getTokenMetadata(token, near),
    ]);
    return { amount: BigInt(amount), decimals: metadata.decimals };
  }
  const [balance, decimals] = await Promise.all([
    jsonRpc<string>(chainId, 'eth_call', [{ to: token, data: `0x70a08231${pad32(owner)}` }, 'latest']),
    jsonRpc<string>(chainId, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']),
  ]);
  return { amount: balance && balance !== '0x' ? BigInt(balance) : 0n, decimals: decimals && decimals !== '0x' ? Number(BigInt(decimals)) : 18 };
}

let priceCache: { at: number; prices: Record<string, number> } | null = null;

/** USD prices of native coins (ETH, BNB, SOL, NEAR, USDC) from NEAR Intents' token list. */
export async function nativePricesUsd(): Promise<Record<string, number>> {
  if (priceCache && Date.now() - priceCache.at < 5 * 60_000) return priceCache.prices;
  const prices: Record<string, number> = { USDC: 1 };
  try {
    const response = await fetch('https://1click.chaindefuser.com/v0/tokens', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Price provider failed');
    for (const token of await response.json() as Array<{ symbol: string; price?: number; contractAddress?: string }>) {
      const symbol = token.symbol.toUpperCase() === 'WNEAR' ? 'NEAR' : token.symbol.toUpperCase();
      if (token.price && !prices[symbol] && (!token.contractAddress || symbol === 'NEAR')) prices[symbol] = token.price;
    }
    priceCache = { at: Date.now(), prices };
  } catch {
    // Balances still render without USD values.
  }
  return priceCache?.prices ?? prices;
}

/** Symbol and USD price for tokens, from DexScreener's most liquid pair. */
export async function tokenMarkets(addresses: string[]): Promise<Record<string, { symbol: string; priceUsd: number }>> {
  const out: Record<string, { symbol: string; priceUsd: number }> = {};
  const unique = [...new Set(addresses)].slice(0, 30);
  if (!unique.length) return out;
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${unique.map(encodeURIComponent).join(',')}`);
    const data = await response.json() as { pairs?: Array<{ baseToken?: { address?: string; symbol?: string }; priceUsd?: string; liquidity?: { usd?: number } }> };
    const best = new Map<string, { symbol: string; priceUsd: number; liquidity: number }>();
    for (const pair of data.pairs ?? []) {
      const address = pair.baseToken?.address;
      const price = Number(pair.priceUsd);
      if (!address || !Number.isFinite(price)) continue;
      const key = unique.find((item) => item.toLowerCase() === address.toLowerCase());
      if (!key) continue;
      const liquidity = pair.liquidity?.usd ?? 0;
      if ((best.get(key)?.liquidity ?? -1) < liquidity) best.set(key, { symbol: pair.baseToken?.symbol ?? '', priceUsd: price, liquidity });
    }
    for (const [key, value] of best) out[key] = { symbol: value.symbol, priceUsd: value.priceUsd };
  } catch {
    // Holdings still render without USD values.
  }
  return out;
}
