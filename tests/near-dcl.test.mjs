import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefSwapPlan, getNearSwapQuote, NATIVE_NEAR, REF_DCL, REF_EXCHANGE, RHEA_TOKEN, WRAP_NEAR, HOPR_FEE_BPS } from '../src/services/nearService.ts';
import { mergeMarket, tokenChartUrl } from '../src/services/chainDetector.ts';
import { parseNearlyLaunches } from '../src/services/launchpads.ts';

const TOKEN = 'cat.nearlytrade.near';
const ONE = 10n ** 24n;
const msgOf = (action) => JSON.parse(action.args.msg);

test('the platform fee is 0.75% on trades and bridges', () => {
  assert.deepEqual({ ...HOPR_FEE_BPS }, { swap: 75, bridge: 75 });
});

test('a DCL buy wraps NEAR, takes the fee and swaps on Rhea DCL in one transaction', () => {
  const quote = {
    tokenIn: NATIVE_NEAR, tokenOut: TOKEN, amountIn: ONE.toString(), expectedOut: '1000', minOut: '980', actions: [], hops: 1, slippage: 0.02, venue: 'Rhea DCL',
    legs: [{ venue: 'dcl', tokenIn: WRAP_NEAR, tokenOut: TOKEN, amountIn: ONE.toString(), expectedOut: '1000', minOut: '980', poolIds: [`${TOKEN}|${WRAP_NEAR}|10000`], recipient: 'alice.near' }],
  };
  const plans = buildRefSwapPlan(quote, { outputStorageDeposit: 5n, wrapStorageDeposit: 0n }, { account: 'hoprtg.near', amount: 75n * 10n ** 20n, storageDeposit: 0n });
  assert.deepEqual(plans.map((plan) => plan.receiverId), [TOKEN, WRAP_NEAR]);
  const [deposit, fee, swap] = plans[1].actions;
  assert.equal(deposit.methodName, 'near_deposit');
  assert.equal(deposit.deposit, ONE + 75n * 10n ** 20n, 'the fee is wrapped together with the swap amount');
  assert.equal(fee.args.receiver_id, 'hoprtg.near');
  assert.equal(swap.args.receiver_id, REF_DCL);
  assert.deepEqual(msgOf(swap), { Swap: { pool_ids: [`${TOKEN}|${WRAP_NEAR}|10000`], output_token: TOKEN, min_output_amount: '980', swap_out_recipient: 'alice.near' } });
});

test('a DCL sell to NEAR swaps on DCL, then unwraps the minimum received', () => {
  const quote = {
    tokenIn: TOKEN, tokenOut: NATIVE_NEAR, amountIn: '1000', expectedOut: '50', minOut: '49', actions: [], hops: 1, slippage: 0.02,
    legs: [{ venue: 'dcl', tokenIn: TOKEN, tokenOut: WRAP_NEAR, amountIn: '1000', expectedOut: '50', minOut: '49', poolIds: [`${TOKEN}|${WRAP_NEAR}|10000`] }],
  };
  const plans = buildRefSwapPlan(quote, { outputStorageDeposit: 0n, wrapStorageDeposit: 0n });
  assert.deepEqual(plans.map((plan) => `${plan.receiverId}:${plan.actions.map((action) => action.methodName).join('+')}`), [`${TOKEN}:ft_transfer_call`, `${WRAP_NEAR}:near_withdraw`]);
  assert.equal(plans[1].actions[0].args.amount, '49');
});

test('a token paired with RHEA is bought through Ref (wNEAR→RHEA) and then DCL (RHEA→token)', () => {
  const quote = {
    tokenIn: NATIVE_NEAR, tokenOut: TOKEN, amountIn: ONE.toString(), expectedOut: '700', minOut: '690', actions: [], hops: 2, slippage: 0.01,
    legs: [
      { venue: 'ref', tokenIn: WRAP_NEAR, tokenOut: RHEA_TOKEN, amountIn: ONE.toString(), expectedOut: '300', minOut: '297', actions: [{ pool_id: 6458, token_in: WRAP_NEAR, token_out: RHEA_TOKEN, amount_in: ONE.toString(), min_amount_out: '297' }] },
      { venue: 'dcl', tokenIn: RHEA_TOKEN, tokenOut: TOKEN, amountIn: '297', expectedOut: '700', minOut: '690', poolIds: [`${TOKEN}|${RHEA_TOKEN}|10000`] },
    ],
  };
  const plans = buildRefSwapPlan(quote, { outputStorageDeposit: 0n, wrapStorageDeposit: 0n, intermediateStorageDeposits: { [RHEA_TOKEN]: 7n } });
  assert.deepEqual(plans.map((plan) => plan.receiverId), [RHEA_TOKEN, WRAP_NEAR, RHEA_TOKEN], 'register on RHEA, swap to RHEA, swap RHEA');
  assert.equal(plans[1].actions.at(-1).args.receiver_id, REF_EXCHANGE);
  const second = plans[2].actions[0];
  assert.equal(second.args.receiver_id, REF_DCL);
  assert.equal(second.args.amount, '297', 'leg 2 spends leg 1’s minimum output');
});

test('when Ref has no route, the quote uses the token’s Rhea DCL pool', async () => {
  const encode = (value) => Array.from(Buffer.from(JSON.stringify(value)));
  const rpcFetch = async (url, init) => {
    const { params } = JSON.parse(init.body);
    const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
    if (params.method_name === 'get_pool') return Response.json({ jsonrpc: '2.0', id: '1', result: { result: encode(args.pool_id === `${TOKEN}|${WRAP_NEAR}|10000` ? { pool_id: args.pool_id } : null) } });
    if (params.method_name === 'quote') return Response.json({ jsonrpc: '2.0', id: '1', result: { result: encode({ amount: '123456', tag: null }) } });
    return Response.json({ jsonrpc: '2.0', id: '1', error: { message: 'no such method' } });
  };
  const quote = await getNearSwapQuote({
    tokenIn: NATIVE_NEAR, tokenOut: TOKEN, amountIn: ONE.toString(), slippage: 0.01, accountId: 'alice.near',
    rpc: { urls: ['https://rpc.example'], fetchImpl: rpcFetch },
    fetchImpl: async () => Response.json({ result_code: 1008, result_data: null }),
  });
  assert.equal(quote.venue, 'Rhea DCL');
  assert.equal(quote.expectedOut, '123456');
  assert.equal(quote.legs[0].poolIds[0], `${TOKEN}|${WRAP_NEAR}|10000`);
  assert.equal(quote.minOut, (123456n * 9900n / 10000n).toString());
});

test('nearly.trade launches become radar pools priced in USD with a token page link', () => {
  const [pool] = parseNearlyLaunches([{ token: TOKEN, name: 'Cat', symbol: 'CAT', pool_id: `${TOKEN}|wrap.near|10000`, quote: 'wrap.near',
    price_usd: 0.0001, near_usd: 5, liquidity_near: 100, volume_24h_near: 20, change_24h: 3, created_at_ms: 1790000000000 }, { token: 'not-a-launch.near' }], 1);
  assert.equal(pool.symbol, 'CAT');
  assert.equal(pool.quoteSymbol, 'wNEAR');
  assert.equal(pool.liquidityUsd, 500);
  assert.equal(pool.volume24h, 100);
  assert.equal(pool.url, `https://nearly.trade/t/${TOKEN}`);
});

test('token details merge every provider: missing fields come from the others', () => {
  const base = { address: 'x', name: 'Bonk', symbol: 'Bonk', decimals: 5, chainId: 1151111081099710, chainType: 'SVM', chainName: 'Solana', chainColor: '#000', change24h: 0, freshDeployment: false };
  const merged = mergeMarket([
    { ...base, priceUsd: 0.0000038, liquidity: 425_000, volume24h: 800_000, fdv: 0, marketStatus: 'live', marketSource: 'DexScreener', pairUrl: 'https://dexscreener.com/solana/pair' },
    { ...base, priceUsd: 0.0000037, liquidity: 6_400_000, volume24h: 2_600_000, fdv: 330_000_000, holders: 1_026_000, marketStatus: 'live', marketSource: 'Jupiter' },
  ]);
  assert.equal(merged.fdv, 330_000_000, 'FDV filled from Jupiter');
  assert.equal(merged.holders, 1_026_000);
  assert.equal(merged.liquidity, 6_400_000, 'token-wide liquidity');
  assert.equal(merged.marketSource, 'DexScreener · Jupiter');
});

test('chart links open the token itself, never a search page, on every chain', () => {
  assert.equal(tokenChartUrl({ address: '0xabc', chainId: 8453, marketSource: 'DexScreener · GeckoTerminal' }), 'https://dexscreener.com/base/0xabc');
  assert.equal(tokenChartUrl({ address: 'mint', chainId: 1151111081099710, marketSource: 'Jupiter' }), 'https://www.geckoterminal.com/solana/tokens/mint');
  assert.equal(tokenChartUrl({ address: '0xdef', chainId: 4663, marketSource: 'GeckoTerminal', geckoNetwork: 'robinhood', pairAddress: '0xpool' }), 'https://www.geckoterminal.com/robinhood/pools/0xpool');
  assert.equal(tokenChartUrl({ address: TOKEN, chainId: 397, marketSource: 'DexScreener', chartUrl: `https://nearly.trade/t/${TOKEN}` }), `https://nearly.trade/t/${TOKEN}`);
  assert.equal(tokenChartUrl({ address: '0x123', chainId: 5042 }), 'https://dexscreener.com/arc/0x123');
});
