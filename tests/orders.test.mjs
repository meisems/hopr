import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cancelOrder, createOrder, isTriggered, listOrders, MAX_ORDER_ATTEMPTS, OrderError, runOrderSweep } from '../workers/orders.ts';
import worker from '../workers/index.ts';

/** D1 over in-memory SQLite with every migration applied, in order. */
function createD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      const statement = db.prepare(sql);
      const run = (args) => ({
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
      });
      return { ...run([]), bind: (...args) => run(args) };
    },
  };
}

const TOKEN = '0x4444444444444444444444444444444444440004';
const base = { userId: '700', walletId: 'w1', chainId: 8453, tokenAddress: TOKEN, symbol: 'ORD', referencePriceUsd: 1, sellPercent: 50, slippage: 0.01 };

test('triggers: limit and take profit at or above, stop loss at or below', () => {
  assert.equal(isTriggered({ kind: 'tp', trigger_price_usd: 2 }, 2), true);
  assert.equal(isTriggered({ kind: 'limit', trigger_price_usd: 2 }, 1.99), false);
  assert.equal(isTriggered({ kind: 'sl', trigger_price_usd: 0.8 }, 0.8), true);
  assert.equal(isTriggered({ kind: 'sl', trigger_price_usd: 0.8 }, 0.81), false);
  assert.equal(isTriggered({ kind: 'sl', trigger_price_usd: 0.8 }, 0), false, 'a missing price never triggers a stop loss');
});

test('the sweep sells triggered orders once, leaves the rest, and reports fills', async () => {
  const env = { DB: createD1() };
  const tp = await createOrder(env, { ...base, kind: 'tp', triggerPriceUsd: 1.5 });
  const sl = await createOrder(env, { ...base, kind: 'sl', triggerPriceUsd: 0.7 });
  const executed = [];
  const notes = [];
  const deps = {
    prices: async (chainId, addresses) => new Map(addresses.map((address) => [address.toLowerCase(), 1.6])),
    execute: async (order) => { executed.push(order.id); return { txHash: `0xtx-${order.id}` }; },
    notify: async (order, outcome) => { notes.push([order.id, outcome.status]); },
  };
  // Two overlapping runs: the conditional claim lets only one of them sell.
  const [first, second] = await Promise.all([runOrderSweep(env, deps), runOrderSweep(env, deps)]);
  assert.equal(first.filled + second.filled, 1);
  assert.deepEqual(executed, [tp.id]);
  assert.deepEqual(notes, [[tp.id, 'filled']]);
  const { open, recent } = await listOrders(env, '700');
  assert.deepEqual(open.map((order) => order.id), [sl.id], 'the stop loss keeps watching');
  assert.equal(recent[0].tx_hash, `0xtx-${tp.id}`);
  assert.equal(recent[0].triggered_price_usd, 1.6);
});

test('a failed sell retries while triggered, then gives up and tells the user; final errors stop at once', async () => {
  const env = { DB: createD1() };
  const order = await createOrder(env, { ...base, kind: 'sl', triggerPriceUsd: 0.9 });
  const notes = [];
  const deps = {
    prices: async () => new Map([[TOKEN.toLowerCase(), 0.5]]),
    execute: async () => { throw new Error('LI.FI is slow to quote right now'); },
    notify: async (_order, outcome) => { notes.push(outcome.status); },
  };
  for (let run = 0; run < MAX_ORDER_ATTEMPTS; run += 1) await runOrderSweep(env, deps);
  assert.deepEqual(notes, ['retrying', 'failed'], 'one heads-up, then the final failure');
  const row = env.DB.raw.prepare('SELECT status, attempts, error FROM limit_orders WHERE id = ?').get(order.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, MAX_ORDER_ATTEMPTS);

  const empty = await createOrder(env, { ...base, kind: 'tp', triggerPriceUsd: 0.1 });
  await runOrderSweep(env, { ...deps, execute: async () => { throw new OrderError('The wallet holds no ORD any more.', true); } });
  assert.equal(env.DB.raw.prepare('SELECT status FROM limit_orders WHERE id = ?').get(empty.id).status, 'failed');
});

test('an order interrupted mid-sell is closed and reported, never re-sold blindly', async () => {
  const env = { DB: createD1() };
  const order = await createOrder(env, { ...base, kind: 'tp', triggerPriceUsd: 1.1 }, 1_000);
  env.DB.raw.prepare(`UPDATE limit_orders SET status = 'executing', updated_at = 1000 WHERE id = ?`).run(order.id);
  const notes = [];
  const result = await runOrderSweep(env, {
    prices: async () => new Map([[TOKEN.toLowerCase(), 5]]),
    execute: async () => { throw new Error('must not run'); },
    notify: async (_order, outcome) => { notes.push(outcome.status); },
    now: () => 1_000 + 11 * 60_000,
  });
  assert.equal(result.interrupted, 1);
  assert.deepEqual(notes, ['failed']);
});

test('orders can be cancelled until they start executing, and are capped per user', async () => {
  const env = { DB: createD1() };
  const order = await createOrder(env, { ...base, kind: 'limit', triggerPriceUsd: 3 });
  assert.equal(await cancelOrder(env, '999', order.id), false, 'only the owner can cancel');
  assert.equal(await cancelOrder(env, '700', order.id), true);
  assert.equal(await cancelOrder(env, '700', order.id), false);
  await assert.rejects(createOrder(env, { ...base, kind: 'tp', triggerPriceUsd: 3, sellPercent: 30 }), /Sell 25%, 50% or 100%/);
});

test('bot: 🛑 Stop loss → −20% → sell 50% → place, then cancel from 🎯 Orders', async () => {
  const DB = createD1();
  DB.raw.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active) VALUES ('w1', '701', 'W1', 'generated', '0x1111111111111111111111111111111111111111', 'x', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'y', 1)`).run();
  const values = new Map([['telegram:701', JSON.stringify({ lastTokenAddress: TOKEN, lastTokenChainId: 8453, lastTokenSymbol: 'ORD' })]]);
  const kv = { get: async (key) => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); }, delete: async (key) => { values.delete(key); } };
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's', DB, TELEGRAM_STATE: kv };
  const tap = async (data) => {
    const sent = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes('api.telegram.org')) { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: true }); }
      if (href.includes('dexscreener.com/tokens/v1/base')) return Response.json([{ baseToken: { address: TOKEN, symbol: 'ORD' }, priceUsd: '2', liquidity: { usd: 50_000 } }]);
      return new Response('', { status: 429 });
    };
    try {
      await worker.fetch(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' }, body: JSON.stringify({ callback_query: { id: data, data, message: { message_id: 4, chat: { id: 701, type: 'private' } } } }) }), env, {});
    } finally {
      globalThis.fetch = original;
    }
    return sent.filter((call) => call.text).at(-1);
  };
  const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const start = await tap('order:new:sl');
  assert.match(plain(start.text), /Stop loss · ORD/);
  assert.match(plain(start.text), /Price now  \$2/);
  assert.deepEqual(start.reply_markup.inline_keyboard[0].map((button) => button.text), ['−10%', '−20%', '−30%', '−50%']);
  const sizes = await tap('order:at:sl:20');
  assert.match(plain(sizes.text), /≤ \$1\.6 \(−20%\)/);
  const review = await tap('order:size:50');
  assert.match(plain(review.text), /Executes automatically/);
  assert.match(plain(review.text), /Sell  50% of what W1 holds/);
  const placed = await tap('order:place');
  assert.match(plain(placed.text), /Stop loss placed for ORD/);
  const row = DB.raw.prepare('SELECT * FROM limit_orders WHERE user_id = ?').get('701');
  assert.equal(row.kind, 'sl');
  assert.equal(row.wallet_id, 'w1');
  assert.equal(row.sell_percent, 50);
  assert.ok(Math.abs(row.trigger_price_usd - 1.6) < 1e-9);
  const cancel = placed.reply_markup.inline_keyboard[0][0];
  assert.equal(cancel.callback_data, `order:cancel:${row.id}`);
  const after = await tap(cancel.callback_data);
  assert.match(plain(after.text), /Order cancelled/);
  assert.equal(DB.raw.prepare('SELECT status FROM limit_orders WHERE id = ?').get(row.id).status, 'cancelled');
});
