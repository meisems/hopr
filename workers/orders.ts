// Limit sell, take profit and stop loss orders.
//
// Orders live in D1 (migrations/0008_limit_orders.sql). The worker's cron
// trigger runs runOrderSweep() every minute: it prices every token with an
// active order (one request per chain), claims each triggered order with a
// conditional UPDATE (so overlapping runs can never sell twice), executes the
// sell from the order's wallet and tells the user in Telegram. Placing an
// order is the user's authorization for that one automatic sell.

export type OrderKind = 'limit' | 'tp' | 'sl';
export type OrderStatus = 'active' | 'executing' | 'filled' | 'failed' | 'cancelled';

export interface LimitOrder {
  id: string;
  user_id: string;
  wallet_id: string | null;
  chain_id: number;
  token_address: string;
  symbol: string;
  kind: OrderKind;
  trigger_price_usd: number;
  reference_price_usd: number;
  sell_percent: number;
  slippage: number;
  status: OrderStatus;
  attempts: number;
  triggered_price_usd: number | null;
  tx_hash: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface OrdersEnv {
  DB?: D1Database;
}

export const MAX_ACTIVE_ORDERS = 20;
/** Execution attempts before an order is given up on (quotes can fail for a minute or two). */
export const MAX_ORDER_ATTEMPTS = 3;
/** An order stuck in 'executing' this long was interrupted mid-run. */
const STUCK_EXECUTION_MS = 10 * 60_000;

export const ORDER_LABEL: Record<OrderKind, string> = { limit: 'Limit sell', tp: 'Take profit', sl: 'Stop loss' };

export class OrderError extends Error {
  /** Retrying cannot help (e.g. the wallet holds none of the token). */
  constructor(message: string, readonly final = false) {
    super(message);
  }
}

/** Limit and take-profit sell at or above the trigger; stop loss at or below. */
export function isTriggered(order: Pick<LimitOrder, 'kind' | 'trigger_price_usd'>, priceUsd: number): boolean {
  if (!(priceUsd > 0)) return false;
  return order.kind === 'sl' ? priceUsd <= order.trigger_price_usd : priceUsd >= order.trigger_price_usd;
}

export async function createOrder(env: OrdersEnv, input: {
  userId: string; walletId: string | null; chainId: number; tokenAddress: string; symbol: string; kind: OrderKind;
  triggerPriceUsd: number; referencePriceUsd: number; sellPercent: number; slippage: number;
}, now = Date.now()): Promise<LimitOrder> {
  if (!env.DB) throw new OrderError('Orders need the DB binding.', true);
  if (!(input.triggerPriceUsd > 0) || !Number.isFinite(input.triggerPriceUsd)) throw new OrderError('Trigger price must be above zero.', true);
  if (![25, 50, 100].includes(input.sellPercent)) throw new OrderError('Sell 25%, 50% or 100%.', true);
  const active = await env.DB.prepare(`SELECT COUNT(*) AS total FROM limit_orders WHERE user_id = ?1 AND status IN ('active','executing')`).bind(input.userId).first<{ total: number }>();
  if ((active?.total ?? 0) >= MAX_ACTIVE_ORDERS) throw new OrderError(`You already have ${MAX_ACTIVE_ORDERS} open orders. Cancel one in 🎯 Orders first.`, true);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO limit_orders (id, user_id, wallet_id, chain_id, token_address, symbol, kind, trigger_price_usd, reference_price_usd, sell_percent, slippage, status, attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', 0, ?12, ?12)`,
  ).bind(id, input.userId, input.walletId, input.chainId, input.tokenAddress, input.symbol.slice(0, 32), input.kind, input.triggerPriceUsd, input.referencePriceUsd, input.sellPercent, input.slippage, now).run();
  return (await env.DB.prepare(`SELECT * FROM limit_orders WHERE id = ?1`).bind(id).first<LimitOrder>())!;
}

export async function listOrders(env: OrdersEnv, userId: string): Promise<{ open: LimitOrder[]; recent: LimitOrder[] }> {
  if (!env.DB) return { open: [], recent: [] };
  const [open, recent] = await Promise.all([
    env.DB.prepare(`SELECT * FROM limit_orders WHERE user_id = ?1 AND status IN ('active','executing') ORDER BY created_at DESC LIMIT ?2`).bind(userId, MAX_ACTIVE_ORDERS).all<LimitOrder>(),
    env.DB.prepare(`SELECT * FROM limit_orders WHERE user_id = ?1 AND status IN ('filled','failed') ORDER BY updated_at DESC LIMIT 5`).bind(userId).all<LimitOrder>(),
  ]);
  return { open: open.results ?? [], recent: recent.results ?? [] };
}

/** Cancels an order that has not started executing. */
export async function cancelOrder(env: OrdersEnv, userId: string, id: string, now = Date.now()): Promise<boolean> {
  if (!env.DB) return false;
  const result = await env.DB.prepare(`UPDATE limit_orders SET status = 'cancelled', updated_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'active'`).bind(id, userId, now).run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface SweepDeps {
  /** Current USD prices for tokens on one chain (lowercased address → price). */
  prices: (chainId: number, addresses: string[]) => Promise<Map<string, number>>;
  /** Sell for a triggered order; resolves with the transaction hash. Throw OrderError(…, true) when retrying is pointless. */
  execute: (order: LimitOrder) => Promise<{ txHash: string; explorerUrl?: string }>;
  notify: (order: LimitOrder, outcome: { status: 'filled'; txHash: string; explorerUrl?: string; priceUsd: number } | { status: 'failed'; error: string } | { status: 'retrying'; error: string }) => Promise<void>;
  now?: () => number;
}

export interface SweepResult { checked: number; triggered: number; filled: number; failed: number; retrying: number; interrupted: number }

/** One pass over every active order: price, claim, sell, notify. */
export async function runOrderSweep(env: OrdersEnv, deps: SweepDeps, limit = 500): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, triggered: 0, filled: 0, failed: 0, retrying: 0, interrupted: 0 };
  if (!env.DB) return result;
  const now = deps.now ?? Date.now;

  // A run that died mid-sell leaves 'executing' behind: the sell may or may not have landed, so never retry it blindly.
  const stuck = await env.DB.prepare(`SELECT * FROM limit_orders WHERE status = 'executing' AND updated_at < ?1`).bind(now() - STUCK_EXECUTION_MS).all<LimitOrder>();
  for (const order of stuck.results ?? []) {
    const error = 'Interrupted while selling — check your wallet before placing it again.';
    const update = await env.DB.prepare(`UPDATE limit_orders SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'executing'`).bind(order.id, error, now()).run();
    if ((update.meta?.changes ?? 0) > 0) {
      result.interrupted += 1;
      await deps.notify(order, { status: 'failed', error }).catch(() => undefined);
    }
  }

  const rows = await env.DB.prepare(`SELECT * FROM limit_orders WHERE status = 'active' ORDER BY created_at ASC LIMIT ?1`).bind(limit).all<LimitOrder>();
  const orders = rows.results ?? [];
  result.checked = orders.length;
  if (!orders.length) return result;

  // One price request per chain for every token with an order.
  const byChain = new Map<number, string[]>();
  for (const order of orders) byChain.set(order.chain_id, [...new Set([...(byChain.get(order.chain_id) ?? []), order.token_address])]);
  const prices = new Map<string, number>();
  await Promise.all([...byChain.entries()].map(async ([chainId, addresses]) => {
    const quoted = await deps.prices(chainId, addresses).catch(() => new Map<string, number>());
    for (const [address, price] of quoted) prices.set(`${chainId}:${address.toLowerCase()}`, price);
  }));

  for (const order of orders) {
    const price = prices.get(`${order.chain_id}:${order.token_address.toLowerCase()}`);
    if (price === undefined || !isTriggered(order, price)) continue;
    // Claim it: only one run can move an order from active to executing.
    const claim = await env.DB.prepare(
      `UPDATE limit_orders SET status = 'executing', attempts = attempts + 1, triggered_price_usd = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'active'`,
    ).bind(order.id, price, now()).run();
    if ((claim.meta?.changes ?? 0) === 0) continue;
    result.triggered += 1;
    const claimed: LimitOrder = { ...order, status: 'executing', attempts: order.attempts + 1, triggered_price_usd: price };
    try {
      const { txHash, explorerUrl } = await deps.execute(claimed);
      await env.DB.prepare(`UPDATE limit_orders SET status = 'filled', tx_hash = ?2, error = NULL, updated_at = ?3 WHERE id = ?1`).bind(order.id, txHash, now()).run();
      result.filled += 1;
      await deps.notify({ ...claimed, status: 'filled', tx_hash: txHash }, { status: 'filled', txHash, explorerUrl, priceUsd: price }).catch(() => undefined);
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Sell failed').slice(0, 300);
      const final = (error instanceof OrderError && error.final) || claimed.attempts >= MAX_ORDER_ATTEMPTS;
      await env.DB.prepare(`UPDATE limit_orders SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1`).bind(order.id, final ? 'failed' : 'active', message, now()).run();
      if (final) {
        result.failed += 1;
        await deps.notify({ ...claimed, status: 'failed', error: message }, { status: 'failed', error: message }).catch(() => undefined);
      } else {
        result.retrying += 1;
        // Only the first miss is reported; the order keeps watching the price.
        if (claimed.attempts === 1) await deps.notify(claimed, { status: 'retrying', error: message }).catch(() => undefined);
      }
    }
  }
  return result;
}
