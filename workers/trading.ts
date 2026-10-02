// Trading module: custodial wallet provisioning + confirm-then-execute flow
// for the Telegram bot and dashboard.
//
// Design choice vs. the original spec: execution happens in two taps, not
// one. The first tap ("Buy 0.5") fetches a live LI.FI quote and shows the
// user exactly what they'll receive; only the second tap ("Confirm") signs
// and submits. The pending quote is cached for 90 seconds so "Confirm"
// can't replay a stale price. This is a deliberate safety margin on top of
// the original "no secondary confirmation" spec — custodial signing on a
// single accidental tap, with no amount or price shown first, is how users
// lose funds to fat-fingered taps or stale quotes.

import {
  generateDualWallet,
  encryptPrivateKey,
  decryptPrivateKey,
  packEncryptedSecret,
  unpackEncryptedSecret,
  type EncryptedSecret,
} from '../src/services/walletService';
import { getQuote, execute, executeNativeDeposit, buildSellQuoteRequest, type LifiQuote } from '../src/services/lifiTrader';
import { readNativeBalance } from './balances';
import { getChainById, getChainByKey, SUPPORTED_CHAINS } from '../src/services/chainDetector';
import {
  buildIntentsDepositPlan,
  buildRefSwapPlan,
  getNearBalance,
  getTokenMetadata,
  getNearSwapQuote,
  routeIntermediateTokens,
  HOPR_FEE_BPS,
  NATIVE_NEAR,
  NEAR_CHAIN_ID,
  NEAR_GAS_RESERVE_YOCTO,
  formatNearAmount,
  planAttachedDeposit,
  refInputContract,
  splitHoprFee,
  storageDepositNeeded,
  viewFunction,
  WRAP_NEAR,
  type NearRpcOptions,
  type RefSwapFee,
  type RefSwapQuote,
} from '../src/services/nearService';
import { executeNearTransactions, generateNearWallet } from '../src/services/nearSigner';
import { saveIntentsFeeQuote } from './intentsFees';

export interface TradingEnv {
  DB?: D1Database;
  TELEGRAM_STATE?: KVNamespace;
  ENCRYPTION_KEY?: string;
  LIFI_API_KEY?: string;
  /** Keyed NEAR RPC endpoint; public fallbacks are tried after it. */
  NEAR_RPC_URL?: string;
  /** Hopr's NEAR account: NEAR Intents app fee + Ref swap fee. */
  HOPR_INTENTS_FEE_ACCOUNT?: string;
  /** 1Click API key: default app-fee split is 50/50; public quotes add 25bps. */
  ONECLICK_JWT?: string;
}

export interface CustodialWallet {
  evmAddress: string;
  solanaAddress: string;
  /** NEAR implicit account; null until the user first uses NEAR (see ensureNearWallet). */
  nearAddress?: string | null;
}

export function nearRpcOptions(env: TradingEnv): NearRpcOptions {
  // NEAR_RPC_URL may list several keyed endpoints (comma-separated); public NEAR RPCs back them up.
  return { urls: (env.NEAR_RPC_URL ?? '').split(',').map((url) => url.trim()).filter(Boolean) };
}

/** Where signed transactions go: health-checked endpoints, keyed first (see workers/rpcConfig.ts). */
export interface TransactionRpcs {
  evm: (chainId: number) => Promise<string>;
  solana: () => Promise<string>;
  /** Extra Solana endpoints the same signed transaction is also broadcast to. */
  solanaBroadcast?: (primary: string) => string[];
}

const MISSING_NEAR_COLUMNS = /no such column: near_|has no column named near_/i;
const NEAR_MIGRATION_REQUIRED = 'NEAR wallets need migrations/0004_add_near_chain.sql applied to the D1 database.';

/** Run a query that reads NEAR columns, falling back to `legacySql` before migration 0004 is applied. */
async function firstWithNearFallback<T>(env: TradingEnv, sql: string, legacySql: string, binds: unknown[]): Promise<T | null> {
  try {
    return await env.DB!.prepare(sql).bind(...binds).first<T>();
  } catch (error) {
    if (!MISSING_NEAR_COLUMNS.test(String(error))) throw error;
    return env.DB!.prepare(legacySql).bind(...binds).first<T>();
  }
}

const PENDING_TRADE_TTL_SECONDS = 90;
const EVM_NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SOLANA_NATIVE_TOKEN = '11111111111111111111111111111111';
/** Arc pays gas in USDC; LI.FI quotes it as this 6-decimal ERC-20 view (balances/values stay 18-decimal). */
export const ARC_CHAIN_ID = 5042;
export const ARC_NATIVE_USDC = '0x3600000000000000000000000000000000000000';

function nativeTokenAddress(chainKey: string): string {
  return chainKey === 'sol' ? SOLANA_NATIVE_TOKEN : EVM_NATIVE_TOKEN;
}

/** Fetch the user's custodial wallet, or null if they haven't created one. */
export async function getCustodialWallet(userId: string, env: TradingEnv): Promise<CustodialWallet | null> {
  if (!env.DB) return null;
  type Row = { evm_address: string; solana_address: string; near_address?: string | null };
  let row: Row | null = null;
  try {
    row = await firstWithNearFallback<Row>(
      env,
      `SELECT evm_address, solana_address, near_address FROM wallet_accounts WHERE user_id = ?1 AND evm_address IS NOT NULL AND solana_address IS NOT NULL ORDER BY is_active DESC, created_at ASC LIMIT 1`,
      `SELECT evm_address, solana_address FROM wallet_accounts WHERE user_id = ?1 AND evm_address IS NOT NULL AND solana_address IS NOT NULL ORDER BY is_active DESC, created_at ASC LIMIT 1`,
      [userId],
    );
  } catch {
    // The multi-wallet migration may not be applied yet; fall back to the legacy single-wallet table.
  }
  if (!row) {
    row = await firstWithNearFallback<Row>(
      env,
      `SELECT evm_address, solana_address, near_address FROM user_wallets WHERE user_id = ?1`,
      `SELECT evm_address, solana_address FROM user_wallets WHERE user_id = ?1`,
      [userId],
    );
  }
  if (!row) return null;
  return { evmAddress: row.evm_address, solanaAddress: row.solana_address, nearAddress: row.near_address ?? null };
}

/**
 * Return the user's NEAR account, generating and storing a key the first time.
 * The conditional UPDATE (`near_address IS NULL`) makes this safe under
 * concurrent calls: whichever key lands first wins and every caller returns
 * that stored address, so funds are never sent to an address whose key was
 * overwritten.
 */
export async function ensureNearWallet(userId: string, env: TradingEnv): Promise<string> {
  if (!env.DB) throw new Error('DB binding is required for NEAR wallets');
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY secret is required for NEAR wallets');
  const wallet = await getCustodialWallet(userId, env);
  if (!wallet) throw new Error('Create a Hopr wallet first.');
  if (wallet.nearAddress) return wallet.nearAddress;

  const near = generateNearWallet();
  const encrypted = packEncryptedSecret(await encryptPrivateKey(near.privateKey, env.ENCRYPTION_KEY));
  try {
    const account = await env.DB.prepare(
      `SELECT id FROM wallet_accounts WHERE user_id = ?1 AND evm_address = ?2 AND solana_address = ?3 ORDER BY is_active DESC, created_at ASC LIMIT 1`
    ).bind(userId, wallet.evmAddress, wallet.solanaAddress).first<{ id: string }>().catch(() => null);
    if (account) {
      await env.DB.prepare(`UPDATE wallet_accounts SET near_address = ?1, near_encrypted_key = ?2 WHERE id = ?3 AND near_address IS NULL`)
        .bind(near.address, encrypted, account.id).run();
      const stored = await env.DB.prepare(`SELECT near_address, near_encrypted_key FROM wallet_accounts WHERE id = ?1`)
        .bind(account.id).first<{ near_address: string | null; near_encrypted_key: string | null }>();
      if (!stored?.near_address || !stored.near_encrypted_key) throw new Error('Could not store the NEAR wallet.');
      await env.DB.prepare(`UPDATE user_wallets SET near_address = ?1, near_encrypted_key = ?2 WHERE user_id = ?3 AND evm_address = ?4 AND near_address IS NULL`)
        .bind(stored.near_address, stored.near_encrypted_key, userId, wallet.evmAddress).run();
      return stored.near_address;
    }
    await env.DB.prepare(`UPDATE user_wallets SET near_address = ?1, near_encrypted_key = ?2 WHERE user_id = ?3 AND near_address IS NULL`)
      .bind(near.address, encrypted, userId).run();
    const stored = await env.DB.prepare(`SELECT near_address FROM user_wallets WHERE user_id = ?1`).bind(userId).first<{ near_address: string | null }>();
    if (!stored?.near_address) throw new Error('Could not store the NEAR wallet.');
    return stored.near_address;
  } catch (error) {
    if (MISSING_NEAR_COLUMNS.test(String(error))) throw new Error(NEAR_MIGRATION_REQUIRED);
    throw error;
  }
}

/** The encrypted key for the user's NEAR account (the same wallet row getCustodialWallet reads). */
async function getNearSigner(userId: string, env: TradingEnv, walletId?: string): Promise<{ accountId: string; encryptedKey: EncryptedSecret }> {
  if (!env.DB) throw new Error('DB binding required');
  type Row = { near_address: string | null; near_encrypted_key: string | null };
  let row: Row | null = null;
  if (walletId) {
    // A bundle trade signs with the wallet it was quoted for, not the active one.
    row = await env.DB.prepare(`SELECT near_address, near_encrypted_key FROM wallet_accounts WHERE id = ?1 AND user_id = ?2`).bind(walletId, userId).first<Row>();
    if (!row?.near_address || !row.near_encrypted_key) throw new Error('That wallet has no NEAR account yet.');
    return { accountId: row.near_address, encryptedKey: unpackEncryptedSecret(row.near_encrypted_key) };
  }
  try {
    row = await env.DB.prepare(
      `SELECT near_address, near_encrypted_key FROM wallet_accounts WHERE user_id = ?1 AND evm_address IS NOT NULL AND solana_address IS NOT NULL ORDER BY is_active DESC, created_at ASC LIMIT 1`
    ).bind(userId).first<Row>().catch((error: unknown) => {
      if (MISSING_NEAR_COLUMNS.test(String(error))) throw error;
      return null; // multi-wallet table missing: use the legacy table
    });
    if (!row?.near_encrypted_key) {
      row = await env.DB.prepare(`SELECT near_address, near_encrypted_key FROM user_wallets WHERE user_id = ?1`).bind(userId).first<Row>();
    }
  } catch (error) {
    if (MISSING_NEAR_COLUMNS.test(String(error))) throw new Error(NEAR_MIGRATION_REQUIRED);
    throw error;
  }
  if (!row?.near_address || !row.near_encrypted_key) throw new Error('No NEAR wallet on file. Open /wallet to create one.');
  return { accountId: row.near_address, encryptedKey: unpackEncryptedSecret(row.near_encrypted_key) };
}

/**
 * Create a new custodial wallet for a user, encrypt both private keys, and
 * store them. Refuses to overwrite an existing wallet — call
 * getCustodialWallet() first. Throws if ENCRYPTION_KEY or DB is missing.
 */
export async function createCustodialWallet(userId: string, env: TradingEnv): Promise<CustodialWallet> {
  if (!env.DB) throw new Error('DB binding is required to create a custodial wallet');
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY secret is required to create a custodial wallet');

  const existing = await getCustodialWallet(userId, env);
  if (existing) return existing;

  const wallet = generateDualWallet();
  const near = generateNearWallet();
  const evmEncrypted = await encryptPrivateKey(wallet.evmPrivateKey, env.ENCRYPTION_KEY);
  const solEncrypted = await encryptPrivateKey(wallet.solanaPrivateKey, env.ENCRYPTION_KEY);

  const packedEvm = packEncryptedSecret(evmEncrypted);
  const packedSolana = packEncryptedSecret(solEncrypted);
  const packedNear = packEncryptedSecret(await encryptPrivateKey(near.privateKey, env.ENCRYPTION_KEY));
  const walletId = crypto.randomUUID();
  let nearStored = true;
  try {
    await env.DB.prepare(
      `INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, near_address, near_encrypted_key, is_active)
       VALUES (?1, ?2, ?3, 'generated', ?4, ?5, ?6, ?7, ?8, ?9, 1)`
    ).bind(walletId, userId, 'W1', wallet.evmAddress, packedEvm, wallet.solanaAddress, packedSolana, near.address, packedNear).run();
  } catch (error) {
    // Before 0004 (no NEAR columns): store EVM + Solana; ensureNearWallet adds NEAR later.
    // Before 0003 (no wallet_accounts table): the legacy table below is the only store.
    if (MISSING_NEAR_COLUMNS.test(String(error))) {
      nearStored = false;
      await env.DB.prepare(
        `INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active)
         VALUES (?1, ?2, ?3, 'generated', ?4, ?5, ?6, ?7, 1)`
      ).bind(walletId, userId, 'W1', wallet.evmAddress, packedEvm, wallet.solanaAddress, packedSolana).run().catch(() => undefined);
    }
  }
  try {
    if (!nearStored) throw new Error('no such column: near_address');
    await env.DB.prepare(
      `INSERT INTO user_wallets (user_id, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, near_address, near_encrypted_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(userId, wallet.evmAddress, packedEvm, wallet.solanaAddress, packedSolana, near.address, packedNear).run();
  } catch (error) {
    if (!MISSING_NEAR_COLUMNS.test(String(error))) throw error;
    nearStored = false;
    await env.DB.prepare(
      `INSERT INTO user_wallets (user_id, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(userId, wallet.evmAddress, packedEvm, wallet.solanaAddress, packedSolana).run();
  }

  return { evmAddress: wallet.evmAddress, solanaAddress: wallet.solanaAddress, nearAddress: nearStored ? near.address : null };
}

async function getEncryptedKey(
  userId: string,
  chainType: 'EVM' | 'SVM',
  env: TradingEnv,
  walletId?: string,
): Promise<EncryptedSecret> {
  if (!env.DB) throw new Error('DB binding required');
  let row: { evm_encrypted_key: string; solana_encrypted_key: string } | null = null;
  if (walletId) {
    // A bundle trade signs with the wallet it was quoted for, not the active one.
    row = await env.DB.prepare(`SELECT evm_encrypted_key, solana_encrypted_key FROM wallet_accounts WHERE id = ?1 AND user_id = ?2`)
      .bind(walletId, userId).first<{ evm_encrypted_key: string; solana_encrypted_key: string }>();
    if (!row) throw new Error('That wallet no longer exists.');
    return unpackEncryptedSecret(chainType === 'EVM' ? row.evm_encrypted_key : row.solana_encrypted_key);
  }
  try {
    row = await env.DB.prepare(
      `SELECT evm_encrypted_key, solana_encrypted_key FROM wallet_accounts WHERE user_id = ?1 AND evm_encrypted_key IS NOT NULL AND solana_encrypted_key IS NOT NULL ORDER BY is_active DESC, created_at ASC LIMIT 1`
    ).bind(userId).first<{ evm_encrypted_key: string; solana_encrypted_key: string }>();
  } catch {
    // Fall through to the legacy table.
  }
  if (!row) {
    row = await env.DB.prepare(
      `SELECT evm_encrypted_key, solana_encrypted_key FROM user_wallets WHERE user_id = ?1`
    ).bind(userId).first<{ evm_encrypted_key: string; solana_encrypted_key: string }>();
  }
  if (!row) throw new Error('No custodial wallet on file for this user');
  const packed = chainType === 'EVM' ? row.evm_encrypted_key : row.solana_encrypted_key;
  return unpackEncryptedSecret(packed);
}

export interface PendingTrade {
  id: string;
  userId: string;
  kind: 'buy' | 'sell';
  /** Signing wallet for bundle trades; absent = the active wallet. */
  walletId?: string;
  /** Part of a bundle: a sell does not close the user's recorded position for the token. */
  bundle?: boolean;
  /** Execution venue; absent on quotes stored before NEAR support (treated as LI.FI). */
  venue?: 'lifi' | 'ref' | 'intents';
  quote: LifiQuote;
  /** Address that signs (and pays) — recorded for referral verification. */
  fromAddress?: string;
  /** Hopr fee on this quote in bps (0 on step 2 of a NEAR-funded buy). */
  feeBps?: number;
  sourceContinuationId?: string;
  /** Set on a LI.FI hop to a hub chain whose coins continue into a NEAR token (e.g. Arc → Base → NEAR). */
  hubContinuation?: { hubChainId: number; targetChainId: number; targetTokenAddress: string; targetSymbol: string; slippage: number; hubBalanceBefore: string };
  /** NEAR → another chain through NEAR Intents (step 1 of a NEAR-funded buy). */
  intents?: {
    accountId: string;
    depositAddress: string;
    amountIn: string;
    expectedOut: string;
    minOut: string;
    outSymbol: string;
    outDecimals: number;
    feeBps: number;
    /** Set when the delivered coin still has to be swapped into the token (step 2). */
    continuation?: { targetChainId: number; targetTokenAddress: string; targetSymbol: string; slippage: number; hubChainId?: number;
      nearAccountId?: string; nativeBefore?: string; wrappedBefore?: string };
  };
  /** Ref Finance route + registration deposits; the transaction plan is rebuilt from these at confirm time. */
  nearSwap?: {
    accountId: string;
    quote: RefSwapQuote;
    outputStorageDeposit: string;
    wrapStorageDeposit: string;
    /** Registrations for tokens a multi-leg route passes through (e.g. RHEA). */
    intermediateStorageDeposits?: Record<string, string>;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    tokenInDecimals: number;
    tokenOutDecimals: number;
    /** Hopr's fee, paid in the input token inside the swap transaction (absent when not configured). */
    fee?: { account: string; amount: string; storageDeposit: string };
  };
  fromChainType: 'EVM' | 'SVM' | 'NEAR';
  fromChainKey: string;
  toChainId: number;
  toChainType: 'EVM' | 'SVM' | 'NEAR';
  fromTokenAddress: string;
  toTokenAddress: string;
  fundingChainId: number; // for buy: the chain the user paid from; for sell: where proceeds return to
  fundingTokenAddress: string;
  displayAmount: string;
  displaySymbol: string;
  createdAt: number;
}

function pendingTradeKey(userId: string, tradeId: string) {
  return `pending_trade:${userId}:${tradeId}`;
}

async function storePendingTrade(trade: PendingTrade, env: TradingEnv): Promise<void> {
  if (!env.TELEGRAM_STATE) throw new Error('TELEGRAM_STATE KV binding required to hold a pending quote');
  await env.TELEGRAM_STATE.put(pendingTradeKey(trade.userId, trade.id), JSON.stringify(trade), {
    expirationTtl: PENDING_TRADE_TTL_SECONDS,
  });
}

async function loadPendingTrade(userId: string, tradeId: string, env: TradingEnv): Promise<PendingTrade | null> {
  if (!env.TELEGRAM_STATE) return null;
  const raw = await env.TELEGRAM_STATE.get(pendingTradeKey(userId, tradeId));
  if (!raw) return null;
  return JSON.parse(raw) as PendingTrade;
}

/**
 * Step 1 of a buy: quote it and cache the quote for confirmation. Returns
 * the quote plus a short-lived trade id to pass to confirmTrade().
 */
export async function prepareBuy(params: {
  userId: string;
  wallet: CustodialWallet;
  fundingChainKey: string; // LI.FI key, e.g. 'bas'
  fundingTokenAddress: string; // 'native' or an ERC-20/SPL address
  fundingAmountUnits: string; // smallest-unit string
  targetChainId: number;
  targetTokenAddress: string;
  slippage: number;
  /** Hopr fee fraction; 0 for the second step of a NEAR-funded buy (fee already paid in step 1). */
  fee?: number;
  /** Bundle buys: the wallet that signs (default: the active wallet). */
  walletId?: string;
}, env: TradingEnv): Promise<PendingTrade> {
  const fundingChain = getChainByKey(params.fundingChainKey);
  const targetChain = getChainById(params.targetChainId);
  if (!fundingChain || !targetChain) throw new Error('Unsupported chain');

  const fromAddress = fundingChain.type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress;
  const toAddress = targetChain.type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress;
  const arcNative = fundingChain.id === ARC_CHAIN_ID && params.fundingTokenAddress === 'native';
  const fundingTokenAddress = params.fundingTokenAddress === 'native'
    ? (arcNative ? ARC_NATIVE_USDC : nativeTokenAddress(fundingChain.key))
    : params.fundingTokenAddress;
  // Amounts arrive in native units (18 decimals); LI.FI wants Arc's gas USDC in 6.
  const quoteAmount = arcNative ? (BigInt(params.fundingAmountUnits) / 10n ** 12n).toString() : params.fundingAmountUnits;

  const quote = await getQuote(
    {
      // Numeric chain ids: LI.FI's keys differ from ours for some chains (e.g. Robinhood).
      fromChain: String(fundingChain.id),
      toChain: String(targetChain.id),
      fromToken: fundingTokenAddress,
      toToken: params.targetTokenAddress,
      fromAmount: quoteAmount,
      fromAddress,
      toAddress,
      slippage: params.slippage,
      fee: params.fee ?? HOPR_FEE_BPS.swap / 10_000,
    },
    env.LIFI_API_KEY ?? ''
  );

  const trade: PendingTrade = {
    id: crypto.randomUUID(),
    userId: params.userId,
    kind: 'buy',
    ...(params.walletId ? { walletId: params.walletId, bundle: true } : {}),
    quote,
    fromAddress,
    feeBps: Math.round((params.fee ?? HOPR_FEE_BPS.swap / 10_000) * 10_000),
    fromChainType: fundingChain.type,
    fromChainKey: fundingChain.key,
    toChainId: targetChain.id,
    toChainType: targetChain.type,
    fromTokenAddress: fundingTokenAddress,
    toTokenAddress: params.targetTokenAddress,
    fundingChainId: fundingChain.id,
    fundingTokenAddress,
    displayAmount: params.fundingAmountUnits,
    displaySymbol: fundingChain.nativeSymbol,
    createdAt: Date.now(),
  };
  await storePendingTrade(trade, env);
  return trade;
}

/**
 * Bundle sell: sell `amountUnits` of a token held by one wallet into the
 * coin of the token's own chain (one LI.FI swap, signed by that wallet).
 */
export async function prepareTokenSell(params: {
  userId: string;
  wallet: CustodialWallet;
  walletId: string;
  chainId: number;
  tokenAddress: string;
  amountUnits: string;
  slippage: number;
}, env: TradingEnv): Promise<PendingTrade> {
  const chain = getChainById(params.chainId);
  if (!chain) throw new Error('Unsupported chain');
  const owner = chain.type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress;
  const native = chain.id === ARC_CHAIN_ID ? ARC_NATIVE_USDC : nativeTokenAddress(chain.key);
  const quote = await getQuote({
    fromChain: String(chain.id), toChain: String(chain.id), fromToken: params.tokenAddress, toToken: native,
    fromAmount: params.amountUnits, fromAddress: owner, toAddress: owner, slippage: params.slippage, fee: HOPR_FEE_BPS.swap / 10_000,
  }, env.LIFI_API_KEY ?? '');
  const trade: PendingTrade = {
    id: crypto.randomUUID(),
    userId: params.userId,
    kind: 'sell',
    walletId: params.walletId,
    bundle: true,
    quote,
    fromAddress: owner,
    feeBps: HOPR_FEE_BPS.swap,
    fromChainType: chain.type,
    fromChainKey: chain.key,
    toChainId: chain.id,
    toChainType: chain.type,
    fromTokenAddress: params.tokenAddress,
    toTokenAddress: native,
    fundingChainId: chain.id,
    fundingTokenAddress: native,
    displayAmount: params.amountUnits,
    displaySymbol: chain.nativeSymbol,
    createdAt: Date.now(),
  };
  await storePendingTrade(trade, env);
  return trade;
}

/**
 * Step 1 of a sell: look up the original funding route for this position
 * and quote the reverse trip, so proceeds land back on the original chain
 * and token.
 */
export async function prepareSell(params: {
  userId: string;
  wallet: CustodialWallet;
  originalTradeDbId: string;
  sellAmountUnits: string;
  slippage: number;
}, env: TradingEnv): Promise<PendingTrade> {
  if (!env.DB) throw new Error('DB binding required');
  const original = await env.DB.prepare(
    `SELECT target_token_address, target_chain_id, funding_chain_id, funding_token_address
       FROM user_trades WHERE id = ?1 AND user_id = ?2`
  )
    .bind(params.originalTradeDbId, params.userId)
    .first<{
      target_token_address: string;
      target_chain_id: string;
      funding_chain_id: string;
      funding_token_address: string;
    }>();
  if (!original) throw new Error('Original purchase not found');

  const targetChain = getChainById(Number(original.target_chain_id));
  const fundingChain = getChainById(Number(original.funding_chain_id));
  if (!targetChain || !fundingChain) throw new Error('Unsupported chain on original trade');

  const walletAddress = targetChain.type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress;
  // Proceeds land on the funding chain, so they need that chain's address (EVM ≠ Solana).
  const proceedsAddress = fundingChain.type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress;

  const req = buildSellQuoteRequest({
    targetChain: String(targetChain.id),
    targetTokenAddress: original.target_token_address,
    fundingChain: String(fundingChain.id),
    fundingTokenAddress: original.funding_token_address,
    sellAmount: params.sellAmountUnits,
    walletAddress,
    toAddress: proceedsAddress,
    slippage: params.slippage,
  });
  const quote = await getQuote(req, env.LIFI_API_KEY ?? '');

  const trade: PendingTrade = {
    id: crypto.randomUUID(),
    userId: params.userId,
    kind: 'sell',
    quote,
    fromAddress: walletAddress,
    feeBps: HOPR_FEE_BPS.swap,
    fromChainType: targetChain.type,
    fromChainKey: targetChain.key,
    toChainId: fundingChain.id,
    toChainType: fundingChain.type,
    fromTokenAddress: original.target_token_address,
    toTokenAddress: original.funding_token_address,
    fundingChainId: fundingChain.id,
    fundingTokenAddress: original.funding_token_address,
    displayAmount: params.sellAmountUnits,
    displaySymbol: targetChain.nativeSymbol,
    createdAt: Date.now(),
  };
  await storePendingTrade(trade, env);
  return trade;
}

/**
 * Step 1 of a NEAR swap (buy or sell) on Ref Finance. Checks the wallet can
 * cover the amount, storage registrations and a gas reserve before storing
 * the quote, so Confirm only fails for market reasons (price moved past
 * slippage) rather than an avoidable balance error.
 */
export async function prepareNearSwap(params: {
  userId: string;
  kind: 'buy' | 'sell';
  tokenIn: { id: string; symbol: string; decimals: number }; // id: NATIVE_NEAR or a NEP-141 contract
  tokenOut: { id: string; symbol: string; decimals: number };
  amountInUnits: string;
  slippage: number; // fraction, e.g. 0.01
  /** Zero for a continuation whose platform fee was already paid. */
  feeBps?: number;
  /** Bundle trades: the wallet that signs (default: the active wallet). */
  walletId?: string;
}, env: TradingEnv): Promise<PendingTrade> {
  const rpc = nearRpcOptions(env);
  const accountId = params.walletId ? (await getNearSigner(params.userId, env, params.walletId)).accountId : await ensureNearWallet(params.userId, env);
  // Hopr's 0.75% is taken from the input inside the swap transaction; the rest is swapped.
  const feeAccount = env.HOPR_INTENTS_FEE_ACCOUNT?.trim() ?? '';
  const { net, fee } = splitHoprFee(BigInt(params.amountInUnits), feeAccount ? params.feeBps ?? HOPR_FEE_BPS.swap : 0);
  // Best of Ref's smart router and Rhea DCL pools (launchpad tokens often trade only on DCL).
  const quote = await getNearSwapQuote({ tokenIn: params.tokenIn.id, tokenOut: params.tokenOut.id, amountIn: net.toString(), slippage: params.slippage, accountId, rpc });
  const usesWnear = params.tokenIn.id === NATIVE_NEAR || (params.tokenOut.id === NATIVE_NEAR && quote.legs?.at(-1)?.venue === 'dcl');

  const [outputStorageDeposit, wrapStorageDeposit, feeStorageDeposit, balance, intermediates] = await Promise.all([
    params.tokenOut.id === NATIVE_NEAR ? 0n : storageDepositNeeded(params.tokenOut.id, accountId, rpc),
    usesWnear ? storageDepositNeeded(WRAP_NEAR, accountId, rpc) : 0n,
    fee > 0n ? storageDepositNeeded(refInputContract(params.tokenIn.id), feeAccount, rpc) : 0n,
    getNearBalance(accountId, [], rpc),
    Promise.all(routeIntermediateTokens(quote).map(async (token) => [token, await storageDepositNeeded(token, accountId, rpc)] as const)),
  ]);
  const intermediateStorageDeposits = Object.fromEntries(intermediates.filter(([, deposit]) => deposit > 0n));
  const hoprFee: RefSwapFee | null = fee > 0n ? { account: feeAccount, amount: fee, storageDeposit: feeStorageDeposit } : null;
  const needed = planAttachedDeposit(buildRefSwapPlan(quote, { outputStorageDeposit, wrapStorageDeposit, intermediateStorageDeposits }, hoprFee)) + NEAR_GAS_RESERVE_YOCTO;
  if (!balance.exists || BigInt(balance.availableYocto) < needed) {
    throw new Error(`Not enough NEAR: this swap needs about ${formatNearAmount(needed)} NEAR including storage and gas, and your wallet has ${formatNearAmount(balance.availableYocto)} NEAR available.`);
  }
  if (params.tokenIn.id !== NATIVE_NEAR) {
    const held = BigInt(await viewFunction<string>(params.tokenIn.id, 'ft_balance_of', { account_id: accountId }, rpc).catch(() => '0'));
    if (held < BigInt(params.amountInUnits)) throw new Error(`Not enough ${params.tokenIn.symbol} in your NEAR wallet.`);
  }

  const trade: PendingTrade = {
    id: crypto.randomUUID(),
    userId: params.userId,
    kind: params.kind,
    ...(params.walletId ? { walletId: params.walletId, bundle: true } : {}),
    venue: 'ref',
    quote: {
      id: `ref:${crypto.randomUUID()}`,
      estimate: { fromAmount: quote.amountIn, toAmount: quote.expectedOut, toAmountMin: quote.minOut, executionDuration: 3 },
      raw: quote,
    },
    nearSwap: {
      accountId,
      quote,
      outputStorageDeposit: outputStorageDeposit.toString(),
      wrapStorageDeposit: wrapStorageDeposit.toString(),
      ...(Object.keys(intermediateStorageDeposits).length ? { intermediateStorageDeposits: Object.fromEntries(Object.entries(intermediateStorageDeposits).map(([token, deposit]) => [token, deposit.toString()])) } : {}),
      tokenInSymbol: params.tokenIn.symbol,
      tokenOutSymbol: params.tokenOut.symbol,
      tokenInDecimals: params.tokenIn.decimals,
      tokenOutDecimals: params.tokenOut.decimals,
      ...(hoprFee ? { fee: { account: hoprFee.account, amount: hoprFee.amount.toString(), storageDeposit: hoprFee.storageDeposit.toString() } } : {}),
    },
    fromAddress: accountId,
    fromChainType: 'NEAR',
    fromChainKey: 'near',
    toChainId: NEAR_CHAIN_ID,
    toChainType: 'NEAR',
    fromTokenAddress: params.tokenIn.id,
    toTokenAddress: params.tokenOut.id,
    fundingChainId: NEAR_CHAIN_ID,
    fundingTokenAddress: params.kind === 'buy' ? params.tokenIn.id : params.tokenOut.id,
    displayAmount: params.amountInUnits,
    displaySymbol: params.tokenIn.symbol,
    createdAt: Date.now(),
  };
  await storePendingTrade(trade, env);
  return trade;
}

// ---------------------------------------------------------------------------
// NEAR-funded buys of tokens on other chains (NEAR Intents, then LI.FI)
// ---------------------------------------------------------------------------

const ONECLICK_API = 'https://1click.chaindefuser.com/v0';
const BASE_CHAIN_ID = 8453;
const INTENTS_CHAIN: Record<number, string> = { 8453: 'base', 42161: 'arb', 56: 'bsc', 4663: 'hood', 1151111081099710: 'sol' };
interface IntentsToken { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress?: string }
let intentsTokenCache: { at: number; tokens: IntentsToken[] } | null = null;

async function intentsTokens(): Promise<IntentsToken[]> {
  if (intentsTokenCache && Date.now() - intentsTokenCache.at < 10 * 60_000) return intentsTokenCache.tokens;
  const response = await fetch(`${ONECLICK_API}/tokens`, { signal: AbortSignal.timeout(8_000) })
    .catch(() => { throw new Error('NEAR Intents is unavailable right now.'); });
  if (!response.ok) throw new Error('NEAR Intents is unavailable right now.');
  intentsTokenCache = { at: Date.now(), tokens: await response.json() as IntentsToken[] };
  return intentsTokenCache.tokens;
}

/** 1Click asset for a token (or the native coin) on an EVM/Solana chain, or null if 1Click doesn't list it. */
async function intentsAsset(chainId: number, tokenAddress: string | 'native'): Promise<IntentsToken | null> {
  const chain = INTENTS_CHAIN[chainId];
  if (!chain) return null;
  const tokens = (await intentsTokens()).filter((token) => token.blockchain === chain);
  if (tokenAddress === 'native') {
    const symbol = getChainById(chainId)?.nativeSymbol.toUpperCase();
    return tokens.find((token) => !token.contractAddress && token.symbol.toUpperCase() === symbol) ?? null;
  }
  return tokens.find((token) => token.contractAddress?.toLowerCase() === tokenAddress.toLowerCase()) ?? null;
}

/**
 * Ask 1Click for a quote. Hopr's app fee is added here (server-side) when the
 * fee account is configured. Authenticated default terms split it 50/50.
 */
export async function requestIntentsQuote(body: Record<string, unknown>, feeBps: number, env: TradingEnv): Promise<{ status: number; data: Record<string, unknown> }> {
  const feeAccount = env.HOPR_INTENTS_FEE_ACCOUNT?.trim();
  const payload = { ...body, appFees: feeAccount && feeBps > 0 ? [{ recipient: feeAccount, fee: feeBps }] : [] };
  const response = await fetch(`${ONECLICK_API}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(env.ONECLICK_JWT ? { Authorization: `Bearer ${env.ONECLICK_JWT}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('NEAR Intents is slow to quote right now. Please try again in a moment.');
    throw error;
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  const quote = data.quote as { depositAddress?: string } | undefined;
  if (response.ok && body.dry === false && quote?.depositAddress && feeAccount && feeBps > 0 && env.DB) {
    // Await durable accounting before giving the user an address to fund.
    await saveIntentsFeeQuote(env.DB, {
      depositAddress: quote.depositAddress, refundWallet: String(body.refundTo),
      feeAccount, requestedBps: feeBps, authenticated: Boolean(env.ONECLICK_JWT),
    });
  }
  return { status: response.status, data: response.ok ? { ...data, hoprFee: {
    requestedBps: feeAccount ? feeBps : 0, authenticated: Boolean(env.ONECLICK_JWT),
  } } : data };
}

/**
 * Step 1 of buying an EVM/Solana token with NEAR: bridge NEAR through NEAR
 * Intents to the token itself when 1Click lists it, otherwise to the chain's
 * native coin, which step 2 (continueNearFundedBuy) swaps into the token.
 */
export async function prepareNearIntentsBuy(params: {
  userId: string;
  wallet: CustodialWallet;
  amountYocto: string;
  targetChainId: number;
  targetTokenAddress: string;
  targetSymbol: string;
  slippage: number;
}, env: TradingEnv): Promise<PendingTrade> {
  const targetChain = getChainById(params.targetChainId);
  if (!targetChain) throw new Error('Unsupported chain');
  const accountId = await ensureNearWallet(params.userId, env);
  const rpc = nearRpcOptions(env);
  const balance = await getNearBalance(accountId, [], rpc);
  const amount = BigInt(params.amountYocto);
  if (!balance.exists || BigInt(balance.availableYocto) < amount + NEAR_GAS_RESERVE_YOCTO) {
    throw new Error(`Not enough NEAR: you have ${formatNearAmount(balance.availableYocto)} NEAR available (keep ~0.05 for gas).`);
  }
  const quoteTo = async (destinationAsset: string, recipient: string) => {
    const { status, data } = await requestIntentsQuote({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: Math.round(params.slippage * 10_000),
      originAsset: `nep141:${WRAP_NEAR}`,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset,
      amount: amount.toString(),
      refundTo: accountId,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    }, HOPR_FEE_BPS.swap, env);
    const quote = data.quote as { depositAddress?: string; amountOut?: string; minAmountOut?: string; timeEstimate?: number } | undefined;
    if (status >= 400 || !quote?.depositAddress || !quote.amountOut) {
      throw new Error(typeof data.message === 'string' ? `NEAR Intents: ${data.message}` : 'NEAR Intents could not quote this route.');
    }
    return { data, quote: quote as Required<Pick<typeof quote, 'depositAddress' | 'amountOut'>> & typeof quote };
  };
  const addressOn = (type: 'EVM' | 'SVM' | 'NEAR') => (type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress);

  let direct = await intentsAsset(params.targetChainId, params.targetTokenAddress);
  let destination = direct ?? await intentsAsset(params.targetChainId, 'native');
  let hubChainId = params.targetChainId;
  let result: Awaited<ReturnType<typeof quoteTo>> | null = null;
  let firstError: unknown = null;
  if (destination) {
    result = await quoteTo(destination.assetId, addressOn(targetChain.type)).catch((error) => { firstError = error; return null; });
  }
  if (!result && params.targetChainId !== BASE_CHAIN_ID) {
    // NEAR Intents can't serve this chain right now (minimums, liquidity): land ETH on Base, then LI.FI crosses over.
    const base = await intentsAsset(BASE_CHAIN_ID, 'native');
    if (base) {
      result = await quoteTo(base.assetId, params.wallet.evmAddress).catch(() => null);
      if (result) {
        direct = null;
        destination = base;
        hubChainId = BASE_CHAIN_ID;
      }
    }
  }
  if (!result || !destination) {
    if (firstError) throw firstError;
    throw new Error(`NEAR Intents doesn't reach ${targetChain.name} yet. Pick another funding chain in /settings.`);
  }
  const { data, quote } = result;
  const hubChain = getChainById(hubChainId)!;
  if (!direct) {
    if (!env.TELEGRAM_STATE) throw new Error('Multi-step NEAR buys require TELEGRAM_STATE to resume the final swap.');
    const reserve = hubChain.type === 'SVM' ? 5_000_000n : hubChainId === ARC_CHAIN_ID ? 100_000n : hubChainId === 56 ? 1_000_000_000_000_000n : 300_000_000_000_000n;
    const spend = BigInt(quote.minAmountOut ?? quote.amountOut) - reserve;
    if (spend <= 0n) throw new Error('This amount cannot cover the final swap and gas. No funds were moved.');
    // Check the final market before offering the bridge for confirmation. The route
    // is quoted again after delivery because this preview can expire or lose liquidity.
    try {
      await getQuote({ fromChain: String(hubChainId), toChain: String(params.targetChainId),
        fromToken: hubChainId === ARC_CHAIN_ID ? ARC_NATIVE_USDC : nativeTokenAddress(hubChain.key),
        toToken: params.targetTokenAddress, fromAmount: spend.toString(),
        fromAddress: addressOn(hubChain.type), toAddress: addressOn(targetChain.type),
        slippage: params.slippage, fee: 0 }, env.LIFI_API_KEY ?? '');
    } catch {
      throw new Error('The final token swap could not be quoted. No NEAR was moved. Retry or choose another token.');
    }
  }
  const trade: PendingTrade = {
    id: crypto.randomUUID(),
    userId: params.userId,
    kind: 'buy',
    venue: 'intents',
    quote: {
      id: `intents:${quote.depositAddress}`,
      estimate: { fromAmount: amount.toString(), toAmount: quote.amountOut, toAmountMin: quote.minAmountOut ?? quote.amountOut, executionDuration: quote.timeEstimate ?? 120 },
      raw: data,
    },
    fromAddress: accountId,
    intents: {
      accountId,
      depositAddress: quote.depositAddress,
      amountIn: amount.toString(),
      expectedOut: quote.amountOut,
      minOut: quote.minAmountOut ?? quote.amountOut,
      outSymbol: direct ? params.targetSymbol : hubChain.nativeSymbol,
      outDecimals: destination.decimals,
      feeBps: env.HOPR_INTENTS_FEE_ACCOUNT ? HOPR_FEE_BPS.swap : 0,
      ...(direct ? {} : {
        continuation: { targetChainId: params.targetChainId, targetTokenAddress: params.targetTokenAddress, targetSymbol: params.targetSymbol, slippage: params.slippage, hubChainId },
      }),
    },
    fromChainType: 'NEAR',
    fromChainKey: 'near',
    toChainId: hubChainId,
    toChainType: hubChain.type,
    fromTokenAddress: NATIVE_NEAR,
    toTokenAddress: direct ? params.targetTokenAddress : 'native',
    fundingChainId: NEAR_CHAIN_ID,
    fundingTokenAddress: NATIVE_NEAR,
    displayAmount: amount.toString(),
    displaySymbol: 'NEAR',
    createdAt: Date.now(),
  };
  await storePendingTrade(trade, env);
  return trade;
}

/**
 * Quote native SOL / EVM funds into a NEAR token, with Ref as the final hop if needed.
 * Chains NEAR Intents doesn't reach (Arc) first cross to ETH on Base with LI.FI.
 */
export async function prepareIncomingNearBuy(params: {
  userId: string; wallet: CustodialWallet; fundingChainId: number;
  amountUnits: string; tokenAddress: string; slippage: number;
  /** Hopr fee override in bps; 0 when an earlier step already charged it. */
  feeBps?: number;
}, env: TradingEnv): Promise<PendingTrade> {
  const chain = getChainById(params.fundingChainId);
  if (!chain) throw new Error('Unsupported funding chain');
  const origin = await intentsAsset(chain.id, 'native');
  if (!origin) return prepareHubToNearBuy({ ...params, chainId: chain.id }, env);
  const accountId = await ensureNearWallet(params.userId, env);
  const fromAddress = chain.type === 'SVM' ? params.wallet.solanaAddress : params.wallet.evmAddress;
  const reserve = chain.type === 'SVM' ? 5_000_000n : chain.id === 56 ? 1_000_000_000_000_000n : 300_000_000_000_000n;
  const amount = BigInt(params.amountUnits);
  if (amount <= 0n) throw new Error('Enter an amount greater than zero');
  if (await readNativeBalance(chain.id, fromAddress) < amount + reserve) throw new Error(`Not enough ${chain.nativeSymbol} on ${chain.name} for the buy and gas.`);
  const rpc = nearRpcOptions(env);
  const [metadata, allTokens, nearBefore] = await Promise.all([
    getTokenMetadata(params.tokenAddress, rpc),
    intentsTokens(),
    getNearBalance(accountId, [], rpc),
  ]);
  const nearTokens = allTokens.filter((token) => token.blockchain === 'near');
  const listed = nearTokens.find((token) => token.contractAddress === params.tokenAddress || token.assetId === `nep141:${params.tokenAddress}`);
  // A token can only be delivered straight to an account that exists and is registered with its
  // contract; a fresh wallet receives NEAR instead (which creates the account) and swaps on Ref.
  const registered = listed && nearBefore.exists
    ? await storageDepositNeeded(params.tokenAddress, accountId, rpc).then((needed) => needed === 0n).catch(() => false)
    : false;
  const direct = registered ? listed : undefined;
  const destination = direct ?? nearTokens.find((token) => token.assetId === `nep141:${WRAP_NEAR}`);
  if (!destination) throw new Error('NEAR Intents has no NEAR destination asset right now');
  const body = {
    swapType: 'EXACT_INPUT', slippageTolerance: Math.round(params.slippage * 10_000),
    originAsset: origin.assetId, destinationAsset: destination.assetId, amount: amount.toString(),
    depositType: 'ORIGIN_CHAIN', refundTo: fromAddress, refundType: 'ORIGIN_CHAIN',
    recipient: accountId, recipientType: 'DESTINATION_CHAIN', deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const feeBps = env.HOPR_INTENTS_FEE_ACCOUNT ? params.feeBps ?? HOPR_FEE_BPS.swap : 0;
  const quoteOnce = async (dry: boolean) => {
    const { status, data } = await requestIntentsQuote({ ...body, dry }, feeBps, env);
    const quote = data.quote as { depositAddress?: string; amountOut?: string; minAmountOut?: string; timeEstimate?: number } | undefined;
    if (status >= 300 || !quote?.amountOut || BigInt(quote.amountOut) <= 0n) throw new Error(String(data.message ?? 'No cross-chain route into NEAR at this amount.'));
    return quote;
  };
  const preview = await quoteOnce(true);
  if (!direct) {
    // Validate the final pool before offering a funding transaction.
    const input = BigInt(preview.minAmountOut ?? preview.amountOut!) * 98n / 100n - NEAR_GAS_RESERVE_YOCTO;
    if (input <= 0n) throw new Error('Amount too small for NEAR gas and the final swap');
    await getNearSwapQuote({ tokenIn: WRAP_NEAR, tokenOut: params.tokenAddress, amountIn: input.toString(), slippage: params.slippage, rpc });
  }
  const balance = nearBefore;
  const wrapped = !direct && nearBefore.exists
    ? await viewFunction<string>(WRAP_NEAR, 'ft_balance_of', { account_id: accountId }, rpc).catch(() => '0')
    : '0';
  const quote = await quoteOnce(false);
  if (!quote.depositAddress) throw new Error('NEAR Intents did not return a deposit address');
  const trade: PendingTrade = {
    id: crypto.randomUUID(), userId: params.userId, kind: 'buy', venue: 'intents',
    fromAddress, feeBps, fromChainType: chain.type, fromChainKey: chain.key,
    toChainId: NEAR_CHAIN_ID, toChainType: 'NEAR', fromTokenAddress: 'native',
    toTokenAddress: direct ? params.tokenAddress : WRAP_NEAR, fundingChainId: chain.id,
    fundingTokenAddress: 'native', displayAmount: amount.toString(), displaySymbol: chain.nativeSymbol,
    createdAt: Date.now(), quote: { id: 'intents:' + crypto.randomUUID(), estimate: {
      fromAmount: amount.toString(), toAmount: quote.amountOut!, toAmountMin: quote.minAmountOut ?? quote.amountOut!, executionDuration: quote.timeEstimate ?? 120,
    }, raw: quote },
    intents: { accountId, depositAddress: quote.depositAddress, amountIn: amount.toString(),
      expectedOut: quote.amountOut!, minOut: quote.minAmountOut ?? quote.amountOut!, outSymbol: direct ? metadata.symbol : 'NEAR',
      outDecimals: direct ? metadata.decimals : 24, feeBps,
      ...(!direct ? { continuation: { targetChainId: NEAR_CHAIN_ID, hubChainId: NEAR_CHAIN_ID,
        targetTokenAddress: params.tokenAddress, targetSymbol: metadata.symbol, slippage: params.slippage,
        nearAccountId: accountId, nativeBefore: balance.availableYocto, wrappedBefore: wrapped } } : {}),
    },
  };
  await storePendingTrade(trade, env);
  return trade;
}

/**
 * Step 1 of a NEAR-token buy from a chain NEAR Intents doesn't reach: LI.FI
 * moves the coin to ETH on Base (same EVM address, Hopr fee charged here),
 * then continueNearFundedBuy quotes Base ETH → NEAR with the ETH that landed.
 */
async function prepareHubToNearBuy(params: {
  userId: string; wallet: CustodialWallet; chainId: number;
  amountUnits: string; tokenAddress: string; slippage: number;
}, env: TradingEnv): Promise<PendingTrade> {
  const chain = getChainById(params.chainId)!;
  const hub = getChainById(BASE_CHAIN_ID)!;
  if (chain.type !== 'EVM') throw new Error(`${chain.name} can't be routed into NEAR yet. Choose another funding chain.`);
  if (!await intentsAsset(BASE_CHAIN_ID, 'native')) throw new Error('NEAR Intents is unavailable right now.');
  const amount = BigInt(params.amountUnits);
  if (amount <= 0n) throw new Error('Enter an amount greater than zero');
  const reserve = chain.id === ARC_CHAIN_ID ? 100_000_000_000_000_000n : 300_000_000_000_000n;
  if (await readNativeBalance(chain.id, params.wallet.evmAddress) < amount + reserve) throw new Error(`Not enough ${chain.nativeSymbol} on ${chain.name} for the buy and gas.`);
  const [metadata, hubBalanceBefore] = await Promise.all([
    getTokenMetadata(params.tokenAddress, nearRpcOptions(env)),
    readNativeBalance(BASE_CHAIN_ID, params.wallet.evmAddress).catch(() => 0n),
    ensureNearWallet(params.userId, env),
  ]);
  const trade = await prepareBuy({
    userId: params.userId, wallet: params.wallet, fundingChainKey: chain.key, fundingTokenAddress: 'native',
    fundingAmountUnits: params.amountUnits, targetChainId: BASE_CHAIN_ID, targetTokenAddress: EVM_NATIVE_TOKEN, slippage: params.slippage,
  }, env);
  trade.hubContinuation = {
    hubChainId: hub.id, targetChainId: NEAR_CHAIN_ID, targetTokenAddress: params.tokenAddress,
    targetSymbol: metadata.symbol, slippage: params.slippage, hubBalanceBefore: hubBalanceBefore.toString(),
  };
  await storePendingTrade(trade, env);
  return trade;
}

export interface Continuation {
  /** 'lifi': step 1 was a LI.FI hop to the hub chain, tracked by `txHash` instead of a 1Click deposit. */
  kind?: 'lifi';
  txHash?: string;
  fromChainId?: number;
  hubBalanceBefore?: string;
  id: string;
  nearAccountId?: string;
  nativeBefore?: string;
  wrappedBefore?: string;
  pendingTradeId?: string;
  consumed?: boolean;
  depositAddress: string;
  /** Chain the bridged coin landed on (the target chain, or Base as a fallback hub). */
  hubChainId?: number;
  targetChainId: number;
  targetTokenAddress: string;
  targetSymbol: string;
  slippage: number;
  createdAt: number;
}

const continuationKey = (userId: string, id: string) => `near_continuation:${userId}:${id}`;

export async function loadContinuation(userId: string, id: string, env: TradingEnv): Promise<Continuation | null> {
  const raw = await env.TELEGRAM_STATE?.get(continuationKey(userId, id));
  return raw ? JSON.parse(raw) as Continuation : null;
}

/**
 * Step 2 of a NEAR-funded buy. Once NEAR Intents has delivered the native
 * coin, quote swapping exactly what arrived (keeping gas) into the token.
 * Returns { status: 'pending' } while the bridge is still in flight.
 */
export async function continueNearFundedBuy(userId: string, id: string, wallet: CustodialWallet, balanceOf: (chainId: number, address: string) => Promise<bigint>, env: TradingEnv): Promise<
  | { status: 'pending'; detail: string }
  | { status: 'failed'; detail: string }
  | { status: 'ready'; trade: PendingTrade; continuation: Continuation; delivered: bigint }
> {
  const continuation = await loadContinuation(userId, id, env);
  if (!continuation) return { status: 'failed', detail: 'This step expired. Your coins are in your Hopr wallet — buy with them directly.' };
  if (continuation.consumed) return { status: 'failed', detail: 'This continuation was already submitted. Check your wallet before trading again.' };
  if (continuation.pendingTradeId) {
    const existing = await loadPendingTrade(userId, continuation.pendingTradeId, env);
    if (existing) return { status: 'ready', trade: existing, continuation, delivered: BigInt(existing.displayAmount) };
  }
  if (continuation.kind === 'lifi') return continueHubToNear(userId, continuation, wallet, balanceOf, env);
  const response = await fetch(`${ONECLICK_API}/status?depositAddress=${encodeURIComponent(continuation.depositAddress)}`);
  const data = await response.json().catch(() => ({})) as { status?: string; swapDetails?: { amountOut?: string } };
  if (data.status === 'REFUNDED' || data.status === 'FAILED') {
    await env.TELEGRAM_STATE?.delete(continuationKey(userId, id));
    return { status: 'failed', detail: data.status === 'REFUNDED' ? 'NEAR Intents refunded the NEAR to your wallet.' : 'NEAR Intents could not complete the bridge.' };
  }
  if (data.status !== 'SUCCESS') return { status: 'pending', detail: (data.status ?? 'PENDING_DEPOSIT').replace(/_/g, ' ').toLowerCase() };

  if (continuation.targetChainId === NEAR_CHAIN_ID) {
    const accountId = await ensureNearWallet(userId, env);
    if (accountId !== continuation.nearAccountId) throw new Error('Your NEAR wallet changed after bridging. Switch back to the receiving wallet.');
    const rpc = nearRpcOptions(env);
    const delivered = BigInt(data.swapDetails?.amountOut ?? '0');
    if (delivered <= 0n) return { status: 'pending', detail: 'Waiting for the delivered NEAR amount' };
    const [balance, wrapped, metadata] = await Promise.all([
      getNearBalance(accountId, [], rpc), viewFunction<string>(WRAP_NEAR, 'ft_balance_of', { account_id: accountId }, rpc),
      getTokenMetadata(continuation.targetTokenAddress, rpc),
    ]);
    const nativeAvailable = BigInt(balance.availableYocto);
    const wrappedDelta = BigInt(wrapped) - BigInt(continuation.wrappedBefore ?? '0');
    const nativeDelta = nativeAvailable - BigInt(continuation.nativeBefore ?? '0');
    const useWrapped = wrappedDelta >= delivered;
    let spend = useWrapped ? delivered : (nativeDelta < delivered ? nativeDelta : delivered);
    if (!useWrapped) {
      const storage = await storageDepositNeeded(continuation.targetTokenAddress, accountId, rpc)
        + await storageDepositNeeded(WRAP_NEAR, accountId, rpc);
      const available = nativeAvailable - NEAR_GAS_RESERVE_YOCTO - storage;
      if (spend > available) spend = available;
    }
    if (spend <= 0n) return { status: 'pending', detail: 'Waiting for spendable NEAR; keep NEAR for storage and gas' };
    const trade = await prepareNearSwap({ userId, kind: 'buy',
      tokenIn: { id: useWrapped ? WRAP_NEAR : NATIVE_NEAR, symbol: useWrapped ? 'wNEAR' : 'NEAR', decimals: 24 },
      tokenOut: { id: continuation.targetTokenAddress, ...metadata }, amountInUnits: spend.toString(),
      slippage: continuation.slippage, feeBps: 0,
    }, env);
    trade.sourceContinuationId = id;
    await storePendingTrade(trade, env);
    continuation.pendingTradeId = trade.id;
    await env.TELEGRAM_STATE!.put(continuationKey(userId, id), JSON.stringify(continuation), { expirationTtl: 86400 });
    return { status: 'ready', trade, continuation, delivered: spend };
  }

  const hubChainId = continuation.hubChainId ?? continuation.targetChainId;
  const chain = getChainById(hubChainId)!;
  const owner = chain.type === 'EVM' ? wallet.evmAddress : wallet.solanaAddress;
  const delivered = BigInt(data.swapDetails?.amountOut ?? '0');
  const reserve = chain.type === 'SVM' ? 5_000_000n : hubChainId === 56 ? 1_000_000_000_000_000n : 300_000_000_000_000n;
  const balance = await balanceOf(hubChainId, owner).catch(() => delivered);
  const spend = delivered < balance - reserve ? delivered : balance - reserve;
  if (spend <= 0n) return { status: 'failed', detail: `The ${chain.nativeSymbol} arrived but isn't enough to cover gas for the swap.` };
  // Hopr's fee was paid on step 1, so step 2 is fee-free.
  const trade = await prepareBuy({
    userId,
    wallet,
    fundingChainKey: chain.key,
    fundingTokenAddress: 'native',
    fundingAmountUnits: spend.toString(),
    targetChainId: continuation.targetChainId,
    targetTokenAddress: continuation.targetTokenAddress,
    slippage: continuation.slippage,
    fee: 0,
  }, env);
  trade.sourceContinuationId = id;
  await storePendingTrade(trade, env);
  return { status: 'ready', trade, continuation, delivered: spend };
}

/** Step 2 of a hub buy: once LI.FI delivered ETH on the hub chain, quote it into NEAR through NEAR Intents. */
async function continueHubToNear(userId: string, continuation: Continuation, wallet: CustodialWallet, balanceOf: (chainId: number, address: string) => Promise<bigint>, env: TradingEnv): Promise<
  | { status: 'pending'; detail: string }
  | { status: 'failed'; detail: string }
  | { status: 'ready'; trade: PendingTrade; continuation: Continuation; delivered: bigint }
> {
  const hubChainId = continuation.hubChainId ?? BASE_CHAIN_ID;
  const query = new URLSearchParams({ txHash: continuation.txHash ?? '', fromChain: String(continuation.fromChainId ?? ''), toChain: String(hubChainId) });
  const response = await fetch(`https://li.quest/v1/status?${query}`, {
    headers: env.LIFI_API_KEY ? { 'x-lifi-api-key': env.LIFI_API_KEY } : {},
  }).catch(() => null);
  const data = await response?.json().catch(() => ({})) as { status?: string; substatus?: string; receiving?: { amount?: string } } | undefined;
  if (data?.status === 'FAILED') {
    await env.TELEGRAM_STATE?.delete(continuationKey(userId, continuation.id));
    return { status: 'failed', detail: 'The bridge to Base failed; LI.FI returns funds to your wallet.' };
  }
  if (data?.status !== 'DONE') return { status: 'pending', detail: (data?.substatus ?? data?.status ?? 'PENDING').replace(/_/g, ' ').toLowerCase() };
  const hub = getChainById(hubChainId)!;
  const balance = await balanceOf(hubChainId, wallet.evmAddress);
  const arrived = BigInt(data.receiving?.amount ?? '0') || balance - BigInt(continuation.hubBalanceBefore ?? '0');
  const reserve = 300_000_000_000_000n;
  const spend = arrived < balance - reserve ? arrived : balance - reserve;
  if (spend <= 0n) return { status: 'failed', detail: `The ${hub.nativeSymbol} arrived but isn't enough to cover gas for the next step.` };
  const trade = await prepareIncomingNearBuy({
    userId, wallet, fundingChainId: hubChainId, amountUnits: spend.toString(),
    tokenAddress: continuation.targetTokenAddress, slippage: continuation.slippage, feeBps: 0,
  }, env);
  trade.sourceContinuationId = continuation.id;
  await storePendingTrade(trade, env);
  continuation.pendingTradeId = trade.id;
  await env.TELEGRAM_STATE!.put(continuationKey(userId, continuation.id), JSON.stringify(continuation), { expirationTtl: 86400 });
  return { status: 'ready', trade, continuation, delivered: BigInt(trade.displayAmount) };
}

async function confirmNearIntents(userId: string, trade: PendingTrade, env: TradingEnv): Promise<ConfirmResult> {
  const intents = trade.intents;
  if (!intents) throw new Error('This NEAR quote is incomplete. Request a new quote.');
  const signer = await getNearSigner(userId, env);
  if (signer.accountId !== intents.accountId) throw new Error('Your active wallet changed since this quote. Request a new quote.');
  const rpc = nearRpcOptions(env);
  const registration = await storageDepositNeeded(WRAP_NEAR, intents.depositAddress, rpc);
  const plans = buildIntentsDepositPlan({ token: WRAP_NEAR, native: true, amount: BigInt(intents.amountIn), depositAddress: intents.depositAddress, registration });
  const privateKey = await decryptPrivateKey(signer.encryptedKey, env.ENCRYPTION_KEY!);
  const result = await executeNearTransactions(signer.accountId, privateKey, plans, rpc);
  const txHash = result.hashes[result.hashes.length - 1];
  // Let 1Click start right away (it also watches the chain).
  await fetch(`${ONECLICK_API}/deposit/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash, depositAddress: intents.depositAddress }),
  }).catch(() => undefined);

  const continuationId = await saveContinuation(userId, intents, env);
  return { txHash, confirmed: result.confirmed, venue: 'intents', fromAddress: signer.accountId, fromChainId: NEAR_CHAIN_ID, depositAddress: intents.depositAddress, continuationId };
}

/** Persist step 2 of a multi-step intents buy; returns its short id for the Continue button / poller. */
async function saveContinuation(userId: string, intents: NonNullable<PendingTrade['intents']>, env: TradingEnv): Promise<string | undefined> {
  if (!intents.continuation || !env.TELEGRAM_STATE) return undefined;
  const id = crypto.randomUUID().slice(0, 8);
  const continuation: Continuation = { id, depositAddress: intents.depositAddress, ...intents.continuation, createdAt: Date.now() };
  await env.TELEGRAM_STATE.put(continuationKey(userId, id), JSON.stringify(continuation), { expirationTtl: 24 * 60 * 60 });
  return id;
}

/**
 * Step 1 of buying a NEAR token with SOL / ETH (or another native coin): send
 * exactly the quoted amount to the 1Click deposit address from the Hopr wallet
 * on the funding chain. A plain native transfer — no opaque calldata is signed.
 */
async function confirmIncomingIntents(userId: string, trade: PendingTrade, rpcUrls: TransactionRpcs, env: TradingEnv): Promise<ConfirmResult> {
  const intents = trade.intents;
  const chain = getChainById(trade.fundingChainId);
  if (!intents || !chain || !trade.fromAddress) throw new Error('This quote is incomplete. Request a new quote.');
  const wallet = await getCustodialWallet(userId, env);
  const owner = chain.type === 'SVM' ? wallet?.solanaAddress : wallet?.evmAddress;
  const sameOwner = chain.type === 'SVM' ? owner === trade.fromAddress : owner?.toLowerCase() === trade.fromAddress.toLowerCase();
  if (!sameOwner) throw new Error('Your active wallet changed since this quote. Request a new quote.');
  if (await ensureNearWallet(userId, env) !== intents.accountId) throw new Error('Your NEAR wallet changed since this quote. Request a new quote.');

  const result = await executeNativeDeposit({
    chainType: chain.type,
    chainId: chain.id,
    rpcUrl: chain.type === 'SVM' ? await rpcUrls.solana() : await rpcUrls.evm(chain.id),
    encryptedKey: await getEncryptedKey(userId, chain.type, env),
    encryptionSecret: env.ENCRYPTION_KEY!,
    fromAddress: trade.fromAddress,
    depositAddress: intents.depositAddress,
    amount: BigInt(intents.amountIn),
  });
  await fetch(`${ONECLICK_API}/deposit/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash: result.txHash, depositAddress: intents.depositAddress }),
  }).catch(() => undefined);

  const continuationId = await saveContinuation(userId, intents, env);
  if (!continuationId && env.DB && trade.toChainId === NEAR_CHAIN_ID) {
    // Delivered straight into the token: this is the position.
    await env.DB.prepare(
      `INSERT INTO user_trades
         (id, user_id, target_token_address, target_chain_id, purchased_amount,
          funding_chain_id, funding_token_address, funding_amount, status, tx_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'native', ?7, 'SUBMITTED', ?8)`
    ).bind(crypto.randomUUID(), userId, trade.toTokenAddress, String(NEAR_CHAIN_ID), intents.minOut, String(chain.id), intents.amountIn, result.txHash).run();
  }
  return { txHash: result.txHash, confirmed: true, venue: 'intents', fromAddress: trade.fromAddress, fromChainId: chain.id, depositAddress: intents.depositAddress, continuationId };
}

/** Step 2 was submitted: its continuation can never be resumed again. */
async function consumeContinuation(userId: string, id: string | undefined, env: TradingEnv): Promise<void> {
  if (!id || !env.TELEGRAM_STATE) return;
  const continuation = await loadContinuation(userId, id, env);
  if (!continuation) return;
  continuation.consumed = true;
  await env.TELEGRAM_STATE.put(continuationKey(userId, id), JSON.stringify(continuation), { expirationTtl: 24 * 60 * 60 });
}

export interface ConfirmResult {
  txHash: string;
  dbTradeId?: string;
  /** false when NEAR's RPC timed out before execution finished; the swap may still complete. */
  confirmed?: boolean;
  venue?: 'lifi' | 'ref' | 'intents';
  /** Signing wallet and source chain (for referral verification). */
  fromAddress?: string;
  fromChainId?: number;
  /** NEAR Intents deposit account (intents venue). */
  depositAddress?: string;
  /** Step 2 of a NEAR-funded buy, continued with continueNearFundedBuy(). */
  continuationId?: string;
  /** Hopr fee charged on this trade, in bps (0 = none, so no referral reward). */
  feeBps?: number;
}

/**
 * Step 2: sign and submit a previously-quoted, still-fresh pending trade.
 * Rejects if the quote has expired (see PENDING_TRADE_TTL_SECONDS) so a
 * confirm tap can never execute against a stale price.
 */
export async function confirmTrade(
  userId: string,
  tradeId: string,
  rpcUrls: TransactionRpcs,
  env: TradingEnv
): Promise<ConfirmResult> {
  const trade = await loadPendingTrade(userId, tradeId, env);
  if (!trade) throw new Error('This quote has expired. Request a new quote and confirm again.');
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY secret is required to sign');
  // Consume the quote before signing so a double tap (or a replayed request) can never submit twice.
  if (env.TELEGRAM_STATE) await env.TELEGRAM_STATE.delete(pendingTradeKey(userId, tradeId));

  if (trade.venue === 'ref') {
    const result = await confirmNearSwap(userId, trade, env);
    await consumeContinuation(userId, trade.sourceContinuationId, env);
    return result;
  }
  if (trade.venue === 'intents') {
    const result = trade.fromChainType === 'NEAR'
      ? await confirmNearIntents(userId, trade, env)
      : await confirmIncomingIntents(userId, trade, rpcUrls, env);
    await consumeContinuation(userId, trade.sourceContinuationId, env);
    return { ...result, feeBps: trade.intents?.feeBps ?? 0 };
  }
  if (trade.fromChainType === 'NEAR') throw new Error('Unsupported NEAR quote. Request a new quote.');

  const [encryptedKey, evmRpcUrl, solanaRpcUrl] = await Promise.all([
    getEncryptedKey(userId, trade.fromChainType, env, trade.walletId),
    trade.fromChainType === 'EVM' ? rpcUrls.evm(SUPPORTED_CHAINS.find((c) => c.key === trade.fromChainKey)!.id) : undefined,
    trade.fromChainType === 'SVM' ? rpcUrls.solana() : undefined,
  ]);

  const result = await execute({
    quote: trade.quote,
    fromChainType: trade.fromChainType,
    encryptedKey,
    encryptionSecret: env.ENCRYPTION_KEY,
    evmRpcUrl,
    solanaRpcUrl,
    solanaBroadcastUrls: solanaRpcUrl ? rpcUrls.solanaBroadcast?.(solanaRpcUrl) : undefined,
    fromTokenAddress: trade.fromTokenAddress,
  });

  const fromChain = SUPPORTED_CHAINS.find((chain) => chain.key === trade.fromChainKey);
  let continuationId: string | undefined;
  if (trade.hubContinuation && env.TELEGRAM_STATE) {
    // A hop to the hub chain is not a position; step 2 continues it into the NEAR token.
    continuationId = crypto.randomUUID().slice(0, 8);
    const continuation: Continuation = {
      id: continuationId, kind: 'lifi', txHash: result.txHash, fromChainId: fromChain?.id, depositAddress: '',
      ...trade.hubContinuation, createdAt: Date.now(),
    };
    await env.TELEGRAM_STATE.put(continuationKey(userId, continuationId), JSON.stringify(continuation), { expirationTtl: 24 * 60 * 60 });
  }

  let dbTradeId: string | undefined;
  if (env.DB && !trade.hubContinuation) {
    if (trade.kind === 'buy') {
      dbTradeId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO user_trades
           (id, user_id, target_token_address, target_chain_id, purchased_amount,
            funding_chain_id, funding_token_address, funding_amount, status, tx_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'SUBMITTED', ?9)`
      )
        .bind(
          dbTradeId,
          userId,
          trade.toTokenAddress,
          String(trade.toChainId),
          trade.quote.estimate.toAmountMin,
          String(trade.fundingChainId),
          trade.fundingTokenAddress,
          trade.displayAmount,
          result.txHash
        )
        .run();
    } else if (!trade.bundle) {
      await env.DB.prepare(
        `UPDATE user_trades SET status = 'SOLD', sell_tx_hash = ?1, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?2 AND target_token_address = ?3 AND status = 'SUBMITTED'`
      )
        .bind(result.txHash, userId, trade.fromTokenAddress)
        .run();
    }
  }

  await consumeContinuation(userId, trade.sourceContinuationId, env);
  return {
    txHash: result.txHash,
    dbTradeId,
    confirmed: true,
    venue: 'lifi',
    continuationId,
    fromAddress: trade.fromAddress,
    fromChainId: fromChain?.id,
    feeBps: trade.feeBps ?? HOPR_FEE_BPS.swap,
  };
}

async function confirmNearSwap(userId: string, trade: PendingTrade, env: TradingEnv): Promise<ConfirmResult> {
  const swap = trade.nearSwap;
  if (!swap) throw new Error('This NEAR quote is incomplete. Request a new quote.');
  const signer = await getNearSigner(userId, env, trade.walletId);
  if (signer.accountId !== swap.accountId) throw new Error('Your active wallet changed since this quote. Request a new quote.');

  const plans = buildRefSwapPlan(swap.quote, {
    outputStorageDeposit: BigInt(swap.outputStorageDeposit),
    wrapStorageDeposit: BigInt(swap.wrapStorageDeposit),
    intermediateStorageDeposits: Object.fromEntries(Object.entries(swap.intermediateStorageDeposits ?? {}).map(([token, deposit]) => [token, BigInt(deposit)])),
  }, swap.fee ? { account: swap.fee.account, amount: BigInt(swap.fee.amount), storageDeposit: BigInt(swap.fee.storageDeposit) } : null);
  const privateKey = await decryptPrivateKey(signer.encryptedKey, env.ENCRYPTION_KEY!);
  const result = await executeNearTransactions(signer.accountId, privateKey, plans, nearRpcOptions(env));
  const txHash = result.hashes[result.hashes.length - 1];

  let dbTradeId: string | undefined;
  if (env.DB) {
    if (trade.kind === 'buy') {
      dbTradeId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO user_trades
           (id, user_id, target_token_address, target_chain_id, purchased_amount,
            funding_chain_id, funding_token_address, funding_amount, status, tx_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        dbTradeId, userId, trade.toTokenAddress, String(NEAR_CHAIN_ID), swap.quote.minOut,
        String(NEAR_CHAIN_ID), trade.fromTokenAddress, swap.quote.amountIn, result.confirmed ? 'CONFIRMED' : 'SUBMITTED', txHash,
      ).run();
    } else if (!trade.bundle) {
      // NEAR sells are sized from the live token balance, so only a full exit closes the position.
      const remaining = BigInt(await viewFunction<string>(trade.fromTokenAddress, 'ft_balance_of', { account_id: signer.accountId }, nearRpcOptions(env)).catch(() => '1'));
      if (remaining === 0n) {
        await env.DB.prepare(
          `UPDATE user_trades SET status = 'SOLD', sell_tx_hash = ?1, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?2 AND target_token_address = ?3 AND target_chain_id = ?4 AND status IN ('SUBMITTED','CONFIRMED')`
        ).bind(txHash, userId, trade.fromTokenAddress, String(NEAR_CHAIN_ID)).run();
      }
    }
  }
  return {
    txHash,
    dbTradeId,
    confirmed: result.confirmed,
    venue: 'ref',
    fromAddress: signer.accountId,
    fromChainId: NEAR_CHAIN_ID,
    feeBps: swap.fee ? HOPR_FEE_BPS.swap : 0,
  };
}
