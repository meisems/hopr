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

async function sendUpdate(update, { method = 'POST', secret = env.TELEGRAM_WEBHOOK_SECRET, extraEnv = {}, externalFetch, ctx = {} } = {}) {
  const calls = [];
  const chatActions = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).includes('api.telegram.org')) {
      if (externalFetch) return externalFetch(url, init);
      throw new Error(`Unexpected external request: ${url}`);
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    // "typing…" indicators are not messages; tests assert on them separately.
    (String(url).endsWith('/sendChatAction') ? chatActions : calls).push({ url, ...init, body });
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
    }), { ...env, ...extraEnv }, ctx);
    await ctx.settled?.();
    return { response, calls, chatActions };
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
  assert.doesNotMatch(plain(calls[0].body.text), /setwallet|link a public/i);
  assert.match(plain(calls[0].body.text), /create, switch, import or delete up to 10 wallets/);
  assert.match(plain(calls[0].body.text), /Pay from any chain/);
  assert.match(plain(calls[0].body.text), /\/swap <amount> <from> <to>/);
  assert.match(plain(calls[0].body.text), /Confirm and submit button signs and submits/);
  assert.match(calls[0].body.text, /├ .*\n└ /, 'sections render as ├/└ trees');
  assert.match(plain(calls[0].body.text), /\/portfolio — every token you hold on all 7 chains/);
  assert.doesNotMatch(plain(calls[0].body.text), /Mini App|\/app/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, [
    [
      { text: '🟢 Buy', callback_data: 'trade:start' },
      { text: '🔴 Sell', callback_data: 'positions' },
    ],
    [
      { text: '💼 Portfolio', callback_data: 'positions' },
      { text: '💳 Wallets', callback_data: 'wallet' },
    ],
    [
      { text: '📡 Launch radar', callback_data: 'pools' },
      { text: '⚙️ Settings', callback_data: 'settings' },
    ],
    [
      { text: '🎁 Refer & Earn', callback_data: 'referral' },
      { text: '❓ Help', callback_data: 'help' },
    ],
    [{ text: '🔄 Refresh', callback_data: 'menu' }],
  ]);
});

test('/pools and its inline filters use the shared feed, escape metadata and fit callback limits', async () => {
  const kv = createKv();
  await kv.put('launchpads:v1:argus', JSON.stringify({ source: 'argus', stale: false, partial: false, observedAt: Date.now(), coverage: 'Indexed pools',
    pools: [{ id: '5042:pool', source: 'argus', chainId: 5042, tokenAddress: '0x' + '1'.repeat(40), symbol: '<ARGUS>', quoteSymbol: 'USDC', liquidityUsd: 1234, volume24h: null }] }));
  const { calls } = await sendUpdate({ message: { chat: { id: 820, type: 'private' }, text: '/pools argus' } }, { extraEnv: { CACHE: kv } });
  const panel = calls.at(-1).body;
  assert.match(panel.text, /&lt;ARGUS&gt;/); assert.match(panel.text, /Not indexed/);
  assert.ok(panel.reply_markup.inline_keyboard.flat().every((b) => Buffer.byteLength(b.callback_data ?? '') <= 64));
  const callback = await sendUpdate({ callback_query: { id: 'pad-filter', data: 'pools:argus', message: { message_id: 4, chat: { id: 820, type: 'private' } } } }, { extraEnv: { CACHE: kv } });
  assert.match(callback.calls.at(-1).url, /editMessageText/);
  assert.match(callback.calls.at(-1).body.text, /Launch radar/);
});

test('/setwallet no longer links read-only wallets and points to create/import', async () => {
  const kv = createKv();
  const address = '0x1234567890abcdef1234567890abcdef12345678';
  const { calls } = await sendUpdate({ message: { chat: { id: 456, type: 'private' }, text: `/setwallet evm ${address}` } }, {
    extraEnv: { TELEGRAM_STATE: kv },
  });
  assert.equal(kv.values.size, 0);
  assert.match(plain(calls[0].body.text), /Wallet linking was removed/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[0].map((button) => button.callback_data), ['wallet:generate', 'wallet:import']);
});

test('old Link wallet buttons are no longer available', async () => {
  for (const data of ['wallet:link', 'wallet:set:evm']) {
    const { calls } = await sendUpdate({
      callback_query: { id: 'link-old', data, message: { chat: { id: 812, type: 'private' } } },
    }, { extraEnv: { TELEGRAM_STATE: createKv() } });
    assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), ['answerCallbackQuery']);
    assert.equal(calls[0].body.text, 'This button is no longer available.');
  }
});

test('/wallet without a Hopr wallet offers create or import, never linking', async () => {
  const kv = createKv();
  await kv.put('telegram:456', JSON.stringify({ evmAddress: '0x1234567890abcdef1234567890abcdef12345678' }));
  const { calls } = await sendUpdate({ message: { chat: { id: 456, type: 'private' }, text: '/wallet' } }, { extraEnv: { TELEGRAM_STATE: kv } });
  assert.match(plain(calls.at(-1).body.text), /No wallet yet/);
  assert.match(plain(calls.at(-1).body.text), /up to 10 wallets/);
  assert.doesNotMatch(plain(calls.at(-1).body.text), /read-only|Link/);
  assert.deepEqual(calls.at(-1).body.reply_markup.inline_keyboard[0].map((button) => button.callback_data), ['wallet:generate', 'wallet:import']);
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
        baseToken: { address, name: 'Example Token', symbol: 'EX' },
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
  assert.deepEqual(keyboard[3].map((button) => button.callback_data), ['token:pay:397', 'token:pay:1151111081099710', 'token:pay:4663']);
  assert.deepEqual(keyboard[4].map((button) => button.text), ['✏️ Buy X', '⛓ Base', '🎚 Slip 1%']);
  assert.equal(keyboard[5][1].url, 'https://basescan.org/token/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
});

test('dashboard-style trade callbacks require a stored token context before quoting', async () => {
  const { calls } = await sendUpdate({
    callback_query: { id: 'trade-preview', data: 'trade:buy:0.5', message: { chat: { id: 322, type: 'private' } } },
  });
  assert.match(calls.at(-1).body.text, /Open a token lookup first/);
});

test('D1-backed Telegram profiles persist when KV is absent', async () => {
  const db = createD1();
  await sendUpdate({ callback_query: { id: 'd1-chain', data: 'settings:chain:8453', message: { chat: { id: 900, type: 'private' } } } }, {
    extraEnv: { DB: db },
  });
  assert.equal(db.rows.get(900).funding_chain_id, 8453);
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

test('blocks wallet balance queries in group chats', async () => {
  const { calls } = await sendUpdate({
    message: { chat: { id: -48, type: 'group' }, text: '/wallet 0x1234567890abcdef1234567890abcdef12345678' },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /check wallet balances in a private chat/);
});

test('blocks personal wallet buttons in group chats', async () => {
  const { calls } = await sendUpdate({
    callback_query: { id: 'wallet-group', data: 'wallet:generate', message: { chat: { id: -49, type: 'group' } } },
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

test('token names from market data are HTML-escaped and prices formatted', async () => {
  const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabce';
  const { calls } = await sendUpdate({ message: { chat: { id: 461 }, text: address } }, {
    externalFetch: async () => Response.json({ pairs: [{
      chainId: 'base',
      baseToken: { address, name: '<script>', symbol: 'A&B' },
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
  assert.match(card, /🏪 Uniswap/);
});

test('Buy & Sell asks for a token address with a focused reply box', async () => {
  const { calls } = await sendUpdate({ callback_query: { id: 'bs', data: 'trade:start', message: { message_id: 3, chat: { id: 471, type: 'private' } } } });
  const prompt = calls.at(-1);
  assert.equal(prompt.url.split('/').at(-1), 'sendMessage');
  assert.equal(prompt.body.reply_markup.force_reply, true);
  assert.match(prompt.body.text, /token contract address/);
});

test('Positions stay private in group chats', async () => {
  const { calls } = await sendUpdate({ callback_query: { id: 'pg', data: 'positions', message: { chat: { id: -473, type: 'group' } } } });
  assert.match(calls.at(-1).body.text, /private chat/);
});


/** ExecutionContext stand-in: collects waitUntil work so a test can await it. */
function backgroundCtx() {
  const pending = [];
  return { pending, waitUntil: (promise) => pending.push(promise), settled: () => Promise.all(pending) };
}

const examplePair = (address, symbol) => ({ pairs: [{
  chainId: 'base', baseToken: { address, name: `${symbol} Token`, symbol }, priceUsd: '2', liquidity: { usd: 50000 }, fdv: 100000, priceChange: { h24: 1 },
}] });

test('webhook is acknowledged at once while the reply is built in the background', async () => {
  const address = '0x1111111111111111111111111111111111111aaa';
  const ctx = backgroundCtx();
  let releaseMarket;
  const marketGate = new Promise((resolve) => { releaseMarket = resolve; });
  const calls = [];
  const chatActions = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('api.telegram.org')) {
      (String(url).endsWith('/sendChatAction') ? chatActions : calls).push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: true });
    }
    await marketGate; // DexScreener is slow today
    return Response.json(examplePair(address, 'SLOW'));
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: 7001, message: { chat: { id: 4401, type: 'private' }, text: address } }),
    }), env, ctx);
    assert.equal(response.status, 200, 'Telegram gets its 200 before market data arrives');
    assert.equal(ctx.pending.length, 1);
    assert.equal(calls.length, 0, 'no card yet');
    assert.equal(chatActions[0]?.body.action, 'typing', 'the user sees "typing…" immediately');
    releaseMarket();
    await ctx.settled();
    assert.match(plain(calls.at(-1).body.text), /SLOW  \|  SLOW Token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a redelivered update is ignored instead of answered twice', async () => {
  const update = { update_id: 7002, message: { chat: { id: 4402 }, text: '/help' } };
  const first = await sendUpdate(update);
  const again = await sendUpdate(update);
  assert.equal(first.calls.length, 1);
  assert.equal(again.response.status, 200);
  assert.equal(again.calls.length, 0);
});

test('trade confirmation finishes before the webhook replies, even with background tasks available', async () => {
  const ctx = backgroundCtx();
  const { calls } = await sendUpdate({
    update_id: 7003,
    callback_query: { id: 'confirm-inline', data: 'trade:confirm:00000000-0000-0000-0000-000000000000', message: { message_id: 12, chat: { id: 4403, type: 'private' } } },
  }, { ctx });
  assert.equal(ctx.pending.length, 0, 'signing never runs in a time-limited background task');
  assert.match(plain(calls.at(-1).body.text), /Trade was not submitted/);
});

test('a failing update still gets a friendly reply instead of silence', async () => {
  const ctx = backgroundCtx();
  const db = { prepare() { throw new Error('D1 is down'); } };
  const { response, calls } = await sendUpdate({ update_id: 7004, message: { chat: { id: 4404, type: 'private' }, text: '/settings' } }, { ctx, extraEnv: { DB: db } });
  assert.equal(response.status, 200, 'no 500, so Telegram does not retry the update');
  assert.match(plain(calls.at(-1).body.text), /Something went wrong/);
});

test('/start t_<address> from the website opens that token\'s trading panel', async () => {
  const address = '0x2222222222222222222222222222222222222bbb';
  const { calls, chatActions } = await sendUpdate({ message: { chat: { id: 4405, type: 'private' }, text: `/start t_${address}` } }, {
    externalFetch: async () => Response.json(examplePair(address, 'WEB')),
  });
  assert.equal(chatActions.length, 1);
  const card = calls.at(-1).body;
  assert.match(plain(card.text), /WEB  \|  WEB Token/);
  assert.ok(card.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'trade:buy:0.1'));
});

test('the Mini App is gone: /app opens the menu and no button opens a web app', async () => {
  const { calls } = await sendUpdate({ message: { chat: { id: 4406 }, text: '/app' } }, {
    extraEnv: { TELEGRAM_MINI_APP_URL: 'https://hopr.example/' },
  });
  const menu = calls.at(-1).body;
  assert.match(plain(menu.text), /Cross-chain trading terminal/);
  assert.ok(menu.reply_markup.inline_keyboard.flat().every((button) => !button.web_app));
});

test('Mini App and website-trading endpoints are removed; /health lists configured keys without values', async () => {
  const removed = [
    ['POST', '/api/trade/quote'], ['POST', '/api/trade/buy'], ['POST', '/api/trade/sell'], ['GET', '/api/trade/x/status'], ['POST', '/api/trade/execute'],
    ['POST', '/api/telegram/session'], ['POST', '/api/telegram/wallets'], ['POST', '/api/telegram/trade/prepare'],
    ['GET', '/api/lifi/quote'], ['POST', '/api/intents/quote'], ['POST', '/api/referrals/stats'], ['GET', '/api/wallet/0x1234567890abcdef1234567890abcdef12345678/balances'],
  ];
  for (const [method, path] of removed) {
    const response = await worker.fetch(new Request(`https://worker.example${path}`, { method, body: method === 'POST' ? '{}' : undefined }), env, {});
    assert.equal(response.status, 404, path);
  }
  const health = await (await worker.fetch(new Request('https://worker.example/health'), { ...env, ALCHEMY_API_KEY: 'alchemy-secret', RPC_ARC: 'https://arc.example/rpc' }, {})).json();
  assert.equal(health.keys.alchemy, true);
  assert.equal(health.keys.helius, false);
  assert.equal(health.keys.rpc.Base, true, 'Alchemy covers Base');
  assert.equal(health.keys.rpc.Arc, true);
  assert.equal(health.keys.rpc.Robinhood, false);
  assert.doesNotMatch(JSON.stringify(health), /alchemy-secret|arc\.example/, 'never leaks key values');
});

/** D1 stand-in: one active wallet and the tokens the user traded. */
function walletDb(wallet, trades = []) {
  return {
    prepare(sql) {
      const statement = {
        async first() { return /wallet_accounts|user_wallets/.test(sql) && /SELECT/.test(sql) ? { ...wallet } : null; },
        async all() { return { results: /user_trades/.test(sql) ? trades : /wallet_accounts/.test(sql) ? [{ id: 'w1', label: 'W1', source: 'generated', is_active: 1, ...wallet }] : [] }; },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return { ...statement, bind: () => statement };
    },
  };
}

test('Portfolio lists every holding across chains with values, 24h change and token buttons', async () => {
  const { Interface } = await import('ethers');
  const multicall = new Interface([
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
    'function getEthBalance(address addr) view returns (uint256 balance)',
  ]);
  const erc20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
  const owner = '0x9999999999999999999999999999999999999901';
  const token = '0xabcdefabcdefabcdefabcdefabcdefabcdefab01';
  const wallet = { evm_address: owner, solana_address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', near_address: null };
  const rpc = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_call') {
      const [calls] = multicall.decodeFunctionData('aggregate3', body.params[0].data);
      const results = calls.map((call) => {
        const selector = call.callData.slice(0, 10);
        if (call.target.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return { success: true, returnData: multicall.encodeFunctionResult('getEthBalance', [calls.length > 1 ? 10n ** 18n : 0n]) };
        if (selector === erc20.getFunction('balanceOf').selector) return { success: true, returnData: erc20.encodeFunctionResult('balanceOf', [1000n * 10n ** 18n]) };
        if (selector === erc20.getFunction('decimals').selector) return { success: true, returnData: erc20.encodeFunctionResult('decimals', [18]) };
        return { success: true, returnData: erc20.encodeFunctionResult('symbol', ['POS']) };
      });
      return Response.json({ jsonrpc: '2.0', id: 1, result: multicall.encodeFunctionResult('aggregate3', [results]) });
    }
    if (body.method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: 1, result: { value: 0 } });
    if (body.method === 'getTokenAccountsByOwner') return Response.json({ jsonrpc: '2.0', id: 1, result: { value: [] } });
    throw new Error(`Unexpected RPC ${body.method}`);
  };
  const { calls } = await sendUpdate({ callback_query: { id: 'pf', data: 'positions', message: { message_id: 9, chat: { id: 4407, type: 'private' } } } }, {
    extraEnv: { DB: walletDb(wallet, [{ target_token_address: token, target_chain_id: '8453' }]) },
    externalFetch: async (url, init) => {
      const href = String(url);
      if (href.includes('api.dexscreener.com/tokens/v1/base/')) {
        return Response.json([{ chainId: 'base', baseToken: { address: token, symbol: 'POS' }, priceUsd: '0.5', liquidity: { usd: 90000 }, priceChange: { h24: -2 } }]);
      }
      if (href.includes('api.dexscreener.com')) return Response.json([]);
      if (href.includes('1click.chaindefuser.com')) return Response.json([{ symbol: 'ETH', price: 2000 }]);
      if (init?.method === 'POST') return rpc(url, init);
      throw new Error(`Unexpected request ${href}`);
    },
  });
  const panel = calls.at(-1);
  assert.equal(panel.url.split('/').at(-1), 'editMessageText');
  const text = plain(panel.body.text);
  assert.match(text, /💼 Portfolio/);
  assert.match(text, /🔷 Base/);
  assert.match(text, /POS  1,000 · \$500\.00 🔴−2\.0%/);
  assert.match(text, /ETH  1/);
  const buttons = panel.body.reply_markup.inline_keyboard;
  assert.deepEqual(buttons[0], [{ text: '📈 POS', callback_data: `token:refresh:${token}` }]);
  assert.ok(buttons.flat().some((button) => button.callback_data === 'positions:fresh'));
});

test('the wallet manager switches the active wallet in the bot', async () => {
  const runs = [];
  const accounts = [
    { id: 'w1', label: 'W1', source: 'generated', is_active: 1, evm_address: '0x1111111111111111111111111111111111111111', solana_address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', near_address: null },
    { id: 'w2', label: 'W2', source: 'imported', is_active: 0, evm_address: '0x2222222222222222222222222222222222222222', solana_address: 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy', near_address: null },
  ];
  const db = {
    prepare(sql) {
      const statement = (params = []) => ({
        async all() { return { results: /wallet_accounts/.test(sql) ? accounts : [] }; },
        async first() { return null; },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
      });
      return { ...statement(), bind: (...params) => statement(params) };
    },
  };
  const list = await sendUpdate({ callback_query: { id: 'wl', data: 'wallet:list', message: { message_id: 5, chat: { id: 4408, type: 'private' } } } }, { extraEnv: { DB: db } });
  const panel = list.calls.at(-1).body;
  assert.match(plain(panel.text), /Switch wallet/);
  assert.match(plain(panel.text), /✅ W1/);
  const switchButtons = panel.reply_markup.inline_keyboard[0];
  assert.deepEqual(switchButtons.map((button) => button.callback_data), ['wallet:use:w1', 'wallet:use:w2']);
  await sendUpdate({ callback_query: { id: 'wu', data: 'wallet:use:w2', message: { message_id: 5, chat: { id: 4408, type: 'private' } } } }, { extraEnv: { DB: db } });
  const activation = runs.find((run) => /SET is_active = CASE WHEN id = \?1/.test(run.sql));
  assert.deepEqual(activation.params, ['w2', '4408']);
});

test('token card shows what you hold of the token and what you can pay with', async () => {
  const { Interface } = await import('ethers');
  const multicall = new Interface([
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
    'function getEthBalance(address addr) view returns (uint256 balance)',
  ]);
  const erc20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
  const token = '0xabcdefabcdefabcdefabcdefabcdefabcdefab02';
  const wallet = { evm_address: '0x9999999999999999999999999999999999999902', solana_address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', near_address: null };
  const kv = createKv();
  const { calls } = await sendUpdate({ message: { chat: { id: 4409, type: 'private' }, text: token } }, {
    extraEnv: { DB: walletDb(wallet), TELEGRAM_STATE: kv },
    externalFetch: async (url, init) => {
      if (String(url).includes('api.dexscreener.com')) {
        return Response.json({ pairs: [{ chainId: 'base', baseToken: { address: token, name: 'Held Token', symbol: 'HELD' }, priceUsd: '2', liquidity: { usd: 80000 }, fdv: 1e6, priceChange: { h24: 1 } }] });
      }
      const body = JSON.parse(init.body);
      if (body.method === 'eth_getBalance') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x6f05b59d3b20000' }); // 0.5 ETH
      if (body.method === 'eth_call' && body.params[0].to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
        const [batch] = multicall.decodeFunctionData('aggregate3', body.params[0].data);
        const results = batch.map((call) => {
          const selector = call.callData.slice(0, 10);
          if (selector === erc20.getFunction('balanceOf').selector) return { success: true, returnData: erc20.encodeFunctionResult('balanceOf', [25n * 10n ** 18n]) };
          if (selector === erc20.getFunction('decimals').selector) return { success: true, returnData: erc20.encodeFunctionResult('decimals', [18]) };
          if (selector === erc20.getFunction('symbol').selector) return { success: true, returnData: erc20.encodeFunctionResult('symbol', ['HELD']) };
          return { success: true, returnData: multicall.encodeFunctionResult('getEthBalance', [0n]) };
        });
        return Response.json({ jsonrpc: '2.0', id: 1, result: multicall.encodeFunctionResult('aggregate3', [results]) });
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' });
    },
  });
  const card = plain(calls.at(-1).body.text);
  assert.match(card, /💼 Your wallet/);
  assert.match(card, /Holding  25 HELD · \$50\.00/);
  assert.match(card, /Pay with  0\.5 ETH on Base/);
  const watchlist = JSON.parse(kv.values.get('watch:v1:4409'));
  assert.deepEqual(watchlist[0], { chainId: 8453, address: token, symbol: 'HELD' }, 'opened tokens are tracked for the portfolio');
});

test('/importkey evm becomes a new active wallet instead of overwriting a funded key', async () => {
  const runs = [];
  const db = {
    prepare(sql) {
      const statement = (params = []) => ({
        async first() {
          if (/COUNT\(\*\)/.test(sql)) return { total: 1 };
          if (/SELECT \* FROM wallet_accounts WHERE id/.test(sql)) return { id: params[0], label: 'W2', source: 'imported', evm_address: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', solana_address: 'x', is_active: 1 };
          return null;
        },
        async all() { return { results: [{ label: 'W1' }] }; },
        async run() { runs.push({ sql, params }); return { success: true, meta: { changes: 1 } }; },
      });
      return { ...statement(), bind: (...params) => statement(params) };
    },
  };
  // Well-known test key (never holds funds).
  const key = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const { calls } = await sendUpdate({ message: { chat: { id: 4410, type: 'private' }, text: `/importkey evm ${key}` } }, {
    extraEnv: { DB: db, ENCRYPTION_KEY: 'test-encryption-key-test-encryption-key' },
  });
  const insert = runs.find((run) => /INSERT INTO wallet_accounts/.test(run.sql));
  assert.ok(insert, 'stored as a wallet_accounts row');
  assert.equal(insert.params[3], 'imported');
  assert.equal(insert.params[4], '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  assert.ok(!runs.some((run) => /user_wallets/.test(run.sql) && /UPDATE|ON CONFLICT/.test(run.sql)), 'the legacy wallet row is never overwritten');
  assert.match(plain(calls.at(-1).body.text), /EVM key imported as W2/);
  assert.ok(!JSON.stringify(calls).includes(key.slice(2)), 'the raw key is never echoed back');
});
