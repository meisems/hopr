import test from 'node:test';
import assert from 'node:assert/strict';
import { buyAmountProblem, buyButtonAmounts, floorSignificant, formatAmount, niceCeil } from '../workers/buyLimits.ts';

const NEAR_PRESETS = ['0.1', '0.5', '1', '5', '10'];

test('round amounts: 1, 2, 2.5, 5 × 10^n upward, 3 significant digits downward', () => {
  assert.equal(niceCeil(0.37), 0.5);
  assert.equal(niceCeil(0.0041), 0.005);
  assert.equal(niceCeil(1.2), 2);
  assert.equal(niceCeil(2.2), 2.5);
  assert.equal(floorSignificant(4.2871), 4.28);
  assert.equal(formatAmount(0.005), '0.005');
  assert.equal(formatAmount(12), '12');
});

test('Buy buttons never go below the route minimum', () => {
  // NEAR → a Solana token with an empty SOL wallet: 0.1 is dropped, the smallest workable amount leads.
  assert.deepEqual(buyButtonAmounts(NEAR_PRESETS, { min: 0.2, max: 20, symbol: 'NEAR', reason: '' }), ['0.2', '0.5', '1']);
  assert.deepEqual(buyButtonAmounts(NEAR_PRESETS, { min: 0.37, max: 20, symbol: 'NEAR', reason: '' }), ['0.5', '1', '5']);
  // A minimum below every preset changes nothing.
  assert.deepEqual(buyButtonAmounts(NEAR_PRESETS, { min: 0.01, max: 20, symbol: 'NEAR', reason: '' }), ['0.1', '0.5', '1']);
  // A higher minimum is topped up with round amounts from the minimum.
  assert.deepEqual(buyButtonAmounts(['0.005', '0.01', '0.05', '0.1'], { min: 0.04, max: 3, symbol: 'ETH', reason: '' }), ['0.05', '0.1', '0.2']);
});

test('Buy buttons never exceed what the wallet can spend; unaffordable shows none', () => {
  assert.deepEqual(buyButtonAmounts(NEAR_PRESETS, { min: 0.37, max: 0.8, symbol: 'NEAR', reason: '' }), ['0.5', '0.8']);
  assert.deepEqual(buyButtonAmounts(NEAR_PRESETS, { min: 0.37, max: 0.2, symbol: 'NEAR', reason: '' }), []);
  // Limits unknown (RPC down): the presets.
  assert.deepEqual(buyButtonAmounts(NEAR_PRESETS, null), ['0.1', '0.5', '1']);
});

test('an amount outside the range explains why', () => {
  const limits = { min: 0.37, max: 4.287, symbol: 'NEAR', reason: 'the swap on Solana needs ~0.0041 SOL for fees' };
  assert.match(buyAmountProblem(0.1, limits), /minimum for this route is 0\.5 NEAR — the swap on Solana needs/);
  assert.match(buyAmountProblem(10, limits), /up to 4\.28 NEAR after network fees/);
  assert.equal(buyAmountProblem(1, limits), null);
  assert.match(buyAmountProblem(1, { ...limits, max: 0.1 }), /can't cover the minimum of 0\.5 NEAR/);
});
