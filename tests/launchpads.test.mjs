import test from 'node:test';
import assert from 'node:assert/strict';
import { launchpadById, parseGeckoPools, parseTollyPools, nearPoolPrice, uniquePools, sortPools, metric, fetchLaunchpadFeed } from '../src/services/launchpads.ts';
import { getLaunchpadFeed } from '../workers/launchpads.ts';

const mint = 'So11111111111111111111111111111111111111112';
const pool = 'HWGadsqBpzSr323ix615PNNZLkfBFvv6LXDBChDsDcNv';
function gecko(dex = 'pump-fun') {
  return { data: [{ attributes: { address: pool, name: 'TOKEN / SOL', reserve_in_usd: '0', base_token_price_usd: '0.000001', volume_usd: { h24: '25' } },
    relationships: { dex: { data: { id: dex } }, base_token: { data: { id: `solana_${mint}` } } } }] };
}
test('pool parser retains true zero, unknown change and case-sensitive Solana addresses', () => {
  const [row] = parseGeckoPools(gecko(), launchpadById('pump'), 'pump-fun', 123);
  assert.equal(row.tokenAddress, mint); assert.equal(row.poolAddress, pool);
  assert.equal(row.liquidityUsd, 0); assert.equal(row.change24h, null); assert.equal(row.observedAt, 123);
  assert.equal(row.id, `1151111081099710:${pool}`);
  assert.equal(metric('Infinity'), null); assert.equal(metric(null), null); assert.equal(metric('-1'), null);
});
test('launchpad attribution requires the exact venue; mismatched data is excluded', () => {
  assert.deepEqual(parseGeckoPools(gecko('uniswap'), launchpadById('pump'), 'pump-fun'), []);
  const wrong = gecko(); wrong.data[0].relationships.base_token.data.id = `base_${mint}`;
  assert.deepEqual(parseGeckoPools(wrong, launchpadById('pump'), 'pump-fun'), []);
});
test('Tolly excludes external launches and unsafe v4 aggregate liquidity', () => {
  const token = { address: '0x' + '1'.repeat(40), pool: '0x' + '2'.repeat(64), tolly: true, liquidity: 1000, price: '0.01' };
  const rows = parseTollyPools({ tokens: [token, { ...token, tolly: false }] });
  assert.equal(rows.length, 1); assert.equal(rows[0].liquidityUsd, null);
  assert.equal(parseTollyPools({ tokens: [{ ...token, liquiditySource: 'poolmanager-extsload' }] })[0].liquidityUsd, 1000);
});
test('NEAR DCL price handles orientation and quote decimals without inventing a dollar peg', () => {
  const state = { token_x: 'coin.near', token_y: 'wrap.near', current_point: 0 };
  assert.equal(nearPoolPrice(state, 'coin.near', 18, 24, 3), 0.000003);
  assert.equal(nearPoolPrice(state, 'wrap.near', 24, 18, 2), 2_000_000);
  assert.equal(nearPoolPrice(state, 'other.near', 18, 24, 3), null);
  assert.equal(nearPoolPrice(state, 'coin.near', 18, 24, null), null);
});
test('pool deduplication retains separate pools for a token; null metrics sort last', () => {
  const [a] = parseGeckoPools(gecko(), launchpadById('pump'), 'pump-fun');
  const b = { ...a, id: 'other-pool', volume24h: null };
  assert.equal(uniquePools([a, a, b]).length, 2);
  assert.deepEqual(sortPools([b, a], 'volume').map((p) => p.id), [a.id, b.id]);
});
test('a failed pons venue produces a partial feed, not failure of all versions', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('pons-v2-dex') ? new Response('', { status: 429 }) : Response.json({ data: [] });
  try { const result = await fetchLaunchpadFeed('pons'); assert.equal(result.partial, true); assert.deepEqual(result.pools, []); }
  finally { globalThis.fetch = original; }
});
test('upstream failure returns timestamped last-known pools from KV', async () => {
  const original = globalThis.fetch;
  const cached = { source: 'moonit', pools: [], observedAt: Date.now() - 300_000, stale: false, partial: false, coverage: 'test' };
  globalThis.fetch = async () => new Response('', { status: 503 });
  try {
    const result = await getLaunchpadFeed('moonit', { CACHE: { get: async () => JSON.stringify(cached) } });
    assert.equal(result.stale, true); assert.equal(result.observedAt, cached.observedAt);
    await assert.rejects(getLaunchpadFeed('not-a-source', {}), /Unknown launchpad/);
  } finally { globalThis.fetch = original; }
});
