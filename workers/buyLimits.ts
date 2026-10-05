// The range of amounts a buy can actually complete, per route, so the Buy
// buttons (and ✏️ Buy X) never offer an amount that is bound to fail:
// - min: the smallest amount the route can carry through. Below it the fees of
//   a later step (gas, token-account rent, NEAR gas) would eat the whole
//   amount, or bridges have nothing to route.
// - max: what the wallet can spend after keeping that step's fees.
// Minimums that depend on another coin are converted with live USD prices and
// a safety margin; when prices are unknown only hard limits apply.

import { getNetwork } from '../src/services/chains';
import { getNearBalance, NEAR_CHAIN_ID, NEAR_GAS_RESERVE_YOCTO, type NearRpcOptions } from '../src/services/nearService';
import { nativePricesUsd, readNativeBalance } from './balances';
import { gasReserve } from './gasReserve';
import { SOLANA_CHAIN_ID } from './rpcConfig';

export interface BuyLimits {
  /** Smallest amount that completes, in the pay-from coin. */
  min: number;
  /** Most the wallet can spend after fees (null = balance unknown). */
  max: number | null;
  symbol: string;
  /** Why the minimum is what it is, for messages. */
  reason: string;
}

export interface BuyRoute {
  tokenChainId: number;
  tokenAddress: string;
  fundingChainId: number;
  wallet: { evmAddress: string | null; solanaAddress: string | null; nearAddress?: string | null };
  near: NearRpcOptions;
}

/** Chains NEAR Intents delivers to directly; others hop through Base. */
const INTENTS_HUBS = new Set([8453, 42161, 56, 4663, SOLANA_CHAIN_ID]);
const BASE_CHAIN_ID = 8453;
/** Extra on top of computed minimums: prices move between the card and the trade. */
const MARGIN = 1.5;
/** Bridges and aggregators have nothing to route below these (USD). */
const MIN_CROSS_CHAIN_USD = 1;
const MIN_SAME_CHAIN_USD = 0.1;
/** NEAR Intents rejects dust; Ref swaps need something left after storage. */
const MIN_NEAR_INTENTS = 0.1;
const MIN_NEAR_REF = 0.01;
/** NEAR kept back on a NEAR-funded trade: gas plus a first storage registration. */
const NEAR_TRADE_RESERVE = NEAR_GAS_RESERVE_YOCTO + 10_000_000_000_000_000_000_000n; // 0.06 NEAR

const units = (value: bigint, decimals: number) => Number(value) / 10 ** decimals;
const decimalsOf = (chainId: number) => chainId === NEAR_CHAIN_ID ? 24 : chainId === SOLANA_CHAIN_ID ? 9 : 18;
const symbolOf = (chainId: number) => getNetwork(chainId)?.nativeSymbol ?? 'native';

function ownerOn(wallet: BuyRoute['wallet'], chainId: number): string | null {
  return chainId === NEAR_CHAIN_ID ? wallet.nearAddress ?? null : chainId === SOLANA_CHAIN_ID ? wallet.solanaAddress : wallet.evmAddress;
}

async function nearAvailable(accountId: string | null | undefined, near: NearRpcOptions): Promise<bigint | null> {
  if (!accountId) return 0n;
  try {
    return BigInt((await getNearBalance(accountId, [], near)).availableYocto);
  } catch {
    return null;
  }
}

async function heldOn(chainId: number, owner: string | null): Promise<bigint | null> {
  if (!owner) return 0n;
  return readNativeBalance(chainId, owner).catch(() => null);
}

export async function buyLimits(route: BuyRoute): Promise<BuyLimits> {
  const { tokenChainId, fundingChainId, wallet, near } = route;
  const symbol = symbolOf(fundingChainId);
  const prices = await nativePricesUsd().catch(() => ({} as Record<string, number>));
  const usd = (chainId: number) => prices[symbolOf(chainId).toUpperCase()] ?? 0;
  const fundingUsd = usd(fundingChainId);
  const fromUsd = (amountUsd: number, floor: number) => Math.max(fundingUsd > 0 ? amountUsd / fundingUsd : 0, floor);

  // Pay with NEAR.
  if (fundingChainId === NEAR_CHAIN_ID) {
    const available = await nearAvailable(wallet.nearAddress, near);
    const max = available === null ? null : Math.max(0, units(available - NEAR_TRADE_RESERVE, 24));
    if (tokenChainId === NEAR_CHAIN_ID) {
      return { min: MIN_NEAR_REF, max, symbol, reason: 'Ref Finance keeps ~0.06 NEAR for gas and storage' };
    }
    // NEAR → the chain's coin → the token: the final swap's fees come out of what arrives,
    // unless the wallet already holds that coin there.
    const hub = INTENTS_HUBS.has(tokenChainId) ? tokenChainId : BASE_CHAIN_ID;
    const owner = ownerOn(wallet, hub);
    const [reserve, held] = await Promise.all([
      gasReserve(hub, 'swap', { owner: owner ?? undefined, mint: hub === tokenChainId ? route.tokenAddress : undefined }),
      heldOn(hub, owner),
    ]);
    const shortfall = held === null ? reserve : reserve > held ? reserve - held : 0n;
    const shortfallUsd = units(shortfall, decimalsOf(hub)) * usd(hub);
    // 1.8×: after the fees, most of a fee's worth is still left to swap (prices exclude bridge fees).
    const min = fromUsd(shortfallUsd * 1.8, MIN_NEAR_INTENTS);
    const coin = symbolOf(hub);
    return {
      min, max, symbol,
      reason: shortfall > 0n
        ? `the swap on ${getNetwork(hub)?.name ?? 'the token chain'} needs ~${units(reserve, decimalsOf(hub)).toPrecision(2)} ${coin} for fees${hub === SOLANA_CHAIN_ID ? ' and the token account' : ''}, paid from what arrives`
        : 'NEAR Intents has a small minimum',
    };
  }

  // Pay with an EVM or Solana coin.
  const owner = ownerOn(wallet, fundingChainId);
  const intoNear = tokenChainId === NEAR_CHAIN_ID;
  const sameChain = fundingChainId === tokenChainId;
  const [reserve, held, nearHeld] = await Promise.all([
    gasReserve(fundingChainId, intoNear && INTENTS_HUBS.has(fundingChainId) ? 'transfer' : 'swap', {
      owner: owner ?? undefined,
      mint: sameChain && fundingChainId === SOLANA_CHAIN_ID ? route.tokenAddress : undefined,
    }),
    heldOn(fundingChainId, owner),
    intoNear ? nearAvailable(wallet.nearAddress, near) : Promise.resolve(0n),
  ]);
  const max = held === null ? null : Math.max(0, units(held - reserve, decimalsOf(fundingChainId)));
  if (intoNear) {
    // What arrives on NEAR pays NEAR gas first, unless the NEAR wallet already holds it, then swaps on Ref.
    const heldNear = nearHeld ?? 0n;
    const nearShortfall = NEAR_GAS_RESERVE_YOCTO > heldNear ? NEAR_GAS_RESERVE_YOCTO - heldNear : 0n;
    const neededNear = units(nearShortfall, 24) + 0.02;
    const min = fromUsd(neededNear * usd(NEAR_CHAIN_ID) * MARGIN, 0);
    return { min: Math.max(min, fromUsd(MIN_CROSS_CHAIN_USD, 0)), max, symbol, reason: nearShortfall > 0n ? 'NEAR gas (~0.05 NEAR) is paid from what arrives' : 'cross-chain routes need about $1' };
  }
  return {
    min: fromUsd(sameChain ? MIN_SAME_CHAIN_USD : MIN_CROSS_CHAIN_USD, 0),
    max,
    symbol,
    reason: sameChain ? 'tiny swaps cost more in fees than they buy' : 'cross-chain routes need about $1',
  };
}

/* ---- Button amounts ------------------------------------------------------ */

/** Round up to a "nice" amount: 1, 2, 2.5, 5 × 10^n. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 0;
  const exponent = Math.floor(Math.log10(value));
  const scale = 10 ** exponent;
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * scale >= value * (1 - 1e-9)) ?? 10;
  return Number((step * scale).toPrecision(6));
}

/** Round down to 3 significant digits (for "Max"). */
export function floorSignificant(value: number): number {
  if (!(value > 0)) return 0;
  const exponent = Math.floor(Math.log10(value));
  const scale = 10 ** (exponent - 2);
  return Number((Math.floor(value / scale) * scale).toPrecision(6));
}

/** Plain decimal text, no exponent, no trailing zeros. */
export function formatAmount(value: number): string {
  if (!(value > 0)) return '0';
  const digits = Math.max(0, Math.min(18, 3 - Math.floor(Math.log10(value))));
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

/**
 * Up to three buy amounts within [min, max]: the chain's presets that fit,
 * topped up with round amounts from the minimum, and the wallet's maximum
 * when the presets run past it. Empty when even the minimum is unaffordable.
 */
export function buyButtonAmounts(presets: string[], limits: BuyLimits | null): string[] {
  if (!limits) return presets.slice(0, 3);
  const { min, max } = limits;
  if (max !== null && max < min) return [];
  const fits = (value: number) => value >= min * (1 - 1e-9) && (max === null || value <= max);
  const picks = new Set<number>();
  // A preset below the minimum is replaced by the smallest round amount that works.
  if (presets.some((preset) => Number(preset) < min) && fits(niceCeil(min))) picks.add(niceCeil(min));
  for (const preset of presets.map(Number).filter(fits)) picks.add(preset);
  for (const factor of [1, 2, 5, 10, 20]) {
    if (picks.size >= 3) break;
    const candidate = niceCeil(min * factor);
    if (fits(candidate)) picks.add(candidate);
  }
  if (picks.size < 3 && max !== null) {
    const top = floorSignificant(max);
    if (fits(top)) picks.add(top);
  }
  return [...picks].sort((left, right) => left - right).slice(0, 3).map(formatAmount);
}

/** Why an amount can't be bought on this route, or null when it fits. */
export function buyAmountProblem(amount: number, limits: BuyLimits): string | null {
  if (amount < limits.min * (1 - 1e-9)) {
    return `The minimum for this route is ${formatAmount(niceCeil(limits.min))} ${limits.symbol} — ${limits.reason}.`;
  }
  if (limits.max !== null && amount > limits.max) {
    return limits.max >= limits.min
      ? `You can spend up to ${formatAmount(floorSignificant(limits.max))} ${limits.symbol} after network fees.`
      : `Your wallet can't cover the minimum of ${formatAmount(niceCeil(limits.min))} ${limits.symbol} plus fees yet. Fund it first.`;
  }
  return null;
}
