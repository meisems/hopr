import test from 'node:test';
import assert from 'node:assert/strict';
import { tracked } from '../workers/balances.ts';
import { jsonRpc } from '../src/services/rpcPool.ts';

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
