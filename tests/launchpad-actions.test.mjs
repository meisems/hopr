import test from 'node:test';
import assert from 'node:assert/strict';
import { savePoolActions, readPoolAction } from '../workers/launchpadActions.ts';
import { validPnlCard } from '../src/services/pnlCard.ts';

function kv() {
  const values = new Map();
  return { values, async get(k) { return values.get(k); }, async put(k, v) { values.set(k, v); } };
}
test('pool buttons keep the exact token and funding amount across feed reorder and chat changes', async () => {
  const store = kv(); const env = { CACHE: store };
  const rows = [{ pool: { source: 'pump', chainId: 1151111081099710, tokenAddress: 'FirstToken' }, fundingChainId: 8453, amount: '0.005' }];
  const id = await savePoolActions(123, rows, env);
  rows[0].pool.tokenAddress = 'DifferentToken';
  assert.equal((await readPoolAction(123, id, 0, env)).pool.tokenAddress, 'FirstToken');
  assert.equal((await readPoolAction(123, id, 0, env)).fundingChainId, 8453);
  assert.equal(await readPoolAction(456, id, 0, env), null);
  assert.ok(Buffer.byteLength(`lp:buy:${id}:0`) <= 64);
});
test('expired and corrupted buttons cannot resolve to a trade', async () => {
  const store = kv(); const env = { TELEGRAM_STATE: store };
  const id = await savePoolActions(1, [], env); const key = `pool-actions:1:${id}`;
  store.values.set(key, JSON.stringify({ expiresAt: Date.now() - 1, actions: [{}] }));
  assert.equal(await readPoolAction(1, id, 0, env), null);
  store.values.set(key, 'corrupt'); assert.equal(await readPoolAction(1, id, 0, env), null);
  assert.equal(await readPoolAction(1, id, 6, env), null);
  assert.equal(await savePoolActions(1, [], {}), null);
});
test('PnL export accepts losses and rejects incomplete or non-finite valuations', () => {
  const data = { symbol: 'TEST', chain: 'Base', pnlUsd: -20, pnlPercent: -20, investedUsd: 100, valueUsd: 80, realizedUsd: 0, observedAt: Date.now() };
  assert.equal(validPnlCard(data), true);
  for (const patch of [{ investedUsd: 0 }, { pnlUsd: NaN }, { valueUsd: Infinity }, { realizedUsd: -1 }]) assert.equal(validPnlCard({ ...data, ...patch }), false);
});
