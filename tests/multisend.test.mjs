import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ethers } from 'ethers';
import { sendNativeMulti } from '../workers/trading.ts';
import { encryptPrivateKey, packEncryptedSecret } from '../src/services/walletService.ts';
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

const ENCRYPTION_KEY = 'multisend-test-encryption-key-0123456789';
const SENDER_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const SENDER = new ethers.Wallet(SENDER_KEY).address;

/** A local Base JSON-RPC node that records every raw transaction it is sent. */
async function fakeBaseNode() {
  const raw = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const answer = (call) => {
        const result = (() => {
          switch (call.method) {
            case 'eth_chainId': return '0x2105';
            case 'eth_getTransactionCount': return '0x5';
            case 'eth_blockNumber': return '0x10';
            case 'eth_getBlockByNumber': return { number: '0x10', baseFeePerGas: '0x3b9aca00', timestamp: '0x1', hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'2'.repeat(64)}`, gasLimit: '0x1c9c380', gasUsed: '0x0', miner: SENDER, extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', transactions: [] };
            case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
            case 'eth_gasPrice': return '0x3b9aca00';
            case 'eth_estimateGas': return '0x5208';
            case 'eth_sendRawTransaction': raw.push(call.params[0]); return ethers.keccak256(call.params[0]);
            default: return null;
          }
        })();
        return { jsonrpc: '2.0', id: call.id, result };
      };
      const payload = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, raw, close: () => server.close() };
}

test('multi-send on EVM signs one transfer per recipient with consecutive nonces, from the chosen wallet', async () => {
  const DB = createD1();
  const encrypted = packEncryptedSecret(await encryptPrivateKey(SENDER_KEY, ENCRYPTION_KEY));
  DB.raw.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active) VALUES ('w2', '901', 'W2', 'imported', ?, ?, 'x', 'y', 0)`).run(SENDER, encrypted);
  const node = await fakeBaseNode();
  const recipients = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];
  try {
    const { hashes } = await sendNativeMulti({ userId: '901', walletId: 'w2', chainId: 8453, recipients, amountUnits: (10n ** 16n).toString() },
      { evm: async () => node.url, solana: async () => '' }, { DB, ENCRYPTION_KEY });
    assert.equal(hashes.length, 3);
    const sent = node.raw.map((tx) => ethers.Transaction.from(tx));
    assert.deepEqual(sent.map((tx) => tx.to.toLowerCase()), recipients);
    assert.deepEqual(sent.map((tx) => tx.nonce), [5, 6, 7]);
    assert.ok(sent.every((tx) => tx.value === 10n ** 16n && tx.from === SENDER && tx.chainId === 8453n));
  } finally {
    node.close();
  }
});

test('bot: 📤 Multi-send to my other wallets shows the total and balance before anything is sent', async () => {
  const DB = createD1();
  const add = (id, label, evm, active) => DB.raw.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active) VALUES (?, '902', ?, 'generated', ?, 'k', ?, 's', ?)`).run(id, label, evm, `Sol${id}11111111111111111111111111111111111`.slice(0, 44), active);
  add('a1', 'W1', '0x1000000000000000000000000000000000000001', 1);
  add('a2', 'W2', '0x2000000000000000000000000000000000000002', 0);
  add('a3', 'W3', '0x3000000000000000000000000000000000000003', 0);
  const values = new Map();
  const kv = { get: async (key) => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); }, delete: async (key) => { values.delete(key); } };
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's', DB, TELEGRAM_STATE: kv };
  const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const tap = async (data) => {
    const sent = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('api.telegram.org')) { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: true }); }
      const body = JSON.parse(init.body);
      return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x' }); // 1 ETH
    };
    try {
      await worker.fetch(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' }, body: JSON.stringify({ callback_query: { id: data, data, message: { message_id: 7, chat: { id: 902, type: 'private' } } } }) }), env, {});
    } finally {
      globalThis.fetch = original;
    }
    return sent.filter((call) => call.text).at(-1);
  };
  const start = await tap('ms:start');
  assert.ok(start.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'ms:chain:8453'));
  const who = await tap('ms:chain:8453');
  assert.equal(who.reply_markup.inline_keyboard[0][0].text, '👛 My other wallets (2)');
  const amounts = await tap('ms:to:mine');
  assert.match(plain(amounts.text), /2 recipients/);
  assert.match(plain(amounts.text), /W2 .*\n.*W3/s);
  const review = await tap('ms:amt:0.01');
  const text = plain(review.text);
  assert.match(text, /Each  0\.01 ETH → 2 addresses on Base/);
  assert.match(text, /Total  0\.02 ETH \+ network fees/);
  assert.match(text, /Balance  1 ETH/);
  assert.equal(review.reply_markup.inline_keyboard[0][0].callback_data, 'ms:send');
});
