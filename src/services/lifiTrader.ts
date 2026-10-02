// LI.FI Execution Service
//
// Fetches cross-chain swap routes from LI.FI and executes them. Buy sends a
// user's chosen funding asset to the detected token on its resolved chain.
// Sell reverses the exact route back to the original funding chain/token so
// proceeds always land where the user's money came from.
//
// SAFETY NOTE: execute() must only ever be called after the caller has an
// explicit, freshly-obtained user confirmation for this specific quote
// (amount, destination, and slippage all shown to the user). This module
// does not itself gate on confirmation — the caller (Telegram callback
// handler / dashboard trade endpoint) is responsible for that, and must
// treat a stored "default preset" as a stated amount to confirm, not as
// standing authorization to keep trading unattended.

import { ethers } from 'ethers';
import { Connection, VersionedTransaction, PublicKey, TransactionMessage, SystemProgram, Keypair } from '@solana/web3.js';
import { decryptPrivateKey, unpackEncryptedSecret, type EncryptedSecret } from './walletService';

const LIFI_QUOTE_URL = 'https://li.quest/v1/quote';
const EVM_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SOLANA_LIFI_CHAIN_ID = '1151111081099710';
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
];

export interface LifiQuoteRequest {
  fromChain: string; // LI.FI chain key or numeric id, e.g. 'sol', '8453'
  toChain: string;
  fromToken: string; // address or symbol
  toToken: string;
  fromAmount: string; // smallest unit, as a string
  fromAddress: string;
  toAddress: string;
  slippage?: number; // e.g. 0.02 for 2%
  integrator?: string;
  fee?: number; // fraction of fromAmount, e.g. 0.0075 = 0.75%
}

export interface LifiQuote {
  id: string;
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    executionDuration: number;
  };
  transactionRequest?: {
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
    chainId?: number;
  };
  // Present when the source chain is Solana: a base64 VersionedTransaction.
  transactionRequestSolana?: string;
  raw: unknown;
}

const QUOTE_TIMEOUT_MS = 15_000;

export async function getQuote(req: LifiQuoteRequest, apiKey: string): Promise<LifiQuote> {
  const params = new URLSearchParams({
    fromChain: req.fromChain,
    toChain: req.toChain,
    fromToken: req.fromToken,
    toToken: req.toToken,
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    toAddress: req.toAddress,
    slippage: String(req.slippage ?? 0.03),
    integrator: req.integrator ?? 'hopr',
    fee: String(req.fee ?? 0.0075),
  });

  const res = await fetch(`${LIFI_QUOTE_URL}?${params.toString()}`, {
    headers: apiKey ? { 'x-lifi-api-key': apiKey } : {},
    // A stuck quote should fail fast with a retryable message, not hang the bot.
    signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('LI.FI is slow to quote right now. Please try again in a moment.');
    throw error;
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LI.FI quote failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  return {
    id: data.id ?? crypto.randomUUID(),
    estimate: {
      fromAmount: data.estimate?.fromAmount ?? req.fromAmount,
      toAmount: data.estimate?.toAmount ?? '0',
      toAmountMin: data.estimate?.toAmountMin ?? data.estimate?.toAmount ?? '0',
      approvalAddress: data.estimate?.approvalAddress,
      executionDuration: data.estimate?.executionDuration ?? 0,
    },
    transactionRequest: data.transactionRequest,
    transactionRequestSolana: data.transactionRequest?.data && (req.fromChain === 'sol' || req.fromChain === SOLANA_LIFI_CHAIN_ID)
      ? data.transactionRequest.data
      : undefined,
    raw: data,
  };
}

interface ExecuteParams {
  quote: LifiQuote;
  fromChainType: 'EVM' | 'SVM';
  encryptedKey: EncryptedSecret;
  encryptionSecret: string;
  evmRpcUrl?: string; // required for EVM execution
  solanaRpcUrl?: string; // required for SVM execution
  /** Extra Solana RPCs the signed transaction is also broadcast to, so it lands even if one node drops it. */
  solanaBroadcastUrls?: string[];
  fromTokenAddress: string; // for approval check; 'native' for gas token
}

export interface ExecuteResult {
  txHash: string;
  status: 'SUBMITTED';
}

/** Native-coin deposit for a confirmed 1Click quote; never accepts opaque calldata. */
export async function executeNativeDeposit(params: {
  chainType: 'EVM' | 'SVM'; chainId: number; rpcUrl: string;
  encryptedKey: EncryptedSecret; encryptionSecret: string;
  fromAddress: string; depositAddress: string; amount: bigint;
}): Promise<ExecuteResult> {
  if (params.amount <= 0n) throw new Error('Invalid deposit amount');
  const secret = await decryptPrivateKey(params.encryptedKey, params.encryptionSecret);
  if (params.chainType === 'EVM') {
    const provider = new ethers.JsonRpcProvider(params.rpcUrl);
    const signer = new ethers.Wallet(secret, provider);
    if (signer.address.toLowerCase() !== params.fromAddress.toLowerCase()) throw new Error('Your active wallet changed. Request a new quote.');
    if ((await provider.getNetwork()).chainId !== BigInt(params.chainId)) throw new Error('Funding RPC is on the wrong chain');
    const tx = await signer.sendTransaction({ to: params.depositAddress, value: params.amount, data: '0x' });
    return { txHash: tx.hash, status: 'SUBMITTED' };
  }
  const bs58 = await import('bs58');
  const keypair = Keypair.fromSecretKey(bs58.default.decode(secret));
  if (keypair.publicKey.toBase58() !== params.fromAddress) throw new Error('Your active wallet changed. Request a new quote.');
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(params.depositAddress), lamports: params.amount })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair]);
  return { txHash: await connection.sendTransaction(transaction, { skipPreflight: false }), status: 'SUBMITTED' };
}

/**
 * Sign and submit the trade for a single already-confirmed quote. Decrypts
 * the user's key only for the duration of this call and never returns it.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  const privateKey = await decryptPrivateKey(params.encryptedKey, params.encryptionSecret);

  try {
    if (params.fromChainType === 'SVM') {
      return await executeSolana(params, privateKey);
    }
    return await executeEvm(params, privateKey);
  } finally {
    // Best-effort: there is no way to zero a JS string in place, but we drop
    // every reference to `privateKey` here so it becomes eligible for GC as
    // soon as this function returns.
  }
}

async function executeEvm(params: ExecuteParams, privateKey: string): Promise<ExecuteResult> {
  if (!params.evmRpcUrl) throw new Error('evmRpcUrl is required for EVM execution');
  if (!params.quote.transactionRequest) throw new Error('Quote has no EVM transactionRequest');

  const provider = new ethers.JsonRpcProvider(params.evmRpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const approvalAddress = params.quote.estimate.approvalAddress;
  // Arc's gas USDC (0x3600…) is pulled through its ERC-20 view, so it is approved like a token.
  const isNative = params.fromTokenAddress.toLowerCase() === 'native'
    || params.fromTokenAddress.toLowerCase() === EVM_NATIVE_TOKEN;

  if (approvalAddress && !isNative) {
    const token = new ethers.Contract(params.fromTokenAddress, ERC20_ABI, wallet);
    const current: bigint = await token.allowance(wallet.address, approvalAddress);
    const required = BigInt(params.quote.estimate.fromAmount);
    if (current < required) {
      const approveTx = await token.approve(approvalAddress, required);
      await approveTx.wait(1);
    }
  }

  const tx = await wallet.sendTransaction({
    to: params.quote.transactionRequest.to,
    data: params.quote.transactionRequest.data,
    value: params.quote.transactionRequest.value
      ? BigInt(params.quote.transactionRequest.value)
      : undefined,
    gasLimit: params.quote.transactionRequest.gasLimit
      ? BigInt(params.quote.transactionRequest.gasLimit)
      : undefined,
  });

  return { txHash: tx.hash, status: 'SUBMITTED' };
}

async function executeSolana(params: ExecuteParams, privateKeyBase58: string): Promise<ExecuteResult> {
  if (!params.solanaRpcUrl) throw new Error('solanaRpcUrl is required for Solana execution');
  if (!params.quote.transactionRequestSolana) {
    throw new Error('Quote has no Solana transaction payload');
  }

  const bs58 = await import('bs58');
  const { Keypair } = await import('@solana/web3.js');
  const secretKey = bs58.default.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);

  const connection = new Connection(params.solanaRpcUrl, 'confirmed');
  const txBytes = Uint8Array.from(atob(params.quote.transactionRequestSolana), (c) => c.charCodeAt(0));
  const versionedTx = VersionedTransaction.deserialize(txBytes);
  versionedTx.sign([keypair]);

  const signature = await connection.sendTransaction(versionedTx, { skipPreflight: false });
  // Same signed bytes, same signature: rebroadcasting is idempotent and only helps it land.
  if (params.solanaBroadcastUrls?.length) {
    const raw = versionedTx.serialize();
    await Promise.allSettled(params.solanaBroadcastUrls.map((url) => Promise.race([
      new Connection(url, 'confirmed').sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])));
  }
  return { txHash: signature, status: 'SUBMITTED' };
}

/**
 * Build the reversed route for a sell: takes proceeds on the token's chain
 * and routes them back to the exact chain/token the user originally funded
 * with, so a round trip always returns the user to their starting asset.
 */
export function buildSellQuoteRequest(original: {
  targetChain: string;
  targetTokenAddress: string;
  fundingChain: string;
  fundingTokenAddress: string;
  sellAmount: string;
  walletAddress: string; // the seller's address on the token's chain
  /** Where proceeds land; defaults to walletAddress (only valid when both chains share a VM). */
  toAddress?: string;
  slippage?: number;
}): LifiQuoteRequest {
  return {
    fromChain: original.targetChain,
    toChain: original.fundingChain,
    fromToken: original.targetTokenAddress,
    toToken: original.fundingTokenAddress,
    fromAmount: original.sellAmount,
    fromAddress: original.walletAddress,
    toAddress: original.toAddress ?? original.walletAddress,
    slippage: original.slippage ?? 0.03,
  };
}
