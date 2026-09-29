import { fetchLaunchpadFeed, launchpadById, type LaunchpadFeed, type LaunchpadId } from '../src/services/launchpads';

interface Env { CACHE?: KVNamespace; NEAR_RPC_URL?: string }
const TTL = 120_000;
const MAX_AGE = 24 * 60 * 60 * 1000;
const memory = new Map<string, LaunchpadFeed>();
const inflight = new Map<string, Promise<LaunchpadFeed>>();

/** Shared by HTTP and Telegram; an outage never replaces a last known feed with fabricated data. */
export async function getLaunchpadFeed(id: LaunchpadId, env: Env): Promise<LaunchpadFeed> {
  if (!launchpadById(id)) throw new Error('Unknown launchpad');
  const key = `launchpads:v1:${id}`;
  let cached = memory.get(key);
  if (!cached) {
    try {
      const raw = await env.CACHE?.get(key);
      const value = raw ? JSON.parse(raw) as LaunchpadFeed : null;
      if (value?.source === id && Array.isArray(value.pools) && Number.isFinite(value.observedAt)) cached = value;
    } catch { /* Storage failure must not prevent live reads. */ }
  }
  if (cached && Date.now() - cached.observedAt < TTL) return cached;
  if (inflight.has(key)) return inflight.get(key)!;
  const pending = (async () => {
    try {
      const fresh = await fetchLaunchpadFeed(id, env.NEAR_RPC_URL ? { urls: [env.NEAR_RPC_URL] } : undefined);
      memory.set(key, fresh);
      await env.CACHE?.put(key, JSON.stringify(fresh), { expirationTtl: MAX_AGE / 1000 }).catch(() => undefined);
      return fresh;
    } catch (error) {
      if (cached && Date.now() - cached.observedAt < MAX_AGE) return { ...cached, stale: true };
      throw error;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, pending);
  return pending;
}
