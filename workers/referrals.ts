// Referral program: codes, first-touch bindings, server-verified trade
// rewards, and payout requests. See migrations/0005 and 0006.
//
// Referrers earn REFERRAL_SHARE (25%) of Hopr's fee revenue AFTER the
// routing provider's share (0.5% trades, 1% bridges before splitting). Rewards are never taken
// from client-supplied numbers — every reported trade is checked against
// the route provider first:
//   LI.FI ......... status API: DONE, Hopr's integrator id, sent by the referred
//                   wallet; the fee is LI.FI's own integrator-fee figure
//   NEAR Intents .. 1Click status: SUCCESS, refunds to the referred wallet,
//                   Hopr's app fee attached; revenue uses the saved quote-time split
//   Ref Finance ... NEAR RPC: the swap transaction was signed by the referred
//                   account and carries the ft_transfer of Hopr's fee
//
// Identities are wallets (web) or `tg:<telegram user id>` (the Telegram bot
// and Mini App share one). Binding is authenticated: a wallet must sign the
// invite message (walletProof.ts); a Telegram user is authenticated by
// Telegram itself (/start payload or verified Mini App initData). Hopr
// custodial wallets inherit their Telegram user's referrer server-side, so
// bot trades, Mini App trades and web trades all land on one account.

import { verifyWalletProof, type WalletProof } from './walletProof';
import type { IntentsFeeRecord } from './intentsFees';

export const REFERRAL_SHARE = 0.25; // of Hopr's fee revenue after the provider's share
export const PLATFORM_FEE = { swap: 0.005, bridge: 0.01 } as const;
const DEFAULT_MIN_PAYOUT_USD = 5;
const MAX_VERIFY_ATTEMPTS = 40;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const REF_EXCHANGE = 'v2.ref-finance.near';

export interface ReferralEnv {
  DB?: D1Database;
  LIFI_INTEGRATOR?: string;
  /** Hopr's NEAR account: receives the NEAR Intents app fee and the Ref swap fee. */
  HOPR_INTENTS_FEE_ACCOUNT?: string;
  NEAR_RPC_URL?: string;
  /** Bearer token for the payout admin endpoints. */
  ADMIN_TOKEN?: string;
  REFERRAL_MIN_PAYOUT_USD?: string;
}

type Vm = 'evm' | 'svm' | 'near' | 'tg';

/** Canonical form of a wallet address, and which ecosystem it belongs to. */
export function normalizeWallet(value: unknown): { wallet: string; vm: Exclude<Vm, 'tg'> } | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return { wallet: raw.toLowerCase(), vm: 'evm' };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return { wallet: raw, vm: 'svm' };
  const lower = raw.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(lower) || (/^(([a-z\d]+[-_])*[a-z\d]+\.)+(near|tg)$/.test(lower) && lower.length <= 64)) return { wallet: lower, vm: 'near' };
  return null;
}

/** The referral identity of a Telegram user (bot and Mini App). */
export const telegramIdentity = (userId: string | number) => `tg:${userId}`;

function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().replace(/^ref[_-]/, '');
  return /^[a-z0-9]{4,16}$/.test(code) ? code : null;
}

function randomCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

function json(data: unknown, corsHeaders: Record<string, string>, status = 200) {
  return Response.json(data, { status, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface TradeRow {
  id: string;
  tx_hash: string;
  code: string;
  wallet: string;
  provider: string;
  chain_id: number;
  deposit_address: string | null;
  status: string;
  attempts: number;
  created_at: number;
}

type Verdict =
  | { status: 'verified'; volumeUsd: number; feeUsd: number }
  | { status: 'rejected' | 'ineligible'; reason: string }
  | { status: 'pending'; reason: string };

interface LifiStatus {
  status?: string;
  fromAddress?: string;
  metadata?: { integrator?: string };
  sending?: { amountUSD?: string; chainId?: number; token?: { coinKey?: string; symbol?: string } };
  receiving?: { chainId?: number; token?: { coinKey?: string; symbol?: string } };
  feeCosts?: Array<{ amount?: string; amountUSD?: string; feeSplit?: { integratorFee?: string } }>;
}

/** Hopr's share of a LI.FI transfer's fees in USD, from LI.FI's integrator-fee split. */
export function lifiPlatformFeeUsd(data: LifiStatus): number | null {
  const split = (data.feeCosts ?? []).filter((cost) => cost.feeSplit?.integratorFee !== undefined);
  if (split.length > 0) {
    let total = 0;
    for (const cost of split) {
      const amount = Number(cost.amount);
      const usd = Number(cost.amountUSD);
      const integrator = Number(cost.feeSplit!.integratorFee);
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(usd) || usd < 0 ||
          !Number.isFinite(integrator) || integrator < 0 || integrator > amount) return null;
      total += (usd * integrator) / amount;
    }
    return total;
  }
  // Unknown provider revenue must not be turned into a payable reward.
  return null;
}

function decodeArgs(base64: unknown): Record<string, unknown> {
  try {
    return typeof base64 === 'string' ? JSON.parse(atob(base64)) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function nearRpcCall<T>(env: ReferralEnv, method: string, params: unknown, fetchImpl: typeof fetch): Promise<{ result?: T; error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown } }> {
  const response = await fetchImpl(env.NEAR_RPC_URL || 'https://free.rpc.fastnear.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'hopr-referrals', method, params }),
  });
  return await response.json() as { result?: T; error?: { name?: string; message?: string } };
}

async function nearTokenDecimals(env: ReferralEnv, token: string, fetchImpl: typeof fetch): Promise<number | null> {
  if (token === 'wrap.near') return 24;
  const data = await nearRpcCall<{ result?: number[] }>(env, 'query', { request_type: 'call_function', finality: 'final', account_id: token, method_name: 'ft_metadata', args_base64: 'e30=' }, fetchImpl);
  try {
    const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(data.result?.result ?? []))) as { decimals?: number };
    return typeof metadata.decimals === 'number' ? metadata.decimals : null;
  } catch {
    return null;
  }
}

async function nearTokenPriceUsd(token: string, fetchImpl: typeof fetch): Promise<number | null> {
  try {
    const response = await fetchImpl(`https://indexer.ref.finance/get-token-price?token_id=${encodeURIComponent(token)}`);
    const price = Number((await response.json() as { price?: string }).price);
    if (Number.isFinite(price) && price > 0) return price;
  } catch {
    // fall through to NEAR Intents' price list
  }
  try {
    const response = await fetchImpl('https://1click.chaindefuser.com/v0/tokens');
    const tokens = await response.json() as Array<{ assetId?: string; price?: number }>;
    const price = Number(tokens.find((item) => item.assetId === `nep141:${token}`)?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** Ref swap: the signed transaction must include Hopr's ft_transfer fee next to the swap. */
async function verifyRefTrade(row: TradeRow, env: ReferralEnv, fetchImpl: typeof fetch): Promise<Verdict> {
  const feeAccount = env.HOPR_INTENTS_FEE_ACCOUNT;
  if (!feeAccount) return { status: 'ineligible', reason: 'Hopr NEAR fee account not configured' };
  const data = await nearRpcCall<{
    transaction?: { signer_id?: string; receiver_id?: string; actions?: Array<Record<string, { method_name?: string; args?: string }> | string> };
    transaction_outcome?: { outcome?: { receipt_ids?: string[] } };
    receipts_outcome?: Array<{ id?: string; outcome?: { status?: Record<string, unknown> } }>;
  }>(env, 'tx', { tx_hash: row.tx_hash, sender_account_id: row.wallet, wait_until: 'EXECUTED_OPTIMISTIC' }, fetchImpl);
  if (!data.result) {
    const reason = data.error?.cause?.name ?? data.error?.name ?? 'UNKNOWN';
    return /INVALID_TRANSACTION|PARSE_ERROR/.test(reason) ? { status: 'rejected', reason: `NEAR RPC: ${reason}` } : { status: 'pending', reason };
  }
  const tx = data.result.transaction;
  if (tx?.signer_id !== row.wallet) return { status: 'rejected', reason: 'Signer does not match the referred wallet' };
  const calls = (tx.actions ?? []).flatMap((action) => (typeof action === 'object' && action.FunctionCall ? [{ method: action.FunctionCall.method_name, args: decodeArgs(action.FunctionCall.args) }] : []));
  const fee = calls.find((call) => call.method === 'ft_transfer' && call.args.receiver_id === feeAccount);
  const swap = calls.find((call) => call.method === 'ft_transfer_call' && call.args.receiver_id === REF_EXCHANGE);
  if (!swap) return { status: 'rejected', reason: 'Not a Ref Finance swap' };
  if (!fee) return { status: 'ineligible', reason: 'Hopr fee not attached' };
  const firstReceipt = data.result.transaction_outcome?.outcome?.receipt_ids?.[0];
  const receipt = data.result.receipts_outcome?.find((item) => item.id === firstReceipt);
  if (!receipt) return { status: 'pending', reason: 'receipt not executed yet' };
  if (receipt.outcome?.status && 'Failure' in receipt.outcome.status) return { status: 'rejected', reason: 'Transaction failed' };

  const token = tx.receiver_id ?? '';
  const [decimals, price] = await Promise.all([nearTokenDecimals(env, token, fetchImpl), nearTokenPriceUsd(token, fetchImpl)]);
  if (decimals === null || price === null) return { status: 'pending', reason: 'Token price unavailable' };
  const units = (value: unknown) => Number(typeof value === 'string' ? value : '0') / 10 ** decimals;
  const feeUsd = units(fee.args.amount) * price;
  const volumeUsd = (units(fee.args.amount) + units(swap.args.amount)) * price;
  if (!(feeUsd > 0)) return { status: 'ineligible', reason: 'No Hopr fee paid' };
  return { status: 'verified', volumeUsd, feeUsd };
}

export async function verifyTrade(row: TradeRow, env: ReferralEnv, fetchImpl: typeof fetch = fetch): Promise<Verdict> {
  if (row.provider === 'ref') return verifyRefTrade(row, env, fetchImpl);

  if (row.provider === 'lifi') {
    const response = await fetchImpl(`https://li.quest/v1/status?txHash=${encodeURIComponent(row.tx_hash)}`, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({})) as LifiStatus;
    if (data.status === 'DONE') {
      const integrator = env.LIFI_INTEGRATOR ?? 'hopr';
      if (data.metadata?.integrator !== integrator) return { status: 'rejected', reason: 'Not routed through Hopr' };
      if (normalizeWallet(data.fromAddress)?.wallet !== row.wallet) return { status: 'rejected', reason: 'Sender does not match the referred wallet' };
      const volume = Number(data.sending?.amountUSD);
      if (!Number.isFinite(volume) || volume <= 0) return { status: 'rejected', reason: 'No USD volume reported' };
      const feeUsd = lifiPlatformFeeUsd(data);
      if (feeUsd === null) return { status: 'pending', reason: 'Awaiting LI.FI integrator fee split' };
      if (!(feeUsd > 0)) return { status: 'ineligible', reason: 'No Hopr fee on this route' };
      return { status: 'verified', volumeUsd: volume, feeUsd };
    }
    if (data.status === 'FAILED' || data.status === 'INVALID') return { status: 'rejected', reason: `LI.FI status ${data.status}` };
    return { status: 'pending', reason: data.status ?? 'NOT_FOUND' };
  }

  if (row.provider === 'intents') {
    if (!env.HOPR_INTENTS_FEE_ACCOUNT) return { status: 'ineligible', reason: 'Hopr Intents fee account not configured' };
    if (!row.deposit_address) return { status: 'rejected', reason: 'Missing deposit address' };
    const response = await fetchImpl(`https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(row.deposit_address)}`);
    const data = await response.json().catch(() => ({})) as {
      status?: string;
      quoteResponse?: { quote?: { amountInUsd?: string }; quoteRequest?: { refundTo?: string; appFees?: Array<{ recipient?: string; fee?: number }> } };
      swapDetails?: { amountInUsd?: string; originChainTxHashes?: Array<{ hash: string }> };
    };
    if (data.status === 'SUCCESS') {
      const request = data.quoteResponse?.quoteRequest;
      if (normalizeWallet(request?.refundTo)?.wallet !== row.wallet) return { status: 'rejected', reason: 'Depositor does not match the referred wallet' };
      const bps = (request?.appFees ?? []).filter((fee) => fee.recipient === env.HOPR_INTENTS_FEE_ACCOUNT).reduce((sum, fee) => sum + (fee.fee ?? 0), 0);
      if (!(bps > 0)) return { status: 'ineligible', reason: 'Hopr app fee not attached' };
      const saved = await env.DB?.prepare('SELECT * FROM intents_fee_quotes WHERE deposit_address = ?1')
        .bind(row.deposit_address).first<IntentsFeeRecord>();
      if (!saved) return { status: 'pending', reason: 'Quote-time fee agreement unavailable; reconciliation required' };
      if (saved.credited_trade_id && saved.credited_trade_id !== row.id) return { status: 'rejected', reason: 'Deposit already credited' };
      if (normalizeWallet(saved.refund_wallet)?.wallet !== row.wallet || saved.fee_account !== env.HOPR_INTENTS_FEE_ACCOUNT) {
        return { status: 'rejected', reason: 'Fee agreement does not match this trade' };
      }
      // Some provider responses normalize appFees to the effective recipient share.
      // Revenue always comes from our saved agreement, never by halving a response twice.
      if (bps !== saved.requested_bps && bps !== saved.hopr_bps) return { status: 'pending', reason: 'Provider fee differs from saved agreement' };
      const hashes = data.swapDetails?.originChainTxHashes;
      if (!hashes?.length) return { status: 'pending', reason: 'Awaiting deposit transaction confirmation' };
      const sameHash = (hash: string) => /^0x/i.test(hash) ? hash.toLowerCase() === row.tx_hash.toLowerCase() : hash === row.tx_hash;
      if (!hashes.some(({ hash }) => sameHash(hash))) return { status: 'rejected', reason: 'Deposit transaction does not match' };
      const volume = Number(data.swapDetails?.amountInUsd);
      if (!Number.isFinite(volume) || volume <= 0) return { status: 'rejected', reason: 'No USD volume reported' };
      return { status: 'verified', volumeUsd: volume, feeUsd: (volume * saved.hopr_bps) / 10_000 };
    }
    if (data.status === 'REFUNDED' || data.status === 'FAILED') return { status: 'rejected', reason: `Intents status ${data.status}` };
    return { status: 'pending', reason: data.status ?? 'PENDING' };
  }

  return { status: 'rejected', reason: 'Unknown provider' };
}

async function applyVerdict(row: TradeRow, verdict: Verdict, env: ReferralEnv): Promise<void> {
  const now = Date.now();
  if (verdict.status === 'verified') {
    if (row.provider === 'intents') {
      const claim = await env.DB!.prepare(`UPDATE intents_fee_quotes SET credited_trade_id = ?1
        WHERE deposit_address = ?2 AND (credited_trade_id IS NULL OR credited_trade_id = ?1)`)
        .bind(row.id, row.deposit_address).run();
      if (!claim.meta.changes) {
        await applyVerdict(row, { status: 'rejected', reason: 'Deposit already credited' }, env);
        return;
      }
    }
    await env.DB!.prepare(
      `UPDATE referral_trades SET status = 'verified', volume_usd = ?1, fee_usd = ?2, reward_usd = ?3, status_reason = NULL, verified_at = ?4, attempts = attempts + 1 WHERE id = ?5 AND status = 'pending'`
    ).bind(round(verdict.volumeUsd), round(verdict.feeUsd), round(verdict.feeUsd * REFERRAL_SHARE), now, row.id).run();
    return;
  }
  if (verdict.status === 'pending' && row.attempts + 1 < MAX_VERIFY_ATTEMPTS) {
    await env.DB!.prepare(`UPDATE referral_trades SET attempts = attempts + 1, status_reason = ?1 WHERE id = ?2`).bind(verdict.reason, row.id).run();
    return;
  }
  const status = verdict.status === 'pending' ? 'rejected' : verdict.status;
  const reason = verdict.status === 'pending' ? `Not confirmed by provider (${verdict.reason})` : verdict.reason;
  await env.DB!.prepare(`UPDATE referral_trades SET status = ?1, status_reason = ?2, attempts = attempts + 1 WHERE id = ?3 AND status = 'pending'`).bind(status, reason, row.id).run();
}

/** Re-check a few pending trades for a code (lazy verification; no cron needed). */
async function verifyPending(code: string, env: ReferralEnv, fetchImpl: typeof fetch, limit = 10): Promise<void> {
  const rows = await env.DB!.prepare(
    `SELECT * FROM referral_trades WHERE code = ?1 AND status = 'pending' ORDER BY created_at ASC LIMIT ?2`
  ).bind(code, limit).all<TradeRow>();
  await Promise.all((rows.results ?? []).map(async (row) => {
    try {
      await applyVerdict(row, await verifyTrade(row, env, fetchImpl), env);
    } catch {
      // Provider unreachable: leave pending for the next check.
    }
  }));
}

// ---------------------------------------------------------------------------
// Program operations (used by the HTTP API and by the Telegram bot)
// ---------------------------------------------------------------------------

async function codeFor(identity: string, env: ReferralEnv): Promise<string | null> {
  const row = await env.DB!.prepare(`SELECT code FROM referral_codes WHERE owner_wallet = ?1`).bind(identity).first<{ code: string }>();
  return row?.code ?? null;
}

/** The identity's referral code, created on first use. */
export async function ensureReferralCode(identity: string, env: ReferralEnv): Promise<string> {
  const existing = await codeFor(identity, env);
  if (existing) return existing;
  const vm: Vm = identity.startsWith('tg:') ? 'tg' : normalizeWallet(identity)?.vm ?? 'evm';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    const result = await env.DB!.prepare(
      `INSERT OR IGNORE INTO referral_codes (code, owner_wallet, owner_vm, created_at) VALUES (?1, ?2, ?3, ?4)`
    ).bind(code, identity, vm, Date.now()).run();
    if ((result.meta?.changes ?? 0) > 0) return code;
    const raced = await codeFor(identity, env); // a concurrent request may have created it
    if (raced) return raced;
  }
  throw new Error('Could not allocate a referral code');
}

async function bindingFor(identity: string, env: ReferralEnv): Promise<string | null> {
  const row = await env.DB!.prepare(`SELECT code FROM referral_bindings WHERE wallet = ?1`).bind(identity).first<{ code: string }>();
  return row?.code ?? null;
}

export type BindResult = { bound: boolean; reason?: string; status?: number };

/** Bind `identity` (a wallet or tg:<id>) to `code`: first touch wins, no self-referral. */
export async function bindReferral(identity: string, rawCode: unknown, env: ReferralEnv, telegramUserId?: string): Promise<BindResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { bound: false, reason: 'Invalid referral code', status: 400 };
  const owner = await env.DB!.prepare(`SELECT owner_wallet FROM referral_codes WHERE code = ?1`).bind(code).first<{ owner_wallet: string }>();
  if (!owner) return { bound: false, reason: 'Unknown referral code', status: 404 };
  if (owner.owner_wallet === identity || (telegramUserId && owner.owner_wallet === telegramIdentity(telegramUserId))) {
    return { bound: false, reason: 'You cannot refer yourself', status: 400 };
  }
  const result = await env.DB!.prepare(
    `INSERT OR IGNORE INTO referral_bindings (wallet, code, created_at, telegram_user_id) VALUES (?1, ?2, ?3, ?4)`
  ).bind(identity, code, Date.now(), telegramUserId ?? null).run();
  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await bindingFor(identity, env);
    return { bound: existing === code, reason: existing === code ? 'Already referred by this code' : 'Already has a referrer' };
  }
  return { bound: true };
}

/** Telegram user joined through a referral (bot /start or Mini App startapp). */
export function bindTelegramReferral(userId: string, code: unknown, env: ReferralEnv): Promise<BindResult> {
  return bindReferral(telegramIdentity(userId), code, env, userId);
}

/** Referrer code a trade by `wallet` pays into: the wallet's own binding, else its Telegram user's. */
async function referrerCodeFor(wallet: string, env: ReferralEnv, telegramUserId?: string): Promise<string | null> {
  const direct = await bindingFor(wallet, env);
  if (direct) return direct;
  if (!telegramUserId) return null;
  const inherited = await bindingFor(telegramIdentity(telegramUserId), env);
  if (!inherited) return null;
  // Remember the inheritance so later trades from this wallet (e.g. on the web) count too.
  await bindReferral(wallet, inherited, env, telegramUserId).catch(() => undefined);
  return inherited;
}

export interface TradeReport {
  wallet: string;
  txHash: string;
  provider: 'lifi' | 'intents' | 'ref';
  chainId: number;
  depositAddress?: string | null;
  /** Set when the trade came from the Telegram bot / Mini App custodial wallet. */
  telegramUserId?: string;
}

/** Record a referred trade and verify it now (or later, lazily, while it settles). */
export async function recordReferralTrade(report: TradeReport, env: ReferralEnv, fetchImpl: typeof fetch = fetch): Promise<{ recorded: boolean; status?: string; reason?: string }> {
  if (!env.DB) return { recorded: false, reason: 'Referrals are not configured' };
  const trader = normalizeWallet(report.wallet);
  const txHash = /^[A-Za-z0-9]{32,100}$/.test(report.txHash.replace(/^0x/, '')) ? report.txHash.trim() : null;
  if (!trader || !txHash) return { recorded: false, reason: 'Invalid trade' };
  const code = await referrerCodeFor(trader.wallet, env, report.telegramUserId);
  if (!code) return { recorded: false, reason: 'Wallet has no referrer' };
  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO referral_trades (id, tx_hash, code, wallet, provider, chain_id, deposit_address, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(id, txHash, code, trader.wallet, report.provider, report.chainId, report.depositAddress ?? null, Date.now()).run();
  if ((inserted.meta?.changes ?? 0) === 0) return { recorded: false, reason: 'Trade already recorded' };
  const row = await env.DB.prepare(`SELECT * FROM referral_trades WHERE id = ?1`).bind(id).first<TradeRow>();
  if (row) await applyVerdict(row, await verifyTrade(row, env, fetchImpl).catch(() => ({ status: 'pending', reason: 'provider unreachable' }) as Verdict), env);
  const status = await env.DB.prepare(`SELECT status FROM referral_trades WHERE id = ?1`).bind(id).first<{ status: string }>();
  return { recorded: true, status: status?.status ?? 'pending' };
}

export interface ReferralStatsResult {
  code: string | null;
  referredBy: string | null;
  share: number;
  minPayoutUsd: number;
  referredUsers?: number;
  trades?: number;
  pendingTrades?: number;
  volumeUsd?: number;
  feesUsd?: number;
  earnedUsd?: number;
  paidUsd?: number;
  requestedUsd?: number;
  claimableUsd?: number;
  recent?: Array<{ wallet: string; provider: string; chainId: number; volumeUsd: number; feeUsd: number; rewardUsd: number; status: string; reason: string | null; createdAt: number }>;
}

export async function referralStats(identity: string, env: ReferralEnv, fetchImpl: typeof fetch = fetch): Promise<ReferralStatsResult> {
  const code = await codeFor(identity, env);
  const minPayout = Number(env.REFERRAL_MIN_PAYOUT_USD) || DEFAULT_MIN_PAYOUT_USD;
  const referredBy = await bindingFor(identity, env);
  if (!code) return { code: null, referredBy, share: REFERRAL_SHARE, minPayoutUsd: minPayout };
  await verifyPending(code, env, fetchImpl);

  const referred = await env.DB!.prepare(
    `SELECT COUNT(DISTINCT COALESCE(telegram_user_id, wallet)) AS count FROM referral_bindings WHERE code = ?1`
  ).bind(code).first<{ count: number }>();
  const totals = await env.DB!.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'verified' THEN volume_usd END), 0) AS volume,
       COALESCE(SUM(CASE WHEN status = 'verified' THEN fee_usd END), 0) AS fees,
       COALESCE(SUM(CASE WHEN status = 'verified' THEN reward_usd END), 0) AS earned,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COUNT(*) AS trades
     FROM referral_trades WHERE code = ?1`
  ).bind(code).first<{ volume: number; fees: number; earned: number; pending: number; trades: number }>();
  const payouts = await env.DB!.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_usd END), 0) AS paid,
       COALESCE(SUM(CASE WHEN status = 'requested' THEN amount_usd END), 0) AS requested
     FROM referral_payouts WHERE code = ?1`
  ).bind(code).first<{ paid: number; requested: number }>();
  const recent = await env.DB!.prepare(
    `SELECT wallet, provider, chain_id, volume_usd, fee_usd, reward_usd, status, status_reason, created_at FROM referral_trades WHERE code = ?1 ORDER BY created_at DESC LIMIT 20`
  ).bind(code).all<{ wallet: string; provider: string; chain_id: number; volume_usd: number; fee_usd: number; reward_usd: number; status: string; status_reason: string | null; created_at: number }>();

  const earned = totals?.earned ?? 0;
  const paid = payouts?.paid ?? 0;
  const requested = payouts?.requested ?? 0;
  return {
    code,
    referredBy,
    share: REFERRAL_SHARE,
    minPayoutUsd: minPayout,
    referredUsers: referred?.count ?? 0,
    trades: totals?.trades ?? 0,
    pendingTrades: totals?.pending ?? 0,
    volumeUsd: round(totals?.volume ?? 0),
    feesUsd: round(totals?.fees ?? 0),
    earnedUsd: round(earned),
    paidUsd: round(paid),
    requestedUsd: round(requested),
    claimableUsd: round(Math.max(0, earned - paid - requested)),
    recent: (recent.results ?? []).map((row) => ({
      wallet: `${row.wallet.slice(0, 6)}…${row.wallet.slice(-4)}`,
      provider: row.provider,
      chainId: row.chain_id,
      volumeUsd: row.volume_usd,
      feeUsd: row.fee_usd,
      rewardUsd: row.reward_usd,
      status: row.status,
      reason: row.status_reason,
      createdAt: row.created_at,
    })),
  };
}

export type ClaimResult = { requested: true; id: string; amountUsd: number; payoutWallet: string } | { requested: false; error: string; status: number };

/** Request a payout of everything claimable. It goes to `payoutWallet` (the code owner's wallet, never client-chosen). */
export async function claimReferralRewards(identity: string, payoutWallet: string, env: ReferralEnv, fetchImpl: typeof fetch = fetch): Promise<ClaimResult> {
  const current = await referralStats(identity, env, fetchImpl);
  if (!current.code) return { requested: false, error: 'No referral code yet.', status: 404 };
  const claimable = current.claimableUsd ?? 0;
  if (claimable < current.minPayoutUsd) {
    return { requested: false, error: `Minimum payout is $${current.minPayoutUsd}. You have $${claimable.toFixed(2)} claimable.`, status: 400 };
  }
  const id = crypto.randomUUID();
  await env.DB!.prepare(
    `INSERT INTO referral_payouts (id, code, amount_usd, payout_wallet, status, created_at) VALUES (?1, ?2, ?3, ?4, 'requested', ?5)`
  ).bind(id, current.code, claimable, payoutWallet, Date.now()).run();
  return { requested: true, id, amountUsd: claimable, payoutWallet };
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

export interface ReferralHttpOptions {
  fetchImpl?: typeof fetch;
  /**
   * Verify Telegram Mini App initData. Returns the user and the wallet their
   * referral payouts go to (their Hopr custodial EVM wallet), or null.
   */
  resolveTelegram?: (initData: string) => Promise<{ userId: string; payoutWallet?: string; startParam?: string } | null>;
}

type Identity = { identity: string; payoutWallet?: string; telegramUserId?: string };

/** Who is asking: a Telegram user (verified initData) or a wallet. */
async function identify(source: Record<string, unknown>, options: ReferralHttpOptions): Promise<Identity | null> {
  const initData = typeof source.initData === 'string' ? source.initData : '';
  if (initData && options.resolveTelegram) {
    const user = initData.length <= 4096 ? await options.resolveTelegram(initData) : null;
    return user ? { identity: telegramIdentity(user.userId), payoutWallet: user.payoutWallet, telegramUserId: user.userId } : null;
  }
  const owner = normalizeWallet(source.wallet);
  return owner ? { identity: owner.wallet, payoutWallet: owner.wallet } : null;
}

/**
 * Route /api/referrals/* and /api/admin/referral-payouts*. Returns null for
 * paths it doesn't own.
 */
export async function handleReferralRequest(
  request: Request,
  path: string,
  env: ReferralEnv,
  corsHeaders: Record<string, string>,
  fetchOrOptions: typeof fetch | ReferralHttpOptions = {},
): Promise<Response | null> {
  if (!path.startsWith('/api/referrals') && !path.startsWith('/api/admin/referral-payouts')) return null;
  if (!env.DB) return json({ error: 'Referrals need the DB binding and migrations 0005–0006.' }, corsHeaders, 503);
  const options: ReferralHttpOptions = typeof fetchOrOptions === 'function' ? { fetchImpl: fetchOrOptions } : fetchOrOptions;
  const fetchImpl = options.fetchImpl ?? fetch;
  const needIdentity = () => json({ error: 'A valid wallet address or Telegram session is required.' }, corsHeaders, 400);

  try {
    if (path === '/api/referrals/code' && request.method === 'POST') {
      const who = await identify(await readBody(request), options);
      if (!who) return needIdentity();
      return json({ code: await ensureReferralCode(who.identity, env) }, corsHeaders);
    }

    if (path === '/api/referrals/stats' && (request.method === 'GET' || request.method === 'POST')) {
      const source = request.method === 'GET' ? { wallet: new URL(request.url).searchParams.get('wallet') } : await readBody(request);
      const who = await identify(source, options);
      if (!who) return needIdentity();
      return json(await referralStats(who.identity, env, fetchImpl), corsHeaders);
    }

    if (path === '/api/referrals/bind' && request.method === 'POST') {
      const body = await readBody(request);
      const initData = typeof body.initData === 'string' ? body.initData : '';

      if (initData) {
        // Mini App: bind the Telegram user (first touch). Returns the user's referrer
        // so the app can ask connected wallets to sign it too.
        const user = options.resolveTelegram && initData.length <= 4096 ? await options.resolveTelegram(initData) : null;
        if (!user) return json({ error: 'Telegram session could not be verified.' }, corsHeaders, 401);
        // The invite comes from the app (?ref / pending code) or the Mini App's startapp=ref_<code> link.
        const invite = body.code ?? (user.startParam?.startsWith('ref_') ? user.startParam : undefined);
        const result = invite ? await bindTelegramReferral(user.userId, invite, env) : null;
        const referredBy = await bindingFor(telegramIdentity(user.userId), env);
        return json({ bound: result?.bound ?? false, ...(result?.reason ? { reason: result.reason } : {}), referredBy }, corsHeaders);
      }

      const wallet = normalizeWallet(body.wallet);
      const code = normalizeCode(body.code);
      if (!wallet || !code) return json({ error: 'wallet and code are required.' }, corsHeaders, 400);
      // The wallet owner must sign the invite, so nobody can bind other people's wallets to their code.
      const proof = body.proof as WalletProof | undefined;
      const proven = proof ? await verifyWalletProof(wallet.wallet, wallet.vm, code, proof, env, fetchImpl) : false;
      if (!proven) return json({ bound: false, reason: 'Wallet signature missing or invalid' }, corsHeaders, 401);
      const result = await bindReferral(wallet.wallet, code, env);
      return json({ bound: result.bound, ...(result.reason ? { reason: result.reason } : {}) }, corsHeaders, result.status ?? 200);
    }

    if (path === '/api/referrals/trade' && request.method === 'POST') {
      const body = await readBody(request);
      const provider = body.provider === 'lifi' || body.provider === 'intents' || body.provider === 'ref' ? body.provider : null;
      const chainId = Number(body.chainId);
      const depositAddress = typeof body.depositAddress === 'string' && body.depositAddress.length <= 100 ? body.depositAddress : null;
      if (typeof body.wallet !== 'string' || typeof body.txHash !== 'string' || !provider || !Number.isFinite(chainId)) {
        return json({ error: 'wallet, txHash, provider and chainId are required.' }, corsHeaders, 400);
      }
      // Only the wallet's own (signed) binding counts here; custodial Telegram trades are recorded server-side.
      const result = await recordReferralTrade({ wallet: body.wallet, txHash: body.txHash, provider, chainId, depositAddress }, env, fetchImpl);
      if (result.reason === 'Invalid trade') return json({ error: 'wallet, txHash, provider and chainId are required.' }, corsHeaders, 400);
      return json(result.recorded ? { recorded: true, status: result.status } : { recorded: false, reason: result.reason }, corsHeaders);
    }

    if (path === '/api/referrals/claim' && request.method === 'POST') {
      const who = await identify(await readBody(request), options);
      if (!who) return needIdentity();
      if (!who.payoutWallet) return json({ error: 'Create your Hopr wallet in the bot first — payouts are sent to it.' }, corsHeaders, 400);
      const result = await claimReferralRewards(who.identity, who.payoutWallet, env, fetchImpl);
      return result.requested ? json(result, corsHeaders) : json({ error: result.error }, corsHeaders, result.status);
    }

    // --- Admin: payout queue -------------------------------------------------
    if (path.startsWith('/api/admin/referral-payouts')) {
      const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) return json({ error: 'Unauthorized' }, corsHeaders, 401);
      if (path === '/api/admin/referral-payouts' && request.method === 'GET') {
        const status = new URL(request.url).searchParams.get('status') ?? 'requested';
        const rows = await env.DB.prepare(`SELECT * FROM referral_payouts WHERE status = ?1 ORDER BY created_at ASC LIMIT 200`).bind(status).all();
        return json({ payouts: rows.results ?? [] }, corsHeaders);
      }
      if (path === '/api/admin/referral-payouts/paid' && request.method === 'POST') {
        const body = await readBody(request);
        if (typeof body.id !== 'string' || typeof body.txHash !== 'string') return json({ error: 'id and txHash are required.' }, corsHeaders, 400);
        const result = await env.DB.prepare(`UPDATE referral_payouts SET status = 'paid', payout_tx = ?1, paid_at = ?2 WHERE id = ?3 AND status = 'requested'`).bind(body.txHash, Date.now(), body.id).run();
        return json({ updated: (result.meta?.changes ?? 0) > 0 }, corsHeaders);
      }
    }

    return json({ error: 'Not found' }, corsHeaders, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Referral request failed';
    const missingSchema = /no such table: referral_|no such column|has no column named/.test(message);
    return json({ error: missingSchema ? 'Apply migrations/0005_referrals.sql and 0006_referral_fee_share.sql to enable referrals.' : message }, corsHeaders, missingSchema ? 503 : 500);
  }
}
