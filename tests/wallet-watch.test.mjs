import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { classifyMovements, evmDeltas, runWalletWatch, solanaDeltas, walletKind } from '../workers/walletWatch.ts';
import worker from '../workers/index.ts';

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
const createKv = () => {
  const values = new Map();
  return { values, get: async (key) => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); }, delete: async (key) => { values.delete(key); } };
};

const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LEADER = '0xaaaa00000000000000000000000000000000aaaa';
const WETH = '0x4200000000000000000000000000000000000006';
const MEME = '0x5555000000000000000000000000000000005555';
const pad = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const amount = (value) => `0x${value.toString(16).padStart(64, '0')}`;

test('addresses: EVM, Solana and NEAR are told apart', () => {
  assert.equal(walletKind('0x1111111111111111111111111111111111111111'), 'evm');
  assert.equal(walletKind('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'), 'svm');
  assert.equal(walletKind('whale.near'), 'near');
  assert.equal(walletKind('not an address'), null);
});

test('EVM: token in while WETH goes out is a buy; token out is a sell; base coins are never "traded"', () => {
  const logs = [
    { address: MEME, topics: [T, pad('0x9999000000000000000000000000000000009999'), pad(LEADER)], data: amount(1000n), transactionHash: '0xbuy' },
    { address: WETH, topics: [T, pad(LEADER), pad('0x9999000000000000000000000000000000009999')], data: amount(5n), transactionHash: '0xbuy' },
    { address: MEME, topics: [T, pad(LEADER), pad('0x9999000000000000000000000000000000009999')], data: amount(400n), transactionHash: '0xsell' },
  ];
  const perTx = evmDeltas(logs, new Set([LEADER]));
  const buy = classifyMovements(perTx.get(`${LEADER}|0xbuy`), new Map([[WETH, 'WETH'], [MEME, 'MEME']]));
  assert.deepEqual(buy, [{ side: 'buy', token: MEME, amount: 1000n }]);
  const sell = classifyMovements(perTx.get(`${LEADER}|0xsell`), new Map([[MEME, 'MEME']]));
  assert.deepEqual(sell, [{ side: 'sell', token: MEME, amount: 400n }]);
});

test('Solana: the owner’s token balance changes in a swap become a buy (USDC spent is base)', () => {
  const owner = 'Own3r1111111111111111111111111111111111111';
  const tx = { meta: {
    preTokenBalances: [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner, uiTokenAmount: { amount: '5000000', decimals: 6 } }],
    postTokenBalances: [
      { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner, uiTokenAmount: { amount: '0', decimals: 6 } },
      { mint: 'MemeMint11111111111111111111111111111111111', owner, uiTokenAmount: { amount: '777', decimals: 9 } },
      { mint: 'MemeMint11111111111111111111111111111111111', owner: 'someoneElse', uiTokenAmount: { amount: '5', decimals: 9 } },
    ],
  } };
  const { deltas, post } = solanaDeltas(tx, owner);
  assert.deepEqual(classifyMovements(deltas, new Map()), [{ side: 'buy', token: 'MemeMint11111111111111111111111111111111111', amount: 777n }]);
  assert.equal(post.get('MemeMint11111111111111111111111111111111111'), '777');
});

test('the watch alerts every tracker, copies once for copy traders, and ignores spam tokens', async () => {
  const env = { DB: createD1(), TELEGRAM_STATE: createKv() };
  const insert = (id, user, mode) => env.DB.raw.prepare(`INSERT INTO tracked_wallets (id, user_id, address, kind, label, alerts, copy_mode, copy_amount_usd, created_at, updated_at) VALUES (?, ?, ?, 'evm', 'Whale', 1, ?, 25, 1, 1)`).run(id, user, LEADER, mode);
  insert('t1', '801', 'off');
  insert('t2', '802', 'buy');
  let block = 100;
  const pending = [];
  const alerts = [];
  const copies = [];
  const results = [];
  const deps = {
    latestBlock: async (chainId) => (chainId === 8453 ? block : 1),
    evmTrades: async (chainId, addresses, from, to) => (chainId === 8453 ? pending.splice(0).map((trade) => ({ ...trade, from, to })) : []),
    solanaTrades: async () => ({ trades: [], cursor: null }),
    nearTrades: async () => ({ trades: [], snapshot: {} }),
    markets: async () => new Map([[MEME, { priceUsd: 0.5, liquidityUsd: 80_000, symbol: 'MEME' }]]),
    alert: async (tracker, trade) => { alerts.push([tracker.user_id, trade.side, trade.symbol]); },
    copy: async (tracker, trade) => { copies.push([tracker.user_id, trade.side]); return { txHash: '0xcopy' }; },
    copyResult: async (tracker, trade, outcome) => { results.push([tracker.user_id, outcome.status]); },
  };
  // First look: cursors are set, nothing replayed.
  await runWalletWatch(env, deps);
  assert.equal(env.TELEGRAM_STATE.values.get('watch:evm:8453'), '100');

  block = 110;
  const buy = { address: LEADER, chainId: 8453, txHash: '0xb1', side: 'buy', token: MEME, amount: '100000000000000000000', decimals: 18, symbol: 'TOKEN', remaining: '100000000000000000000' };
  const spam = { ...buy, txHash: '0xs1', token: '0xdead00000000000000000000000000000000dead' };
  pending.push(buy, spam);
  const run = await runWalletWatch(env, deps);
  assert.equal(run.trades, 1, 'the token without a market is ignored');
  assert.deepEqual(alerts, [['801', 'buy', 'MEME'], ['802', 'buy', 'MEME']]);
  assert.deepEqual(copies, [['802', 'buy']]);
  assert.deepEqual(results, [['802', 'filled']]);

  // The same leader trade seen again is never copied twice; sells are not copied in "buy" mode.
  block = 120;
  pending.push(buy, { ...buy, txHash: '0xs2', side: 'sell' });
  await runWalletWatch(env, deps);
  assert.deepEqual(copies, [['802', 'buy']]);
  assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS total FROM copy_trades`).get().total, 1);
});

test('bot: /track a wallet, then turn on copy trading with an explicit confirmation', async () => {
  const DB = createD1();
  const kv = createKv();
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's', DB, TELEGRAM_STATE: kv };
  const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const send = async (update) => {
    const sent = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { if (String(url).includes('api.telegram.org')) sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: true }); };
    try {
      await worker.fetch(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' }, body: JSON.stringify(update) }), env, {});
    } finally {
      globalThis.fetch = original;
    }
    return sent.filter((call) => call.text).at(-1);
  };
  const added = await send({ message: { chat: { id: 803, type: 'private' }, text: `/track ${LEADER.toUpperCase().replace('0X', '0x')} Big Whale` } });
  assert.match(plain(added.text), /Tracking Big Whale/);
  const row = DB.raw.prepare('SELECT * FROM tracked_wallets WHERE user_id = ?').get('803');
  assert.equal(row.address, LEADER, 'stored lowercased');
  assert.equal(row.copy_mode, 'off');
  const tap = (data) => send({ callback_query: { id: data, data, message: { message_id: 3, chat: { id: 803, type: 'private' } } } });
  const review = await tap(`track:ca:${row.id}:buysell:50`);
  assert.match(plain(review.text), /Trades execute automatically/);
  assert.match(plain(review.text), /Per buy  \$50/);
  await tap(`track:ok:${row.id}:buysell:50`);
  const after = DB.raw.prepare('SELECT copy_mode, copy_amount_usd FROM tracked_wallets WHERE id = ?').get(row.id);
  assert.deepEqual({ ...after }, { copy_mode: 'buysell', copy_amount_usd: 50 });
  const dup = await send({ message: { chat: { id: 803, type: 'private' }, text: `/track ${LEADER}` } });
  assert.match(plain(dup.text), /already track/);
});
