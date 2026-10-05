import test from 'node:test';
import assert from 'node:assert/strict';
import { evmGasReserve, gasReserve, SOLANA_RENT_EXEMPT_MINIMUM } from '../workers/gasReserve.ts';

async function withGasPrice(price, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: price });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('EVM reserves follow the live gas price instead of a fixed 0.0003 ETH', async () => {
  // Base at 0.01 gwei: a swap costs far less than the floor, so the 0.00002 ETH floor applies.
  const baseSwap = await withGasPrice(`0x${(10_000_000n).toString(16)}`, () => evmGasReserve(8453, 'swap'));
  assert.equal(baseSwap, 20_000_000_000_000n);
  // BNB at 1 gwei: 700k gas × 2 headroom.
  const bnbSwap = await withGasPrice(`0x${(1_000_000_000n).toString(16)}`, () => evmGasReserve(56, 'swap'));
  assert.equal(bnbSwap, 1_400_000_000_000_000n);
  // Three transfers on Arbitrum reserve three transfers' worth.
  const transfers = await withGasPrice(`0x${(10_000_000n).toString(16)}`, () => evmGasReserve(42161, 'transfer', 3));
  assert.equal(transfers, 15_000_000_000_000n);
});

test('an absurd or missing gas price falls back to the old fixed reserve', async () => {
  const absurd = await withGasPrice(`0x${(2_500_000_000_000_000n).toString(16)}`, () => evmGasReserve(8453, 'swap'));
  assert.equal(absurd, 300_000_000_000_000n);
});

test('a Solana transfer only keeps the account rent-exempt', async () => {
  assert.equal(await gasReserve(1151111081099710, 'transfer'), SOLANA_RENT_EXEMPT_MINIMUM + 10_000n);
});
