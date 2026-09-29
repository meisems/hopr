import { launchpadById, type LaunchpadPool } from '../src/services/launchpads';

interface StorageEnv { CACHE?: KVNamespace; TELEGRAM_STATE?: KVNamespace }
export interface PoolAction {
  pool: LaunchpadPool;
  fundingChainId: number;
  amount: string;
}
const TTL = 15 * 60;

/** Immutable, chat-bound snapshot: a stale button must never buy a newly ranked token. */
export async function savePoolActions(chatId: number, actions: PoolAction[], env: StorageEnv): Promise<string | null> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  if (!store) return null;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  await store.put(`pool-actions:${chatId}:${id}`, JSON.stringify({ expiresAt: Date.now() + TTL * 1000, actions }), { expirationTtl: TTL });
  return id;
}

export async function readPoolAction(chatId: number, id: string, index: number, env: StorageEnv): Promise<PoolAction | null> {
  if (!/^[a-f0-9]{24}$/.test(id) || !Number.isInteger(index) || index < 0 || index > 5) return null;
  const raw = await (env.TELEGRAM_STATE ?? env.CACHE)?.get(`pool-actions:${chatId}:${id}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const action = data.actions?.[index] as PoolAction | undefined;
    const source = action && launchpadById(action.pool?.source);
    if (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() || !source || source.chainId !== action?.pool.chainId) return null;
    return action ?? null;
  } catch { return null; }
}
