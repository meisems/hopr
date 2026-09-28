import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSignedTransaction } from '@near-js/transactions';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2';
import worker from '../workers/index.ts';
import { encryptPrivateKey, packEncryptedSecret } from '../src/services/walletService.ts';
import {
  NEAR_CHAIN_ID,
  REF_EXCHANGE,
  WRAP_NEAR,
} from '../src/services/nearService.ts';
import { generateNearWallet } from '../src/services/nearSigner.ts';

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BRIDGED_USDC = 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near';
const ENCRYPTION_KEY = 'test-encryption-key-0123456789abcdef';
const baseEnv = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret', ENCRYPTION_KEY };

const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function createKv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    values,
  };
}

/** Minimal D1 stand-in that answers the custody queries by SQL shape. */
function createCustodyDb(wallet) {
  const trades = [];
  return {
    trades,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (/SELECT evm_address, solana_address, near_address FROM wallet_accounts/.test(sql)) {
                return { evm_address: wallet.evm, solana_address: wallet.solana, near_address: wallet.near.address };
              }
              if (/SELECT near_address, near_encrypted_key FROM wallet_accounts/.test(sql)) {
                return { near_address: wallet.near.address, near_encrypted_key: wallet.nearEncrypted };
              }
              return null;
            },
            async run() {
              if (/INSERT INTO user_trades/.test(sql)) trades.push(params);
              return { success: true, meta: { changes: 1 } };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
}

const ROUTER_RESPONSE = {
  result_code: 0,
  result_data: {
    routes: [{
      pools: [
        { pool_id: '3', token_in: WRAP_NEAR, token_out: BRIDGED_USDC, amount_in: '1000000000000000000000000', min_amount_out: '0' },
        { pool_id: '5516', token_in: BRIDGED_USDC, token_out: USDC, amount_in: '0', min_amount_out: '5236549' },
      ],
      amount_in: '1000000000000000000000000',
      min_amount_out: '5236549',
    }],
    amount_out: '5262864',
  },
};

/** Mocked NEAR RPC + Ref router + DexScreener. Records every broadcast transaction. */
function createNearNetwork() {
  const broadcasts = [];
  const blockHash = bs58.encode(sha256(new TextEncoder().encode('block')));
  const encode = (value) => ({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('smartrouter.ref.finance')) return Response.json(ROUTER_RESPONSE);
    if (href.includes('dexscreener')) {
      const requested = decodeURIComponent(href.split('/').pop());
      return Response.json({ pairs: [{
        chainId: 'near', dexId: 'rhea-finance', pairAddress: '3',
        baseToken: { address: requested, name: 'USD Coin', symbol: 'USDC' },
        quoteToken: { address: WRAP_NEAR, name: 'Wrapped NEAR', symbol: 'wNEAR' },
        priceUsd: '0.9998', liquidity: { usd: 2_400_000 }, fdv: 50_000_000, priceChange: { h24: 0.01 }, volume: { h24: 900_000 },
      }] });
    }
    const body = JSON.parse(init.body);
    if (body.method === 'send_tx') {
      broadcasts.push(decodeSignedTransaction(Buffer.from(body.params.signed_tx_base64, 'base64')));
      return Response.json({ result: { status: { SuccessValue: '' }, receipts_outcome: [] } });
    }
    const params = body.params;
    if (params.request_type === 'view_account') return Response.json({ result: { amount: '10000000000000000000000000', locked: '0', storage_usage: 182 } });
    if (params.request_type === 'view_access_key') return Response.json({ result: { nonce: 100, block_hash: blockHash, permission: 'FullAccess' } });
    switch (params.method_name) {
      case 'ft_metadata': return Response.json(encode({ symbol: 'USDC', name: 'USD Coin', decimals: 6 }));
      case 'storage_balance_of': return Response.json(encode(null));
      case 'storage_balance_bounds': return Response.json(encode({ min: '1250000000000000000000', max: '1250000000000000000000' }));
      case 'ft_balance_of': return Response.json(encode('0'));
      default: throw new Error(`Unexpected RPC call ${JSON.stringify(params)}`);
    }
  };
  return { fetchImpl, broadcasts };
}

async function sendUpdate(update, env, network) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('api.telegram.org')) {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json({ ok: true, result: { message_id: 999 } });
    }
    if (!network) throw new Error(`Unexpected external request: ${url}`);
    return network.fetchImpl(url, init);
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': baseEnv.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify(update),
    }), env, {});
    assert.equal(response.status, 200);
    return calls;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function custodialSetup() {
  const near = generateNearWallet();
  const wallet = {
    evm: '0x1234567890abcdef1234567890abcdef12345678',
    solana: '11111111111111111111111111111111',
    near,
    nearEncrypted: packEncryptedSecret(await encryptPrivateKey(near.privateKey, ENCRYPTION_KEY)),
  };
  const kv = createKv();
  const db = createCustodyDb(wallet);
  return { wallet, kv, db, env: { ...baseEnv, TELEGRAM_STATE: kv, DB: db } };
}

test('NEAR token address opens a NEAR market card with NEAR-denominated quick buys', async () => {
  const network = createNearNetwork();
  const calls = await sendUpdate({ message: { chat: { id: 70, type: 'private' }, text: 'Token.V2.Ref-Finance.near' } }, { ...baseEnv, TELEGRAM_STATE: createKv() }, {
    ...network,
    fetchImpl: async (url, init) => {
      assert.doesNotMatch(String(url), /Token\.V2/, 'NEAR ids are normalised to lowercase');
      return network.fetchImpl(url, init);
    },
  });
  const card = plain(calls[0].body.text);
  assert.match(card, /Ⓝ NEAR · 🏪 RHEA FINANCE/);
  assert.match(card, /Route  Ref Finance · paid in NEAR/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[1].map((button) => button.callback_data), ['trade:buy:0.5', 'trade:buy:1', 'trade:buy:5']);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[1][1].text, '🟢 Buy 1 NEAR');
  assert.equal(calls[0].body.reply_markup.inline_keyboard[4][1].url, 'https://nearblocks.io/token/token.v2.ref-finance.near');
  for (const row of calls[0].body.reply_markup.inline_keyboard) {
    for (const button of row) if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
  }
});

test('long NEAR token ids use a short refresh callback that fits Telegram limits', async () => {
  const kv = createKv();
  const calls = await sendUpdate({ message: { chat: { id: 71, type: 'private' }, text: USDC } }, { ...baseEnv, TELEGRAM_STATE: kv }, createNearNetwork());
  const refresh = calls[0].body.reply_markup.inline_keyboard.flat().find((button) => button.text === '🔄 Refresh');
  assert.equal(refresh.callback_data, 'token:refresh:last');
});

test('quick buy on a NEAR token quotes on Ref Finance, then Confirm signs wrap + swap and records the trade', async () => {
  const { kv, db, env, wallet } = await custodialSetup();
  const network = createNearNetwork();
  await kv.put('telegram:72', JSON.stringify({ lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenChainType: 'NEAR', lastTokenSymbol: 'USDC', slippagePercent: 0.5 }));

  const quoteCalls = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:1', message: { message_id: 5, chat: { id: 72, type: 'private' } } } }, env, network);
  const quote = quoteCalls.at(-1);
  const quoteText = plain(quote.body.text);
  assert.match(quoteText, /You pay  1 NEAR/);
  assert.match(quoteText, /Minimum received  5\.2365 USDC/);
  assert.match(quoteText, /Route  Ref Finance · 2 hops/);
  assert.match(quoteText, /One-time token registration  0\.0025 NEAR/);
  const confirm = quote.body.reply_markup.inline_keyboard[0][0];
  assert.equal(confirm.text, '✅ Confirm swap');
  assert.equal(network.broadcasts.length, 0, 'nothing is signed before Confirm');

  const confirmCalls = await sendUpdate({ callback_query: { id: 'c', data: confirm.callback_data, message: { message_id: 6, chat: { id: 72, type: 'private' } } } }, env, network);
  assert.deepEqual(network.broadcasts.map((tx) => tx.transaction.receiverId), [USDC, WRAP_NEAR]);
  assert.deepEqual(network.broadcasts.map((tx) => tx.transaction.signerId), [wallet.near.address, wallet.near.address]);
  const swapActions = network.broadcasts[1].transaction.actions.map((action) => action.functionCall);
  assert.deepEqual(swapActions.map((call) => call.methodName), ['storage_deposit', 'near_deposit', 'ft_transfer_call']);
  const transferArgs = JSON.parse(Buffer.from(swapActions[2].args).toString());
  assert.equal(transferArgs.receiver_id, REF_EXCHANGE);
  assert.equal(JSON.parse(transferArgs.msg).actions.at(-1).min_amount_out, '5236549');

  const result = confirmCalls.at(-1);
  assert.equal(result.url.split('/').at(-1), 'editMessageText');
  assert.match(plain(result.body.text), /Swap executed/);
  assert.match(result.body.reply_markup.inline_keyboard[0][0].url, /^https:\/\/nearblocks\.io\/txns\//);
  assert.equal(db.trades.length, 1);
  assert.equal(db.trades[0][2], USDC);
  assert.equal(db.trades[0][3], String(NEAR_CHAIN_ID));

  // The quote was consumed: a second Confirm tap cannot sign again.
  const replay = await sendUpdate({ callback_query: { id: 'r', data: confirm.callback_data, message: { message_id: 6, chat: { id: 72, type: 'private' } } } }, env, network);
  assert.equal(network.broadcasts.length, 2);
  assert.match(plain(replay.at(-1).body.text), /expired/);
});

test('NEAR quick-buy amounts are only accepted for NEAR tokens', async () => {
  const { kv, env } = await custodialSetup();
  await kv.put('telegram:73', JSON.stringify({ lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenSymbol: 'USDC' }));
  const calls = await sendUpdate({ callback_query: { id: 'x', data: 'trade:buy:0.1', message: { chat: { id: 73, type: 'private' } } } }, env, createNearNetwork());
  assert.match(plain(calls.at(-1).body.text), /not available for NEAR tokens/);
});

test('/swap quotes any NEAR pair and shows usage for bad input', async () => {
  const { env } = await custodialSetup();
  const usage = await sendUpdate({ message: { chat: { id: 74, type: 'private' }, text: '/swap near' } }, env, createNearNetwork());
  assert.match(plain(usage[0].body.text), /\/swap <amount> <from> <to>/);

  const calls = await sendUpdate({ message: { chat: { id: 74, type: 'private' }, text: '/swap 1 near to usdc' } }, env, createNearNetwork());
  assert.match(plain(calls.at(-1).body.text), /Quote ready · BUY/);
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].text, '✅ Confirm swap');

  const group = await sendUpdate({ message: { chat: { id: -74, type: 'group' }, text: '/swap 1 near usdc' } }, env, createNearNetwork());
  assert.match(plain(group[0].body.text), /private chat/);
});

test('/swap refuses when the wallet cannot cover amount, storage and gas', async () => {
  const { env } = await custodialSetup();
  const network = createNearNetwork();
  const poor = {
    fetchImpl: async (url, init) => {
      if (init?.body && JSON.parse(init.body).params?.request_type === 'view_account') {
        return Response.json({ result: { amount: '1000000000000000000000000', locked: '0', storage_usage: 182 } });
      }
      return network.fetchImpl(url, init);
    },
  };
  const calls = await sendUpdate({ message: { chat: { id: 75, type: 'private' }, text: '/swap 1 near usdc' } }, env, poor);
  assert.match(plain(calls.at(-1).body.text), /Not enough NEAR/);
});

test('/setwallet near links a read-only NEAR account and /wallet near reads it', async () => {
  const kv = createKv();
  const linked = await sendUpdate({ message: { chat: { id: 76, type: 'private' }, text: '/setwallet near Alice.near' } }, { ...baseEnv, TELEGRAM_STATE: kv });
  assert.equal(JSON.parse(kv.values.get('telegram:76')).nearAddress, 'alice.near');
  assert.match(plain(linked[0].body.text), /NEAR public address linked/);

  const network = createNearNetwork();
  const balance = await sendUpdate({ message: { chat: { id: 76, type: 'private' }, text: '/wallet near alice.near' } }, { ...baseEnv }, network);
  const text = plain(balance[0].body.text);
  assert.match(text, /NEAR · alice\.near/);
  assert.match(text, /NEAR: 9\.9981 NEAR/); // 10 NEAR minus 182 bytes of storage staking
});

test('read-only NEAR quote API needs no wallet', async () => {
  const network = createNearNetwork();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = network.fetchImpl;
  try {
    const response = await worker.fetch(new Request('https://worker.example/api/trade/quote', {
      method: 'POST',
      body: JSON.stringify({ chain: 'near', tokenIn: 'near', tokenOut: 'usdc', amount: '1', slippage: 0.5 }),
    }), baseEnv, {});
    assert.equal(response.status, 200);
    const quote = await response.json();
    assert.equal(quote.execution, 'read_only');
    assert.equal(quote.minOutFormatted, '5.236549');
    assert.equal(quote.tokenOut.symbol, 'USDC');
    assert.equal(quote.tradeId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
