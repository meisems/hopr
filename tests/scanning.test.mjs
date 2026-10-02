import test from 'node:test';
import assert from 'node:assert/strict';
import { venueName, launchpadFromVenue, firstHit } from '../src/services/venues.ts';
import { jsonRpcRace } from '../src/services/rpcPool.ts';
import { decodeFlapTokenCreated, fetchLaunchpadFeed, FLAP_TOKEN_CREATED, LAUNCHPADS, sourceVenues } from '../src/services/launchpads.ts';
import { detectChain } from '../src/services/chainDetector.ts';

/** A real Robinhood Portal TokenCreated log ("Cat Bot"). */
const FLAP_LOG_DATA = '0x000000000000000000000000000000000000000000000000000000006abc09950000000000000000000000005bbb332a7ea0bbc98424304326c3dce71d8b666600000000000000000000000000000000000000000000000000000000000516fa000000000000000000000000d8d085413535d3fb7dc2c9a566271154679a777700000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000000743617420426f74000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006434154424f540000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003b6261666b7265696535747970337633666b37657a6469746f7076766e376a6e6665716979676a6e7173786a7374636d75656e376565697332636a690000000000';
const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('venues are named by family and launchpads are only attributed to launchpads', () => {
  for (const [id, name] of [['flapsh', 'Flap'], ['four-meme', 'Four.meme'], ['fourmeme', 'Four.meme'], ['uniswap-v3-base', 'Uniswap v3'],
    ['uniswap_v3_arbitrum', 'Uniswap v3'], ['pancakeswap-infinity-clmm', 'PancakeSwap Infinity'], ['clanker-robinhood', 'Clanker'],
    ['bags-fm', 'Bags'], ['meteora-dbc', 'Meteora DBC'], ['raydium-clmm', 'Raydium CLMM'], ['some-new-dex', 'Some New Dex']]) {
    assert.equal(venueName(id), name, id);
  }
  assert.equal(launchpadFromVenue('flapsh'), 'Flap');
  assert.equal(launchpadFromVenue('uniswap-v4-robinhood'), undefined);
  assert.equal(launchpadFromVenue('pons-v2-dex'), 'PonsFamily');
});

test('firstHit hedges a slow source and moves on at once from an empty one', async () => {
  let started = Date.now();
  assert.equal(await firstHit([{ run: () => sleep(2000, 'slow'), delayMs: 0 }, { run: () => sleep(10, 'backup'), delayMs: 80 }]), 'backup');
  assert.ok(Date.now() - started < 600);
  started = Date.now();
  assert.equal(await firstHit([{ run: () => sleep(20, null), delayMs: 0 }, { run: () => sleep(10, 'backup'), delayMs: 5000 }]), 'backup');
  assert.ok(Date.now() - started < 600, 'an empty primary starts the backup immediately');
  assert.equal(await firstHit([{ run: () => sleep(10, 'primary'), delayMs: 0 }, { run: () => sleep(1, 'backup'), delayMs: 200 }]), 'primary');
  assert.equal(await firstHit([{ run: () => Promise.reject(new Error('down')), delayMs: 0 }, { run: () => sleep(5, null), delayMs: 20 }]), null);
});

test('scanning RPC reads race backup endpoints: a hung or failing RPC does not stall the scan', async () => {
  const seen = [];
  const result = await withFetch(async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('bsc-dataseed.binance.org')) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (String(url).includes('publicnode')) return new Response('bad gateway', { status: 502 });
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x6080' });
  }, () => jsonRpcRace(56, 'eth_getCode', ['0x' + '1'.repeat(40), 'latest'], { hedgeMs: 50 }));
  assert.equal(result, '0x6080');
  assert.ok(seen.length >= 3, 'backups were asked');
  // A genuine call error (revert) is an answer, not an endpoint problem: no failover.
  await assert.rejects(withFetch(async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
    () => jsonRpcRace(56, 'eth_call', [{}, 'latest'], { hedgeMs: 10 })), /reverted/);
});

test('Flap TokenCreated logs decode to the launched token', () => {
  assert.deepEqual(decodeFlapTokenCreated(FLAP_LOG_DATA), { ts: 1790708117, token: '0xd8d085413535d3fb7dc2c9a566271154679a7777', name: 'Cat Bot', symbol: 'CATBOT' });
  assert.equal(decodeFlapTokenCreated('0x1234'), null);
});

test('the Flap feed lists fresh launches from Portal events, priced by one DexScreener batch per chain', async () => {
  const requests = [];
  const feed = await withFetch(async (url, init = {}) => {
    const href = String(url);
    requests.push(href);
    if (href.includes('api.dexscreener.com/tokens/v1/robinhood/')) {
      return Response.json([{ dexId: 'flapsh', pairAddress: '0x' + 'a'.repeat(40), baseToken: { address: '0xd8d085413535d3fb7dc2c9a566271154679a7777', symbol: 'CATBOT', name: 'Cat Bot' },
        quoteToken: { symbol: 'WETH' }, priceUsd: '0.0000047', liquidity: { usd: 9000 }, volume: { h24: 1200 }, url: 'https://dexscreener.com/robinhood/pair' }]);
    }
    if (href.includes('dexscreener')) return Response.json([]);
    const body = JSON.parse(init.body);
    if (body.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x100000' });
    if (body.method === 'eth_getLogs') {
      assert.deepEqual(body.params[0].topics, [FLAP_TOKEN_CREATED]);
      const robinhood = body.params[0].address === '0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09';
      return Response.json({ jsonrpc: '2.0', id: 1, result: robinhood ? [{ data: FLAP_LOG_DATA, topics: [FLAP_TOKEN_CREATED] }] : [] });
    }
    throw new Error(`unexpected ${href}`);
  }, () => fetchLaunchpadFeed('flap'));
  assert.equal(feed.partial, false);
  assert.equal(feed.pools.length, 1);
  const [pool] = feed.pools;
  assert.equal(pool.chainId, 4663);
  assert.equal(pool.symbol, 'CATBOT');
  assert.equal(pool.priceUsd, 0.0000047);
  assert.equal(pool.createdAt, 1790708117000);
  assert.equal(pool.venue, 'flapsh');
  assert.equal(requests.filter((href) => href.includes('dexscreener')).length, 1, 'only chains with launches are priced');
});

test('every radar source has a feed and fits Telegram callback limits', () => {
  const custom = new Set(['nearpaid', 'tolly', 'flap']);
  for (const source of LAUNCHPADS) {
    assert.ok(custom.has(source.id) || sourceVenues(source).length > 0, source.id);
    assert.ok(Buffer.byteLength(`pools:${source.id}`) <= 64);
  }
  assert.deepEqual(sourceVenues(LAUNCHPADS.find((source) => source.id === 'uniswap')).map((venue) => venue.chainId), [4663, 4663, 8453, 8453, 42161]);
});

test('scans pick the deepest pool on a Hopr chain and name its venue', async () => {
  const token = `0x${'7'.repeat(36)}7777`;
  const pair = (chainId, dexId, liquidity) => ({ chainId, dexId, pairAddress: '0x' + '9'.repeat(40), baseToken: { address: token, name: 'Flappy', symbol: 'FLAP' },
    quoteToken: { address: '0x' + '0'.repeat(40), name: 'Wrapped BNB', symbol: 'WBNB' }, priceUsd: '0.01', liquidity: { usd: liquidity } });
  const detected = await withFetch(async (url) => {
    if (String(url).includes('dexscreener')) return Response.json({ pairs: [pair('ethereum', 'uniswap', 9e9), pair('bsc', 'pancakeswap', 500), pair('bsc', 'flapsh', 12_000)] });
    return new Response('', { status: 429 });
  }, () => detectChain(token));
  assert.equal(detected.chainId, 56, 'unsupported chains are ignored');
  assert.equal(detected.liquiditySource, 'Flap');
  assert.equal(detected.launchpad, 'Flap');
  assert.equal(detected.liquidity, 12_000);
});
