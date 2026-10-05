/**
 * Hopr Cloudflare Worker — the Hopr Telegram trading bot.
 *
 * - POST /telegram/webhook: the bot (all trading, wallets, portfolio, referrals)
 * - POST /api/detect, GET /api/launchpads/pools, GET /api/config: the read-only website
 * - /api/admin/referral-payouts*: operator payout queue
 * - GET /health: liveness plus which RPC / API keys are configured (never their values)
 *
 * Deploy with: npx wrangler deploy
 *
 * CUSTODIAL TRADING: buy/sell now execute for real once a user creates a
 * custodial wallet (see workers/trading.ts). Execution is gated behind an
 * explicit "Confirm" tap on a live quote, not the initial preset tap, so a
 * single accidental button press can never sign a transaction. Both the D1
 * `user_wallets`/`user_trades` tables (migrations/0002_trade_history.sql)
 * and the ENCRYPTION_KEY secret must be configured before this path works;
 * it fails closed (with a clear message) if either is missing.
 */
import {
  getCustodialWallet,
  defaultWalletFor,
  loadWalletRows,
  setDefaultWallet,
  walletAddressOn,
  walletChains,
  walletWithAddress,
  WALLET_CHAINS,
  type CustodialWallet,
  type WalletChain,
  type WalletRow,
  createCustodialWallet,
  ensureNearWallet,
  nearRpcOptions,
  prepareBuy,
  prepareNearSwap,
  prepareSell,
  prepareTokenSell,
  sendNativeMulti,
  confirmTrade,
  continueNearFundedBuy,
  prepareNearIntentsBuy,
  prepareIncomingNearBuy,
  type ConfirmResult,
  type PendingTrade,
} from './trading';
import { detectChain as detectTokenOnChain, getChainById, tokenChartUrl } from '../src/services/chainDetector';
import { feedRefreshMs, LAUNCHPADS, launchpadById, sortPools, type LaunchpadId } from '../src/services/launchpads';
import { getLaunchpadFeed } from './launchpads';
import { savePoolActions, readPoolAction } from './launchpadActions';
import { getNetwork } from '../src/services/chains';
import { tracked, readNativeBalance, nativePricesUsd, type TrackedAmount } from './balances';
import { forgetPortfolio, loadPortfolio, NATIVE, pendingPortfolioLoad, quickNativeBalance, quickTokenBalance, type Portfolio, type TrackedToken } from './portfolio';
import { apiKeyStatus, applyRpcConfig, solanaBroadcastRpcs, transactionRpc, type RpcEnv } from './rpcConfig';
import { chainMarkets } from './portfolio';
import { gasReserve } from './gasReserve';
import { cancelOrder, createOrder, listOrders, ORDER_LABEL, OrderError, runOrderSweep, type LimitOrder, type OrderKind } from './orders';
import {
  fetchEvmTrades, fetchNearTrades, fetchSolanaTrades, latestEvmBlock, MAX_COPY_TRADES_PER_DAY, MAX_TRACKED_PER_USER, MIN_COPY_LIQUIDITY_USD,
  normalizeWalletAddress, runWalletWatch, walletKind, type CopyMode, type TrackedWallet, type WalletTrade,
} from './walletWatch';
import {
  generateDualWallet,
  decryptPrivateKey,
  encryptPrivateKey,
  packEncryptedSecret,
  unpackEncryptedSecret,
  importEvmKey,
  importSolanaKey,
} from '../src/services/walletService';
import {
  bindTelegramReferral,
  claimReferralRewards,
  ensureReferralCode,
  handleReferralRequest,
  recordReferralTrade,
  referralStats,
  REFERRAL_SHARE,
  telegramIdentity,
} from './referrals';
import {
  findNearAccountsForKey,
  formatNearAmount,
  formatUnits,
  HOPR_FEE_BPS,
  HOPR_FEE_PERCENT,
  getNearBalance,
  getTokenMetadata,
  isNearAccountId,
  isValidNearAccountId,
  NATIVE_NEAR,
  NEAR_CHAIN,
  NEAR_CHAIN_ID,
  NEAR_DECIMALS,
  parseUnits,
  resolveNearToken,
  verifyFullAccessKey,
  viewAccount,
  viewFunction,
  type NearBalance,
} from '../src/services/nearService';
import { generateNearWallet, importNearKey, type NearKeyPair } from '../src/services/nearSigner';

export interface Env extends RpcEnv {
  DB?: D1Database;
  CACHE?: KVNamespace;
  ENCRYPTION_KEY?: string;
  LIFI_API_KEY?: string;
  LIFI_INTEGRATOR?: string;
  ENVIRONMENT: string;
  RATE_LIMIT?: KVNamespace; // For rate limiting
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_STATE?: KVNamespace;
  /** Hopr's NEAR account: receives the NEAR Intents app fee and the Ref / Rhea swap fee (0.75%). */
  HOPR_INTENTS_FEE_ACCOUNT?: string;
  /** 1Click API key: default app-fee split is 50/50; public quotes add 25bps. */
  ONECLICK_JWT?: string;
  /** Bot username without @, for invite links (read from getMe when unset). */
  TELEGRAM_BOT_USERNAME?: string;
  /** Bearer token for /api/admin/* (referral payout queue). */
  ADMIN_TOKEN?: string;
  REFERRAL_MIN_PAYOUT_USD?: string;
}

interface TelegramMessage {
  message_id?: number;
  chat?: { id: number; type?: string };
  from?: { first_name?: string; username?: string };
  text?: string;
  reply_to_message?: { text?: string; from?: { is_bot?: boolean } };
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

type TelegramButton = { text: string; callback_data?: string; url?: string };
type TelegramKeyboard = { inline_keyboard: TelegramButton[][] };

/* ------------------------------------------------------------------------ *
 * Telegram presentation layer. Every bot message is HTML: a bold title line,
 * an optional italic subtitle, details grouped as Maestro-style trees
 * (├ … └), and addresses in <code> so they are tap-to-copy. Menu taps edit the panel that
 * was tapped instead of stacking new messages.
 * ------------------------------------------------------------------------ */

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tgTitle(icon: string, title: string, subtitle?: string): string {
  return `${icon} <b>${title}</b>${subtitle ? `\n<i>${subtitle}</i>` : ''}`;
}

/** Terminal-style tree, the look of Maestro/BaseBot cards: ├ item … └ last item. */
function tgCard(lines: string[]): string {
  return lines.map((line, index) => `${index === lines.length - 1 ? '└' : '├'} ${line}`).join('\n');
}

/** A titled tree section: "📊 <b>Market</b>" followed by its branches. */
function tgSection(icon: string, title: string, lines: string[]): string {
  return `${icon} <b>${title}</b>\n${tgCard(lines)}`;
}

/** Compact signed change for inline timeframes: 🟢+3.5% / 🔴−1.2%. */
function formatChangeShort(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${value >= 0 ? '🟢' : '🔴'}${sign}${Math.abs(value) >= 100 ? Math.abs(value).toFixed(0) : Math.abs(value).toFixed(1)}%`;
}

/** Pair age in the unit traders use: 45m, 7h, 12d, 2y. */
function formatAge(createdAtMs: number | undefined): string | null {
  if (!createdAtMs || !Number.isFinite(createdAtMs)) return null;
  const minutes = Math.max(0, (Date.now() - createdAtMs) / 60_000);
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 365) return `${Math.floor(minutes / (60 * 24))}d`;
  return `${(minutes / (60 * 24 * 365)).toFixed(1).replace(/\.0$/, '')}y`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(value);
}

function tgFootnote(text: string): string {
  return `<i>${text}</i>`;
}

function tgMessage(...blocks: Array<string | false | null | undefined>): string {
  return blocks.filter(Boolean).join('\n\n');
}

function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (value >= size) return `$${(value / size).toFixed(value / size >= 100 ? 0 : value / size >= 10 ? 1 : 2)}${suffix}`;
  }
  return `$${value.toFixed(2)}`;
}

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

/** DEX-style price: $1.2345, $0.004213, or $0.0₅4213 for very small prices. */
function formatTokenPriceUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: value >= 1000 ? 2 : 4 })}`;
  const zeros = Math.ceil(-Math.log10(value)) - 1; // zeros right after the decimal point
  const significant = (value * 10 ** (zeros + 4)).toFixed(0).replace(/0+$/, '') || '0';
  if (zeros >= 4) return `$0.0${String(zeros).split('').map((digit) => SUBSCRIPT_DIGITS[Number(digit)]).join('')}${significant}`;
  return `$${Number(value.toPrecision(4))}`;
}

/** $1,234.56 · $0.42 · $0.0012 — portfolio values. */
function formatUsdValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value >= 1_000_000) return formatCompactUsd(value);
  if (value >= 0.01) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Number(value.toPrecision(2))}`;
}

/** Token amount from smallest units: 12.4K, 3.2M, 0.0042. */
function formatTokenAmount(amount: string | bigint, decimals: number): string {
  const units = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const value = Number(units / base) + Number(units % base) / Number(base);
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return formatTelegramBalance(value);
}

function formatPercentChange(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${value >= 0 ? '🟢' : '🔴'} ${sign}${Math.abs(value).toFixed(2)}%`;
}

function liquidityBadge(liquidityUsd: number): string {
  if (liquidityUsd >= 250_000) return '🟢 deep';
  if (liquidityUsd >= 25_000) return '🟡 moderate';
  return '🔴 thin';
}

function formatTelegramBalance(value: string | number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '0';
  if (Math.abs(amount) < 0.0001) return '<0.0001';
  if (Math.abs(amount) < 1) return String(Number(amount.toPrecision(4)));
  return amount.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function shortenTelegramAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function telegramUtcTime(): string {
  return `${new Date().toISOString().slice(11, 16)} UTC`;
}

const TELEGRAM_CHAIN_ICONS: Record<number, string> = {
  1151111081099710: '◎',
  42161: '🔵',
  8453: '🔷',
  56: '🟡',
  4663: '🟩',
  5042: '◢',
  [NEAR_CHAIN_ID]: 'Ⓝ',
};

function chainEmoji(chainId: number | undefined): string {
  return (chainId !== undefined && TELEGRAM_CHAIN_ICONS[chainId]) || '⛓';
}

const TELEGRAM_EXPLORERS: Record<number, string> = {
  1151111081099710: 'https://solscan.io/tx/',
  42161: 'https://arbiscan.io/tx/',
  8453: 'https://basescan.org/tx/',
  56: 'https://bscscan.com/tx/',
  4663: 'https://robin.etherscan.io/tx/',
  5042: 'https://explorer.arc.io/tx/',
  [NEAR_CHAIN_ID]: NEAR_CHAIN.explorerTxUrl,
};

/** Token pages on each chain's explorer, for the token card's 🔍 button. */
const TELEGRAM_TOKEN_EXPLORERS: Record<number, string> = {
  1151111081099710: 'https://solscan.io/token/',
  42161: 'https://arbiscan.io/token/',
  8453: 'https://basescan.org/token/',
  56: 'https://bscscan.com/token/',
  4663: 'https://robin.etherscan.io/token/',
  5042: 'https://explorer.arc.io/token/',
  [NEAR_CHAIN_ID]: 'https://nearblocks.io/token/',
};

/** Quick-buy presets, in the funding chain's native token. NEAR tokens are bought with NEAR. */
const QUICK_BUY_AMOUNTS = ['0.1', '0.5', '1.0'];
const NEAR_QUICK_BUY_AMOUNTS = ['0.5', '1', '5'];

/** Main menu, laid out like Maestro / BaseBot: trade first, then portfolio and wallets, then tools. */
function telegramActionKeyboard(): TelegramKeyboard {
  return {
    inline_keyboard: [
      // Trade first, then what you hold, discovery, account, and housekeeping last.
      [
        { text: '🟢 Buy', callback_data: 'trade:start' },
        { text: '🔴 Sell', callback_data: 'positions' },
      ],
      [
        { text: '💼 Portfolio', callback_data: 'positions' },
        { text: '🎯 Orders', callback_data: 'orders' },
      ],
      [
        { text: '📡 Launch radar', callback_data: 'pools' },
        { text: '👀 Tracking', callback_data: 'track' },
      ],
      [
        { text: '💳 Wallets', callback_data: 'wallet' },
        { text: '🎁 Refer & Earn', callback_data: 'referral' },
      ],
      [
        { text: '⚙️ Settings', callback_data: 'settings' },
        { text: '❓ Help', callback_data: 'help' },
        { text: '🔄 Refresh', callback_data: 'menu' },
      ],
    ],
  };
}

interface TokenKeyboardContext {
  chainId?: number;
  /** Chain the quick buys are paid from (any supported chain, including NEAR). */
  fundingChainId?: number;
  /** Native symbol the quick buys spend (ETH, SOL, BNB, NEAR …). */
  fundingSymbol?: string;
  fundingChainName?: string;
  slippagePercent?: number;
  /** Pay-with shortcuts: the chains the wallet holds funds on, else the defaults. */
  payWith?: Array<{ id: number; label: string }>;
  /** Chart page for this token (see tokenChartUrl). */
  chartUrl?: string;
}

/** Quick-buy presets for the pay-from chain: NEAR keeps 0.5/1/5; NEAR tokens paid elsewhere use chain-sized presets. */
function telegramQuickBuyAmounts(tokenChainId: number | undefined, fundingChainId: number | undefined): string[] {
  if (tokenChainId === NEAR_CHAIN_ID) {
    if (fundingChainId === undefined || fundingChainId === NEAR_CHAIN_ID) return NEAR_QUICK_BUY_AMOUNTS;
    return getNetwork(fundingChainId)?.quickBuy.slice(0, 3) ?? QUICK_BUY_AMOUNTS;
  }
  return QUICK_BUY_AMOUNTS;
}

/** How long a token card waits for balances to choose Pay-with chains (usually cached already). */
const PAY_WITH_BUDGET_MS = 1_500;

function payWithLabel(chainId: number): string {
  const chain = TELEGRAM_CHAINS.find((item) => item.id === chainId);
  const short: Record<number, string> = { 8453: 'Base', 42161: 'Arb', 4663: 'Robinhood' };
  return `${chainEmoji(chainId)} ${short[chainId] ? `${short[chainId]} ` : ''}${chain?.symbol ?? ''}`.trim();
}

/** Pay-with shortcuts shown on every token card (callback sets the funding chain and redraws the card). */
const TELEGRAM_PAY_WITH = [
  { id: NEAR_CHAIN_ID, label: 'Ⓝ NEAR' },
  { id: 1151111081099710, label: '◎ SOL' },
  { id: 4663, label: '🟩 Robinhood ETH' },
];

/**
 * Trading panel under a token card. Mirrors the Maestro layout: utility row on
 * top, buy presets labelled with the exact amount and asset, sells, then setup
 * and links. Callback data is unchanged so older cards keep working.
 */
function telegramTokenKeyboard(address: string, context: TokenKeyboardContext = {}): TelegramKeyboard {
  const fundingSymbol = context.fundingSymbol ?? '';
  const refresh = `token:refresh:${address}`.length <= 64 ? `token:refresh:${address}` : 'token:refresh:last'; // 64-byte callback cap
  const explorer = context.chainId !== undefined ? TELEGRAM_TOKEN_EXPLORERS[context.chainId] : undefined;
  return {
    inline_keyboard: [
      [
        { text: '🔄 Refresh', callback_data: refresh },
        { text: '✖️ Close', callback_data: 'dismiss' },
      ],
      telegramQuickBuyAmounts(context.chainId, context.fundingChainId).map((amount) => ({
        text: `🟢 Buy ${amount}${fundingSymbol ? ` ${fundingSymbol}` : ''}`,
        callback_data: `trade:buy:${amount}`,
      })),
      [
        { text: '🔴 Sell 25%', callback_data: 'trade:sell:25' },
        { text: '🔴 Sell 50%', callback_data: 'trade:sell:50' },
        { text: '🔴 Sell 100%', callback_data: 'trade:sell:100' },
      ],
      (context.payWith ?? TELEGRAM_PAY_WITH).map((option) => ({
        text: `${option.id === context.fundingChainId ? '✅ ' : ''}${option.label}`,
        callback_data: `token:pay:${option.id}`,
      })),
      [
        { text: '✏️ Buy X', callback_data: 'trade:custom' },
        { text: `⛓ ${context.fundingChainName ?? 'Funding'}`, callback_data: 'settings' },
        { text: `🎚 Slip ${context.slippagePercent ?? 1}%`, callback_data: 'settings' },
      ],
      [
        { text: '📈 Chart', url: context.chartUrl ?? tokenChartUrl({ address, chainId: context.chainId }) },
        ...(explorer ? [{ text: '🔍 Explorer', url: `${explorer}${encodeURIComponent(address)}` }] : []),
      ],
      [
        { text: '🧺 Bundle buy', callback_data: 'bundle:buy' },
        { text: '🧺 Bundle sell', callback_data: 'bundle:sell' },
      ],
      [
        { text: '🎯 Limit sell', callback_data: 'order:new:limit' },
        { text: '📈 Take profit', callback_data: 'order:new:tp' },
        { text: '🛑 Stop loss', callback_data: 'order:new:sl' },
      ],
    ],
  };
}

function telegramTradeConfirmationKeyboard(tradeId: string, confirmLabel = '✅ Confirm and submit'): TelegramKeyboard {
  return {
    inline_keyboard: [[
      { text: confirmLabel, callback_data: `trade:confirm:${tradeId}` },
      { text: '✖️ Cancel', callback_data: 'trade:cancel' },
    ]],
  };
}

/** Most wallets one Telegram user can hold (generated + imported). */
const MAX_WALLETS_PER_USER = 10;

const telegramDetectionMemoryCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();

const TELEGRAM_CHAINS = [
  { id: 1151111081099710, name: 'Solana', symbol: 'SOL' },
  { id: 42161, name: 'Arbitrum One', symbol: 'ETH' },
  { id: 8453, name: 'Base', symbol: 'ETH' },
  { id: 56, name: 'BNB Chain', symbol: 'BNB' },
  { id: 4663, name: 'Robinhood Chain', symbol: 'ETH' },
  { id: 5042, name: 'Arc Chain', symbol: 'USDC' },
  { id: 397, name: 'NEAR', symbol: 'NEAR' }, // funds EVM/Solana buys through NEAR Intents
];

const TELEGRAM_SLIPPAGE_OPTIONS = [0.5, 1, 3, 5];

interface TelegramProfile {
  /** Legacy read-only linked addresses (linking was removed; kept so old rows round-trip). */
  evmAddress?: string;
  solanaAddress?: string;
  nearAddress?: string;
  fundingChainId?: number;
  slippagePercent?: number;
  lastTokenAddress?: string;
  lastTokenChainId?: number;
  lastTokenChainType?: 'EVM' | 'SVM' | 'NEAR';
  lastTokenSymbol?: string;
}

const API_RATE_LIMIT = 60;

// Rate limiting middleware
async function checkRateLimit(
  request: Request,
  env: Env,
  maxRequests: number = 10,
  windowMs: number = 60000
): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
  if (!env.RATE_LIMIT) {
    return { allowed: true, remaining: maxRequests, resetTime: 0 };
  }

  // Get client IP (Cloudflare adds this header)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rate-limit:${ip}`;

  const now = Date.now();
  const windowStart = now - windowMs;

  // Get current requests
  const data = await env.RATE_LIMIT.get(key);
  let requests: number[] = data ? JSON.parse(data) : [];

  // Remove old requests outside the window
  requests = requests.filter(time => time > windowStart);

  // Check if limit reached
  if (requests.length >= maxRequests) {
    const oldestRequest = requests[0];
    const resetTime = oldestRequest + windowMs;
    return { allowed: false, remaining: 0, resetTime };
  }

  // Add this request
  requests.push(now);
  await env.RATE_LIMIT.put(key, JSON.stringify(requests), { expirationTtl: Math.ceil(windowMs / 1000) });

  return { allowed: true, remaining: maxRequests - requests.length, resetTime: 0 };
}

export default {
  /** Cron trigger (wrangler.toml [triggers]): every minute, check and execute limit / TP / SL orders. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    applyRpcConfig(env);
    ctx.waitUntil(Promise.all([
      sweepOrders(env).then((result) => {
        if (result.triggered || result.interrupted) console.log('Order sweep', JSON.stringify(result));
      }).catch((error) => console.error('Order sweep failed', error)),
      watchWallets(env).then((result) => {
        if (result.trades) console.log('Wallet watch', JSON.stringify(result));
      }).catch((error) => console.error('Wallet watch failed', error)),
    ]));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // Keyed RPCs (ALCHEMY / HELIUS / RPC_*) go ahead of the public backups for every read and transaction.
    applyRpcConfig(env);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Telegram webhook. Keep this outside the public API rate limiter and
      // authenticate it with the secret configured in BotFather's webhook.
      if (path === '/telegram/webhook') {
        if (request.method !== 'POST') {
          return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
        }
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
          return Response.json({ error: 'Telegram is not configured' }, { status: 503, headers: corsHeaders });
        }
        const receivedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (receivedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
        }
        return handleTelegramWebhook(request, env, ctx);
      }

      // API Routes - apply rate limiting
      if (path.startsWith('/api/')) {
        // Check rate limit (60 requests per minute per IP — quotes refresh as users type)
        const rateLimit = await checkRateLimit(request, env, API_RATE_LIMIT, 60000);
        
        if (!rateLimit.allowed) {
          return Response.json(
            { 
              error: 'Rate limit exceeded',
              message: `Too many requests. Try again in ${Math.ceil((rateLimit.resetTime - Date.now()) / 1000)} seconds.`,
              retryAfter: Math.ceil((rateLimit.resetTime - Date.now()) / 1000)
            },
            { 
              status: 429, 
              headers: { 
                ...corsHeaders,
                'Retry-After': String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)),
                'X-RateLimit-Limit': String(API_RATE_LIMIT),
                'X-RateLimit-Remaining': '0',
              }
            }
          );
        }

        const response = await handleApiRequest(request, env, ctx, corsHeaders);
        
        // Add rate limit headers to response
        const headers = new Headers(response.headers);
        headers.set('X-RateLimit-Limit', String(API_RATE_LIMIT));
        headers.set('X-RateLimit-Remaining', String(rateLimit.remaining));
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // Health check
      if (path === '/health') {
        // Which RPC / API keys are configured (booleans only — never the values).
        return Response.json({ status: 'ok', timestamp: Date.now(), keys: apiKeyStatus(env as unknown as RpcEnv & Record<string, unknown>) }, { headers: corsHeaders });
      }

      // For all other routes, serve the static site from Pages
      return fetch(request);
    } catch (error) {
      return Response.json(
        { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};

/** Recently handled update ids (per isolate): Telegram redelivers an update it thinks timed out. */
const handledTelegramUpdates = new Set<number>();

function firstTelegramDelivery(updateId: number | undefined): boolean {
  if (updateId === undefined) return true;
  if (handledTelegramUpdates.has(updateId)) return false;
  handledTelegramUpdates.add(updateId);
  if (handledTelegramUpdates.size > 500) handledTelegramUpdates.delete(handledTelegramUpdates.values().next().value!);
  return true;
}

/**
 * Telegram waits for the webhook response before it delivers that chat's next
 * update, so a slow quote used to make every following tap feel stuck. The
 * update is acknowledged at once and handled in the background instead.
 * Confirming a trade is the exception: signing and recording it must not be
 * cut short by the background-task time limit, so it runs before replying.
 */
async function handleTelegramWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  if (!firstTelegramDelivery(update.update_id)) return Response.json({ ok: true });

  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  const work = processTelegramUpdate(update, env).catch(async (error: unknown) => {
    console.error('Telegram update failed', error);
    if (chatId) {
      await telegramApiRequest('sendMessage', env, {
        chat_id: chatId,
        text: tgMessage(tgTitle('⚠️', 'Something went wrong'), 'That request could not be completed. Please try again.'),
        parse_mode: 'HTML',
        reply_markup: telegramActionKeyboard(),
      });
    }
  });
  const mustFinish = /^(trade|bundle):confirm:|^ms:send$/.test(update.callback_query?.data ?? '');
  if (mustFinish || typeof ctx?.waitUntil !== 'function') await work;
  else ctx.waitUntil(work);
  return Response.json({ ok: true });
}

/** Commands and replies that do network work first get Telegram's "typing…" indicator right away. */
function telegramMessageNeedsTyping(text: string, isBuyXReply: boolean): boolean {
  if (isBuyXReply) return true;
  const command = text.split(/\s+/)[0]?.toLowerCase().split('@')[0] ?? '';
  if (['/start', '/wallet', '/balances', '/positions', '/pools', '/swap', '/referral', '/refer', '/invite', '/rewards', '/menu', '/settings', '/importkey'].includes(command)) return true;
  return !command.startsWith('/') && normalizeTelegramAddress(text) !== null;
}

async function processTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const message = update.message;
  const callback = update.callback_query;
  const chatId = message?.chat?.id ?? callback?.message?.chat?.id;
  if (!chatId) return;

  if (callback) {
    const data = callback.data ?? '';
    const chatType = callback.message?.chat?.type;
    const recognized = ['help', 'menu', 'wallet', 'settings', 'dismiss', 'positions', 'positions:fresh', 'trade:start', 'token:refresh:last', 'referral', 'referral:claim', 'pools'].includes(data)
      || (data.startsWith('pools:') && !!launchpadById(data.slice(6)))
      || /^lp:(view|buy):[a-f0-9]{24}:[0-5]$/.test(data)
      || /^trade:cont:[0-9a-f]{8}$/.test(data)
      || ['wallet:generate', 'wallet:import', 'wallet:export', 'wallet:preferred', 'wallet:list', 'wallet:rename', 'wallet:delete', 'wallet:delete:confirm'].includes(data)
      || data === 'orders' || data === 'order:place' || data === 'order:discard' || data === 'order:price'
      || ['ms:start', 'ms:to:mine', 'ms:to:paste', 'ms:custom', 'ms:amounts', 'ms:send', 'ms:cancel'].includes(data) || /^ms:chain:\d+$/.test(data) || /^ms:amt:\d{1,9}(\.\d{1,9})?$/.test(data)
      || data === 'track' || data === 'track:add' || /^track:(v|alerts|copy|del):[0-9a-f]{10}$/.test(data)
      || /^import:(evm|solana|near)$/.test(data) || /^import:near:pick:[0-7]$/.test(data)
      || (data.startsWith('track:a:') && walletKind(data.slice('track:a:'.length)) !== null)
      || /^track:cm:[0-9a-f]{10}:(off|buy|buysell)$/.test(data) || /^track:(ca|ok):[0-9a-f]{10}:(buy|buysell):(10|25|50|100|250)$/.test(data)
      || /^order:new:(limit|tp|sl)$/.test(data) || /^order:at:(limit|tp|sl):\d{1,4}$/.test(data) || /^order:size:(25|50|100)$/.test(data) || /^order:cancel:[0-9a-f]{10}$/.test(data)
      || /^bundle:(buy|sell)(:\d{1,6}(\.\d{1,6})?)?$/.test(data) || /^bundle:confirm:[0-9a-f]{8}$/.test(data) || data === 'bundle:cancel'
      || /^wallet:use:[\w:-]{1,52}$/.test(data)
      || /^wallet:(v|ren|exp|del|delok):[\w:-]{1,52}$/.test(data) || /^wallet:def:[esna]:[\w:-]{1,50}$/.test(data)
      || /^token:refresh:(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(data)
      || (data.startsWith('token:refresh:') && isNearAccountId(data.slice('token:refresh:'.length)))
      || /^token:pay:\d+$/.test(data)
      || /^settings:chain:\d+$/.test(data)
      || /^settings:slippage:(0\.5|1|3|5)$/.test(data)
      || /^trade:(buy:\d{1,6}(\.\d{1,6})?|sell:(25|50|100)|custom|confirm:[0-9a-f-]+|cancel)$/.test(data);
    if (!recognized) {
      await telegramApiCall('answerCallbackQuery', env, {
        callback_query_id: callback.id,
        text: 'This button is no longer available.',
        show_alert: true,
      });
      return;
    }
    // Acknowledge the tap while the real work runs, instead of one extra round trip first.
    const acknowledged = telegramApiRequest('answerCallbackQuery', env, {
      callback_query_id: callback.id,
      ...(telegramCallbackToast(data) ? { text: telegramCallbackToast(data) } : {}),
    });
    if ((data.startsWith('lp:') || data.startsWith('trade:') || data.startsWith('token:pay:') || data === 'wallet' || data.startsWith('wallet:') || data === 'settings' || data.startsWith('settings:') || data.startsWith('positions') || data.startsWith('referral') || data.startsWith('bundle') || data.startsWith('order') || data.startsWith('track') || data.startsWith('import') || data.startsWith('ms:')) && chatType !== 'private') {
      await acknowledged;
      await sendTelegramMessage(chatId, '🔒 For privacy, check wallet balances and manage personal settings in a private chat with this bot.', env);
      return;
    }
    await Promise.all([acknowledged, handleTelegramCallback(chatId, data, env, callback.message?.message_id, chatType)]);
    return;
  }

  const text = message?.text?.trim() ?? '';
  const replyTo = message?.reply_to_message;
  const isBuyXReply = Boolean(replyTo?.from?.is_bot && replyTo.text?.startsWith(TELEGRAM_BUY_X_PROMPT));
  // Instant feedback while market data, balances or quotes load; never delays the real reply.
  const typing = telegramMessageNeedsTyping(text, isBuyXReply)
    ? telegramApiRequest('sendChatAction', env, { chat_id: chatId, action: 'typing' })
    : undefined;
  await Promise.all([typing, handleTelegramMessage(chatId, message?.chat?.type, text, env, replyTo, message?.from?.first_name, message?.message_id)]);
}

/** Short toast shown on the button tap itself, so every tap gets instant feedback. */
function telegramCallbackToast(data: string): string | undefined {
  if (data.startsWith('token:refresh:')) return 'Refreshing market data…';
  if (data === 'wallet') return 'Loading balances…';
  if (data.startsWith('positions')) return 'Loading your portfolio…';
  if (/^trade:(buy|sell):/.test(data)) return 'Fetching a live quote…';
  if (data.startsWith('trade:confirm:')) return 'Submitting…';
  if (data.startsWith('bundle:confirm:')) return 'Submitting every wallet…';
  if (data === 'order:place') return 'Placing order…';
  if (data === 'ms:send') return 'Sending…';
  if (data.startsWith('order:cancel:')) return 'Cancelling…';
  if (/^bundle:(buy|sell):/.test(data)) return 'Quoting every wallet…';
  if (data.startsWith('trade:cont:')) return 'Checking the bridge…';
  if (data === 'referral') return 'Loading your referrals…';
  const chainMatch = data.match(/^(?:settings:chain|token:pay):(\d+)$/);
  if (chainMatch) {
    const chain = TELEGRAM_CHAINS.find((item) => item.id === Number(chainMatch[1]));
    return chain ? `Funding chain: ${chain.name}` : undefined;
  }
  const slippageMatch = data.match(/^settings:slippage:(.+)$/);
  if (slippageMatch) return `Slippage set to ${slippageMatch[1]}%`;
  return undefined;
}

const TELEGRAM_HELP_TEXT = tgMessage(
  tgTitle('❓', 'Hopr command guide', 'Everything the bot can do, in one place.'),
  tgSection('🛒', 'Trading', [
    'Paste any token address (EVM, Solana or NEAR) for a live trading panel',
    'Pay from any chain — Solana, Base, Arbitrum, BNB, Robinhood, Arc or NEAR — for a token on any chain',
    'Buy / Sell buttons first show a live quote',
    '/swap &lt;amount&gt; &lt;from&gt; &lt;to&gt; — NEAR swaps on Ref Finance, e.g. <code>/swap 1 near usdc</code>',
    '/portfolio — every token you hold on all 7 chains, live prices',
    '/pools — launchpad pools, liquidity and volume',
    '🧺 Bundle buy / sell — trade a token from every wallet at once, one confirmation',
    '🎯 Limit sell · 📈 Take profit · 🛑 Stop loss — automatic sells, checked every minute (/orders)',
    '👀 /track &lt;address&gt; [name] — alerts when a wallet buys or sells · 🤖 optional copy trading',
    'Only the <b>Confirm and submit</b> button signs and submits a trade',
  ]),
  tgSection('💳', 'Wallet', [
    '/wallet — balances for your active wallet',
    '/wallet &lt;address&gt; — one-off balance check',
    `💳 Wallets — create, switch, rename, import or delete up to ${MAX_WALLETS_PER_USER} wallets (W1, W2 …)`,
    '📥 Import — choose EVM, Solana or NEAR, then paste the key (DM only; the message is deleted)',
    '/exportkeys — reveal your private keys (DM only)',
    '📤 /multisend — send a coin from one wallet to many (your W2, W3 … or pasted addresses)',
  ]),
  tgSection('🎁', 'Refer &amp; Earn', [
    '/referral — your invite links and earnings',
    `Earn ${REFERRAL_SHARE * 100}% of HOPR fee revenue after the routing provider's share (${HOPR_FEE_PERCENT}% on trades and bridges)`,
  ]),
  tgSection('⚙️', 'General', [
    '/menu — main menu with your portfolio',
    '/balances — native balances on every chain',
    '/settings — funding chain &amp; slippage',
  ]),
  tgFootnote('Every token you buy or open is tracked automatically. Hopr never asks for a seed phrase.'),
);

async function handleTelegramMessage(
  chatId: number,
  chatType: string | undefined,
  text: string,
  env: Env,
  replyToMessage?: TelegramMessage['reply_to_message'],
  firstName?: string,
  messageId?: number,
): Promise<void> {
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_IMPORT_PROMPT)) {
    const chain = importChainFromPrompt(replyToMessage.text);
    if (chain && chatType === 'private') {
      await clearPendingPrompt(chatId, env);
      await importFromPrompt(chatId, chain, text, env, messageId);
      return;
    }
  }
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_MS_ADDRESS_PROMPT)) {
    await setMultiSendRecipients(chatId, text, env);
    return;
  }
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_MS_AMOUNT_PROMPT)) {
    await setMultiSendAmount(chatId, text.trim().replace(',', '.'), env);
    return;
  }
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_TRACK_PROMPT)) {
    await clearPendingPrompt(chatId, env);
    await addTelegramTrackedWallet(chatId, text, env);
    return;
  }
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_ORDER_PRICE_PROMPT)) {
    await setTelegramOrderPrice(chatId, text, env);
    return;
  }
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_RENAME_PROMPT)) {
    await renameTelegramWallet(chatId, text, env);
    return;
  }
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_BUY_X_PROMPT)) {
    const amount = text.trim().replace(',', '.');
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(amount) || !(Number(amount) > 0)) {
      await sendTelegramMessage(chatId, tgMessage(tgTitle('✏️', 'Buy X'), 'Send just a number, e.g. <code>1</code> or <code>0.25</code>. Tap ✏️ Buy X to try again.'), env);
      return;
    }
    await handleTelegramTradeAction(chatId, `trade:buy:${amount}`, env);
    return;
  }
  // The bot just asked for a wallet or a key: a plain message (no "Reply") answers it too.
  if (!replyToMessage && text && !text.startsWith('/') && chatType === 'private') {
    const pending = await takePendingPrompt(chatId, env);
    if (pending?.kind === 'track') {
      await addTelegramTrackedWallet(chatId, text, env);
      return;
    }
    if (pending?.kind === 'import') {
      await importFromPrompt(chatId, pending.chain, text, env, messageId);
      return;
    }
  }

  const [rawCommand = '', ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];

  if (command === '/start') {
    // t.me/<bot>?start=t_<address>: "Trade on Telegram" from the website opens that token's panel.
    const sharedToken = args[0]?.startsWith('t_') ? normalizeTelegramAddress(args[0].slice(2)) : null;
    if (sharedToken) {
      // First visit: create the wallet alongside the lookup, so the Buy buttons work right away.
      await Promise.all([
        loadTelegramHomeWallet(chatId, chatType, env, true),
        lookupTelegramToken(chatId, sharedToken, env),
      ]);
      return;
    }
    // t.me/<bot>?start=ref_<code>: the invite binds this Telegram user to the referrer.
    const invite = args[0]?.match(/^ref[_-]([a-z0-9]{4,16})$/i)?.[1];
    let notice: string | undefined;
    if (invite && chatType === 'private' && env.DB) {
      const result = await bindTelegramReferral(String(chatId), invite, env).catch(() => null);
      if (result?.bound) notice = '🎁 Invite accepted — you joined through a friend. Happy trading!';
    }
    await showTelegramWelcome(chatId, chatType, env, firstName, notice);
    return;
  }
  if (command === '/referral' || command === '/refer' || command === '/invite' || command === '/rewards') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 Open /referral in a private chat with this bot to see your invite link and earnings.', env);
      return;
    }
    await showTelegramReferral(chatId, env);
    return;
  }
  if (command === '/menu') {
    await showTelegramMenu(chatId, env, undefined, chatType);
    return;
  }
  if (command === '/pools') {
    const id = text.trim().split(/\s+/)[1]?.toLowerCase() ?? 'pump';
    if (!launchpadById(id)) {
      await sendTelegramMessage(chatId, `Choose a source: ${LAUNCHPADS.map((s) => `/pools ${s.id}`).join(', ')}`, env);
      return;
    }
    await showTelegramPools(chatId, id as LaunchpadId, env);
    return;
  }
  if (command === '/track' || command === '/tracking' || command === '/watch' || command === '/copy' || command === '/untrack') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 Track wallets in a private chat with this bot.', env);
      return;
    }
    if (command === '/untrack' && args[0]) {
      await removeTelegramTrackedWallet(chatId, args[0], env);
      return;
    }
    if ((command === '/track' || command === '/watch') && args[0]) {
      await addTelegramTrackedWallet(chatId, args.join(' '), env);
      return;
    }
    await showTelegramTracking(chatId, env);
    return;
  }
  if (command === '/multisend' || command === '/send' || command === '/disperse') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 Send funds only in a private chat with this bot.', env);
      return;
    }
    await startMultiSend(chatId, env);
    return;
  }
  if (command === '/orders' || command === '/limit' || command === '/tp' || command === '/sl') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 Open /orders in a private chat with this bot.', env);
      return;
    }
    await showTelegramOrders(chatId, env);
    return;
  }
  if (command === '/positions' || command === '/portfolio' || command === '/pnl') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For privacy, view positions in a private chat with this bot.', env);
      return;
    }
    await showTelegramPositions(chatId, env);
    return;
  }
  if (command === '/app') {
    // The Mini App was retired: everything lives in the bot now.
    await showTelegramMenu(chatId, env, undefined, chatType);
    return;
  }
  if (command === '/help' || !text) {
    await sendTelegramMessage(chatId, TELEGRAM_HELP_TEXT, env, telegramActionKeyboard());
    return;
  }
  if (command === '/wallet' || command === '/balances') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For privacy, check wallet balances in a private chat with this bot.', env);
      return;
    }
    if (args.length > 0) {
      const network = args[0]?.toLowerCase();
      const suppliedAddress = network === 'evm' || network === 'solana' || network === 'near' ? args.slice(1).join(' ') : args.join(' ');
      const isEvmAddress = /^0x[a-fA-F0-9]{40}$/.test(suppliedAddress);
      const isSolanaAddress = suppliedAddress.length >= 32 && suppliedAddress.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(suppliedAddress);
      const isNearAddress = isNearAccountId(suppliedAddress.toLowerCase());
      if ((!isEvmAddress && !isSolanaAddress && !isNearAddress)
        || (network === 'evm' && !isEvmAddress)
        || (network === 'solana' && !isSolanaAddress)
        || (network === 'near' && !isNearAddress)) {
        await sendTelegramMessage(chatId, tgMessage(
          tgTitle('💳', 'Check a wallet'),
          tgCard(['/wallet &lt;public-address&gt;', '/wallet evm &lt;address&gt;', '/wallet solana &lt;address&gt;', '/wallet near &lt;account.near&gt;']),
          tgFootnote('Only public addresses are supported — never send a private key or seed phrase.'),
        ), env);
        return;
      }
      await showTelegramWalletBalances(
        chatId,
        isEvmAddress ? suppliedAddress : undefined,
        isSolanaAddress ? suppliedAddress : undefined,
        env,
        { label: 'Balance check', nearAddress: !isEvmAddress && !isSolanaAddress && isNearAddress ? suppliedAddress.toLowerCase() : undefined },
      );
      return;
    }
    await showTelegramWallet(chatId, env);
    return;
  }
  if (command === '/setwallet') {
    // Read-only wallet linking was retired: every wallet is now a Hopr wallet you create or import.
    await sendTelegramMessage(chatId, tgMessage(
      tgTitle('💳', 'Wallet linking was removed'),
      `Create, import and switch between up to ${MAX_WALLETS_PER_USER} wallets from 💳 Wallets.`,
    ), env, chatType === 'private' ? telegramWalletSetupKeyboard() : undefined);
    return;
  }
  if (command === '/importkey') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For your safety, only send private keys in a private chat with this bot — never in a group.', env);
      return;
    }
    // The message holds a private key: remove it from the chat before anything else.
    if (args.length > 1) await deleteTelegramMessage(chatId, messageId, env);
    await handleTelegramImportKey(chatId, args, env);
    return;
  }
  if (command === '/exportkeys') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For your safety, export keys only in a private chat with this bot.', env);
      return;
    }
    await sendTelegramMessage(
      chatId,
      tgMessage(
        tgTitle('⚠️', 'Reveal private keys?'),
        tgCard([
          'Your raw private keys will be shown in this chat.',
          '<b>Anyone who sees them controls your funds.</b>',
        ]),
        tgFootnote('Only continue on a private, trusted device.'),
      ),
      env,
      telegramExportWarningKeyboard(),
    );
    return;
  }
  if (command === '/settings') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For privacy, manage personal settings in a private chat with this bot.', env);
      return;
    }
    await showTelegramSettings(chatId, env);
    return;
  }
  if (command === '/swap') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For your safety, trade only in a private chat with this bot.', env);
      return;
    }
    await handleTelegramNearSwapCommand(chatId, args, env);
    return;
  }

  const address = normalizeTelegramAddress(text);
  if (address) {
    await lookupTelegramToken(chatId, address, env);
    return;
  }

  await sendTelegramMessage(
    chatId,
    tgMessage(
      tgTitle('🤔', 'Not sure what that is'),
      'Paste a complete EVM (<code>0x…</code>), Solana, or NEAR (<code>token.near</code>) token address, or use /help to see every command.',
    ),
    env,
    telegramActionKeyboard(),
  );
}

type TelegramHomeWallet = CustodialWallet | null;

/**
 * The user's trading wallet for the home screen; creates the NEAR account for pre-NEAR wallets.
 * With `provision` (/start) a first wallet is generated, so trading works from the first tap.
 */
async function loadTelegramHomeWallet(chatId: number, chatType: string | undefined, env: Env, provision = false): Promise<TelegramHomeWallet> {
  if (chatType !== 'private') return null;
  try {
    let wallet = await getCustodialWallet(String(chatId), env);
    if (!wallet && provision && env.DB && env.ENCRYPTION_KEY) wallet = await createCustodialWallet(String(chatId), env);
    if (wallet && !wallet.nearAddress) wallet.nearAddress = await ensureNearWallet(String(chatId), env).catch(() => null);
    return wallet;
  } catch {
    return null;
  }
}

/** The home screen shows the chains that answered within this budget; the rest keep loading. */
const HOME_PORTFOLIO_BUDGET_MS = 2_500;

/**
 * Home screen shared by /start and /menu. Deliberately short: title, balance,
 * one line of coins, the deposit addresses, one hint. Details live behind the buttons
 * (💳 Wallets, 💼 Portfolio, ❓ Help).
 */
function telegramHomeText(heading: string, wallet: TelegramHomeWallet, portfolio: Portfolio | null): string {
  const coins = (portfolio?.holdings ?? [])
    .filter((holding) => holding.address === NATIVE && BigInt(holding.amount) > 0n)
    .slice(0, 4)
    .map((holding) => `${chainEmoji(holding.chainId)} ${formatTokenAmount(holding.amount, holding.decimals)} ${escapeTelegramHtml(holding.symbol)}`);
  const funded = Boolean(portfolio && (portfolio.totalUsd > 0 || coins.length));
  const hint = !wallet
    ? 'No trading wallet yet — tap 💳 Wallets to create one.'
    : funded
      ? 'Paste a token address to trade.'
      : 'Send funds to an address above, then paste a token address to trade.';
  // Tap-to-copy deposit addresses, one per line.
  const addresses = wallet
    ? [
      wallet.evmAddress && `EVM   <code>${escapeTelegramHtml(wallet.evmAddress)}</code>`,
      wallet.solanaAddress && `SOL   <code>${escapeTelegramHtml(wallet.solanaAddress)}</code>`,
      wallet.nearAddress && `NEAR  <code>${escapeTelegramHtml(wallet.nearAddress)}</code>`,
    ].filter(Boolean).join('\n') || null
    : null;
  return tgMessage(
    `⚡ <b>${heading}</b>`,
    wallet && portfolio ? `💼 <b>${formatUsdValue(portfolio.totalUsd)}</b>${coins.length ? `\n${coins.join('  ·  ')}` : ''}` : null,
    addresses,
    `<i>${hint}</i>`,
  );
}

/** Portfolio for a home screen: whatever chains are ready within the budget. */
async function homePortfolio(chatId: number, wallet: TelegramHomeWallet, env: Env): Promise<Portfolio | null> {
  if (!wallet) return null;
  return loadUserPortfolio(chatId, wallet, env, false, HOME_PORTFOLIO_BUDGET_MS).catch(() => null);
}

/** After the home screen is sent, let the slow chains finish so 💼 Portfolio opens instantly. */
async function settlePortfolio(wallet: TelegramHomeWallet): Promise<void> {
  if (wallet) await pendingPortfolioLoad(wallet);
}

async function showTelegramWelcome(chatId: number, chatType: string | undefined, env: Env, firstName?: string, notice?: string): Promise<void> {
  const name = firstName?.trim() ? `, ${escapeTelegramHtml(firstName.trim().slice(0, 32))}` : '';
  const wallet = await loadTelegramHomeWallet(chatId, chatType, env, true);
  const home = telegramHomeText(`Welcome to Hopr${name}`, wallet, await homePortfolio(chatId, wallet, env));
  await sendTelegramMessage(chatId, notice ? tgMessage(`<b>${notice}</b>`, home) : home, env, telegramActionKeyboard());
  await settlePortfolio(wallet);
}

async function showTelegramMenu(chatId: number, env: Env, panelId?: number, chatType = 'private'): Promise<void> {
  const wallet = await loadTelegramHomeWallet(chatId, chatType, env);
  await sendTelegramPanel(chatId, panelId, telegramHomeText('Hopr', wallet, await homePortfolio(chatId, wallet, env)), env, telegramActionKeyboard());
  await settlePortfolio(wallet);
}

const TELEGRAM_BUY_SELL_PROMPT = 'Paste the token contract address you want to trade.';

async function showTelegramBuySell(chatId: number, env: Env): Promise<void> {
  // A force-reply prompt focuses the input box; the reply is handled like any pasted address.
  await sendTelegramMessage(chatId, TELEGRAM_BUY_SELL_PROMPT, env, {
    force_reply: true,
    input_field_placeholder: 'Token address — EVM, Solana or NEAR',
  }, null);
}

/** Tokens a user opened in the bot (newest first); with their trades, these are always tracked. */
const WATCHLIST_LIMIT = 40;
const watchlistKey = (chatId: number) => `watch:v1:${chatId}`;

async function readWatchlist(chatId: number, env: Env): Promise<TrackedToken[]> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  const raw = await store?.get(watchlistKey(chatId)).catch(() => null);
  try {
    const parsed = raw ? JSON.parse(raw) as TrackedToken[] : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.chainId === 'number' && typeof item.address === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember an opened token so the portfolio reads its balance from then on. */
async function trackTelegramToken(chatId: number, token: TrackedToken, env: Env): Promise<void> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  if (!store) return;
  const current = await readWatchlist(chatId, env);
  const next = [token, ...current.filter((item) => !(item.chainId === token.chainId && item.address.toLowerCase() === token.address.toLowerCase()))].slice(0, WATCHLIST_LIMIT);
  await store.put(watchlistKey(chatId), JSON.stringify(next), { expirationTtl: 180 * 24 * 60 * 60 });
}

/** Everything the user traded or opened, so it shows up even before an indexer sees it. */
async function trackedTokensFor(chatId: number, env: Env): Promise<TrackedToken[]> {
  type Row = { target_token_address: string; target_chain_id: string };
  const [watched, traded] = await Promise.all([
    readWatchlist(chatId, env),
    env.DB
      ? env.DB.prepare(`SELECT DISTINCT target_token_address, target_chain_id FROM user_trades WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 60`)
        .bind(String(chatId)).all<Row>().then((result) => result.results ?? []).catch(() => [] as Row[])
      : Promise.resolve([] as Row[]),
  ]);
  return [...watched, ...traded.map((row) => ({ chainId: Number(row.target_chain_id), address: row.target_token_address }))]
    .filter((item) => Number.isFinite(item.chainId) && item.address);
}

async function loadUserPortfolio(chatId: number, wallet: NonNullable<TelegramHomeWallet>, env: Env, fresh = false, budgetMs?: number): Promise<Portfolio> {
  return loadPortfolio(wallet, env, { tracked: await trackedTokensFor(chatId, env), fresh, near: nearRpcOptions(env), budgetMs });
}

const TELEGRAM_CHAIN_NAMES: Record<number, string> = {
  8453: 'Base', 42161: 'Arbitrum', 56: 'BNB Chain', 4663: 'Robinhood', 5042: 'Arc', 1151111081099710: 'Solana', [NEAR_CHAIN_ID]: 'NEAR',
};

/**
 * 💼 Portfolio: every token the active wallet holds on all 7 chains, grouped
 * by chain and sorted by value, with a button per token to open its panel
 * (Sell lives there). Untracked tokens need a real market to be shown.
 */
async function showTelegramPositions(chatId: number, env: Env, panelId?: number, fresh = false): Promise<void> {
  const wallet = await getCustodialWallet(String(chatId), env).catch(() => null);
  if (!wallet) {
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('💼', 'Portfolio'),
      tgCard(['No Hopr wallet yet', 'Create one in 💳 Wallets — then fund it and buy any token']),
    ), env, telegramWalletSetupKeyboard());
    return;
  }
  const portfolio = await loadUserPortfolio(chatId, wallet, env, fresh);
  const keyboard: TelegramKeyboard = { inline_keyboard: [] };
  const tokens = portfolio.holdings.filter((holding) => holding.address !== NATIVE);
  const tokenButtons = tokens
    .map((holding) => ({ text: `📈 ${holding.symbol.slice(0, 10)}`, callback_data: `token:refresh:${holding.address}` }))
    .filter((button) => button.callback_data.length <= 64)
    .slice(0, 9);
  for (let index = 0; index < tokenButtons.length; index += 3) keyboard.inline_keyboard.push(tokenButtons.slice(index, index + 3));
  keyboard.inline_keyboard.push(
    [{ text: '🔄 Refresh', callback_data: 'positions:fresh' }, { text: '🟢 Buy', callback_data: 'trade:start' }],
    [{ text: '💳 Wallets', callback_data: 'wallet' }, { text: '◀️ Menu', callback_data: 'menu' }],
  );

  const chains = [...new Set(portfolio.holdings.map((holding) => holding.chainId))]
    .map((chainId) => ({ chainId, holdings: portfolio.holdings.filter((holding) => holding.chainId === chainId) }))
    .map((group) => ({ ...group, total: group.holdings.reduce((sum, holding) => sum + (holding.valueUsd ?? 0), 0) }))
    .sort((left, right) => right.total - left.total);

  const blocks: string[] = [
    `💼 <b>Portfolio</b>  ·  <b>${formatUsdValue(portfolio.totalUsd)}</b>\n<i>${portfolio.holdings.length} asset${portfolio.holdings.length === 1 ? '' : 's'} on ${chains.length} chain${chains.length === 1 ? '' : 's'} · ${telegramUtcTime()}</i>`,
  ];
  let shown = 0;
  for (const group of chains) {
    if (shown >= 28) break;
    const lines = group.holdings.slice(0, Math.max(1, 28 - shown)).map((holding) => {
      shown += 1;
      const change = holding.change24h !== null ? ` ${formatChangeShort(holding.change24h)}` : '';
      const value = holding.valueUsd !== null ? ` · <b>${formatUsdValue(holding.valueUsd)}</b>` : ' · <i>no market yet</i>';
      return `<b>${escapeTelegramHtml(holding.symbol)}</b>  ${formatTokenAmount(holding.amount, holding.decimals)}${value}${change}`;
    });
    blocks.push(`${chainEmoji(group.chainId)} <b>${TELEGRAM_CHAIN_NAMES[group.chainId] ?? 'Chain'}</b> · ${formatUsdValue(group.total)}\n${tgCard(lines)}`);
  }
  if (!portfolio.holdings.length) {
    blocks.push(tgSection('📭', 'Nothing here yet', [
      ...(wallet.evmAddress ? [`EVM  <code>${escapeTelegramHtml(wallet.evmAddress)}</code>`] : []),
      ...(wallet.solanaAddress ? [`SOL  <code>${escapeTelegramHtml(wallet.solanaAddress)}</code>`] : []),
      ...(wallet.nearAddress ? [`NEAR  <code>${escapeTelegramHtml(wallet.nearAddress)}</code>`] : []),
      'Fund any address, then paste a token to buy it',
    ]));
  }
  const slow = [...portfolio.staleChains.map((id) => `${TELEGRAM_CHAIN_NAMES[id] ?? id} (last known)`), ...portfolio.failedChains.map((id) => `${TELEGRAM_CHAIN_NAMES[id] ?? id} (unavailable)`)];
  if (slow.length) blocks.push(`⚠️ <i>RPC busy: ${escapeTelegramHtml(slow.join(', '))} — tap Refresh to retry</i>`);
  blocks.push(tgFootnote('Tap a token to trade or sell it · every token you buy or open is tracked automatically'));
  await sendTelegramPanel(chatId, panelId, tgMessage(...blocks), env, keyboard);
}

function normalizeTelegramAddress(text: string): string | null {
  const value = text.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) return value;
  if (value.length >= 32 && value.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return value;
  // NEAR account ids are case-insensitive to users but always lowercase on-chain.
  if (isNearAccountId(value.toLowerCase())) return value.toLowerCase();
  return null;
}

async function lookupTelegramToken(chatId: number, address: string, env: Env, panelId?: number, chainHint?: number, listing?: string, fresh = false): Promise<void> {
  // Market data, the user's profile and their wallet are independent: fetch them together.
  const [response, profile, wallet] = await Promise.all([
    chainHint
      ? detectTokenOnChain(address, chainHint).catch(() => null).then((detected) => Response.json(detected ?? {}, { status: detected ? 200 : 404 }))
      : handleChainDetection(address, env, {}, { fresh }),
    env.DB || env.TELEGRAM_STATE ? readTelegramProfile(chatId, env).catch(() => null) : Promise.resolve(null),
    env.DB ? getCustodialWallet(String(chatId), env).catch(() => null) : Promise.resolve(null),
  ]);
  const token = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    // A wallet address is not a token: offer to track it instead.
    const trackable = walletKind(address) !== null && `track:a:${address}`.length <= 64;
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🔍', 'No market found'),
      `No indexed token market was found for <code>${escapeTelegramHtml(address)}</code>.`,
      tgFootnote(trackable ? 'If this is a wallet, tap 👀 Track to get alerts when it buys or sells.' : 'Check the address and chain, then try again.'),
    ), env, trackable ? { inline_keyboard: [[{ text: '👀 Track this wallet', callback_data: `track:a:${address}` }, { text: '◀️ Menu', callback_data: 'menu' }]] } : undefined);
    return;
  }

  const numberOrZero = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const price = numberOrZero(token.priceUsd);
  const liquidity = numberOrZero(token.liquidity);
  const fdv = numberOrZero(token.fdv);
  const change = numberOrZero(token.change24h);
  const volume = numberOrZero(token.volume24h);
  const symbol = typeof token.symbol === 'string' ? token.symbol : 'Unknown';
  const name = typeof token.name === 'string' ? token.name : 'Unknown token';
  const chain = typeof token.chainName === 'string' ? token.chainName : 'Unknown chain';
  const chainId = typeof token.chainId === 'number' ? token.chainId : undefined;
  // Named venue from the scanner ("Flap", "Uniswap v3"); NEAR results carry a raw dex id.
  const dex = typeof token.liquiditySource === 'string' ? token.liquiditySource
    : typeof token.dexId === 'string' ? token.dexId.replace(/[-_]+/g, ' ').toUpperCase() : 'DEX';
  const changes = (token.priceChanges ?? {}) as { m5?: number; h1?: number; h6?: number; h24?: number };
  const txns = token.txns24h as { buys?: number; sells?: number } | undefined;
  const age = formatAge(typeof token.pairCreatedAt === 'number' ? token.pairCreatedAt : undefined);

  // The profile supplies the funding chain / slippage shown on the card and its buttons.
  // Any chain can pay for any token; NEAR tokens default to paying with NEAR. Without an explicit
  // choice, a default chain the wallet holds nothing on gives way to the chain it holds the most on.
  const isNear = chainId === NEAR_CHAIN_ID;
  const funds = wallet ? await loadUserPortfolio(chatId, wallet, env, false, PAY_WITH_BUDGET_MS).catch(() => null) : null;
  const funded = (funds?.holdings ?? [])
    .filter((holding) => holding.address === NATIVE && BigInt(holding.amount) > 0n && TELEGRAM_CHAINS.some((item) => item.id === holding.chainId))
    .sort((left, right) => (right.valueUsd ?? 0) - (left.valueUsd ?? 0));
  const defaultFunding = isNear ? NEAR_CHAIN_ID : 8453;
  const autoFunding = profile?.fundingChainId === undefined && funded.length > 0 && !funded.some((holding) => holding.chainId === defaultFunding)
    ? funded[0].chainId : undefined;
  const fundingChain = TELEGRAM_CHAINS.find((item) => item.id === (profile?.fundingChainId ?? autoFunding ?? defaultFunding)) ?? TELEGRAM_CHAINS[2];
  const payWith = funded.length
    ? [...new Set([...funded.map((holding) => holding.chainId), ...TELEGRAM_PAY_WITH.map((option) => option.id)])].slice(0, 3)
      .map((id) => ({ id, label: TELEGRAM_PAY_WITH.find((option) => option.id === id)?.label ?? payWithLabel(id) }))
    : TELEGRAM_PAY_WITH;
  const fundingSymbol = fundingChain.symbol;
  const slippage = profile?.slippagePercent ?? 1;
  const nearViaRef = isNear && fundingChain.id === NEAR_CHAIN_ID;

  // "Your wallet" lines: what you hold of this token and what you can pay with (short deadline, never blocks the card for long).
  const ownerOn = (id: number | undefined) => !wallet || id === undefined ? null
    : id === NEAR_CHAIN_ID ? wallet.nearAddress ?? null : id === 1151111081099710 ? wallet.solanaAddress : wallet.evmAddress;
  const tokenOwner = ownerOn(chainId);
  const fundingOwner = ownerOn(fundingChain.id);
  const nearRpc = nearRpcOptions(env);
  const [held, payBalance] = await Promise.all([
    tokenOwner && chainId !== undefined ? quickTokenBalance(chainId, address, tokenOwner, nearRpc) : Promise.resolve(null),
    fundingOwner ? quickNativeBalance(fundingChain.id, fundingOwner, nearRpc) : Promise.resolve(null),
  ]);
  const heldUnits = held ? BigInt(held.amount) : 0n;
  const heldValue = held && heldUnits > 0n && price > 0 ? Number(formatUnits(heldUnits, held.decimals, 8).replace(/,/g, '')) * price : null;
  const walletLines = wallet ? [
    held === null ? 'Holding  <i>balance loading — tap Refresh</i>'
      : heldUnits > 0n ? `Holding  <b>${formatTokenAmount(heldUnits, held.decimals)} ${escapeTelegramHtml(symbol)}</b>${heldValue !== null ? ` · ${formatUsdValue(heldValue)}` : ''}`
      : `Holding  <i>none yet</i>`,
    payBalance === null ? `Pay with  ${escapeTelegramHtml(fundingSymbol)} on ${escapeTelegramHtml(fundingChain.name)}`
      : `Pay with  <b>${formatTokenAmount(payBalance, nativeDecimalsOf(fundingChain.id))} ${escapeTelegramHtml(fundingSymbol)}</b> on ${escapeTelegramHtml(fundingChain.name)}${autoFunding !== undefined ? ' · <i>auto-picked: you hold funds here</i>' : ''}${payBalance === 0n ? (funded.length ? ' · <i>empty — tap a Pay-with chain you hold</i>' : ' · <i>fund to buy</i>') : ''}`,
  ] : null;

  const identity = [
    listing ? `📡 Listed on ${escapeTelegramHtml(listing)}` : token.launchpad ? `📡 ${escapeTelegramHtml(String(token.launchpad))}` : null,
    `${chainEmoji(chainId)} ${escapeTelegramHtml(chain)} · 🏪 ${escapeTelegramHtml(dex)}`,
    [age && `🌱 ${age}`, txns && (txns.buys || txns.sells) ? `🔁 ${formatCount((txns.buys ?? 0) + (txns.sells ?? 0))} txns (🟢${formatCount(txns.buys ?? 0)} 🔴${formatCount(txns.sells ?? 0)})` : null]
      .filter(Boolean).join(' · ') || null,
  ].filter((line): line is string => Boolean(line));

  // A zero here means "not reported", never a real $0: show a dash and say why.
  const marketStatus = typeof token.marketStatus === 'string' ? token.marketStatus : price > 0 ? 'live' : 'none';
  const marketSource = typeof token.marketSource === 'string' ? token.marketSource : 'DexScreener';
  const usdOrDash = (value: number) => value > 0 ? `<b>${formatCompactUsd(value)}</b>` : '—';
  const observed = typeof token.marketObservedAt === 'number' ? new Date(token.marketObservedAt).toISOString().slice(11, 16) : null;
  const holders = typeof token.holders === 'number' && token.holders > 0 ? token.holders : null;
  const marketNote = marketStatus === 'stale'
    ? `⚠️ <i>Market providers are busy — last known numbers${observed ? ` from ${observed} UTC` : ''}. Tap 🔄 Refresh.</i>`
    : marketStatus === 'partial'
      ? `ℹ️ <i>Price via ${escapeTelegramHtml(marketSource)} · no indexed pool yet, so liquidity and volume are not known.</i>`
      : marketStatus === 'none'
        ? '⏳ <i>No market data yet — a brand-new token, or the market providers are busy. Tap 🔄 Refresh in a moment.</i>'
        : null;
  const result = tgMessage(
    `🪙 <b>${escapeTelegramHtml(symbol)}  |  ${escapeTelegramHtml(name)}</b>\n<code>${escapeTelegramHtml(address)}</code>\n${tgCard(identity)}`,
    tgSection('📊', 'Market', [
      `Price  ${price > 0 ? `<b>${formatTokenPriceUsd(price)}</b>` : '—'}`,
      `MC / FDV  ${usdOrDash(fdv)}`,
      `Liquidity  ${liquidity > 0 ? `<b>${formatCompactUsd(liquidity)}</b> ${liquidityBadge(liquidity)}` : '—'}`,
      `Volume 24h  ${usdOrDash(volume)}`,
      ...(holders ? [`Holders  <b>${formatCount(holders)}</b>`] : []),
    ]),
    marketNote,
    price > 0 && tgSection('📈', 'Price change', [
      changes.m5 !== undefined || changes.h1 !== undefined || changes.h6 !== undefined
        ? `5m ${formatChangeShort(changes.m5)} · 1h ${formatChangeShort(changes.h1)} · 6h ${formatChangeShort(changes.h6)} · 24h ${formatChangeShort(change)}`
        : `24h  ${formatPercentChange(change)}`,
    ]),
    walletLines && tgSection('💼', 'Your wallet', walletLines),
    tgSection('⚙️', 'Trade setup', [
      nearViaRef ? 'Route  Ref Finance / Rhea DCL · paid in NEAR' : `Funding  ${chainEmoji(fundingChain.id)} ${escapeTelegramHtml(fundingChain.name)} (${fundingSymbol})${fundingChain.id !== chainId ? ' · cross-chain' : ''}`,
      `Slippage  ${slippage}% · every trade is quoted before you confirm`,
    ]),
    tgFootnote(`${escapeTelegramHtml(marketSource)} · ${telegramUtcTime()} · Scan only — no transaction was submitted.`),
  );

  // Persist alongside sending the card; the KV write starts first, so a tap on the new buttons sees this token.
  const persisted = env.DB || env.TELEGRAM_STATE
    ? writeTelegramProfile(chatId, {
      ...(profile ?? {}),
      lastTokenAddress: address,
      lastTokenChainId: chainId,
      lastTokenChainType: token.chainType === 'SVM' || token.chainType === 'NEAR' ? token.chainType : 'EVM',
      lastTokenSymbol: symbol,
      // An auto-picked pay-from chain is saved, so the Buy buttons on this card pay from it.
      ...(autoFunding !== undefined ? { fundingChainId: autoFunding } : {}),
    }, env).catch((error) => console.error('Telegram token profile persistence failed', error))
    : Promise.resolve();
  // Every opened token is tracked, so its balance shows in 💼 Portfolio without any indexer.
  const watched = chainId !== undefined
    ? trackTelegramToken(chatId, { chainId, address, symbol }, env).catch(() => undefined)
    : Promise.resolve();
  await Promise.all([persisted, watched, sendTelegramPanel(chatId, panelId, result, env, telegramTokenKeyboard(address, {
    chainId,
    fundingChainId: fundingChain.id,
    fundingSymbol,
    fundingChainName: fundingChain.name.replace(' One', '').replace(' Chain', ''),
    slippagePercent: slippage,
    payWith,
    chartUrl: tokenChartUrl({ ...token, address, chainId }),
  }))]);
}

const telegramProfileKey = (chatId: number) => `telegram:${chatId}`;

async function readTelegramProfile(chatId: number, env: Env): Promise<TelegramProfile | null> {
  const key = telegramProfileKey(chatId);
  if (env.TELEGRAM_STATE) {
    const cached = await env.TELEGRAM_STATE.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as TelegramProfile;
      } catch {
        // Remove malformed cache data by falling through to the durable store.
      }
    }
  }
  if (!env.DB) return env.TELEGRAM_STATE ? {} : null;
  type ProfileRow = {
    evm_address?: string;
    solana_address?: string;
    near_address?: string;
    funding_chain_id?: number;
    slippage_percent?: number;
    last_token_address?: string;
    last_token_chain_id?: number;
    last_token_chain_type?: 'EVM' | 'SVM' | 'NEAR';
    last_token_symbol?: string;
  };
  const profileColumns = `evm_address, solana_address, funding_chain_id, slippage_percent,
            last_token_address, last_token_chain_id, last_token_chain_type, last_token_symbol`;
  const row = await env.DB.prepare(`SELECT ${profileColumns}, near_address FROM telegram_profiles WHERE chat_id = ?1`)
    .bind(chatId).first<ProfileRow>()
    .catch((error: unknown) => {
      // Before migrations/0004_add_near_chain.sql there is no near_address column.
      if (!/near_address/.test(String(error))) throw error;
      return env.DB!.prepare(`SELECT ${profileColumns} FROM telegram_profiles WHERE chat_id = ?1`).bind(chatId).first<ProfileRow>();
    });
  if (!row) return {};
  const profile: TelegramProfile = {
    evmAddress: row.evm_address,
    solanaAddress: row.solana_address,
    nearAddress: row.near_address ?? undefined,
    fundingChainId: row.funding_chain_id,
    slippagePercent: row.slippage_percent,
    lastTokenAddress: row.last_token_address,
    lastTokenChainId: row.last_token_chain_id,
    lastTokenChainType: row.last_token_chain_type,
    lastTokenSymbol: row.last_token_symbol,
  };
  if (env.TELEGRAM_STATE) await env.TELEGRAM_STATE.put(key, JSON.stringify(profile), { expirationTtl: 86400 });
  return profile;
}

async function writeTelegramProfile(chatId: number, profile: TelegramProfile, env: Env): Promise<boolean> {
  if (!env.TELEGRAM_STATE && !env.DB) return false;
  // KV first: it is what readTelegramProfile consults, so the next tap sees the change immediately.
  const cached = env.TELEGRAM_STATE?.put(telegramProfileKey(chatId), JSON.stringify(profile), { expirationTtl: 86400 });
  const now = Date.now();
  if (env.DB) {
    const values = [
      chatId,
      profile.evmAddress ?? null,
      profile.solanaAddress ?? null,
      profile.fundingChainId ?? null,
      profile.slippagePercent ?? 1,
      profile.lastTokenAddress ?? null,
      profile.lastTokenChainId ?? null,
      profile.lastTokenChainType ?? null,
      profile.lastTokenSymbol ?? null,
      now,
    ];
    const upsert = (withNear: boolean) => env.DB!.prepare(
      `INSERT INTO telegram_profiles
        (chat_id, evm_address, solana_address, funding_chain_id, slippage_percent,
         last_token_address, last_token_chain_id, last_token_chain_type, last_token_symbol, created_at, updated_at${withNear ? ', near_address' : ''})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10${withNear ? ', ?11' : ''})
       ON CONFLICT(chat_id) DO UPDATE SET
         evm_address = excluded.evm_address,
         solana_address = excluded.solana_address,
         funding_chain_id = excluded.funding_chain_id,
         slippage_percent = excluded.slippage_percent,
         last_token_address = excluded.last_token_address,
         last_token_chain_id = excluded.last_token_chain_id,
         last_token_chain_type = excluded.last_token_chain_type,
         last_token_symbol = excluded.last_token_symbol,
         updated_at = excluded.updated_at${withNear ? ',\n         near_address = excluded.near_address' : ''}`,
    ).bind(...values, ...(withNear ? [profile.nearAddress ?? null] : [])).run();
    await upsert(true).catch((error: unknown) => {
      // Before migrations/0004_add_near_chain.sql there is no near_address column.
      if (!/near_address/.test(String(error))) throw error;
      return upsert(false);
    });
  }
  await cached;
  return true;
}

const TELEGRAM_PERSISTENCE_REQUIRED = tgMessage(
  tgTitle('🧩', 'Setup required'),
  'Saving wallets and settings needs the <code>TELEGRAM_STATE</code> KV or <code>DB</code> binding. Ask the bot owner to enable persistence.',
  tgFootnote('For a one-time read-only balance check, use /wallet &lt;public-address&gt;.'),
);

/** All of a user's wallets, oldest first (empty before migration 0003). */
async function listWalletAccounts(userId: string, env: Env): Promise<WalletAccountRow[]> {
  return loadWalletRows(userId, env) as Promise<WalletAccountRow[]>;
}

const WALLET_CHAIN_META: Record<WalletChain, { icon: string; name: string; code: 'e' | 's' | 'n' }> = {
  evm: { icon: '🔷', name: 'EVM', code: 'e' },
  solana: { icon: '◎', name: 'Solana', code: 's' },
  near: { icon: 'Ⓝ', name: 'NEAR', code: 'n' },
};
const WALLET_CHAIN_BY_CODE: Record<string, WalletChain> = { e: 'evm', s: 'solana', n: 'near' };

/** The wallet chain a chain id trades on (every EVM network shares one key). */
function walletChainOf(chainId: number | undefined): WalletChain {
  return chainId === NEAR_CHAIN_ID ? 'near' : chainId === 1151111081099710 ? 'solana' : 'evm';
}

/** The default wallet for a chain id (see defaultWalletFor). */
function walletForChain(accounts: WalletAccountRow[], chainId: number | undefined): WalletAccountRow | null {
  return defaultWalletFor(accounts, walletChainOf(chainId));
}

/** The trading addresses of one wallet row (null where it holds no key). */
function walletAddresses(row: WalletAccountRow): CustodialWallet {
  return { evmAddress: row.evm_address ?? null, solanaAddress: row.solana_address ?? null, nearAddress: row.near_address ?? null };
}

function shortWalletAddress(address: string): string {
  return address.length > 22 ? shortenTelegramAddress(address) : address;
}

/** "W1 · 🔷◎Ⓝ" — a wallet's name with the chains it holds. */
function walletButtonText(row: WalletAccountRow, defaults: Set<WalletChain>): string {
  const chains = walletChains(row).map((chain) => WALLET_CHAIN_META[chain].icon).join('');
  return `${defaults.size ? '✅ ' : ''}${row.label.slice(0, 14)} · ${chains}`;
}

/** Which chains each wallet is the default for. */
function walletDefaults(accounts: WalletAccountRow[]): Map<string, Set<WalletChain>> {
  const map = new Map<string, Set<WalletChain>>();
  for (const chain of WALLET_CHAINS) {
    const row = defaultWalletFor(accounts, chain);
    if (!row) continue;
    if (!map.has(row.id)) map.set(row.id, new Set());
    map.get(row.id)!.add(chain);
  }
  return map;
}

function telegramWalletActionKeyboard(): TelegramKeyboard {
  return {
    inline_keyboard: [
      [{ text: '🗂 Manage wallets', callback_data: 'wallet:list' }, { text: '🔄 Refresh', callback_data: 'wallet' }],
      [{ text: '📦 New wallet', callback_data: 'wallet:generate' }, { text: '📥 Import wallet', callback_data: 'wallet:import' }],
      [{ text: '📤 Multi-send', callback_data: 'ms:start' }, { text: '💼 Portfolio', callback_data: 'positions' }, { text: '◀️ Menu', callback_data: 'menu' }],
    ],
  };
}

/** 💳 Wallets: the default wallet of each chain with its balances. */
async function showTelegramWallet(chatId: number, env: Env, panelId?: number): Promise<void> {
  const userId = String(chatId);
  let wallet: CustodialWallet | null = null;
  try {
    wallet = await getCustodialWallet(userId, env);
  } catch {
    wallet = null;
  }
  if (!wallet) {
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('💳', 'No wallet yet', `Create a wallet or import one you own — up to ${MAX_WALLETS_PER_USER} wallets.`),
      tgCard([
        '📦 <b>Create</b> — a new encrypted EVM + Solana + NEAR wallet',
        '📥 <b>Import</b> — bring an EVM, Solana or NEAR key you already own',
      ]),
      tgFootnote('Never send a seed phrase to anyone, including this bot.'),
    ), env, telegramWalletSetupKeyboard());
    return;
  }
  // A generated wallet from before NEAR support gets its NEAR account on first view.
  const [nearAddress, accounts] = await Promise.all([
    wallet.nearAddress ? Promise.resolve(wallet.nearAddress) : ensureNearWallet(userId, env).catch(() => null),
    listWalletAccounts(userId, env),
  ]);
  const near = nearAddress ? defaultWalletFor(accounts, 'near') : null;
  await showTelegramWalletBalances(chatId, wallet.evmAddress ?? undefined, wallet.solanaAddress ?? undefined, env, {
    label: `Wallets · ${accounts.length || 1} of ${MAX_WALLETS_PER_USER}`,
    panelId,
    nearAddress: nearAddress ?? undefined,
    custodial: true,
    walletLabels: { evm: wallet.labels?.evm, solana: wallet.labels?.solana, near: near?.label ?? wallet.labels?.near },
  });
}

/** 🗂 Manage wallets: every wallet grouped by chain; ✅ marks each chain's default. */
async function showTelegramWalletList(chatId: number, env: Env, panelId?: number, notice?: string): Promise<void> {
  const accounts = await listWalletAccounts(String(chatId), env);
  if (!accounts.length) return showTelegramWallet(chatId, env, panelId);
  const defaults = walletDefaults(accounts);
  const sections = WALLET_CHAINS.map((chain) => {
    const holders = accounts.filter((row) => walletAddressOn(row, chain));
    const meta = WALLET_CHAIN_META[chain];
    if (!holders.length) return `${meta.icon} <b>${meta.name}</b>\n└ <i>none — 📥 import or 📦 create one</i>`;
    return `${meta.icon} <b>${meta.name}</b>\n${tgCard(holders.map((row) => {
      const isDefault = defaults.get(row.id)?.has(chain);
      return `${isDefault ? '✅' : '▫️'} <b>${escapeTelegramHtml(row.label)}</b>  <code>${escapeTelegramHtml(shortWalletAddress(walletAddressOn(row, chain)!))}</code>${row.source === 'imported' ? '  <i>imported</i>' : ''}`;
    }))}`;
  });
  const buttons = accounts.filter((row) => `wallet:v:${row.id}`.length <= 64)
    .map((row) => ({ text: walletButtonText(row, defaults.get(row.id) ?? new Set()), callback_data: `wallet:v:${row.id}` }));
  const rows: TelegramButton[][] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('🗂', 'Your wallets', `${accounts.length} of ${MAX_WALLETS_PER_USER} · ✅ = the wallet that trades on that chain`),
    notice ? `<b>${notice}</b>` : null,
    sections.join('\n\n'),
    tgFootnote('Tap a wallet to make it the default, rename, export or delete it. Imported keys stay their own wallet.'),
  ), env, {
    inline_keyboard: [
      ...rows,
      [{ text: '📦 New wallet', callback_data: 'wallet:generate' }, { text: '📥 Import', callback_data: 'wallet:import' }],
      [{ text: '💳 Balances', callback_data: 'wallet' }, { text: '◀️ Menu', callback_data: 'menu' }],
    ],
  });
}

/** One wallet: its addresses, which chains it is default for, and its actions. */
async function showTelegramWalletDetail(chatId: number, walletId: string, env: Env, panelId?: number, notice?: string): Promise<void> {
  const accounts = await listWalletAccounts(String(chatId), env);
  const row = accounts.find((item) => item.id === walletId);
  if (!row) return showTelegramWalletList(chatId, env, panelId, 'That wallet no longer exists.');
  const defaults = walletDefaults(accounts).get(row.id) ?? new Set<WalletChain>();
  const chains = walletChains(row);
  const lines = chains.map((chain) => {
    const meta = WALLET_CHAIN_META[chain];
    return `${meta.icon} <b>${meta.name}</b>${defaults.has(chain) ? '  ✅ default' : ''}\n<code>${escapeTelegramHtml(walletAddressOn(row, chain)!)}</code>`;
  });
  const missing = chains.filter((chain) => !defaults.has(chain));
  const useButtons: TelegramButton[] = missing.map((chain) => ({ text: `✅ Use for ${WALLET_CHAIN_META[chain].name}`, callback_data: `wallet:def:${WALLET_CHAIN_META[chain].code}:${row.id}` }));
  if (missing.length > 1) useButtons.unshift({ text: '✅ Use for all its chains', callback_data: `wallet:def:a:${row.id}` });
  const useRows: TelegramButton[][] = [];
  for (let index = 0; index < useButtons.length; index += 2) useRows.push(useButtons.slice(index, index + 2));
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('💳', `${escapeTelegramHtml(row.label)}`, `${row.source === 'imported' ? 'Imported' : 'Created in Hopr'} · ${chains.map((chain) => WALLET_CHAIN_META[chain].name).join(' + ')}`),
    notice ? `<b>${notice}</b>` : null,
    lines.join('\n\n'),
    tgFootnote(missing.length ? 'Make it the default to trade with it on that chain.' : 'This wallet trades on every chain it holds.'),
  ), env, {
    inline_keyboard: [
      ...useRows,
      [{ text: '✏️ Rename', callback_data: `wallet:ren:${row.id}` }, { text: '🔑 Export keys', callback_data: `wallet:exp:${row.id}` }],
      [{ text: '🗑 Delete', callback_data: `wallet:del:${row.id}` }, { text: '◀️ All wallets', callback_data: 'wallet:list' }],
    ],
  });
}

/** Make a wallet the default for one chain (or every chain it holds). */
async function setTelegramDefaultWallet(chatId: number, walletId: string, code: string, env: Env, panelId?: number): Promise<void> {
  const userId = String(chatId);
  const row = (await listWalletAccounts(userId, env)).find((item) => item.id === walletId);
  if (!row || !env.DB) return showTelegramWalletList(chatId, env, panelId, 'That wallet no longer exists.');
  const chains = code === 'a' ? walletChains(row) : [WALLET_CHAIN_BY_CODE[code]].filter((chain): chain is WalletChain => Boolean(chain));
  const moved = await setDefaultWallet(userId, walletId, chains, env);
  void getCustodialWallet(userId, env).then((wallet) => wallet && forgetPortfolio(wallet)).catch(() => undefined);
  const names = moved.map((chain) => WALLET_CHAIN_META[chain].name).join(', ');
  return showTelegramWalletDetail(chatId, walletId, env, panelId, moved.length ? `✅ ${escapeTelegramHtml(row.label)} now trades on ${names}.` : 'Nothing changed.');
}

/** Old "switch wallet" buttons: make that wallet the default for every chain it holds. */
async function useTelegramWallet(chatId: number, walletId: string, env: Env, panelId?: number): Promise<void> {
  return setTelegramDefaultWallet(chatId, walletId, 'a', env, panelId);
}

async function confirmTelegramWalletDelete(chatId: number, walletId: string, env: Env, panelId?: number): Promise<void> {
  const row = (await listWalletAccounts(String(chatId), env)).find((item) => item.id === walletId);
  if (!row) return showTelegramWalletList(chatId, env, panelId, 'That wallet no longer exists.');
  return sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('⚠️', `Delete ${escapeTelegramHtml(row.label)} permanently?`),
    tgCard([
      ...walletChains(row).map((chain) => `${WALLET_CHAIN_META[chain].icon} <code>${escapeTelegramHtml(shortWalletAddress(walletAddressOn(row, chain)!))}</code>`),
      'Only this wallet is deleted; your other wallets stay.',
      'Without a backup of its keys, the wallet and its funds <b>cannot be recovered</b>.',
    ]),
  ), env, {
    inline_keyboard: [
      [{ text: '🔑 Export keys first', callback_data: `wallet:exp:${row.id}` }],
      [{ text: '🗑 Delete permanently', callback_data: `wallet:delok:${row.id}` }],
      [{ text: '◀️ Keep it', callback_data: `wallet:v:${row.id}` }],
    ],
  });
}

/** Delete one wallet; chains it was default for fall back to another wallet holding them. */
async function deleteTelegramWallet(chatId: number, walletId: string, env: Env, panelId?: number): Promise<void> {
  const userId = String(chatId);
  if (!env.DB) return sendTelegramPanel(chatId, panelId, '🧩 Wallet storage is not configured.', env);
  const accounts = await listWalletAccounts(userId, env);
  const row = accounts.find((item) => item.id === walletId);
  if (!row) return showTelegramWalletList(chatId, env, panelId, 'That wallet no longer exists.');
  await env.DB.prepare(`DELETE FROM wallet_accounts WHERE id = ?1 AND user_id = ?2`).bind(row.id, userId).run();
  await env.DB.prepare(`DELETE FROM user_wallets WHERE user_id = ?1 AND (evm_address = ?2 OR solana_address = ?3)`).bind(userId, row.evm_address ?? '', row.solana_address ?? '').run().catch(() => undefined);
  const remaining = accounts.filter((item) => item.id !== row.id);
  if (row.is_active && remaining.length) {
    await env.DB.prepare(`UPDATE wallet_accounts SET is_active = 1 WHERE id = ?1`).bind(remaining[0].id).run();
  }
  return showTelegramWalletList(chatId, env, panelId, `🗑 ${escapeTelegramHtml(row.label)} deleted.`);
}

/** Old "delete wallet" button: the wallet that trades on EVM (else any). */
async function deleteActiveTelegramWallet(chatId: number, env: Env, panelId?: number): Promise<void> {
  const accounts = await listWalletAccounts(String(chatId), env);
  const row = defaultWalletFor(accounts, 'evm') ?? accounts[0];
  if (!row) return showTelegramWallet(chatId, env, panelId);
  return confirmTelegramWalletDelete(chatId, row.id, env, panelId);
}

/** NEAR block for the wallet card: spendable NEAR plus any NEP-141 tokens held. */
async function telegramNearBalanceBlock(nearAddress: string, env: Env, custodial: boolean, walletLabel?: string): Promise<string> {
  let detail: NearBalance | undefined;
  const reading = await tracked(env, `397:${nearAddress}`, async () => {
    detail = await getNearBalance(nearAddress, [], nearRpcOptions(env));
    return BigInt(detail.availableYocto);
  });
  const lines = [`${chainEmoji(NEAR_CHAIN_ID)} <b>NEAR</b>: ${telegramTrackedAmount(reading, 24, 'NEAR')}`];
  for (const token of detail?.tokens ?? []) lines.push(`🪙 <b>${escapeTelegramHtml(token.symbol)}</b>: ${escapeTelegramHtml(formatUnits(token.balance, token.decimals))}`);
  if (custodial && reading?.value === 0n && !reading.cachedAt) lines.push('<i>Fund this address with NEAR to cover trades and storage.</i>');
  return `Ⓝ <b>NEAR</b>${walletLabel ? ` · ✅ ${escapeTelegramHtml(walletLabel)}` : ''}\n<code>${escapeTelegramHtml(nearAddress)}</code>\n${tgCard(lines)}`;
}

function telegramTrackedAmount(reading: TrackedAmount | null, decimals: number, symbol: string): string {
  if (!reading) return '<i>Sync pending · tap Refresh to retry</i>';
  const age = reading.cachedAt ? ` <i>· last known ${new Date(reading.cachedAt).toISOString().slice(11, 16)} UTC</i>` : '';
  return `${escapeTelegramHtml(formatUnits(reading.value, decimals, decimals === 24 ? 4 : 5))} <code>${escapeTelegramHtml(symbol)}</code>${age}`;
}

async function showTelegramWalletBalances(
  chatId: number,
  evmAddress: string | undefined,
  solanaAddress: string | undefined,
  env: Env,
  options: { label?: string; panelId?: number; nearAddress?: string; custodial?: boolean; walletLabels?: { evm?: string; solana?: string; near?: string } } = {},
): Promise<void> {
  const blocks: string[] = [tgTitle('💳', options.label ?? 'Wallet', options.walletLabels ? 'The ✅ default wallet of each chain · 🗂 Manage wallets to change' : 'Native balances across supported chains')];
  const tag = (label: string | undefined) => (label ? ` · ✅ ${escapeTelegramHtml(label)}` : '');
  // Every chain (and the price list) is read at once: the card waits for the slowest RPC, not their sum.
  const pricesPromise = nativePricesUsd().catch(() => ({} as Record<string, number>));
  const evmChains = TELEGRAM_CHAINS.filter((chain) => chain.id !== 1151111081099710 && chain.id !== NEAR_CHAIN_ID);
  const [evmBlock, solanaBlock, nearBlock] = await Promise.all([
    evmAddress ? (async () => {
      const [results, prices] = await Promise.all([
        Promise.all(evmChains.map(async (chain) => ({
          chain,
          reading: await tracked(env, `${chain.id}:${evmAddress.toLowerCase()}`, () => readNativeBalance(chain.id, evmAddress)),
        }))),
        pricesPromise,
      ]);
      const lines = results.map(({ chain, reading }) => {
        const price = prices[chain.symbol];
        const usd = reading && price ? ` · ≈$${(Number(reading.value) / 1e18 * price).toFixed(2)}` : '';
        return `${chainEmoji(chain.id)} <b>${escapeTelegramHtml(chain.name)}</b>: ${telegramTrackedAmount(reading, 18, chain.symbol)}${usd}`;
      });
      return `🔷 <b>EVM</b>${tag(options.walletLabels?.evm)}\n<code>${escapeTelegramHtml(evmAddress)}</code>\n${tgCard(lines)}`;
    })() : null,
    solanaAddress ? (async () => {
      const reading = await tracked(env, `1151111081099710:${solanaAddress}`, () => readNativeBalance(1151111081099710, solanaAddress));
      const line = `${chainEmoji(1151111081099710)} <b>Solana</b>: ${telegramTrackedAmount(reading, 9, 'SOL')}`;
      return `◎ <b>Solana</b>${tag(options.walletLabels?.solana)}\n<code>${escapeTelegramHtml(solanaAddress)}</code>\n${tgCard([line])}`;
    })() : null,
    options.nearAddress ? telegramNearBalanceBlock(options.nearAddress, env, Boolean(options.custodial), options.walletLabels?.near) : null,
  ]);
  for (const block of [evmBlock, solanaBlock, nearBlock]) if (block) blocks.push(block);

  blocks.push(tgFootnote(`Checked ${telegramUtcTime()} · tap an address to copy it · cached balances carry their last-read time`));
  await sendTelegramPanel(chatId, options.panelId, tgMessage(...blocks), env, telegramWalletActionKeyboard());
}

function telegramSettingsKeyboard(profile: TelegramProfile): TelegramKeyboard {
  const selectedChainId = profile.fundingChainId ?? TELEGRAM_CHAINS[0].id;
  const selectedSlippage = profile.slippagePercent ?? 1;
  const chainRows = TELEGRAM_CHAINS.reduce<TelegramButton[][]>((rows, chain, index) => {
    const row = Math.floor(index / 2);
    rows[row] ??= [];
    rows[row].push({
      text: `${chain.id === selectedChainId ? '✅' : chainEmoji(chain.id)} ${chain.name}`,
      callback_data: `settings:chain:${chain.id}`,
    });
    return rows;
  }, []);
  return {
    inline_keyboard: [
      ...chainRows,
      TELEGRAM_SLIPPAGE_OPTIONS.map((slippage) => ({
        text: `${slippage === selectedSlippage ? '✅ ' : ''}${slippage}%`,
        callback_data: `settings:slippage:${slippage}`,
      })),
      [{ text: '💳 Wallet', callback_data: 'wallet' }, { text: '◀️ Menu', callback_data: 'menu' }],
    ],
  };
}

function telegramWalletSetupKeyboard(): TelegramKeyboard {
  return {
    inline_keyboard: [
      [{ text: '📦 Create wallet', callback_data: 'wallet:generate' }, { text: '📥 Import wallet', callback_data: 'wallet:import' }],
      [{ text: '❓ Help', callback_data: 'help' }, { text: '◀️ Menu', callback_data: 'menu' }],
    ],
  };
}

function telegramExportWarningKeyboard(): TelegramKeyboard {
  return {
    inline_keyboard: [
      [{ text: '⚠️ Reveal private keys', callback_data: 'wallet:export' }],
      [{ text: '✖️ Cancel', callback_data: 'dismiss' }],
    ],
  };
}

/**
 * Decrypts and sends the user's raw private keys, once, as a DM. Telegram
 * chat history is not a safe place to store a key long-term, so deletion is
 * attempted ~60 seconds after sending — the caller should still tell the user
 * to move funds to self-custody if they export.
 */
async function showTelegramWalletExport(chatId: number, env: Env, walletId?: string): Promise<void> {
  const userId = String(chatId);
  if (!env.DB || !env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, '🧩 Exporting keys requires the bot owner to configure <code>DB</code> and <code>ENCRYPTION_KEY</code>.', env, telegramActionKeyboard());
    return;
  }
  // The chosen wallet, else the one that trades on EVM; the legacy table only before migration 0003.
  const accounts = await listWalletAccounts(userId, env);
  const active = (walletId ? accounts.find((account) => account.id === walletId) : null) ?? defaultWalletFor(accounts, 'evm') ?? accounts[0];
  const row = active
    ? { evm_address: active.evm_address!, evm_encrypted_key: active.evm_encrypted_key!, solana_address: active.solana_address!, solana_encrypted_key: active.solana_encrypted_key! }
    : await env.DB.prepare(
      `SELECT evm_address, evm_encrypted_key, solana_address, solana_encrypted_key FROM user_wallets WHERE user_id = ?1`
    )
      .bind(userId)
      .first<{ evm_address: string; evm_encrypted_key: string; solana_address: string; solana_encrypted_key: string }>();
  if (!row) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('💳', 'No trading wallet yet'), 'Create a trading wallet first, then you can export its keys.'), env, telegramWalletSetupKeyboard());
    return;
  }
  const decryptIfPresent = (packed: string | null | undefined) => packed ? decryptPrivateKey(unpackEncryptedSecret(packed), env.ENCRYPTION_KEY!) : Promise.resolve('');
  const evmKey = await decryptIfPresent(row.evm_encrypted_key);
  const solKey = await decryptIfPresent(row.solana_encrypted_key);
  const near = active
    ? { near_address: active.near_address ?? null, near_encrypted_key: active.near_encrypted_key ?? null }
    : await env.DB.prepare(`SELECT near_address, near_encrypted_key FROM user_wallets WHERE user_id = ?1`)
      .bind(userId).first<{ near_address: string | null; near_encrypted_key: string | null }>()
      .catch(() => null); // no NEAR columns before migrations/0004_add_near_chain.sql
  const nearKey = await decryptIfPresent(near?.near_encrypted_key);
  const text = tgMessage(
    tgTitle('🔑', active ? `Private keys · ${escapeTelegramHtml(active.label)}` : 'Private keys', 'Anyone with these keys has full control of this wallet.'),
    evmKey && `<b>EVM</b> · ${escapeTelegramHtml(shortenTelegramAddress(row.evm_address))}\n<code>${escapeTelegramHtml(evmKey)}</code>`,
    solKey && `<b>Solana</b> · ${escapeTelegramHtml(shortenTelegramAddress(row.solana_address))}\n<code>${escapeTelegramHtml(solKey)}</code>`,
    nearKey && near?.near_address && `<b>NEAR</b> · ${escapeTelegramHtml(shortenTelegramAddress(near.near_address))}\n<code>${escapeTelegramHtml(nearKey)}</code>`,
    tgFootnote('⏱ This message self-deletes in ~60s — save the keys somewhere safe now and never share them.'),
  );
  const sent = await telegramApiCall('sendMessage', env, { chat_id: chatId, text, parse_mode: 'HTML' });
  const messageId = (sent.result as { message_id?: number } | undefined)?.message_id;
  if (messageId) {
    // Best-effort auto-delete; if it fails the user still saw the warning above.
    setTimeout(() => {
      telegramApiCall('deleteMessage', env, { chat_id: chatId, message_id: messageId }).catch(() => {});
    }, 60_000);
  }
}

/* ------------------------------------------------------------------------ *
 * Wallet import. 📥 Import → choose EVM / Solana / NEAR → paste the key.
 * The key message is deleted right away. An imported key becomes a wallet of
 * its own chain only (never mixed with other keys) and that chain's default;
 * a key the user already has just becomes the default again.
 * ------------------------------------------------------------------------ */

type ImportChain = 'evm' | 'solana' | 'near';
const IMPORT_CHAIN_LABEL: Record<ImportChain, string> = { evm: 'EVM', solana: 'Solana', near: 'NEAR' };

/** Prefix of the force-reply prompt asking for a key; the chain name follows it. */
const TELEGRAM_IMPORT_PROMPT = '🔑 Import — reply with your';

type ImportPlacement = { walletLabel: string; placement: 'existing' | 'new'; address: string };
type ImportOutcome = (ImportPlacement & { implicitOnly?: boolean }) | { choose: string[] } | { error: string };

function importChainOf(value: string | undefined): ImportChain | null {
  const chain = value?.toLowerCase();
  return chain === 'evm' || chain === 'eth' ? 'evm' : chain === 'solana' || chain === 'sol' ? 'solana' : chain === 'near' ? 'near' : null;
}

async function showTelegramImportPicker(chatId: number, env: Env, panelId?: number): Promise<void> {
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('📥', 'Import a wallet', 'Choose what to import'),
    tgCard([
      '🔷 <b>EVM</b> — one key for Base, Arbitrum, BNB, Robinhood &amp; Arc',
      '◎ <b>Solana</b> — your base58 secret key',
      'Ⓝ <b>NEAR</b> — your ed25519 key; the account (e.g. alice.near) is found for you',
    ]),
    tgFootnote(`🔐 Keys are stored encrypted, and your message with the key is deleted right after. Up to ${MAX_WALLETS_PER_USER} wallets.`),
  ), env, {
    inline_keyboard: [
      [{ text: '🔷 EVM', callback_data: 'import:evm' }, { text: '◎ Solana', callback_data: 'import:solana' }, { text: 'Ⓝ NEAR', callback_data: 'import:near' }],
      [{ text: '◀️ Wallets', callback_data: 'wallet' }],
    ],
  });
}

async function promptTelegramImport(chatId: number, chain: ImportChain, env: Env): Promise<void> {
  await setPendingPrompt(chatId, { kind: 'import', chain }, env);
  const extra = chain === 'near' ? ' — add the account name after it if you know it (e.g. <code>ed25519:… alice.near</code>)' : '';
  await sendTelegramMessage(chatId, `${TELEGRAM_IMPORT_PROMPT} ${IMPORT_CHAIN_LABEL[chain]} private key${extra}. Your message is deleted right after.`, env, {
    force_reply: true,
    input_field_placeholder: chain === 'evm' ? '0x… private key' : chain === 'solana' ? 'base58 secret key' : 'ed25519:… [alice.near]',
  });
}

/** The chain a key prompt asked for, read back from the prompt the user replied to. */
function importChainFromPrompt(prompt: string): ImportChain | null {
  return importChainOf(prompt.slice(TELEGRAM_IMPORT_PROMPT.length).trim().split(/\s+/)[0]);
}

async function deleteTelegramMessage(chatId: number, messageId: number | undefined, env: Env): Promise<void> {
  // Bots may delete incoming messages in private chats; a failure just leaves the message.
  if (messageId) await telegramApiRequest('deleteMessage', env, { chat_id: chatId, message_id: messageId });
}

/** A pasted key: remove the message holding it first, then import. */
async function importFromPrompt(chatId: number, chain: ImportChain, text: string, env: Env, messageId?: number): Promise<void> {
  await deleteTelegramMessage(chatId, messageId, env);
  await handleTelegramImportKey(chatId, [chain, ...text.trim().split(/\s+/)], env);
}

/** /importkey <evm|solana|near> <key> [account.near], or a key pasted after choosing a chain. */
async function handleTelegramImportKey(chatId: number, args: string[], env: Env): Promise<void> {
  if (!env.DB || !env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, '🧩 Importing a key requires the bot owner to configure <code>DB</code> and <code>ENCRYPTION_KEY</code>.', env);
    return;
  }
  const chain = importChainOf(args[0]);
  const rawKey = args[1] ?? '';
  if (!chain || !rawKey) {
    await showTelegramImportPicker(chatId, env);
    return;
  }
  const userId = String(chatId);
  let evmOrSolana: { address: string; privateKey: string } | null = null;
  let near: NearKeyPair | null = null;
  try {
    if (chain === 'near') near = importNearKey(rawKey);
    else evmOrSolana = chain === 'evm' ? importEvmKey(rawKey) : importSolanaKey(rawKey);
  } catch {
    await sendTelegramMessage(chatId, tgMessage(
      tgTitle('⚠️', `That is not a valid ${IMPORT_CHAIN_LABEL[chain]} private key`),
      chain === 'evm' ? 'Expected 64 hex characters, with or without <code>0x</code>.'
        : chain === 'solana' ? 'Expected the base58 secret key (about 88 characters), as exported by Phantom or Solflare.'
          : 'Expected <code>ed25519:…</code>, as exported by your NEAR wallet.',
    ), env, { inline_keyboard: [[{ text: '🔁 Try again', callback_data: `import:${chain}` }, { text: '📥 Import', callback_data: 'wallet:import' }]] });
    return;
  }

  let outcome: ImportOutcome;
  try {
    outcome = near
      ? await importTelegramNearKey(userId, near, args[2]?.toLowerCase(), env)
      : await placeImportedKey(userId, chain, evmOrSolana!.address, evmOrSolana!.privateKey, env);
  } catch {
    outcome = { error: 'The check could not finish (network or storage busy). Nothing was imported — try again in a minute.' };
  }

  if ('choose' in outcome && near) {
    await offerTelegramNearAccounts(chatId, outcome.choose, near, env);
    return;
  }
  await reportTelegramImport(chatId, chain, outcome, env);
}

/**
 * A NEAR key does not encode its account: named accounts (alice.near) are
 * found in the key index and confirmed on-chain, so importing a named
 * account's key imports that account — never the key's unused implicit one.
 */
async function importTelegramNearKey(userId: string, pair: NearKeyPair, namedAccount: string | undefined, env: Env): Promise<ImportOutcome> {
  const rpc = nearRpcOptions(env);
  let accountId: string;
  if (namedAccount) {
    if (!isValidNearAccountId(namedAccount)) return { error: `“${namedAccount}” is not a valid NEAR account name.` };
    if (namedAccount !== pair.accountId && !await verifyFullAccessKey(namedAccount, pair.publicKey, rpc)) {
      return { error: `That key is not a full-access key of ${namedAccount}.` };
    }
    accountId = namedAccount;
  } else {
    const accounts = await findNearAccountsForKey(pair.publicKey, pair.accountId, rpc);
    if (accounts.length > 1) return { choose: accounts };
    accountId = accounts[0] ?? pair.accountId;
  }
  const placed = await placeImportedKey(userId, 'near', accountId, pair.privateKey, env);
  return 'error' in placed ? placed : { ...placed, implicitOnly: accountId === pair.accountId };
}

const NEAR_PICK_TTL_SECONDS = 300;
const nearPickKey = (chatId: number) => `nearpick:v1:${chatId}`;

/** The key controls several NEAR accounts: let the user choose (the key waits encrypted, briefly). */
async function offerTelegramNearAccounts(chatId: number, accounts: string[], pair: NearKeyPair, env: Env): Promise<void> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  const listing = tgCard(accounts.map((account) => `<code>${escapeTelegramHtml(account)}</code>`));
  if (!store) {
    await sendTelegramMessage(chatId, tgMessage(
      tgTitle('Ⓝ', 'This key controls several NEAR accounts'),
      listing,
      'Import one by sending <code>/importkey near &lt;key&gt; &lt;account&gt;</code>.',
    ), env);
    return;
  }
  const key = packEncryptedSecret(await encryptPrivateKey(pair.privateKey, env.ENCRYPTION_KEY!));
  await store.put(nearPickKey(chatId), JSON.stringify({ accounts, key }), { expirationTtl: NEAR_PICK_TTL_SECONDS });
  await sendTelegramMessage(chatId, tgMessage(
    tgTitle('Ⓝ', 'Choose the NEAR account to import', 'This key controls more than one account.'),
    listing,
    tgFootnote('This choice expires in 5 minutes.'),
  ), env, {
    inline_keyboard: [
      ...accounts.map((account, index) => [{ text: account.length > 40 ? `${account.slice(0, 18)}…${account.slice(-18)}` : account, callback_data: `import:near:pick:${index}` }]),
      [{ text: '✖️ Cancel', callback_data: 'wallet' }],
    ],
  });
}

async function pickTelegramNearAccount(chatId: number, index: number, env: Env, panelId?: number): Promise<void> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  const raw = await store?.get(nearPickKey(chatId)).catch(() => null);
  let pending: { accounts?: string[]; key?: string } | null = null;
  try {
    pending = raw ? JSON.parse(raw) : null;
  } catch {
    pending = null;
  }
  const accountId = pending?.accounts?.[index];
  if (!pending?.key || !accountId || !env.DB || !env.ENCRYPTION_KEY) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⌛', 'That choice expired'), 'Import the key again from 📥 Import.'), env, { inline_keyboard: [[{ text: '📥 Import', callback_data: 'wallet:import' }]] });
    return;
  }
  await store!.delete(nearPickKey(chatId)).catch(() => undefined);
  let outcome: ImportOutcome;
  try {
    const pair = importNearKey(await decryptPrivateKey(unpackEncryptedSecret(pending.key), env.ENCRYPTION_KEY));
    outcome = await importTelegramNearKey(String(chatId), pair, accountId, env);
  } catch {
    outcome = { error: 'The check could not finish (network or storage busy). Nothing was imported — try again in a minute.' };
  }
  await reportTelegramImport(chatId, 'near', outcome, env, panelId);
}

/** An imported key is a wallet of its own chain (never mixed into another wallet) and becomes that chain's default. */
async function placeImportedKey(userId: string, chain: ImportChain, address: string, privateKey: string, env: Env): Promise<ImportPlacement | { error: string }> {
  const rows = await listWalletAccounts(userId, env);
  // Already one of the user's wallets: make it the default instead of adding a duplicate.
  const owned = walletWithAddress(rows, chain, address);
  if (owned) {
    await setDefaultWallet(userId, owned.id, [chain], env);
    return { walletLabel: owned.label, placement: 'existing', address };
  }
  try {
    const row = await storeWalletAccount(userId, {
      evmAddress: chain === 'evm' ? address : null,
      evmPrivateKey: chain === 'evm' ? privateKey : null,
      solanaAddress: chain === 'solana' ? address : null,
      solanaPrivateKey: chain === 'solana' ? privateKey : null,
      nearAddress: chain === 'near' ? address : null,
      nearPrivateKey: chain === 'near' ? privateKey : null,
    }, '', 'imported', env, [chain]);
    return { walletLabel: row.label, placement: 'new', address };
  } catch (error) {
    if (error instanceof WalletLimitError) return { error: error.message };
    throw error;
  }
}

async function reportTelegramImport(chatId: number, chain: ImportChain, outcome: ImportOutcome, env: Env, panelId?: number): Promise<void> {
  const label = IMPORT_CHAIN_LABEL[chain];
  if ('error' in outcome || 'choose' in outcome) {
    const reason = 'error' in outcome ? outcome.error : 'Choose the account to import.';
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⚠️', `${label} key not imported`), escapeTelegramHtml(reason)), env, {
      inline_keyboard: [[{ text: '🔁 Try again', callback_data: `import:${chain}` }, { text: '💳 Wallets', callback_data: 'wallet' }]],
    });
    return;
  }
  const wallet = escapeTelegramHtml(outcome.walletLabel);
  const title = outcome.placement === 'existing' ? `Already yours — ${wallet} is your ${label} wallet` : `${label} key imported as ${wallet}`;
  const notes = [
    `${wallet} now trades on ${label}. Your other chains keep their wallets.`,
    outcome.implicitOnly ? 'No named account (like alice.near) uses this key, so its own account was imported. If your wallet has a name, import again with the name after the key.' : null,
  ].filter(Boolean) as string[];
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('✅', title),
    `<code>${escapeTelegramHtml(outcome.address)}</code>`,
    tgCard(notes),
  ), env, telegramWalletActionKeyboard());
}

/* ---- Prompts that also accept a plain (non-reply) answer ---------------- */

type PendingPrompt = { kind: 'track' } | { kind: 'import'; chain: ImportChain };
/** A prompt waits this long for its answer (KV's minimum TTL is 60s). */
const PROMPT_TTL_SECONDS = 120;
const promptKey = (chatId: number) => `prompt:v1:${chatId}`;

/** Remember what the bot just asked for, so the next plain message answers it even without "Reply". */
async function setPendingPrompt(chatId: number, prompt: PendingPrompt, env: Env): Promise<void> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  await store?.put(promptKey(chatId), JSON.stringify({ ...prompt, at: Date.now() }), { expirationTtl: PROMPT_TTL_SECONDS }).catch(() => undefined);
}

async function clearPendingPrompt(chatId: number, env: Env): Promise<void> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  await store?.delete(promptKey(chatId)).catch(() => undefined);
}

/** The open prompt, if any; reading it closes it. */
async function takePendingPrompt(chatId: number, env: Env): Promise<PendingPrompt | null> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  if (!store) return null;
  const raw = await store.get(promptKey(chatId)).catch(() => null);
  if (!raw) return null;
  await store.delete(promptKey(chatId)).catch(() => undefined);
  try {
    const prompt = JSON.parse(raw) as { kind?: string; chain?: string; at?: number };
    if (!prompt.at || Date.now() - prompt.at > PROMPT_TTL_SECONDS * 1000) return null;
    if (prompt.kind === 'track') return { kind: 'track' };
    const chain = importChainOf(prompt.chain);
    return prompt.kind === 'import' && chain ? { kind: 'import', chain } : null;
  } catch {
    return null;
  }
}

async function showTelegramWalletGenerate(chatId: number, env: Env): Promise<void> {
  const userId = String(chatId);
  if (!env.DB) {
    await sendTelegramMessage(chatId, '🧩 Creating a trading wallet requires the bot owner to configure the D1 database binding.', env, telegramActionKeyboard());
    return;
  }
  if (!env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, '🧩 Creating a trading wallet requires the bot owner to set the <code>ENCRYPTION_KEY</code> secret.', env, telegramActionKeyboard());
    return;
  }
  const existing = await getCustodialWallet(userId, env);
  let wallet: CustodialWallet;
  let label: string | null = null;
  if (!existing) {
    wallet = await createCustodialWallet(userId, env);
  } else {
    // Another wallet (up to the cap); it becomes the active one.
    try {
      const near = generateNearWallet();
      const row = await storeWalletAccount(userId, { ...generateDualWallet(), nearAddress: near.address, nearPrivateKey: near.privateKey }, '', 'generated', env, WALLET_CHAINS);
      wallet = walletAddresses(row);
      label = row.label;
    } catch (error) {
      const message = error instanceof WalletLimitError ? error.message : 'Wallet storage is unavailable. Apply migrations/0003_multi_wallets.sql, then try again.';
      await sendTelegramMessage(chatId, tgMessage(tgTitle('💳', 'No new wallet created'), escapeTelegramHtml(message)), env, telegramWalletActionKeyboard());
      return;
    }
  }
  const nearAddress = wallet.nearAddress ?? await ensureNearWallet(userId, env).catch(() => null);
  await sendTelegramMessage(
    chatId,
    tgMessage(
      tgTitle('✦', label ? `Wallet ${escapeTelegramHtml(label)} created` : 'Your Hopr wallet is ready', label ? 'It now trades on every chain · change defaults any time in 🗂 Manage wallets.' : 'Welcome to your private cross-chain command center.'),
      tgCard([
        ...(wallet.evmAddress ? [`<b>EVM</b>  <code>${escapeTelegramHtml(wallet.evmAddress)}</code>`] : []),
        ...(wallet.solanaAddress ? [`<b>Solana</b>  <code>${escapeTelegramHtml(wallet.solanaAddress)}</code>`] : []),
        ...(nearAddress ? [`<b>NEAR</b>  <code>${escapeTelegramHtml(nearAddress)}</code>`] : []),
      ]),
      !existing && `<b>Next step</b>\nFund any address, then paste a token address to trade.`,
      tgCard([
        '🔐 Encrypted key custody',
        '⚡ Cross-chain ready',
        '🛡 Confirmation required before every trade',
      ]),
    ),
    env,
    telegramActionKeyboard(),
  );
}

async function showTelegramSettings(chatId: number, env: Env, panelId?: number): Promise<void> {
  const profile = await readTelegramProfile(chatId, env);
  if (!profile) {
    await sendTelegramPanel(chatId, panelId, TELEGRAM_PERSISTENCE_REQUIRED, env);
    return;
  }
  const chain = TELEGRAM_CHAINS.find((item) => item.id === profile.fundingChainId) ?? TELEGRAM_CHAINS[0];
  const slippage = profile.slippagePercent ?? 1;
  await sendTelegramPanel(
    chatId,
    panelId,
    tgMessage(
      tgTitle('⚙️', 'Your Telegram trade preferences'),
      tgCard([
        `${chainEmoji(chain.id)} Funding chain: <b>${escapeTelegramHtml(chain.name)}</b>`,
        `🎯 Slippage preference: <b>${slippage}%</b>`,
      ]),
      tgFootnote('Tap to change. Quotes still require an explicit confirmation before submission.'),
    ),
    env,
    telegramSettingsKeyboard(profile),
  );
}

function telegramQuoteMessage(side: 'BUY' | 'SELL', lines: string[]): string {
  return tgMessage(
    tgTitle('🧾', `Quote ready · ${side}`),
    tgCard(lines),
    tgFootnote('⏳ Prices move fast. Tap Confirm and submit to sign this quote, or Cancel to discard it.'),
  );
}

async function handleTelegramTradeAction(chatId: number, data: string, env: Env, panelId?: number, target?: TelegramProfile): Promise<void> {
  if (data === 'trade:custom') {
    const profile = await readTelegramProfile(chatId, env).catch(() => null);
    if (!profile?.lastTokenAddress) {
      await sendTelegramMessage(chatId, tgMessage(tgTitle('🔎', 'Pick a token first'), 'Paste a token address, then tap ✏️ Buy X on its panel.'), env, telegramActionKeyboard());
      return;
    }
    const symbol = profile.lastTokenChainId === NEAR_CHAIN_ID
      ? 'NEAR'
      : TELEGRAM_CHAINS.find((chain) => chain.id === (profile.fundingChainId ?? 8453))?.symbol ?? 'native';
    // Force-reply: the answer comes back as a reply to this exact prompt.
    await sendTelegramMessage(chatId, `${TELEGRAM_BUY_X_PROMPT} ${symbol} to spend on ${profile.lastTokenSymbol ?? 'this token'}.`, env, {
      force_reply: true,
      input_field_placeholder: `Amount in ${symbol}, e.g. 1`,
    }, null);
    return;
  }
  const continueMatch = data.match(/^trade:cont:([0-9a-f]{8})$/);
  if (continueMatch) {
    await continueTelegramNearBuy(chatId, continueMatch[1], env, panelId);
    return;
  }
  if (data === 'trade:cancel') {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('✖️', 'Trade cancelled'), 'No transaction was signed or submitted.'), env);
    return;
  }
  const confirmMatch = data.match(/^trade:confirm:([0-9a-f-]+)$/);
  if (confirmMatch) {
    // Lock the quote first: removing its buttons makes a double submit impossible.
    if (panelId) await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⏳', 'Submitting trade…'), 'Signing and broadcasting your transaction.'), env);
    try {
      // Signed transactions go through a keyed, health-checked RPC; Solana is also rebroadcast to backups.
      const rpcUrls = {
        evm: (chainId: number) => transactionRpc(chainId),
        solana: () => transactionRpc(1151111081099710),
        solanaBroadcast: solanaBroadcastRpcs,
      };
      const result = await confirmTrade(String(chatId), confirmMatch[1], rpcUrls, env);
      void getCustodialWallet(String(chatId), env).then((wallet) => wallet && forgetPortfolio(wallet)).catch(() => undefined);
      await recordTelegramReferral(String(chatId), result, env);
      if (result.venue === 'intents' || result.continuationId) {
        const explorer = TELEGRAM_EXPLORERS[result.fromChainId ?? NEAR_CHAIN_ID];
        await sendTelegramPanel(chatId, panelId, telegramIntentsSentMessage(result), env, {
          inline_keyboard: [
            ...(result.continuationId ? [[{ text: '▶️ Continue — next step', callback_data: `trade:cont:${result.continuationId}` }]] : []),
            ...(explorer ? [[{ text: '🔎 View transaction', url: `${explorer}${encodeURIComponent(result.txHash)}` }]] : []),
            [{ text: '💼 Portfolio', callback_data: 'positions:fresh' }, { text: '◀️ Menu', callback_data: 'menu' }],
          ],
        });
        return;
      }
      const profile = result.venue === 'ref' ? null : await readTelegramProfile(chatId, env).catch(() => null);
      const explorer = result.venue === 'ref'
        ? TELEGRAM_EXPLORERS[NEAR_CHAIN_ID]
        : profile?.lastTokenChainId !== undefined ? TELEGRAM_EXPLORERS[profile.lastTokenChainId] : undefined;
      await sendTelegramPanel(
        chatId,
        panelId,
        tgMessage(
          tgTitle('✅', result.venue === 'ref' && result.confirmed ? 'Swap executed' : 'Trade submitted successfully'),
          tgCard([`Transaction: <code>${escapeTelegramHtml(result.txHash)}</code>`]),
          tgFootnote(result.venue === 'ref' && result.confirmed
            ? 'Executed on NEAR via Ref Finance. Tokens are already in your wallet.'
            : 'The transaction is now on-chain; final settlement may take additional time.'),
        ),
        env,
        {
          inline_keyboard: [
            ...(explorer ? [[{ text: '🔎 View transaction', url: `${explorer}${encodeURIComponent(result.txHash)}` }]] : []),
            [{ text: '💼 Portfolio', callback_data: 'positions:fresh' }, { text: '◀️ Menu', callback_data: 'menu' }],
          ],
        },
      );
    } catch (error) {
      await sendTelegramPanel(
        chatId,
        panelId,
        tgMessage(tgTitle('⚠️', 'Trade was not submitted'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')),
        env,
        telegramActionKeyboard(),
      );
    }
    return;
  }
  const userId = String(chatId);
  // Independent lookups: read the token context and the wallet together.
  const [profile, wallet] = await Promise.all([
    target ?? readTelegramProfile(chatId, env),
    getCustodialWallet(userId, env),
  ]);
  if (!profile?.lastTokenAddress || !profile.lastTokenChainId) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('🔎', 'Pick a token first'), 'Open a token lookup first (paste a contract address), then use the buy/sell buttons on that result.'), env, telegramActionKeyboard());
    return;
  }

  if (!wallet) {
    await sendTelegramMessage(
      chatId,
      tgMessage(
        tgTitle('💳', 'Trading needs a Hopr wallet'),
        `Hopr holds the keys and signs only after you confirm a quote. Create or import one (up to ${MAX_WALLETS_PER_USER}).`,
      ),
      env,
      telegramWalletSetupKeyboard(),
    );
    return;
  }
  if (!env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, '🧩 Trading is not available: the bot owner has not set <code>ENCRYPTION_KEY</code>.', env, telegramActionKeyboard());
    return;
  }

  if (profile.lastTokenChainId === NEAR_CHAIN_ID) {
    await handleTelegramNearTrade(chatId, data, profile, env);
    return;
  }

  // Buttons send 0.1 / 0.5 / 1.0; ✏️ Buy X replies send any amount.
  const buyMatch = data.match(/^trade:buy:(\d{1,12}(?:\.\d{1,18})?)$/);
  const sellMatch = data.match(/^trade:sell:(25|50|100)$/);
  if (!buyMatch && !sellMatch) return;

  const targetChain = getChainById(profile.lastTokenChainId);
  if (!targetChain) {
    await sendTelegramMessage(chatId, '⛓ That chain is not supported for trading yet.', env, telegramActionKeyboard());
    return;
  }
  const slippagePercent = profile.slippagePercent ?? 1;
  const slippage = slippagePercent / 100;
  const tokenSymbol = escapeTelegramHtml(profile.lastTokenSymbol ?? 'token');

  try {
    if (buyMatch) {
      const amountDecimal = buyMatch[1];
      const fundingChainId = profile.fundingChainId ?? 8453;
      if (fundingChainId === NEAR_CHAIN_ID) {
        // Pay with NEAR: NEAR Intents to the token (or the chain's coin), then a LI.FI swap as step 2.
        const trade = await prepareNearIntentsBuy({
          userId,
          wallet,
          amountYocto: parseUnits(amountDecimal, NEAR_DECIMALS).toString(),
          targetChainId: targetChain.id,
          targetTokenAddress: profile.lastTokenAddress,
          targetSymbol: profile.lastTokenSymbol ?? 'token',
          slippage,
        }, env);
        const intents = trade.intents!;
        const out = `${formatUnits(intents.expectedOut, intents.outDecimals, 6)} ${escapeTelegramHtml(intents.outSymbol)}`;
        await sendTelegramMessage(
          chatId,
          telegramQuoteMessage('BUY', [
            `💸 <b>You pay</b>  ${amountDecimal} NEAR`,
            ...(intents.continuation
              ? [
                `🌉 <b>Step 1</b>  NEAR → ≈ ${out} on ${escapeTelegramHtml(getChainById(trade.toChainId)?.name ?? targetChain.name)} · NEAR Intents`,
                `🎯 <b>Step 2</b>  ${escapeTelegramHtml(intents.outSymbol)} → ${tokenSymbol}${trade.toChainId !== targetChain.id ? ` on ${escapeTelegramHtml(targetChain.name)}` : ''} · LI.FI (you confirm it next)`,
              ]
              : [`🎯 <b>You get</b>  ≈ ${out} · NEAR Intents`]),
            `🎚 <b>Slippage</b>  ${slippagePercent}%`,
            `🏷 <b>Platform fee</b>  ${HOPR_FEE_PERCENT}% · charged once${env.ONECLICK_JWT ? '' : ' + 0.25% 1Click routing fee'}`,
          ]),
          env,
          telegramTradeConfirmationKeyboard(trade.id, intents.continuation ? '✅ Confirm step 1' : '✅ Confirm and submit'),
        );
        return;
      }
      const fundingChain = getChainById(fundingChainId);
      if (!fundingChain) throw new Error('Configured funding chain is not supported');
      const trade = await prepareBuy(
        {
          userId,
          wallet,
          fundingChainKey: fundingChain.key,
          fundingTokenAddress: 'native',
          fundingAmountUnits: decimalToUnits(amountDecimal, fundingChain.type === 'EVM' ? 18 : 9),
          targetChainId: targetChain.id,
          targetTokenAddress: profile.lastTokenAddress,
          slippage,
        },
        env,
      );
      await sendTelegramMessage(
        chatId,
        telegramQuoteMessage('BUY', [
          `💸 <b>You pay</b>  ${amountDecimal} ${escapeTelegramHtml(fundingChain.nativeSymbol)}`,
          `🎯 <b>You get</b>  ${tokenSymbol}`,
          `🧭 <b>Route</b>  ${escapeTelegramHtml(fundingChain.name)} → ${escapeTelegramHtml(targetChain.name)}`,
          `🛡 <b>Minimum output</b>  <code>${escapeTelegramHtml(String(trade.quote.estimate.toAmountMin))}</code> base units`,
          `🎚 <b>Slippage</b>  ${slippagePercent}%`,
          `🏷 <b>Platform fee</b>  ${HOPR_FEE_PERCENT}% included`,
        ]),
        env,
        telegramTradeConfirmationKeyboard(trade.id),
      );
      return;
    }

    if (sellMatch) {
      const percent = Number(sellMatch[1]);
      if (!env.DB) throw new Error('DB binding required to look up open positions');
      const openTrade = await env.DB.prepare(
        `SELECT id, purchased_amount FROM user_trades
           WHERE user_id = ?1 AND target_token_address = ?2 AND status IN ('SUBMITTED','CONFIRMED')
           ORDER BY created_at DESC LIMIT 1`
      )
        .bind(userId, profile.lastTokenAddress)
        .first<{ id: string; purchased_amount: string }>();
      if (!openTrade) {
        await sendTelegramMessage(chatId, tgMessage(tgTitle('📭', 'Nothing to sell'), `No open ${tokenSymbol} position found for this wallet to sell.`), env, telegramActionKeyboard());
        return;
      }
      const sellUnits = (BigInt(openTrade.purchased_amount) * BigInt(percent)) / 100n;
      const trade = await prepareSell(
        { userId, wallet, originalTradeDbId: openTrade.id, sellAmountUnits: sellUnits.toString(), slippage },
        env,
      );
      await sendTelegramMessage(
        chatId,
        telegramQuoteMessage('SELL', [
          `💸 <b>You sell</b>  ${percent}% of ${tokenSymbol}`,
          `🧭 <b>Route</b>  ${escapeTelegramHtml(targetChain.name)} → original funding asset`,
          `🛡 <b>Minimum output</b>  <code>${escapeTelegramHtml(String(trade.quote.estimate.toAmountMin))}</code> base units`,
          `🎚 <b>Slippage</b>  ${slippagePercent}%`,
          `🏷 <b>Platform fee</b>  ${HOPR_FEE_PERCENT}% included`,
        ]),
        env,
        telegramTradeConfirmationKeyboard(trade.id),
      );
      return;
    }
  } catch (error) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'Trade failed'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')), env, telegramActionKeyboard());
  }
}

// ---------------------------------------------------------------------------
// NEAR trading (Ref Finance)
// ---------------------------------------------------------------------------

const NEAR_TOKEN = { id: NATIVE_NEAR, symbol: 'NEAR', decimals: NEAR_DECIMALS };

/** Display-only ratio of two token amounts given in smallest units. */
function nearDisplayRate(amountIn: string, decimalsIn: number, amountOut: string, decimalsOut: number): string {
  const input = Number(BigInt(amountIn)) / 10 ** decimalsIn;
  const output = Number(BigInt(amountOut)) / 10 ** decimalsOut;
  if (!input || !Number.isFinite(output / input)) return '—';
  const rate = output / input;
  return rate >= 1 ? rate.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(Number(rate.toPrecision(4)));
}

function telegramNearQuoteMessage(trade: PendingTrade): string {
  const swap = trade.nearSwap!;
  const { quote } = swap;
  const storage = BigInt(swap.outputStorageDeposit) + BigInt(swap.wrapStorageDeposit) + BigInt(swap.fee?.storageDeposit ?? '0')
    + Object.values(swap.intermediateStorageDeposits ?? {}).reduce((sum, deposit) => sum + BigInt(deposit), 0n);
  const fee = BigInt(swap.fee?.amount ?? '0');
  const inSymbol = escapeTelegramHtml(swap.tokenInSymbol);
  const outSymbol = escapeTelegramHtml(swap.tokenOutSymbol);
  return tgMessage(
    tgTitle('🧾', `Quote ready · ${trade.kind === 'buy' ? 'BUY' : 'SELL'}`, `Ⓝ NEAR · ${escapeTelegramHtml(quote.venue ?? 'Ref Finance')}`),
    tgCard([
      `💸 <b>You pay</b>  ${formatUnits(BigInt(quote.amountIn) + fee, swap.tokenInDecimals)} ${inSymbol}`,
      `🎯 <b>You receive</b>  ≈ ${formatUnits(quote.expectedOut, swap.tokenOutDecimals)} ${outSymbol}`,
      `🛡 <b>Minimum received</b>  ${formatUnits(quote.minOut, swap.tokenOutDecimals)} ${outSymbol}`,
      `💱 <b>Rate</b>  1 ${inSymbol} ≈ ${nearDisplayRate(quote.amountIn, swap.tokenInDecimals, quote.expectedOut, swap.tokenOutDecimals)} ${outSymbol}`,
      `🧭 <b>Route</b>  ${escapeTelegramHtml(quote.venue ?? 'Ref Finance')}${quote.legs ? '' : ` · ${quote.hops} hop${quote.hops === 1 ? '' : 's'}`}`,
      `🎚 <b>Slippage</b>  ${Number((quote.slippage * 100).toFixed(2))}%`,
      ...(fee > 0n ? [`🏷 <b>Platform fee</b>  ${HOPR_FEE_PERCENT}% (${formatUnits(fee, swap.tokenInDecimals)} ${inSymbol})`] : []),
      ...(storage > 0n ? [`🗄 <b>One-time token registration</b>  ${formatNearAmount(storage, 5)} NEAR`] : []),
    ]),
    tgFootnote('⏳ Quotes expire in 90 seconds. Tap Confirm swap to sign, or Cancel to discard it.'),
  );
}

async function sendTelegramNearQuote(chatId: number, trade: PendingTrade, env: Env): Promise<void> {
  await sendTelegramMessage(chatId, telegramNearQuoteMessage(trade), env, telegramTradeConfirmationKeyboard(trade.id, '✅ Confirm swap'));
}

/** Decimals of the native coin a trade is paid with, by chain id. */
function nativeDecimalsOf(chainId: number): number {
  return chainId === NEAR_CHAIN_ID ? NEAR_DECIMALS : chainId === 1151111081099710 ? 9 : 18;
}

/**
 * Quote card for trades paid from one chain into a NEAR token: NEAR Intents
 * from SOL / ETH / BNB, or a LI.FI hop to Base first for chains Intents can't
 * reach. Ref swaps reuse the NEAR quote card.
 */
function telegramIncomingQuote(trade: PendingTrade): { text: string; confirmLabel: string } {
  if (trade.venue === 'ref') return { text: telegramNearQuoteMessage(trade), confirmLabel: '✅ Confirm swap' };
  const chain = getChainById(trade.fundingChainId);
  const pay = `${formatUnits(trade.displayAmount, nativeDecimalsOf(trade.fundingChainId), 6)} ${escapeTelegramHtml(trade.displaySymbol)}${chain ? ` on ${escapeTelegramHtml(chain.name)}` : ''}`;
  const fee = trade.feeBps ? `🏷 <b>Platform fee</b>  ${trade.feeBps / 100}% · charged once` : '🏷 <b>Platform fee</b>  already paid in step 1';
  if (trade.hubContinuation) {
    const target = escapeTelegramHtml(trade.hubContinuation.targetSymbol);
    return {
      text: telegramQuoteMessage('BUY', [
        `💸 <b>You pay</b>  ${pay}`,
        `🌉 <b>Step 1</b>  ${escapeTelegramHtml(trade.displaySymbol)} → ≈ ${formatUnits(trade.quote.estimate.toAmount, 18, 6)} ETH on Base · LI.FI`,
        `🎯 <b>Next</b>  ETH → ${target} on NEAR · NEAR Intents + Ref Finance (you confirm each step)`,
        `🎚 <b>Slippage</b>  ${Number((trade.hubContinuation.slippage * 100).toFixed(2))}%`,
        fee,
      ]),
      confirmLabel: '✅ Confirm step 1',
    };
  }
  const intents = trade.intents!;
  const out = `${formatUnits(intents.expectedOut, intents.outDecimals, 6)} ${escapeTelegramHtml(intents.outSymbol)}`;
  return {
    text: telegramQuoteMessage('BUY', [
      `💸 <b>You pay</b>  ${pay}`,
      ...(intents.continuation
        ? [
          `🌉 <b>Step 1</b>  ${escapeTelegramHtml(trade.displaySymbol)} → ≈ ${out} on NEAR · NEAR Intents`,
          `🎯 <b>Step 2</b>  NEAR → ${escapeTelegramHtml(intents.continuation.targetSymbol)} · Ref Finance (you confirm it next)`,
        ]
        : [`🎯 <b>You get</b>  ≈ ${out} on NEAR · NEAR Intents`]),
      `🎚 <b>Slippage</b>  ${Number((((intents.continuation?.slippage) ?? 0.01) * 100).toFixed(2))}%`,
      fee,
    ]),
    confirmLabel: intents.continuation ? '✅ Confirm step 1' : '✅ Confirm and submit',
  };
}

async function sendTelegramPreparedTrade(chatId: number, trade: PendingTrade, env: Env, panelId?: number): Promise<void> {
  const { text, confirmLabel } = telegramIncomingQuote(trade);
  const keyboard = telegramTradeConfirmationKeyboard(trade.id, confirmLabel);
  if (panelId) await sendTelegramPanel(chatId, panelId, text, env, keyboard);
  else await sendTelegramMessage(chatId, text, env, keyboard);
}

async function handleTelegramNearTrade(chatId: number, data: string, profile: TelegramProfile, env: Env): Promise<void> {
  const buyMatch = data.match(/^trade:buy:(\d{1,12}(?:\.\d{1,24})?)$/);
  const sellMatch = data.match(/^trade:sell:(25|50|100)$/);
  if (!buyMatch && !sellMatch) {
    await sendTelegramMessage(chatId, 'That amount is not available for NEAR tokens. Use the Buy buttons, ✏️ Buy X, or /swap.', env);
    return;
  }
  const userId = String(chatId);
  const tokenId = profile.lastTokenAddress!;
  const rpc = nearRpcOptions(env);
  const slippage = (profile.slippagePercent ?? 1) / 100;
  const fundingChainId = profile.fundingChainId ?? NEAR_CHAIN_ID;
  try {
    if (buyMatch && fundingChainId !== NEAR_CHAIN_ID) {
      // Paid from another chain: NEAR Intents into NEAR (LI.FI first for chains Intents can't reach).
      const funding = getChainById(fundingChainId);
      const wallet = await getCustodialWallet(userId, env);
      if (!funding || !wallet) throw new Error('Pick a funding chain in /settings.');
      const trade = await prepareIncomingNearBuy({
        userId, wallet, fundingChainId: funding.id,
        amountUnits: decimalToUnits(buyMatch[1], funding.type === 'SVM' ? 9 : 18),
        tokenAddress: tokenId, slippage,
      }, env);
      await sendTelegramPreparedTrade(chatId, trade, env);
      return;
    }
    const metadata = await getTokenMetadata(tokenId, rpc);
    const token = { id: tokenId, symbol: metadata.symbol, decimals: metadata.decimals };
    if (buyMatch) {
      const trade = await prepareNearSwap({ userId, kind: 'buy', tokenIn: NEAR_TOKEN, tokenOut: token, amountInUnits: parseUnits(buyMatch[1], NEAR_DECIMALS).toString(), slippage }, env);
      await sendTelegramNearQuote(chatId, trade, env);
      return;
    }
    // NEAR sells are sized from what the wallet actually holds, not from trade history.
    const accountId = await ensureNearWallet(userId, env);
    const held = BigInt(await viewFunction<string>(tokenId, 'ft_balance_of', { account_id: accountId }, rpc).catch(() => '0'));
    const amount = (held * BigInt(sellMatch![1])) / 100n;
    if (amount === 0n) {
      await sendTelegramMessage(chatId, tgMessage(tgTitle('📭', 'Nothing to sell'), `Your NEAR wallet holds no ${escapeTelegramHtml(metadata.symbol)}.`), env, telegramActionKeyboard());
      return;
    }
    const trade = await prepareNearSwap({ userId, kind: 'sell', tokenIn: token, tokenOut: NEAR_TOKEN, amountInUnits: amount.toString(), slippage }, env);
    await sendTelegramNearQuote(chatId, trade, env);
  } catch (error) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'No quote'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')), env, telegramActionKeyboard());
  }
}

const TELEGRAM_SWAP_USAGE = tgMessage(
  tgTitle('Ⓝ', 'Swap on NEAR', 'Ref Finance routing, confirmed by you before anything is signed.'),
  tgCard([
    '/swap &lt;amount&gt; &lt;from&gt; &lt;to&gt;',
    '<code>/swap 1 near usdc</code>',
    '<code>/swap 25 usdc near</code>',
    '<code>/swap 2 near token.v2.ref-finance.near</code>',
  ]),
  tgFootnote('Tokens: near, wnear, usdc, usdt, or any NEP-141 contract id.'),
);

/** `/swap <amount> <from> <to>` — any NEAR ↔ NEP-141 or NEP-141 ↔ NEP-141 swap via Ref Finance. */
async function handleTelegramNearSwapCommand(chatId: number, args: string[], env: Env): Promise<void> {
  const [amountText, fromText, ...rest] = args.filter((arg) => !['to', 'for', '->', '→'].includes(arg.toLowerCase()));
  const toText = rest[0];
  const tokenIn = fromText ? resolveNearToken(fromText) : null;
  const tokenOut = toText ? resolveNearToken(toText) : null;
  if (!amountText || !/^\d+(\.\d+)?$/.test(amountText) || !tokenIn || !tokenOut || tokenIn === tokenOut) {
    await sendTelegramMessage(chatId, TELEGRAM_SWAP_USAGE, env);
    return;
  }
  const userId = String(chatId);
  if (!env.DB || !env.ENCRYPTION_KEY || !env.TELEGRAM_STATE) {
    await sendTelegramMessage(chatId, '🧩 NEAR swaps need the <code>DB</code>, <code>TELEGRAM_STATE</code> and <code>ENCRYPTION_KEY</code> bindings.', env);
    return;
  }
  if (!await getCustodialWallet(userId, env).catch(() => null)) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('💳', 'Trading needs a Hopr wallet'), 'Create one first — it includes a NEAR account.'), env, telegramWalletSetupKeyboard());
    return;
  }
  const rpc = nearRpcOptions(env);
  try {
    const [inMeta, outMeta, profile] = await Promise.all([
      getTokenMetadata(tokenIn, rpc),
      getTokenMetadata(tokenOut, rpc),
      readTelegramProfile(chatId, env).catch(() => null),
    ]);
    const trade = await prepareNearSwap({
      userId,
      kind: tokenOut === NATIVE_NEAR ? 'sell' : 'buy',
      tokenIn: { id: tokenIn, symbol: inMeta.symbol, decimals: inMeta.decimals },
      tokenOut: { id: tokenOut, symbol: outMeta.symbol, decimals: outMeta.decimals },
      amountInUnits: parseUnits(amountText, inMeta.decimals).toString(),
      slippage: (profile?.slippagePercent ?? 1) / 100,
    }, env);
    await sendTelegramNearQuote(chatId, trade, env);
  } catch (error) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'No quote'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')), env);
  }
}

function decimalToUnits(amount: string, decimals: number): string {
  const [whole, fraction = ''] = amount.split('.');
  return `${BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')}`;
}

async function showTelegramPools(chatId: number, sourceId: LaunchpadId, env: Env, panelId?: number): Promise<void> {
  const source = launchpadById(sourceId);
  if (!source) return;
  const buttons: TelegramButton[][] = [];
  for (let i = 0; i < LAUNCHPADS.length; i += 3) buttons.push(LAUNCHPADS.slice(i, i + 3).map((pad) => ({ text: `${pad.id === sourceId ? '• ' : ''}${pad.name}`, callback_data: `pools:${pad.id}` })));
  buttons.push([{ text: '↻ Refresh', callback_data: `pools:${sourceId}` }, { text: '◆ Menu', callback_data: 'menu' }]);
  const usd = (value: number | null) => value === null ? 'Not indexed' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  try {
    const feed = await getLaunchpadFeed(sourceId, env);
    // Launch feeds read newest-first (Flap lists launches seconds old, before any volume exists).
    const rows = sortPools(feed.pools, sourceId === 'nearly' || sourceId === 'nearpaid' || sourceId === 'flap' ? 'newest' : 'volume').slice(0, 6);
    const profile = await readTelegramProfile(chatId, env).catch(() => null);
    const funding = getNetwork(source.chainId === NEAR_CHAIN_ID ? NEAR_CHAIN_ID : profile?.fundingChainId ?? 8453) ?? getNetwork(8453)!;
    const amount = funding.quickBuy[0];
    const actionId = await savePoolActions(chatId, rows.map((pool) => ({ pool, fundingChainId: funding.id, amount })), env).catch(() => null);
    if (actionId) buttons.unshift(...rows.map((pool, i) => [
      { text: `📊 ${i + 1}. ${pool.symbol.slice(0, 18)}`, callback_data: `lp:view:${actionId}:${i}` },
      { text: `🟢 Buy ${amount} ${funding.nativeSymbol}`, callback_data: `lp:buy:${actionId}:${i}` },
    ]));
    const body = rows.map((pool, i) => tgMessage(
      `<b>${i + 1}. ${escapeTelegramHtml(pool.symbol.slice(0, 32))}</b>${pool.quoteSymbol ? ` / ${escapeTelegramHtml(pool.quoteSymbol.slice(0, 20))}` : ''}`,
      tgCard([`Liquidity: ${usd(pool.liquidityUsd)}`, `Volume · 24h: ${usd(pool.volume24h)}`]),
      `<code>${escapeTelegramHtml(pool.tokenAddress)}</code>`,
    ));
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('📡', `${source.name} · Launch radar`),
      `<i>${feed.stale ? 'Last saved' : feed.partial ? 'Partial update' : 'Fetched'} ${new Date(feed.observedAt).toISOString().slice(11, 16)} UTC · ${source.network}</i>`,
      ...body, rows.length ? (actionId ? 'Tap Buy for a live quote, then confirm. Buttons expire after 15 minutes. Change your pay-from chain in Settings.' : 'Send a token address to check routes. Quick Buy needs CACHE or TELEGRAM_STATE storage.') : 'No pools returned by this source yet.',
      `<i>${escapeTelegramHtml(feed.coverage)}</i>`), env, { inline_keyboard: buttons });
  } catch {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('📡', `${source.name} · Launch radar`),
      'This source could not refresh. Retry shortly or choose another launchpad.'), env, { inline_keyboard: buttons });
  }
}

async function handleTelegramCallback(chatId: number, data: string, env: Env, panelId?: number, chatType?: string): Promise<void> {
  const poolAction = data.match(/^lp:(view|buy):([a-f0-9]{24}):([0-5])$/);
  if (poolAction) {
    if (chatType !== 'private') return sendTelegramMessage(chatId, 'Open a private chat to trade launchpad tokens.', env);
    const action = await readPoolAction(chatId, poolAction[2], Number(poolAction[3]), env).catch(() => null);
    if (!action) return sendTelegramPanel(chatId, panelId, 'This pool button expired. Open /pools for fresh token buttons.', env, telegramActionKeyboard());
    const { pool, fundingChainId, amount } = action;
    if (poolAction[1] === 'view') return lookupTelegramToken(chatId, pool.tokenAddress, env, panelId, pool.chainId, launchpadById(pool.source)?.name);
    const profile = await readTelegramProfile(chatId, env).catch(() => null);
    return handleTelegramTradeAction(chatId, `trade:buy:${amount}`, env, panelId, {
      ...profile, fundingChainId, lastTokenAddress: pool.tokenAddress, lastTokenChainId: pool.chainId,
      lastTokenChainType: pool.chainId === NEAR_CHAIN_ID ? 'NEAR' : pool.network === 'solana' ? 'SVM' : 'EVM', lastTokenSymbol: pool.symbol,
    });
  }
  if (data === 'pools' || data.startsWith('pools:')) return showTelegramPools(chatId, (data === 'pools' ? 'pump' : data.slice(6)) as LaunchpadId, env, panelId);
  if (data === 'help') return sendTelegramPanel(chatId, panelId, TELEGRAM_HELP_TEXT, env, telegramActionKeyboard());
  if (data === 'menu') return showTelegramMenu(chatId, env, panelId, chatType);
  if (data === 'positions' || data === 'positions:fresh') return showTelegramPositions(chatId, env, panelId, data === 'positions:fresh');
  if (data === 'wallet:list' || data === 'wallet:preferred') return showTelegramWalletList(chatId, env, panelId);
  if (data === 'wallet:rename') return promptTelegramWalletRename(chatId, env);
  if (data === 'orders') return showTelegramOrders(chatId, env, panelId);
  if (data.startsWith('ms:')) return handleMultiSendCallback(chatId, data, env, panelId);
  if (data === 'track') return showTelegramTracking(chatId, env, panelId);
  if (data === 'track:add') return promptTelegramTrack(chatId, env);
  if (data.startsWith('track:a:')) return addTelegramTrackedWallet(chatId, data.slice('track:a:'.length), env);
  if (data.startsWith('track:')) return handleTrackCallback(chatId, data, env, panelId);
  if (data.startsWith('order:new:')) return startTelegramOrder(chatId, data.slice('order:new:'.length) as OrderKind, env, panelId);
  if (data.startsWith('order:at:')) {
    const [, , kind, percent] = data.split(':');
    return setTelegramOrderTrigger(chatId, kind as OrderKind, Number(percent), env, panelId);
  }
  if (data === 'order:price') return promptTelegramOrderPrice(chatId, env);
  if (data.startsWith('order:size:')) return reviewTelegramOrder(chatId, Number(data.slice('order:size:'.length)), env, panelId);
  if (data === 'order:place') return placeTelegramOrder(chatId, env, panelId);
  if (data === 'order:discard') return sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('✖️', 'Order discarded'), 'Nothing was placed.'), env, telegramActionKeyboard());
  if (data.startsWith('order:cancel:')) {
    const cancelled = await cancelOrder(env, String(chatId), data.slice('order:cancel:'.length)).catch(() => false);
    return showTelegramOrders(chatId, env, panelId, cancelled ? '✅ Order cancelled.' : 'That order already executed or was cancelled.');
  }
  if (data === 'bundle:buy' || data === 'bundle:sell') return showTelegramBundleMenu(chatId, data === 'bundle:buy' ? 'buy' : 'sell', env, panelId);
  if (data.startsWith('bundle:buy:') || data.startsWith('bundle:sell:')) {
    const [, kind, value] = data.split(':');
    return prepareTelegramBundle(chatId, kind as 'buy' | 'sell', value, env, panelId);
  }
  if (data.startsWith('bundle:confirm:')) return confirmTelegramBundle(chatId, data.slice('bundle:confirm:'.length), env, panelId);
  if (data === 'bundle:cancel') return sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('✖️', 'Bundle cancelled'), 'No transaction was signed or submitted.'), env, telegramActionKeyboard());
  const walletAction = data.match(/^wallet:(v|ren|exp|del|delok):([\w:-]{1,52})$/);
  if (walletAction) {
    const [, action, walletId] = walletAction;
    if (action === 'v') return showTelegramWalletDetail(chatId, walletId, env, panelId);
    if (action === 'ren') return promptTelegramWalletRename(chatId, env, walletId);
    if (action === 'exp') return showTelegramWalletExport(chatId, env, walletId);
    if (action === 'del') return confirmTelegramWalletDelete(chatId, walletId, env, panelId);
    return deleteTelegramWallet(chatId, walletId, env, panelId);
  }
  const defaultMatch = data.match(/^wallet:def:([esna]):([\w:-]{1,50})$/);
  if (defaultMatch) return setTelegramDefaultWallet(chatId, defaultMatch[2], defaultMatch[1], env, panelId);
  if (data.startsWith('wallet:use:')) return useTelegramWallet(chatId, data.slice('wallet:use:'.length), env, panelId);
  if (data === 'trade:start') return showTelegramBuySell(chatId, env);
  if (data === 'wallet') return showTelegramWallet(chatId, env, panelId);
  if (data === 'settings') return showTelegramSettings(chatId, env, panelId);
  if (data === 'referral') return showTelegramReferral(chatId, env, panelId);
  if (data === 'referral:claim') return claimTelegramReferral(chatId, env, panelId);
  if (data === 'dismiss') {
    if (panelId) await telegramApiRequest('deleteMessage', env, { chat_id: chatId, message_id: panelId });
    return;
  }
  if (data.startsWith('token:refresh:')) {
    let address = data.slice('token:refresh:'.length);
    if (address === 'last') {
      const profile = await readTelegramProfile(chatId, env).catch(() => null);
      if (!profile?.lastTokenAddress) return sendTelegramPanel(chatId, panelId, 'Paste the token address again to refresh it.', env);
      address = profile.lastTokenAddress;
    }
    // Refresh means live numbers: skip both the isolate and the KV cache.
    return lookupTelegramToken(chatId, address, env, panelId, undefined, undefined, true);
  }
  if (data.startsWith('trade:')) {
    return handleTelegramTradeAction(chatId, data, env, panelId);
  }
  if (data === 'wallet:generate') {
    return showTelegramWalletGenerate(chatId, env);
  }
  if (data === 'wallet:delete') return deleteActiveTelegramWallet(chatId, env, panelId);
  if (data === 'wallet:delete:confirm') return deleteActiveTelegramWallet(chatId, env, panelId);
  if (data === 'wallet:export') {
    return showTelegramWalletExport(chatId, env);
  }
  if (data === 'wallet:import') return showTelegramImportPicker(chatId, env, panelId);
  const importMatch = data.match(/^import:(evm|solana|near)$/);
  if (importMatch) return promptTelegramImport(chatId, importMatch[1] as ImportChain, env);
  const pickMatch = data.match(/^import:near:pick:([0-7])$/);
  if (pickMatch) return pickTelegramNearAccount(chatId, Number(pickMatch[1]), env, panelId);
  const payMatch = data.match(/^token:pay:(\d+)$/);
  if (payMatch) {
    const chain = TELEGRAM_CHAINS.find((item) => item.id === Number(payMatch[1]));
    const profile = await readTelegramProfile(chatId, env);
    if (!chain || !profile) return sendTelegramPanel(chatId, panelId, TELEGRAM_PERSISTENCE_REQUIRED, env);
    if (!profile.lastTokenAddress) return sendTelegramPanel(chatId, panelId, 'Paste the token address again to trade it.', env);
    await writeTelegramProfile(chatId, { ...profile, fundingChainId: chain.id }, env);
    return lookupTelegramToken(chatId, profile.lastTokenAddress, env, panelId);
  }

  const chainMatch = data.match(/^settings:chain:(\d+)$/);
  if (chainMatch) {
    const chainId = Number(chainMatch[1]);
    const chain = TELEGRAM_CHAINS.find((item) => item.id === chainId);
    if (!chain) return sendTelegramMessage(chatId, 'That chain option is no longer available. Open /settings and try again.', env);
    const profile = await readTelegramProfile(chatId, env);
    if (!profile || !await writeTelegramProfile(chatId, { ...profile, fundingChainId: chain.id }, env)) {
      return sendTelegramPanel(chatId, panelId, TELEGRAM_PERSISTENCE_REQUIRED, env);
    }
    return showTelegramSettings(chatId, env, panelId);
  }

  const slippageMatch = data.match(/^settings:slippage:(0\.5|1|3|5)$/);
  if (slippageMatch) {
    const profile = await readTelegramProfile(chatId, env);
    if (!profile || !await writeTelegramProfile(chatId, { ...profile, slippagePercent: Number(slippageMatch[1]) }, env)) {
      return sendTelegramPanel(chatId, panelId, TELEGRAM_PERSISTENCE_REQUIRED, env);
    }
    return showTelegramSettings(chatId, env, panelId);
  }

  await sendTelegramMessage(chatId, 'This button is no longer available. Use /help to see current commands.', env);
}

/** Sends a new HTML message. Pass `parseMode: null` for plain text (e.g. force-reply prompts). */
async function sendTelegramMessage(
  chatId: number,
  text: string,
  env: Env,
  replyMarkup?: Record<string, unknown>,
  parseMode: 'HTML' | null = 'HTML',
): Promise<void> {
  await telegramApiCall('sendMessage', env, {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
}

/**
 * Menu navigation: edit the tapped panel in place so the chat stays one clean
 * card instead of a stack of messages. Falls back to a new message when there
 * is no panel to edit (commands) or the edit is refused (message too old).
 */
async function sendTelegramPanel(
  chatId: number,
  panelId: number | undefined,
  text: string,
  env: Env,
  replyMarkup?: TelegramKeyboard,
): Promise<void> {
  if (panelId) {
    const edited = await telegramApiRequest('editMessageText', env, {
      chat_id: chatId,
      message_id: panelId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
    if (edited.ok || edited.description?.includes('message is not modified')) return;
  }
  await sendTelegramMessage(chatId, text, env, replyMarkup);
}

/** Telegram Bot API call that reports failure instead of throwing. */
async function telegramApiRequest(method: string, env: Env, body: Record<string, unknown>): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { ok?: boolean; description?: string; result?: unknown };
    return { ok: Boolean(response.ok && result.ok), description: result.description, result: result.result };
  } catch {
    return { ok: false, description: `Telegram API request failed (${method})` };
  }
}

async function telegramApiCall(method: string, env: Env, body: Record<string, unknown>): Promise<{ ok?: boolean; description?: string; result?: unknown }> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let result: { ok?: boolean; description?: string; result?: unknown };
  try {
    result = await response.json() as { ok?: boolean; description?: string; result?: unknown };
  } catch {
    console.error(`Telegram API ${method} returned an invalid response (HTTP ${response.status})`);
    throw new Error(`Telegram API request failed (${method})`);
  }
  if (!response.ok || !result.ok) {
    console.error(`Telegram API ${method} failed with HTTP ${response.status}${result.description ? `: ${result.description}` : ''}`);
    throw new Error(`Telegram API request failed (${method})`);
  }
  return result;
}

async function handleApiRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/launchpads/pools' && request.method === 'GET') {
    const source = launchpadById(url.searchParams.get('source') ?? 'pump');
    if (!source) return Response.json({ error: 'Unknown launchpad' }, { status: 400, headers: corsHeaders });
    try {
      const feed = await getLaunchpadFeed(source.id, env);
      return Response.json(feed, { headers: { ...corsHeaders, 'Cache-Control': feed.stale ? 'no-store' : `public, max-age=${Math.round(feedRefreshMs(source.id) / 2000)}` } });
    } catch {
      return Response.json({ error: 'Pool provider could not refresh. Please retry.' }, { status: 503, headers: { ...corsHeaders, 'Retry-After': '120' } });
    }
  }

  // POST /api/detect - Chain detection
  if (path === '/api/detect' && request.method === 'POST') {
    const body = await request.json() as { address: string };
    return handleChainDetection(body.address, env, corsHeaders);
  }

  // Referral payout queue for operators (/api/admin/referral-payouts*). Referrals themselves live in the bot.
  if (path.startsWith('/api/admin/referral-payouts')) {
    const referralResponse = await handleReferralRequest(request, path, env, corsHeaders);
    if (referralResponse) return referralResponse;
  }

  // GET /api/config - public settings the website viewer needs (bot link for "Trade on Telegram")
  if (path === '/api/config' && request.method === 'GET') {
    return Response.json({
      fees: { swap: HOPR_FEE_BPS.swap / 10_000, bridge: HOPR_FEE_BPS.bridge / 10_000 },
      telegramBot: await telegramBotUsername(env).catch(() => null),
    }, { headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300' } });
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
}

type WalletAccountRow = WalletRow & { user_id: string; created_at: string };

class WalletLimitError extends Error {
  constructor() {
    super(`You already have ${MAX_WALLETS_PER_USER} wallets, the maximum. Delete one you no longer use to add another.`);
  }
}

/**
 * Store a wallet. Slots it has no key for stay empty (an imported key is a
 * wallet of its own chain only). It becomes the default for `defaultFor`.
 */
async function storeWalletAccount(
  userId: string,
  wallet: { evmAddress: string | null; evmPrivateKey: string | null; solanaAddress: string | null; solanaPrivateKey: string | null; nearAddress?: string | null; nearPrivateKey?: string | null },
  label: string,
  source: 'generated' | 'imported',
  env: Env,
  defaultFor: WalletChain[],
): Promise<WalletAccountRow> {
  if (!env.DB || !env.ENCRYPTION_KEY) throw new Error('Wallet storage is not configured.');
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM wallet_accounts WHERE user_id = ?1`).bind(userId).first<{ total: number }>();
  if ((count?.total ?? 0) >= MAX_WALLETS_PER_USER) throw new WalletLimitError();
  const id = crypto.randomUUID();
  const encrypt = async (key: string | null | undefined) => key ? packEncryptedSecret(await encryptPrivateKey(key, env.ENCRYPTION_KEY!)) : null;
  const evmEncrypted = await encrypt(wallet.evmPrivateKey);
  const solanaEncrypted = await encrypt(wallet.solanaPrivateKey);
  const nearEncrypted = await encrypt(wallet.nearPrivateKey);
  const finalLabel = (label.trim() || await nextWalletLabel(userId, env)).slice(0, 80);
  const base = [id, userId, finalLabel, source, wallet.evmAddress, evmEncrypted, wallet.solanaAddress, solanaEncrypted];
  const withoutNear = `INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`;
  // Insert first, then make it default: a failed insert must never leave a chain without its wallet.
  if (wallet.nearAddress && nearEncrypted) {
    try {
      await env.DB.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, near_address, near_encrypted_key, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)`)
        .bind(...base, wallet.nearAddress, nearEncrypted).run();
    } catch (error) {
      if (!/near_/.test(String(error))) throw error;
      if (!wallet.evmAddress && !wallet.solanaAddress) throw new Error('NEAR wallets need migrations/0004_add_near_chain.sql applied first.');
      await env.DB.prepare(withoutNear).bind(...base).run();
    }
  } else {
    await env.DB.prepare(withoutNear).bind(...base).run();
  }
  await setDefaultWallet(userId, id, defaultFor, env);
  return (await env.DB.prepare(`SELECT * FROM wallet_accounts WHERE id = ?1`).bind(id).first<WalletAccountRow>())!;
}

async function nextWalletLabel(userId: string, env: Env): Promise<string> {
  const rows = await env.DB!.prepare(`SELECT label FROM wallet_accounts WHERE user_id = ?1`).bind(userId).all<{ label: string }>();
  const highest = (rows.results ?? []).reduce((max, row) => {
    const match = /^W(\d+)$/i.exec(row.label.trim());
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `W${highest + 1}`;
}

/** Market data goes stale fast: keep live detections briefly (KV's minimum TTL is 60s). */
const DETECTION_MEMORY_TTL_MS = 20_000;
const DETECTION_KV_TTL_SECONDS = 60;
/** A result without market data is only held this long (absorbs a double tap, never hides a recovery). */
const DETECTION_MISS_TTL_MS = 5_000;
/** Last good market numbers per token, shown (labelled) when every provider is busy. */
const LAST_MARKET_TTL_SECONDS = 7 * 24 * 60 * 60;
const MARKET_FIELDS = ['priceUsd', 'liquidity', 'volume24h', 'fdv', 'change24h', 'priceChanges', 'txns24h', 'pairCreatedAt', 'pairAddress', 'geckoNetwork', 'liquiditySource', 'pairedAsset', 'holders', 'marketSource', 'chartUrl', 'launchpad', 'imageUrl'] as const;

async function handleChainDetection(
  address: string,
  env: Env,
  corsHeaders: Record<string, string>,
  options: { fresh?: boolean } = {},
): Promise<Response> {
  // Check cache first (a refresh skips it and rewrites it with live data)
  const cacheKey = `detect:${address}`;
  const memoryCached = options.fresh ? undefined : telegramDetectionMemoryCache.get(cacheKey);
  if (memoryCached && memoryCached.expiresAt > Date.now()) {
    return Response.json(memoryCached.value, { headers: { ...corsHeaders, 'X-Cache': 'MEMORY' } });
  }
  if (memoryCached) telegramDetectionMemoryCache.delete(cacheKey);
  const cached = options.fresh ? null : await env.CACHE?.get(cacheKey);
  if (cached) {
    const value = JSON.parse(cached) as Record<string, unknown>;
    telegramDetectionMemoryCache.set(cacheKey, { value, expiresAt: Date.now() + DETECTION_MEMORY_TTL_MS });
    return Response.json(value, { headers: { ...corsHeaders, 'X-Cache': 'HIT' } });
  }

  // Shared with the website: DexScreener raced against GeckoTerminal (and Jupiter on Solana), the deepest
  // base-side pool on a Hopr chain, venue attribution, then DefiLlama prices and on-chain probes as backups.
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(address);
  const nearId = !isBase58 && !isEvm && isNearAccountId(address.toLowerCase()) ? address.toLowerCase() : null;
  if (!nearId && !isBase58 && !isEvm) return Response.json({ error: 'Token not found' }, { status: 404, headers: corsHeaders });

  const detected = await detectTokenOnChain(nearId ?? address).catch(() => null);
  if (!detected) {
    return Response.json({ error: 'Token not found' }, { status: 404, headers: corsHeaders });
  }
  let result: Record<string, unknown> = { ...detected, address: nearId ?? address, dexId: detected.liquiditySource ?? (detected.freshDeployment ? 'unindexed' : undefined) };

  // Remember good numbers; when no provider answered this time, show the last known ones (labelled).
  const lastKey = `mkt:v1:${detected.chainId}:${(nearId ?? address).toLowerCase()}`;
  const store = env.CACHE ?? env.TELEGRAM_STATE;
  const live = detected.marketStatus === 'live' && detected.priceUsd > 0;
  if (live) {
    const snapshot = Object.fromEntries(MARKET_FIELDS.map((field) => [field, detected[field]]));
    void store?.put(lastKey, JSON.stringify({ ...snapshot, observedAt: Date.now() }), { expirationTtl: LAST_MARKET_TTL_SECONDS }).catch(() => undefined);
  } else {
    const last = await store?.get(lastKey).catch(() => null);
    try {
      const known = last ? JSON.parse(last) as Record<string, unknown> & { observedAt?: number; priceUsd?: number } : null;
      if (known && Number(known.priceUsd) > 0 && !(detected.priceUsd > 0 && detected.liquidity > 0)) {
        result = { ...result, ...known, marketStatus: 'stale', marketObservedAt: known.observedAt, freshDeployment: false };
      }
    } catch {
      // corrupted entry: ignore
    }
  }

  // Short-lived cache: repeat scans are instant while prices stay live. Do not add KV write latency to the response.
  telegramDetectionMemoryCache.set(cacheKey, { value: result, expiresAt: Date.now() + (live ? DETECTION_MEMORY_TTL_MS : DETECTION_MISS_TTL_MS) });
  if (env.CACHE && live) {
    void env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: DETECTION_KV_TTL_SECONDS }).catch((error: unknown) => {
      console.error('Token detection cache write failed', error);
    });
  }

  return Response.json(result, { headers: { ...corsHeaders, 'X-Cache': 'MISS' } });
}

// ---------------------------------------------------------------------------
// Referrals in Telegram (one tg:<user id> identity per user)
// ---------------------------------------------------------------------------

const TELEGRAM_BUY_X_PROMPT = '✏️ Buy X — reply with how much';
const TELEGRAM_RENAME_PROMPT = '✏️ Rename wallet — reply with a new name for';
const TELEGRAM_ORDER_PRICE_PROMPT = '🎯 Limit sell — reply with the USD price to sell';
const TELEGRAM_TRACK_PROMPT = '👀 Track a wallet — reply with its address';
const TELEGRAM_MS_ADDRESS_PROMPT = '📤 Multi-send — reply with the addresses';
const TELEGRAM_MS_AMOUNT_PROMPT = '📤 Multi-send — reply with the amount each address gets';

// ---------------------------------------------------------------------------
// Multi-send: one wallet's coin to many wallets
// ---------------------------------------------------------------------------

const MULTISEND_MAX_RECIPIENTS = 20;
const MULTISEND_DRAFT_TTL_SECONDS = 15 * 60;
const multiSendKey = (chatId: number) => `msdraft:v1:${chatId}`;
/** Coins kept back for network fees on top of the amounts sent. */
const NEAR_MULTISEND_RESERVE = 50_000_000_000_000_000_000_000n; // 0.05 NEAR for gas

interface MultiSendDraft {
  chainId: number;
  walletId: string | null;
  walletLabel: string;
  from: string;
  recipients: Array<{ address: string; label?: string }>;
  amount?: string;
}

function multiSendCoin(chainId: number): { symbol: string; decimals: number; name: string } {
  if (chainId === NEAR_CHAIN_ID) return { symbol: 'NEAR', decimals: NEAR_DECIMALS, name: 'NEAR' };
  const chain = getChainById(chainId);
  return { symbol: chain?.nativeSymbol ?? 'native', decimals: chain?.type === 'SVM' ? 9 : 18, name: chain?.name ?? 'chain' };
}

/** A recipient address valid for the chain (and not the sender). */
function validRecipient(chainId: number, address: string): string | null {
  const value = address.trim();
  if (chainId === NEAR_CHAIN_ID) return isNearAccountId(value.toLowerCase()) ? value.toLowerCase() : null;
  if (chainId === 1151111081099710) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;
}

async function readMultiSend(chatId: number, env: Env): Promise<MultiSendDraft | null> {
  const raw = await (env.TELEGRAM_STATE ?? env.CACHE)?.get(multiSendKey(chatId)).catch(() => null);
  try {
    return raw ? JSON.parse(raw) as MultiSendDraft : null;
  } catch {
    return null;
  }
}

async function saveMultiSend(chatId: number, draft: MultiSendDraft, env: Env): Promise<void> {
  await (env.TELEGRAM_STATE ?? env.CACHE)?.put(multiSendKey(chatId), JSON.stringify(draft), { expirationTtl: MULTISEND_DRAFT_TTL_SECONDS });
}

const MULTISEND_EXPIRED = tgMessage(tgTitle('⌛', 'Multi-send expired'), 'Start again from 💳 Wallets → 📤 Multi-send.');

async function startMultiSend(chatId: number, env: Env, panelId?: number): Promise<void> {
  const accounts = await listWalletAccounts(String(chatId), env);
  if (!accounts.length && !await getCustodialWallet(String(chatId), env).catch(() => null)) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('📤', 'Multi-send needs a wallet'), 'Create one in 💳 Wallets first.'), env, telegramWalletSetupKeyboard());
    return;
  }
  const chains = [NEAR_CHAIN_ID, 1151111081099710, 8453, 42161, 56, 4663, 5042];
  const buttons = chains.map((id) => ({ text: `${chainEmoji(id)} ${id === NEAR_CHAIN_ID ? 'NEAR' : `${(TELEGRAM_CHAIN_NAMES[id] ?? '').replace(' Chain', '')} ${multiSendCoin(id).symbol}`}`, callback_data: `ms:chain:${id}` }));
  const rows: TelegramButton[][] = [];
  for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3));
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('📤', 'Multi-send', 'Send one coin from that chain’s ✅ wallet to many wallets at once.'),
    tgFootnote('Pick the coin to send. Next: your other Hopr wallets or pasted addresses, then the amount each.'),
  ), env, { inline_keyboard: [...rows, [{ text: '✖️ Cancel', callback_data: 'ms:cancel' }]] });
}

async function handleMultiSendCallback(chatId: number, data: string, env: Env, panelId?: number): Promise<void> {
  if (data === 'ms:start') return startMultiSend(chatId, env, panelId);
  if (data === 'ms:cancel') {
    await (env.TELEGRAM_STATE ?? env.CACHE)?.delete(multiSendKey(chatId)).catch(() => undefined);
    return sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('✖️', 'Multi-send cancelled'), 'Nothing was sent.'), env, telegramWalletActionKeyboard());
  }
  if (data.startsWith('ms:chain:')) {
    const chainId = Number(data.slice('ms:chain:'.length));
    const userId = String(chatId);
    const accounts = await listWalletAccounts(userId, env);
    const active = walletForChain(accounts, chainId);
    const legacy = active ? null : await getCustodialWallet(userId, env).catch(() => null);
    const addressOf = (wallet: { evm_address?: string | null; solana_address?: string | null; near_address?: string | null }) =>
      chainId === NEAR_CHAIN_ID ? wallet.near_address ?? null : chainId === 1151111081099710 ? wallet.solana_address ?? null : wallet.evm_address ?? null;
    const from = active ? addressOf(active) : legacy ? addressOf({ evm_address: legacy.evmAddress, solana_address: legacy.solanaAddress, near_address: legacy.nearAddress }) : null;
    if (!from) return sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('📤', 'No account on that chain'), 'None of your wallets holds that chain yet. Create or import one in 💳 Wallets.'), env, telegramWalletActionKeyboard());
    const coin = multiSendCoin(chainId);
    const others = accounts.filter((account) => account.id !== active?.id && addressOf(account));
    await saveMultiSend(chatId, { chainId, walletId: active?.id ?? null, walletLabel: active?.label ?? 'W1', from, recipients: [] }, env);
    return sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('📤', `Multi-send ${coin.symbol} · ${escapeTelegramHtml(coin.name)}`, `From ${escapeTelegramHtml(active?.label ?? 'your wallet')} <code>${escapeTelegramHtml(shortenTelegramAddress(from))}</code>`),
      tgFootnote('Who gets it?'),
    ), env, { inline_keyboard: [
      ...(others.length ? [[{ text: `👛 My other wallets (${others.length})`, callback_data: 'ms:to:mine' }]] : []),
      [{ text: '✏️ Paste addresses', callback_data: 'ms:to:paste' }],
      [{ text: '✖️ Cancel', callback_data: 'ms:cancel' }],
    ] });
  }
  const draft = await readMultiSend(chatId, env);
  if (!draft) return sendTelegramPanel(chatId, panelId, MULTISEND_EXPIRED, env, telegramWalletActionKeyboard());
  if (data === 'ms:to:mine') {
    const accounts = await listWalletAccounts(String(chatId), env);
    draft.recipients = accounts.filter((account) => account.id !== draft.walletId).flatMap((account) => {
      const address = draft.chainId === NEAR_CHAIN_ID ? account.near_address : draft.chainId === 1151111081099710 ? account.solana_address : account.evm_address;
      return address && address !== draft.from ? [{ address, label: account.label }] : [];
    }).slice(0, MULTISEND_MAX_RECIPIENTS);
    await saveMultiSend(chatId, draft, env);
    return showMultiSendAmounts(chatId, draft, env, panelId);
  }
  if (data === 'ms:to:paste') {
    return sendTelegramMessage(chatId, `${TELEGRAM_MS_ADDRESS_PROMPT} (one per line, up to ${MULTISEND_MAX_RECIPIENTS}) for ${multiSendCoin(draft.chainId).symbol} on ${multiSendCoin(draft.chainId).name}`, env, {
      force_reply: true,
      input_field_placeholder: 'One address per line',
    }, null);
  }
  if (data === 'ms:custom') {
    const coin = multiSendCoin(draft.chainId);
    return sendTelegramMessage(chatId, `${TELEGRAM_MS_AMOUNT_PROMPT} (in ${coin.symbol})`, env, { force_reply: true, input_field_placeholder: `Amount in ${coin.symbol}, e.g. 0.01` }, null);
  }
  if (data === 'ms:amounts') return showMultiSendAmounts(chatId, draft, env, panelId);
  if (data.startsWith('ms:amt:')) return setMultiSendAmount(chatId, data.slice('ms:amt:'.length), env, panelId);
  if (data === 'ms:send') return executeMultiSend(chatId, draft, env, panelId);
}

async function setMultiSendRecipients(chatId: number, text: string, env: Env): Promise<void> {
  const draft = await readMultiSend(chatId, env);
  if (!draft) {
    await sendTelegramMessage(chatId, MULTISEND_EXPIRED, env);
    return;
  }
  const entries = text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
  const valid = [...new Set(entries.map((entry) => validRecipient(draft.chainId, entry)).filter((address): address is string => address !== null && address !== draft.from))];
  const invalid = entries.filter((entry) => validRecipient(draft.chainId, entry) === null);
  if (!valid.length) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('📤', 'No valid addresses'), `None of those are ${escapeTelegramHtml(multiSendCoin(draft.chainId).name)} addresses. Tap ✏️ Paste addresses to try again.`), env);
    return;
  }
  draft.recipients = valid.slice(0, MULTISEND_MAX_RECIPIENTS).map((address) => ({ address }));
  await saveMultiSend(chatId, draft, env);
  await showMultiSendAmounts(chatId, draft, env, undefined, invalid.length || valid.length > MULTISEND_MAX_RECIPIENTS
    ? `${invalid.length ? `${invalid.length} invalid address${invalid.length === 1 ? '' : 'es'} skipped. ` : ''}${valid.length > MULTISEND_MAX_RECIPIENTS ? `Only the first ${MULTISEND_MAX_RECIPIENTS} are used.` : ''}` : undefined);
}

async function showMultiSendAmounts(chatId: number, draft: MultiSendDraft, env: Env, panelId?: number, notice?: string): Promise<void> {
  const coin = multiSendCoin(draft.chainId);
  if (!draft.recipients.length) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('📤', 'No recipients'), 'Create more wallets in 💳 Wallets, or paste addresses.'), env, { inline_keyboard: [[{ text: '✏️ Paste addresses', callback_data: 'ms:to:paste' }, { text: '✖️ Cancel', callback_data: 'ms:cancel' }]] });
    return;
  }
  const presets = draft.chainId === NEAR_CHAIN_ID ? ['0.1', '0.5', '1', '5'] : getNetwork(draft.chainId)?.quickBuy.slice(0, 4) ?? ['0.01', '0.05', '0.1'];
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('📤', `Multi-send ${coin.symbol} · ${draft.recipients.length} recipient${draft.recipients.length === 1 ? '' : 's'}`),
    notice ? `<i>${escapeTelegramHtml(notice)}</i>` : null,
    tgCard(draft.recipients.slice(0, 12).map((recipient) => `${recipient.label ? `<b>${escapeTelegramHtml(recipient.label)}</b> ` : ''}<code>${escapeTelegramHtml(shortenTelegramAddress(recipient.address))}</code>`)
      .concat(draft.recipients.length > 12 ? [`+${draft.recipients.length - 12} more`] : [])),
    tgFootnote(`How much ${coin.symbol} should each address get?`),
  ), env, { inline_keyboard: [
    presets.map((amount) => ({ text: `${amount} ${coin.symbol}`, callback_data: `ms:amt:${amount}` })),
    [{ text: '✏️ Custom amount', callback_data: 'ms:custom' }, { text: '✖️ Cancel', callback_data: 'ms:cancel' }],
  ] });
}

async function setMultiSendAmount(chatId: number, amount: string, env: Env, panelId?: number): Promise<void> {
  const draft = await readMultiSend(chatId, env);
  if (!draft) {
    await sendTelegramPanel(chatId, panelId, MULTISEND_EXPIRED, env);
    return;
  }
  const coin = multiSendCoin(draft.chainId);
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(amount) || !(Number(amount) > 0)) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('📤', 'Amount not understood'), `Reply with just a number in ${coin.symbol}, e.g. <code>0.01</code>.`), env);
    return;
  }
  draft.amount = amount;
  await saveMultiSend(chatId, draft, env);
  const each = parseUnits(amount, coin.decimals);
  const total = each * BigInt(draft.recipients.length);
  // Fees for one transfer per recipient at today's gas price (NEAR keeps its fixed gas reserve).
  const [balance, reserve] = await Promise.all([
    quickNativeBalance(draft.chainId, draft.from, nearRpcOptions(env), 4_000),
    draft.chainId === NEAR_CHAIN_ID ? Promise.resolve(NEAR_MULTISEND_RESERVE) : gasReserve(draft.chainId, 'transfer', { count: draft.recipients.length }),
  ]);
  const short = balance !== null && balance < total + reserve;
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('📤', 'Send now?'),
    tgCard([
      `From  <b>${escapeTelegramHtml(draft.walletLabel)}</b> <code>${escapeTelegramHtml(shortenTelegramAddress(draft.from))}</code>`,
      `Each  <b>${escapeTelegramHtml(amount)} ${coin.symbol}</b> → ${draft.recipients.length} address${draft.recipients.length === 1 ? '' : 'es'} on ${escapeTelegramHtml(coin.name)}`,
      `Total  <b>${formatTokenAmount(total, coin.decimals)} ${coin.symbol}</b> + network fees`,
      balance !== null ? `Balance  ${formatTokenAmount(balance, coin.decimals)} ${coin.symbol}` : 'Balance  could not be read — the send fails safely if it is too low',
    ]),
    short ? `⚠️ <b>Not enough ${coin.symbol}</b> for the total plus fees. Fund the wallet or pick a smaller amount.` : '⚠️ Transfers can’t be reversed. Check the addresses.',
  ), env, { inline_keyboard: [
    ...(short ? [] : [[{ text: `✅ Send ${formatTokenAmount(total, coin.decimals)} ${coin.symbol}`, callback_data: 'ms:send' }]]),
    [{ text: '◀️ Change amount', callback_data: 'ms:amounts' }, { text: '✖️ Cancel', callback_data: 'ms:cancel' }],
  ] });
}

async function executeMultiSend(chatId: number, draft: MultiSendDraft, env: Env, panelId?: number): Promise<void> {
  if (!draft.amount || !draft.recipients.length) {
    await sendTelegramPanel(chatId, panelId, MULTISEND_EXPIRED, env, telegramWalletActionKeyboard());
    return;
  }
  // Consume first: a double tap can never send twice.
  await (env.TELEGRAM_STATE ?? env.CACHE)?.delete(multiSendKey(chatId)).catch(() => undefined);
  const coin = multiSendCoin(draft.chainId);
  if (panelId) await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⏳', `Sending to ${draft.recipients.length} addresses…`)), env);
  const rpcUrls = { evm: (id: number) => transactionRpc(id), solana: () => transactionRpc(1151111081099710), solanaBroadcast: solanaBroadcastRpcs };
  try {
    const { hashes } = await sendNativeMulti({
      userId: String(chatId), walletId: draft.walletId ?? undefined, chainId: draft.chainId,
      recipients: draft.recipients.map((recipient) => recipient.address), amountUnits: parseUnits(draft.amount, coin.decimals).toString(),
    }, rpcUrls, env);
    const explorer = TELEGRAM_EXPLORERS[draft.chainId];
    const links = hashes.slice(0, 10).map((hash, index) => explorer ? `<a href="${explorer}${encodeURIComponent(hash)}">${draft.chainId === 1151111081099710 ? `batch ${index + 1}` : `tx ${index + 1}`}</a>` : `<code>${escapeTelegramHtml(hash.slice(0, 12))}…</code>`);
    const accounts = await listWalletAccounts(String(chatId), env).catch(() => []);
    for (const account of accounts) forgetPortfolio({ evmAddress: account.evm_address, solanaAddress: account.solana_address, nearAddress: account.near_address });
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('✅', `Sent ${draft.amount} ${coin.symbol} to ${draft.recipients.length} address${draft.recipients.length === 1 ? '' : 'es'}`),
      links.length ? links.join(' · ') : null,
      tgFootnote('Transfers are on-chain; balances update within a minute.'),
    ), env, telegramWalletActionKeyboard());
  } catch (error) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⚠️', 'Multi-send stopped'), escapeTelegramHtml(error instanceof Error ? error.message : 'send failed')), env, telegramWalletActionKeyboard());
  }
}

// ---------------------------------------------------------------------------
// Wallet tracking alerts and copy trading (workers/walletWatch.ts reads the chains)
// ---------------------------------------------------------------------------

const KIND_ICON: Record<string, string> = { evm: '🔷', svm: '◎', near: 'Ⓝ' };
const COPY_LABEL: Record<CopyMode, string> = { off: 'off', buy: 'copies buys', buysell: 'copies buys + sells' };
const COPY_AMOUNTS = [10, 25, 50, 100, 250];
/** Copied trades chase moving prices; they never use less than this slippage. */
const COPY_MIN_SLIPPAGE_PERCENT = 3;
const TRACKING_MIGRATION_HINT = 'Wallet tracking needs migrations/0009_wallet_tracking.sql applied to the database.';
const isMissingTrackingTable = (error: unknown) => /no such table: (tracked_wallets|copy_trades)/.test(String(error));

async function listTrackedWallets(userId: string, env: Env): Promise<TrackedWallet[]> {
  if (!env.DB) return [];
  return (await env.DB.prepare(`SELECT * FROM tracked_wallets WHERE user_id = ?1 ORDER BY created_at ASC`).bind(userId).all<TrackedWallet>()).results ?? [];
}

async function promptTelegramTrack(chatId: number, env: Env): Promise<void> {
  await setPendingPrompt(chatId, { kind: 'track' }, env);
  await sendTelegramMessage(chatId, `${TELEGRAM_TRACK_PROMPT} (EVM, Solana or NEAR) and an optional name`, env, {
    force_reply: true,
    input_field_placeholder: '0x… / base58 / name.near  then a name',
  }, null);
}

async function addTelegramTrackedWallet(chatId: number, input: string, env: Env): Promise<void> {
  const [rawAddress = '', ...nameParts] = input.trim().split(/\s+/);
  const kind = walletKind(rawAddress);
  if (!kind) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('👀', 'Not a wallet address'), 'Send an EVM <code>0x…</code>, Solana or NEAR (<code>name.near</code>) address, then an optional name. Example: <code>/track 0xabc… Whale</code>'), env);
    return;
  }
  if (!env.DB) {
    await sendTelegramMessage(chatId, '🧩 Wallet tracking needs the DB binding.', env);
    return;
  }
  const userId = String(chatId);
  const address = normalizeWalletAddress(rawAddress, kind);
  const name = nameParts.join(' ').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 20);
  try {
    const existing = await listTrackedWallets(userId, env);
    if (existing.some((wallet) => wallet.address === address)) {
      await showTelegramTracking(chatId, env, undefined, 'You already track that wallet.');
      return;
    }
    if (existing.length >= MAX_TRACKED_PER_USER) {
      await showTelegramTracking(chatId, env, undefined, `You can track up to ${MAX_TRACKED_PER_USER} wallets. Remove one first.`);
      return;
    }
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO tracked_wallets (id, user_id, address, kind, label, alerts, copy_mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 'off', ?6, ?6)`)
      .bind(crypto.randomUUID().replace(/-/g, '').slice(0, 10), userId, address, kind, name || `Wallet ${existing.length + 1}`, now).run();
  } catch (error) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'Not tracked'), escapeTelegramHtml(isMissingTrackingTable(error) ? TRACKING_MIGRATION_HINT : 'The wallet could not be saved.')), env);
    return;
  }
  await showTelegramTracking(chatId, env, undefined, `👀 Tracking ${escapeTelegramHtml(name || shortenTelegramAddress(address))}. You'll get an alert within a minute of its next buy or sell.`);
}

async function removeTelegramTrackedWallet(chatId: number, needle: string, env: Env, panelId?: number): Promise<void> {
  const wallets = await listTrackedWallets(String(chatId), env).catch(() => []);
  const target = wallets.find((wallet) => wallet.id === needle || wallet.address === needle.toLowerCase() || wallet.address === needle || wallet.label.toLowerCase() === needle.toLowerCase());
  if (target && env.DB) await env.DB.prepare(`DELETE FROM tracked_wallets WHERE id = ?1 AND user_id = ?2`).bind(target.id, String(chatId)).run();
  await showTelegramTracking(chatId, env, panelId, target ? `Stopped tracking ${escapeTelegramHtml(target.label)}.` : 'No tracked wallet matches that.');
}

async function showTelegramTracking(chatId: number, env: Env, panelId?: number, notice?: string): Promise<void> {
  let wallets: TrackedWallet[];
  try {
    wallets = await listTrackedWallets(String(chatId), env);
  } catch (error) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('👀', 'Wallet tracking'), escapeTelegramHtml(isMissingTrackingTable(error) ? TRACKING_MIGRATION_HINT : 'Tracking could not be loaded.')), env, telegramActionKeyboard());
    return;
  }
  const lines = wallets.map((wallet) => `${KIND_ICON[wallet.kind]} <b>${escapeTelegramHtml(wallet.label)}</b>  <code>${escapeTelegramHtml(shortenTelegramAddress(wallet.address))}</code> · ${wallet.alerts ? '🔔' : '🔕'}${wallet.copy_mode !== 'off' ? ` · 🤖 $${wallet.copy_amount_usd ?? 0} ${COPY_LABEL[wallet.copy_mode]}` : ''}`);
  const buttons = wallets.map((wallet) => ({ text: `${KIND_ICON[wallet.kind]} ${wallet.label.slice(0, 14)}`, callback_data: `track:v:${wallet.id}` }));
  const rows: TelegramButton[][] = [];
  for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3));
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('👀', 'Wallet tracking', `Alerts within a minute when a wallet buys or sells · ${wallets.length}/${MAX_TRACKED_PER_USER}`),
    notice ? `<b>${notice}</b>` : null,
    wallets.length ? tgCard(lines) : tgCard(['No wallets tracked yet', 'Tap ➕ Track wallet, or send /track &lt;address&gt; [name]']),
    tgFootnote('Tap a wallet to toggle alerts, set up 🤖 copy trading or stop tracking. Tokens without a real market (airdrop spam) are ignored.'),
  ), env, { inline_keyboard: [...rows, [{ text: '➕ Track wallet', callback_data: 'track:add' }, { text: '◀️ Menu', callback_data: 'menu' }]] });
}

async function handleTrackCallback(chatId: number, data: string, env: Env, panelId?: number): Promise<void> {
  const [, action, id, mode, usd] = data.split(':');
  const userId = String(chatId);
  const wallet = (await listTrackedWallets(userId, env).catch(() => [])).find((item) => item.id === id);
  if (!wallet || !env.DB) return showTelegramTracking(chatId, env, panelId, 'That wallet is no longer tracked.');
  const save = (sql: string, ...values: unknown[]) => env.DB!.prepare(sql).bind(...values, wallet.id, userId).run();
  if (action === 'del') return removeTelegramTrackedWallet(chatId, wallet.id, env, panelId);
  if (action === 'alerts') {
    await save(`UPDATE tracked_wallets SET alerts = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4`, wallet.alerts ? 0 : 1, Date.now());
    return showTrackedWallet(chatId, { ...wallet, alerts: wallet.alerts ? 0 : 1 }, env, panelId);
  }
  if (action === 'copy') {
    return sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🤖', `Copy trading · ${escapeTelegramHtml(wallet.label)}`, 'Mirror this wallet’s trades from your Hopr wallet.'),
      tgCard([
        '<b>Copy buys</b> — when it buys a token, you buy it too, for a fixed USD amount in that chain’s coin',
        '<b>Buys + sells</b> — also sells the same share of your position when it sells',
        `Limits: ${MAX_COPY_TRADES_PER_DAY} copied trades a day · tokens under $${MIN_COPY_LIQUIDITY_USD.toLocaleString('en-US')} liquidity are skipped · ≥${COPY_MIN_SLIPPAGE_PERCENT}% slippage`,
      ]),
    ), env, { inline_keyboard: [
      [{ text: '🟢 Copy buys', callback_data: `track:cm:${wallet.id}:buy` }, { text: '🔁 Buys + sells', callback_data: `track:cm:${wallet.id}:buysell` }],
      [{ text: '⏹ Copy off', callback_data: `track:cm:${wallet.id}:off` }, { text: '◀️ Back', callback_data: `track:v:${wallet.id}` }],
    ] });
  }
  if (action === 'cm') {
    if (mode === 'off') {
      await save(`UPDATE tracked_wallets SET copy_mode = 'off', updated_at = ?1 WHERE id = ?2 AND user_id = ?3`, Date.now());
      return showTrackedWallet(chatId, { ...wallet, copy_mode: 'off' }, env, panelId, 'Copy trading is off for this wallet.');
    }
    return sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🤖', `How much per copied buy?`, `${escapeTelegramHtml(wallet.label)} · ${COPY_LABEL[mode as CopyMode]}`),
      'Paid in the coin of the token’s chain (ETH, SOL, BNB, NEAR…) from your active Hopr wallet.',
    ), env, { inline_keyboard: [
      COPY_AMOUNTS.map((amount) => ({ text: `$${amount}`, callback_data: `track:ca:${wallet.id}:${mode}:${amount}` })),
      [{ text: '◀️ Back', callback_data: `track:copy:${wallet.id}` }],
    ] });
  }
  if (action === 'ca') {
    return sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🤖', 'Turn on copy trading?'),
      tgCard([
        `Leader  <b>${escapeTelegramHtml(wallet.label)}</b> <code>${escapeTelegramHtml(shortenTelegramAddress(wallet.address))}</code>`,
        `Mode  <b>${COPY_LABEL[mode as CopyMode]}</b>`,
        `Per buy  <b>$${usd}</b> in the token chain’s coin · from your ✅ wallet on that chain`,
        `Fee  ${HOPR_FEE_PERCENT}% per trade · slippage ≥${COPY_MIN_SLIPPAGE_PERCENT}%`,
      ]),
      `⚠️ <b>Trades execute automatically.</b> Each time this wallet ${mode === 'buysell' ? 'buys or sells' : 'buys'}, Hopr signs and sends the matching trade without asking again. Copying is checked every minute, so your price will differ from theirs. Copy only wallets you trust; tokens can be scams.`,
    ), env, { inline_keyboard: [[{ text: '✅ Start copying', callback_data: `track:ok:${wallet.id}:${mode}:${usd}` }, { text: '✖️ Cancel', callback_data: `track:v:${wallet.id}` }]] });
  }
  if (action === 'ok') {
    // No fixed wallet: each copied trade uses the user's default wallet for the leader's chain.
    await save(`UPDATE tracked_wallets SET copy_mode = ?1, copy_amount_usd = ?2, copy_wallet_id = ?3, updated_at = ?4 WHERE id = ?5 AND user_id = ?6`, mode, Number(usd), null, Date.now());
    return showTrackedWallet(chatId, { ...wallet, copy_mode: mode as CopyMode, copy_amount_usd: Number(usd), copy_wallet_id: null }, env, panelId, `🤖 Copying ${escapeTelegramHtml(wallet.label)}: $${usd} per buy${mode === 'buysell' ? ', sells mirrored' : ''}.`);
  }
  return showTrackedWallet(chatId, wallet, env, panelId);
}

async function showTrackedWallet(chatId: number, wallet: TrackedWallet, env: Env, panelId?: number, notice?: string): Promise<void> {
  const explorer = wallet.kind === 'near' ? `https://nearblocks.io/address/${wallet.address}` : wallet.kind === 'svm' ? `https://solscan.io/account/${wallet.address}` : `https://debank.com/profile/${wallet.address}`;
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('👀', escapeTelegramHtml(wallet.label)),
    notice ? `<b>${notice}</b>` : null,
    tgCard([
      `<code>${escapeTelegramHtml(wallet.address)}</code>`,
      `Alerts  ${wallet.alerts ? '🔔 on' : '🔕 off'}`,
      `Copy trading  ${wallet.copy_mode === 'off' ? 'off' : `🤖 ${COPY_LABEL[wallet.copy_mode]} · $${wallet.copy_amount_usd ?? 0} per buy`}`,
    ]),
  ), env, { inline_keyboard: [
    [{ text: wallet.alerts ? '🔕 Mute alerts' : '🔔 Alerts on', callback_data: `track:alerts:${wallet.id}` }, { text: '🤖 Copy trading', callback_data: `track:copy:${wallet.id}` }],
    [{ text: '🔎 Explorer', url: explorer }, { text: '🗑 Stop tracking', callback_data: `track:del:${wallet.id}` }],
    [{ text: '◀️ All wallets', callback_data: 'track' }],
  ] });
}

/** Mirror one leader trade from the copier's Hopr wallet. */
async function executeCopyTrade(tracker: TrackedWallet, trade: WalletTrade, env: Env): Promise<{ txHash: string; explorerUrl?: string }> {
  const userId = tracker.user_id;
  if (!env.ENCRYPTION_KEY || !env.TELEGRAM_STATE) throw new Error('Trading is not configured on this bot.');
  const accounts = await listWalletAccounts(userId, env);
  const pinned = tracker.copy_wallet_id ? accounts.find((account) => account.id === tracker.copy_wallet_id) : null;
  const row = (pinned && walletAddressOn(pinned, walletChainOf(trade.chainId)) ? pinned : null) ?? walletForChain(accounts, trade.chainId);
  const legacy = row ? null : await getCustodialWallet(userId, env);
  const wallet = row ? walletAddresses(row) : legacy;
  if (!wallet) throw new Error('No Hopr wallet to copy with.');
  const walletId = row?.id;
  const profile = await readTelegramProfile(Number(userId), env).catch(() => null);
  const slippage = Math.max(profile?.slippagePercent ?? 1, COPY_MIN_SLIPPAGE_PERCENT) / 100;
  const rpc = nearRpcOptions(env);
  const isNear = trade.chainId === NEAR_CHAIN_ID;
  const chain = isNear ? null : getChainById(trade.chainId);
  if (!isNear && !chain) throw new Error('Unsupported chain.');
  const owner = isNear ? wallet.nearAddress : chain!.type === 'SVM' ? wallet.solanaAddress : wallet.evmAddress;
  if (!owner) throw new Error('Your wallet has no account on this chain yet.');
  let trade_: PendingTrade;
  if (trade.side === 'buy') {
    const prices = await nativePricesUsd();
    const symbol = isNear ? 'NEAR' : chain!.nativeSymbol;
    const coinPrice = symbol === 'USDC' ? 1 : prices[symbol];
    if (!coinPrice) throw new Error(`No ${symbol} price right now.`);
    const coins = (tracker.copy_amount_usd ?? 25) / coinPrice;
    if (isNear) {
      const metadata = await getTokenMetadata(trade.token, rpc);
      trade_ = await prepareNearSwap({ userId, kind: 'buy', tokenIn: NEAR_TOKEN, tokenOut: { id: trade.token, symbol: metadata.symbol, decimals: metadata.decimals }, amountInUnits: parseUnits(coins.toFixed(6), NEAR_DECIMALS).toString(), slippage, walletId }, env);
    } else {
      const units = decimalToUnits(coins.toFixed(9), chain!.type === 'SVM' ? 9 : 18);
      const balance = await quickNativeBalance(chain!.id, owner, rpc, 5_000);
      if (balance !== null && balance <= BigInt(units)) throw new Error(`not enough ${symbol} on ${chain!.name} in ${row?.label ?? 'your wallet'}`);
      trade_ = await prepareBuy({ userId, wallet, fundingChainKey: chain!.key, fundingTokenAddress: 'native', fundingAmountUnits: units, targetChainId: chain!.id, targetTokenAddress: trade.token, slippage, walletId }, env);
    }
  } else {
    const held = await quickTokenBalance(trade.chainId, trade.token, owner, rpc, 5_000);
    if (!held || BigInt(held.amount) === 0n) throw new Error(`you hold no ${trade.symbol}`);
    // Sell the share of their position they sold (all of it when the rest is unknown).
    const sold = BigInt(trade.amount);
    const remaining = trade.remaining !== undefined ? BigInt(trade.remaining) : 0n;
    const shareBps = sold + remaining > 0n ? (sold * 10_000n) / (sold + remaining) : 10_000n;
    const amount = (BigInt(held.amount) * (shareBps > 10_000n ? 10_000n : shareBps)) / 10_000n;
    if (amount <= 0n) throw new Error('nothing to sell');
    if (isNear) {
      const metadata = await getTokenMetadata(trade.token, rpc);
      trade_ = await prepareNearSwap({ userId, kind: 'sell', tokenIn: { id: trade.token, symbol: metadata.symbol, decimals: metadata.decimals }, tokenOut: NEAR_TOKEN, amountInUnits: amount.toString(), slippage, walletId }, env);
    } else {
      trade_ = await prepareTokenSell({ userId, wallet, walletId, chainId: trade.chainId, tokenAddress: trade.token, amountUnits: amount.toString(), slippage }, env);
    }
  }
  const result = await confirmTrade(userId, trade_.id, { evm: (chainId: number) => transactionRpc(chainId), solana: () => transactionRpc(1151111081099710), solanaBroadcast: solanaBroadcastRpcs }, env);
  await recordTelegramReferral(userId, result, env);
  forgetPortfolio(wallet);
  const explorer = TELEGRAM_EXPLORERS[result.venue === 'ref' ? NEAR_CHAIN_ID : result.fromChainId ?? trade.chainId];
  return { txHash: result.txHash, explorerUrl: explorer ? `${explorer}${encodeURIComponent(result.txHash)}` : undefined };
}

function leaderTxLink(trade: WalletTrade): string | null {
  if (trade.txHash.startsWith('near:')) return `https://nearblocks.io/address/${trade.address}`;
  const explorer = TELEGRAM_EXPLORERS[trade.chainId];
  return explorer ? `${explorer}${encodeURIComponent(trade.txHash)}` : null;
}

/** The cron job for tracking: alerts and copy trades. Exported for tests. */
export function watchWallets(env: Env) {
  return runWalletWatch(env, {
    latestBlock: latestEvmBlock,
    evmTrades: fetchEvmTrades,
    solanaTrades: fetchSolanaTrades,
    nearTrades: (accountId, previous) => fetchNearTrades(accountId, previous, nearRpcOptions(env)),
    markets: async (chainId, tokens) => {
      const found = await chainMarkets(chainId, tokens);
      return new Map([...found].map(([address, market]) => [address, { priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd, symbol: market.symbol }]));
    },
    alert: async (tracker, trade) => {
      const verb = trade.side === 'buy' ? '🟢 bought' : '🔴 sold';
      const link = leaderTxLink(trade);
      const tokenButton = `token:refresh:${trade.token}`.length <= 64 ? [{ text: `📈 Trade ${trade.symbol.slice(0, 12)}`, callback_data: `token:refresh:${trade.token}` }] : [];
      await sendTelegramMessage(Number(tracker.user_id), tgMessage(
        `👀 <b>${escapeTelegramHtml(tracker.label)}</b> ${verb} <b>${escapeTelegramHtml(trade.symbol)}</b> ${chainEmoji(trade.chainId)}`,
        tgCard([
          `${formatTokenAmount(trade.amount, trade.decimals)} ${escapeTelegramHtml(trade.symbol)} · ≈ <b>${formatUsdValue(trade.valueUsd ?? 0)}</b>`,
          `Price ${formatTokenPriceUsd(trade.priceUsd ?? 0)} · Liquidity ${formatCompactUsd(trade.liquidityUsd ?? 0)}`,
          `<code>${escapeTelegramHtml(trade.token)}</code>`,
        ]),
      ), env, { inline_keyboard: [[...tokenButton, ...(link ? [{ text: '🔎 Transaction', url: link }] : [])], [{ text: '👀 Tracking', callback_data: 'track' }]] });
    },
    copy: (tracker, trade) => executeCopyTrade(tracker, trade, env),
    copyResult: async (tracker, trade, outcome) => {
      const what = `${trade.side === 'buy' ? 'buy' : 'sell'} of <b>${escapeTelegramHtml(trade.symbol)}</b>`;
      const text = outcome.status === 'filled'
        ? tgMessage(`🤖 <b>Copied ${escapeTelegramHtml(tracker.label)}'s ${what}</b>`, tgCard([`Transaction  ${outcome.explorerUrl ? `<a href="${outcome.explorerUrl}">${escapeTelegramHtml(outcome.txHash.slice(0, 12))}…</a>` : `<code>${escapeTelegramHtml(outcome.txHash)}</code>`}`]))
        : tgMessage(`🤖 <b>${outcome.status === 'skipped' ? 'Skipped' : 'Could not copy'} ${escapeTelegramHtml(tracker.label)}'s ${what}</b>`, escapeTelegramHtml(outcome.reason));
      await sendTelegramMessage(Number(tracker.user_id), text, env, { inline_keyboard: [[{ text: '💼 Portfolio', callback_data: 'positions:fresh' }, { text: '👀 Tracking', callback_data: 'track' }]] });
    },
  });
}

// ---------------------------------------------------------------------------
// Limit sell · take profit · stop loss (workers/orders.ts holds the order book and sweep)
// ---------------------------------------------------------------------------

const ORDER_ICON: Record<OrderKind, string> = { limit: '🎯', tp: '📈', sl: '🛑' };
const ORDER_PRESETS: Record<OrderKind, number[]> = { limit: [10, 25, 50, 100], tp: [25, 50, 100, 200], sl: [10, 20, 30, 50] };
const ORDER_DRAFT_TTL_SECONDS = 15 * 60;
const orderDraftKey = (chatId: number) => `orderdraft:v1:${chatId}`;

interface OrderDraft {
  kind: OrderKind; chainId: number; tokenAddress: string; symbol: string; referencePriceUsd: number;
  triggerPriceUsd?: number; sellPercent?: number; walletId: string | null; walletLabel: string; slippage: number;
}

const ORDERS_MIGRATION_HINT = 'Orders need migrations/0008_limit_orders.sql applied to the database.';
const isMissingOrdersTable = (error: unknown) => /no such table: limit_orders/.test(String(error));

/** Live USD prices for tokens on one chain: DexScreener / DefiLlama in one request, the full scanner for the rest. */
async function orderPrices(chainId: number, addresses: string[]): Promise<Map<string, number>> {
  const markets = await chainMarkets(chainId, addresses).catch(() => new Map<string, { priceUsd: number }>());
  const out = new Map<string, number>();
  for (const [address, market] of markets) if (market.priceUsd > 0) out.set(address.toLowerCase(), market.priceUsd);
  const missing = addresses.filter((address) => !out.has(address.toLowerCase())).slice(0, 10);
  await Promise.all(missing.map(async (address) => {
    const detected = await detectTokenOnChain(address, chainId).catch(() => null);
    if (detected && detected.priceUsd > 0 && detected.marketStatus !== 'stale') out.set(address.toLowerCase(), detected.priceUsd);
  }));
  return out;
}

function formatOrderTrigger(order: Pick<LimitOrder, 'kind' | 'trigger_price_usd' | 'reference_price_usd'>): string {
  const change = ((order.trigger_price_usd / order.reference_price_usd) - 1) * 100;
  const sign = change >= 0 ? '+' : '−';
  return `${order.kind === 'sl' ? '≤' : '≥'} ${formatTokenPriceUsd(order.trigger_price_usd)} (${sign}${Number(Math.abs(change).toFixed(1))}%)`;
}

async function startTelegramOrder(chatId: number, kind: OrderKind, env: Env, panelId?: number): Promise<void> {
  const userId = String(chatId);
  const [profile, accounts] = await Promise.all([readTelegramProfile(chatId, env).catch(() => null), listWalletAccounts(userId, env)]);
  if (!profile?.lastTokenAddress || !profile.lastTokenChainId) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle(ORDER_ICON[kind], 'Pick a token first'), `Paste a token address, then tap ${ORDER_ICON[kind]} ${ORDER_LABEL[kind]} on its card.`), env, telegramActionKeyboard());
    return;
  }
  const wallet = walletForChain(accounts, profile.lastTokenChainId);
  const legacy = wallet ? null : await getCustodialWallet(userId, env).catch(() => null);
  if (!wallet && !legacy) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle(ORDER_ICON[kind], 'Orders need a Hopr wallet'), 'Create one in 💳 Wallets first.'), env, telegramWalletSetupKeyboard());
    return;
  }
  const prices = await orderPrices(profile.lastTokenChainId, [profile.lastTokenAddress]);
  const price = prices.get(profile.lastTokenAddress.toLowerCase());
  const symbol = profile.lastTokenSymbol ?? 'token';
  if (!price) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle(ORDER_ICON[kind], ORDER_LABEL[kind]), `No live price for ${escapeTelegramHtml(symbol)} right now — orders need one to trigger. Try again in a moment.`), env, { inline_keyboard: [[{ text: '◀️ Back to token', callback_data: 'token:refresh:last' }]] });
    return;
  }
  const draft: OrderDraft = {
    kind, chainId: profile.lastTokenChainId, tokenAddress: profile.lastTokenAddress, symbol, referencePriceUsd: price,
    walletId: wallet?.id ?? null, walletLabel: wallet?.label ?? 'W1', slippage: (profile.slippagePercent ?? 1) / 100,
  };
  await (env.TELEGRAM_STATE ?? env.CACHE)?.put(orderDraftKey(chatId), JSON.stringify(draft), { expirationTtl: ORDER_DRAFT_TTL_SECONDS });
  const sign = kind === 'sl' ? '−' : '+';
  const what = kind === 'sl' ? 'Sells automatically if the price falls to the level you pick — limits your loss.'
    : kind === 'tp' ? 'Sells automatically once the price rises to the level you pick — locks in profit.'
      : 'Sells automatically once the price reaches your target price.';
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle(ORDER_ICON[kind], `${ORDER_LABEL[kind]} · ${escapeTelegramHtml(symbol)}`, what),
    tgCard([`Price now  <b>${formatTokenPriceUsd(price)}</b>`, `Wallet  <b>${escapeTelegramHtml(draft.walletLabel)}</b> (active)`]),
    tgFootnote('Pick the trigger, relative to the price now.'),
  ), env, { inline_keyboard: [
    ORDER_PRESETS[kind].map((percent) => ({ text: `${sign}${percent}%`, callback_data: `order:at:${kind}:${percent}` })),
    ...(kind === 'limit' ? [[{ text: '✏️ Exact price', callback_data: 'order:price' }]] : []),
    [{ text: '✖️ Cancel', callback_data: 'order:discard' }],
  ] });
}

async function readOrderDraft(chatId: number, env: Env): Promise<OrderDraft | null> {
  const raw = await (env.TELEGRAM_STATE ?? env.CACHE)?.get(orderDraftKey(chatId)).catch(() => null);
  try {
    return raw ? JSON.parse(raw) as OrderDraft : null;
  } catch {
    return null;
  }
}

async function saveOrderDraft(chatId: number, draft: OrderDraft, env: Env): Promise<void> {
  await (env.TELEGRAM_STATE ?? env.CACHE)?.put(orderDraftKey(chatId), JSON.stringify(draft), { expirationTtl: ORDER_DRAFT_TTL_SECONDS });
}

const ORDER_EXPIRED = tgMessage(tgTitle('⌛', 'Order setup expired'), 'Open the token again and tap 🎯 / 📈 / 🛑 to start over.');

async function setTelegramOrderTrigger(chatId: number, kind: OrderKind, percent: number, env: Env, panelId?: number): Promise<void> {
  const draft = await readOrderDraft(chatId, env);
  if (!draft || draft.kind !== kind || !(percent > 0) || (kind === 'sl' && percent >= 100)) {
    await sendTelegramPanel(chatId, panelId, ORDER_EXPIRED, env, telegramActionKeyboard());
    return;
  }
  draft.triggerPriceUsd = draft.referencePriceUsd * (kind === 'sl' ? 1 - percent / 100 : 1 + percent / 100);
  await saveOrderDraft(chatId, draft, env);
  await showOrderSizes(chatId, draft, env, panelId);
}

async function promptTelegramOrderPrice(chatId: number, env: Env): Promise<void> {
  const draft = await readOrderDraft(chatId, env);
  if (!draft) {
    await sendTelegramMessage(chatId, ORDER_EXPIRED, env);
    return;
  }
  await sendTelegramMessage(chatId, `${TELEGRAM_ORDER_PRICE_PROMPT} ${draft.symbol} at (now ${formatTokenPriceUsd(draft.referencePriceUsd)})`, env, {
    force_reply: true,
    input_field_placeholder: 'USD price, e.g. 0.0042',
  }, null);
}

async function setTelegramOrderPrice(chatId: number, text: string, env: Env): Promise<void> {
  const draft = await readOrderDraft(chatId, env);
  const price = Number(text.trim().replace(/^\$/, '').replace(',', '.'));
  if (!draft) {
    await sendTelegramMessage(chatId, ORDER_EXPIRED, env);
    return;
  }
  if (!Number.isFinite(price) || price <= 0) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('🎯', 'Price not understood'), 'Reply with just a number in USD, e.g. <code>0.0042</code>. Tap ✏️ Exact price to try again.'), env);
    return;
  }
  if (price <= draft.referencePriceUsd) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('🎯', 'Target is below the price now'), `A limit sell triggers when the price rises to it. ${escapeTelegramHtml(draft.symbol)} is at ${formatTokenPriceUsd(draft.referencePriceUsd)} — use 🛑 Stop loss to sell on the way down.`), env);
    return;
  }
  draft.triggerPriceUsd = price;
  await saveOrderDraft(chatId, draft, env);
  await showOrderSizes(chatId, draft, env);
}

async function showOrderSizes(chatId: number, draft: OrderDraft, env: Env, panelId?: number): Promise<void> {
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle(ORDER_ICON[draft.kind], `${ORDER_LABEL[draft.kind]} · ${escapeTelegramHtml(draft.symbol)}`),
    tgCard([`Trigger  <b>${formatOrderTrigger({ kind: draft.kind, trigger_price_usd: draft.triggerPriceUsd!, reference_price_usd: draft.referencePriceUsd })}</b>`, `Price now  ${formatTokenPriceUsd(draft.referencePriceUsd)}`]),
    tgFootnote(`How much of ${escapeTelegramHtml(draft.walletLabel)}'s ${escapeTelegramHtml(draft.symbol)} should it sell?`),
  ), env, { inline_keyboard: [
    [25, 50, 100].map((size) => ({ text: `🔴 Sell ${size}%`, callback_data: `order:size:${size}` })),
    [{ text: '✖️ Cancel', callback_data: 'order:discard' }],
  ] });
}

async function reviewTelegramOrder(chatId: number, size: number, env: Env, panelId?: number): Promise<void> {
  const draft = await readOrderDraft(chatId, env);
  if (!draft?.triggerPriceUsd) {
    await sendTelegramPanel(chatId, panelId, ORDER_EXPIRED, env, telegramActionKeyboard());
    return;
  }
  draft.sellPercent = size;
  await saveOrderDraft(chatId, draft, env);
  const chainName = TELEGRAM_CHAIN_NAMES[draft.chainId] ?? 'its chain';
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle(ORDER_ICON[draft.kind], `Place ${ORDER_LABEL[draft.kind].toLowerCase()}?`),
    tgCard([
      `Token  <b>${escapeTelegramHtml(draft.symbol)}</b> on ${escapeTelegramHtml(chainName)}`,
      `When  price <b>${formatOrderTrigger({ kind: draft.kind, trigger_price_usd: draft.triggerPriceUsd, reference_price_usd: draft.referencePriceUsd })}</b>`,
      `Sell  <b>${size}%</b> of what ${escapeTelegramHtml(draft.walletLabel)} holds then · into ${draft.chainId === NEAR_CHAIN_ID ? 'NEAR' : escapeTelegramHtml(getChainById(draft.chainId)?.nativeSymbol ?? 'the native coin')}`,
      `Slippage  ${Number((draft.slippage * 100).toFixed(2))}% · platform fee ${HOPR_FEE_PERCENT}%`,
    ]),
    `⚠️ <b>Executes automatically.</b> When the price triggers, Hopr signs and sends this sell without asking again. Prices are checked every minute, so the fill can differ from the trigger in fast markets.`,
  ), env, { inline_keyboard: [[{ text: '✅ Place order', callback_data: 'order:place' }, { text: '✖️ Cancel', callback_data: 'order:discard' }]] });
}

async function placeTelegramOrder(chatId: number, env: Env, panelId?: number): Promise<void> {
  const draft = await readOrderDraft(chatId, env);
  if (!draft?.triggerPriceUsd || !draft.sellPercent) {
    await sendTelegramPanel(chatId, panelId, ORDER_EXPIRED, env, telegramActionKeyboard());
    return;
  }
  try {
    await createOrder(env, {
      userId: String(chatId), walletId: draft.walletId, chainId: draft.chainId, tokenAddress: draft.tokenAddress, symbol: draft.symbol, kind: draft.kind,
      triggerPriceUsd: draft.triggerPriceUsd, referencePriceUsd: draft.referencePriceUsd, sellPercent: draft.sellPercent, slippage: draft.slippage,
    });
  } catch (error) {
    const message = isMissingOrdersTable(error) ? ORDERS_MIGRATION_HINT : error instanceof Error ? error.message : 'Order not placed';
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⚠️', 'Order not placed'), escapeTelegramHtml(message)), env, telegramActionKeyboard());
    return;
  }
  await (env.TELEGRAM_STATE ?? env.CACHE)?.delete(orderDraftKey(chatId)).catch(() => undefined);
  await showTelegramOrders(chatId, env, panelId, `✅ ${ORDER_LABEL[draft.kind]} placed for ${escapeTelegramHtml(draft.symbol)}.`);
}

async function showTelegramOrders(chatId: number, env: Env, panelId?: number, notice?: string): Promise<void> {
  let orders: Awaited<ReturnType<typeof listOrders>>;
  try {
    orders = await listOrders(env, String(chatId));
  } catch (error) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('🎯', 'Orders'), escapeTelegramHtml(isMissingOrdersTable(error) ? ORDERS_MIGRATION_HINT : 'Orders could not be loaded.')), env, telegramActionKeyboard());
    return;
  }
  const line = (order: LimitOrder) => `${ORDER_ICON[order.kind]} <b>${escapeTelegramHtml(order.symbol)}</b> ${chainEmoji(order.chain_id)} · sell ${order.sell_percent}% ${formatOrderTrigger(order)}${order.status === 'executing' ? ' · <i>selling…</i>' : order.attempts > 0 ? ` · <i>retrying</i>` : ''}`;
  const done = (order: LimitOrder) => `${order.status === 'filled' ? '✅' : '⚠️'} ${escapeTelegramHtml(ORDER_LABEL[order.kind])} · <b>${escapeTelegramHtml(order.symbol)}</b>${order.status === 'failed' && order.error ? ` · <i>${escapeTelegramHtml(order.error.slice(0, 80))}</i>` : ''}`;
  const cancelButtons = orders.open.filter((order) => order.status === 'active').slice(0, 10).map((order) => ({ text: `✖️ ${ORDER_ICON[order.kind]} ${order.symbol.slice(0, 10)}`, callback_data: `order:cancel:${order.id}` }));
  const rows: TelegramButton[][] = [];
  for (let index = 0; index < cancelButtons.length; index += 2) rows.push(cancelButtons.slice(index, index + 2));
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('🎯', 'Orders', 'Limit sell · take profit · stop loss — checked every minute'),
    notice ? `<b>${notice}</b>` : null,
    orders.open.length ? tgCard(orders.open.map(line)) : tgCard(['No open orders', 'Open a token and tap 🎯 Limit sell, 📈 Take profit or 🛑 Stop loss']),
    orders.recent.length ? `<b>Recent</b>\n${tgCard(orders.recent.map(done))}` : null,
    tgFootnote('Triggered orders sell automatically from the wallet they were placed with.'),
  ), env, { inline_keyboard: [...rows, [{ text: '🔄 Refresh', callback_data: 'orders' }, { text: '💼 Portfolio', callback_data: 'positions' }, { text: '◀️ Menu', callback_data: 'menu' }]] });
}

/** Sells a triggered order from its wallet: the chosen share of the live balance, quoted and signed now. */
async function executeOrder(order: LimitOrder, env: Env): Promise<{ txHash: string; explorerUrl?: string }> {
  const userId = order.user_id;
  if (!env.ENCRYPTION_KEY || !env.TELEGRAM_STATE) throw new OrderError('Trading is not configured on this bot.', true);
  const accounts = await listWalletAccounts(userId, env);
  const row = order.wallet_id ? accounts.find((account) => account.id === order.wallet_id) : null;
  if (order.wallet_id && !row) throw new OrderError('The wallet this order was placed with no longer exists.', true);
  const legacy = row ? null : await getCustodialWallet(userId, env);
  const wallet = row ? walletAddresses(row) : legacy;
  if (!wallet) throw new OrderError('No Hopr wallet on file.', true);
  const isNear = order.chain_id === NEAR_CHAIN_ID;
  const owner = isNear ? wallet.nearAddress ?? null : order.chain_id === 1151111081099710 ? wallet.solanaAddress : wallet.evmAddress;
  if (!owner) throw new OrderError('The wallet has no account on this chain.', true);
  const rpc = nearRpcOptions(env);
  const held = await quickTokenBalance(order.chain_id, order.token_address, owner, rpc, 6_000);
  if (held === null) throw new OrderError('The token balance could not be read.');
  const amount = (BigInt(held.amount) * BigInt(order.sell_percent)) / 100n;
  if (amount <= 0n) throw new OrderError(`The wallet holds no ${order.symbol} any more.`, true);
  const walletId = order.wallet_id ?? undefined;
  const trade = isNear
    ? await (async () => {
      const metadata = await getTokenMetadata(order.token_address, rpc);
      return prepareNearSwap({ userId, kind: 'sell', tokenIn: { id: order.token_address, symbol: metadata.symbol, decimals: metadata.decimals }, tokenOut: NEAR_TOKEN, amountInUnits: amount.toString(), slippage: order.slippage, walletId }, env);
    })()
    : await prepareTokenSell({ userId, wallet, walletId, chainId: order.chain_id, tokenAddress: order.token_address, amountUnits: amount.toString(), slippage: order.slippage }, env);
  const result = await confirmTrade(userId, trade.id, { evm: (chainId: number) => transactionRpc(chainId), solana: () => transactionRpc(1151111081099710), solanaBroadcast: solanaBroadcastRpcs }, env);
  await recordTelegramReferral(userId, result, env);
  forgetPortfolio(wallet);
  const explorer = TELEGRAM_EXPLORERS[result.venue === 'ref' ? NEAR_CHAIN_ID : result.fromChainId ?? order.chain_id];
  return { txHash: result.txHash, explorerUrl: explorer ? `${explorer}${encodeURIComponent(result.txHash)}` : undefined };
}

/** The cron job: one pass over every active order. Exported for tests. */
export function sweepOrders(env: Env) {
  return runOrderSweep(env, {
    prices: orderPrices,
    execute: (order) => executeOrder(order, env),
    notify: async (order, outcome) => {
      const chatId = Number(order.user_id);
      const title = `${ORDER_ICON[order.kind]} ${ORDER_LABEL[order.kind]} · ${escapeTelegramHtml(order.symbol)}`;
      const text = outcome.status === 'filled'
        ? tgMessage(`✅ <b>${title} filled</b>`, tgCard([`Triggered at ${formatTokenPriceUsd(outcome.priceUsd)} · sold ${order.sell_percent}%`, `Transaction  ${outcome.explorerUrl ? `<a href="${outcome.explorerUrl}">${escapeTelegramHtml(outcome.txHash.slice(0, 12))}…</a>` : `<code>${escapeTelegramHtml(outcome.txHash)}</code>`}`]))
        : outcome.status === 'failed'
          ? tgMessage(`⚠️ <b>${title} could not sell</b>`, escapeTelegramHtml(outcome.error), tgFootnote('The order is closed. Check your wallet, then place a new one if needed.'))
          : tgMessage(`⏳ <b>${title} triggered</b>`, `The sell did not go through yet (${escapeTelegramHtml(outcome.error)}). It retries automatically while the price stays past the trigger.`);
      await sendTelegramMessage(chatId, text, env, { inline_keyboard: [[{ text: '🎯 Orders', callback_data: 'orders' }, { text: '💼 Portfolio', callback_data: 'positions:fresh' }]] });
    },
  });
}

// ---------------------------------------------------------------------------
// Wallet names (default W1, W2 … from nextWalletLabel; renamable here)
// ---------------------------------------------------------------------------

const renameKey = (chatId: number) => `rename:v1:${chatId}`;

async function promptTelegramWalletRename(chatId: number, env: Env, walletId?: string): Promise<void> {
  const accounts = await listWalletAccounts(String(chatId), env);
  const active = (walletId ? accounts.find((account) => account.id === walletId) : null) ?? defaultWalletFor(accounts, 'evm') ?? accounts[0];
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  if (!active || !store) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('✏️', 'Rename wallet'), 'Create a wallet first in 💳 Wallets.'), env, telegramWalletSetupKeyboard());
    return;
  }
  await store.put(renameKey(chatId), active.id, { expirationTtl: 600 });
  await sendTelegramMessage(chatId, `${TELEGRAM_RENAME_PROMPT} ${active.label}`, env, {
    force_reply: true,
    input_field_placeholder: 'New name, e.g. Sniper (max 20 characters)',
  }, null);
}

async function renameTelegramWallet(chatId: number, text: string, env: Env): Promise<void> {
  const name = text.trim().replace(/\s+/g, ' ');
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  const walletId = await store?.get(renameKey(chatId)).catch(() => null);
  if (!walletId || !env.DB) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('✏️', 'Rename expired'), 'Open 💳 Wallets → 🗂 Manage wallets → tap the wallet → ✏️ Rename.'), env);
    return;
  }
  if (!/^[\p{L}\p{N} _.\-]{1,20}$/u.test(name)) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('✏️', 'Name not saved'), 'Use 1–20 letters, numbers, spaces, dots, dashes or underscores. Tap ✏️ Rename to try again.'), env);
    return;
  }
  await env.DB.prepare(`UPDATE wallet_accounts SET label = ?1 WHERE id = ?2 AND user_id = ?3`).bind(name, walletId, String(chatId)).run();
  await store?.delete(renameKey(chatId)).catch(() => undefined);
  await showTelegramWalletDetail(chatId, walletId, env, undefined, `✅ Renamed to ${escapeTelegramHtml(name)}.`);
}

// ---------------------------------------------------------------------------
// Bundle buy / sell: one quote per wallet, one confirmation, every wallet signs its own trade
// ---------------------------------------------------------------------------

const BUNDLE_TTL_SECONDS = 90;
const bundleKey = (chatId: number, id: string) => `bundle:v1:${chatId}:${id}`;

interface BundleRecord {
  kind: 'buy' | 'sell';
  symbol: string;
  legs: Array<{ tradeId: string; walletId: string; label: string; pay: string; receive: string; explorer?: string; evmAddress?: string | null; solanaAddress?: string | null; nearAddress?: string | null }>;
  skipped: Array<{ label: string; reason: string }>;
}

/** Bundle trades use one-step routes so every wallet's trade settles on its own. */
function bundleRoute(profile: TelegramProfile): { fundingChainId: number; error?: string } {
  const isNear = profile.lastTokenChainId === NEAR_CHAIN_ID;
  const fundingChainId = profile.fundingChainId ?? (isNear ? NEAR_CHAIN_ID : 8453);
  if (isNear && fundingChainId !== NEAR_CHAIN_ID) return { fundingChainId, error: 'Bundle buys of NEAR tokens pay with NEAR. Tap Ⓝ NEAR on the token card, then Bundle buy.' };
  if (!isNear && fundingChainId === NEAR_CHAIN_ID) return { fundingChainId, error: 'Bundle buys pay from an EVM or Solana chain. Pick one with the Pay-with buttons, then Bundle buy.' };
  return { fundingChainId };
}

/** Wallets that can join a bundle: they hold the token's chain and, for buys, the pay-from chain. */
function bundleWallets(accounts: WalletAccountRow[], kind: 'buy' | 'sell', profile: TelegramProfile | null): WalletAccountRow[] {
  if (!profile?.lastTokenChainId) return [];
  const needs = new Set<WalletChain>([walletChainOf(profile.lastTokenChainId)]);
  if (kind === 'buy') needs.add(walletChainOf(bundleRoute(profile).fundingChainId));
  return accounts.filter((row) => [...needs].every((chain) => walletAddressOn(row, chain)));
}

async function showTelegramBundleMenu(chatId: number, kind: 'buy' | 'sell', env: Env, panelId?: number): Promise<void> {
  const [profile, accounts] = await Promise.all([readTelegramProfile(chatId, env).catch(() => null), listWalletAccounts(String(chatId), env)]);
  const wallets = bundleWallets(accounts, kind, profile);
  if (!profile?.lastTokenAddress || !profile.lastTokenChainId) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('🧺', 'Pick a token first'), 'Paste a token address, then tap 🧺 Bundle buy or sell on its card.'), env, telegramActionKeyboard());
    return;
  }
  if (!wallets.length) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('🧺', 'Bundle trades need wallets'), 'Create wallets in 💳 Wallets (📦 New wallet) and fund them.'), env, telegramWalletSetupKeyboard());
    return;
  }
  const symbol = escapeTelegramHtml(profile.lastTokenSymbol ?? 'token');
  const list = tgCard(wallets.map((wallet) => `<b>${escapeTelegramHtml(wallet.label)}</b>  <code>${escapeTelegramHtml(shortenTelegramAddress(profile.lastTokenChainId === NEAR_CHAIN_ID ? wallet.near_address ?? '—' : profile.lastTokenChainId === 1151111081099710 ? wallet.solana_address! : wallet.evm_address!))}</code>`));
  const more = wallets.length < 2 ? tgFootnote('Tip: bundles shine with several wallets — 📦 New wallet adds W2, W3 … (up to 10).') : null;
  if (kind === 'sell') {
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🧺', `Bundle sell · ${symbol}`, `Sells the same share of ${symbol} from every wallet that holds it.`),
      list, more, tgFootnote('You review one combined quote, then confirm once.'),
    ), env, { inline_keyboard: [
      [25, 50, 100].map((percent) => ({ text: `🔴 Sell ${percent}%`, callback_data: `bundle:sell:${percent}` })),
      [{ text: '✖️ Cancel', callback_data: 'bundle:cancel' }],
    ] });
    return;
  }
  const route = bundleRoute(profile);
  if (route.error) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('🧺', 'Bundle buy'), escapeTelegramHtml(route.error)), env, { inline_keyboard: [[{ text: '◀️ Back to token', callback_data: 'token:refresh:last' }]] });
    return;
  }
  const network = getNetwork(route.fundingChainId);
  const amounts = route.fundingChainId === NEAR_CHAIN_ID ? NEAR_QUICK_BUY_AMOUNTS : network?.quickBuy.slice(0, 4) ?? QUICK_BUY_AMOUNTS;
  const coin = network?.nativeSymbol ?? 'native';
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('🧺', `Bundle buy · ${symbol}`, `Every wallet with enough ${escapeTelegramHtml(coin)} on ${escapeTelegramHtml(network?.name ?? 'the pay-from chain')} buys the amount you pick.`),
    list, more, tgFootnote('Amount is per wallet. You review one combined quote, then confirm once.'),
  ), env, { inline_keyboard: [
    amounts.map((amount) => ({ text: `🟢 ${amount} ${coin} each`, callback_data: `bundle:buy:${amount}` })),
    [{ text: '✖️ Cancel', callback_data: 'bundle:cancel' }],
  ] });
}

async function prepareTelegramBundle(chatId: number, kind: 'buy' | 'sell', value: string, env: Env, panelId?: number): Promise<void> {
  const userId = String(chatId);
  const [profile, accounts] = await Promise.all([readTelegramProfile(chatId, env).catch(() => null), listWalletAccounts(userId, env)]);
  const wallets = bundleWallets(accounts, kind, profile);
  if (!profile?.lastTokenAddress || !profile.lastTokenChainId || !wallets.length || !env.ENCRYPTION_KEY) {
    await showTelegramBundleMenu(chatId, kind, env, panelId);
    return;
  }
  const tokenAddress = profile.lastTokenAddress;
  const tokenChainId = profile.lastTokenChainId;
  const isNear = tokenChainId === NEAR_CHAIN_ID;
  const symbol = profile.lastTokenSymbol ?? 'token';
  const slippage = (profile.slippagePercent ?? 1) / 100;
  const rpc = nearRpcOptions(env);
  const route = bundleRoute(profile);
  if (kind === 'buy' && route.error) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('🧺', 'Bundle buy'), escapeTelegramHtml(route.error)), env);
    return;
  }
  const near = isNear ? await getTokenMetadata(tokenAddress, rpc).catch(() => null) : null;
  if (isNear && !near) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⚠️', 'Token unavailable'), 'Its NEP-141 metadata could not be read. Try again in a moment.'), env);
    return;
  }
  const record: BundleRecord = { kind, symbol, legs: [], skipped: [] };
  const fundingChain = getChainById(route.fundingChainId);
  const percent = Number(value);

  const quoteWallet = async (wallet: WalletAccountRow) => {
    const label = wallet.label;
    const addresses = walletAddresses(wallet);
    try {
      if (kind === 'buy') {
        if (isNear) {
          const trade = await prepareNearSwap({ userId, kind: 'buy', tokenIn: NEAR_TOKEN, tokenOut: { id: tokenAddress, symbol: near!.symbol, decimals: near!.decimals },
            amountInUnits: parseUnits(value, NEAR_DECIMALS).toString(), slippage, walletId: wallet.id }, env);
          const swap = trade.nearSwap!;
          return { tradeId: trade.id, walletId: wallet.id, label, ...addresses, pay: `${value} NEAR`, receive: `≈ ${formatUnits(swap.quote.expectedOut, swap.tokenOutDecimals, 4)} ${swap.tokenOutSymbol}` };
        }
        if (!fundingChain) throw new Error('Unsupported pay-from chain');
        const owner = fundingChain.type === 'EVM' ? wallet.evm_address! : wallet.solana_address!;
        const units = BigInt(decimalToUnits(value, fundingChain.type === 'EVM' ? 18 : 9));
        const balance = await quickNativeBalance(fundingChain.id, owner, rpc, 4_000);
        if (balance !== null && balance <= units) throw new Error(`not enough ${fundingChain.nativeSymbol}`);
        const trade = await prepareBuy({ userId, wallet: addresses, fundingChainKey: fundingChain.key, fundingTokenAddress: 'native', fundingAmountUnits: units.toString(),
          targetChainId: tokenChainId, targetTokenAddress: tokenAddress, slippage, walletId: wallet.id }, env);
        const decimals = Number((trade.quote.raw as { action?: { toToken?: { decimals?: number } } } | undefined)?.action?.toToken?.decimals ?? 18);
        return { tradeId: trade.id, walletId: wallet.id, label, ...addresses, pay: `${value} ${fundingChain.nativeSymbol}`, receive: `≈ ${formatUnits(trade.quote.estimate.toAmount, decimals, 4)} ${symbol}` };
      }
      // Sell: a share of what this wallet actually holds.
      const owner = isNear ? wallet.near_address : tokenChainId === 1151111081099710 ? wallet.solana_address : wallet.evm_address;
      if (!owner) throw new Error('no account on this chain yet');
      const held = await quickTokenBalance(tokenChainId, tokenAddress, owner, rpc, 4_000);
      if (held === null) throw new Error('balance unavailable right now');
      const amount = (BigInt(held.amount) * BigInt(percent)) / 100n;
      if (amount <= 0n) throw new Error(`holds no ${symbol}`);
      if (isNear) {
        const trade = await prepareNearSwap({ userId, kind: 'sell', tokenIn: { id: tokenAddress, symbol: near!.symbol, decimals: near!.decimals }, tokenOut: NEAR_TOKEN,
          amountInUnits: amount.toString(), slippage, walletId: wallet.id }, env);
        return { tradeId: trade.id, walletId: wallet.id, label, ...addresses, pay: `${formatTokenAmount(amount, held.decimals)} ${symbol}`, receive: `≈ ${formatUnits(trade.nearSwap!.quote.expectedOut, NEAR_DECIMALS, 4)} NEAR` };
      }
      const trade = await prepareTokenSell({ userId, wallet: addresses, walletId: wallet.id, chainId: tokenChainId, tokenAddress, amountUnits: amount.toString(), slippage }, env);
      const chain = getChainById(tokenChainId)!;
      return { tradeId: trade.id, walletId: wallet.id, label, ...addresses, pay: `${formatTokenAmount(amount, held.decimals)} ${symbol}`, receive: `≈ ${formatUnits(trade.quote.estimate.toAmount, chain.type === 'SVM' ? 9 : chain.id === 5042 ? 6 : 18, 6)} ${chain.nativeSymbol}` };
    } catch (error) {
      record.skipped.push({ label, reason: error instanceof Error ? error.message.replace(/^Not enough/, 'not enough').slice(0, 120) : 'no quote' });
      return null;
    }
  };

  // Four wallets at a time keeps the quote providers happy.
  for (let index = 0; index < wallets.length; index += 4) {
    const quoted = await Promise.all(wallets.slice(index, index + 4).map(quoteWallet));
    for (const leg of quoted) if (leg) record.legs.push(leg);
  }
  if (!record.legs.length) {
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🧺', `No bundle ${kind}`, 'None of your wallets could trade this right now.'),
      tgCard(record.skipped.map((item) => `<b>${escapeTelegramHtml(item.label)}</b>  ${escapeTelegramHtml(item.reason)}`)),
    ), env, { inline_keyboard: [[{ text: '◀️ Back to token', callback_data: 'token:refresh:last' }]] });
    return;
  }
  const id = crypto.randomUUID().slice(0, 8);
  await (env.TELEGRAM_STATE ?? env.CACHE)!.put(bundleKey(chatId, id), JSON.stringify(record), { expirationTtl: BUNDLE_TTL_SECONDS });
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('🧺', `Bundle ${kind === 'buy' ? 'BUY' : 'SELL'} · ${escapeTelegramHtml(symbol)}`, `${record.legs.length} wallet${record.legs.length === 1 ? '' : 's'} · each signs its own trade`),
    tgCard(record.legs.map((leg) => `<b>${escapeTelegramHtml(leg.label)}</b>  ${escapeTelegramHtml(leg.pay)} → ${escapeTelegramHtml(leg.receive)}`)),
    record.skipped.length ? `<i>Skipped:</i>\n${tgCard(record.skipped.map((item) => `${escapeTelegramHtml(item.label)} · ${escapeTelegramHtml(item.reason)}`))}` : null,
    `🏷 <b>Platform fee</b>  ${HOPR_FEE_PERCENT}% per trade · 🎚 slippage ${profile.slippagePercent ?? 1}%`,
    tgFootnote(`⏳ Quotes expire in ${BUNDLE_TTL_SECONDS} seconds. Nothing is signed until you confirm.`),
  ), env, { inline_keyboard: [[{ text: `✅ Confirm ${record.legs.length} trade${record.legs.length === 1 ? '' : 's'}`, callback_data: `bundle:confirm:${id}` }, { text: '✖️ Cancel', callback_data: 'bundle:cancel' }]] });
}

async function confirmTelegramBundle(chatId: number, id: string, env: Env, panelId?: number): Promise<void> {
  const store = env.TELEGRAM_STATE ?? env.CACHE;
  const raw = await store?.get(bundleKey(chatId, id)).catch(() => null);
  if (!raw || !store) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⌛', 'Bundle expired'), 'Quotes last 90 seconds. Open the token and tap 🧺 Bundle again.'), env, telegramActionKeyboard());
    return;
  }
  // Consume first: a double tap can never submit the bundle twice.
  await store.delete(bundleKey(chatId, id));
  const record = JSON.parse(raw) as BundleRecord;
  if (panelId) await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⏳', `Submitting ${record.legs.length} trades…`), 'Each wallet signs and broadcasts its own transaction.'), env);
  const rpcUrls = { evm: (chainId: number) => transactionRpc(chainId), solana: () => transactionRpc(1151111081099710), solanaBroadcast: solanaBroadcastRpcs };
  const results = await Promise.allSettled(record.legs.map((leg) => confirmTrade(String(chatId), leg.tradeId, rpcUrls, env)));
  const lines = await Promise.all(results.map(async (result, index) => {
    const leg = record.legs[index];
    forgetPortfolio({ evmAddress: leg.evmAddress, solanaAddress: leg.solanaAddress, nearAddress: leg.nearAddress });
    if (result.status === 'rejected') return `⚠️ <b>${escapeTelegramHtml(leg.label)}</b>  ${escapeTelegramHtml(result.reason instanceof Error ? result.reason.message.slice(0, 100) : 'failed')}`;
    await recordTelegramReferral(String(chatId), result.value, env);
    const explorer = TELEGRAM_EXPLORERS[result.value.venue === 'ref' ? NEAR_CHAIN_ID : result.value.fromChainId ?? NEAR_CHAIN_ID];
    const hash = escapeTelegramHtml(result.value.txHash);
    return `✅ <b>${escapeTelegramHtml(leg.label)}</b>  ${explorer ? `<a href="${explorer}${encodeURIComponent(result.value.txHash)}">${hash.slice(0, 10)}…</a>` : `<code>${hash}</code>`}`;
  }));
  const ok = results.filter((result) => result.status === 'fulfilled').length;
  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle(ok ? '✅' : '⚠️', `Bundle ${record.kind}: ${ok} of ${record.legs.length} submitted`, escapeTelegramHtml(record.symbol)),
    tgCard(lines),
    tgFootnote('Transactions are on-chain; settlement may take a moment. 💼 Portfolio refreshes with the new balances.'),
  ), env, { inline_keyboard: [[{ text: '💼 Portfolio', callback_data: 'positions:fresh' }, { text: '◀️ Menu', callback_data: 'menu' }]] });
}

let cachedBotUsername: string | null | undefined;

/** Bot username for t.me invite links: TELEGRAM_BOT_USERNAME, else getMe (cached per isolate). */
async function telegramBotUsername(env: Env): Promise<string | null> {
  if (env.TELEGRAM_BOT_USERNAME) return env.TELEGRAM_BOT_USERNAME.replace(/^@/, '');
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const response = await telegramApiRequest('getMe', env, {}).catch(() => null);
  cachedBotUsername = (response?.result as { username?: string } | undefined)?.username ?? null;
  return cachedBotUsername;
}

const formatRewardUsd = (value: number | undefined) => `$${(value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Credit a bot trade to the Telegram user's referrer. */
async function recordTelegramReferral(userId: string, result: ConfirmResult, env: Env): Promise<void> {
  if (!env.DB || !result.fromAddress || !result.feeBps || !result.venue || result.fromChainId === undefined) return;
  await recordReferralTrade({
    wallet: result.fromAddress,
    txHash: result.txHash,
    provider: result.venue,
    chainId: result.fromChainId,
    depositAddress: result.depositAddress,
    telegramUserId: userId,
  }, env).catch((error) => console.error('Referral trade not recorded', error));
}

async function showTelegramReferral(chatId: number, env: Env, panelId?: number, notice?: string): Promise<void> {
  if (!env.DB) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('🎁', 'Refer & Earn'), 'Referrals are not configured on this bot yet.'), env, telegramActionKeyboard());
    return;
  }
  const identity = telegramIdentity(String(chatId));
  try {
    const code = await ensureReferralCode(identity, env);
    const [stats, bot, wallet] = await Promise.all([
      referralStats(identity, env),
      telegramBotUsername(env).catch(() => null),
      getCustodialWallet(String(chatId), env).catch(() => null),
    ]);
    const telegramLink = bot ? `https://t.me/${bot}?start=ref_${code}` : null;
    const claimable = stats.claimableUsd ?? 0;
    const canClaim = Boolean(wallet) && claimable >= stats.minPayoutUsd;
    const text = tgMessage(
      tgTitle('🎁', 'Refer &amp; Earn', `Earn ${REFERRAL_SHARE * 100}% of HOPR fee revenue after the routing provider's share on every trade your friends make in Hopr on Telegram.`),
      notice ? `<b>${notice}</b>` : null,
      tgSection('🔗', 'Your invite', [
        ...(telegramLink ? [`Telegram  ${telegramLink}`] : []),
        `Code  <code>${code}</code>`,
      ]),
      tgSection('📊', 'Earnings', [
        `👥 Friends  <b>${stats.referredUsers ?? 0}</b>`,
        `💱 Their volume  <b>${formatRewardUsd(stats.volumeUsd)}</b>`,
        `🏷 HOPR revenue after routing fees  <b>${formatRewardUsd(stats.feesUsd)}</b>`,
        `💰 You earned (${REFERRAL_SHARE * 100}%)  <b>${formatRewardUsd(stats.earnedUsd)}</b>`,
        `✅ Claimable  <b>${formatRewardUsd(claimable)}</b> · min ${formatRewardUsd(stats.minPayoutUsd)}`,
        ...(stats.pendingTrades ? [`⏳ Verifying  ${stats.pendingTrades} trade${stats.pendingTrades === 1 ? '' : 's'}`] : []),
        ...((stats.paidUsd ?? 0) > 0 || (stats.requestedUsd ?? 0) > 0 ? [`💸 Paid ${formatRewardUsd(stats.paidUsd)} · requested ${formatRewardUsd(stats.requestedUsd)}`] : []),
      ]),
      tgSection('💳', 'Payouts', [
        wallet?.evmAddress ? `USDC to your Hopr wallet <code>${escapeTelegramHtml(wallet.evmAddress)}</code>` : 'Create or import an EVM wallet (💳 Wallets) to receive payouts',
        `Platform fee: ${HOPR_FEE_PERCENT}% on trades and bridges`,
      ]),
      tgFootnote('Rewards count once the route provider confirms the trade.'),
    );
    const share = telegramLink;
    await sendTelegramPanel(chatId, panelId, text, env, {
      inline_keyboard: [
        ...(share ? [[{ text: '📤 Share invite', url: `https://t.me/share/url?url=${encodeURIComponent(share)}&text=${encodeURIComponent('Trade any token on any chain in one tap with Hopr 🐇')}` }]] : []),
        [
          ...(canClaim ? [{ text: `💸 Claim ${formatRewardUsd(claimable)}`, callback_data: 'referral:claim' }] : []),
          { text: '🔄 Refresh', callback_data: 'referral' },
        ],
        [{ text: '◀️ Menu', callback_data: 'menu' }],
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    const schema = /no such table|no such column|has no column/.test(message);
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🎁', 'Refer &amp; Earn'),
      schema ? 'Referrals need migrations 0005 and 0006 applied to the database.' : `Could not load your referrals: ${escapeTelegramHtml(message)}`,
    ), env, telegramActionKeyboard());
  }
}

async function claimTelegramReferral(chatId: number, env: Env, panelId?: number): Promise<void> {
  if (!env.DB) return showTelegramReferral(chatId, env, panelId);
  const wallet = await getCustodialWallet(String(chatId), env).catch(() => null);
  if (!wallet?.evmAddress) return showTelegramReferral(chatId, env, panelId, 'Create or import an EVM wallet first — payouts are sent to it.');
  const result = await claimReferralRewards(telegramIdentity(String(chatId)), wallet.evmAddress, env).catch((error) => ({ requested: false as const, error: String(error), status: 500 }));
  return showTelegramReferral(chatId, env, panelId, result.requested
    ? `✅ Payout of ${formatRewardUsd(result.amountUsd)} requested — USDC will be sent to your Hopr wallet.`
    : `⚠️ ${escapeTelegramHtml(result.error)}`);
}

// ---------------------------------------------------------------------------
// NEAR-funded buys: step 1 (NEAR Intents) sent → step 2 (LI.FI) on Continue
// ---------------------------------------------------------------------------

/** Native balance in smallest units (wei / lamports) for the custodial wallet checks. */
async function nativeBalanceUnits(chainId: number, address: string): Promise<bigint> {
  // Execution checks require a fresh read; display caches must never authorize spending.
  return readNativeBalance(chainId, address);
}

function telegramIntentsSentMessage(result: ConfirmResult): string {
  const origin = result.fromChainId !== undefined && result.fromChainId !== NEAR_CHAIN_ID
    ? TELEGRAM_CHAINS.find((chain) => chain.id === result.fromChainId)
    : undefined;
  const bridge = result.venue === 'lifi' ? 'LI.FI' : 'NEAR Intents';
  return result.continuationId
    ? tgMessage(
      tgTitle('🌉', `Step 1 of ${result.venue === 'lifi' ? 3 : 2} sent`, `${origin ? `${escapeTelegramHtml(origin.symbol)} from ${escapeTelegramHtml(origin.name)}` : 'NEAR'} is on its way through ${bridge}.`),
      tgCard([
        `Transaction: <code>${escapeTelegramHtml(result.txHash)}</code>`,
        'Usually lands in 1–3 minutes',
      ]),
      tgFootnote('Tap ▶️ Continue once it lands — Hopr quotes step 2 with exactly what arrived.'),
    )
    : tgMessage(
      tgTitle('✅', 'Swap submitted', 'Routed through NEAR Intents.'),
      tgCard([`Transaction: <code>${escapeTelegramHtml(result.txHash)}</code>`, 'Tokens usually arrive in 1–3 minutes']),
    );
}

async function continueTelegramNearBuy(chatId: number, continuationId: string, env: Env, panelId?: number): Promise<void> {
  const userId = String(chatId);
  const wallet = await getCustodialWallet(userId, env).catch(() => null);
  if (!wallet) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('💳', 'Wallet not found'), 'Open 💳 Wallets to check your Hopr wallet.'), env, telegramActionKeyboard());
    return;
  }
  try {
    const step = await continueNearFundedBuy(userId, continuationId, wallet, nativeBalanceUnits, env);
    if (step.status === 'pending') {
      const time = new Date().toISOString().slice(11, 19);
      await sendTelegramPanel(chatId, panelId, tgMessage(
        tgTitle('⏳', 'Still bridging…', `Bridge status: ${escapeTelegramHtml(step.detail)}`),
        tgFootnote(`Checked ${time} UTC. Tap Continue again in a minute.`),
      ), env, { inline_keyboard: [[{ text: '▶️ Continue — next step', callback_data: `trade:cont:${continuationId}` }], [{ text: '◀️ Menu', callback_data: 'menu' }]] });
      return;
    }
    if (step.status === 'failed') {
      await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⚠️', 'Next step unavailable'), escapeTelegramHtml(step.detail)), env, telegramActionKeyboard());
      return;
    }
    if (step.trade.venue === 'ref' || step.trade.venue === 'intents') {
      // Into a NEAR token: a Ref swap of the NEAR that arrived, or (after a LI.FI hop) NEAR Intents from the hub.
      await sendTelegramPreparedTrade(chatId, step.trade, env);
      return;
    }
    // The coin landed on the hub chain (the target chain, or Base when NEAR Intents couldn't reach it).
    const chain = getChainById(step.continuation.hubChainId ?? step.continuation.targetChainId)!;
    const target = getChainById(step.continuation.targetChainId)!;
    const decimals = chain.type === 'SVM' ? 9 : 18;
    await sendTelegramMessage(
      chatId,
      telegramQuoteMessage('BUY', [
        `💸 <b>You pay</b>  ${formatUnits(step.delivered, decimals, 6)} ${escapeTelegramHtml(chain.nativeSymbol)} (arrived from NEAR)`,
        `🎯 <b>You get</b>  ${escapeTelegramHtml(step.continuation.targetSymbol)}`,
        `🧭 <b>Route</b>  ${chain.id === target.id ? escapeTelegramHtml(chain.name) : `${escapeTelegramHtml(chain.name)} → ${escapeTelegramHtml(target.name)}`} · LI.FI`,
        `🛡 <b>Minimum output</b>  <code>${escapeTelegramHtml(String(step.trade.quote.estimate.toAmountMin))}</code> base units`,
        `🎚 <b>Slippage</b>  ${Number((step.continuation.slippage * 100).toFixed(2))}%`,
        '🏷 <b>Platform fee</b>  already paid in step 1',
      ]),
      env,
      telegramTradeConfirmationKeyboard(step.trade.id, '✅ Confirm step 2'),
    );
  } catch (error) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'Step 2 failed'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')), env, telegramActionKeyboard());
  }
}
