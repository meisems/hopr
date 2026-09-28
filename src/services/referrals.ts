// Referral program client. Links look like https://hopr.app/?ref=<code> or
// https://t.me/<bot>?start=ref_<code>. Referrers earn 25% of the Hopr fees
// their friends pay (0.5% trades, 1% bridges).
//
// The code is remembered on first visit (first touch). A connected wallet
// accepts the invite by signing a free message (no transaction), so nobody
// can attach other people's wallets to their code. Inside the Telegram Mini
// App the Telegram user itself is the referral identity — the same one the
// bot uses — so the bot, the Mini App and the web share one account.

import { API_BASE_URL, apiUrl } from './api';
import type { RouteProvider } from './router';
import { referralProofMessage } from './referralMessage';

const PENDING_KEY = 'hopr-referral-code';
const BOUND_PREFIX = 'hopr-referral-bound:';
const DECLINED_PREFIX = 'hopr-referral-declined:';

/** Referrals need the worker API (VITE_API_URL). */
export const referralsEnabled = API_BASE_URL.length > 0;

/** Referrers' share of the platform fee. */
export const REFERRAL_SHARE_PERCENT = 25;

export interface WalletProof {
  message: string;
  signature: string;
  publicKey?: string;
  nonce?: string;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const telegramInitData = () => window.Telegram?.WebApp?.initData ?? '';
export const inTelegram = () => Boolean(telegramInitData());

function normalizeCode(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase().replace(/^ref[_-]/, '');
  return code && /^[a-z0-9]{4,16}$/.test(code) ? code : null;
}

/** Save ?ref=<code> (or a Mini App startapp=ref_<code>) — first touch wins — and clean the address bar. */
export function captureReferralFromUrl() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('ref') ?? url.searchParams.get('r');
  const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
  const code = normalizeCode(fromUrl) ?? (startParam?.startsWith('ref_') ? normalizeCode(startParam) : null);
  if (code && !storage()?.getItem(PENDING_KEY)) storage()?.setItem(PENDING_KEY, code);
  if (fromUrl !== null) {
    url.searchParams.delete('ref');
    url.searchParams.delete('r');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
}

export function pendingReferralCode(): string | null {
  return storage()?.getItem(PENDING_KEY) ?? null;
}

export function referralLink(code: string): string {
  return `${window.location.origin}/?ref=${code}`;
}

export function telegramReferralLink(code: string, botUrl: string): string {
  return `${botUrl.replace(/\/$/, '')}?start=ref_${code}`;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
  if (!response.ok) throw Object.assign(new Error(data.error ?? data.reason ?? 'Referral service unavailable'), { status: response.status });
  return data;
}

/**
 * Inside the Telegram Mini App: bind the Telegram user to the invite (if
 * any) and learn their referrer, so connected wallets can accept it too.
 */
export async function syncTelegramReferral(): Promise<void> {
  const initData = telegramInitData();
  if (!referralsEnabled || !initData) return;
  try {
    const pending = pendingReferralCode();
    const result = await post<{ referredBy?: string | null }>('/api/referrals/bind', { initData, ...(pending ? { code: pending } : {}) });
    if (result.referredBy && !pending) storage()?.setItem(PENDING_KEY, result.referredBy);
  } catch {
    // Service down: retried next launch.
  }
}

export type ReferralSigner = (message: string) => Promise<WalletProof>;

/**
 * Accept the pending invite with a connected wallet (once per wallet). The
 * wallet signs a free message proving it agrees; nothing is sent on-chain.
 * Returns true when the wallet is (now) settled with a referrer.
 */
const inFlight = new Set<string>();

export async function bindReferral(wallet: string, sign: ReferralSigner, options: { force?: boolean } = {}): Promise<boolean> {
  const code = pendingReferralCode();
  const store = storage();
  if (!referralsEnabled || !code || store?.getItem(`${BOUND_PREFIX}${wallet}`) || inFlight.has(wallet)) return false;
  if (!options.force && store?.getItem(`${DECLINED_PREFIX}${wallet}`)) return false;
  inFlight.add(wallet);
  try {
    return await acceptInvite(wallet, code, sign, store);
  } finally {
    inFlight.delete(wallet);
  }
}

async function acceptInvite(wallet: string, code: string, sign: ReferralSigner, store: Storage | null): Promise<boolean> {
  let proof: WalletProof;
  try {
    proof = await sign(referralProofMessage(wallet, code, new Date().toISOString()));
  } catch {
    store?.setItem(`${DECLINED_PREFIX}${wallet}`, '1'); // don't nag; the Rewards page can retry
    return false;
  }
  try {
    const result = await post<{ bound: boolean; reason?: string }>('/api/referrals/bind', { wallet, code, proof });
    // Settled either way (bound now, already bound elsewhere, or self-referral): don't retry.
    if (result.bound || result.reason) store?.setItem(`${BOUND_PREFIX}${wallet}`, code);
    store?.removeItem(`${DECLINED_PREFIX}${wallet}`);
    return result.bound;
  } catch (error) {
    if ((error as { status?: number }).status === 400 || (error as { status?: number }).status === 404) store?.setItem(`${BOUND_PREFIX}${wallet}`, code);
    return false;
  }
}

/** Whether this wallet still has an invite to accept (it was declined or not signed yet). */
export function inviteAwaitingSignature(wallet: string | null | undefined): boolean {
  return Boolean(wallet && referralsEnabled && pendingReferralCode() && !storage()?.getItem(`${BOUND_PREFIX}${wallet}`));
}

/** Report an executed trade; the worker verifies it with the provider before any reward. */
export function reportReferralTrade(trade: { wallet: string; txHash: string; chainId: number; provider: RouteProvider; depositAddress?: string }) {
  if (!referralsEnabled || !trade.txHash) return;
  void post('/api/referrals/trade', trade).catch(() => undefined);
}

export interface ReferralStats {
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

/** Who the Rewards page acts for: the Telegram user in the Mini App, otherwise a wallet. */
export type ReferralIdentity = { telegram: true } | { wallet: string };

const identityBody = (identity: ReferralIdentity) => ('telegram' in identity ? { initData: telegramInitData() } : { wallet: identity.wallet });

export async function getReferralCode(identity: ReferralIdentity): Promise<string> {
  return (await post<{ code: string }>('/api/referrals/code', identityBody(identity))).code;
}

export async function getReferralStats(identity: ReferralIdentity): Promise<ReferralStats> {
  return post<ReferralStats>('/api/referrals/stats', identityBody(identity));
}

export async function claimReferralRewards(identity: ReferralIdentity): Promise<{ amountUsd: number; payoutWallet: string }> {
  return post('/api/referrals/claim', identityBody(identity));
}
