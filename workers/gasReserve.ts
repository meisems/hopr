// Coins kept back for fees, sized to what the action actually costs right now,
// so small swaps work instead of being refused by a blanket safety margin.
//
// - EVM: live gas price × the action's gas, ×2 headroom, never below a small
//   floor (rollup L1 data fees). If the price can't be read, the old fixed
//   reserves are used.
// - Solana: the transaction fee, the temporary wrapped-SOL account a swap from
//   SOL opens (its rent comes back in the same transaction), and the output
//   token's account unless the wallet already has one. A plain transfer only
//   keeps the account rent-exempt.

import { jsonRpcRace } from '../src/services/rpcPool';
import { SOLANA_CHAIN_ID } from './rpcConfig';

export type GasAction = 'transfer' | 'swap';

const EVM_GAS_UNITS: Record<GasAction, bigint> = { transfer: 21_000n, swap: 700_000n };
/** Below these a quote can't cover a rollup's L1 data fee or a price spike (native units, 18 decimals). */
const EVM_SWAP_FLOOR: Record<number, bigint> = {
  8453: 20_000_000_000_000n, // 0.00002 ETH
  42161: 20_000_000_000_000n,
  4663: 20_000_000_000_000n,
  56: 50_000_000_000_000n, // 0.00005 BNB
  5042: 20_000_000_000_000_000n, // 0.02 USDC (Arc pays gas in USDC)
};
const EVM_TRANSFER_FLOOR: Record<number, bigint> = {
  8453: 5_000_000_000_000n, // 0.000005 ETH
  42161: 5_000_000_000_000n,
  4663: 5_000_000_000_000n,
  56: 20_000_000_000_000n,
  5042: 5_000_000_000_000_000n,
};
/** Used when no RPC answers with a gas price: the earlier fixed reserves. */
const EVM_FALLBACK: Record<number, bigint> = { 56: 1_000_000_000_000_000n, 5042: 100_000_000_000_000_000n };
const EVM_DEFAULT_FALLBACK = 300_000_000_000_000n; // 0.0003 ETH
/** Anything above 1000 gwei is not a real price on these chains. */
const MAX_SANE_GAS_PRICE = 1_000_000_000_000n;

export const SOLANA_FEE_LAMPORTS = 100_000n; // base fee plus priority-fee headroom
export const SOLANA_TOKEN_ACCOUNT_RENT = 2_039_280n;
export const SOLANA_RENT_EXEMPT_MINIMUM = 890_880n;

export async function evmGasReserve(chainId: number, action: GasAction, count = 1): Promise<bigint> {
  const floor = (action === 'swap' ? EVM_SWAP_FLOOR : EVM_TRANSFER_FLOOR)[chainId] ?? (action === 'swap' ? 20_000_000_000_000n : 5_000_000_000_000n);
  try {
    const price = BigInt(await jsonRpcRace<string>(chainId, 'eth_gasPrice', [], {
      hedgeMs: 400,
      timeoutMs: 2_500,
      validate: (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) && BigInt(value) > 0n && BigInt(value) < MAX_SANE_GAS_PRICE,
    }));
    const estimate = price * EVM_GAS_UNITS[action] * 2n;
    return (estimate > floor ? estimate : floor) * BigInt(count);
  } catch {
    return (EVM_FALLBACK[chainId] ?? EVM_DEFAULT_FALLBACK) * BigInt(action === 'transfer' ? Math.max(1, Math.ceil(count / 10)) : count);
  }
}

/** Whether a Solana wallet already has a token account for `mint` (unknown → false, the safe answer). */
export async function solanaHasTokenAccount(owner: string, mint: string): Promise<boolean> {
  try {
    const result = await jsonRpcRace<{ value: unknown[] }>(SOLANA_CHAIN_ID, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'base64' }], {
      hedgeMs: 400,
      timeoutMs: 2_500,
      validate: (value) => Array.isArray(value?.value),
    });
    return result.value.length > 0;
  } catch {
    return false;
  }
}

export async function solanaGasReserve(action: GasAction, options: { owner?: string; mint?: string; count?: number } = {}): Promise<bigint> {
  if (action === 'transfer') return SOLANA_RENT_EXEMPT_MINIMUM + 10_000n * BigInt(options.count ?? 1);
  const hasAccount = options.owner && options.mint ? await solanaHasTokenAccount(options.owner, options.mint) : false;
  return SOLANA_FEE_LAMPORTS + SOLANA_TOKEN_ACCOUNT_RENT + (hasAccount ? 0n : SOLANA_TOKEN_ACCOUNT_RENT);
}

/** The reserve for an action on any EVM or Solana chain, in that chain's native units. */
export async function gasReserve(chainId: number, action: GasAction, options: { owner?: string; mint?: string; count?: number } = {}): Promise<bigint> {
  return chainId === SOLANA_CHAIN_ID ? solanaGasReserve(action, options) : evmGasReserve(chainId, action, options.count ?? 1);
}
