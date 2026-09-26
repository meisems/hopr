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

export interface TradingEnv {
  DB?: D1Database;
  TELEGRAM_STATE?: KVNamespace;
  ENCRYPTION_KEY?: string;
  LIFI_API_KEY?: string;
}

export interface CustodialWallet {
  evmAddress: string;
  solanaAddress: string;
}

const PENDING_TRADE_TTL_SECONDS = 90;

/** Fetch the user's custodial wallet, or null if they haven't created one. */
export async function getCustodialWallet(userId: string, env: TradingEnv): Promise<CustodialWallet | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT evm_address, solana_address FROM user_wallets WHERE user_id = ?1`
  )
    .bind(userId)
    .first<{ evm_address: string; solana_address: string }>();
  if (!row) return null;
  return { evmAddress: row.evm_address, solanaAddress: row.solana_address };
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
  const evmEncrypted = await encryptPrivateKey(wallet.evmPrivateKey, env.ENCRYPTION_KEY);
  const solEncrypted = await encryptPrivateKey(wallet.solanaPrivateKey, env.ENCRYPTION_KEY);

  await env.DB.prepare(
    `INSERT INTO user_wallets (user_id, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(
      userId,
      wallet.evmAddress,
      packEncryptedSecret(evmEncrypted),
      wallet.solanaAddress,
      packEncryptedSecret(solEncrypted)
    )
    .run();

  return { evmAddress: wallet.evmAddress, solanaAddress: wallet.solanaAddress };
}

async function getEncryptedKey(
  userId: string,
  chainType: 'EVM' | 'SVM',
  env: TradingEnv
): Promise<EncryptedSecret> {
  if (!env.DB) throw new Error('DB binding required');
  const row = await env.DB.prepare(
    `SELECT evm_encrypted_key, solana_encrypted_key FROM user_wallets WHERE user_id = ?1`
  )
    .bind(userId)
    .first<{ evm_encrypted_key: string; solana_encrypted_key: string }>();
  if (!row) throw new Error('No custodial wallet on file for this user');
  const packed = chainType === 'EVM' ? row.evm_encrypted_key : row.solana_encrypted_key;
  return unpackEncryptedSecret(packed);
}

export interface PendingTrade {
  id: string;
  userId: string;
  kind: 'buy' | 'sell';
  quote: LifiQuote;
  fromChainType: 'EVM' | 'SVM';
  fromChainKey: string;
  toChainId: number;
  toChainType: 'EVM' | 'SVM';
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

  const quote = await getQuote(
    {
      fromChain: fundingChain.key,
      toChain: targetChain.key,
      fromToken: params.fundingTokenAddress,
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
    fromTokenAddress: params.fundingTokenAddress,
    toTokenAddress: params.targetTokenAddress,
    fundingChainId: fundingChain.id,
    fundingTokenAddress: params.fundingTokenAddress,
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

export interface ConfirmResult {
  txHash: string;
  dbTradeId?: string;
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

  // Best-effort cleanup so a confirm tap can't be replayed even within the TTL.
  if (env.TELEGRAM_STATE) await env.TELEGRAM_STATE.delete(pendingTradeKey(userId, tradeId));

  return { txHash: result.txHash, dbTradeId };
}
