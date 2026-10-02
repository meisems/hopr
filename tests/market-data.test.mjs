import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChain } from '../src/services/chainDetector.ts';
import { rpcEndpoints } from '../src/services/rpcPool.ts';
import worker from '../workers/index.ts';

const busy = () => new Response('Too Many Requests', { status: 429 });
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const abiString = (text) => `0x${word(32)}${word(text.length)}${Buffer.from(text).toString('hex').padEnd(64, '0')}`;

test('EVM: with DexScreener and GeckoTerminal throttled, DefiLlama prices the token and FDV comes from the on-chain supply', async () => {
  const token = '0x1111111111111111111111111111111111110001';
  const baseRpcs = new Set(rpcEndpoints(8453));
  const token_ = await withFetch(async (url, init) => {
    const href = String(url);
    if (href.includes('dexscreener') || href.includes('geckoterminal')) return busy();
    if (href.includes('coins.llama.fi')) return Response.json({ coins: { [`base:${token}`]: { price: 0.005, symbol: 'brett', decimals: 18, confidence: 0.99 } } });
    const body = JSON.parse(init.body);
    const onBase = baseRpcs.has(href);
    const result = body.method === 'eth_getCode' ? (onBase ? '0x6080' : '0x')
      : body.params?.[0]?.data === '0x06fdde03' ? abiString('Brett')
        : body.params?.[0]?.data === '0x95d89b41' ? abiString('BRETT')
          : body.params?.[0]?.data === '0x313ce567' ? `0x${word(18)}`
            : body.params?.[0]?.data === '0x18160ddd' ? `0x${word(10n ** 9n * 10n ** 18n)}` // 1B supply
              : '0x';
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }, () => detectChain(token));
  assert.equal(token_.chainId, 8453);
  assert.equal(token_.symbol, 'BRETT');
  assert.equal(token_.priceUsd, 0.005);
  assert.equal(Math.round(token_.fdv), 5_000_000);
  assert.equal(token_.marketStatus, 'partial');
  assert.equal(token_.marketSource, 'DefiLlama');
});

test('Solana: with DexScreener throttled, Jupiter supplies price, FDV, liquidity, volume and holders', async () => {
  const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const detected = await withFetch(async (url) => {
    const href = String(url);
    if (href.includes('lite-api.jup.ag')) {
      return Response.json([{ id: mint, name: 'Bonk', symbol: 'Bonk', decimals: 5, usdPrice: 0.0000037, fdv: 330_000_000, mcap: 330_000_000, liquidity: 6_400_000, holderCount: 1_026_128,
        stats24h: { priceChange: -2.7, buyVolume: 1_300_000, sellVolume: 1_300_000, numBuys: 36_000, numSells: 37_000 } }]);
    }
    return busy();
  }, () => detectChain(mint));
  assert.equal(detected.symbol, 'Bonk');
  assert.equal(detected.liquidity, 6_400_000);
  assert.equal(detected.fdv, 330_000_000);
  assert.equal(detected.volume24h, 2_600_000);
  assert.equal(detected.holders, 1_026_128);
  assert.equal(detected.marketStatus, 'live');
  assert.equal(detected.marketSource, 'Jupiter');
});

test('a token scanned on the quote side of its deepest pool is priced as itself, not as the other token', async () => {
  const usdc = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
  const pairs = [
    // A thin pool whose quote token is USDC; its "price" is COSA's.
    { chainId: 'bsc', dexId: 'pancakeswap', pairAddress: '0xpool1', baseToken: { address: '0x5F980533B994c93631A639dEdA7892fC49995839', name: 'Cosanta', symbol: 'COSA' }, quoteToken: { address: usdc, name: 'USD Coin', symbol: 'USDC' }, priceUsd: '1.77', priceNative: '1.77', liquidity: { usd: 15_955_648 }, fdv: 113_419_572 },
    { chainId: 'bsc', dexId: 'pancakeswap', pairAddress: '0xpool2', baseToken: { address: usdc, name: 'USD Coin', symbol: 'USDC' }, quoteToken: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', name: 'WBNB', symbol: 'WBNB' }, priceUsd: '0.9999', priceNative: '0.0012', liquidity: { usd: 4_000_000 }, fdv: 650_000_000 },
  ];
  const detected = await withFetch(async (url) => (String(url).includes('dexscreener') ? Response.json({ pairs }) : busy()), () => detectChain(usdc));
  assert.equal(detected.symbol, 'USDC');
  assert.equal(detected.priceUsd, 0.9999);
  assert.equal(detected.pairedAsset.symbol, 'WBNB');

  // Only the quote-side pool exists: invert its price; its FDV belongs to the other token.
  const quoteOnly = await withFetch(async (url) => (String(url).includes('dexscreener') ? Response.json({ pairs: [pairs[0]] }) : busy()), () => detectChain(usdc));
  assert.ok(Math.abs(quoteOnly.priceUsd - 1) < 1e-9);
  assert.notEqual(quoteOnly.fdv, 113_419_572);
});

test('the bot shows the last known market numbers (labelled) instead of $0 when every provider is busy', async () => {
  const address = '0x2222222222222222222222222222222222220002';
  const values = new Map();
  const cache = { get: async (key) => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); } };
  const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's', CACHE: cache };
  const send = async (update, marketFetch) => withFetch(async (url, init) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      sent.push(JSON.parse(init.body));
      return Response.json({ ok: true, result: true });
    }
    return marketFetch(href, init);
  }, () => worker.fetch(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' }, body: JSON.stringify(update) }), env, {}));
  let sent = [];
  await send({ message: { chat: { id: 5501 }, text: address } }, async (href) => href.includes('dexscreener')
    ? Response.json({ pairs: [{ chainId: 'base', dexId: 'uniswap', baseToken: { address, name: 'Known', symbol: 'KNOWN' }, priceUsd: '0.42', liquidity: { usd: 120_000 }, fdv: 4_200_000, volume: { h24: 55_000 }, priceChange: { h24: 3 } }] })
    : busy());
  assert.match(plain(sent.at(-1).text), /Price  \$0\.42/);

  sent = [];
  // Providers now throttled (and the token has no bytecode answer either): Refresh skips the detection caches.
  await send({ callback_query: { id: 'r', data: `token:refresh:${address}`, message: { message_id: 3, chat: { id: 5501 } } } }, async (href, init) => {
    if (href.includes('dexscreener') || href.includes('geckoterminal') || href.includes('llama')) return busy();
    const body = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'eth_getCode' && rpcEndpoints(8453).includes(href) ? '0x6080' : '0x' });
  });
  const card = plain(sent.filter((call) => call.text).at(-1).text);
  assert.match(card, /Price  \$0\.42/);
  assert.match(card, /Liquidity  \$120K/);
  assert.match(card, /last known numbers/);
  assert.doesNotMatch(card, /\$0(?![.\d])/, 'never a fake $0');
});

test('a token with no market anywhere shows dashes and an explanation, never $0', async () => {
  const address = '0x3333333333333333333333333333333333330003';
  const sent = [];
  await withFetch(async (url, init) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: true }); }
    if (href.includes('dexscreener') || href.includes('geckoterminal') || href.includes('llama')) return busy();
    const body = JSON.parse(init.body);
    const data = body.params?.[0]?.data;
    const result = body.method === 'eth_getCode' ? (rpcEndpoints(42161).includes(href) ? '0x6080' : '0x')
      : data === '0x95d89b41' ? abiString('NEW') : data === '0x06fdde03' ? abiString('New Token') : data === '0x313ce567' ? `0x${word(18)}` : '0x';
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  }, () => worker.fetch(new Request('https://w/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' }, body: JSON.stringify({ message: { chat: { id: 5502 }, text: address } }) }), { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }, {}));
  const card = plain(sent.at(-1).text);
  assert.match(card, /NEW  \|  New Token/);
  assert.match(card, /Price  —/);
  assert.match(card, /Liquidity  —/);
  assert.match(card, /No market data yet/);
  assert.doesNotMatch(card, /\$0(?![.\d])/);
});
