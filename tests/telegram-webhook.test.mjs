import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/index.ts';
const env = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret' };

/** Bot messages are HTML; assert on what the user actually reads. */
function plain(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function createKv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    values,
  };
}

function createD1() {
  const rows = new Map();
  return {
    prepare() {
      return {
        bind(...params) {
          return {
            async first() {
              const row = rows.get(params[0]);
              return row ? { ...row } : null;
            },
            async run() {
              rows.set(params[0], {
                evm_address: params[1], solana_address: params[2], funding_chain_id: params[3], slippage_percent: params[4],
                last_token_address: params[5], last_token_chain_id: params[6], last_token_chain_type: params[7], last_token_symbol: params[8],
              });
              return { success: true };
            },
          };
        },
      };
    },
    rows,
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
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.match(plain(calls[0].body.text), /setwallet <evm\|solana\|near>/);
  assert.match(plain(calls[0].body.text), /\/swap <amount> <from> <to>/);
  assert.match(plain(calls[0].body.text), /Confirm and submit button signs and submits/);
  assert.match(calls[0].body.text, /├ .*\n└ /, 'sections render as ├/└ trees');
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, [
    [
      { text: '🛒 Buy & Sell', callback_data: 'trade:start' },
      { text: '📊 Positions', callback_data: 'positions' },
    ],
    [
      { text: '💳 Wallets', callback_data: 'wallet' },
      { text: '⚙️ Settings', callback_data: 'settings' },
    ],
    [
      { text: '🎁 Refer & Earn', callback_data: 'referral' },
      { text: '🔗 Link wallet', callback_data: 'wallet:link' },
      { text: '❓ Help', callback_data: 'help' },
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
      { text: '🔗 Link EVM (read-only)', callback_data: 'wallet:set:evm' },
      { text: '🔗 Link Solana (read-only)', callback_data: 'wallet:set:solana' },
    ],
    [{ text: '🔗 Link NEAR (read-only)', callback_data: 'wallet:set:near' }],
    [{ text: '📦 Create trading wallet', callback_data: 'wallet:generate' }],
    [{ text: '📥 Import private key', callback_data: 'wallet:import' }],
    [{ text: '❓ Help', callback_data: 'help' }, { text: '◀️ Menu', callback_data: 'menu' }],
  ]);

  const prompt = await sendUpdate({
    callback_query: { id: 'link-2', data: 'wallet:set:evm', message: { chat: { id: 812, type: 'private' } } },
  }, { extraEnv });
  assert.equal(prompt.calls.at(-1).body.reply_markup.force_reply, true);
  assert.equal(prompt.calls.at(-1).body.reply_markup.input_field_placeholder, 'Public EVM address only');
  assert.equal(prompt.calls.at(-1).body.parse_mode, undefined);

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
  assert.match(calls.at(-1).body.text, /<b>Solana<\/b>: 2\.5 <code>SOL<\/code>/);
  assert.match(calls.at(-1).body.text, /<b>Base<\/b>: 0\.001 <code>ETH<\/code>/);
  assert.match(calls.at(-1).body.text, /<b>Arbitrum One<\/b>: 0\.001 <code>ETH<\/code>/);
  assert.match(plain(calls.at(-1).body.text), /Linked wallet · read-only/);
});

test('/wallet <address> reads balances without requiring saved profile storage', async () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const { calls } = await sendUpdate({ message: { chat: { id: 459, type: 'private' }, text: `/wallet ${address}` } }, {
    externalFetch: async () => Response.json({ result: '0x38d7ea4c68000' }),
  });
  assert.match(calls[0].body.text, /<b>EVM<\/b> · <code>0x1234567890abcdef1234567890abcdef12345678<\/code>/);
  assert.match(calls[0].body.text, /<b>Base<\/b>: 0\.001 <code>ETH<\/code>/);
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
  const card = plain(calls[0].body.text);
  assert.match(card, /EX  \|  Example Token/);
  assert.match(card, /Base/);
  assert.match(card, /Price  \$1\.25/);
  assert.match(card, /24h  🟢 \+3\.50%/);
  assert.match(card, /Liquidity  \$42\.0K 🟡 moderate/);
  assert.match(card, /Funding  🔷 Base \(ETH\)/);
  assert.match(card, /no transaction was submitted/);
  const keyboard = calls[0].body.reply_markup.inline_keyboard;
  assert.deepEqual(keyboard[0].map((button) => button.text), ['🔄 Refresh', '✖️ Close']);
  assert.deepEqual(keyboard[1], [
    { text: '🟢 Buy 0.1 ETH', callback_data: 'trade:buy:0.1' },
    { text: '🟢 Buy 0.5 ETH', callback_data: 'trade:buy:0.5' },
    { text: '🟢 Buy 1.0 ETH', callback_data: 'trade:buy:1.0' },
  ]);
  assert.deepEqual(keyboard[3].map((button) => button.text), ['✏️ Buy X', '⛓ Base', '🎚 Slip 1%']);
  assert.equal(keyboard[4][1].url, 'https://basescan.org/token/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
});

test('dashboard-style trade callbacks require a stored token context before quoting', async () => {
  const { calls } = await sendUpdate({
    callback_query: { id: 'trade-preview', data: 'trade:buy:0.5', message: { chat: { id: 322, type: 'private' } } },
  });
  assert.match(calls.at(-1).body.text, /Open a token lookup first/);
});

test('D1-backed Telegram profiles persist when KV is absent', async () => {
  const db = createD1();
  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const { calls } = await sendUpdate({ message: { chat: { id: 900, type: 'private' }, text: `/setwallet evm ${address}` } }, {
    extraEnv: { DB: db },
  });
  assert.equal(db.rows.get(900).evm_address, address);
  assert.match(calls[0].body.text, /EVM public address linked/);
});

test('website/API quote path forwards requests to LI.FI with the server-side key', async () => {
  let lifiRequest;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    lifiRequest = { url: String(url), headers: init.headers };
    return Response.json({ estimate: { toAmount: '12345', executionDuration: 120 }, transactionRequest: { to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0x0', chainId: 8453 } });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/api/trade/quote', {
      method: 'POST',
      body: JSON.stringify({ fromAddress: '0x1234567890abcdef1234567890abcdef12345678', tokenAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', toChainId: 8453, amount: '0.1', fundingChain: '42161', slippage: 1 }),
    }), { ...env, LIFI_API_KEY: 'server-key' }, {});
    assert.equal(response.status, 200);
    const quoteResponse = await response.json();
    assert.equal(quoteResponse.execution, 'wallet_confirmation');
    assert.equal(quoteResponse.platformFeePercent, 0.5);
    assert.match(lifiRequest.url, /fromAmount=100000000000000000/);
    assert.match(lifiRequest.url, /integrator=hopr/);
    assert.match(lifiRequest.url, /fee=0\.005/);
    assert.equal(lifiRequest.headers['x-lifi-api-key'], 'server-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings buttons persist funding-chain and slippage preferences', async () => {
  const kv = createKv();
  const first = await sendUpdate({
    callback_query: { id: 'callback-1', data: 'settings:chain:8453', message: { chat: { id: 777, type: 'private' } } },
  }, { extraEnv: { TELEGRAM_STATE: kv } });
  assert.deepEqual(JSON.parse(kv.values.get('telegram:777')), { fundingChainId: 8453 });
  assert.match(plain(first.calls.at(-1).body.text), /Funding chain: Base/);
  assert.equal(first.calls.at(-1).body.reply_markup.inline_keyboard.length, 6); // 7 funding chains (incl. NEAR) + slippage + nav
  assert.deepEqual(first.calls.at(-1).body.reply_markup.inline_keyboard[1][0], { text: '✅ Base', callback_data: 'settings:chain:8453' });

  const second = await sendUpdate({
    callback_query: { id: 'callback-2', data: 'settings:slippage:3', message: { chat: { id: 777, type: 'private' } } },
  }, { extraEnv: { TELEGRAM_STATE: kv } });
  assert.deepEqual(JSON.parse(kv.values.get('telegram:777')), { fundingChainId: 8453, slippagePercent: 3 });
  assert.match(plain(second.calls.at(-1).body.text), /Slippage preference: 3%/);
  assert.deepEqual(second.calls.at(-1).body.reply_markup.inline_keyboard[4][2], { text: '✅ 3%', callback_data: 'settings:slippage:3' });
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
  assert.match(calls.at(-1).body.text, /Your Telegram trade preferences/);
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

test('menu taps edit the tapped panel in place instead of sending a new message', async () => {
  const kv = createKv();
  const { calls } = await sendUpdate({
    callback_query: { id: 'panel-1', data: 'settings', message: { message_id: 55, chat: { id: 456, type: 'private' } } },
  }, { extraEnv: { TELEGRAM_STATE: kv } });
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), ['answerCallbackQuery', 'editMessageText']);
  assert.equal(calls[1].body.message_id, 55);
  assert.equal(calls[1].body.parse_mode, 'HTML');
  assert.match(plain(calls[1].body.text), /Your Telegram trade preferences/);
});

test('setting taps answer with a confirmation toast', async () => {
  const { calls } = await sendUpdate({
    callback_query: { id: 'toast-1', data: 'settings:slippage:5', message: { message_id: 56, chat: { id: 457, type: 'private' } } },
  }, { extraEnv: { TELEGRAM_STATE: createKv() } });
  assert.equal(calls[0].url.endsWith('/answerCallbackQuery'), true);
  assert.equal(calls[0].body.text, 'Slippage set to 5%');
});

test('Close button removes the token card', async () => {
  const { calls } = await sendUpdate({
    callback_query: { id: 'close-1', data: 'dismiss', message: { message_id: 77, chat: { id: 458, type: 'private' } } },
  });
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), ['answerCallbackQuery', 'deleteMessage']);
  assert.equal(calls[1].body.message_id, 77);
});

test('/start greets the user by name and escapes it', async () => {
  const { calls } = await sendUpdate({ message: { chat: { id: 459, type: 'private' }, from: { first_name: 'Ada <b>' }, text: '/start' } });
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.match(calls[0].body.text, /Welcome to Hopr, Ada &lt;b&gt;/);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'trade:start');
  assert.match(plain(calls[0].body.text), /No trading wallet yet/);
});

test('Mini App button leads the main menu when configured', async () => {
  const { calls } = await sendUpdate({ message: { chat: { id: 460 }, text: '/menu' } }, {
    extraEnv: { TELEGRAM_MINI_APP_URL: 'https://hopr.example/' },
  });
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard.at(-1), [{ text: '🚀 Open Hopr App', web_app: { url: 'https://hopr.example/' } }]);
});

test('token names from market data are HTML-escaped and prices formatted', async () => {
  const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabce';
  const { calls } = await sendUpdate({ message: { chat: { id: 461 }, text: address } }, {
    externalFetch: async () => Response.json({ pairs: [{
      chainId: 'base',
      baseToken: { name: '<script>', symbol: 'A&B' },
      priceUsd: '0.00001234',
      liquidity: { usd: 500 },
      fdv: 1234567,
      priceChange: { h24: -1.5 },
    }] }),
  });
  assert.match(calls[0].body.text, /A&amp;B  \|  &lt;script&gt;/);
  const card = plain(calls[0].body.text);
  assert.match(card, /Price  \$0\.0₄1234/);
  assert.match(card, /24h  🔴 −1\.50%/);
  assert.match(card, /FDV  \$1\.23M/);
  assert.match(card, /🔴 thin/);
});

test('token card shows Maestro-style timeframes, txns and pair age when DexScreener has them', async () => {
  const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcf';
  const { calls } = await sendUpdate({ message: { chat: { id: 470 }, text: address } }, {
    externalFetch: async () => Response.json({ pairs: [{
      chainId: 'base', dexId: 'uniswap',
      baseToken: { address, name: 'Example', symbol: 'EX' },
      priceUsd: '2', liquidity: { usd: 300000 }, fdv: 2000000,
      priceChange: { m5: 0.4, h1: -1.25, h6: 3, h24: 12.5 },
      txns: { h24: { buys: 1200, sells: 800 } },
      pairCreatedAt: Date.now() - 3 * 24 * 3600 * 1000,
    }] }),
  });
  const card = plain(calls[0].body.text);
  assert.match(card, /🌱 3d · 🔁 2\.0K txns \(🟢1\.2K 🔴800\)/);
  assert.match(card, /5m 🟢\+0\.4% · 1h 🔴−1\.3% · 6h 🟢\+3\.0% · 24h 🟢\+12\.5%/);
  assert.match(card, /🏪 UNISWAP/);
});

test('Buy & Sell asks for a token address with a focused reply box', async () => {
  const { calls } = await sendUpdate({ callback_query: { id: 'bs', data: 'trade:start', message: { message_id: 3, chat: { id: 471, type: 'private' } } } });
  const prompt = calls.at(-1);
  assert.equal(prompt.url.split('/').at(-1), 'sendMessage');
  assert.equal(prompt.body.reply_markup.force_reply, true);
  assert.match(prompt.body.text, /token contract address/);
});

test('Positions lists open trades with live prices and buttons to reopen them', async () => {
  const token = '0xabcdefabcdefabcdefabcdefabcdefabcdefab00';
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              assert.match(sql, /FROM user_trades/);
              return { results: [{ target_token_address: token, target_chain_id: '8453', funding_chain_id: '8453', funding_token_address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', funding_amount: '500000000000000000', created_at: '2024-01-01 00:00:00' }] };
            },
            async first() { return null; },
            async run() { return { success: true }; },
          };
        },
      };
    },
  };
  const { calls } = await sendUpdate({ callback_query: { id: 'p', data: 'positions', message: { message_id: 9, chat: { id: 472, type: 'private' } } } }, {
    extraEnv: { DB: db },
    externalFetch: async () => Response.json({ pairs: [{ chainId: 'base', baseToken: { address: token, name: 'Pos Token', symbol: 'POS' }, priceUsd: '0.5', liquidity: { usd: 1 }, priceChange: { h24: -2 } }] }),
  });
  const panel = calls.at(-1);
  assert.equal(panel.url.split('/').at(-1), 'editMessageText');
  const text = plain(panel.body.text);
  assert.match(text, /1\. POS · 🔷/);
  assert.match(text, /Entry  0\.5 ETH/);
  assert.match(text, /Price  \$0\.5 · 24h 🔴−2\.0%/);
  assert.deepEqual(panel.body.reply_markup.inline_keyboard[0], [{ text: '📈 POS', callback_data: `token:refresh:${token}` }]);
});

test('Positions stay private in group chats', async () => {
  const { calls } = await sendUpdate({ callback_query: { id: 'pg', data: 'positions', message: { chat: { id: -473, type: 'group' } } } });
  assert.match(calls.at(-1).body.text, /private chat/);
});

