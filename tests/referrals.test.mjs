import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import {
  bindTelegramReferral,
  handleReferralRequest,
  lifiPlatformFeeUsd,
  normalizeWallet,
  recordReferralTrade,
  REFERRAL_SHARE,
  referralStats,
  telegramIdentity,
} from '../workers/referrals.ts';
import { nep413Hash, personalMessageHash, verifyWalletProof } from '../workers/walletProof.ts';
import { referralProofMessage } from '../src/services/referralMessage.ts';

/** Cloudflare D1 API over an in-memory SQLite database with the real migrations applied. */
function createD1() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0005_referrals.sql', '0006_referral_fee_share.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...params) {
          const args = params.map((value) => (value === undefined ? null : value));
          return {
            async first() { return statement.get(...args) ?? null; },
            async all() { return { results: statement.all(...args) }; },
            async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
          };
        },
      };
    },
  };
}

// --- Wallets that can really sign ------------------------------------------------
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function evmWallet() {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const address = `0x${hex(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(-20))}`;
  const sign = (message) => {
    const signature = secp256k1.sign(personalMessageHash(message), privateKey);
    return `0x${hex(signature.toCompactRawBytes())}${(27 + signature.recovery).toString(16)}`;
  };
  return { address, sign };
}

const REFERRER = evmWallet();
const TRADER = evmWallet();
const TX = `0x${'1'.repeat(64)}`;
const cors = {};

function proofFor(wallet, code, issuedAt = new Date().toISOString()) {
  const message = referralProofMessage(wallet.address, code, issuedAt);
  return { message, signature: wallet.sign(message) };
}

function setup(extraEnv = {}) {
  const env = { DB: createD1(), ADMIN_TOKEN: 'admin-secret', HOPR_INTENTS_FEE_ACCOUNT: 'hopr-fees.near', ...extraEnv };
  let providerResponses = [];
  const fetchImpl = async (url, init) => {
    const next = providerResponses.find((item) => String(url).includes(item.match) && (!item.method || JSON.parse(init?.body ?? '{}').method === item.method));
    if (!next) throw new Error(`Unexpected provider call ${url}`);
    return Response.json(typeof next.body === 'function' ? next.body(init) : next.body);
  };
  // Telegram Mini App sessions: initData "tg:<id>[:start_param]" stands in for verified initData.
  const resolveTelegram = async (initData) => {
    const [prefix, userId, startParam] = initData.split(':');
    return prefix === 'tg' ? { userId, payoutWallet: `0x${userId.padStart(40, '0')}`, startParam } : null;
  };
  const call = async (method, path, body, headers = {}) => {
    const url = `https://worker.example${path}`;
    const request = new Request(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const response = await handleReferralRequest(request, new URL(url).pathname, env, cors, { fetchImpl, resolveTelegram });
    return { status: response.status, data: await response.json() };
  };
  return { env, call, fetchImpl, provide: (responses) => { providerResponses = responses; } };
}

const lifiDone = (overrides = {}) => ({
  match: 'li.quest',
  body: {
    status: 'DONE',
    fromAddress: TRADER.address,
    metadata: { integrator: 'hopr' },
    sending: { amountUSD: '1000.00', chainId: 8453, token: { coinKey: 'ETH' } },
    receiving: { chainId: 8453, token: { coinKey: 'DEGEN' } },
    // LI.FI's fee split: $7.50 total, of which $5.00 (0.5% of $1000) is Hopr's integrator fee.
    feeCosts: [{ amount: '7500000', amountUSD: '7.50', feeSplit: { lifiFee: '2500000', integratorFee: '5000000' } }],
    ...overrides,
  },
});

async function referredTrader(ctx) {
  const { data } = await ctx.call('POST', '/api/referrals/code', { wallet: REFERRER.address });
  const bound = await ctx.call('POST', '/api/referrals/bind', { wallet: TRADER.address, code: data.code, proof: proofFor(TRADER, data.code) });
  assert.equal(bound.data.bound, true);
  return data.code;
}

test('wallets are normalized per ecosystem', () => {
  assert.deepEqual(normalizeWallet(REFERRER.address.toUpperCase().replace('0X', '0x')), { wallet: REFERRER.address, vm: 'evm' });
  assert.deepEqual(normalizeWallet('Alice.NEAR'), { wallet: 'alice.near', vm: 'near' });
  assert.equal(normalizeWallet('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM').vm, 'svm');
  assert.equal(normalizeWallet('not a wallet'), null);
});

test('binding a wallet needs its signature: unsigned, forged, wrong-code and stale proofs are refused', async () => {
  const ctx = setup();
  const { data } = await ctx.call('POST', '/api/referrals/code', { wallet: REFERRER.address });
  assert.match(data.code, /^[a-z0-9]{8}$/);
  assert.equal((await ctx.call('POST', '/api/referrals/code', { wallet: REFERRER.address.toUpperCase().replace('0X', '0x') })).data.code, data.code);

  const unsigned = await ctx.call('POST', '/api/referrals/bind', { wallet: TRADER.address, code: data.code });
  assert.equal(unsigned.status, 401);
  // Someone else signing for the trader's wallet (the "bind every wallet to my code" attack).
  const attacker = evmWallet();
  const message = referralProofMessage(TRADER.address, data.code, new Date().toISOString());
  assert.equal((await ctx.call('POST', '/api/referrals/bind', { wallet: TRADER.address, code: data.code, proof: { message, signature: attacker.sign(message) } })).status, 401);
  const otherCode = (await ctx.call('POST', '/api/referrals/code', { wallet: attacker.address })).data.code;
  assert.equal((await ctx.call('POST', '/api/referrals/bind', { wallet: TRADER.address, code: otherCode, proof: proofFor(TRADER, data.code) })).status, 401);
  const stale = proofFor(TRADER, data.code, new Date(Date.now() - 3 * 24 * 3600_000).toISOString());
  assert.equal((await ctx.call('POST', '/api/referrals/bind', { wallet: TRADER.address, code: data.code, proof: stale })).status, 401);

  // Self-referral and first touch.
  assert.equal((await ctx.call('POST', '/api/referrals/bind', { wallet: REFERRER.address, code: data.code, proof: proofFor(REFERRER, data.code) })).data.bound, false);
  assert.equal((await ctx.call('POST', '/api/referrals/bind', { wallet: TRADER.address, code: data.code, proof: proofFor(TRADER, data.code) })).data.bound, true);
  const steal = await ctx.call('POST', '/api/referrals/bind', { wallet: TRADER.address, code: otherCode, proof: proofFor(TRADER, otherCode) });
  assert.equal(steal.data.bound, false);
  assert.match(steal.data.reason, /already has a referrer/i);
});

test('Solana and NEAR wallets prove ownership with signMessage (ed25519 / NEP-413)', async () => {
  const code = 'abcd2345';
  const solanaKey = ed25519.utils.randomPrivateKey();
  const solanaAddress = bs58.encode(ed25519.getPublicKey(solanaKey));
  const solMessage = referralProofMessage(solanaAddress, code, new Date().toISOString());
  const solSignature = Buffer.from(ed25519.sign(new TextEncoder().encode(solMessage), solanaKey)).toString('base64');
  assert.equal(await verifyWalletProof(solanaAddress, 'svm', code, { message: solMessage, signature: solSignature }, {}), true);
  assert.equal(await verifyWalletProof('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'svm', code, { message: solMessage, signature: solSignature }, {}), false);

  const nearKey = ed25519.utils.randomPrivateKey();
  const nearPublic = ed25519.getPublicKey(nearKey);
  const implicit = hex(nearPublic);
  const nearMessage = referralProofMessage(implicit, code, new Date().toISOString());
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const nearProof = {
    message: nearMessage,
    signature: Buffer.from(ed25519.sign(nep413Hash(nearMessage, nonce, 'hopr'), nearKey)).toString('base64'),
    publicKey: `ed25519:${bs58.encode(nearPublic)}`,
    nonce: Buffer.from(nonce).toString('base64'),
  };
  assert.equal(await verifyWalletProof(implicit, 'near', code, nearProof, {}), true);
  // Named accounts must hold the key as a full-access key.
  const named = referralProofMessage('alice.near', code, new Date().toISOString());
  const namedProof = { ...nearProof, message: named, signature: Buffer.from(ed25519.sign(nep413Hash(named, nonce, 'hopr'), nearKey)).toString('base64') };
  const rpc = (permission) => async () => Response.json({ result: { permission } });
  assert.equal(await verifyWalletProof('alice.near', 'near', code, namedProof, {}, rpc('FullAccess')), true);
  assert.equal(await verifyWalletProof('alice.near', 'near', code, namedProof, {}, rpc({ FunctionCall: {} })), false);
});

test(`a verified LI.FI trade earns ${REFERRAL_SHARE * 100}% of the Hopr fee LI.FI reports`, async () => {
  const ctx = setup();
  await referredTrader(ctx);
  ctx.provide([lifiDone()]);
  const reported = await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: TX, provider: 'lifi', chainId: 8453 });
  assert.deepEqual(reported.data, { recorded: true, status: 'verified' });

  const { data } = await ctx.call('GET', `/api/referrals/stats?wallet=${REFERRER.address}`);
  assert.equal(data.share, 0.25);
  assert.equal(data.referredUsers, 1);
  assert.equal(data.volumeUsd, 1000);
  assert.equal(data.feesUsd, 5);
  assert.equal(data.earnedUsd, 1.25); // 25% of the $5 platform fee
  assert.equal(data.claimableUsd, 1.25);
  assert.equal(data.recent[0].feeUsd, 5);

  const duplicate = await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: TX, provider: 'lifi', chainId: 8453 });
  assert.equal(duplicate.data.recorded, false);
});

test('without a fee split the standard rate applies: 0.5% trades, 1% same-asset bridges', () => {
  assert.equal(lifiPlatformFeeUsd({ sending: { chainId: 8453, token: { coinKey: 'ETH' } }, receiving: { chainId: 8453, token: { coinKey: 'DEGEN' } } }, 1000), 5);
  assert.equal(lifiPlatformFeeUsd({ sending: { chainId: 8453, token: { coinKey: 'ETH' } }, receiving: { chainId: 42161, token: { coinKey: 'ETH' } } }, 1000), 10);
  assert.equal(lifiPlatformFeeUsd({ feeCosts: [{ amount: '100', amountUSD: '0.25', feeSplit: { integratorFee: '0' } }] }, 1000), 0);
});

test('trades not routed through Hopr, sent by another wallet, or without a Hopr fee earn nothing', async () => {
  const ctx = setup();
  await referredTrader(ctx);
  ctx.provide([lifiDone({ metadata: { integrator: 'someone-else' } })]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: TX, provider: 'lifi', chainId: 8453 })).data.status, 'rejected');
  ctx.provide([lifiDone({ fromAddress: REFERRER.address })]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: `0x${'2'.repeat(64)}`, provider: 'lifi', chainId: 8453 })).data.status, 'rejected');
  ctx.provide([lifiDone({ feeCosts: [{ amount: '100', amountUSD: '0.25', feeSplit: { integratorFee: '0' } }] })]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: `0x${'3'.repeat(64)}`, provider: 'lifi', chainId: 8453 })).data.status, 'ineligible');

  const { data } = await ctx.call('GET', `/api/referrals/stats?wallet=${REFERRER.address}`);
  assert.equal(data.earnedUsd, 0);
});

test('pending cross-chain trades are verified later when stats are read', async () => {
  const ctx = setup();
  await referredTrader(ctx);
  ctx.provide([{ match: 'li.quest', body: { status: 'PENDING' } }]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: TX, provider: 'lifi', chainId: 42161 })).data.status, 'pending');
  ctx.provide([lifiDone({ sending: { amountUSD: '250' }, feeCosts: [{ amount: '1', amountUSD: '1.25', feeSplit: { integratorFee: '1' } }] })]);
  const { data } = await ctx.call('GET', `/api/referrals/stats?wallet=${REFERRER.address}`);
  assert.equal(data.earnedUsd, 0.3125);
  assert.equal(data.pendingTrades, 0);
});

test('NEAR Intents trades earn on Hopr’s app-fee bps; routes without it are ineligible', async () => {
  const ctx = setup();
  await referredTrader(ctx);
  const intents = (appFees) => ({ match: '1click', body: { status: 'SUCCESS', swapDetails: { amountInUsd: '500' }, quoteResponse: { quoteRequest: { refundTo: TRADER.address, appFees } } } });

  ctx.provide([intents([{ recipient: 'hopr-fees.near', fee: 50 }])]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: TX, provider: 'intents', chainId: 8453, depositAddress: 'deposit-1' })).data.status, 'verified');
  ctx.provide([intents([{ recipient: 'someone.near', fee: 50 }])]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: `0x${'3'.repeat(64)}`, provider: 'intents', chainId: 8453, depositAddress: 'deposit-2' })).data.status, 'ineligible');

  const { data } = await ctx.call('GET', `/api/referrals/stats?wallet=${REFERRER.address}`);
  assert.equal(data.feesUsd, 2.5);
  assert.equal(data.earnedUsd, 0.625);
});

test('Ref Finance swaps earn when the signed transaction carries Hopr’s fee transfer', async () => {
  const ctx = setup();
  const code = (await ctx.call('POST', '/api/referrals/code', { wallet: REFERRER.address })).data.code;
  const nearKey = ed25519.utils.randomPrivateKey();
  const trader = hex(ed25519.getPublicKey(nearKey));
  const message = referralProofMessage(trader, code, new Date().toISOString());
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  await ctx.call('POST', '/api/referrals/bind', { wallet: trader, code, proof: {
    message,
    signature: Buffer.from(ed25519.sign(nep413Hash(message, nonce, 'hopr'), nearKey)).toString('base64'),
    publicKey: `ed25519:${bs58.encode(ed25519.getPublicKey(nearKey))}`,
    nonce: Buffer.from(nonce).toString('base64'),
  } });

  const args = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
  const refTx = (withFee, failed = false) => ({
    match: 'fastnear',
    method: 'tx',
    body: { result: {
      transaction: { signer_id: trader, receiver_id: 'wrap.near', actions: [
        { FunctionCall: { method_name: 'near_deposit', args: args({}) } },
        ...(withFee ? [{ FunctionCall: { method_name: 'ft_transfer', args: args({ receiver_id: 'hopr-fees.near', amount: (5n * 10n ** 23n).toString() }) } }] : []),
        { FunctionCall: { method_name: 'ft_transfer_call', args: args({ receiver_id: 'v2.ref-finance.near', amount: (995n * 10n ** 23n).toString(), msg: '{}' }) } },
      ] },
      transaction_outcome: { outcome: { receipt_ids: ['r1'] } },
      receipts_outcome: [{ id: 'r1', outcome: { status: failed ? { Failure: {} } : { SuccessReceiptId: 'r2' } } }],
    } },
  });
  const price = { match: 'indexer.ref.finance', body: { price: '5' } };

  ctx.provide([refTx(true), price]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: trader, txHash: 'A'.repeat(44), provider: 'ref', chainId: 397 })).data.status, 'verified');
  ctx.provide([refTx(false), price]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: trader, txHash: 'B'.repeat(44), provider: 'ref', chainId: 397 })).data.status, 'ineligible');
  ctx.provide([refTx(true, true), price]);
  assert.equal((await ctx.call('POST', '/api/referrals/trade', { wallet: trader, txHash: 'C'.repeat(44), provider: 'ref', chainId: 397 })).data.status, 'rejected');

  const { data } = await ctx.call('GET', `/api/referrals/stats?wallet=${REFERRER.address}`);
  assert.equal(data.volumeUsd, 500); // 100 NEAR × $5
  assert.equal(data.feesUsd, 2.5); // 0.5 NEAR fee × $5
  assert.equal(data.earnedUsd, 0.625);
});

test('Telegram: /start invite + bot trades + Mini App wallets all credit the same referrer', async () => {
  const ctx = setup();
  const code = (await ctx.call('POST', '/api/referrals/code', { wallet: REFERRER.address })).data.code;

  // The bot binds the Telegram user from /start ref_<code>; the first invite wins.
  assert.equal((await bindTelegramReferral('555', `ref_${code}`, ctx.env)).bound, true);
  assert.equal((await bindTelegramReferral('555', 'ref_other123', ctx.env)).bound, false);

  // A custodial bot trade (recorded server-side) inherits the Telegram user's referrer.
  const custodial = '0x00000000000000000000000000000000000c0de5';
  ctx.provide([lifiDone({ fromAddress: custodial })]);
  const recorded = await recordReferralTrade({ wallet: custodial, txHash: TX, provider: 'lifi', chainId: 8453, telegramUserId: '555' }, ctx.env, ctx.fetchImpl);
  assert.deepEqual(recorded, { recorded: true, status: 'verified' });

  // The Mini App sees the same binding and passes it to wallets connected there.
  const miniApp = await ctx.call('POST', '/api/referrals/bind', { initData: 'tg:555' });
  assert.equal(miniApp.data.referredBy, code);

  const stats = await referralStats(REFERRER.address, ctx.env, ctx.fetchImpl);
  assert.equal(stats.referredUsers, 1, 'the Telegram user and their custodial wallet are one friend');
  assert.equal(stats.earnedUsd, 1.25);

  // Unauthenticated reports cannot borrow a Telegram user's referrer for other wallets.
  ctx.provide([lifiDone({ fromAddress: TRADER.address })]);
  const outsider = await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: `0x${'9'.repeat(64)}`, provider: 'lifi', chainId: 8453, initData: 'tg:555' });
  assert.equal(outsider.data.recorded, false);
});

test('Telegram identities own one code in the bot and the Mini App, and claim to their Hopr wallet', async () => {
  const ctx = setup({ REFERRAL_MIN_PAYOUT_USD: '1' });
  const fromMiniApp = (await ctx.call('POST', '/api/referrals/code', { initData: 'tg:777' })).data.code;
  const botStats = await referralStats(telegramIdentity('777'), ctx.env, ctx.fetchImpl);
  assert.equal(botStats.code, fromMiniApp, 'the bot’s /referral shows the Mini App’s code');

  // A friend opens the Mini App via t.me/<bot>/app?startapp=ref_<code>.
  const joined = await ctx.call('POST', '/api/referrals/bind', { initData: `tg:888:ref_${fromMiniApp}` });
  assert.equal(joined.data.bound, true);
  assert.equal((await ctx.call('POST', '/api/referrals/bind', { initData: `tg:777:ref_${fromMiniApp}` })).data.bound, false, 'no self-referral');

  const friendWallet = '0x0000000000000000000000000000000000000888';
  ctx.provide([lifiDone({ fromAddress: friendWallet, sending: { amountUSD: '2000' }, feeCosts: [{ amount: '1', amountUSD: '10', feeSplit: { integratorFee: '1' } }] })]);
  await recordReferralTrade({ wallet: friendWallet, txHash: TX, provider: 'lifi', chainId: 8453, telegramUserId: '888' }, ctx.env, ctx.fetchImpl);

  const stats = (await ctx.call('POST', '/api/referrals/stats', { initData: 'tg:777' })).data;
  assert.equal(stats.earnedUsd, 2.5);
  const claim = await ctx.call('POST', '/api/referrals/claim', { initData: 'tg:777' });
  assert.equal(claim.data.requested, true);
  assert.equal(claim.data.payoutWallet, `0x${'777'.padStart(40, '0')}`);
  assert.equal((await ctx.call('POST', '/api/referrals/code', { initData: 'bogus' })).status, 400);
});

test('unreferred wallets record nothing', async () => {
  const ctx = setup();
  const response = await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: TX, provider: 'lifi', chainId: 8453 });
  assert.deepEqual(response.data, { recorded: false, reason: 'Wallet has no referrer' });
});

test('claims respect the minimum, pay only the code owner, and the admin queue marks them paid', async () => {
  const ctx = setup({ REFERRAL_MIN_PAYOUT_USD: '5' });
  await referredTrader(ctx);
  ctx.provide([lifiDone({ sending: { amountUSD: '3000' }, feeCosts: [{ amount: '1', amountUSD: '15', feeSplit: { integratorFee: '1' } }] })]);
  await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: TX, provider: 'lifi', chainId: 8453 });

  const tooSmall = await ctx.call('POST', '/api/referrals/claim', { wallet: REFERRER.address });
  assert.equal(tooSmall.status, 400); // $3.75 < $5 minimum

  ctx.provide([lifiDone({ sending: { amountUSD: '4000' }, feeCosts: [{ amount: '1', amountUSD: '20', feeSplit: { integratorFee: '1' } }] })]);
  await ctx.call('POST', '/api/referrals/trade', { wallet: TRADER.address, txHash: `0x${'5'.repeat(64)}`, provider: 'lifi', chainId: 8453 });
  const claim = await ctx.call('POST', '/api/referrals/claim', { wallet: REFERRER.address });
  assert.equal(claim.data.requested, true);
  assert.equal(claim.data.amountUsd, 8.75);
  assert.equal(claim.data.payoutWallet, REFERRER.address);
  assert.equal((await ctx.call('GET', `/api/referrals/stats?wallet=${REFERRER.address}`)).data.claimableUsd, 0);
  assert.equal((await ctx.call('POST', '/api/referrals/claim', { wallet: REFERRER.address })).status, 400);

  assert.equal((await ctx.call('GET', '/api/admin/referral-payouts')).status, 401);
  const auth = { Authorization: 'Bearer admin-secret' };
  const queue = await ctx.call('GET', '/api/admin/referral-payouts', undefined, auth);
  assert.equal(queue.data.payouts.length, 1);
  const paid = await ctx.call('POST', '/api/admin/referral-payouts/paid', { id: claim.data.id, txHash: '0xpaid' }, auth);
  assert.equal(paid.data.updated, true);
  const after = await ctx.call('GET', `/api/referrals/stats?wallet=${REFERRER.address}`);
  assert.equal(after.data.paidUsd, 8.75);
  assert.equal(after.data.requestedUsd, 0);
});
