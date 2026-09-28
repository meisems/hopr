import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRouteStatus, describePlan, executePlan, executeRoute, getRouteQuote, nearDepositPlans, planRoute, previewPlan, HOPR_FEES } from '../src/services/router.ts';
import { formatTokenPrice } from '../src/services/chainDetector.ts';

const EVM = '0x1234567890abcdef1234567890abcdef12345678';
const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const LIFI_ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

const asset = (chainId, address, symbol, decimals) => ({ chainId, address, symbol, decimals });
const BASE_ETH = asset(8453, 'native', 'ETH', 18);
const ARB_ETH = asset(42161, 'native', 'ETH', 18);
const SOL_NATIVE = asset(1151111081099710, 'native', 'SOL', 9);
const NEAR_NATIVE = asset(397, 'native', 'NEAR', 24);
const NEAR_USDC = asset(397, '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'USDC', 6);

const INTENTS_TOKENS = [
  { assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18, price: 2600 },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', blockchain: 'base', symbol: 'USDC', decimals: 6, contractAddress: USDC_BASE },
  { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR', decimals: 24, contractAddress: 'wrap.near', price: 5 },
  { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9, price: 120 },
];

/** Route global fetch to per-URL handlers and record every call. */
function mockFetch(handlers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: href, body });
    for (const [match, handler] of handlers) {
      if (href.includes(match)) return handler(href, body);
    }
    throw new Error(`Unexpected fetch ${href}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const lifiResponse = (overrides = {}) => Response.json({
  estimate: { toAmount: '5000000', toAmountMin: '4950000', fromAmountUSD: '26.10', toAmountUSD: '25.90', executionDuration: 30, approvalAddress: LIFI_ROUTER },
  transactionRequest: { to: LIFI_ROUTER, data: '0xabcdef', value: '0x2386f26fc10000', gasLimit: '0x30d40', chainId: 8453 },
  toolDetails: { name: 'Jumper' },
  ...overrides,
});

test('prices render as real decimals, never scientific notation', () => {
  assert.equal(formatTokenPrice(0.000651234), '$0.0006512');
  assert.equal(formatTokenPrice(0.00000001234), '$0.00000001234');
  assert.equal(formatTokenPrice(2657.51), '$2,657.51');
});

test('EVM ↔ Solana routes go to LI.FI with Hopr fee, integrator and native-token placeholders', async () => {
  const net = mockFetch([['li.quest/v1/quote', () => lifiResponse()]]);
  try {
    const quote = await getRouteQuote({ kind: 'swap', from: SOL_NATIVE, to: asset(8453, USDC_BASE, 'USDC', 6), amount: 100_000_000n, fromAddress: SOL, toAddress: EVM, slippage: 0.01 });
    const url = new URL(net.calls[0].url);
    assert.equal(url.searchParams.get('fromChain'), '1151111081099710');
    assert.equal(url.searchParams.get('fromToken'), '11111111111111111111111111111111');
    assert.equal(url.searchParams.get('toToken'), USDC_BASE);
    assert.equal(url.searchParams.get('toAddress'), EVM);
    assert.equal(url.searchParams.get('integrator'), 'hopr');
    assert.equal(url.searchParams.get('fee'), String(HOPR_FEES.swap));
    assert.equal(quote.provider, 'lifi');
    assert.equal(quote.minOut, 4_950_000n);
    assert.equal(quote.via, 'LI.FI · Jumper');

    await getRouteQuote({ kind: 'bridge', from: BASE_ETH, to: ARB_ETH, amount: 10n ** 16n, fromAddress: EVM, toAddress: EVM, slippage: 0.005 });
    const bridgeUrl = new URL(net.calls[1].url);
    assert.equal(bridgeUrl.searchParams.get('fee'), String(HOPR_FEES.bridge));
    assert.equal(bridgeUrl.searchParams.get('fromToken'), '0x0000000000000000000000000000000000000000');
  } finally {
    net.restore();
  }
});

test('selling an ERC-20 approves exactly the amount, waits for it, then sends the LI.FI transaction', async () => {
  const requests = [];
  const provider = {
    async request({ method, params }) {
      requests.push({ method, params });
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_sendTransaction') return requests.filter((item) => item.method === 'eth_sendTransaction').length === 1 ? '0xapprove' : '0xswap';
      throw new Error(method);
    },
  };
  const net = mockFetch([
    ['li.quest/v1/quote', () => lifiResponse()],
    ['mainnet.base.org', (_url, body) => Response.json({ result: body.method === 'eth_call' ? '0x0' : { status: '0x1' } })],
  ]);
  try {
    const from = asset(8453, USDC_BASE, 'USDC', 6);
    const quote = await getRouteQuote({ kind: 'swap', from, to: BASE_ETH, amount: 25_000_000n, fromAddress: EVM, toAddress: EVM, slippage: 0.01 }, { commit: true });
    const progress = [];
    const result = await executeRoute(quote, { evm: { provider, address: EVM } }, (message) => progress.push(message));
    const sends = requests.filter((item) => item.method === 'eth_sendTransaction').map((item) => item.params[0]);
    assert.equal(sends.length, 2);
    assert.equal(sends[0].to, USDC_BASE);
    assert.equal(sends[0].data, `0x095ea7b3${LIFI_ROUTER.slice(2).padStart(64, '0')}${(25_000_000).toString(16).padStart(64, '0')}`);
    assert.equal(sends[1].to, LIFI_ROUTER);
    assert.equal(sends[1].value, '0x2386f26fc10000');
    assert.equal(result.txHash, '0xswap');
    assert.equal(result.explorerUrl, 'https://basescan.org/tx/0xswap');
    assert.deepEqual(result.track, { type: 'lifi', txHash: '0xswap', fromChain: 8453, toChain: 8453 });
    assert.match(progress[0], /Approve USDC/);
  } finally {
    net.restore();
  }
});

test('the wallet is switched to the source chain, adding it first when unknown', async () => {
  const requests = [];
  let added = false;
  const provider = {
    async request({ method, params }) {
      requests.push(method);
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain' && !added) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
      if (method === 'wallet_addEthereumChain') {
        added = true;
        assert.equal(params[0].chainId, '0xa4b1');
        assert.deepEqual(params[0].nativeCurrency, { name: 'ETH', symbol: 'ETH', decimals: 18 });
        return null;
      }
      if (method === 'eth_sendTransaction') return '0xbridge';
      return null;
    },
  };
  const net = mockFetch([['li.quest/v1/quote', () => lifiResponse({ transactionRequest: { to: LIFI_ROUTER, data: '0x', value: '0x1', chainId: 42161 } })]]);
  try {
    const quote = await getRouteQuote({ kind: 'bridge', from: ARB_ETH, to: BASE_ETH, amount: 1n, fromAddress: EVM, toAddress: EVM, slippage: 0.005 }, { commit: true });
    await executeRoute(quote, { evm: { provider, address: EVM } });
    assert.deepEqual(requests, ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_sendTransaction']);
  } finally {
    net.restore();
  }
});

test('routes involving NEAR use NEAR Intents: bps slippage, mapped assets, deposit from the origin wallet', async () => {
  const net = mockFetch([
    ['1click.chaindefuser.com/v0/tokens', () => Response.json(INTENTS_TOKENS)],
    ['1click.chaindefuser.com/v0/quote', (_url, body) => Response.json({
      quote: { depositAddress: body.dry ? undefined : '0xdeposit00000000000000000000000000000000', amountOut: '5000000000000000000000000', minAmountOut: '4950000000000000000000000', amountInUsd: '26', amountOutUsd: '25.8', timeEstimate: 40 },
      quoteRequest: { appFees: [{ recipient: 'x', fee: 20 }] },
    })],
    ['1click.chaindefuser.com/v0/deposit/submit', () => Response.json({})],
  ]);
  const sent = [];
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_sendTransaction') { sent.push(params[0]); return '0xdeposit-tx'; }
      return null;
    },
  };
  try {
    const preview = await getRouteQuote({ kind: 'bridge', from: BASE_ETH, to: NEAR_NATIVE, amount: 10n ** 16n, fromAddress: EVM, toAddress: 'alice.near', slippage: 0.01 });
    assert.equal(preview.provider, 'intents');
    assert.equal(preview.intents, undefined, 'preview quotes do not allocate a deposit address');
    const request = net.calls.find((call) => call.url.endsWith('/v0/quote')).body;
    assert.equal(request.dry, true);
    assert.equal(request.slippageTolerance, 100);
    assert.equal(request.originAsset, 'nep141:base.omft.near');
    assert.equal(request.destinationAsset, 'nep141:wrap.near');
    assert.equal(request.refundTo, EVM);
    assert.equal(request.recipient, 'alice.near');
    assert.deepEqual(preview.fees, ['NEAR Intents app fee 0.2% (included)']);

    const quote = await getRouteQuote({ kind: 'bridge', from: BASE_ETH, to: NEAR_NATIVE, amount: 10n ** 16n, fromAddress: EVM, toAddress: 'alice.near', slippage: 0.01 }, { commit: true });
    const result = await executeRoute(quote, { evm: { provider, address: EVM } });
    assert.deepEqual(sent, [{ from: EVM, to: '0xdeposit00000000000000000000000000000000', data: '0x', value: '0x2386f26fc10000' }]);
    assert.deepEqual(result.track, { type: 'intents', depositAddress: '0xdeposit00000000000000000000000000000000' });
    assert.ok(net.calls.some((call) => call.url.endsWith('/v0/deposit/submit') && call.body.txHash === '0xdeposit-tx'));
  } finally {
    net.restore();
  }
});

test('NEAR-side Intents deposits register the deposit account, wrap NEAR and transfer wNEAR', async () => {
  const encode = (value) => ({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
  const net = mockFetch([['rpc', (_url, body) => Response.json(encode(body.params.method_name === 'storage_balance_of' ? null : { min: '1250000000000000000000' }))]]);
  try {
    const plans = await nearDepositPlans({ kind: 'bridge', from: NEAR_NATIVE, to: BASE_ETH, amount: 10n ** 24n, fromAddress: 'alice.near', toAddress: EVM, slippage: 0.01 }, 'deposit.near');
    assert.equal(plans[0].receiverId, 'wrap.near');
    assert.deepEqual(plans[0].actions.map((action) => action.methodName), ['storage_deposit', 'near_deposit', 'ft_transfer']);
    assert.deepEqual(plans[0].actions[2].args, { receiver_id: 'deposit.near', amount: (10n ** 24n).toString() });
    assert.equal(plans[0].actions[1].deposit, 10n ** 24n);

    const usdc = await nearDepositPlans({ kind: 'bridge', from: NEAR_USDC, to: BASE_ETH, amount: 5_000_000n, fromAddress: 'alice.near', toAddress: EVM, slippage: 0.01 }, 'deposit.near');
    assert.equal(usdc[0].receiverId, NEAR_USDC.address);
    assert.deepEqual(usdc[0].actions.map((action) => action.methodName), ['storage_deposit', 'ft_transfer']);
  } finally {
    net.restore();
  }
});

test('LI.FI failures fall back to NEAR Intents when both assets are supported there', async () => {
  const net = mockFetch([
    ['li.quest/v1/quote', () => Response.json({ message: 'No available quotes' }, { status: 404 })],
    ['1click.chaindefuser.com/v0/tokens', () => Response.json(INTENTS_TOKENS)],
    ['1click.chaindefuser.com/v0/quote', () => Response.json({ quote: { amountOut: '100', minAmountOut: '99' } })],
  ]);
  try {
    const quote = await getRouteQuote({ kind: 'bridge', from: BASE_ETH, to: SOL_NATIVE, amount: 10n ** 16n, fromAddress: EVM, toAddress: SOL, slippage: 0.01 });
    assert.equal(quote.provider, 'intents');
  } finally {
    net.restore();
  }
});

test('cross-chain status maps provider states to pending / done / failed / refunded', async () => {
  const net = mockFetch([
    ['li.quest/v1/status', (url) => Response.json(url.includes('0xdone') ? { status: 'DONE', receiving: { txHash: '0xrecv' } } : url.includes('0xfail') ? { status: 'FAILED', substatusMessage: 'slippage' } : { status: 'PENDING', substatusMessage: 'bridging' })],
    ['1click.chaindefuser.com/v0/status', () => Response.json({ status: 'REFUNDED' })],
  ]);
  try {
    assert.deepEqual(await checkRouteStatus({ type: 'lifi', txHash: '0xdone', fromChain: 8453, toChain: 42161 }), { status: 'done', receivingTxHash: '0xrecv' });
    assert.deepEqual(await checkRouteStatus({ type: 'lifi', txHash: '0xfail', fromChain: 8453, toChain: 42161 }), { status: 'failed', detail: 'slippage' });
    assert.equal((await checkRouteStatus({ type: 'lifi', txHash: '0xwait', fromChain: 8453, toChain: 42161 })).status, 'pending');
    assert.equal((await checkRouteStatus({ type: 'intents', depositAddress: 'd' })).status, 'refunded');
    assert.deepEqual(await checkRouteStatus({ type: 'final' }), { status: 'done' });
  } finally {
    net.restore();
  }
});

const DEGEN = asset(8453, '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', 'DEGEN', 18);
const NEAR_MEME = asset(397, 'meme.tkn.near', 'MEME', 18);

test('NEAR ↔ tokens NEAR Intents does not list are planned through hub assets, with the fee on step 1 only', async () => {
  const net = mockFetch([['1click.chaindefuser.com/v0/tokens', () => Response.json(INTENTS_TOKENS)]]);
  try {
    const shape = (legs) => legs.map((leg) => `${leg.from.symbol}@${leg.from.chainId}>${leg.to.symbol}@${leg.to.chainId}:${leg.feeBps}`);
    const buyWithNear = await planRoute({ kind: 'swap', from: NEAR_NATIVE, to: DEGEN, amount: 10n ** 24n, fromAddress: 'alice.near', toAddress: EVM, slippage: 0.01 });
    assert.deepEqual(shape(buyWithNear), ['NEAR@397>ETH@8453:50', 'ETH@8453>DEGEN@8453:0']);
    assert.equal(buyWithNear[0].amount, 10n ** 24n);
    assert.equal(buyWithNear[1].fromAddress, EVM, 'step 2 is signed by the EVM wallet that received the ETH');
    assert.equal(describePlan(buyWithNear), 'NEAR → ETH → DEGEN');

    const sellForNear = await planRoute({ kind: 'swap', from: DEGEN, to: NEAR_NATIVE, amount: 10n ** 21n, fromAddress: EVM, toAddress: 'alice.near', slippage: 0.01 });
    assert.deepEqual(shape(sellForNear), ['DEGEN@8453>ETH@8453:50', 'ETH@8453>NEAR@397:0']);

    const nearMeme = await planRoute({ kind: 'swap', from: BASE_ETH, to: NEAR_MEME, amount: 10n ** 16n, fromAddress: EVM, toAddress: 'alice.near', slippage: 0.01 });
    assert.deepEqual(shape(nearMeme), ['ETH@8453>wNEAR@397:50', 'wNEAR@397>MEME@397:0']);
    assert.equal(nearMeme[1].from.address, 'wrap.near', 'the Ref step spends the delivered wNEAR');

    // One step when NEAR Intents lists both ends, or when NEAR isn't involved at all.
    assert.equal((await planRoute({ kind: 'swap', from: NEAR_NATIVE, to: asset(8453, USDC_BASE, 'USDC', 6), amount: 1n, fromAddress: 'alice.near', toAddress: EVM, slippage: 0.01 })).length, 1);
    const solToBase = await planRoute({ kind: 'swap', from: SOL_NATIVE, to: DEGEN, amount: 10n ** 9n, fromAddress: SOL, toAddress: EVM, slippage: 0.01 });
    assert.deepEqual(shape(solToBase), ['SOL@1151111081099710>DEGEN@8453:50']);
  } finally {
    net.restore();
  }
});

test('fee-free plan steps ask LI.FI for no integrator fee', async () => {
  const net = mockFetch([['li.quest/v1/quote', () => lifiResponse()]]);
  try {
    const quote = await getRouteQuote({ kind: 'swap', from: BASE_ETH, to: DEGEN, amount: 10n ** 15n, fromAddress: EVM, toAddress: EVM, slippage: 0.01, feeBps: 0 });
    const url = new URL(net.calls[0].url);
    assert.equal(url.searchParams.get('fee'), '0');
    assert.equal(url.searchParams.get('type'), 'hop');
    assert.deepEqual(quote.fees, []);
  } finally {
    net.restore();
  }
});

test('executePlan runs step 2 with exactly what step 1 delivered (DEGEN → ETH → NEAR)', async () => {
  const sent = [];
  let balanceReads = 0;
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_sendTransaction') { sent.push(params[0]); return sent.length === 1 ? '0xstep1' : '0xstep2'; }
      return null;
    },
  };
  const net = mockFetch([
    ['1click.chaindefuser.com/v0/tokens', () => Response.json(INTENTS_TOKENS)],
    ['li.quest/v1/quote', () => lifiResponse({ estimate: { toAmount: '2000000000000000', toAmountMin: '1900000000000000', approvalAddress: LIFI_ROUTER } })],
    ['li.quest/v1/status', () => Response.json({ status: 'DONE', receiving: { txHash: '0xrecv', amount: '1950000000000000' } })],
    ['1click.chaindefuser.com/v0/quote', (_url, body) => Response.json({ quote: { depositAddress: '0xdeposit00000000000000000000000000000000', amountOut: '9000000000000000000000000', minAmountOut: '8900000000000000000000000' }, quoteRequest: body })],
    ['1click.chaindefuser.com/v0/deposit/submit', () => Response.json({})],
    ['mainnet.base.org', (_url, body) => {
      if (body.method === 'eth_call') return Response.json({ result: `0x${'f'.repeat(64)}` }); // allowance already set
      if (body.method === 'eth_getTransactionReceipt') return Response.json({ result: { status: '0x1' } });
      if (body.method === 'eth_getBalance') {
        balanceReads += 1;
        return Response.json({ result: `0x${(balanceReads === 1 ? 5_000_000_000_000_000n : 6_950_000_000_000_000n).toString(16)}` });
      }
      throw new Error(`Unexpected RPC ${body.method}`);
    }],
  ]);
  try {
    const legs = await planRoute({ kind: 'swap', from: DEGEN, to: NEAR_NATIVE, amount: 10n ** 21n, fromAddress: EVM, toAddress: 'alice.near', slippage: 0.01 });
    const steps = [];
    const { results } = await executePlan(legs, { evm: { provider, address: EVM } }, { onStepSent: (step, quote) => steps.push([step, quote.provider, quote.request.amount]) });
    assert.deepEqual(steps, [[0, 'lifi', 10n ** 21n], [1, 'intents', 1_950_000_000_000_000n]]);
    assert.equal(results[1].txHash, '0xstep2');
    // Step 2 deposits the ETH that arrived (as reported by LI.FI), not the quoted estimate.
    assert.equal(sent[1].to, '0xdeposit00000000000000000000000000000000');
    assert.equal(BigInt(sent[1].value), 1_950_000_000_000_000n);
    const intentsQuote = net.calls.find((call) => call.url.includes('/v0/quote') && call.body.dry === false).body;
    assert.equal(intentsQuote.appFees, undefined, 'the second step carries no Hopr fee');
  } finally {
    net.restore();
  }
});

test('Arc pays gas in USDC: LI.FI gets the 6-decimal 0x3600 token, which is approved before the swap', async () => {
  const ARC_USDC = '0x3600000000000000000000000000000000000000';
  const ARC_NATIVE = asset(5042, 'native', 'USDC', 18);
  const sent = [];
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x13b2';
      if (method === 'eth_sendTransaction') { sent.push(params[0]); return sent.length === 1 ? '0xapprove' : '0xswap'; }
      return null;
    },
  };
  const net = mockFetch([
    ['li.quest/v1/quote', () => lifiResponse({ estimate: { toAmount: '5000000', toAmountMin: '4900000', approvalAddress: LIFI_ROUTER }, transactionRequest: { to: LIFI_ROUTER, data: '0xabcdef', value: '0x0', chainId: 5042 } })],
    ['rpc.mainnet.arc.io', (_url, body) => Response.json({ result: body.method === 'eth_call' ? '0x0' : { status: '0x1' } })],
  ]);
  try {
    // 15 USDC of Arc gas (18 decimals in the wallet) → DEGEN on Base.
    const quote = await getRouteQuote({ kind: 'swap', from: ARC_NATIVE, to: DEGEN, amount: 15n * 10n ** 18n, fromAddress: EVM, toAddress: EVM, slippage: 0.01 }, { commit: true });
    const url = new URL(net.calls[0].url);
    assert.equal(url.searchParams.get('fromToken'), ARC_USDC);
    assert.equal(url.searchParams.get('fromAmount'), '15000000');
    await executeRoute(quote, { evm: { provider, address: EVM } });
    assert.equal(sent[0].to, ARC_USDC, 'the gas USDC is approved through its ERC-20 view');
    assert.equal(sent[0].data, `0x095ea7b3${LIFI_ROUTER.slice(2).padStart(64, '0')}${(15_000_000).toString(16).padStart(64, '0')}`);
    assert.equal(sent[1].to, LIFI_ROUTER);

    // Selling into Arc gas: LI.FI's 6-decimal output is scaled back to 18 decimals.
    const sell = await getRouteQuote({ kind: 'swap', from: DEGEN, to: ARC_NATIVE, amount: 10n ** 21n, fromAddress: EVM, toAddress: EVM, slippage: 0.01 });
    assert.equal(sell.expectedOut, 5_000_000n * 10n ** 12n);
  } finally {
    net.restore();
  }
});

test('when NEAR Intents cannot serve a chain, the plan crosses through ETH on Base instead', async () => {
  const CAKE = asset(56, '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', 'CAKE', 18);
  const tokens = [...INTENTS_TOKENS, { assetId: 'nep141:bsc.omft.near', blockchain: 'bsc', symbol: 'BNB', decimals: 18 }];
  const net = mockFetch([
    ['1click.chaindefuser.com/v0/tokens', () => Response.json(tokens)],
    ['1click.chaindefuser.com/v0/quote', (_url, body) => (body.destinationAsset === 'nep141:bsc.omft.near'
      ? Response.json({ message: 'Temporary swap limits: minimum swap amount is $1,000' }, { status: 400 })
      : Response.json({ quote: { amountOut: '2000000000000000', minAmountOut: '1950000000000000', amountOutUsd: '5.1' } }))],
    ['li.quest/v1/quote', () => lifiResponse({ estimate: { toAmount: '9000000000000000000', toAmountMin: '8900000000000000000', toAmountUSD: '5.0' } })],
  ]);
  try {
    const preview = await previewPlan({ kind: 'swap', from: NEAR_NATIVE, to: CAKE, amount: 10n ** 24n, fromAddress: 'alice.near', toAddress: EVM, slippage: 0.01 });
    assert.equal(describePlan(preview.legs), 'NEAR → ETH → CAKE');
    assert.deepEqual(preview.legs.map((leg) => `${leg.from.chainId}>${leg.to.chainId}:${leg.feeBps}`), ['397>8453:50', '8453>56:0']);
    const lifi = new URL(net.calls.find((call) => call.url.includes('li.quest')).url);
    assert.equal(lifi.searchParams.get('fromChain'), '8453');
    assert.equal(lifi.searchParams.get('toChain'), '56');
    assert.equal(preview.expectedOut, 9n * 10n ** 18n);
  } finally {
    net.restore();
  }
});
