import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const workerSource = await readFile(new URL('../workers/index.ts', import.meta.url), 'utf8');
const workerJavaScript = ts.transpileModule(workerSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerJavaScript).toString('base64')}`);
const worker = workerModule.default;
const env = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret' };

function createKv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    values,
  };
}

async function sendUpdate(update, { method = 'POST', secret = env.TELEGRAM_WEBHOOK_SECRET, extraEnv = {}, externalFetch } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).includes('api.telegram.org')) {
      if (externalFetch) return externalFetch(url, init);
      throw new Error(`Unexpected external request: ${url}`);
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, ...init, body });
    return Response.json({ ok: true, result: true });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method,
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
      body: method === 'POST' ? JSON.stringify(update) : undefined,
    }), { ...env, ...extraEnv }, {});
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('help command lists working commands and shows navigation buttons', async () => {
  const { response, calls } = await sendUpdate({
    message: { chat: { id: 321 }, text: '/help@HoprBot' },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/sendMessage'), true);
  assert.equal(calls[0].body.chat_id, 321);
  assert.match(calls[0].body.text, /setwallet <evm\|solana>/);
  assert.match(calls[0].body.text, /does not sign or submit trades/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, [
    [
      { text: 'Wallet', callback_data: 'wallet' },
      { text: 'Settings', callback_data: 'settings' },
    ],
    [
      { text: 'Link wallet', callback_data: 'wallet:link' },
      { text: 'Help', callback_data: 'help' },
    ],
  ]);
});

test('private /setwallet stores an EVM address and confirms read-only use', async () => {
  const kv = createKv();
  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const { calls } = await sendUpdate({ message: { chat: { id: 456, type: 'private' }, text: `/setwallet evm ${address}` } }, {
    extraEnv: { TELEGRAM_STATE: kv },
  });
  assert.equal(JSON.parse(kv.values.get('telegram:456')).evmAddress, address);
  assert.match(calls[0].body.text, /Only native balances are read/);
});

test('Link wallet buttons prompt for a public address and save the private reply', async () => {
  const kv = createKv();
  const extraEnv = { TELEGRAM_STATE: kv };
  const chooseNetwork = await sendUpdate({
    callback_query: { id: 'link-1', data: 'wallet:link', message: { chat: { id: 812, type: 'private' } } },
  }, { extraEnv });
  assert.deepEqual(chooseNetwork.calls.at(-1).body.reply_markup.inline_keyboard, [
    [
      { text: 'Link EVM', callback_data: 'wallet:set:evm' },
      { text: 'Link Solana', callback_data: 'wallet:set:solana' },
    ],
    [{ text: 'Help', callback_data: 'help' }],
  ]);

  const prompt = await sendUpdate({
    callback_query: { id: 'link-2', data: 'wallet:set:evm', message: { chat: { id: 812, type: 'private' } } },
  }, { extraEnv });
  assert.equal(prompt.calls.at(-1).body.reply_markup.force_reply, true);
  assert.equal(prompt.calls.at(-1).body.reply_markup.input_field_placeholder, 'Public EVM address only');

  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const saved = await sendUpdate({
    message: {
      chat: { id: 812, type: 'private' },
      text: address,
      reply_to_message: { text: 'Reply to this message with a public EVM address only.', from: { is_bot: true } },
    },
  }, { extraEnv });
  assert.equal(JSON.parse(kv.values.get('telegram:812')).evmAddress, address);
  assert.match(saved.calls[0].body.text, /EVM public address linked/);
});

test('Link wallet explains that persistent setup is required when KV is absent', async () => {
  const { calls } = await sendUpdate({
    callback_query: { id: 'link-3', data: 'wallet:link', message: { chat: { id: 813, type: 'private' } } },
  });
  assert.match(calls.at(-1).body.text, /TELEGRAM_STATE/);
});

test('wallet command reads EVM and Solana native balances', async () => {
  const kv = createKv();
  await kv.put('telegram:456', JSON.stringify({
    evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
    solanaAddress: '11111111111111111111111111111111',
  }));
  const { calls } = await sendUpdate({ message: { chat: { id: 456, type: 'private' }, text: '/wallet' } }, {
    extraEnv: { TELEGRAM_STATE: kv },
    externalFetch: async (url) => {
      if (String(url).includes('solana.com')) return Response.json({ result: { value: 2500000000 } });
      return Response.json({ result: '0x38d7ea4c68000' });
    },
  });
  assert.match(calls.at(-1).body.text, /Solana .*: 2\.50000 SOL/);
  assert.match(calls.at(-1).body.text, /Base: 0\.00100 ETH/);
  assert.match(calls.at(-1).body.text, /Arbitrum One: 0\.00100 ETH/);
});

test('/wallet <address> reads balances without requiring saved profile storage', async () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const { calls } = await sendUpdate({ message: { chat: { id: 459, type: 'private' }, text: `/wallet ${address}` } }, {
    externalFetch: async () => Response.json({ result: '0x38d7ea4c68000' }),
  });
  assert.match(calls[0].body.text, /EVM 0x1234…5678/);
  assert.match(calls[0].body.text, /Base: 0\.00100 ETH/);
});

test('token address gets real market lookup details from DexScreener', async () => {
  const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const { calls } = await sendUpdate({ message: { chat: { id: 321 }, text: address } }, {
    externalFetch: async (url) => {
      assert.match(String(url), /api\.dexscreener\.com\/latest\/dex\/tokens/);
      return Response.json({ pairs: [{
        chainId: 'base',
        baseToken: { name: 'Example Token', symbol: 'EX' },
        priceUsd: '1.25',
        liquidity: { usd: 42000 },
        fdv: 500000,
        priceChange: { h24: 3.5 },
      }] });
    },
  });
  assert.match(calls[0].body.text, /EX — Example Token/);
  assert.match(calls[0].body.text, /Base/);
  assert.match(calls[0].body.text, /24h: \+3\.50%/);
  assert.match(calls[0].body.text, /does not execute trades/);
});

test('settings buttons persist funding-chain and slippage preferences', async () => {
  const kv = createKv();
  const first = await sendUpdate({
    callback_query: { id: 'callback-1', data: 'settings:chain:8453', message: { chat: { id: 777, type: 'private' } } },
  }, { extraEnv: { TELEGRAM_STATE: kv } });
  assert.deepEqual(JSON.parse(kv.values.get('telegram:777')), { fundingChainId: 8453 });
  assert.match(first.calls.at(-1).body.text, /Funding chain: Base/);
  assert.equal(first.calls.at(-1).body.reply_markup.inline_keyboard.length, 5);

  const second = await sendUpdate({
    callback_query: { id: 'callback-2', data: 'settings:slippage:3', message: { chat: { id: 777, type: 'private' } } },
  }, { extraEnv: { TELEGRAM_STATE: kv } });
  assert.deepEqual(JSON.parse(kv.values.get('telegram:777')), { fundingChainId: 8453, slippagePercent: 3 });
  assert.match(second.calls.at(-1).body.text, /Slippage preference: 3%/);
});

test('settings command explains persistence requirement when KV is not bound', async () => {
  const { calls } = await sendUpdate({ message: { chat: { id: 111, type: 'private' }, text: '/settings' } });
  assert.match(calls[0].body.text, /TELEGRAM_STATE/);
});

test('rejects wallet linking in group chats to avoid exposing addresses', async () => {
  const kv = createKv();
  const { calls } = await sendUpdate({ message: { chat: { id: -42, type: 'group' }, text: '/setwallet evm 0x1234567890abcdef1234567890abcdef12345678' } }, {
    extraEnv: { TELEGRAM_STATE: kv },
  });
  assert.match(calls[0].body.text, /only in a private chat/);
  assert.equal(kv.values.size, 0);
});

test('blocks wallet balance queries in group chats', async () => {
  const { calls } = await sendUpdate({
    message: { chat: { id: -48, type: 'group' }, text: '/wallet 0x1234567890abcdef1234567890abcdef12345678' },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /check wallet balances in a private chat/);
});

test('blocks the inline Link wallet button in group chats', async () => {
  const { calls } = await sendUpdate({
    callback_query: { id: 'link-group', data: 'wallet:link', message: { chat: { id: -49, type: 'group' } } },
  }, { extraEnv: { TELEGRAM_STATE: createKv() } });
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), ['answerCallbackQuery', 'sendMessage']);
  assert.match(calls.at(-1).body.text, /in a private chat/);
});

test('inline Settings button is answered and shows selectable options', async () => {
  const kv = createKv();
  const { response, calls } = await sendUpdate({
    callback_query: { id: 'callback-3', data: 'settings', message: { chat: { id: 456, type: 'private' } } },
  }, { extraEnv: { TELEGRAM_STATE: kv } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), ['answerCallbackQuery', 'sendMessage']);
  assert.match(calls[1].body.text, /Your trade preferences/);
});

test('rejects an incorrect webhook secret without calling Telegram', async () => {
  const { response, calls } = await sendUpdate(
    { message: { chat: { id: 321 }, text: '/start' } },
    { secret: 'wrong-secret' },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test('rejects non-POST webhook methods', async () => {
  const { response, calls } = await sendUpdate({}, { method: 'GET' });
  assert.equal(response.status, 405);
  assert.deepEqual(calls, []);
});

test('ignores unknown inline callback actions safely', async () => {
  const { response, calls } = await sendUpdate({
    callback_query: { id: 'callback-4', data: 'trade:buy', message: { chat: { id: 789 } } },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/answerCallbackQuery'), true);
  assert.equal(calls[0].body.show_alert, true);
  assert.equal(calls[0].body.text, 'This button is no longer available.');
});

test('trade API placeholders reject buy, sell, and status instead of reporting mock success', async () => {
  const requests = [
    new Request('https://worker.example/api/trade/buy', { method: 'POST', body: JSON.stringify({ userId: 'u', tokenAddress: '0x1', amount: '1' }) }),
    new Request('https://worker.example/api/trade/sell', { method: 'POST', body: JSON.stringify({ userId: 'u', tokenAddress: '0x1', percentage: 100 }) }),
    new Request('https://worker.example/api/trade/example-id/status'),
  ];
  const responses = await Promise.all(requests.map((request) => worker.fetch(request, env, {})));
  assert.deepEqual(responses.map((response) => response.status), [501, 501, 501]);
  for (const response of responses) {
    const data = await response.json();
    assert.equal(data.code, 'TRADE_EXECUTION_UNAVAILABLE');
    assert.match(data.error, /not implemented/);
  }
});
