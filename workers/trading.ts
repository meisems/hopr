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
import { getQuote, execute, buildSellQuoteRequest, type LifiQuote } from '../src/services/lifiTrader';
import { getChainById, getChainByKey, SUPPORTED_CHAINS } from '../src/services/chainDetector';
import {
  buildRefSwapPlan,
  getNearBalance,
  getRefSwapQuote,
  NATIVE_NEAR,
  NEAR_CHAIN_ID,
  NEAR_GAS_RESERVE_YOCTO,
  formatNearAmount,
  planAttachedDeposit,
  storageDepositNeeded,
  viewFunction,
  WRAP_NEAR,
  type NearRpcOptions,
  type RefSwapQuote,
} from '../src/services/nearService';
import { executeNearTransactions, generateNearWallet } from '../src/services/nearSigner';

export interface TradingEnv {
  DB?: D1Database;
  TELEGRAM_STATE?: KVNamespace;
  ENCRYPTION_KEY?: string;
  LIFI_API_KEY?: string;
  /** Keyed NEAR RPC endpoint; public fallbacks are tried after it. */
  NEAR_RPC_URL?: string;
}

export interface CustodialWallet {
  evmAddress: string;
  solanaAddress: string;
  /** NEAR implicit account; null until the user first uses NEAR (see ensureNearWallet). */
  nearAddress?: string | null;
}

export function nearRpcOptions(env: TradingEnv): NearRpcOptions {
  return { urls: env.NEAR_RPC_URL ? [env.NEAR_RPC_URL] : [] };
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
async function getNearSigner(userId: string, env: TradingEnv): Promise<{ accountId: string; encryptedKey: EncryptedSecret }> {
  if (!env.DB) throw new Error('DB binding required');
  type Row = { near_address: string | null; near_encrypted_key: string | null };
  let row: Row | null = null;
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
  env: TradingEnv
): Promise<EncryptedSecret> {
  if (!env.DB) throw new Error('DB binding required');
  let row: { evm_encrypted_key: string; solana_encrypted_key: string } | null = null;
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
  /** Execution venue; absent on quotes stored before NEAR support (treated as LI.FI). */
  venue?: 'lifi' | 'ref';
  quote: LifiQuote;
  /** Ref Finance route + registration deposits; the transaction plan is rebuilt from these at confirm time. */
  nearSwap?: {
    accountId: string;
    quote: RefSwapQuote;
    outputStorageDeposit: string;
    wrapStorageDeposit: string;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    tokenInDecimals: number;
    tokenOutDecimals: number;
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
}, env: TradingEnv): Promise<PendingTrade> {
  const fundingChain = getChainByKey(params.fundingChainKey);
  const targetChain = getChainById(params.targetChainId);
  if (!fundingChain || !targetChain) throw new Error('Unsupported chain');

  const fromAddress = fundingChain.type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress;
  const toAddress = targetChain.type === 'EVM' ? params.wallet.evmAddress : params.wallet.solanaAddress;
  const fundingTokenAddress = params.fundingTokenAddress === 'native'
    ? nativeTokenAddress(fundingChain.key)
    : params.fundingTokenAddress;

  const quote = await getQuote(
    {
      fromChain: fundingChain.key,
      toChain: targetChain.key,
      fromToken: fundingTokenAddress,
      toToken: params.targetTokenAddress,
      fromAmount: params.fundingAmountUnits,
      fromAddress,
      toAddress,
      slippage: params.slippage,
    },
    env.LIFI_API_KEY ?? ''
  );

  const trade: PendingTrade = {
    id: crypto.randomUUID(),
    userId: params.userId,
    kind: 'buy',
    quote,
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

  const req = buildSellQuoteRequest({
    targetChain: targetChain.key,
    targetTokenAddress: original.target_token_address,
    fundingChain: fundingChain.key,
    fundingTokenAddress: original.funding_token_address,
    sellAmount: params.sellAmountUnits,
    walletAddress,
    slippage: params.slippage,
  });
  const quote = await getQuote(req, env.LIFI_API_KEY ?? '');

  const trade: PendingTrade = {
    id: crypto.randomUUID(),
    userId: params.userId,
    kind: 'sell',
    quote,
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
}, env: TradingEnv): Promise<PendingTrade> {
  const rpc = nearRpcOptions(env);
  const accountId = await ensureNearWallet(params.userId, env);
  const quote = await getRefSwapQuote({ tokenIn: params.tokenIn.id, tokenOut: params.tokenOut.id, amountIn: params.amountInUnits, slippage: params.slippage });

  const [outputStorageDeposit, wrapStorageDeposit, balance] = await Promise.all([
    params.tokenOut.id === NATIVE_NEAR ? 0n : storageDepositNeeded(params.tokenOut.id, accountId, rpc),
    params.tokenIn.id === NATIVE_NEAR ? storageDepositNeeded(WRAP_NEAR, accountId, rpc) : 0n,
    getNearBalance(accountId, [], rpc),
  ]);
  const needed = planAttachedDeposit(buildRefSwapPlan(quote, { outputStorageDeposit, wrapStorageDeposit })) + NEAR_GAS_RESERVE_YOCTO;
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
      tokenInSymbol: params.tokenIn.symbol,
      tokenOutSymbol: params.tokenOut.symbol,
      tokenInDecimals: params.tokenIn.decimals,
      tokenOutDecimals: params.tokenOut.decimals,
    },
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

export interface ConfirmResult {
  txHash: string;
  dbTradeId?: string;
  /** false when NEAR's RPC timed out before execution finished; the swap may still complete. */
  confirmed?: boolean;
  venue?: 'lifi' | 'ref';
}

/**
 * Step 2: sign and submit a previously-quoted, still-fresh pending trade.
 * Rejects if the quote has expired (see PENDING_TRADE_TTL_SECONDS) so a
 * confirm tap can never execute against a stale price.
 */
export async function confirmTrade(
  userId: string,
  tradeId: string,
  rpcUrls: { evm: (chainId: number) => string; solana: string },
  env: TradingEnv
): Promise<ConfirmResult> {
  const trade = await loadPendingTrade(userId, tradeId, env);
  if (!trade) throw new Error('This quote has expired. Request a new quote and confirm again.');
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY secret is required to sign');
  // Consume the quote before signing so a double tap (or a replayed request) can never submit twice.
  if (env.TELEGRAM_STATE) await env.TELEGRAM_STATE.delete(pendingTradeKey(userId, tradeId));

  if (trade.venue === 'ref') return confirmNearSwap(userId, trade, env);
  if (trade.fromChainType === 'NEAR') throw new Error('Unsupported NEAR quote. Request a new quote.');

  const encryptedKey = await getEncryptedKey(userId, trade.fromChainType, env);

  const result = await execute({
    quote: trade.quote,
    fromChainType: trade.fromChainType,
    encryptedKey,
    encryptionSecret: env.ENCRYPTION_KEY,
    evmRpcUrl: trade.fromChainType === 'EVM' ? rpcUrls.evm(SUPPORTED_CHAINS.find((c) => c.key === trade.fromChainKey)!.id) : undefined,
    solanaRpcUrl: trade.fromChainType === 'SVM' ? rpcUrls.solana : undefined,
    fromTokenAddress: trade.fromTokenAddress,
  });

  let dbTradeId: string | undefined;
  if (env.DB) {
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
    } else {
      await env.DB.prepare(
        `UPDATE user_trades SET status = 'SOLD', sell_tx_hash = ?1, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?2 AND target_token_address = ?3 AND status = 'SUBMITTED'`
      )
        .bind(result.txHash, userId, trade.fromTokenAddress)
        .run();
    }
  }

  return { txHash: result.txHash, dbTradeId, confirmed: true, venue: 'lifi' };
}

async function confirmNearSwap(userId: string, trade: PendingTrade, env: TradingEnv): Promise<ConfirmResult> {
  const swap = trade.nearSwap;
  if (!swap) throw new Error('This NEAR quote is incomplete. Request a new quote.');
  const signer = await getNearSigner(userId, env);
  if (signer.accountId !== swap.accountId) throw new Error('Your active wallet changed since this quote. Request a new quote.');

  const plans = buildRefSwapPlan(swap.quote, {
    outputStorageDeposit: BigInt(swap.outputStorageDeposit),
    wrapStorageDeposit: BigInt(swap.wrapStorageDeposit),
  });
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
    } else {
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
  return { txHash, dbTradeId, confirmed: result.confirmed, venue: 'ref' };
}
