// Route quoting and execution for the dashboard. Every trade and bridge is
// signed by the user's own connected wallet (non-custodial).
//
//   EVM/Solana ↔ EVM/Solana ....... LI.FI (swaps + bridges in one transaction)
//   NEAR ↔ NEAR ................... Ref Finance (signed by the NEAR wallet)
//   NEAR ↔ anything else .......... NEAR Intents 1Click (deposit from the origin wallet)

import { apiUrl, API_BASE_URL } from './api';
import { getNetwork, isNativeAddress, LIFI_NATIVE, explorerTxLink, type Vm } from './chains';
import {
  buildRefSwapPlan,
  getRefSwapQuote,
  NATIVE_NEAR,
  NEAR_CHAIN_ID,
  planAttachedDeposit,
  storageDepositNeeded,
  viewFunction,
  WRAP_NEAR,
  getNearBalance,
  type NearTransactionPlan,
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

export const HOPR_FEES = { swap: 0.005, bridge: 0.01 };

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
  return vmOf(asset.chainId) === 'svm' ? LIFI_NATIVE.svm : LIFI_NATIVE.evm;
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
    fromAmount: request.amount.toString(),
    fromAddress: request.fromAddress,
    toAddress: request.toAddress,
    slippage: String(request.slippage),
    integrator: 'hopr',
    fee: String(HOPR_FEES[request.kind]),
    type: request.kind,
  });
  // The worker proxy adds the server-side LI.FI key; without it, call LI.FI directly.
  const url = API_BASE_URL ? apiUrl(`/api/lifi/quote?${params}`) : `https://li.quest/v1/quote?${params}`;
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({})) as LifiQuoteResponse;
  if (!response.ok || !data.estimate?.toAmount || !data.transactionRequest) {
    throw new Error(data.message ?? 'No LI.FI route found for this pair and amount.');
  }
  const sum = (items?: Array<{ amountUSD?: string }>) => items?.reduce((total, item) => total + Number(item.amountUSD ?? 0), 0);
  return {
    provider: 'lifi',
    request,
    expectedOut: BigInt(data.estimate.toAmount),
    minOut: BigInt(data.estimate.toAmountMin ?? data.estimate.toAmount),
    amountInUsd: Number(data.estimate.fromAmountUSD) || undefined,
    amountOutUsd: Number(data.estimate.toAmountUSD) || undefined,
    gasUsd: sum(data.estimate.gasCosts),
    durationSeconds: data.estimate.executionDuration,
    via: `LI.FI${data.toolDetails?.name ? ` · ${data.toolDetails.name}` : ''}`,
    fees: [`Hopr fee ${HOPR_FEES[request.kind] * 100}% (included)`],
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
  const quote = await getRefSwapQuote({ tokenIn, tokenOut, amountIn: request.amount.toString(), slippage: request.slippage });
  const [outputStorageDeposit, wrapStorageDeposit] = await Promise.all([
    tokenOut === NATIVE_NEAR ? 0n : storageDepositNeeded(tokenOut, request.fromAddress, nearRpc()),
    tokenIn === NATIVE_NEAR ? storageDepositNeeded(WRAP_NEAR, request.fromAddress, nearRpc()) : 0n,
  ]);
  const plans = buildRefSwapPlan(quote, { outputStorageDeposit, wrapStorageDeposit });
  const storage = outputStorageDeposit + wrapStorageDeposit;
  return {
    provider: 'ref',
    request,
    expectedOut: BigInt(quote.expectedOut),
    minOut: BigInt(quote.minOut),
    durationSeconds: 3,
    via: `Ref Finance · ${quote.hops} hop${quote.hops === 1 ? '' : 's'}`,
    fees: storage > 0n ? [`One-time token registration ${Number(storage) / 1e24} NEAR`] : [],
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
  const response = await fetch(`${INTENTS_API}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
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
    }),
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

async function nearDepositPlans(request: RouteRequest, depositAddress: string): Promise<NearTransactionPlan[]> {
  const token = isNativeAddress(request.from.address) ? WRAP_NEAR : request.from.address;
  const registration = await storageDepositNeeded(token, depositAddress, nearRpc());
  const actions: NearTransactionPlan['actions'] = [];
  if (registration > 0n) {
    actions.push({ type: 'FunctionCall', methodName: 'storage_deposit', args: { account_id: depositAddress, registration_only: true }, gas: 30_000_000_000_000n, deposit: registration });
  }
  if (token === WRAP_NEAR && isNativeAddress(request.from.address)) {
    actions.push({ type: 'FunctionCall', methodName: 'near_deposit', args: {}, gas: 10_000_000_000_000n, deposit: request.amount });
  }
  actions.push({ type: 'FunctionCall', methodName: 'ft_transfer', args: { receiver_id: depositAddress, amount: request.amount.toString() }, gas: 30_000_000_000_000n, deposit: 1n });
  return [{ receiverId: token, label: 'Deposit to NEAR Intents', actions }];
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
  if (approval && !isNativeAddress(request.from.address)) {
    onProgress?.(`Approve ${request.from.symbol} in your wallet…`);
    await ensureErc20Allowance(signers.evm.provider, signers.evm.address, request.from.chainId, request.from.address, approval, request.amount);
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

/** Poll-able status for an executed route. */
export async function checkRouteStatus(track: TrackRef): Promise<{ status: TrackStatus; detail?: string; receivingTxHash?: string }> {
  if (track.type === 'final') return { status: 'done' };
  if (track.type === 'intents') {
    const response = await fetch(`${INTENTS_API}/status?depositAddress=${encodeURIComponent(track.depositAddress)}`);
    const data = await response.json().catch(() => ({})) as { status?: string; swapDetails?: { destinationChainTxHashes?: Array<{ hash?: string }> } };
    const status = data.status ?? 'PENDING_DEPOSIT';
    const receiving = data.swapDetails?.destinationChainTxHashes?.[0]?.hash;
    if (status === 'SUCCESS') return { status: 'done', receivingTxHash: receiving };
    if (status === 'REFUNDED') return { status: 'refunded', detail: 'Refunded to your wallet' };
    if (status === 'FAILED') return { status: 'failed', detail: 'NEAR Intents could not complete the swap' };
    return { status: 'pending', detail: status.replace(/_/g, ' ').toLowerCase() };
  }
  const from = getNetwork(track.fromChain)?.lifiChainId ?? track.fromChain;
  const to = getNetwork(track.toChain)?.lifiChainId ?? track.toChain;
  const response = await fetch(`https://li.quest/v1/status?txHash=${encodeURIComponent(track.txHash)}&fromChain=${from}&toChain=${to}`);
  const data = await response.json().catch(() => ({})) as { status?: string; substatusMessage?: string; receiving?: { txHash?: string } };
  if (data.status === 'DONE') return { status: 'done', receivingTxHash: data.receiving?.txHash };
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

/** Spendable balance of `asset` for `owner`, in smallest units. */
export async function getAssetBalance(asset: Asset, owner: string): Promise<bigint> {
  const vm = vmOf(asset.chainId);
  if (vm === 'evm') return isNativeAddress(asset.address) ? getEvmNativeBalance(asset.chainId, owner) : getErc20Balance(asset.chainId, asset.address, owner);
  if (vm === 'svm') return isNativeAddress(asset.address) ? getSolBalance(owner) : (await getSplBalance(owner, asset.address)).amount;
  if (isNativeAddress(asset.address)) return BigInt((await getNearBalance(owner, [], nearRpc())).availableYocto);
  return BigInt(await viewFunction<string>(asset.address, 'ft_balance_of', { account_id: owner }, nearRpc()).catch(() => '0'));
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
