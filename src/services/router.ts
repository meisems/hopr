// Route quoting and execution for the dashboard. Every trade and bridge is
// signed by the user's own connected wallet (non-custodial).
//
//   EVM/Solana ↔ EVM/Solana ....... LI.FI (swaps + bridges in one transaction)
//   NEAR ↔ NEAR ................... Ref Finance (signed by the NEAR wallet)
//   NEAR ↔ anything else .......... NEAR Intents 1Click (deposit from the origin wallet)
//
// NEAR Intents only lists majors (native coins, USDC, a few memes), so a
// trade like "1 NEAR → any Base token" is planned as steps through a hub
// asset (planRoute): NEAR → ETH on Base via Intents, then ETH → token via
// LI.FI. executePlan runs the steps in order, sizing each step from what
// the previous one actually delivered. Hopr's fee is charged once, on the
// first step.

import { apiUrl, API_BASE_URL, viteEnv } from './api';
import { getNetwork, isNativeAddress, LIFI_NATIVE, explorerTxLink, type Vm } from './chains';
import {
  buildIntentsDepositPlan,
  buildRefSwapPlan,
  formatUnits,
  getRefSwapQuote,
  HOPR_FEE_BPS,
  NATIVE_NEAR,
  NEAR_CHAIN_ID,
  planAttachedDeposit,
  refInputContract,
  splitHoprFee,
  storageDepositNeeded,
  viewFunction,
  WRAP_NEAR,
  getNearBalance,
  type NearTransactionPlan,
  type RefSwapFee,
  type RefSwapQuote,
} from './nearService';
import {
  ensureErc20Allowance,
  erc20TransferData,
  getErc20Balance,
  getEvmNativeBalance,
  sendEvmTransaction,
  waitForEvmReceipt,
  type Eip1193Provider,
} from './wallets/evm';
import { getSolBalance, getSplBalance, sendSol, signAndSendSerialized, waitForSolanaSignature, type SolanaProvider } from './wallets/solana';
import { signAndSendNearPlans } from './wallets/near';
import { recallBalance, rememberBalance } from './rpcPool';

export interface Asset {
  chainId: number;
  /** 'native' for the chain's gas token, otherwise the token address / mint / NEP-141 contract. */
  address: string;
  symbol: string;
  decimals: number;
}

export type RouteKind = 'swap' | 'bridge';

export interface RouteRequest {
  kind: RouteKind;
  from: Asset;
  to: Asset;
  amount: bigint; // smallest units of `from`
  fromAddress: string;
  toAddress: string;
  slippage: number; // fraction, e.g. 0.01
  /** Hopr fee in basis points; defaults to the standard fee for `kind` (50 swap / 100 bridge). */
  feeBps?: number;
}

export type RouteProvider = 'lifi' | 'ref' | 'intents';

interface LifiQuoteResponse {
  estimate?: {
    toAmount?: string;
    toAmountMin?: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    executionDuration?: number;
    approvalAddress?: string;
    feeCosts?: Array<{ amountUSD?: string; name?: string }>;
    gasCosts?: Array<{ amountUSD?: string }>;
  };
  transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string; chainId?: number };
  toolDetails?: { name?: string };
  message?: string;
}

export interface RouteQuote {
  provider: RouteProvider;
  request: RouteRequest;
  expectedOut: bigint;
  minOut: bigint;
  amountInUsd?: number;
  amountOutUsd?: number;
  gasUsd?: number;
  durationSeconds?: number;
  via: string; // human route label, e.g. "LI.FI · Jumper" / "Ref Finance · 2 hops"
  fees: string[];
  lifi?: LifiQuoteResponse;
  ref?: { quote: RefSwapQuote; plans: NearTransactionPlan[] };
  intents?: { depositAddress: string; originAsset: string; destinationAsset: string };
  expiresAt: number;
}

export interface Signers {
  evm?: { provider: Eip1193Provider; address: string };
  svm?: { provider: SolanaProvider; address: string };
  near?: { accountId: string };
}

export type TrackRef =
  | { type: 'lifi'; txHash: string; fromChain: number; toChain: number }
  | { type: 'intents'; depositAddress: string }
  | { type: 'final' };

export interface ExecutionResult {
  txHash: string;
  explorerUrl?: string;
  track: TrackRef;
}

export const HOPR_FEES = { swap: HOPR_FEE_BPS.swap / 10_000, bridge: HOPR_FEE_BPS.bridge / 10_000 };

/** Fee (bps) this request pays. */
export function feeBpsFor(request: RouteRequest): number {
  return request.feeBps ?? HOPR_FEE_BPS[request.kind];
}

const pct = (bps: number) => `${bps / 100}%`;

// Hopr's NEAR fee account (NEAR Intents app fee + Ref swap fee). The worker's
// /api/config is the source of truth so it only has to be set server-side;
// VITE_HOPR_INTENTS_FEE_ACCOUNT covers deployments without the worker.
let publicConfig: Promise<{ nearFeeAccount: string }> | null = null;
export function getPublicConfig(): Promise<{ nearFeeAccount: string }> {
  const fallback = { nearFeeAccount: viteEnv.VITE_HOPR_INTENTS_FEE_ACCOUNT?.trim() ?? '' };
  if (!API_BASE_URL) return Promise.resolve(fallback);
  publicConfig ??= fetch(apiUrl('/api/config'))
    .then(async (response) => {
      const data = await response.json() as { nearFeeAccount?: string };
      return { nearFeeAccount: data.nearFeeAccount?.trim() || fallback.nearFeeAccount };
    })
    .catch(() => {
      publicConfig = null;
      return fallback;
    });
  return publicConfig;
}

/** NEAR reads use the configured RPC (VITE_RPC_NEAR) before the public fallbacks. */
const nearRpc = () => ({ urls: [getNetwork(NEAR_CHAIN_ID)!.rpcUrl] });

function vmOf(chainId: number): Vm {
  const network = getNetwork(chainId);
  if (!network) throw new Error('Unsupported chain');
  return network.vm;
}

// ---------------------------------------------------------------------------
// LI.FI
// ---------------------------------------------------------------------------

function lifiToken(asset: Asset): string {
  if (!isNativeAddress(asset.address)) return asset.address;
  const custom = getNetwork(asset.chainId)?.lifiNative;
  if (custom) return custom.address;
  return vmOf(asset.chainId) === 'svm' ? LIFI_NATIVE.svm : LIFI_NATIVE.evm;
}

/** Our native units ÷ LI.FI's units for this asset (Arc: 18-decimal gas vs 6-decimal USDC view). */
function lifiUnitScale(asset: Asset): bigint {
  const network = getNetwork(asset.chainId);
  if (!isNativeAddress(asset.address) || !network?.lifiNative) return 1n;
  return 10n ** BigInt(network.nativeDecimals - network.lifiNative.decimals);
}

async function quoteLifi(request: RouteRequest, signal?: AbortSignal): Promise<RouteQuote> {
  const from = getNetwork(request.from.chainId);
  const to = getNetwork(request.to.chainId);
  if (!from?.lifiChainId || !to?.lifiChainId) throw new Error('LI.FI does not route this chain.');
  const params = new URLSearchParams({
    fromChain: String(from.lifiChainId),
    toChain: String(to.lifiChainId),
    fromToken: lifiToken(request.from),
    toToken: lifiToken(request.to),
    fromAmount: (request.amount / lifiUnitScale(request.from)).toString(),
    fromAddress: request.fromAddress,
    toAddress: request.toAddress,
    slippage: String(request.slippage),
    integrator: 'hopr',
    fee: String(feeBpsFor(request) / 10_000),
    // The worker proxy sets the fee from `type` itself: swap 0.5%, bridge 1%, hop 0% (later steps of a plan).
    type: feeBpsFor(request) === 0 ? 'hop' : request.kind,
  });
  // The worker proxy adds the server-side LI.FI key; without it, call LI.FI directly.
  const url = API_BASE_URL ? apiUrl(`/api/lifi/quote?${params}`) : `https://li.quest/v1/quote?${params}`;
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({})) as LifiQuoteResponse;
  if (response.status === 429) throw new Error('The routing service is busy right now. Try again in a minute.');
  if (!response.ok || !data.estimate?.toAmount || !data.transactionRequest) {
    throw new Error(data.message ?? 'No LI.FI route found for this pair and amount.');
  }
  const sum = (items?: Array<{ amountUSD?: string }>) => items?.reduce((total, item) => total + Number(item.amountUSD ?? 0), 0);
  return {
    provider: 'lifi',
    request,
    expectedOut: BigInt(data.estimate.toAmount) * lifiUnitScale(request.to),
    minOut: BigInt(data.estimate.toAmountMin ?? data.estimate.toAmount) * lifiUnitScale(request.to),
    amountInUsd: Number(data.estimate.fromAmountUSD) || undefined,
    amountOutUsd: Number(data.estimate.toAmountUSD) || undefined,
    gasUsd: sum(data.estimate.gasCosts),
    durationSeconds: data.estimate.executionDuration,
    via: `LI.FI${data.toolDetails?.name ? ` · ${data.toolDetails.name}` : ''}`,
    fees: feeBpsFor(request) ? [`Hopr fee ${pct(feeBpsFor(request))} (included)`] : [],
    lifi: data,
    expiresAt: Date.now() + 60_000,
  };
}

// ---------------------------------------------------------------------------
// Ref Finance (NEAR ↔ NEAR)
// ---------------------------------------------------------------------------

const refToken = (asset: Asset) => (isNativeAddress(asset.address) ? NATIVE_NEAR : asset.address);

async function quoteRef(request: RouteRequest): Promise<RouteQuote> {
  const tokenIn = refToken(request.from);
  const tokenOut = refToken(request.to);
  const { nearFeeAccount } = await getPublicConfig();
  const bps = nearFeeAccount ? feeBpsFor(request) : 0;
  const { net, fee } = splitHoprFee(request.amount, bps);
  const quote = await getRefSwapQuote({ tokenIn, tokenOut, amountIn: net.toString(), slippage: request.slippage });
  const [outputStorageDeposit, wrapStorageDeposit, feeStorageDeposit] = await Promise.all([
    tokenOut === NATIVE_NEAR ? 0n : storageDepositNeeded(tokenOut, request.fromAddress, nearRpc()),
    tokenIn === NATIVE_NEAR ? storageDepositNeeded(WRAP_NEAR, request.fromAddress, nearRpc()) : 0n,
    fee > 0n ? storageDepositNeeded(refInputContract(tokenIn), nearFeeAccount, nearRpc()) : 0n,
  ]);
  const hoprFee: RefSwapFee | null = fee > 0n ? { account: nearFeeAccount, amount: fee, storageDeposit: feeStorageDeposit } : null;
  const plans = buildRefSwapPlan(quote, { outputStorageDeposit, wrapStorageDeposit }, hoprFee);
  const storage = outputStorageDeposit + wrapStorageDeposit + feeStorageDeposit;
  const fees: string[] = [];
  if (fee > 0n) fees.push(`Hopr fee ${pct(bps)} (${formatUnits(fee, request.from.decimals, 6)} ${request.from.symbol})`);
  if (storage > 0n) fees.push(`One-time token registration ${formatUnits(storage, 24, 5)} NEAR`);
  return {
    provider: 'ref',
    request,
    expectedOut: BigInt(quote.expectedOut),
    minOut: BigInt(quote.minOut),
    durationSeconds: 3,
    via: `Ref Finance · ${quote.hops} hop${quote.hops === 1 ? '' : 's'}`,
    fees,
    ref: { quote, plans },
    expiresAt: Date.now() + 60_000,
  };
}

// ---------------------------------------------------------------------------
// NEAR Intents (1Click)
// ---------------------------------------------------------------------------

const INTENTS_API = 'https://1click.chaindefuser.com/v0';

interface IntentsToken { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress?: string; price?: number }
let intentsTokens: Promise<IntentsToken[]> | null = null;

/** 1Click's token list (also the source of live USD prices for native assets). */
export function loadIntentsTokens(): Promise<IntentsToken[]> {
  intentsTokens ??= fetch(`${INTENTS_API}/tokens`).then(async (response) => {
    if (!response.ok) throw new Error('NEAR Intents is unavailable right now.');
    return response.json() as Promise<IntentsToken[]>;
  }).catch((error) => {
    intentsTokens = null;
    throw error;
  });
  return intentsTokens;
}

/** Map an asset to its 1Click asset id. Native NEAR travels as wNEAR. */
export async function intentsAssetId(asset: Asset): Promise<string | null> {
  const network = getNetwork(asset.chainId);
  if (!network?.intentsChain) return null;
  const tokens = (await loadIntentsTokens()).filter((token) => token.blockchain === network.intentsChain);
  if (network.vm === 'near') {
    const id = isNativeAddress(asset.address) ? WRAP_NEAR : asset.address;
    return tokens.find((token) => token.contractAddress === id || token.assetId === `nep141:${id}`)?.assetId ?? null;
  }
  if (isNativeAddress(asset.address)) {
    return tokens.find((token) => !token.contractAddress && token.symbol.toUpperCase() === network.nativeSymbol)?.assetId ?? null;
  }
  const address = asset.address.toLowerCase();
  return tokens.find((token) => token.contractAddress?.toLowerCase() === address)?.assetId ?? null;
}

async function quoteIntents(request: RouteRequest, dry: boolean): Promise<RouteQuote> {
  const [originAsset, destinationAsset] = await Promise.all([intentsAssetId(request.from), intentsAssetId(request.to)]);
  if (!originAsset || !destinationAsset) {
    throw new Error('NEAR cross-chain routes support native coins and USDC. Pick one of those on both sides.');
  }
  if (vmOf(request.from.chainId) === 'svm' && !isNativeAddress(request.from.address)) {
    throw new Error('From Solana, NEAR routes start from native SOL.');
  }
  const bps = feeBpsFor(request);
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: Math.round(request.slippage * 10_000),
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset,
    amount: request.amount.toString(),
    refundTo: request.fromAddress,
    refundType: 'ORIGIN_CHAIN',
    recipient: request.toAddress,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  // Through the worker, the app fee (and the 1Click API key) are added server-side.
  let payload: Record<string, unknown> = { ...body, feeBps: bps };
  if (!API_BASE_URL) {
    const { nearFeeAccount } = await getPublicConfig();
    payload = { ...body, ...(nearFeeAccount && bps ? { appFees: [{ recipient: nearFeeAccount, fee: bps }] } : {}) };
  }
  const response = await fetch(API_BASE_URL ? apiUrl('/api/intents/quote') : `${INTENTS_API}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({})) as {
    quote?: { depositAddress?: string; amountOut?: string; minAmountOut?: string; amountInUsd?: string; amountOutUsd?: string; timeEstimate?: number };
    quoteRequest?: { appFees?: Array<{ fee: number }> };
    message?: string;
  };
  if (!response.ok || !data.quote?.amountOut) throw new Error(data.message ?? 'NEAR Intents could not quote this route.');
  if (!dry && !data.quote.depositAddress) throw new Error('NEAR Intents did not return a deposit address.');
  const appFeeBps = data.quoteRequest?.appFees?.reduce((total, fee) => total + fee.fee, 0) ?? 0;
  return {
    provider: 'intents',
    request,
    expectedOut: BigInt(data.quote.amountOut),
    minOut: BigInt(data.quote.minAmountOut ?? data.quote.amountOut),
    amountInUsd: Number(data.quote.amountInUsd) || undefined,
    amountOutUsd: Number(data.quote.amountOutUsd) || undefined,
    durationSeconds: data.quote.timeEstimate,
    via: 'NEAR Intents',
    fees: appFeeBps ? [`NEAR Intents app fee ${appFeeBps / 100}% (included)`] : [],
    intents: data.quote.depositAddress ? { depositAddress: data.quote.depositAddress, originAsset, destinationAsset } : undefined,
    expiresAt: Date.now() + 5 * 60_000,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Best route for the request. `commit` requests an executable quote (NEAR
 * Intents allocates a deposit address); preview quotes are side-effect free.
 */
export async function getRouteQuote(request: RouteRequest, options: { commit?: boolean; signal?: AbortSignal } = {}): Promise<RouteQuote> {
  if (request.amount <= 0n) throw new Error('Enter an amount greater than zero.');
  const fromVm = vmOf(request.from.chainId);
  const toVm = vmOf(request.to.chainId);
  if (fromVm === 'near' && toVm === 'near') return quoteRef(request);
  if (fromVm === 'near' || toVm === 'near') return quoteIntents(request, !options.commit);
  try {
    return await quoteLifi(request, options.signal);
  } catch (lifiError) {
    // Chains LI.FI doesn't cover (or a pair it can't route) may still be reachable through Intents.
    if (options.signal?.aborted) throw lifiError;
    const intents = await Promise.all([intentsAssetId(request.from), intentsAssetId(request.to)]).catch(() => [null, null]);
    if (intents[0] && intents[1]) return quoteIntents(request, !options.commit);
    throw lifiError;
  }
}

/** Transactions that deposit a NEAR-side asset into a 1Click deposit account (exported for tests). */
export async function nearDepositPlans(request: RouteRequest, depositAddress: string): Promise<NearTransactionPlan[]> {
  const native = isNativeAddress(request.from.address);
  const token = native ? WRAP_NEAR : request.from.address;
  const registration = await storageDepositNeeded(token, depositAddress, nearRpc());
  return buildIntentsDepositPlan({ token, native, amount: request.amount, depositAddress, registration });
}

/**
 * Execute a committed quote with the user's wallet. EVM token inputs are
 * approved first (exact amount). Returns the source-chain transaction hash
 * and what to poll for cross-chain completion.
 */
export async function executeRoute(quote: RouteQuote, signers: Signers, onProgress?: (message: string) => void): Promise<ExecutionResult> {
  if (Date.now() > quote.expiresAt) throw new Error('This quote expired. Request a fresh one.');
  const { request } = quote;
  const fromVm = vmOf(request.from.chainId);

  if (quote.provider === 'ref') {
    if (!signers.near) throw new Error('Connect a NEAR wallet first.');
    onProgress?.('Confirm the swap in your NEAR wallet…');
    const hash = await signAndSendNearPlans(quote.ref!.plans);
    return { txHash: hash ?? '', explorerUrl: hash ? explorerTxLink(NEAR_CHAIN_ID, hash) : undefined, track: { type: 'final' } };
  }

  if (quote.provider === 'intents') {
    const deposit = quote.intents?.depositAddress;
    if (!deposit) throw new Error('Request a fresh quote before depositing.');
    let hash: string;
    if (fromVm === 'evm') {
      if (!signers.evm) throw new Error('Connect an EVM wallet first.');
      onProgress?.('Confirm the deposit in your wallet…');
      hash = isNativeAddress(request.from.address)
        ? await sendEvmTransaction(signers.evm.provider, signers.evm.address, request.from.chainId, { to: deposit, value: request.amount })
        : await sendEvmTransaction(signers.evm.provider, signers.evm.address, request.from.chainId, { to: request.from.address, data: erc20TransferData(deposit, request.amount) });
    } else if (fromVm === 'svm') {
      if (!signers.svm) throw new Error('Connect a Solana wallet first.');
      onProgress?.('Confirm the deposit in your Solana wallet…');
      hash = await sendSol(signers.svm.provider, signers.svm.address, deposit, request.amount);
    } else {
      if (!signers.near) throw new Error('Connect a NEAR wallet first.');
      onProgress?.('Confirm the deposit in your NEAR wallet…');
      hash = (await signAndSendNearPlans(await nearDepositPlans(request, deposit))) ?? '';
    }
    // Tell 1Click about the deposit so it starts immediately (best effort; it also watches the chain).
    if (hash) {
      void fetch(`${INTENTS_API}/deposit/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: hash, depositAddress: deposit }),
      }).catch(() => undefined);
    }
    return { txHash: hash, explorerUrl: hash ? explorerTxLink(request.from.chainId, hash) : undefined, track: { type: 'intents', depositAddress: deposit } };
  }

  // LI.FI
  const tx = quote.lifi?.transactionRequest;
  if (!tx) throw new Error('This route has no transaction to sign.');
  if (fromVm === 'svm') {
    if (!signers.svm) throw new Error('Connect a Solana wallet first.');
    onProgress?.('Confirm in your Solana wallet…');
    const signature = await signAndSendSerialized(signers.svm.provider, tx.data!);
    return { txHash: signature, explorerUrl: explorerTxLink(request.from.chainId, signature), track: { type: 'lifi', txHash: signature, fromChain: request.from.chainId, toChain: request.to.chainId } };
  }
  if (!signers.evm) throw new Error('Connect an EVM wallet first.');
  const approval = quote.lifi?.estimate?.approvalAddress;
  // Gas coins exposed as ERC-20s (Arc's USDC at 0x3600…) are pulled via transferFrom too, so they need approval.
  const spendsErc20 = !isNativeAddress(request.from.address) || Boolean(getNetwork(request.from.chainId)?.lifiNative);
  if (approval && spendsErc20) {
    onProgress?.(`Approve ${request.from.symbol} in your wallet…`);
    await ensureErc20Allowance(signers.evm.provider, signers.evm.address, request.from.chainId, lifiToken(request.from), approval, request.amount / lifiUnitScale(request.from));
  }
  onProgress?.('Confirm the transaction in your wallet…');
  const hash = await sendEvmTransaction(signers.evm.provider, signers.evm.address, request.from.chainId, {
    to: tx.to!,
    data: tx.data,
    value: tx.value,
    gasLimit: tx.gasLimit,
  });
  return { txHash: hash, explorerUrl: explorerTxLink(request.from.chainId, hash), track: { type: 'lifi', txHash: hash, fromChain: request.from.chainId, toChain: request.to.chainId } };
}

export type TrackStatus = 'pending' | 'done' | 'failed' | 'refunded';

/** `{ receivedAmount }` when the provider reported how much arrived. */
function received(value: string | undefined): { receivedAmount?: bigint } {
  return value && /^\d+$/.test(value) ? { receivedAmount: BigInt(value) } : {};
}

/** Poll-able status for an executed route. */
export async function checkRouteStatus(track: TrackRef): Promise<{ status: TrackStatus; detail?: string; receivingTxHash?: string; receivedAmount?: bigint }> {
  if (track.type === 'final') return { status: 'done' };
  if (track.type === 'intents') {
    const response = await fetch(`${INTENTS_API}/status?depositAddress=${encodeURIComponent(track.depositAddress)}`);
    const data = await response.json().catch(() => ({})) as { status?: string; swapDetails?: { amountOut?: string; destinationChainTxHashes?: Array<{ hash?: string }> } };
    const status = data.status ?? 'PENDING_DEPOSIT';
    const receiving = data.swapDetails?.destinationChainTxHashes?.[0]?.hash;
    if (status === 'SUCCESS') return { status: 'done', receivingTxHash: receiving, ...received(data.swapDetails?.amountOut) };
    if (status === 'REFUNDED') return { status: 'refunded', detail: 'Refunded to your wallet' };
    if (status === 'FAILED') return { status: 'failed', detail: 'NEAR Intents could not complete the swap' };
    return { status: 'pending', detail: status.replace(/_/g, ' ').toLowerCase() };
  }
  const from = getNetwork(track.fromChain)?.lifiChainId ?? track.fromChain;
  const to = getNetwork(track.toChain)?.lifiChainId ?? track.toChain;
  const response = await fetch(`https://li.quest/v1/status?txHash=${encodeURIComponent(track.txHash)}&fromChain=${from}&toChain=${to}`);
  const data = await response.json().catch(() => ({})) as { status?: string; substatusMessage?: string; receiving?: { txHash?: string; amount?: string } };
  if (data.status === 'DONE') return { status: 'done', receivingTxHash: data.receiving?.txHash, ...received(data.receiving?.amount) };
  if (data.status === 'FAILED' || data.status === 'INVALID') return { status: 'failed', detail: data.substatusMessage };
  return { status: 'pending', detail: data.substatusMessage ?? 'waiting for confirmation' };
}

/** Wait for the source transaction itself to confirm (before cross-chain tracking). */
export async function waitForSourceConfirmation(chainId: number, hash: string): Promise<void> {
  const vm = vmOf(chainId);
  if (vm === 'evm') await waitForEvmReceipt(chainId, hash);
  else if (vm === 'svm') await waitForSolanaSignature(hash);
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * Spendable balance of `asset` for `owner`, in smallest units. Reads go
 * through the RPC failover pool; if every endpoint is down, the last balance
 * read for this wallet is returned instead of failing.
 */
export async function getAssetBalance(asset: Asset, owner: string): Promise<bigint> {
  const key = `${asset.chainId}:${asset.address.toLowerCase()}:${owner}`;
  try {
    const value = await readAssetBalance(asset, owner);
    rememberBalance(key, value);
    return value;
  } catch (error) {
    const known = recallBalance(key);
    if (known) return known.value;
    throw error;
  }
}

async function readAssetBalance(asset: Asset, owner: string): Promise<bigint> {
  const vm = vmOf(asset.chainId);
  if (vm === 'evm') return isNativeAddress(asset.address) ? getEvmNativeBalance(asset.chainId, owner) : getErc20Balance(asset.chainId, asset.address, owner);
  if (vm === 'svm') return isNativeAddress(asset.address) ? getSolBalance(owner) : (await getSplBalance(owner, asset.address)).amount;
  if (isNativeAddress(asset.address)) return BigInt((await getNearBalance(owner, [], nearRpc())).availableYocto);
  // Errors propagate (→ last known balance) instead of silently reading as zero.
  return BigInt(await viewFunction<string>(asset.address, 'ft_balance_of', { account_id: owner }, nearRpc()));
}

/** Gas to keep aside when spending a native balance "Max". */
export function nativeGasReserve(chainId: number): bigint {
  const vm = vmOf(chainId);
  if (vm === 'svm') return 5_000_000n; // 0.005 SOL
  if (vm === 'near') return 50_000_000_000_000_000_000_000n; // 0.05 NEAR
  return chainId === 56 ? 1_000_000_000_000_000n : 300_000_000_000_000n; // 0.001 BNB / 0.0003 ETH
}

/** The NEAR swap's attached deposits (for balance checks before signing). */
export function refAttachedDeposit(quote: RouteQuote): bigint {
  return quote.ref ? planAttachedDeposit(quote.ref.plans) : 0n;
}

export { LIFI_NATIVE };

// ---------------------------------------------------------------------------
// Multi-step plans (any token ↔ any token across NEAR and the other chains)
// ---------------------------------------------------------------------------

const BASE_CHAIN_ID = 8453;
const WNEAR_ASSET: Asset = { chainId: NEAR_CHAIN_ID, address: WRAP_NEAR, symbol: 'wNEAR', decimals: 24 };

function nativeAsset(chainId: number): Asset {
  const network = getNetwork(chainId)!;
  return { chainId, address: 'native', symbol: network.nativeSymbol, decimals: network.nativeDecimals };
}

const sameAsset = (a: Asset, b: Asset) => a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase();

/**
 * The asset a chain hops through: wNEAR on NEAR, the native coin on chains
 * NEAR Intents serves, otherwise ETH on Base (reached with LI.FI).
 */
export function hubAsset(chainId: number): Asset {
  const network = getNetwork(chainId);
  if (!network) throw new Error('Unsupported chain');
  if (network.vm === 'near') return WNEAR_ASSET;
  return network.intentsChain ? nativeAsset(chainId) : nativeAsset(BASE_CHAIN_ID);
}

/** Whether NEAR Intents can take (`from`) or deliver (`to`) this asset directly. */
async function intentsHandles(asset: Asset, side: 'from' | 'to'): Promise<boolean> {
  if (side === 'from' && vmOf(asset.chainId) === 'svm' && !isNativeAddress(asset.address)) return false; // SOL deposits only
  return Boolean(await intentsAssetId(asset).catch(() => null));
}

/**
 * Split a request into executable steps. Routes that don't touch NEAR, or
 * stay on NEAR, are one step. Routes across the NEAR boundary go through
 * hub assets when NEAR Intents doesn't list the token on either end:
 *
 *   1 NEAR → DEGEN (Base) ...... NEAR ─Intents→ ETH (Base) ─LI.FI→ DEGEN
 *   BLACKDRAGON → ETH (Base) ... BLACKDRAGON ─Ref→ wNEAR ─Intents→ ETH
 *   1 ETH (Base) → a NEAR meme . ETH ─Intents→ wNEAR ─Ref→ meme
 *
 * The first step carries Hopr's fee; later steps are fee-free.
 */
export async function planRoute(request: RouteRequest, options: { viaBase?: boolean } = {}): Promise<RouteRequest[]> {
  const fromVm = vmOf(request.from.chainId);
  const toVm = vmOf(request.to.chainId);
  const fee = feeBpsFor(request);
  if ((fromVm === 'near') === (toVm === 'near')) return [{ ...request, feeBps: fee }];

  // viaBase: NEAR Intents can't serve this chain right now (limits, liquidity) — cross via ETH on Base instead.
  const baseHub = nativeAsset(BASE_CHAIN_ID);
  const hubFor = (asset: Asset) => (options.viaBase ? baseHub : hubAsset(asset.chainId));
  const [fromDirect, toDirect] = await Promise.all([
    fromVm !== 'near' && options.viaBase ? sameAsset(request.from, baseHub) : intentsHandles(request.from, 'from'),
    toVm !== 'near' && options.viaBase ? sameAsset(request.to, baseHub) : intentsHandles(request.to, 'to'),
  ]);
  const legs: RouteRequest[] = [];
  let current = request.from;
  if (!fromDirect) {
    const hub = fromVm === 'near' ? hubAsset(request.from.chainId) : hubFor(request.from);
    if (!(await intentsHandles(hub, 'from'))) throw new Error(`No route from ${getNetwork(request.from.chainId)?.name ?? 'this chain'} to NEAR yet.`);
    legs.push({ ...request, kind: 'swap', to: hub, toAddress: request.fromAddress });
    current = hub;
  }
  let target = request.to;
  let tail: RouteRequest | null = null;
  if (!toDirect) {
    const hub = toVm === 'near' ? hubAsset(request.to.chainId) : hubFor(request.to);
    if (!(await intentsHandles(hub, 'to'))) throw new Error(`No route from NEAR to ${getNetwork(request.to.chainId)?.name ?? 'this chain'} yet.`);
    tail = { ...request, kind: 'swap', from: hub, fromAddress: request.toAddress };
    target = hub;
  }
  if (!sameAsset(current, target)) legs.push({ ...request, from: current, to: target });
  if (tail) legs.push(tail);
  return legs.map((leg, index) => ({ ...leg, feeBps: index === 0 ? fee : 0, amount: index === 0 ? request.amount : 0n }));
}

/** Which provider a step will use (same rules as getRouteQuote). */
export function stepProvider(leg: RouteRequest): RouteProvider {
  const fromVm = vmOf(leg.from.chainId);
  const toVm = vmOf(leg.to.chainId);
  if (fromVm === 'near' && toVm === 'near') return 'ref';
  return fromVm === 'near' || toVm === 'near' ? 'intents' : 'lifi';
}

export const PROVIDER_LABEL: Record<RouteProvider, string> = { lifi: 'LI.FI', ref: 'Ref Finance', intents: 'NEAR Intents' };

/** "NEAR → ETH → DEGEN" style label for a plan. */
export function describePlan(legs: RouteRequest[]): string {
  if (legs.length === 0) return '';
  return [legs[0].from.symbol, ...legs.map((leg) => leg.to.symbol)].join(' → ');
}

/**
 * Quote a whole plan without side effects: each later step is quoted with
 * what the previous step is expected to deliver (less a little for price
 * movement and gas), so the result estimates the final output end to end.
 */
export async function previewPlan(request: RouteRequest, options: { signal?: AbortSignal } = {}): Promise<RouteQuote & { steps: number; quotes: RouteQuote[]; legs: RouteRequest[] }> {
  try {
    return await previewLegs(request, await planRoute(request), options.signal);
  } catch (error) {
    // NEAR Intents sometimes can't serve a chain (temporary minimums, no liquidity):
    // retry the same trade crossing through ETH on Base, which it always serves.
    const crossesNear = (vmOf(request.from.chainId) === 'near') !== (vmOf(request.to.chainId) === 'near');
    if (!crossesNear || options.signal?.aborted) throw error;
    const viaBase = await planRoute(request, { viaBase: true }).catch(() => null);
    if (!viaBase) throw error;
    return previewLegs(request, viaBase, options.signal);
  }
}

async function previewLegs(request: RouteRequest, legs: RouteRequest[], signal?: AbortSignal): Promise<RouteQuote & { steps: number; quotes: RouteQuote[]; legs: RouteRequest[] }> {
  const options = { signal };
  const quotes: RouteQuote[] = [];
  let amount = request.amount;
  for (let index = 0; index < legs.length; index += 1) {
    const quote = await getRouteQuote({ ...legs[index], amount }, { signal: options.signal });
    quotes.push(quote);
    const next = legs[index + 1];
    if (next) {
      amount = (quote.expectedOut * 98n) / 100n;
      if (isNativeAddress(next.from.address)) amount -= nativeGasReserve(next.from.chainId);
      if (amount <= 0n) throw new Error('Amount too small to cover the extra step. Try a larger amount.');
    }
  }
  const first = quotes[0];
  const last = quotes[quotes.length - 1];
  const providers = [...new Set(quotes.map((quote) => PROVIDER_LABEL[quote.provider]))].join(' + ');
  return {
    ...last,
    request,
    amountInUsd: first.amountInUsd,
    fees: first.fees,
    durationSeconds: quotes.reduce((sum, quote) => sum + (quote.durationSeconds ?? 60), 0),
    via: legs.length > 1 ? `${describePlan(legs)} · ${providers}` : last.via,
    steps: legs.length,
    quotes,
    legs,
  };
}

export interface PlanHooks {
  onProgress?: (message: string, step: number, steps: number) => void;
  /** Called as soon as each step is signed and sent (record activity, report referrals…). */
  onStepSent?: (step: number, quote: RouteQuote, result: ExecutionResult) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a sent step until its provider reports it settled. */
async function waitForSettlement(track: TrackRef, onTick: (detail: string) => void, timeoutMs = 30 * 60_000): Promise<bigint | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await checkRouteStatus(track).catch(() => ({ status: 'pending' as TrackStatus, detail: 'checking…', receivedAmount: undefined }));
    if (status.status === 'done') return status.receivedAmount;
    if (status.status === 'failed' || status.status === 'refunded') {
      throw new Error(status.status === 'refunded' ? 'The route was refunded to your wallet. Nothing else was spent.' : `The route failed${status.detail ? `: ${status.detail}` : '.'}`);
    }
    onTick(status.detail ?? 'in progress');
    await sleep(6000);
  }
  throw new Error('This step is taking unusually long. Check History; your funds are safe with the route provider.');
}

/**
 * Run a plan with the user's wallets. Steps after the first are re-quoted
 * with the amount the previous step really delivered (minus gas for native
 * coins), so the user always spends exactly what arrived.
 */
export async function executePlan(legs: RouteRequest[], signers: Signers, hooks: PlanHooks = {}): Promise<{ quotes: RouteQuote[]; results: ExecutionResult[] }> {
  const steps = legs.length;
  const quotes: RouteQuote[] = [];
  const results: ExecutionResult[] = [];
  const plan = legs.map((leg) => ({ ...leg }));

  for (let index = 0; index < steps; index += 1) {
    const leg = plan[index];
    const progress = (message: string) => hooks.onProgress?.(steps > 1 ? `Step ${index + 1}/${steps} · ${message}` : message, index, steps);
    const next = plan[index + 1];
    // Balances before this step, to size the next one.
    const nearHub = next && sameAsset(next.from, WNEAR_ASSET);
    const before = next ? await getAssetBalance(next.from, next.fromAddress).catch(() => 0n) : 0n;

    progress(`Finding the best ${leg.from.symbol} → ${leg.to.symbol} route…`);
    const quote = await getRouteQuote(leg, { commit: true });
    quotes.push(quote);
    const result = await executeRoute(quote, signers, progress);
    results.push(result);
    hooks.onStepSent?.(index, quote, result);
    if (!next) break;

    progress('Waiting for confirmation…');
    if (result.txHash) await waitForSourceConfirmation(leg.from.chainId, result.txHash).catch(() => undefined);
    const reported = result.track.type === 'final' ? undefined : await waitForSettlement(result.track, (detail) => progress(`${leg.to.symbol} on the way (${detail})…`));

    // Work out what arrived. Provider-reported amounts are exact; otherwise use the balance change.
    let from = next.from;
    let amount = 0n;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const after = await getAssetBalance(from, next.fromAddress).catch(() => before);
      const delta = after - before;
      if (nearHub && reported && delta < reported / 2n) {
        // NEAR Intents may deliver native NEAR instead of wNEAR.
        const native = nativeAsset(NEAR_CHAIN_ID);
        const available = await getAssetBalance(native, next.fromAddress).catch(() => 0n);
        if (available > reported) {
          from = native;
          amount = reported;
          break;
        }
      }
      if (delta > 0n || (reported && after >= reported)) {
        amount = reported && reported <= after ? reported : delta;
        break;
      }
      progress(`Waiting for ${from.symbol} to arrive…`);
      await sleep(3000);
    }
    if (isNativeAddress(from.address)) {
      const balance = await getAssetBalance(from, next.fromAddress).catch(() => amount);
      const spendable = balance - nativeGasReserve(from.chainId);
      if (spendable < amount) amount = spendable;
    }
    if (amount <= 0n) throw new Error(`Step ${index + 1} finished but no ${from.symbol} is spendable yet. It is in your wallet — trade it from the card when it lands.`);
    plan[index + 1] = { ...next, from, amount };
  }
  return { quotes, results };
}
