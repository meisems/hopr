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
            async all() {
              if (/SELECT \* FROM wallet_accounts WHERE user_id/.test(sql)) {
                return { results: [{ id: 'w1', label: 'W1', source: 'generated', is_active: 1, evm_address: wallet.evm, solana_address: wallet.solana, near_address: wallet.near.address, near_encrypted_key: wallet.nearEncrypted, default_for: null }] };
              }
              return { results: [] };
            },
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
    if (href.includes('smartrouter.ref.finance')) {
      const amountIn = new URL(href).searchParams.get('amountIn') ?? ROUTER_RESPONSE.result_data.routes[0].amount_in;
      const response = structuredClone(ROUTER_RESPONSE);
      response.result_data.routes[0].amount_in = amountIn;
      response.result_data.routes[0].pools[0].amount_in = amountIn;
      return Response.json(response);
    }
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
    if (String(url).endsWith('/sendChatAction')) return Response.json({ ok: true, result: true }); // "typing…" indicator
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
  assert.match(card, /Ⓝ NEAR · 🏪 Rhea/);
  assert.match(card, /Route  Ref Finance \/ Rhea DCL · paid in NEAR/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[1].map((button) => button.callback_data), ['trade:buy:0.5', 'trade:buy:1', 'trade:buy:5']);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[1][1].text, '🟢 Buy 1 NEAR');
  assert.equal(calls[0].body.reply_markup.inline_keyboard[5][1].url, 'https://nearblocks.io/token/token.v2.ref-finance.near');
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

test('✏️ Buy X asks for an amount and quotes exactly what the user replies', async () => {
  const { kv, env } = await custodialSetup();
  await kv.put('telegram:73', JSON.stringify({ lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenSymbol: 'USDC' }));
  const prompt = await sendUpdate({ callback_query: { id: 'x', data: 'trade:custom', message: { chat: { id: 73, type: 'private' } } } }, env, createNearNetwork());
  const promptText = prompt.at(-1).body.text;
  assert.match(promptText, /Buy X — reply with how much NEAR to spend on USDC/);
  assert.equal(prompt.at(-1).body.reply_markup.force_reply, true);

  const reply = (text) => ({ message: { chat: { id: 73, type: 'private' }, text, reply_to_message: { text: promptText, from: { is_bot: true } } } });
  const quote = await sendUpdate(reply('2.5'), env, createNearNetwork());
  assert.match(plain(quote.at(-1).body.text), /You pay  2\.5 NEAR/);
  const invalid = await sendUpdate(reply('lots'), env, createNearNetwork());
  assert.match(plain(invalid.at(-1).body.text), /Send just a number/);
});

test('with a Hopr NEAR fee account, Ref swaps take 0.75% in the same transaction as the swap', async () => {
  const { kv, env } = await custodialSetup();
  const network = createNearNetwork();
  const feeEnv = { ...env, HOPR_INTENTS_FEE_ACCOUNT: 'hopr-fees.near' };
  await kv.put('telegram:75', JSON.stringify({ lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenSymbol: 'USDC' }));
  const quote = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:1', message: { message_id: 5, chat: { id: 75, type: 'private' } } } }, feeEnv, network);
  const confirm = quote.at(-1).body.reply_markup.inline_keyboard[0][0];
  await sendUpdate({ callback_query: { id: 'c', data: confirm.callback_data, message: { message_id: 6, chat: { id: 75, type: 'private' } } } }, feeEnv, network);

  const swap = network.broadcasts.at(-1).transaction;
  assert.equal(swap.receiverId, WRAP_NEAR);
  const calls = swap.actions.map((action) => action.functionCall);
  assert.deepEqual(calls.map((call) => call.methodName), ['storage_deposit', 'near_deposit', 'storage_deposit', 'ft_transfer', 'ft_transfer_call']);
  const args = (call) => JSON.parse(Buffer.from(call.args).toString());
  assert.equal(calls[1].deposit.toString(), (10n ** 24n).toString(), 'the full 1 NEAR is wrapped');
  assert.deepEqual(args(calls[2]), { account_id: 'hopr-fees.near', registration_only: true });
  assert.equal(args(calls[3]).receiver_id, 'hopr-fees.near');
  assert.equal(args(calls[3]).amount, (75n * 10n ** 20n).toString(), '0.75% of 1 NEAR');
  assert.equal(args(calls[4]).amount, (9925n * 10n ** 20n).toString(), 'the rest is swapped');
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

test('/wallet near <account> reads a NEAR account without linking it', async () => {
  const network = createNearNetwork();
  const balance = await sendUpdate({ message: { chat: { id: 76, type: 'private' }, text: '/wallet near alice.near' } }, { ...baseEnv }, network);
  const text = plain(balance[0].body.text);
  assert.match(text, /Ⓝ NEAR\nalice\.near/);
  assert.match(text, /NEAR: 9\.9981 NEAR/); // 10 NEAR minus 182 bytes of storage staking
});

/** NEAR network plus 1Click, Solana / EVM balance RPCs and LI.FI, recording every request. */
function createIncomingNetwork() {
  const near = createNearNetwork();
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ href, body });
    if (href.endsWith('/v0/tokens')) {
      return Response.json([
        { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
        { assetId: 'nep141:hood.omft.near', blockchain: 'hood', symbol: 'ETH', decimals: 18 },
        { assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18 },
        { assetId: `nep141:${WRAP_NEAR}`, blockchain: 'near', symbol: 'wNEAR', decimals: 24, contractAddress: WRAP_NEAR },
      ]);
    }
    if (href.endsWith('/v0/quote')) return Response.json({ quote: { depositAddress: body.dry ? undefined : 'f'.repeat(64), amountOut: '5000000000000000000000000', minAmountOut: '4900000000000000000000000' } });
    if (body?.method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: 5_000_000_000 } });
    if (body?.method === 'eth_getBalance') return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${(50n * 10n ** 18n).toString(16)}` });
    if (href.includes('li.quest/v1/quote')) return Response.json({ id: 'hub', estimate: { fromAmount: '10000000', toAmount: '3000000000000000', toAmountMin: '2900000000000000' }, transactionRequest: { to: '0x1', data: '0x', value: '0x0' } });
    return near.fetchImpl(url, init);
  };
  return { broadcasts: near.broadcasts, requests, fetchImpl };
}

test('NEAR token cards offer pay-with NEAR, SOL and Robinhood ETH, with presets in the chosen coin', async () => {
  const { kv, env } = await custodialSetup();
  await kv.put('telegram:80', JSON.stringify({ lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenSymbol: 'USDC' }));
  const calls = await sendUpdate({ callback_query: { id: 'pay', data: 'token:pay:1151111081099710', message: { message_id: 3, chat: { id: 80, type: 'private' } } } }, env, createNearNetwork());
  assert.equal(JSON.parse(kv.values.get('telegram:80')).fundingChainId, 1151111081099710);
  const keyboard = calls.at(-1).body.reply_markup.inline_keyboard;
  assert.deepEqual(keyboard[1].map((button) => button.text), ['🟢 Buy 0.05 SOL', '🟢 Buy 0.1 SOL', '🟢 Buy 0.5 SOL']);
  assert.deepEqual(keyboard[3].map((button) => button.text), ['Ⓝ NEAR', '✅ ◎ SOL', '🟩 Robinhood ETH']);
  assert.match(plain(calls.at(-1).body.text), /Funding  ◎ Solana \(SOL\) · cross-chain/);
});

test('buying a NEAR token with SOL quotes NEAR Intents into NEAR, then a Ref swap', async () => {
  const { kv, env, wallet } = await custodialSetup();
  const network = createIncomingNetwork();
  await kv.put('telegram:81', JSON.stringify({ fundingChainId: 1151111081099710, lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenSymbol: 'USDC' }));
  const calls = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:0.1', message: { message_id: 5, chat: { id: 81, type: 'private' } } } }, env, network);
  const text = plain(calls.at(-1).body.text);
  assert.match(text, /You pay  0.1 SOL on Solana/);
  assert.match(text, /Step 1  SOL → ≈ 5 NEAR on NEAR · NEAR Intents/);
  assert.match(text, /Step 2  NEAR → USDC · Ref Finance/);
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].text, '✅ Confirm step 1');
  const quotes = network.requests.filter((request) => request.href.endsWith('/v0/quote')).map((request) => request.body);
  assert.deepEqual(quotes.map((quote) => quote.dry), [true, false]);
  assert.equal(quotes[1].originAsset, 'nep141:sol.omft.near');
  assert.equal(quotes[1].destinationAsset, `nep141:${WRAP_NEAR}`);
  assert.equal(quotes[1].amount, '100000000');
  assert.equal(quotes[1].recipient, wallet.near.address);
  assert.equal(quotes[1].refundTo, wallet.solana);
  assert.equal(network.broadcasts.length, 0, 'nothing is signed before Confirm');
});

test('buying a NEAR token with Robinhood ETH routes through NEAR Intents from hood', async () => {
  const { kv, env } = await custodialSetup();
  const network = createIncomingNetwork();
  await kv.put('telegram:82', JSON.stringify({ fundingChainId: 4663, lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenSymbol: 'USDC' }));
  const calls = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:0.01', message: { message_id: 5, chat: { id: 82, type: 'private' } } } }, env, network);
  assert.match(plain(calls.at(-1).body.text), /You pay  0.01 ETH on Robinhood Chain/);
  const quote = network.requests.filter((request) => request.href.endsWith('/v0/quote')).at(-1).body;
  assert.equal(quote.originAsset, 'nep141:hood.omft.near');
  assert.equal(quote.amount, '10000000000000000');
});

test('Arc, which NEAR Intents does not reach, buys NEAR tokens via a LI.FI hop to Base', async () => {
  const { kv, env } = await custodialSetup();
  const network = createIncomingNetwork();
  await kv.put('telegram:83', JSON.stringify({ fundingChainId: 5042, lastTokenAddress: USDC, lastTokenChainId: NEAR_CHAIN_ID, lastTokenSymbol: 'USDC' }));
  const calls = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:10', message: { message_id: 5, chat: { id: 83, type: 'private' } } } }, env, network);
  const text = plain(calls.at(-1).body.text);
  assert.match(text, /You pay  10 USDC on Arc Chain/);
  assert.match(text, /Step 1  USDC → ≈ 0.003 ETH on Base · LI.FI/);
  assert.match(text, /ETH → USDC on NEAR · NEAR Intents \+ Ref Finance/);
  const lifi = new URL(network.requests.find((request) => request.href.includes('li.quest/v1/quote')).href);
  assert.equal(lifi.searchParams.get('fromChain'), '5042');
  assert.equal(lifi.searchParams.get('toChain'), '8453');
  assert.equal(lifi.searchParams.get('fee'), '0.0075');
});

test('paying with NEAR for a Base token: step 1 bridges through NEAR Intents, Continue quotes step 2 with what arrived', async () => {
  const { kv, env, wallet } = await custodialSetup();
  const feeEnv = { ...env, HOPR_INTENTS_FEE_ACCOUNT: 'hopr-fees.near' };
  const DEGEN = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
  const DEPOSIT = 'd'.repeat(64);
  const near = createNearNetwork();
  const requests = [];
  let bridgeStatus = 'PENDING_DEPOSIT';
  const network = {
    broadcasts: near.broadcasts,
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ href, body });
      if (href.endsWith('/v0/tokens')) {
        return Response.json([
          { assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18 },
          { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR', decimals: 24, contractAddress: 'wrap.near' },
        ]);
      }
      if (href.endsWith('/v0/quote')) return Response.json({ quote: { depositAddress: DEPOSIT, amountOut: '2100000000000000', minAmountOut: '2050000000000000', timeEstimate: 90 } });
      if (href.endsWith('/v0/deposit/submit')) return Response.json({});
      if (href.includes('/v0/status')) return Response.json({ status: bridgeStatus, swapDetails: { amountOut: '2000000000000000' } });
      if (href.includes('mainnet.base.org')) return Response.json({ result: `0x${(2_500_000_000_000_000n).toString(16)}` });
      if (href.includes('li.quest/v1/quote')) {
        return Response.json({ id: 'q', estimate: { fromAmount: '2000000000000000', toAmount: '9000000000000000000000', toAmountMin: '8900000000000000000000', executionDuration: 20 }, transactionRequest: { to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0x', value: '0x0' } });
      }
      return near.fetchImpl(url, init);
    },
  };
  await kv.put('telegram:76', JSON.stringify({ fundingChainId: NEAR_CHAIN_ID, lastTokenAddress: DEGEN, lastTokenChainId: 8453, lastTokenChainType: 'EVM', lastTokenSymbol: 'DEGEN', slippagePercent: 1 }));

  // Step 1 quote: NEAR → ETH on Base (NEAR Intents lists ETH but not DEGEN).
  const quote = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:1.0', message: { message_id: 5, chat: { id: 76, type: 'private' } } } }, feeEnv, network);
  const quoteText = plain(quote.at(-1).body.text);
  assert.match(quoteText, /You pay  1\.0 NEAR/);
  assert.match(quoteText, /Step 1  NEAR → ≈ 0\.0021 ETH on Base · NEAR Intents/);
  assert.match(quoteText, /Step 2  ETH → DEGEN · LI\.FI/);
  const intentsRequest = requests.find((request) => request.href.endsWith('/v0/quote')).body;
  assert.equal(intentsRequest.originAsset, 'nep141:wrap.near');
  assert.equal(intentsRequest.destinationAsset, 'nep141:base.omft.near');
  assert.equal(intentsRequest.recipient, wallet.evm);
  assert.equal(intentsRequest.refundTo, wallet.near.address);
  assert.deepEqual(intentsRequest.appFees, [{ recipient: 'hopr-fees.near', fee: 75 }], 'Hopr’s fee is charged on step 1');
  const confirm = quote.at(-1).body.reply_markup.inline_keyboard[0][0];
  assert.equal(confirm.text, '✅ Confirm step 1');

  // Confirm step 1: wrap + transfer 1 NEAR to the 1Click deposit account, then offer Continue.
  const sent = await sendUpdate({ callback_query: { id: 'c', data: confirm.callback_data, message: { message_id: 6, chat: { id: 76, type: 'private' } } } }, feeEnv, network);
  const deposit = network.broadcasts.at(-1).transaction;
  assert.equal(deposit.receiverId, WRAP_NEAR);
  const calls = deposit.actions.map((action) => action.functionCall);
  assert.deepEqual(calls.map((call) => call.methodName), ['storage_deposit', 'near_deposit', 'ft_transfer']);
  assert.deepEqual(JSON.parse(Buffer.from(calls[2].args).toString()), { receiver_id: DEPOSIT, amount: (10n ** 24n).toString() });
  assert.ok(requests.some((request) => request.href.endsWith('/v0/deposit/submit')));
  assert.match(plain(sent.at(-1).body.text), /Step 1 of 2 sent/);
  const next = sent.at(-1).body.reply_markup.inline_keyboard[0][0];
  assert.match(next.callback_data, /^trade:cont:[0-9a-f]{8}$/);

  // Continue while the bridge is in flight.
  const waiting = await sendUpdate({ callback_query: { id: 'w', data: next.callback_data, message: { message_id: 7, chat: { id: 76, type: 'private' } } } }, feeEnv, network);
  assert.match(plain(waiting.at(-1).body.text), /Still bridging/);

  // Once it lands, step 2 swaps exactly what arrived (0.002 ETH), fee-free.
  bridgeStatus = 'SUCCESS';
  const step2 = await sendUpdate({ callback_query: { id: 's', data: next.callback_data, message: { message_id: 7, chat: { id: 76, type: 'private' } } } }, feeEnv, network);
  const step2Text = plain(step2.at(-1).body.text);
  assert.match(step2Text, /You pay  0\.002 ETH \(arrived from NEAR\)/);
  assert.match(step2Text, /already paid in step 1/);
  assert.equal(step2.at(-1).body.reply_markup.inline_keyboard[0][0].text, '✅ Confirm step 2');
  const lifi = new URL(requests.filter((request) => request.href.includes('li.quest/v1/quote')).at(-1).href);
  assert.equal(lifi.searchParams.get('fromAmount'), '2000000000000000');
  assert.equal(lifi.searchParams.get('fromChain'), '8453');
  assert.equal(lifi.searchParams.get('toToken'), DEGEN);
  assert.equal(lifi.searchParams.get('fee'), '0');
});

test('paying with NEAR for a BNB token falls back to ETH on Base when NEAR Intents cannot reach BNB Chain', async () => {
  const { kv, env } = await custodialSetup();
  const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
  const near = createNearNetwork();
  const requests = [];
  const network = {
    broadcasts: near.broadcasts,
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ href, body });
      if (href.endsWith('/v0/tokens')) {
        return Response.json([
          { assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18 },
          { assetId: 'nep141:bsc.omft.near', blockchain: 'bsc', symbol: 'BNB', decimals: 18 },
        ]);
      }
      if (href.endsWith('/v0/quote')) {
        return body.destinationAsset === 'nep141:bsc.omft.near'
          ? Response.json({ message: 'Temporary swap limits: minimum swap amount is $1,000' }, { status: 400 })
          : Response.json({ quote: { depositAddress: 'e'.repeat(64), amountOut: '2000000000000000', minAmountOut: '1950000000000000' } });
      }
      if (href.endsWith('/v0/deposit/submit')) return Response.json({});
      if (href.includes('/v0/status')) return Response.json({ status: 'SUCCESS', swapDetails: { amountOut: '2000000000000000' } });
      if (href.includes('mainnet.base.org')) return Response.json({ result: `0x${(3_000_000_000_000_000n).toString(16)}` });
      if (href.includes('li.quest/v1/quote')) return Response.json({ estimate: { fromAmount: '2000000000000000', toAmount: '1', toAmountMin: '1' }, transactionRequest: { to: '0x1', data: '0x', value: '0x0' } });
      return near.fetchImpl(url, init);
    },
  };
  await kv.put('telegram:77', JSON.stringify({ fundingChainId: NEAR_CHAIN_ID, lastTokenAddress: CAKE, lastTokenChainId: 56, lastTokenChainType: 'EVM', lastTokenSymbol: 'CAKE' }));
  const quote = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:1.0', message: { message_id: 5, chat: { id: 77, type: 'private' } } } }, env, network);
  assert.match(plain(quote.at(-1).body.text), /Step 1  NEAR → ≈ 0\.002 ETH on Base · NEAR Intents/);
  assert.match(plain(quote.at(-1).body.text), /Step 2  ETH → CAKE on BNB Chain · LI\.FI/);
  const confirm = quote.at(-1).body.reply_markup.inline_keyboard[0][0];
  const sent = await sendUpdate({ callback_query: { id: 'c', data: confirm.callback_data, message: { message_id: 6, chat: { id: 77, type: 'private' } } } }, env, network);
  const next = sent.at(-1).body.reply_markup.inline_keyboard[0][0];
  const step2 = await sendUpdate({ callback_query: { id: 's', data: next.callback_data, message: { message_id: 7, chat: { id: 77, type: 'private' } } } }, env, network);
  assert.match(plain(step2.at(-1).body.text), /Route  Base → BNB Chain · LI\.FI/);
  const lifi = new URL(requests.filter((request) => request.href.includes('li.quest/v1/quote')).at(-1).href);
  assert.equal(lifi.searchParams.get('fromChain'), '8453');
  assert.equal(lifi.searchParams.get('toChain'), '56');
  assert.equal(lifi.searchParams.get('toToken'), CAKE);
});

test('NEAR-funded launchpad buy refuses the bridge when the final token has no route', async () => {
  const { kv, env } = await custodialSetup();
  const near = createNearNetwork();
  await kv.put('telegram:79', JSON.stringify({ fundingChainId: NEAR_CHAIN_ID, lastTokenAddress: '0x' + '8'.repeat(40), lastTokenChainId: 8453, lastTokenSymbol: 'NEW' }));
  const network = { broadcasts: near.broadcasts, fetchImpl: async (url, init = {}) => {
    const href = String(url);
    if (href.endsWith('/v0/tokens')) return Response.json([{ assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18 }]);
    if (href.endsWith('/v0/quote')) return Response.json({ quote: { depositAddress: 'd'.repeat(64), amountOut: '2100000000000000', minAmountOut: '2050000000000000' } });
    if (href.includes('li.quest/v1/quote')) return Response.json({ message: 'No route' }, { status: 404 });
    return near.fetchImpl(url, init);
  }};
  const calls = await sendUpdate({ callback_query: { id: 'blocked-route', data: 'trade:buy:1', message: { message_id: 2, chat: { id: 79, type: 'private' } } } }, env, network);
  assert.match(plain(calls.at(-1).body.text), /final token swap could not be quoted/);
  assert.equal(near.broadcasts.length, 0);
  assert.ok(!calls.at(-1).body.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data?.startsWith('trade:confirm:')));
});

test('paying 0.1 NEAR for a Solana token: SOL already in the wallet covers gas; an empty wallet is told the minimum', async () => {
  const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const solanaNetwork = (lamports, tokenAccounts = 0) => {
    const near = createNearNetwork();
    return {
      broadcasts: near.broadcasts,
      fetchImpl: async (url, init = {}) => {
        const href = String(url);
        const body = init.body ? JSON.parse(init.body) : undefined;
        if (href.endsWith('/v0/tokens')) {
          return Response.json([
            { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9 },
            { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR', decimals: 24, contractAddress: 'wrap.near' },
          ]);
        }
        // 0.1 NEAR delivers ~0.0017 SOL: less than the 0.005 SOL the final swap keeps for gas and rent.
        if (href.endsWith('/v0/quote')) return Response.json({ quote: { depositAddress: 'e'.repeat(64), amountOut: '1750000', minAmountOut: '1700000', timeEstimate: 60 } });
        if (body?.method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: lamports } });
        if (body?.method === 'getTokenAccountsByOwner') return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: Array.from({ length: tokenAccounts }, () => ({ pubkey: 'x' })) } });
        if (href.includes('li.quest/v1/quote')) {
          return Response.json({ id: 'q', estimate: { fromAmount: '1700000', toAmount: '90000000', toAmountMin: '89000000', executionDuration: 20 }, transactionRequest: { data: 'AQ==' } });
        }
        return near.fetchImpl(url, init);
      },
    };
  };
  const profile = JSON.stringify({ fundingChainId: NEAR_CHAIN_ID, lastTokenAddress: BONK, lastTokenChainId: 1151111081099710, lastTokenChainType: 'SVM', lastTokenSymbol: 'BONK', slippagePercent: 1 });

  const empty = await custodialSetup();
  await empty.kv.put('telegram:90', profile);
  const refused = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:0.1', message: { message_id: 5, chat: { id: 90, type: 'private' } } } }, empty.env, solanaNetwork(0));
  const reason = plain(refused.at(-1).body.text);
  assert.match(reason, /Too small for this route/);
  // Fee + temporary wrapped-SOL account + the new BONK account: 0.0041 SOL, not a blanket 0.005.
  assert.match(reason, /needs about 0\.0041 SOL for gas and the token account/);
  assert.match(reason, /Buy with at least 0\.36\d* NEAR/);
  assert.match(reason, /No funds were moved/);

  const holder = await custodialSetup();
  await holder.kv.put('telegram:92', profile);
  const smaller = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:0.1', message: { message_id: 5, chat: { id: 92, type: 'private' } } } }, holder.env, solanaNetwork(0, 1));
  assert.match(plain(smaller.at(-1).body.text), /needs about 0\.0021 SOL[\s\S]*at least 0\.1\d* NEAR/, 'an existing BONK account halves the minimum');

  const funded = await custodialSetup();
  await funded.kv.put('telegram:91', profile);
  const quoted = await sendUpdate({ callback_query: { id: 'q', data: 'trade:buy:0.1', message: { message_id: 5, chat: { id: 91, type: 'private' } } } }, funded.env, solanaNetwork(10_000_000));
  assert.equal(quoted.at(-1).body.reply_markup.inline_keyboard[0][0].text, '✅ Confirm step 1', 'held SOL pays the gas, so 0.1 NEAR goes through');
});
