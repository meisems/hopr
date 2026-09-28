import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { actionCreators, createTransaction, decodeSignedTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { KeyPair, PublicKey } from '@near-js/crypto';
import {
  buildRefSwapPlan,
  formatNearAmount,
  formatUnits,
  getNearBalance,
  getRefSwapQuote,
  isNearAccountId,
  NATIVE_NEAR,
  nearRpc,
  parseNearAmount,
  planAttachedDeposit,
  REF_EXCHANGE,
  resolveNearToken,
  WRAP_NEAR,
} from '../src/services/nearService.ts';
import { encodeNearTransaction, executeNearTransactions, generateNearWallet, importNearKey, nearPublicKeyOf, signNearTransaction } from '../src/services/nearSigner.ts';

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BRIDGED_USDC = 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near';

/** Real smart-router response shape (captured from smartrouter.ref.finance). */
const ROUTER_RESPONSE = {
  result_code: 0,
  result_message: '',
  result_data: {
    routes: [{
      pools: [
        { pool_id: '3', token_in: WRAP_NEAR, token_out: BRIDGED_USDC, amount_in: '1000000000000000000000000', amount_out: '0', min_amount_out: '0' },
        { pool_id: '5516', token_in: BRIDGED_USDC, token_out: USDC, amount_in: '0', amount_out: '0', min_amount_out: '5236549' },
      ],
      amount_in: '1000000000000000000000000',
      min_amount_out: '5236549',
      amount_out: '0',
    }],
    contract_in: WRAP_NEAR,
    contract_out: USDC,
    amount_in: '1000000000000000000000000',
    amount_out: '5262864',
  },
};

test('generated wallets are implicit accounts whose id is the hex public key', () => {
  const wallet = generateNearWallet();
  assert.match(wallet.address, /^[0-9a-f]{64}$/);
  assert.match(wallet.privateKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  const secret = bs58.decode(wallet.privateKey.slice(8));
  assert.equal(secret.length, 64);
  assert.equal(Buffer.from(secret.slice(32)).toString('hex'), wallet.address);
  // The official SDK derives the same public key and implicit address.
  const official = KeyPair.fromString(wallet.privateKey);
  assert.equal(official.getPublicKey().toString(), wallet.publicKey);
  assert.equal(Buffer.from(official.getPublicKey().data).toString('hex'), wallet.address);
});

test('importing a key round-trips and rejects mismatched or foreign keys', () => {
  const wallet = generateNearWallet();
  assert.equal(importNearKey(wallet.privateKey).accountId, wallet.address);
  assert.equal(importNearKey(wallet.privateKey, 'alice.near').accountId, 'alice.near');
  const seedOnly = `ed25519:${bs58.encode(bs58.decode(wallet.privateKey.slice(8)).slice(0, 32))}`;
  assert.equal(importNearKey(seedOnly).accountId, wallet.address);

  const tampered = bs58.decode(wallet.privateKey.slice(8));
  tampered[40] ^= 1;
  assert.throws(() => importNearKey(`ed25519:${bs58.encode(tampered)}`), /does not match/);
  assert.throws(() => importNearKey('secp256k1:abc'), /Only ed25519/);
  assert.throws(() => importNearKey(wallet.privateKey, 'Not A Valid Id'), /Invalid NEAR account id/);
});

test('recognises NEAR account ids without colliding with EVM or Solana addresses', () => {
  for (const id of ['alice.near', 'usdt.tether-token.near', USDC, BRIDGED_USDC, WRAP_NEAR, 'token.v2.ref-finance.near']) {
    assert.equal(isNearAccountId(id), true, id);
  }
  for (const id of ['0x1234567890abcdef1234567890abcdef12345678', 'So11111111111111111111111111111111111111112', 'hello', 'Alice.near', 'a..near', '-bad.near']) {
    assert.equal(isNearAccountId(id), false, id);
  }
  assert.equal(resolveNearToken('USDC'), USDC);
  assert.equal(resolveNearToken('near'), NATIVE_NEAR);
  assert.equal(resolveNearToken('what'), null);
});

test('amount helpers are exact for 24-decimal NEAR', () => {
  assert.equal(parseNearAmount('1'), 10n ** 24n);
  assert.equal(parseNearAmount('0.5'), 5n * 10n ** 23n);
  assert.equal(formatNearAmount('1234567800000000000000000000'), '1,234.5678');
  assert.equal(formatNearAmount('1'), '<0.0001');
  assert.equal(formatUnits('5236549', 6), '5.2365');
  assert.throws(() => parseNearAmount('1e3'), /Invalid amount/);
});

test('transaction encoding and signatures match the official @near-js encoder byte-for-byte', () => {
  const wallet = generateNearWallet();
  const publicKeyBytes = bs58.decode(wallet.publicKey.slice(8));
  const blockHash = sha256(new TextEncoder().encode('block'));
  const args = { receiver_id: REF_EXCHANGE, amount: '1000', msg: JSON.stringify({ force: 0, actions: [] }) };
  const ours = encodeNearTransaction({
    signerId: wallet.address,
    publicKey: publicKeyBytes,
    nonce: 123456789012n,
    receiverId: WRAP_NEAR,
    blockHash,
    actions: [
      { type: 'FunctionCall', methodName: 'near_deposit', args: {}, gas: 10_000_000_000_000n, deposit: 10n ** 24n },
      { type: 'FunctionCall', methodName: 'ft_transfer_call', args, gas: 180_000_000_000_000n, deposit: 1n },
      { type: 'Transfer', deposit: 42n },
    ],
  });

  const officialTx = createTransaction(wallet.address, PublicKey.fromString(wallet.publicKey), WRAP_NEAR, 123456789012n, [
    actionCreators.functionCall('near_deposit', {}, 10_000_000_000_000n, 10n ** 24n),
    actionCreators.functionCall('ft_transfer_call', args, 180_000_000_000_000n, 1n),
    actionCreators.transfer(42n),
  ], blockHash);
  assert.deepEqual(Buffer.from(ours), Buffer.from(encodeTransaction(officialTx)));

  const { signedTx, hash } = signNearTransaction(ours, wallet.privateKey);
  const officialSignature = KeyPair.fromString(wallet.privateKey).sign(sha256(ours));
  const officialSigned = new SignedTransaction({ transaction: officialTx, signature: new Signature({ keyType: 0, data: officialSignature.signature }) });
  assert.deepEqual(Buffer.from(signedTx), Buffer.from(encodeTransaction(officialSigned)));
  assert.equal(hash, bs58.encode(sha256(ours)));
  assert.equal(ed25519.verify(officialSignature.signature, sha256(ours), publicKeyBytes), true);
});

test('RPC client fails over on rate limits and surfaces contract errors immediately', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === 'https://keyed.example') return new Response('slow down', { status: 429 });
    if (url === 'https://free.rpc.fastnear.com') return Response.json({ jsonrpc: '2.0', error: { code: -429, message: 'Rate limits exceeded' } });
    return Response.json({ jsonrpc: '2.0', result: { ok: 1 } });
  };
  assert.deepEqual(await nearRpc('status', [], { urls: ['https://keyed.example'], fetchImpl }), { ok: 1 });
  assert.deepEqual(seen, ['https://keyed.example', 'https://free.rpc.fastnear.com', 'https://near.drpc.org']);

  let calls = 0;
  const failing = async () => {
    calls += 1;
    return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Server error', cause: { name: 'UNKNOWN_ACCOUNT' }, data: 'account does not exist' } });
  };
  await assert.rejects(nearRpc('query', {}, { fetchImpl: failing }), /does not exist/);
  assert.equal(calls, 1);
});

test('balances report spendable NEAR (minus storage) and non-zero NEP-141 tokens', async () => {
  const fetchImpl = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    if (params.request_type === 'view_account') {
      return Response.json({ result: { amount: '2500000000000000000000000', locked: '0', storage_usage: 1000 } });
    }
    const encode = (value) => ({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
    if (params.method_name === 'ft_balance_of') {
      // params.account_id is the token contract; only USDC holds a balance.
      assert.deepEqual(JSON.parse(Buffer.from(params.args_base64, 'base64').toString()), { account_id: 'bob.near' });
      return Response.json(encode(params.account_id === USDC ? '12500000' : '0'));
    }
    return Response.json(encode({ symbol: 'USDC', name: 'USD Coin', decimals: 6 }));
  };
  const balance = await getNearBalance('bob.near', [], { fetchImpl });
  assert.equal(balance.exists, true);
  assert.equal(balance.totalYocto, '2500000000000000000000000');
  assert.equal(balance.availableYocto, '2490000000000000000000000'); // 1000 bytes × 1e19 yocto held for storage
  assert.deepEqual(balance.tokens, [{ id: USDC, symbol: 'USDC', decimals: 6, balance: '12500000' }]);

  const missing = await getNearBalance(generateNearWallet().address, [], {
    fetchImpl: async () => Response.json({ error: { code: -32000, message: 'Server error', cause: { name: 'UNKNOWN_ACCOUNT' } } }),
  });
  assert.deepEqual({ exists: missing.exists, total: missing.totalYocto }, { exists: false, total: '0' });
});

test('Ref quote keeps amount_in on first hops and slippage-protected min_amount_out on final hops', async () => {
  let requested;
  const quote = await getRefSwapQuote({
    tokenIn: NATIVE_NEAR,
    tokenOut: USDC,
    amountIn: '1000000000000000000000000',
    slippage: 0.005,
    fetchImpl: async (url) => { requested = new URL(url); return Response.json(ROUTER_RESPONSE); },
  });
  assert.equal(requested.searchParams.get('tokenIn'), WRAP_NEAR);
  assert.equal(requested.searchParams.get('slippage'), '0.005');
  assert.equal(quote.minOut, '5236549');
  assert.equal(quote.expectedOut, '5262864');
  assert.equal(quote.hops, 2);
  assert.deepEqual(quote.actions, [
    { pool_id: 3, token_in: WRAP_NEAR, token_out: BRIDGED_USDC, amount_in: '1000000000000000000000000', min_amount_out: '0' },
    { pool_id: 5516, token_in: BRIDGED_USDC, token_out: USDC, min_amount_out: '5236549' },
  ]);

  await assert.rejects(getRefSwapQuote({ tokenIn: NATIVE_NEAR, tokenOut: 'usdt.tether-token.near', amountIn: '1000000000000000000000000', slippage: 0.01, fetchImpl: async () => Response.json(ROUTER_RESPONSE) }), /different pair/);
  await assert.rejects(getRefSwapQuote({ tokenIn: NATIVE_NEAR, tokenOut: USDC, amountIn: '5', slippage: 0.01, fetchImpl: async () => Response.json(ROUTER_RESPONSE) }), /does not spend/);
  await assert.rejects(getRefSwapQuote({ tokenIn: NATIVE_NEAR, tokenOut: USDC, amountIn: '1', slippage: 0.01, fetchImpl: async () => Response.json({ result_code: 0, result_data: { routes: [] } }) }), /No Ref Finance route/);
});

test('buying with NEAR wraps and swaps in one transaction after registering the output token', async () => {
  const quote = await getRefSwapQuote({ tokenIn: NATIVE_NEAR, tokenOut: USDC, amountIn: '1000000000000000000000000', slippage: 0.005, fetchImpl: async () => Response.json(ROUTER_RESPONSE) });
  const plans = buildRefSwapPlan(quote, { outputStorageDeposit: 1_250_000_000_000_000_000_000n, wrapStorageDeposit: 1_250_000_000_000_000_000_000n });
  assert.deepEqual(plans.map((plan) => plan.receiverId), [USDC, WRAP_NEAR]);
  assert.deepEqual(plans[1].actions.map((action) => action.methodName), ['storage_deposit', 'near_deposit', 'ft_transfer_call']);
  const transfer = plans[1].actions[2];
  assert.equal(transfer.args.receiver_id, REF_EXCHANGE);
  assert.equal(transfer.deposit, 1n);
  assert.deepEqual(JSON.parse(transfer.args.msg), { force: 0, actions: quote.actions });
  assert.equal(planAttachedDeposit(plans), 10n ** 24n + 2n * 1_250_000_000_000_000_000_000n + 1n);
  for (const plan of plans) assert.ok(plan.actions.reduce((gas, action) => gas + action.gas, 0n) <= 300_000_000_000_000n, 'fits the 300 Tgas limit');
});

test('selling into NEAR asks Ref to unwrap and never registers for wNEAR', () => {
  const quote = {
    tokenIn: USDC, tokenOut: NATIVE_NEAR, amountIn: '5000000', expectedOut: '1', minOut: '1', hops: 1, slippage: 0.01,
    actions: [{ pool_id: 1, token_in: USDC, token_out: WRAP_NEAR, amount_in: '5000000', min_amount_out: '1' }],
  };
  const plans = buildRefSwapPlan(quote, { outputStorageDeposit: 5n, wrapStorageDeposit: 5n });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].receiverId, USDC);
  assert.deepEqual(JSON.parse(plans[0].actions[0].args.msg), { force: 0, actions: quote.actions, skip_unwrap_near: false });
});

test('execution signs sequential nonces against the latest block hash and stops on failure', async () => {
  const wallet = generateNearWallet();
  const blockHash = bs58.encode(sha256(new TextEncoder().encode('recent')));
  const sent = [];
  const rpc = (failSecond) => async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'query') return Response.json({ result: { nonce: 41, block_hash: blockHash, permission: 'FullAccess' } });
    const signed = decodeSignedTransaction(Buffer.from(body.params.signed_tx_base64, 'base64'));
    sent.push(signed);
    assert.equal(body.params.wait_until, 'EXECUTED_OPTIMISTIC');
    if (failSecond && sent.length === 2) {
      return Response.json({ result: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E68: slippage error' } } } } } } });
    }
    return Response.json({ result: { status: { SuccessValue: '' }, receipts_outcome: [] } });
  };
  const plans = [
    { receiverId: USDC, label: 'Register output token', actions: [{ type: 'FunctionCall', methodName: 'storage_deposit', args: {}, gas: 1n, deposit: 1n }] },
    { receiverId: WRAP_NEAR, label: 'Wrap NEAR and swap on Ref Finance', actions: [{ type: 'Transfer', deposit: 2n }] },
  ];

  const result = await executeNearTransactions(wallet.address, wallet.privateKey, plans, { fetchImpl: rpc(false) });
  assert.equal(result.confirmed, true);
  assert.deepEqual(sent.map((tx) => tx.transaction.nonce), [42n, 43n]);
  assert.deepEqual(sent.map((tx) => tx.transaction.receiverId), [USDC, WRAP_NEAR]);
  for (const tx of sent) {
    assert.equal(bs58.encode(tx.transaction.blockHash), blockHash);
    // Borsh decoding yields the raw enum shape { ed25519Key: { data } }.
    const signerKey = Uint8Array.from(tx.transaction.publicKey.ed25519Key.data);
    assert.equal(`ed25519:${bs58.encode(signerKey)}`, nearPublicKeyOf(wallet.privateKey));
    const signature = Uint8Array.from(tx.signature.ed25519Signature.data);
    assert.equal(ed25519.verify(signature, sha256(encodeTransaction(tx.transaction)), signerKey), true);
  }
  assert.equal(result.hashes[0], bs58.encode(sha256(encodeTransaction(sent[0].transaction))));

  sent.length = 0;
  await assert.rejects(executeNearTransactions(wallet.address, wallet.privateKey, plans, { fetchImpl: rpc(true) }), /slippage error/);
});

test('execution explains that an unfunded implicit account must be funded first', async () => {
  const wallet = generateNearWallet();
  await assert.rejects(
    executeNearTransactions(wallet.address, wallet.privateKey, [{ receiverId: WRAP_NEAR, label: 'x', actions: [{ type: 'Transfer', deposit: 1n }] }], {
      fetchImpl: async () => Response.json({ error: { code: -32000, message: 'Server error', cause: { name: 'UNKNOWN_ACCOUNT' }, data: 'account does not exist' } }),
    }),
    /Fund it with NEAR first/,
  );
});
