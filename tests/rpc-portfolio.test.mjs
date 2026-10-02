import test from 'node:test';
import assert from 'node:assert/strict';
import { configureRpcEndpoints, jsonRpc, rpcEndpoints } from '../src/services/rpcPool.ts';
import { applyRpcConfig, keyedRpcUrls, transactionRpc } from '../workers/rpcConfig.ts';

test('keyed endpoints from the worker secrets go ahead of every public backup', () => {
  const env = { ALCHEMY_API_KEY: 'alc', HELIUS_API_KEY: 'hel', RPC_ROBINHOOD: 'https://rh-a.example/rpc, https://rh-b.example/rpc', RPC_BASE: 'http://insecure.example' };
  assert.deepEqual(keyedRpcUrls(env, 8453), ['https://base-mainnet.g.alchemy.com/v2/alc'], 'non-HTTPS URLs are ignored');
  assert.deepEqual(keyedRpcUrls(env, 1151111081099710), ['https://mainnet.helius-rpc.com/?api-key=hel', 'https://solana-mainnet.g.alchemy.com/v2/alc']);
  assert.deepEqual(keyedRpcUrls(env, 4663), ['https://rh-a.example/rpc', 'https://rh-b.example/rpc']);
  applyRpcConfig(env);
  try {
    assert.deepEqual(rpcEndpoints(4663).slice(0, 2), ['https://rh-a.example/rpc', 'https://rh-b.example/rpc']);
    assert.ok(rpcEndpoints(4663).length >= 5, 'public backups stay behind the keyed endpoints');
    assert.equal(rpcEndpoints(8453)[0], 'https://base-mainnet.g.alchemy.com/v2/alc');
  } finally {
    applyRpcConfig({});
  }
  assert.ok(!rpcEndpoints(8453).some((url) => url.includes('alchemy')), 'removing the secret removes the endpoint');
});

test('a public node that blocks a method is skipped, not treated as a call error', async () => {
  let attempts = 0;
  const result = await jsonRpc(1151111081099710, 'getTokenAccountsByOwner', [], {
    extra: ['https://blocked.example'],
    fetchImpl: async () => (++attempts === 1
      ? Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Request blocked' } })
      : Response.json({ jsonrpc: '2.0', id: 1, result: { value: [] } })),
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result, { value: [] });
});

test('transactions only go to an endpoint that is answering and on the right chain', async () => {
  configureRpcEndpoints(5042, ['https://wrong-chain.example', 'https://good.example']);
  try {
    const url = await transactionRpc(5042, async (endpoint) => endpoint === 'https://wrong-chain.example'
      ? Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' })
      : endpoint === 'https://good.example' ? Response.json({ jsonrpc: '2.0', id: 1, result: '0x13b2' }) : Response.json({}, { status: 500 }));
    assert.equal(url, 'https://good.example');
  } finally {
    configureRpcEndpoints(5042, []);
  }
  await assert.rejects(transactionRpc(4663, async () => { throw new Error('offline'); }), /No transaction was sent/);
});

test('a slow chain never holds up the home screen: it is listed as loading, then cached when done', async () => {
  const { loadPortfolio, pendingPortfolioLoad } = await import('../workers/portfolio.ts');
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('1click')) return Response.json([{ symbol: 'SOL', price: 100 }]);
    const body = JSON.parse(init.body);
    if (body.method === 'getBalance') {
      await new Promise((resolve) => setTimeout(resolve, 300)); // a slow Solana RPC
      return Response.json({ jsonrpc: '2.0', id: 1, result: { value: 2_000_000_000 } });
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result: { value: [] } });
  };
  const wallet = { solanaAddress: 'Fm8Yk3sKBG1NrpZZbQ7ZmYPNTq7nUa6hfcJkBhRpHoWk' };
  try {
    const partial = await loadPortfolio(wallet, {}, { budgetMs: 50 });
    assert.deepEqual(partial.pendingChains, [1151111081099710]);
    assert.equal(partial.holdings.length, 0);
    await pendingPortfolioLoad(wallet);
    const full = await loadPortfolio(wallet, {});
    assert.deepEqual(full.pendingChains, []);
    assert.equal(full.holdings[0].symbol, 'SOL');
    assert.equal(full.totalUsd, 200);
  } finally {
    globalThis.fetch = original;
  }
});
