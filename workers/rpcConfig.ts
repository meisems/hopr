// RPC and API-key configuration for the bot.
//
// Every read (balances, scans, portfolio) and every transaction goes through
// the same ordered endpoint list per chain: keyed endpoints from the worker's
// secrets first, then the chain default, then verified public backups
// (src/services/rpcPool.ts). Transactions are only sent through an endpoint
// that just proved it is healthy and on the right chain.

import { configureRpcEndpoints, rpcEndpoints } from '../src/services/rpcPool';
import { DEFAULT_NEAR_RPC_URLS } from '../src/services/nearService';

export const SOLANA_CHAIN_ID = 1151111081099710;

export interface RpcEnv {
  /** One Alchemy key covers Base, Arbitrum, BNB Chain and Solana (+ EVM token discovery). */
  ALCHEMY_API_KEY?: string;
  /** Helius key: Solana reads, token discovery and transaction sending. */
  HELIUS_API_KEY?: string;
  /** Full RPC URLs per chain (comma-separate several); they win over the provider keys above. */
  RPC_BASE?: string;
  RPC_ARBITRUM?: string;
  RPC_BSC?: string;
  RPC_ROBINHOOD?: string;
  RPC_ARC?: string;
  RPC_SOLANA?: string;
  NEAR_RPC_URL?: string;
}

/** Chain → its RPC_* secret and Alchemy network (Alchemy only where it is long established). */
const CHAIN_RPC_ENV: Array<{ chainId: number; name: string; env: keyof RpcEnv; alchemy?: string }> = [
  { chainId: 8453, name: 'Base', env: 'RPC_BASE', alchemy: 'base-mainnet' },
  { chainId: 42161, name: 'Arbitrum', env: 'RPC_ARBITRUM', alchemy: 'arb-mainnet' },
  { chainId: 56, name: 'BNB Chain', env: 'RPC_BSC', alchemy: 'bnb-mainnet' },
  { chainId: 4663, name: 'Robinhood', env: 'RPC_ROBINHOOD' },
  { chainId: 5042, name: 'Arc', env: 'RPC_ARC' },
  { chainId: SOLANA_CHAIN_ID, name: 'Solana', env: 'RPC_SOLANA', alchemy: 'solana-mainnet' },
];

const split = (value: string | undefined) => (value ?? '').split(',').map((url) => url.trim()).filter((url) => /^https:\/\//.test(url));

/** Keyed endpoints for a chain, best first. */
export function keyedRpcUrls(env: RpcEnv, chainId: number): string[] {
  const entry = CHAIN_RPC_ENV.find((item) => item.chainId === chainId);
  if (!entry) return [];
  const urls = split(env[entry.env]);
  if (chainId === SOLANA_CHAIN_ID && env.HELIUS_API_KEY) urls.push(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY.trim())}`);
  if (entry.alchemy && env.ALCHEMY_API_KEY) urls.push(alchemyUrl(entry.alchemy, env.ALCHEMY_API_KEY));
  return [...new Set(urls)];
}

export function alchemyUrl(network: string, key: string): string {
  return `https://${network}.g.alchemy.com/v2/${encodeURIComponent(key.trim())}`;
}

/** Alchemy network for EVM token discovery (alchemy_getTokenBalances), when a key is set. */
export function alchemyNetwork(env: RpcEnv, chainId: number): string | null {
  const entry = CHAIN_RPC_ENV.find((item) => item.chainId === chainId);
  return env.ALCHEMY_API_KEY && entry?.alchemy && chainId !== SOLANA_CHAIN_ID ? entry.alchemy : null;
}

let appliedSignature: string | null = null;

/** Register the keyed endpoints with the shared pool (cheap: only re-applied when the secrets change). */
export function applyRpcConfig(env: RpcEnv) {
  const signature = CHAIN_RPC_ENV.map((entry) => keyedRpcUrls(env, entry.chainId).join(',')).join('|');
  if (signature === appliedSignature) return;
  for (const entry of CHAIN_RPC_ENV) configureRpcEndpoints(entry.chainId, keyedRpcUrls(env, entry.chainId));
  appliedSignature = signature;
}

const healthy = new Map<number, { url: string; at: number }>();
const HEALTHY_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_500;

async function probe(chainId: number, url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const body = chainId === SOLANA_CHAIN_ID
    ? { jsonrpc: '2.0', id: 1, method: 'getHealth' }
    : { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const payload = await response.json() as { result?: string };
    // The chain id check stops a mislabelled endpoint from ever receiving a signed transaction.
    return response.ok && (chainId === SOLANA_CHAIN_ID ? payload.result === 'ok' : payload.result !== undefined && BigInt(payload.result) === BigInt(chainId));
  } catch {
    return false;
  }
}

/**
 * The endpoint a transaction is sent through: the first endpoint (keyed
 * first) that is answering right now and is on `chainId`. All candidates are
 * probed at once, so a dead keyed endpoint costs at most one probe timeout.
 */
export async function transactionRpc(chainId: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cached = healthy.get(chainId);
  if (cached && Date.now() - cached.at < HEALTHY_TTL_MS) return cached.url;
  const candidates = rpcEndpoints(chainId).slice(0, 5);
  const probes = candidates.map((url) => probe(chainId, url, fetchImpl));
  for (let index = 0; index < candidates.length; index += 1) {
    if (await probes[index]) {
      healthy.set(chainId, { url: candidates[index], at: Date.now() });
      return candidates[index];
    }
  }
  throw new Error('Every RPC for this chain is unreachable right now. No transaction was sent — please try again shortly.');
}

/** Extra Solana endpoints a signed transaction is also broadcast to (faster, more reliable landing). */
export function solanaBroadcastRpcs(primary: string): string[] {
  return rpcEndpoints(SOLANA_CHAIN_ID).filter((url) => url !== primary).slice(0, 2);
}

/** Drop a cached healthy endpoint (after it fails a send). */
export function forgetTransactionRpc(chainId: number) {
  healthy.delete(chainId);
}

/** Which keys are configured — booleans only, never values (for /health and the setup docs). */
export function apiKeyStatus(env: RpcEnv & Record<string, unknown>) {
  const set = (name: string) => typeof env[name] === 'string' && (env[name] as string).trim().length > 0;
  return {
    rpc: Object.fromEntries(CHAIN_RPC_ENV.map((entry) => [entry.name, keyedRpcUrls(env, entry.chainId).length > 0])),
    near: set('NEAR_RPC_URL'),
    publicNearFallbacks: DEFAULT_NEAR_RPC_URLS.length,
    alchemy: set('ALCHEMY_API_KEY'),
    helius: set('HELIUS_API_KEY'),
    lifi: set('LIFI_API_KEY'),
    nearIntents: set('ONECLICK_JWT'),
    feeAccount: set('HOPR_INTENTS_FEE_ACCOUNT'),
    encryption: set('ENCRYPTION_KEY'),
    telegram: set('TELEGRAM_BOT_TOKEN') && set('TELEGRAM_WEBHOOK_SECRET'),
  };
}
