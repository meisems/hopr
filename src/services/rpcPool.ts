// JSON-RPC with failover, shared by the dashboard and the worker.
//
// Public RPCs come and go: they rate-limit, block browsers (Solana's own
// api.mainnet-beta.solana.com answers 403 to any request with an Origin), or
// refuse individual methods (several Solana RPCs reject getTokenAccountsByOwner
// without a key). Every read goes through a pool per chain: the configured
// endpoint first (VITE_RPC_* / worker env), then public fallbacks that were
// verified to answer from browsers. The last endpoint that worked is tried
// first next time. Genuine call errors (e.g. an eth_call revert) are
// returned immediately instead of being retried elsewhere.

import { getNetwork, SOLANA_CHAIN_ID } from './chains';

const FALLBACKS: Record<number, string[]> = {
  8453: ['https://mainnet.base.org', 'https://base.drpc.org', 'https://1rpc.io/base'],
  42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org', 'https://1rpc.io/arb'],
  56: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'],
  4663: ['https://rpc.mainnet.chain.robinhood.com'],
  5042: ['https://rpc.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'],
  [SOLANA_CHAIN_ID]: [
    'https://public.rpc.solanavibestation.com',
    'https://solana-rpc.publicnode.com',
    'https://rpc.solanatracker.io/public',
    'https://solana.leorpc.com/?api_key=FREE',
    'https://api.mainnet-beta.solana.com', // server-side only (403 from browsers)
  ],
};

const preferred = new Map<number, string>();

/** Endpoints for a chain: configured first, then public fallbacks (deduplicated). */
export function rpcEndpoints(chainId: number, extra: string[] = []): string[] {
  const configured = getNetwork(chainId)?.rpcUrl;
  const all = [...extra, ...(configured ? [configured] : []), ...(FALLBACKS[chainId] ?? [])].filter(Boolean);
  const unique = [...new Set(all)];
  const best = preferred.get(chainId);
  return best && unique.includes(best) ? [best, ...unique.filter((url) => url !== best)] : unique;
}

/** A JSON-RPC error that is about the call itself, not the endpoint (don't fail over). */
export class RpcCallError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

function endpointProblem(error: { code?: number; message?: string }): boolean {
  const message = error.message ?? '';
  return [-32601, -32603, -32005, -32029, -32000, 429, 403, 401].includes(error.code ?? 0)
    && !/revert|execution|insufficient|nonce|invalid (argument|params)/i.test(message)
    || /rate|limit|forbidden|not allowed|api key|token|unavailable|timeout|too many|not available|unauthor/i.test(message);
}

export async function jsonRpc<T>(chainId: number, method: string, params: unknown, options: { timeoutMs?: number; extra?: string[]; fetchImpl?: typeof fetch; validate?: (value: T) => boolean } = {}): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  let lastError: unknown = new Error(`No RPC endpoint for chain ${chainId}`);
  for (const url of rpcEndpoints(chainId, options.extra)) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 8000) : null;
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller?.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json().catch(() => null) as { result?: T; error?: { code?: number; message?: string } } | null;
      if (!payload) throw new Error(`HTTP ${response.status}`);
      if (payload.error) {
        if (endpointProblem(payload.error) || !response.ok) throw new Error(payload.error.message ?? `HTTP ${response.status}`);
        throw new RpcCallError(payload.error.message ?? `${method} failed`, payload.error.code);
      }
      if (payload.result === undefined) throw new Error(`${method}: empty response`);
      if (options.validate && !options.validate(payload.result)) throw new Error(`${method}: malformed result`);
      preferred.set(chainId, url);
      return payload.result;
    } catch (error) {
      if (error instanceof RpcCallError) throw error;
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Last-known balances (browser): shown when every endpoint is down, so a
// balance never flips to "unavailable" for a network blip.
// ---------------------------------------------------------------------------

const CACHE_KEY = 'hopr-balance-cache-v1';
type CacheEntry = { value: string; at: number };
let memory: Record<string, CacheEntry> | null = null;

function cache(): Record<string, CacheEntry> {
  if (memory) return memory;
  try {
    const parsed = typeof localStorage === 'undefined' ? {} : JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    memory = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    memory = {};
  }
  return memory ?? {};
}

export function rememberBalance(key: string, value: bigint) {
  const store = cache();
  store[key] = { value: value.toString(), at: Date.now() };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // storage full or blocked: the in-memory copy still works this session
  }
}

export function recallBalance(key: string): { value: bigint; at: number } | null {
  const entry = cache()[key];
  if (!entry || !Number.isFinite(entry.at) || Date.now() - entry.at > 30 * 86400_000 || !/^\d+$/.test(entry.value)) return null;
  return { value: BigInt(entry.value), at: entry.at };
}
