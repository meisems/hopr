import test from 'node:test';
import assert from 'node:assert/strict';
import { tracked } from '../workers/balances.ts';
import { jsonRpc } from '../src/services/rpcPool.ts';
import { getAssetBalance, getTrackedAssetBalance } from '../src/services/router.ts';

test('balance tracking distinguishes live zero, cached value and first-read failure', async () => {
  const values = new Map();
  const env = { CACHE: { get: async (k) => values.get(k) ?? null, put: async (k,v) => values.set(k,v) } };
  const fail = async () => { throw new Error('RPC offline'); };
  assert.equal(await tracked(env, 'new-wallet', fail), null);
  assert.deepEqual(await tracked(env, 'wallet', async () => 0n), { value: 0n });
  const stale = await tracked(env, 'wallet', fail);
  assert.equal(stale.value, 0n); assert.ok(stale.cachedAt > 0);
  values.set('bal:v1:broken', '{');
  assert.equal(await tracked(env, 'broken', fail), null);
});
test('RPC fails over on HTTP throttling and malformed results', async () => {
  let attempts = 0;
  const result = await jsonRpc(8453, 'eth_getBalance', ['0x'+'1'.repeat(40), 'latest'], {
    extra: ['https://example.invalid/rpc'], validate: (v) => typeof v === 'string' && /^0x[0-9a-f]+$/.test(v),
    fetchImpl: async () => ++attempts === 1 ? Response.json({ result: '0x0' }, { status: 429 })
      : attempts === 2 ? Response.json({ result: null }) : Response.json({ result: '0xa' }),
  });
  assert.equal(attempts, 3); assert.equal(result, '0xa');
});
test('an execution balance never falls back to the display cache', async () => {
  const original = globalThis.fetch;
  const asset = { chainId: 8453, address: 'native', symbol: 'ETH', decimals: 18 };
  const owner = '0x' + '3'.repeat(40);
  try {
    globalThis.fetch = async () => Response.json({ result: '0x64' });
    assert.equal(await getAssetBalance(asset, owner), 100n);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(getAssetBalance(asset, owner), /offline/);
    const display = await getTrackedAssetBalance(asset, owner);
    assert.equal(display.value, 100n); assert.equal(display.stale, true);
    assert.equal((await getTrackedAssetBalance(asset, '0x'+'4'.repeat(40))).value, null);
  } finally { globalThis.fetch = original; }
});
