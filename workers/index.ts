/**
 * Hopr Cloudflare Worker
 * 
 * Handles API routes for:
 * - Chain detection (POST /api/detect)
 * - Wallet balance queries (GET /api/wallet/:address)
 * - Trade execution (POST /api/trade/buy, POST /api/trade/sell)
 * - Trade status polling (GET /api/trade/:id/status)
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
  createCustodialWallet,
  ensureNearWallet,
  nearRpcOptions,
  prepareBuy,
  prepareNearSwap,
  prepareSell,
  confirmTrade,
  continueNearFundedBuy,
  prepareNearIntentsBuy,
  prepareIncomingNearBuy,
  requestIntentsQuote,
  type ConfirmResult,
  type PendingTrade,
} from './trading';
import { detectChain as detectTokenOnChain, detectLaunchpad, getChainById, SUPPORTED_CHAINS } from '../src/services/chainDetector';
import { LAUNCHPADS, launchpadById, sortPools, type LaunchpadId } from '../src/services/launchpads';
import { getLaunchpadFeed } from './launchpads';
import { savePoolActions, readPoolAction } from './launchpadActions';
import { getNetwork } from '../src/services/chains';
import { tracked, readNativeBalance, nativePricesUsd, type TrackedAmount } from './balances';
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
  formatNearAmount,
  formatUnits,
  getNearBalance,
  getRefSwapQuote,
  getTokenMetadata,
  isNearAccountId,
  NATIVE_NEAR,
  NEAR_CHAIN,
  NEAR_CHAIN_ID,
  NEAR_DECIMALS,
  parseUnits,
  resolveNearToken,
  verifyFullAccessKey,
  viewFunction,
  type NearBalance,
} from '../src/services/nearService';
import { generateNearWallet, importNearKey } from '../src/services/nearSigner';

export interface Env {
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
  TELEGRAM_MINI_APP_URL?: string;
  /** Keyed NEAR JSON-RPC endpoint (recommended); free public RPCs are rate limited. */
  NEAR_RPC_URL?: string;
  /** Hopr's NEAR account: receives the NEAR Intents app fee and the Ref swap fee (0.5% / 1%). */
  HOPR_INTENTS_FEE_ACCOUNT?: string;
  /** 1Click API key: default app-fee split is 50/50; public quotes add 25bps. */
  ONECLICK_JWT?: string;
  /** Bot username without @, for invite links (read from getMe when unset). */
  TELEGRAM_BOT_USERNAME?: string;
  /** Public dashboard URL for web invite links (defaults to TELEGRAM_MINI_APP_URL's origin). */
  PUBLIC_APP_URL?: string;
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
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

type TelegramButton = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
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

function telegramMiniAppRow(env: Env, label = '🚀 Open Hopr App'): TelegramButton[][] {
  return env.TELEGRAM_MINI_APP_URL ? [[{ text: label, web_app: { url: env.TELEGRAM_MINI_APP_URL } }]] : [];
}

/** Main menu, laid out like a trading-bot home screen: trade actions first, account tools below. */
function telegramActionKeyboard(env: Env): TelegramKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '🛒 Buy & Sell', callback_data: 'trade:start' },
        { text: '📊 Positions', callback_data: 'positions' },
      ],
      [
        { text: '💳 Wallets', callback_data: 'wallet' },
        { text: '⚙️ Settings', callback_data: 'settings' },
      ],
      [{ text: '📡 Launch radar', callback_data: 'pools' }],
      [
        { text: '🎁 Refer & Earn', callback_data: 'referral' },
        { text: '❓ Help', callback_data: 'help' },
      ],
      ...telegramMiniAppRow(env),
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
}

/** Quick-buy presets for the pay-from chain: NEAR keeps 0.5/1/5; NEAR tokens paid elsewhere use chain-sized presets. */
function telegramQuickBuyAmounts(tokenChainId: number | undefined, fundingChainId: number | undefined): string[] {
  if (tokenChainId === NEAR_CHAIN_ID) {
    if (fundingChainId === undefined || fundingChainId === NEAR_CHAIN_ID) return NEAR_QUICK_BUY_AMOUNTS;
    return getNetwork(fundingChainId)?.quickBuy.slice(0, 3) ?? QUICK_BUY_AMOUNTS;
  }
  return QUICK_BUY_AMOUNTS;
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
      TELEGRAM_PAY_WITH.map((option) => ({
        text: `${option.id === context.fundingChainId ? '✅ ' : ''}${option.label}`,
        callback_data: `token:pay:${option.id}`,
      })),
      [
        { text: '✏️ Buy X', callback_data: 'trade:custom' },
        { text: `⛓ ${context.fundingChainName ?? 'Funding'}`, callback_data: 'settings' },
        { text: `🎚 Slip ${context.slippagePercent ?? 1}%`, callback_data: 'settings' },
      ],
      [
        { text: '📈 Chart', url: `https://dexscreener.com/search?q=${encodeURIComponent(address)}` },
        ...(explorer ? [{ text: '🔍 Explorer', url: `${explorer}${encodeURIComponent(address)}` }] : []),
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

interface TradeRequest {
  userId: string;
  tokenAddress: string;
  amount: string;
  fundingChain: string;
  slippage: number;
  fromAddress?: string;
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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
        return handleTelegramWebhook(request, env);
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
        return Response.json({ status: 'ok', timestamp: Date.now() }, { headers: corsHeaders });
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

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const message = update.message;
  const callback = update.callback_query;
  const chatId = message?.chat?.id ?? callback?.message?.chat?.id;
  if (!chatId) return Response.json({ ok: true });

  if (callback) {
    const data = callback.data ?? '';
    const chatType = callback.message?.chat?.type;
    const recognized = ['help', 'menu', 'wallet', 'settings', 'dismiss', 'positions', 'trade:start', 'token:refresh:last', 'referral', 'referral:claim', 'pools'].includes(data)
      || (data.startsWith('pools:') && !!launchpadById(data.slice(6)))
      || /^lp:(view|buy):[a-f0-9]{24}:[0-5]$/.test(data)
      || /^trade:cont:[0-9a-f]{8}$/.test(data)
      || ['wallet:generate', 'wallet:import', 'wallet:export', 'wallet:preferred', 'wallet:delete', 'wallet:delete:confirm'].includes(data)
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
      return Response.json({ ok: true });
    }
    // Acknowledge the tap while the real work runs, instead of one extra round trip first.
    const acknowledged = telegramApiRequest('answerCallbackQuery', env, {
      callback_query_id: callback.id,
      ...(telegramCallbackToast(data) ? { text: telegramCallbackToast(data) } : {}),
    });
    if ((data.startsWith('lp:') || data.startsWith('trade:') || data.startsWith('token:pay:') || data === 'wallet' || data.startsWith('wallet:') || data === 'settings' || data.startsWith('settings:') || data === 'positions' || data.startsWith('referral')) && chatType !== 'private') {
      await acknowledged;
      await sendTelegramMessage(chatId, '🔒 For privacy, check wallet balances and manage personal settings in a private chat with this bot.', env);
      return Response.json({ ok: true });
    }
    await Promise.all([acknowledged, handleTelegramCallback(chatId, data, env, callback.message?.message_id, chatType)]);
    return Response.json({ ok: true });
  }

  const text = message?.text?.trim() ?? '';
  await handleTelegramMessage(chatId, message?.chat?.type, text, env, message?.reply_to_message, message?.from?.first_name);

  return Response.json({ ok: true });
}

/** Short toast shown on the button tap itself, so every tap gets instant feedback. */
function telegramCallbackToast(data: string): string | undefined {
  if (data.startsWith('token:refresh:')) return 'Refreshing market data…';
  if (data === 'wallet') return 'Loading balances…';
  if (data === 'positions') return 'Loading positions…';
  if (/^trade:(buy|sell):/.test(data)) return 'Fetching a live quote…';
  if (data.startsWith('trade:confirm:')) return 'Submitting…';
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
    '/positions — open positions with live prices',
    '/pools — launchpad pools, liquidity and volume',
    'Only the <b>Confirm and submit</b> button signs and submits a trade',
  ]),
  tgSection('💳', 'Wallet', [
    '/wallet — balances for your active wallet',
    '/wallet &lt;address&gt; — one-off balance check',
    `💳 Wallets — create or import up to ${MAX_WALLETS_PER_USER} wallets, synced with the Mini App`,
    '/importkey &lt;evm|solana|near&gt; &lt;key&gt; — use your own key (DM only)',
    '/exportkeys — reveal your private keys (DM only)',
  ]),
  tgSection('🎁', 'Refer &amp; Earn', [
    '/referral — your invite links and earnings',
    `Earn ${REFERRAL_SHARE * 100}% of HOPR fee revenue after the routing provider's share (0.5% trades · 1% bridges)`,
  ]),
  tgSection('⚙️', 'General', [
    '/menu — main menu',
    '/app — open the Hopr Mini App',
    '/balances — refresh balances',
    '/settings — funding chain &amp; slippage',
  ]),
  tgFootnote('Hopr never asks for a seed phrase. Never share one with anyone.'),
);

async function handleTelegramMessage(
  chatId: number,
  chatType: string | undefined,
  text: string,
  env: Env,
  replyToMessage?: TelegramMessage['reply_to_message'],
  firstName?: string,
): Promise<void> {
  if (replyToMessage?.from?.is_bot && replyToMessage.text?.startsWith(TELEGRAM_BUY_X_PROMPT)) {
    const amount = text.trim().replace(',', '.');
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(amount) || !(Number(amount) > 0)) {
      await sendTelegramMessage(chatId, tgMessage(tgTitle('✏️', 'Buy X'), 'Send just a number, e.g. <code>1</code> or <code>0.25</code>. Tap ✏️ Buy X to try again.'), env);
      return;
    }
    await handleTelegramTradeAction(chatId, `trade:buy:${amount}`, env);
    return;
  }

  const [rawCommand = '', ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];

  if (command === '/start') {
    // t.me/<bot>?start=ref_<code>: the invite binds this Telegram user (bot + Mini App) to the referrer.
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
  if (command === '/positions') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For privacy, view positions in a private chat with this bot.', env);
      return;
    }
    await showTelegramPositions(chatId, env);
    return;
  }
  if (command === '/app') {
    await sendTelegramMessage(
      chatId,
      env.TELEGRAM_MINI_APP_URL
        ? tgMessage(tgTitle('🚀', 'Hopr Mini App', 'Your synced wallet, charts and trade history in one tap.'))
        : tgMessage(tgTitle('🚀', 'Hopr Mini App'), 'The Mini App is not configured yet. Ask the bot owner to set <code>TELEGRAM_MINI_APP_URL</code>.'),
      env,
      telegramActionKeyboard(env),
    );
    return;
  }
  if (command === '/help' || !text) {
    await sendTelegramMessage(chatId, TELEGRAM_HELP_TEXT, env, telegramActionKeyboard(env));
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
      `Create or import up to ${MAX_WALLETS_PER_USER} wallets from 💳 Wallets — they sync to the Mini App automatically.`,
    ), env, chatType === 'private' ? telegramWalletSetupKeyboard() : undefined);
    return;
  }
  if (command === '/importkey') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, '🔒 For your safety, only send private keys in a private chat with this bot — never in a group.', env);
      return;
    }
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
    telegramActionKeyboard(env),
  );
}

type TelegramHomeWallet = { evmAddress: string; solanaAddress: string; nearAddress?: string | null } | null;

/**
 * The user's trading wallet for the home screen; creates the NEAR account for pre-NEAR wallets.
 * With `provision` (/start) a first wallet is generated, so the Mini App finds it synced on open.
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

/** Home screen shared by /start and /menu: wallet summary on top, then how to trade. */
function telegramHomeText(heading: string, wallet: TelegramHomeWallet): string {
  return tgMessage(
    tgTitle('⚡', heading, 'Cross-chain trading terminal · Solana · Base · Arbitrum · BNB · Robinhood · Arc · NEAR'),
    wallet
      ? tgSection('💳', 'Your wallet', [
        `EVM  <code>${escapeTelegramHtml(wallet.evmAddress)}</code>`,
        `SOL  <code>${escapeTelegramHtml(wallet.solanaAddress)}</code>`,
        ...(wallet.nearAddress ? [`NEAR  <code>${escapeTelegramHtml(wallet.nearAddress)}</code>`] : []),
      ])
      : tgSection('💳', 'Wallet', ['No trading wallet yet — tap 💳 Wallets to create one in one tap']),
    tgSection('🚀', 'Trade', [
      'Paste any token address to open its trading panel',
      'Pay from any supported chain — the route is found for you',
      '🛒 Buy & Sell · 📊 Positions · Ⓝ /swap for NEAR',
      'Every trade shows a live quote first — you confirm',
    ]),
    tgFootnote('🔐 Keys are AES-256 encrypted · Hopr never asks for a seed phrase'),
  );
}

async function showTelegramWelcome(chatId: number, chatType: string | undefined, env: Env, firstName?: string, notice?: string): Promise<void> {
  const name = firstName?.trim() ? `, ${escapeTelegramHtml(firstName.trim().slice(0, 32))}` : '';
  const wallet = await loadTelegramHomeWallet(chatId, chatType, env, true);
  const home = telegramHomeText(`Welcome to Hopr${name}`, wallet);
  await sendTelegramMessage(chatId, notice ? tgMessage(`<b>${notice}</b>`, home) : home, env, telegramActionKeyboard(env));
}

async function showTelegramMenu(chatId: number, env: Env, panelId?: number, chatType = 'private'): Promise<void> {
  const wallet = await loadTelegramHomeWallet(chatId, chatType, env);
  await sendTelegramPanel(chatId, panelId, telegramHomeText('Hopr', wallet), env, telegramActionKeyboard(env));
}

const TELEGRAM_BUY_SELL_PROMPT = 'Paste the token contract address you want to trade.';

async function showTelegramBuySell(chatId: number, env: Env): Promise<void> {
  // A force-reply prompt focuses the input box; the reply is handled like any pasted address.
  await sendTelegramMessage(chatId, TELEGRAM_BUY_SELL_PROMPT, env, {
    force_reply: true,
    input_field_placeholder: 'Token address — EVM, Solana or NEAR',
  }, null);
}

/** Native decimals of the asset a position was funded with (for readable entry sizes). */
function fundingNativeDecimals(chainId: number): { decimals: number; symbol: string } {
  if (chainId === NEAR_CHAIN_ID) return { decimals: NEAR_DECIMALS, symbol: 'NEAR' };
  const chain = TELEGRAM_CHAINS.find((item) => item.id === chainId);
  return { decimals: chainId === 1151111081099710 ? 9 : 18, symbol: chain?.symbol ?? 'native' };
}

const NATIVE_FUNDING_TOKENS = new Set(['native', 'near', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '11111111111111111111111111111111']);

/** Open positions from trade history, each with live market data and a button to reopen its panel. */
async function showTelegramPositions(chatId: number, env: Env, panelId?: number): Promise<void> {
  if (!env.DB) {
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('📊', 'Positions'), 'Positions need the <code>DB</code> binding.'), env, telegramActionKeyboard(env));
    return;
  }
  type PositionRow = { target_token_address: string; target_chain_id: string; funding_chain_id: string; funding_token_address: string; funding_amount: string; created_at: string | null };
  const rows = await env.DB.prepare(
    `SELECT target_token_address, target_chain_id, funding_chain_id, funding_token_address, funding_amount, created_at
       FROM user_trades WHERE user_id = ?1 AND status IN ('SUBMITTED','CONFIRMED')
       ORDER BY created_at DESC LIMIT 8`
  ).bind(String(chatId)).all<PositionRow>().then((result) => result.results ?? []).catch(() => [] as PositionRow[]);

  if (!rows.length) {
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('📊', 'Positions'),
      tgCard(['No open positions yet', 'Paste a token address and tap a 🟢 Buy button to open one']),
    ), env, { inline_keyboard: [[{ text: '🛒 Buy & Sell', callback_data: 'trade:start' }, { text: '◀️ Menu', callback_data: 'menu' }]] });
    return;
  }

  const markets = await Promise.all(rows.map(async (row) => {
    try {
      const response = await handleChainDetection(row.target_token_address, env, {});
      return response.ok ? await response.json() as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }));

  const blocks: string[] = [tgTitle('📊', 'Positions', `${rows.length} open · live DexScreener prices`)];
  const buttons: TelegramButton[] = [];
  rows.forEach((row, index) => {
    const market = markets[index];
    const symbol = typeof market?.symbol === 'string' ? market.symbol : shortenTelegramAddress(row.target_token_address);
    const chainId = Number(row.target_chain_id);
    const funding = fundingNativeDecimals(Number(row.funding_chain_id));
    const entry = NATIVE_FUNDING_TOKENS.has(row.funding_token_address.toLowerCase()) && /^\d+$/.test(row.funding_amount)
      ? `${formatUnits(row.funding_amount, funding.decimals)} ${funding.symbol}`
      : '—';
    const price = typeof market?.priceUsd === 'number' ? formatTokenPriceUsd(market.priceUsd) : '—';
    const change = typeof market?.change24h === 'number' ? formatChangeShort(market.change24h) : '—';
    const opened = formatAge(row.created_at ? Date.parse(`${row.created_at.replace(' ', 'T')}Z`) : undefined);
    blocks.push(`<b>${index + 1}. ${escapeTelegramHtml(symbol)}</b> · ${chainEmoji(chainId)}\n${tgCard([
      `Entry  ${entry}`,
      `Price  ${price} · 24h ${change}`,
      `<code>${escapeTelegramHtml(row.target_token_address)}</code>${opened ? ` · ${opened} ago` : ''}`,
    ])}`);
    const callback = `token:refresh:${row.target_token_address}`;
    if (callback.length <= 64 && buttons.length < 6) buttons.push({ text: `📈 ${symbol.slice(0, 12)}`, callback_data: callback });
  });

  const buttonRows: TelegramButton[][] = [];
  for (let index = 0; index < buttons.length; index += 3) buttonRows.push(buttons.slice(index, index + 3));
  await sendTelegramPanel(chatId, panelId, tgMessage(...blocks, tgFootnote('Tap a token to open its trading panel.')), env, {
    inline_keyboard: [...buttonRows, [{ text: '🔄 Refresh', callback_data: 'positions' }, { text: '◀️ Menu', callback_data: 'menu' }]],
  });
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
  // Market data and the user's profile are independent: fetch them together.
  const [response, profile] = await Promise.all([
    chainHint
      ? detectTokenOnChain(address, chainHint).catch(() => null).then((detected) => Response.json(detected ?? {}, { status: detected ? 200 : 404 }))
      : handleChainDetection(address, env, {}, { fresh }),
    env.DB || env.TELEGRAM_STATE ? readTelegramProfile(chatId, env).catch(() => null) : Promise.resolve(null),
  ]);
  const token = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    await sendTelegramPanel(chatId, panelId, tgMessage(
      tgTitle('🔍', 'No market found'),
      `No indexed token market was found for <code>${escapeTelegramHtml(address)}</code>.`,
      tgFootnote('Check the address and chain, then try again.'),
    ), env);
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
  const dex = typeof token.dexId === 'string' ? token.dexId.replace(/[-_]+/g, ' ').toUpperCase() : String(token.liquiditySource ?? 'DEX');
  const changes = (token.priceChanges ?? {}) as { m5?: number; h1?: number; h6?: number; h24?: number };
  const txns = token.txns24h as { buys?: number; sells?: number } | undefined;
  const age = formatAge(typeof token.pairCreatedAt === 'number' ? token.pairCreatedAt : undefined);

  // The profile supplies the funding chain / slippage shown on the card and its buttons.
  // Any chain can pay for any token; NEAR tokens default to paying with NEAR.
  const isNear = chainId === NEAR_CHAIN_ID;
  const fundingChain = TELEGRAM_CHAINS.find((item) => item.id === (profile?.fundingChainId ?? (isNear ? NEAR_CHAIN_ID : 8453))) ?? TELEGRAM_CHAINS[2];
  const fundingSymbol = fundingChain.symbol;
  const slippage = profile?.slippagePercent ?? 1;
  const nearViaRef = isNear && fundingChain.id === NEAR_CHAIN_ID;

  const identity = [
    listing ? `📡 Listed on ${escapeTelegramHtml(listing)}` : token.launchpad ? `📡 ${escapeTelegramHtml(String(token.launchpad))}` : null,
    `${chainEmoji(chainId)} ${escapeTelegramHtml(chain)} · 🏪 ${escapeTelegramHtml(dex)}`,
    [age && `🌱 ${age}`, txns && (txns.buys || txns.sells) ? `🔁 ${formatCount((txns.buys ?? 0) + (txns.sells ?? 0))} txns (🟢${formatCount(txns.buys ?? 0)} 🔴${formatCount(txns.sells ?? 0)})` : null]
      .filter(Boolean).join(' · ') || null,
  ].filter((line): line is string => Boolean(line));

  const result = tgMessage(
    `🪙 <b>${escapeTelegramHtml(symbol)}  |  ${escapeTelegramHtml(name)}</b>\n<code>${escapeTelegramHtml(address)}</code>\n${tgCard(identity)}`,
    tgSection('📊', 'Market', [
      `Price  <b>${formatTokenPriceUsd(price)}</b>`,
      `MC / FDV  <b>${formatCompactUsd(fdv)}</b>`,
      `Liquidity  <b>${formatCompactUsd(liquidity)}</b> ${liquidityBadge(liquidity)}`,
      `Volume 24h  <b>${formatCompactUsd(volume)}</b>`,
    ]),
    tgSection('📈', 'Price change', [
      changes.m5 !== undefined || changes.h1 !== undefined || changes.h6 !== undefined
        ? `5m ${formatChangeShort(changes.m5)} · 1h ${formatChangeShort(changes.h1)} · 6h ${formatChangeShort(changes.h6)} · 24h ${formatChangeShort(change)}`
        : `24h  ${formatPercentChange(change)}`,
    ]),
    tgSection('⚙️', 'Trade setup', [
      nearViaRef ? 'Route  Ref Finance · paid in NEAR' : `Funding  ${chainEmoji(fundingChain.id)} ${escapeTelegramHtml(fundingChain.name)} (${fundingSymbol})${fundingChain.id !== chainId ? ' · cross-chain' : ''}`,
      `Slippage  ${slippage}% · every trade is quoted before you confirm`,
    ]),
    tgFootnote(`DexScreener · ${telegramUtcTime()} · Scan only — no transaction was submitted.`),
  );

  // Persist alongside sending the card; the KV write starts first, so a tap on the new buttons sees this token.
  const persisted = env.DB || env.TELEGRAM_STATE
    ? writeTelegramProfile(chatId, {
      ...(profile ?? {}),
      lastTokenAddress: address,
      lastTokenChainId: chainId,
      lastTokenChainType: token.chainType === 'SVM' || token.chainType === 'NEAR' ? token.chainType : 'EVM',
      lastTokenSymbol: symbol,
    }, env).catch((error) => console.error('Telegram token profile persistence failed', error))
    : Promise.resolve();
  await Promise.all([persisted, sendTelegramPanel(chatId, panelId, result, env, telegramTokenKeyboard(address, {
    chainId,
    fundingChainId: fundingChain.id,
    fundingSymbol,
    fundingChainName: fundingChain.name.replace(' One', '').replace(' Chain', ''),
    slippagePercent: slippage,
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

async function showTelegramWallet(chatId: number, env: Env, panelId?: number): Promise<void> {
  let tradingWallet: { evmAddress: string; solanaAddress: string; nearAddress?: string | null } | null = null;
  try {
    tradingWallet = await getCustodialWallet(String(chatId), env);
  } catch {
    tradingWallet = null;
  }
  if (tradingWallet) {
    // Wallets created before NEAR support get their NEAR account on first view.
    const nearAddress = tradingWallet.nearAddress ?? await ensureNearWallet(String(chatId), env).catch(() => null);
    await showTelegramWalletBalances(chatId, tradingWallet.evmAddress, tradingWallet.solanaAddress, env, { label: 'Trading wallet', panelId, nearAddress: nearAddress ?? undefined, custodial: true });
    return;
  }

  await sendTelegramPanel(chatId, panelId, tgMessage(
    tgTitle('💳', 'No wallet yet', `Create a wallet or import one you own — up to ${MAX_WALLETS_PER_USER} wallets.`),
    tgCard([
      '📦 <b>Create</b> — a new encrypted EVM + Solana + NEAR wallet',
      '📥 <b>Import</b> — bring a private key you already own',
    ]),
    tgFootnote('Wallets sync to the Hopr Mini App automatically. Never send a seed phrase to anyone, including this bot.'),
  ), env, telegramWalletSetupKeyboard());
}

/** NEAR block for the wallet card: spendable NEAR plus any NEP-141 tokens held. */
async function telegramNearBalanceBlock(nearAddress: string, env: Env, custodial: boolean): Promise<string> {
  let detail: NearBalance | undefined;
  const reading = await tracked(env, `397:${nearAddress}`, async () => {
    detail = await getNearBalance(nearAddress, [], nearRpcOptions(env));
    return BigInt(detail.availableYocto);
  });
  const lines = [`${chainEmoji(NEAR_CHAIN_ID)} <b>NEAR</b>: ${telegramTrackedAmount(reading, 24, 'NEAR')}`];
  for (const token of detail?.tokens ?? []) lines.push(`🪙 <b>${escapeTelegramHtml(token.symbol)}</b>: ${escapeTelegramHtml(formatUnits(token.balance, token.decimals))}`);
  if (custodial && reading?.value === 0n && !reading.cachedAt) lines.push('<i>Fund this address with NEAR to cover trades and storage.</i>');
  return `<b>NEAR</b> · <code>${escapeTelegramHtml(nearAddress)}</code>\n${tgCard(lines)}`;
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
  options: { label?: string; panelId?: number; nearAddress?: string; custodial?: boolean } = {},
): Promise<void> {
  const blocks: string[] = [tgTitle('💳', options.label ?? 'Wallet', 'Native balances across supported chains')];
  const pricesPromise = nativePricesUsd();
  const nearBlock = options.nearAddress ? telegramNearBalanceBlock(options.nearAddress, env, Boolean(options.custodial)) : null;

  if (evmAddress) {
    const evmChains = TELEGRAM_CHAINS.filter((chain) => chain.id !== 1151111081099710 && chain.id !== NEAR_CHAIN_ID);
    const results = await Promise.all(evmChains.map(async (chain) => {
      return { chain, reading: await tracked(env, `${chain.id}:${evmAddress.toLowerCase()}`, () => readNativeBalance(chain.id, evmAddress)) };
    }));
    const prices = await pricesPromise;
    const lines = results.map(({ chain, reading }) => {
      const price = prices[chain.symbol];
      const usd = reading && price ? ` · ≈$${(Number(reading.value) / 1e18 * price).toFixed(2)}` : '';
      return `${chainEmoji(chain.id)} <b>${escapeTelegramHtml(chain.name)}</b>: ${telegramTrackedAmount(reading, 18, chain.symbol)}${usd}`;
    });
    blocks.push(`<b>EVM</b> · <code>${escapeTelegramHtml(evmAddress)}</code>\n${tgCard(lines)}`);
  }

  if (solanaAddress) {
    const reading = await tracked(env, `1151111081099710:${solanaAddress}`, () => readNativeBalance(1151111081099710, solanaAddress));
    const line = `${chainEmoji(1151111081099710)} <b>Solana</b>: ${telegramTrackedAmount(reading, 9, 'SOL')}`;
    blocks.push(`<b>Solana</b> · <code>${escapeTelegramHtml(solanaAddress)}</code>\n${tgCard([line])}`);
  }

  if (nearBlock) blocks.push(await nearBlock);

  blocks.push(tgFootnote(`Checked ${telegramUtcTime()} · tap an address to copy it · cached balances carry their last-read time`));
  await sendTelegramPanel(chatId, options.panelId, tgMessage(...blocks), env, telegramWalletActionKeyboard(env));
}

function telegramWalletActionKeyboard(env: Env): TelegramKeyboard {
  return {
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: 'wallet' }, { text: '📦 Create wallet', callback_data: 'wallet:generate' }],
      [{ text: '📥 Import wallet', callback_data: 'wallet:import' }, { text: '💼 Preferred wallet', callback_data: 'wallet:preferred' }],
      [{ text: '🔑 Export keys', callback_data: 'wallet:export' }, { text: '🗑 Delete wallet', callback_data: 'wallet:delete' }],
      ...telegramMiniAppRow(env, '🔐 Open Wallet Vault'),
      [{ text: '⚙️ Settings', callback_data: 'settings' }, { text: '◀️ Menu', callback_data: 'menu' }],
    ],
  };
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
async function showTelegramWalletExport(chatId: number, env: Env): Promise<void> {
  const userId = String(chatId);
  if (!env.DB || !env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, '🧩 Exporting keys requires the bot owner to configure <code>DB</code> and <code>ENCRYPTION_KEY</code>.', env, telegramActionKeyboard(env));
    return;
  }
  const row = await env.DB.prepare(
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
  const near = await env.DB.prepare(`SELECT near_address, near_encrypted_key FROM user_wallets WHERE user_id = ?1`)
    .bind(userId).first<{ near_address: string | null; near_encrypted_key: string | null }>()
    .catch(() => null); // no NEAR columns before migrations/0004_add_near_chain.sql
  const nearKey = await decryptIfPresent(near?.near_encrypted_key);
  const text = tgMessage(
    tgTitle('🔑', 'Private keys', 'Anyone with these keys has full control of these wallets.'),
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

/** /importkey evm <key> or /importkey solana <key> — stores an existing wallet instead of generating one. */
async function handleTelegramImportKey(chatId: number, args: string[], env: Env): Promise<void> {
  if (!env.DB || !env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, '🧩 Importing a key requires the bot owner to configure <code>DB</code> and <code>ENCRYPTION_KEY</code>.', env);
    return;
  }
  const [network, rawKey] = args;
  const userId = String(chatId);
  const imported = (label: string, address: string) => tgMessage(
    tgTitle('✅', `${label} key imported`),
    `<code>${escapeTelegramHtml(address)}</code>`,
    tgFootnote('🧹 Delete your previous message containing the raw key now.'),
  );
  try {
    if (network?.toLowerCase() === 'evm') {
      const { address, privateKey } = importEvmKey(rawKey ?? '');
      const encrypted = packEncryptedSecret(await encryptPrivateKey(privateKey, env.ENCRYPTION_KEY));
      await env.DB.prepare(
        `INSERT INTO user_wallets (user_id, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key)
         VALUES (?1, ?2, ?3, COALESCE((SELECT solana_address FROM user_wallets WHERE user_id = ?1), ''), COALESCE((SELECT solana_encrypted_key FROM user_wallets WHERE user_id = ?1), ''))
         ON CONFLICT(user_id) DO UPDATE SET evm_address = excluded.evm_address, evm_encrypted_key = excluded.evm_encrypted_key`
      ).bind(userId, address, encrypted).run();
      await sendTelegramMessage(chatId, imported('EVM', address), env, telegramActionKeyboard(env));
    } else if (network?.toLowerCase() === 'solana') {
      const { address, privateKey } = importSolanaKey(rawKey ?? '');
      const encrypted = packEncryptedSecret(await encryptPrivateKey(privateKey, env.ENCRYPTION_KEY));
      await env.DB.prepare(
        `INSERT INTO user_wallets (user_id, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key)
         VALUES (?1, COALESCE((SELECT evm_address FROM user_wallets WHERE user_id = ?1), ''), COALESCE((SELECT evm_encrypted_key FROM user_wallets WHERE user_id = ?1), ''), ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET solana_address = excluded.solana_address, solana_encrypted_key = excluded.solana_encrypted_key`
      ).bind(userId, address, encrypted).run();
      await sendTelegramMessage(chatId, imported('Solana', address), env, telegramActionKeyboard(env));
    } else if (network?.toLowerCase() === 'near') {
      const outcome = await importTelegramNearKey(userId, rawKey ?? '', args[2]?.toLowerCase(), env);
      if ('error' in outcome) {
        await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'NEAR key not imported'), escapeTelegramHtml(outcome.error)), env);
        return;
      }
      await sendTelegramMessage(chatId, imported('NEAR', outcome.accountId), env, telegramActionKeyboard(env));
    } else {
      await sendTelegramMessage(chatId, tgMessage(tgTitle('📥', 'Import a wallet'), tgCard([
        '/importkey evm &lt;private-key&gt;',
        '/importkey solana &lt;base58-secret-key&gt;',
        '/importkey near &lt;ed25519:key&gt; [account.near]',
      ])), env);
    }
  } catch {
    await sendTelegramMessage(chatId, '⚠️ That key could not be parsed. Double-check the format and try again — and delete the bad message either way.', env);
  }
}

/**
 * Store an imported NEAR key as the user's NEAR trading account. A named
 * account must list the key as a full-access key on-chain. Refuses to replace
 * a current NEAR account that still holds funds, so a key is never discarded
 * while money depends on it.
 */
async function importTelegramNearKey(userId: string, rawKey: string, namedAccount: string | undefined, env: Env): Promise<{ accountId: string } | { error: string }> {
  const implicitRequested = namedAccount !== undefined && /^[0-9a-f]{64}$/.test(namedAccount);
  const pair = importNearKey(rawKey, namedAccount && !implicitRequested ? namedAccount : undefined);
  if (implicitRequested && pair.accountId !== namedAccount) return { error: 'That key does not control the implicit account you entered.' };
  const rpc = nearRpcOptions(env);
  if (namedAccount && !implicitRequested && !await verifyFullAccessKey(pair.accountId, pair.publicKey, rpc)) {
    return { error: `That key is not a full-access key of ${pair.accountId}.` };
  }
  const current = await getCustodialWallet(userId, env).catch(() => null);
  if (!current) return { error: 'Create a Hopr trading wallet first (Wallet → Create wallet), then import your NEAR key into it.' };
  if (current.nearAddress && current.nearAddress !== pair.accountId) {
    const balance = await getNearBalance(current.nearAddress, [], rpc).catch(() => null);
    if (!balance || (balance.exists && (BigInt(balance.totalYocto) > 0n || balance.tokens.length > 0))) {
      return { error: `Your current NEAR wallet (${current.nearAddress}) still holds funds or could not be checked. Export its key with /exportkeys and move the funds before replacing it.` };
    }
  }
  const encrypted = packEncryptedSecret(await encryptPrivateKey(pair.privateKey, env.ENCRYPTION_KEY!));
  try {
    await env.DB!.prepare(
      `UPDATE wallet_accounts SET near_address = ?1, near_encrypted_key = ?2
         WHERE id = (SELECT id FROM wallet_accounts WHERE user_id = ?3 AND evm_address IS NOT NULL AND solana_address IS NOT NULL ORDER BY is_active DESC, created_at ASC LIMIT 1)`
    ).bind(pair.accountId, encrypted, userId).run().catch((error: unknown) => {
      if (/near_/.test(String(error))) throw error; // missing NEAR columns
    });
    await env.DB!.prepare(`UPDATE user_wallets SET near_address = ?1, near_encrypted_key = ?2 WHERE user_id = ?3`)
      .bind(pair.accountId, encrypted, userId).run();
  } catch (error) {
    if (/near_/.test(String(error))) return { error: 'NEAR wallets need migrations/0004_add_near_chain.sql applied first.' };
    throw error;
  }
  return { accountId: pair.accountId };
}

async function showTelegramWalletGenerate(chatId: number, env: Env): Promise<void> {
  const userId = String(chatId);
  if (!env.DB) {
    await sendTelegramMessage(chatId, '🧩 Creating a trading wallet requires the bot owner to configure the D1 database binding.', env, telegramActionKeyboard(env));
    return;
  }
  if (!env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, '🧩 Creating a trading wallet requires the bot owner to set the <code>ENCRYPTION_KEY</code> secret.', env, telegramActionKeyboard(env));
    return;
  }
  const existing = await getCustodialWallet(userId, env);
  let wallet: { evmAddress: string; solanaAddress: string; nearAddress?: string | null };
  let label: string | null = null;
  if (!existing) {
    wallet = await createCustodialWallet(userId, env);
  } else {
    // Another wallet (up to the cap); it becomes the active one, same as in the Mini App vault.
    try {
      const near = generateNearWallet();
      const row = await storeWalletAccount(userId, { ...generateDualWallet(), nearAddress: near.address, nearPrivateKey: near.privateKey }, '', 'generated', env);
      wallet = { evmAddress: row.evm_address!, solanaAddress: row.solana_address!, nearAddress: row.near_address ?? null };
      label = row.label;
    } catch (error) {
      const message = error instanceof WalletLimitError ? error.message : 'Wallet storage is unavailable. Apply migrations/0003_multi_wallets.sql, then try again.';
      await sendTelegramMessage(chatId, tgMessage(tgTitle('💳', 'No new wallet created'), escapeTelegramHtml(message)), env, telegramWalletActionKeyboard(env));
      return;
    }
  }
  const nearAddress = wallet.nearAddress ?? await ensureNearWallet(userId, env).catch(() => null);
  await sendTelegramMessage(
    chatId,
    tgMessage(
      tgTitle('✦', label ? `Wallet ${escapeTelegramHtml(label)} created` : 'Your Hopr wallet is ready', label ? 'It is now your active trading wallet · synced to the Mini App.' : 'Welcome to your private cross-chain command center.'),
      tgCard([
        `<b>EVM</b>  <code>${escapeTelegramHtml(wallet.evmAddress)}</code>`,
        `<b>Solana</b>  <code>${escapeTelegramHtml(wallet.solanaAddress)}</code>`,
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
    telegramActionKeyboard(env),
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
      await sendTelegramMessage(chatId, tgMessage(tgTitle('🔎', 'Pick a token first'), 'Paste a token address, then tap ✏️ Buy X on its panel.'), env, telegramActionKeyboard(env));
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
      const rpcUrls = {
        evm: (chainId: number) => getChainById(chainId)?.rpcUrl ?? '',
        solana: SUPPORTED_CHAINS.find((c) => c.key === 'sol')!.rpcUrl,
      };
      const result = await confirmTrade(String(chatId), confirmMatch[1], rpcUrls, env);
      await recordTelegramReferral(String(chatId), result, env);
      if (result.venue === 'intents' || result.continuationId) {
        const explorer = TELEGRAM_EXPLORERS[result.fromChainId ?? NEAR_CHAIN_ID];
        await sendTelegramPanel(chatId, panelId, telegramIntentsSentMessage(result), env, {
          inline_keyboard: [
            ...(result.continuationId ? [[{ text: '▶️ Continue — next step', callback_data: `trade:cont:${result.continuationId}` }]] : []),
            ...(explorer ? [[{ text: '🔎 View transaction', url: `${explorer}${encodeURIComponent(result.txHash)}` }]] : []),
            [{ text: '💳 Wallet', callback_data: 'wallet' }, { text: '◀️ Menu', callback_data: 'menu' }],
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
            [{ text: '💳 Wallet', callback_data: 'wallet' }, { text: '◀️ Menu', callback_data: 'menu' }],
          ],
        },
      );
    } catch (error) {
      await sendTelegramPanel(
        chatId,
        panelId,
        tgMessage(tgTitle('⚠️', 'Trade was not submitted'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')),
        env,
        telegramActionKeyboard(env),
      );
    }
    return;
  }
  const profile = target ?? await readTelegramProfile(chatId, env);
  if (!profile?.lastTokenAddress || !profile.lastTokenChainId) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('🔎', 'Pick a token first'), 'Open a token lookup first (paste a contract address), then use the buy/sell buttons on that result.'), env, telegramActionKeyboard(env));
    return;
  }

  const userId = String(chatId);
  const wallet = await getCustodialWallet(userId, env);
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
    await sendTelegramMessage(chatId, '🧩 Trading is not available: the bot owner has not set <code>ENCRYPTION_KEY</code>.', env, telegramActionKeyboard(env));
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
    await sendTelegramMessage(chatId, '⛓ That chain is not supported for trading yet.', env, telegramActionKeyboard(env));
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
            `🏷 <b>Platform fee</b>  0.5% · charged once${env.ONECLICK_JWT ? '' : ' + 0.25% 1Click routing fee'}`,
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
          '🏷 <b>Platform fee</b>  0.5% included',
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
        await sendTelegramMessage(chatId, tgMessage(tgTitle('📭', 'Nothing to sell'), `No open ${tokenSymbol} position found for this wallet to sell.`), env, telegramActionKeyboard(env));
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
          '🏷 <b>Platform fee</b>  0.5% included',
        ]),
        env,
        telegramTradeConfirmationKeyboard(trade.id),
      );
      return;
    }
  } catch (error) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'Trade failed'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')), env, telegramActionKeyboard(env));
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
  const storage = BigInt(swap.outputStorageDeposit) + BigInt(swap.wrapStorageDeposit) + BigInt(swap.fee?.storageDeposit ?? '0');
  const fee = BigInt(swap.fee?.amount ?? '0');
  const inSymbol = escapeTelegramHtml(swap.tokenInSymbol);
  const outSymbol = escapeTelegramHtml(swap.tokenOutSymbol);
  return tgMessage(
    tgTitle('🧾', `Quote ready · ${trade.kind === 'buy' ? 'BUY' : 'SELL'}`, 'Ⓝ NEAR · Ref Finance'),
    tgCard([
      `💸 <b>You pay</b>  ${formatUnits(BigInt(quote.amountIn) + fee, swap.tokenInDecimals)} ${inSymbol}`,
      `🎯 <b>You receive</b>  ≈ ${formatUnits(quote.expectedOut, swap.tokenOutDecimals)} ${outSymbol}`,
      `🛡 <b>Minimum received</b>  ${formatUnits(quote.minOut, swap.tokenOutDecimals)} ${outSymbol}`,
      `💱 <b>Rate</b>  1 ${inSymbol} ≈ ${nearDisplayRate(quote.amountIn, swap.tokenInDecimals, quote.expectedOut, swap.tokenOutDecimals)} ${outSymbol}`,
      `🧭 <b>Route</b>  Ref Finance · ${quote.hops} hop${quote.hops === 1 ? '' : 's'}`,
      `🎚 <b>Slippage</b>  ${Number((quote.slippage * 100).toFixed(2))}%`,
      ...(fee > 0n ? [`🏷 <b>Platform fee</b>  0.5% (${formatUnits(fee, swap.tokenInDecimals)} ${inSymbol})`] : []),
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
      await sendTelegramMessage(chatId, tgMessage(tgTitle('📭', 'Nothing to sell'), `Your NEAR wallet holds no ${escapeTelegramHtml(metadata.symbol)}.`), env, telegramActionKeyboard(env));
      return;
    }
    const trade = await prepareNearSwap({ userId, kind: 'sell', tokenIn: token, tokenOut: NEAR_TOKEN, amountInUnits: amount.toString(), slippage }, env);
    await sendTelegramNearQuote(chatId, trade, env);
  } catch (error) {
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'No quote'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')), env, telegramActionKeyboard(env));
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

async function requestLifiQuote(params: {
  fromChain: number;
  fromToken: string;
  fromAmount: string;
  fromAddress: string;
  toChain: number;
  toToken: string;
  slippage: number;
  integrator: string;
  fee: number;
}, env: Env): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
  const query = new URLSearchParams({
    fromChain: String(params.fromChain),
    fromToken: params.fromToken,
    fromAmount: params.fromAmount,
    fromAddress: params.fromAddress,
    toChain: String(params.toChain),
    toToken: params.toToken,
    slippage: String(params.slippage),
    integrator: params.integrator,
    fee: String(params.fee),
  });
  try {
    const response = await fetch(`https://li.quest/v1/quote?${query}`, {
      headers: {
        Accept: 'application/json',
        ...(env.LIFI_API_KEY ? { 'x-lifi-api-key': env.LIFI_API_KEY } : {}),
      },
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof data.message === 'string' ? data.message : `HTTP ${response.status}`;
      return { ok: false, message };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, message: 'the quote service could not be reached' };
  }
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
    const rows = sortPools(feed.pools, sourceId === 'nearpaid' ? 'newest' : 'volume').slice(0, 6);
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
    if (!action) return sendTelegramPanel(chatId, panelId, 'This pool button expired. Open /pools for fresh token buttons.', env, telegramActionKeyboard(env));
    const { pool, fundingChainId, amount } = action;
    if (poolAction[1] === 'view') return lookupTelegramToken(chatId, pool.tokenAddress, env, panelId, pool.chainId, launchpadById(pool.source)?.name);
    const profile = await readTelegramProfile(chatId, env).catch(() => null);
    return handleTelegramTradeAction(chatId, `trade:buy:${amount}`, env, panelId, {
      ...profile, fundingChainId, lastTokenAddress: pool.tokenAddress, lastTokenChainId: pool.chainId,
      lastTokenChainType: pool.chainId === NEAR_CHAIN_ID ? 'NEAR' : pool.network === 'solana' ? 'SVM' : 'EVM', lastTokenSymbol: pool.symbol,
    });
  }
  if (data === 'pools' || data.startsWith('pools:')) return showTelegramPools(chatId, (data === 'pools' ? 'pump' : data.slice(6)) as LaunchpadId, env, panelId);
  if (data === 'help') return sendTelegramPanel(chatId, panelId, TELEGRAM_HELP_TEXT, env, telegramActionKeyboard(env));
  if (data === 'menu') return showTelegramMenu(chatId, env, panelId, chatType);
  if (data === 'positions') return showTelegramPositions(chatId, env, panelId);
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
  if (data === 'wallet:preferred') {
    return sendTelegramPanel(
      chatId,
      panelId,
      tgMessage(tgTitle('💼', 'Preferred wallet'), 'The wallet shown in /wallet is your preferred wallet. Use the Wallet Vault in the Mini App to create, select, archive, or manage multiple wallets.'),
      env,
      telegramWalletActionKeyboard(env),
    );
  }
  if (data === 'wallet:delete') {
    return sendTelegramPanel(
      chatId,
      panelId,
      tgMessage(
        tgTitle('⚠️', 'Delete wallet permanently?'),
        tgCard(['This cannot be undone.', 'If you did not back up the private keys, the wallet and its funds <b>cannot be recovered</b>.']),
      ),
      env,
      { inline_keyboard: [[{ text: '🗑 Delete permanently', callback_data: 'wallet:delete:confirm' }], [{ text: '◀️ Keep my wallet', callback_data: 'wallet' }]] },
    );
  }
  if (data === 'wallet:delete:confirm') {
    if (!env.DB) return sendTelegramPanel(chatId, panelId, '🧩 Wallet storage is not configured.', env);
    await env.DB.prepare('DELETE FROM wallet_accounts WHERE user_id = ?1').bind(String(chatId)).run().catch(() => undefined);
    await env.DB.prepare('DELETE FROM user_wallets WHERE user_id = ?1').bind(String(chatId)).run().catch(() => undefined);
    return sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('✅', 'Wallet deleted permanently'), 'It cannot be recovered without a backup.'), env, telegramActionKeyboard(env));
  }
  if (data === 'wallet:export') {
    return showTelegramWalletExport(chatId, env);
  }
  if (data === 'wallet:import') {
    return sendTelegramPanel(
      chatId,
      panelId,
      tgMessage(
        tgTitle('📥', 'Import a wallet you own'),
        'Send one of these as a direct message (not in a group):',
        tgCard(['/importkey evm &lt;private-key&gt;', '/importkey solana &lt;base58-secret-key&gt;', '/importkey near &lt;ed25519:key&gt; [account.near]']),
        tgFootnote(`🧹 Delete your message right after sending it. Up to ${MAX_WALLETS_PER_USER} wallets; the Mini App Wallet Vault imports too.`),
      ),
      env,
      telegramActionKeyboard(env),
    );
  }
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
      return Response.json(feed, { headers: { ...corsHeaders, 'Cache-Control': feed.stale ? 'no-store' : 'public, max-age=30' } });
    } catch {
      return Response.json({ error: 'Pool provider could not refresh. Please retry.' }, { status: 503, headers: { ...corsHeaders, 'Retry-After': '120' } });
    }
  }

  // POST /api/detect - Chain detection
  if (path === '/api/detect' && request.method === 'POST') {
    const body = await request.json() as { address: string };
    return handleChainDetection(body.address, env, corsHeaders);
  }

  // POST /api/telegram/session - verify Mini App initData and return public wallet addresses
  if (path === '/api/telegram/session' && request.method === 'POST') {
    return handleTelegramSession(request, env, corsHeaders);
  }

  // POST /api/telegram/wallet/create - create or return the user's encrypted custodial wallet
  if (path === '/api/telegram/wallet/create' && request.method === 'POST') {
    return handleTelegramWalletCreate(request, env, corsHeaders);
  }
  if (path === '/api/telegram/wallets' && request.method === 'POST') return handleTelegramWalletList(request, env, corsHeaders);
  if (path === '/api/telegram/wallet/import' && request.method === 'POST') return handleTelegramWalletImport(request, env, corsHeaders);
  if (path === '/api/telegram/wallet/rename' && request.method === 'POST') return handleTelegramWalletRename(request, env, corsHeaders);
  if (path === '/api/telegram/wallet/active' && request.method === 'POST') return handleTelegramWalletActive(request, env, corsHeaders);
  if (path === '/api/telegram/wallet/reveal' && request.method === 'POST') return handleTelegramWalletReveal(request, env, corsHeaders);
  if (path === '/api/telegram/wallet/delete' && request.method === 'POST') return handleTelegramWalletDelete(request, env, corsHeaders);

  // GET /api/wallet/:address/balances
  if (path.match(/^\/api\/wallet\/[^/]+\/balances$/) && request.method === 'GET') {
    const address = path.split('/')[3];
    return handleWalletBalances(address, env, corsHeaders);
  }

  // POST /api/trade/buy
  if (path === '/api/trade/buy' && request.method === 'POST') {
    const body = await request.json() as TradeRequest;
    return handleTradeBuy(body, env, corsHeaders);
  }

  // POST /api/trade/quote - LI.FI route quote and executable transaction payload,
  // or (chain: "near") a Ref Finance quote; with Telegram initData it also
  // prepares a confirmable custodial NEAR swap.
  if (path === '/api/trade/quote' && request.method === 'POST') {
    const body = await request.json() as TradeRequest & { toChainId?: number; toToken?: string; chain?: string };
    if (body.chain === 'near') return handleNearTradeQuote(body as unknown as NearQuoteRequest, env, corsHeaders);
    return handleTradeQuote(body, env, corsHeaders);
  }

  // Referral program (/api/referrals/*, /api/admin/referral-payouts*)
  const referralResponse = await handleReferralRequest(request, path, env, corsHeaders, {
    resolveTelegram: (initData) => resolveTelegramReferralUser(initData, env),
  });
  if (referralResponse) return referralResponse;

  // GET /api/config - public settings the dashboard needs (fee account, referral share)
  if (path === '/api/config' && request.method === 'GET') {
    return Response.json({
      nearFeeAccount: env.HOPR_INTENTS_FEE_ACCOUNT?.trim() ?? '',
      fees: { swap: 0.005, bridge: 0.01 },
      referralShare: REFERRAL_SHARE,
      telegramBot: await telegramBotUsername(env).catch(() => null),
    }, { headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300' } });
  }

  // GET /api/lifi/quote - LI.FI quote proxy for the dashboard (adds the server-side key)
  if (path === '/api/lifi/quote' && request.method === 'GET') {
    return handleLifiQuoteProxy(url, env, corsHeaders);
  }

  // POST /api/intents/quote - NEAR Intents 1Click proxy (adds Hopr's app fee and the 1Click key)
  if (path === '/api/intents/quote' && request.method === 'POST') {
    return handleIntentsQuoteProxy(request, env, corsHeaders);
  }

  // POST /api/telegram/trade/prepare | continue - Mini App trades with the Hopr (bot) wallet
  if (path === '/api/telegram/trade/prepare' && request.method === 'POST') return handleTelegramTradePrepare(request, env, corsHeaders);
  if (path === '/api/telegram/trade/continue' && request.method === 'POST') return handleTelegramTradeContinue(request, env, corsHeaders);

  // POST /api/trade/execute - confirm a pending custodial quote (Telegram Mini App auth)
  if (path === '/api/trade/execute' && request.method === 'POST') {
    return handleTradeExecute(request, env, corsHeaders);
  }

  // POST /api/trade/sell
  if (path === '/api/trade/sell' && request.method === 'POST') {
    const body = await request.json() as TradeRequest & { percentage: number };
    return handleTradeSell(body, env, corsHeaders);
  }

  // GET /api/trade/:id/status
  if (path.match(/^\/api\/trade\/[^/]+\/status$/) && request.method === 'GET') {
    const tradeId = path.split('/')[3];
    return handleTradeStatus(tradeId, env, corsHeaders);
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function verifyTelegramInitData(initData: string, botToken: string): Promise<{ id: number; first_name?: string; last_name?: string; username?: string } | null> {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), botToken);
  const expectedHash = await hmacSha256(secretKey, dataCheckString);
  const actualHash = hexToBytes(receivedHash);
  if (!actualHash || !bytesEqual(expectedHash, actualHash)) return null;

  try {
    const user = JSON.parse(params.get('user') ?? '') as { id?: number; first_name?: string; last_name?: string; username?: string };
    return typeof user.id === 'number' ? { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username } : null;
  } catch {
    return null;
  }
}

async function handleTelegramSession(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const auth = await getTelegramRequestUser(request, env);
  if (!auth) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
  const { user } = auth;
  const userId = String(user.id);

  // Same custodial accounts the bot uses, so the Mini App and Telegram always show identical wallets.
  // Opening the Mini App before /start still lands on a ready wallet.
  let wallet = await getCustodialWallet(userId, env).catch(() => null);
  if (!wallet && env.DB && env.ENCRYPTION_KEY) wallet = await createCustodialWallet(userId, env).catch(() => null);
  const nearAddress = wallet ? wallet.nearAddress ?? await ensureNearWallet(userId, env).catch(() => null) : null;
  const wallets = env.DB
    ? await env.DB.prepare(`SELECT * FROM wallet_accounts WHERE user_id = ?1 ORDER BY is_active DESC, created_at ASC`).bind(userId)
      .all<WalletAccountRow>().then((rows) => (rows.results ?? []).map(publicWallet)).catch(() => [])
    : [];
  return Response.json({
    user: { id: user.id, firstName: user.first_name, lastName: user.last_name, username: user.username },
    wallet: wallet ? { evmAddress: wallet.evmAddress, solanaAddress: wallet.solanaAddress, nearAddress } : null,
    wallets,
    maxWallets: MAX_WALLETS_PER_USER,
    walletSource: wallet ? 'telegram' : null,
  }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
}

async function handleTelegramWalletCreate(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.DB || !env.ENCRYPTION_KEY) {
    return Response.json({ error: 'Telegram wallet creation is not configured.' }, { status: 503, headers: corsHeaders });
  }
  const auth = await getTelegramRequestUser(request, env);
  if (!auth) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
  try {
    const body = auth.body as { label?: string };
    const near = generateNearWallet();
    const generated = { ...generateDualWallet(), nearAddress: near.address, nearPrivateKey: near.privateKey };
    const wallet = await storeWalletAccount(String(auth.user.id), generated, body.label || '', 'generated', env);
    return Response.json({ wallet: publicWallet(wallet), created: true }, { headers: corsHeaders });
  } catch (error) {
    if (error instanceof WalletLimitError) return Response.json({ error: error.message }, { status: 409, headers: corsHeaders });
    console.error('Telegram wallet creation failed', error);
    return Response.json({ error: 'Wallet storage is unavailable. Apply migrations/0003_multi_wallets.sql to the production D1 database, then try again.' }, { status: 503, headers: corsHeaders });
  }
}

type WalletAccountRow = {
  id: string; user_id: string; label: string; source: string; evm_address: string | null; evm_encrypted_key: string | null;
  solana_address: string | null; solana_encrypted_key: string | null; near_address?: string | null; near_encrypted_key?: string | null;
  is_active: number; created_at: string;
};

function publicWallet(row: WalletAccountRow | { id: string; label: string; source: string; evm_address: string | null; solana_address: string | null; near_address?: string | null; is_active: number; created_at: string }) {
  return { id: row.id, label: row.label, source: row.source, evmAddress: row.evm_address, solanaAddress: row.solana_address, nearAddress: row.near_address ?? null, isActive: Boolean(row.is_active), createdAt: row.created_at };
}

async function getTelegramRequestUser(request: Request, env: Env): Promise<{ user: { id: number; first_name?: string; last_name?: string; username?: string }; body: Record<string, unknown> } | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return null; }
  const initData = typeof body.initData === 'string' ? body.initData : '';
  if (!initData || initData.length > 4096) return null;
  const user = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  return user ? { user, body } : null;
}

class WalletLimitError extends Error {
  constructor() {
    super(`You already have ${MAX_WALLETS_PER_USER} wallets, the maximum. Delete one you no longer use to add another.`);
  }
}

async function storeWalletAccount(
  userId: string,
  wallet: { evmAddress: string | null; evmPrivateKey: string | null; solanaAddress: string | null; solanaPrivateKey: string | null; nearAddress?: string | null; nearPrivateKey?: string | null },
  label: string,
  source: 'generated' | 'imported',
  env: Env,
): Promise<WalletAccountRow> {
  if (!env.DB || !env.ENCRYPTION_KEY) throw new Error('Wallet storage is not configured.');
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM wallet_accounts WHERE user_id = ?1`).bind(userId).first<{ total: number }>();
  if ((count?.total ?? 0) >= MAX_WALLETS_PER_USER) throw new WalletLimitError();
  const id = crypto.randomUUID();
  const encrypt = async (key: string | null | undefined) => key ? packEncryptedSecret(await encryptPrivateKey(key, env.ENCRYPTION_KEY!)) : null;
  const evmEncrypted = await encrypt(wallet.evmPrivateKey);
  const solanaEncrypted = await encrypt(wallet.solanaPrivateKey);
  const nearEncrypted = await encrypt(wallet.nearPrivateKey);
  const finalLabel = label.trim() || await nextWalletLabel(userId, env);
  const hasNear = Boolean(wallet.nearAddress && nearEncrypted);
  if (!hasNear) {
    await env.DB.prepare(`UPDATE wallet_accounts SET is_active = 0 WHERE user_id = ?1`).bind(userId).run();
    await env.DB.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)`).bind(id, userId, finalLabel.slice(0, 80), source, wallet.evmAddress, evmEncrypted, wallet.solanaAddress, solanaEncrypted).run();
  } else {
    // Insert first, then activate: a failed insert (e.g. before migration 0004) must not leave the user with no active wallet.
    try {
      await env.DB.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, near_address, near_encrypted_key, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)`).bind(id, userId, finalLabel.slice(0, 80), source, wallet.evmAddress, evmEncrypted, wallet.solanaAddress, solanaEncrypted, wallet.nearAddress, nearEncrypted).run();
    } catch (error) {
      if (!/near_/.test(String(error))) throw error;
      await env.DB.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`).bind(id, userId, finalLabel.slice(0, 80), source, wallet.evmAddress, evmEncrypted, wallet.solanaAddress, solanaEncrypted).run();
    }
    await env.DB.prepare(`UPDATE wallet_accounts SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END WHERE user_id = ?2`).bind(id, userId).run();
  }
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

async function walletAuth(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<{ auth: { user: { id: number }; body: Record<string, unknown> } } | Response> {
  if (!env.DB || !env.ENCRYPTION_KEY) return Response.json({ error: 'Wallet storage is not configured.' }, { status: 503, headers: corsHeaders });
  const auth = await getTelegramRequestUser(request, env);
  if (!auth) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
  return { auth: { user: auth.user, body: auth.body } };
}

async function handleTelegramWalletList(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checked = await walletAuth(request, env, corsHeaders); if (checked instanceof Response) return checked;
  const rows = await env.DB!.prepare(`SELECT * FROM wallet_accounts WHERE user_id = ?1 ORDER BY is_active DESC, created_at ASC`).bind(String(checked.auth.user.id)).all<WalletAccountRow>();
  return Response.json({ wallets: (rows.results ?? []).map(publicWallet) }, { headers: corsHeaders });
}

async function handleTelegramWalletImport(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checked = await walletAuth(request, env, corsHeaders); if (checked instanceof Response) return checked;
  const body = checked.auth.body as { network?: string; privateKey?: string; label?: string; confirmRisk?: boolean; accountId?: string };
  if (!body.confirmRisk || typeof body.privateKey !== 'string' || body.privateKey.length > 4096) return Response.json({ error: 'Confirm the private-key risk acknowledgement before importing.' }, { status: 400, headers: corsHeaders });
  try {
    const network = body.network;
    const blank: { evmAddress: string | null; evmPrivateKey: string | null; solanaAddress: string | null; solanaPrivateKey: string | null; nearAddress?: string | null; nearPrivateKey?: string | null } = { evmAddress: null, evmPrivateKey: null, solanaAddress: null, solanaPrivateKey: null };
    if (network === 'near') {
      const accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim().toLowerCase() : undefined;
      const pair = importNearKey(body.privateKey, accountId);
      if (accountId && !/^[0-9a-f]{64}$/.test(accountId) && !await verifyFullAccessKey(accountId, pair.publicKey, nearRpcOptions(env))) {
        throw new Error(`That key is not a full-access key of ${accountId}.`);
      }
      if (accountId && /^[0-9a-f]{64}$/.test(accountId) && importNearKey(body.privateKey).accountId !== accountId) {
        throw new Error('That key does not control the implicit account you entered.');
      }
      blank.nearAddress = pair.accountId;
      blank.nearPrivateKey = pair.privateKey;
      const wallet = await storeWalletAccount(String(checked.auth.user.id), blank, body.label || 'NEAR imported', 'imported', env);
      return Response.json({ wallet: publicWallet(wallet) }, { headers: corsHeaders });
    }
    const imported = network === 'evm' ? importEvmKey(body.privateKey) : network === 'solana' ? importSolanaKey(body.privateKey) : null;
    if (!imported) throw new Error('Choose EVM, Solana, or NEAR.');
    if (network === 'evm') { blank.evmAddress = imported.address; blank.evmPrivateKey = imported.privateKey; }
    else { blank.solanaAddress = imported.address; blank.solanaPrivateKey = imported.privateKey; }
    const wallet = await storeWalletAccount(String(checked.auth.user.id), blank, body.label || `${network!.toUpperCase()} imported`, 'imported', env);
    return Response.json({ wallet: publicWallet(wallet) }, { headers: corsHeaders });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Private key could not be imported.' }, { status: 400, headers: corsHeaders }); }
}

async function handleTelegramWalletActive(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checked = await walletAuth(request, env, corsHeaders); if (checked instanceof Response) return checked;
  const walletId = typeof checked.auth.body.walletId === 'string' ? checked.auth.body.walletId : '';
  if (!walletId) return Response.json({ error: 'walletId is required.' }, { status: 400, headers: corsHeaders });
  await env.DB!.prepare(`UPDATE wallet_accounts SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END WHERE user_id = ?2`).bind(walletId, String(checked.auth.user.id)).run();
  return Response.json({ ok: true }, { headers: corsHeaders });
}

async function handleTelegramWalletRename(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checked = await walletAuth(request, env, corsHeaders); if (checked instanceof Response) return checked;
  const walletId = typeof checked.auth.body.walletId === 'string' ? checked.auth.body.walletId : '';
  const label = typeof checked.auth.body.label === 'string' ? checked.auth.body.label.trim().slice(0, 80) : '';
  if (!walletId || !label) return Response.json({ error: 'A wallet and non-empty label are required.' }, { status: 400, headers: corsHeaders });
  const result = await env.DB!.prepare(`UPDATE wallet_accounts SET label = ?1 WHERE id = ?2 AND user_id = ?3`).bind(label, walletId, String(checked.auth.user.id)).run();
  return Response.json({ renamed: (result.meta?.changes ?? 0) > 0, label }, { headers: corsHeaders });
}

async function handleTelegramWalletReveal(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checked = await walletAuth(request, env, corsHeaders); if (checked instanceof Response) return checked;
  const body = checked.auth.body as { walletId?: string; confirmation?: string; acknowledgeSecurity?: boolean; acknowledgeClipboard?: boolean; acknowledgeIrreversible?: boolean };
  if (body.confirmation !== 'REVEAL PRIVATE KEYS' || !body.acknowledgeSecurity || !body.acknowledgeClipboard || !body.acknowledgeIrreversible) return Response.json({ error: 'All security acknowledgements and the exact confirmation phrase are required.' }, { status: 400, headers: corsHeaders });
  const row = await env.DB!.prepare(`SELECT * FROM wallet_accounts WHERE id = ?1 AND user_id = ?2`).bind(body.walletId ?? '', String(checked.auth.user.id)).first<WalletAccountRow>();
  if (!row) return Response.json({ error: 'Wallet not found.' }, { status: 404, headers: corsHeaders });
  const evmPrivateKey = row.evm_encrypted_key ? await decryptPrivateKey(unpackEncryptedSecret(row.evm_encrypted_key), env.ENCRYPTION_KEY!) : '';
  const solanaPrivateKey = row.solana_encrypted_key ? await decryptPrivateKey(unpackEncryptedSecret(row.solana_encrypted_key), env.ENCRYPTION_KEY!) : '';
  const nearPrivateKey = row.near_encrypted_key ? await decryptPrivateKey(unpackEncryptedSecret(row.near_encrypted_key), env.ENCRYPTION_KEY!) : '';
  return new Response(JSON.stringify({ warning: 'Never share these keys. Anyone with them can permanently control the wallet.', evmPrivateKey, solanaPrivateKey, nearPrivateKey }), { headers: { ...corsHeaders, 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', 'Content-Type': 'application/json' } });
}

async function handleTelegramWalletDelete(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const checked = await walletAuth(request, env, corsHeaders); if (checked instanceof Response) return checked;
  const body = checked.auth.body as { walletId?: string; confirmation?: string; backupConfirmed?: boolean; acknowledgeIrreversible?: boolean };
  if (body.confirmation !== 'DELETE WALLET' || !body.backupConfirmed || !body.acknowledgeIrreversible) return Response.json({ error: 'Confirm the backup and irreversible deletion warnings first.' }, { status: 400, headers: corsHeaders });
  const deletedWallet = await env.DB!.prepare(`SELECT is_active, evm_address, solana_address FROM wallet_accounts WHERE id = ?1 AND user_id = ?2`).bind(body.walletId ?? '', String(checked.auth.user.id)).first<{ is_active: number; evm_address: string | null; solana_address: string | null }>();
  const result = await env.DB!.prepare(`DELETE FROM wallet_accounts WHERE id = ?1 AND user_id = ?2`).bind(body.walletId ?? '', String(checked.auth.user.id)).run();
  if (deletedWallet?.evm_address || deletedWallet?.solana_address) {
    await env.DB!.prepare(`DELETE FROM user_wallets WHERE user_id = ?1 AND (evm_address = ?2 OR solana_address = ?3)`).bind(String(checked.auth.user.id), deletedWallet.evm_address ?? '', deletedWallet.solana_address ?? '').run();
  }
  if (deletedWallet?.is_active) {
    await env.DB!.prepare(`UPDATE wallet_accounts SET is_active = 1 WHERE id = (SELECT id FROM wallet_accounts WHERE user_id = ?1 ORDER BY created_at ASC LIMIT 1)`).bind(String(checked.auth.user.id)).run();
  }
  return Response.json({ deleted: (result.meta?.changes ?? 0) > 0 }, { headers: corsHeaders });
}

interface DexScreenerApiPair {
  chainId: string;
  dexId?: string;
  pairAddress?: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
}

/** Trader-facing activity fields shared by every DexScreener-backed detection result. */
function dexActivity(pair: { priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number }; txns?: { h24?: { buys?: number; sells?: number } }; pairCreatedAt?: number }) {
  return {
    priceChanges: pair.priceChange ?? {},
    txns24h: pair.txns?.h24,
    pairCreatedAt: pair.pairCreatedAt,
  };
}

/** Market data goes stale fast: keep detections briefly (KV's minimum TTL is 60s). */
const DETECTION_MEMORY_TTL_MS = 20_000;
const DETECTION_KV_TTL_SECONDS = 60;
/** Upstream market APIs get this long before a scan moves on without them. */
const MARKET_FETCH_TIMEOUT_MS = 4_000;

function fetchMarket(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(MARKET_FETCH_TIMEOUT_MS) });
}

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

  // Detect chain
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(address);
  const nearId = !isBase58 && !isEvm && isNearAccountId(address.toLowerCase()) ? address.toLowerCase() : null;

  let result;

  if (nearId) {
    result = await detectNearToken(nearId, env);
  } else if (isBase58) {
    // Solana token detection via DexScreener
    const response = await fetchMarket(`https://api.dexscreener.com/latest/dex/tokens/${address}`).catch(() => null);
    const data = (await response?.json().catch(() => null) ?? {}) as { pairs?: DexScreenerApiPair[] };
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs.find((item: { baseToken?: { address?: string }; quoteToken?: { address?: string } }) => item.baseToken?.address === address || item.quoteToken?.address === address) ?? data.pairs[0];
      result = {
        address,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        decimals: 9,
        chainId: 1151111081099710,
        chainType: 'SVM',
        chainName: 'Solana',
        chainColor: '#9945FF',
        priceUsd: parseFloat(pair.priceUsd ?? '') || 0,
        liquidity: pair.liquidity?.usd || 0,
        fdv: pair.fdv || 0,
        change24h: pair.priceChange?.h24 || 0,
        volume24h: pair.volume?.h24 || 0,
        dexId: pair.dexId,
        ...dexActivity(pair),
      };
    }
  } else if (isEvm) {
    // EVM token detection via DexScreener
    const response = await fetchMarket(`https://api.dexscreener.com/latest/dex/tokens/${address}`).catch(() => null);
    const data = (await response?.json().catch(() => null) ?? {}) as { pairs?: DexScreenerApiPair[] };
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs.find((item: { chainId?: string; baseToken?: { address?: string }; quoteToken?: { address?: string } }) => item.chainId === 'robinhood' && (item.baseToken?.address?.toLowerCase() === address.toLowerCase() || item.quoteToken?.address?.toLowerCase() === address.toLowerCase()))
        ?? data.pairs.find((item: { chainId?: string }) => item.chainId === 'robinhood')
        ?? data.pairs[0];
      const chainMap: Record<string, { id: number; name: string; color: string }> = {
        'arbitrum': { id: 42161, name: 'Arbitrum One', color: '#28A0F0' },
        'base': { id: 8453, name: 'Base', color: '#0052FF' },
        'bsc': { id: 56, name: 'BNB Chain', color: '#F0B90B' },
        'robinhood': { id: 4663, name: 'Robinhood Chain', color: '#00C853' },
        'arc': { id: 5042, name: 'Arc Chain', color: '#FF6D00' },
      };
      
      const chainInfo = chainMap[pair.chainId] || { id: 0, name: pair.chainId, color: '#666' };
      
      const scannedIsQuote = pair.quoteToken?.address?.toLowerCase() === address.toLowerCase() && pair.baseToken?.address?.toLowerCase() !== address.toLowerCase();
      const token = scannedIsQuote && pair.quoteToken ? pair.quoteToken : pair.baseToken;
      const paired = scannedIsQuote ? pair.baseToken : pair.quoteToken;
      result = {
        address,
        name: token.name,
        symbol: token.symbol,
        decimals: 18,
        chainId: chainInfo.id,
        chainType: 'EVM',
        chainName: chainInfo.name,
        chainColor: chainInfo.color,
        priceUsd: parseFloat(pair.priceUsd ?? '') || 0,
        liquidity: pair.liquidity?.usd || 0,
        fdv: pair.fdv || 0,
        change24h: pair.priceChange?.h24 || 0,
        volume24h: pair.volume?.h24 || 0,
        pairedAsset: paired ? { address: paired.address, name: paired.name, symbol: paired.symbol } : chainInfo.id === 4663 ? { symbol: 'WETH', name: 'Wrapped Ether' } : undefined,
        dexId: pair.dexId,
        ...dexActivity(pair),
      };
    }
  }

  if (!result && !nearId) {
    const launchpadNetworks = isBase58
      ? [{ slug: 'solana', id: 1151111081099710, name: 'Solana', type: 'SVM', color: '#9945FF' }]
      : [
        { slug: 'arbitrum', id: 42161, name: 'Arbitrum One', type: 'EVM', color: '#28A0F0' },
        { slug: 'base', id: 8453, name: 'Base', type: 'EVM', color: '#0052FF' },
        { slug: 'bsc', id: 56, name: 'BNB Chain', type: 'EVM', color: '#F0B90B' },
        { slug: 'robinhood', id: 4663, name: 'Robinhood Chain', type: 'EVM', color: '#00C853' },
        { slug: 'arc', id: 5042, name: 'Arc Chain', type: 'EVM', color: '#FF6D00' },
      ];
    const launchpadPools = await Promise.all(launchpadNetworks.map(async (network) => ({ network, pool: await fetchGeckoLaunchpadPool(address, network.slug) })));
    const hit = launchpadPools.find((item) => item.pool);
    if (hit?.pool) {
      result = {
        address,
        name: hit.pool.name,
        symbol: hit.pool.symbol,
        decimals: hit.network.type === 'SVM' ? 9 : 18,
        chainId: hit.network.id,
        chainType: hit.network.type,
        chainName: hit.network.name,
        chainColor: hit.network.color,
        priceUsd: hit.pool.priceUsd,
        liquidity: hit.pool.liquidity,
        fdv: hit.pool.fdv,
        change24h: 0,
        volume24h: hit.pool.volume24h,
        pairAddress: hit.pool.pairAddress,
        liquiditySource: hit.pool.source,
        launchpad: hit.pool.launchpad,
        pairedAsset: hit.pool.pairedAsset,
        dexId: hit.pool.source,
      };
    }
  }

  if (!result) {
    return Response.json({ error: 'Token not found' }, { status: 404, headers: corsHeaders });
  }

  // Short-lived cache: repeat scans are instant while prices stay live. Do not add KV write latency to the response.
  telegramDetectionMemoryCache.set(cacheKey, { value: result, expiresAt: Date.now() + DETECTION_MEMORY_TTL_MS });
  if (env.CACHE) {
    void env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: DETECTION_KV_TTL_SECONDS }).catch((error: unknown) => {
      console.error('Token detection cache write failed', error);
    });
  }

  return Response.json(result, { headers: { ...corsHeaders, 'X-Cache': 'MISS' } });
}

/**
 * NEP-141 token lookup: DexScreener market data (chain slug `near`) with
 * on-chain ft_metadata for decimals. A contract with metadata but no indexed
 * pool is still reported, with zeroed market stats.
 */
async function detectNearToken(tokenId: string, env: Env): Promise<Record<string, unknown> | undefined> {
  type Pair = { chainId?: string; dexId?: string; pairAddress?: string; baseToken?: { address?: string; name?: string; symbol?: string }; quoteToken?: { address?: string; name?: string; symbol?: string }; priceUsd?: string; liquidity?: { usd?: number }; fdv?: number; priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number }; volume?: { h24?: number }; txns?: { h24?: { buys?: number; sells?: number } }; pairCreatedAt?: number };
  const [pairs, metadata] = await Promise.all([
    fetchMarket(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenId)}`)
      .then(async (response) => response.ok ? ((await response.json()) as { pairs?: Pair[] }).pairs ?? [] : [])
      .catch(() => [] as Pair[]),
    getTokenMetadata(tokenId, nearRpcOptions(env)).catch(() => null),
  ]);
  const nearPairs = pairs
    .filter((pair) => pair.chainId === 'near' && (pair.baseToken?.address === tokenId || pair.quoteToken?.address === tokenId))
    .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0));
  const pair = nearPairs[0];
  if (!pair && !metadata) return undefined;

  const scannedIsQuote = pair?.quoteToken?.address === tokenId && pair.baseToken?.address !== tokenId;
  const token = scannedIsQuote ? pair?.quoteToken : pair?.baseToken;
  const paired = scannedIsQuote ? pair?.baseToken : pair?.quoteToken;
  // DexScreener prices the pair's base token; invert for a quote-side scan only when it is priced in USD terms we can trust.
  const priceUsd = pair && !scannedIsQuote ? Number(pair.priceUsd) || 0 : 0;
  return {
    address: tokenId,
    name: token?.name ?? metadata?.name ?? tokenId,
    symbol: token?.symbol ?? metadata?.symbol ?? 'UNKNOWN',
    decimals: metadata?.decimals ?? 18,
    chainId: NEAR_CHAIN_ID,
    chainType: 'NEAR',
    chainName: NEAR_CHAIN.name,
    chainColor: NEAR_CHAIN.color,
    priceUsd,
    liquidity: pair?.liquidity?.usd ?? 0,
    fdv: pair?.fdv ?? 0,
    change24h: pair && !scannedIsQuote ? pair.priceChange?.h24 ?? 0 : 0,
    volume24h: pair?.volume?.h24 ?? 0,
    pairAddress: pair?.pairAddress,
    pairedAsset: paired?.symbol ? { address: paired.address, name: paired.name, symbol: paired.symbol } : undefined,
    dexId: pair?.dexId ?? 'unindexed',
    freshDeployment: !pair,
    ...(pair && !scannedIsQuote ? dexActivity(pair) : pair ? { txns24h: pair.txns?.h24, pairCreatedAt: pair.pairCreatedAt } : {}),
  };
}

async function fetchGeckoLaunchpadPool(address: string, network: string): Promise<{ name: string; symbol: string; source: string; launchpad?: string; priceUsd: number; liquidity: number; volume24h: number; fdv: number; pairAddress: string; pairedAsset?: { symbol: string } } | null> {
  try {
    const response = await fetchMarket(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`);
    if (!response.ok) return null;
    const payload = await response.json() as { data?: Array<{ id?: string; attributes?: Record<string, unknown>; relationships?: { dex?: { data?: { id?: string } }; base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } }> };
    const pool = payload.data?.find((item) => Number(item.attributes?.reserve_in_usd ?? 0) > 0) ?? payload.data?.[0];
    if (!pool?.attributes || Number(pool.attributes.reserve_in_usd ?? 0) <= 0) return null;
    const attrs = pool.attributes;
    const source = String(pool.relationships?.dex?.data?.id?.split('_').pop() ?? 'GeckoTerminal').replace(/[_-]+/g, ' ');
    const launchpad = detectLaunchpad(source);
    const volume = attrs.volume_usd as { h24?: number } | undefined;
    const pairSymbols = String(attrs.name ?? 'Launchpad token').split(' / ').map((part) => part.replace(/\s+\d+(?:\.\d+)?%$/, '').trim());
    const baseId = pool.relationships?.base_token?.data?.id?.split('_').pop()?.toLowerCase();
    const quoteId = pool.relationships?.quote_token?.data?.id?.split('_').pop()?.toLowerCase();
    const scannedIsQuote = quoteId === address.toLowerCase() && baseId !== address.toLowerCase();
    const tokenName = scannedIsQuote ? pairSymbols[1] : pairSymbols[0];
    const tokenSymbol = scannedIsQuote ? pairSymbols[1] : String(attrs.base_token_symbol ?? pairSymbols[0] ?? 'UNKNOWN');
    return {
      name: tokenName || 'Token',
      symbol: tokenSymbol || 'UNKNOWN',
      source,
      launchpad,
      priceUsd: Number((scannedIsQuote ? attrs.quote_token_price_usd : attrs.base_token_price_usd) ?? attrs.token_price_usd ?? 0),
      liquidity: Number(attrs.reserve_in_usd ?? 0),
      volume24h: Number(volume?.h24 ?? 0),
      fdv: Number(attrs.fdv_usd ?? attrs.market_cap_usd ?? 0),
      pairAddress: pool.id?.split('_').pop() ?? '',
      pairedAsset: pairSymbols[scannedIsQuote ? 0 : 1] ? { symbol: pairSymbols[scannedIsQuote ? 0 : 1] } : undefined,
    };
  } catch {
    return null;
  }
}

interface NearQuoteRequest {
  chain: 'near';
  tokenIn?: string;
  tokenOut?: string;
  amount?: string; // human units of tokenIn
  slippage?: number; // percent
  initData?: string;
}

/**
 * NEAR quote. Without initData it is read-only (no wallet needed). With valid
 * Telegram Mini App initData it prepares a custodial swap for that user and
 * returns a tradeId for /api/trade/execute — the same two-step flow as the bot.
 */
async function handleNearTradeQuote(body: NearQuoteRequest, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const tokenIn = body.tokenIn ? resolveNearToken(body.tokenIn) : null;
  const tokenOut = body.tokenOut ? resolveNearToken(body.tokenOut) : null;
  if (!tokenIn || !tokenOut || tokenIn === tokenOut || !body.amount || !/^\d+(\.\d+)?$/.test(body.amount)) {
    return Response.json({ error: 'tokenIn, tokenOut (near, usdc, usdt or a NEP-141 contract) and a positive amount are required.' }, { status: 400, headers: corsHeaders });
  }
  const slippage = Math.min(0.5, Math.max(0.0005, Number(body.slippage || 1) / 100));
  const rpc = nearRpcOptions(env);
  try {
    const [inMeta, outMeta] = await Promise.all([getTokenMetadata(tokenIn, rpc), getTokenMetadata(tokenOut, rpc)]);
    const amountIn = parseUnits(body.amount, inMeta.decimals).toString();
    const tokens = {
      tokenIn: { id: tokenIn, symbol: inMeta.symbol, decimals: inMeta.decimals },
      tokenOut: { id: tokenOut, symbol: outMeta.symbol, decimals: outMeta.decimals },
    };

    if (typeof body.initData === 'string' && body.initData) {
      if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ error: 'Telegram is not configured.' }, { status: 503, headers: corsHeaders });
      const user = body.initData.length <= 4096 ? await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN) : null;
      if (!user) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
      const trade = await prepareNearSwap({ userId: String(user.id), kind: tokenOut === NATIVE_NEAR ? 'sell' : 'buy', ...tokens, amountInUnits: amountIn, slippage }, env);
      const swap = trade.nearSwap!;
      return Response.json({
        tradeId: trade.id,
        expiresInSeconds: 90,
        execution: 'custodial_confirmation',
        // The user pays the full amount; Hopr's fee (if any) comes out of it before the swap.
        ...nearQuotePayload({ ...swap.quote, amountIn: (BigInt(swap.quote.amountIn) + BigInt(swap.fee?.amount ?? '0')).toString() }, tokens.tokenIn, tokens.tokenOut),
        hoprFeeFormatted: swap.fee ? formatUnits(swap.fee.amount, tokens.tokenIn.decimals, 6) : null,
        storageDepositYocto: (BigInt(swap.outputStorageDeposit) + BigInt(swap.wrapStorageDeposit) + BigInt(swap.fee?.storageDeposit ?? '0')).toString(),
      }, { headers: corsHeaders });
    }

    const quote = await getRefSwapQuote({ tokenIn, tokenOut, amountIn, slippage });
    return Response.json({ execution: 'read_only', ...nearQuotePayload(quote, tokens.tokenIn, tokens.tokenOut) }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'NEAR quote unavailable', code: 'NEAR_QUOTE_UNAVAILABLE' }, { status: 502, headers: corsHeaders });
  }
}

function nearQuotePayload(quote: { amountIn: string; expectedOut: string; minOut: string; hops: number; slippage: number }, tokenIn: { id: string; symbol: string; decimals: number }, tokenOut: { id: string; symbol: string; decimals: number }) {
  return {
    venue: 'ref-finance',
    chainId: NEAR_CHAIN_ID,
    tokenIn,
    tokenOut,
    amountIn: quote.amountIn,
    expectedOut: quote.expectedOut,
    minOut: quote.minOut,
    amountInFormatted: formatUnits(quote.amountIn, tokenIn.decimals, 6),
    expectedOutFormatted: formatUnits(quote.expectedOut, tokenOut.decimals, 6),
    minOutFormatted: formatUnits(quote.minOut, tokenOut.decimals, 6),
    hops: quote.hops,
    slippagePercent: quote.slippage * 100,
  };
}

const LIFI_PROXY_PARAMS = ['fromChain', 'toChain', 'fromToken', 'toToken', 'fromAmount', 'fromAddress', 'toAddress', 'slippage'];

/**
 * Forward a dashboard quote to LI.FI with the server-side API key. Only known
 * parameters pass through; the integrator and platform fee are set here, so
 * a client cannot change them (0.5% swaps, 1% bridges).
 */
async function handleLifiQuoteProxy(url: URL, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const params = new URLSearchParams();
  for (const key of LIFI_PROXY_PARAMS) {
    const value = url.searchParams.get(key);
    if (!value || value.length > 128) return Response.json({ message: `Missing or invalid ${key}` }, { status: 400, headers: corsHeaders });
    params.set(key, value);
  }
  params.set('integrator', env.LIFI_INTEGRATOR ?? 'hopr');
  // 'hop' = a later step of a multi-step plan whose first step already paid Hopr's fee.
  const type = url.searchParams.get('type');
  params.set('fee', type === 'bridge' ? '0.01' : type === 'hop' ? '0' : '0.005');
  try {
    const response = await fetch(`https://li.quest/v1/quote?${params}`, {
      headers: { Accept: 'application/json', ...(env.LIFI_API_KEY ? { 'x-lifi-api-key': env.LIFI_API_KEY } : {}) },
    });
    return new Response(await response.text(), { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: 'LI.FI could not be reached.' }, { status: 502, headers: corsHeaders });
  }
}

/** Confirm a pending custodial quote created by the Mini App (or the bot) for this Telegram user. */
async function handleTradeExecute(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const auth = await getTelegramRequestUser(request, env);
  if (!auth) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
  const tradeId = typeof auth.body.tradeId === 'string' && /^[0-9a-f-]{36}$/.test(auth.body.tradeId) ? auth.body.tradeId : '';
  if (!tradeId) return Response.json({ error: 'tradeId is required.' }, { status: 400, headers: corsHeaders });
  try {
    const result = await confirmTrade(String(auth.user.id), tradeId, {
      evm: (chainId: number) => getChainById(chainId)?.rpcUrl ?? '',
      solana: SUPPORTED_CHAINS.find((chain) => chain.key === 'sol')!.rpcUrl,
    }, env);
    await recordTelegramReferral(String(auth.user.id), result, env);
    // The transaction lives on the chain that paid (NEAR for Ref swaps and NEAR-funded intents).
    const explorer = TELEGRAM_EXPLORERS[result.venue === 'ref' ? NEAR_CHAIN_ID : result.fromChainId ?? NEAR_CHAIN_ID];
    return Response.json({
      txHash: result.txHash,
      confirmed: result.confirmed ?? true,
      venue: result.venue,
      continuationId: result.continuationId,
      explorerUrl: explorer ? `${explorer}${result.txHash}` : undefined,
    }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Trade failed', code: 'TRADE_FAILED' }, { status: 400, headers: corsHeaders });
  }
}

async function handleWalletBalances(address: string, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let account: string;
  try { account = decodeURIComponent(address); } catch { return Response.json({ error: 'Invalid address' }, { status: 400, headers: corsHeaders }); }
  const evm = /^0x[a-fA-F0-9]{40}$/.test(account);
  const near = !evm && isNearAccountId(account);
  const sol = !evm && !near && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account);
  if (!evm && !near && !sol) return Response.json({ error: 'Invalid wallet address' }, { status: 400, headers: corsHeaders });
  const ids = near ? [NEAR_CHAIN_ID] : sol ? [1151111081099710] : [42161, 8453, 56, 4663, 5042];
  let nearDetail: NearBalance | undefined;
  const balances = await Promise.all(ids.map(async (chainId) => {
    const reading = await tracked(env, `${chainId}:${evm ? account.toLowerCase() : account}`, async () => {
      if (near) {
        nearDetail = await getNearBalance(account, [], nearRpcOptions(env));
        return BigInt(nearDetail.availableYocto);
      }
      return readNativeBalance(chainId, account);
    });
    const decimals = near ? 24 : sol ? 9 : 18;
    const units = reading?.value;
    const base = 10n ** BigInt(decimals);
    const fraction = units === undefined ? '' : (units % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return { chainId, balance: units === undefined ? null : `${units / base}${fraction ? '.' + fraction : ''}`,
      balanceUnits: units?.toString() ?? null, ...(near ? { balanceYocto: units?.toString() ?? null } : {}),
      status: !reading ? 'pending' : reading.cachedAt ? 'stale' : 'live',
      observedAt: reading ? reading.cachedAt ?? Date.now() : null,
      error: reading ? null : 'Balance sync pending; retry shortly.' };
  }));
  return Response.json({ address: account, balances, ...(near ? {
    exists: nearDetail?.exists ?? null, tokensStatus: nearDetail ? 'live' : 'pending',
    tokens: nearDetail?.tokens.map((token) => ({ ...token, formatted: formatUnits(token.balance, token.decimals, 6) })),
  } : {}) }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
}

async function handleTradeBuy(
  _body: TradeRequest,
  _env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  return Response.json({
    error: 'Trade execution is not implemented.',
    code: 'TRADE_EXECUTION_UNAVAILABLE',
  }, { status: 501, headers: corsHeaders });
}

async function handleTradeQuote(
  body: TradeRequest & { toChainId?: number; toToken?: string },
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!body.fromAddress || !body.tokenAddress || !body.toChainId || !body.amount) {
    return Response.json({ error: 'fromAddress, tokenAddress, amount, and toChainId are required.' }, { status: 400, headers: corsHeaders });
  }
  const quote = await requestLifiQuote({
    fromChain: Number(body.fundingChain) || 8453,
    fromToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    fromAmount: decimalToUnits(body.amount, 18),
    fromAddress: body.fromAddress,
    toChain: body.toChainId,
    toToken: body.toToken ?? body.tokenAddress,
    slippage: Math.min(0.5, Math.max(0.0005, Number(body.slippage || 1) / 100)),
    integrator: env.LIFI_INTEGRATOR ?? 'hopr',
    fee: 0.005,
  }, env);
  if (!quote.ok) return Response.json({ error: quote.message, code: 'LIFI_QUOTE_UNAVAILABLE' }, { status: 502, headers: corsHeaders });
  return Response.json({ quote: quote.data, readOnly: false, execution: 'wallet_confirmation', platformFeePercent: 0.5 }, { headers: corsHeaders });
}

async function handleTradeSell(
  _body: TradeRequest & { percentage: number },
  _env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  return Response.json({
    error: 'Trade execution is not implemented.',
    code: 'TRADE_EXECUTION_UNAVAILABLE',
  }, { status: 501, headers: corsHeaders });
}

async function handleTradeStatus(
  _tradeId: string,
  _env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  return Response.json({
    error: 'Trade status is unavailable because trade execution is not implemented.',
    code: 'TRADE_EXECUTION_UNAVAILABLE',
  }, { status: 501, headers: corsHeaders });
}

// ---------------------------------------------------------------------------
// Referrals in Telegram (bot + Mini App share the tg:<user id> identity)
// ---------------------------------------------------------------------------

const TELEGRAM_BUY_X_PROMPT = '✏️ Buy X — reply with how much';

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

function publicAppOrigin(env: Env): string | null {
  const url = env.PUBLIC_APP_URL || env.TELEGRAM_MINI_APP_URL;
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

const formatRewardUsd = (value: number | undefined) => `$${(value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Verified Mini App user for the referral API: payouts go to their Hopr EVM wallet. */
async function resolveTelegramReferralUser(initData: string, env: Env): Promise<{ userId: string; payoutWallet?: string; startParam?: string } | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const user = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!user) return null;
  const wallet = await getCustodialWallet(String(user.id), env).catch(() => null);
  const startParam = new URLSearchParams(initData).get('start_param') ?? undefined;
  return { userId: String(user.id), payoutWallet: wallet?.evmAddress, startParam };
}

/** Credit a custodial (bot / Mini App) trade to the Telegram user's referrer. */
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
    await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('🎁', 'Refer & Earn'), 'Referrals are not configured on this bot yet.'), env, telegramActionKeyboard(env));
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
    const origin = publicAppOrigin(env);
    const webLink = origin ? `${origin}/?ref=${code}` : null;
    const claimable = stats.claimableUsd ?? 0;
    const canClaim = Boolean(wallet) && claimable >= stats.minPayoutUsd;
    const text = tgMessage(
      tgTitle('🎁', 'Refer &amp; Earn', `Earn ${REFERRAL_SHARE * 100}% of HOPR fee revenue after the routing provider's share — in the bot, the Mini App or on the web.`),
      notice ? `<b>${notice}</b>` : null,
      tgSection('🔗', 'Your invite', [
        ...(telegramLink ? [`Telegram  ${telegramLink}`] : []),
        ...(webLink ? [`Web  ${webLink}`] : []),
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
        wallet ? `USDC to your Hopr wallet <code>${escapeTelegramHtml(wallet.evmAddress)}</code>` : 'Create a Hopr wallet (💳 Wallets) to receive payouts',
        'Platform fees: 0.5% trades · 1% bridges',
      ]),
      tgFootnote('Rewards count once the route provider confirms the trade. Same code in the bot and the Mini App.'),
    );
    const share = telegramLink ?? webLink;
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
    ), env, telegramActionKeyboard(env));
  }
}

async function claimTelegramReferral(chatId: number, env: Env, panelId?: number): Promise<void> {
  if (!env.DB) return showTelegramReferral(chatId, env, panelId);
  const wallet = await getCustodialWallet(String(chatId), env).catch(() => null);
  if (!wallet) return showTelegramReferral(chatId, env, panelId, 'Create a Hopr wallet first — payouts are sent to it.');
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
    await sendTelegramMessage(chatId, tgMessage(tgTitle('💳', 'Wallet not found'), 'Open 💳 Wallets to check your Hopr wallet.'), env, telegramActionKeyboard(env));
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
      await sendTelegramPanel(chatId, panelId, tgMessage(tgTitle('⚠️', 'Next step unavailable'), escapeTelegramHtml(step.detail)), env, telegramActionKeyboard(env));
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
    await sendTelegramMessage(chatId, tgMessage(tgTitle('⚠️', 'Step 2 failed'), escapeTelegramHtml(error instanceof Error ? error.message : 'unknown error')), env, telegramActionKeyboard(env));
  }
}

// ---------------------------------------------------------------------------
// Dashboard proxies and Mini App custodial trading
// ---------------------------------------------------------------------------

const INTENTS_PROXY_FIELDS = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];

/** Forward a dashboard 1Click quote with Hopr's app fee (0 / 0.5% / 1%) and the 1Click key added here. */
async function handleIntentsQuoteProxy(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ message: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }
  const feeBps = Number(body.feeBps);
  if (![0, 50, 100].includes(feeBps)) return Response.json({ message: 'feeBps must be 0, 50 or 100' }, { status: 400, headers: corsHeaders });
  const forwarded = Object.fromEntries(INTENTS_PROXY_FIELDS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
  if (forwarded.swapType !== 'EXACT_INPUT') return Response.json({ message: 'Only EXACT_INPUT quotes are supported' }, { status: 400, headers: corsHeaders });
  try {
    const { status, data } = await requestIntentsQuote(forwarded, feeBps, env);
    return Response.json(data, { status, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: 'NEAR Intents could not be reached.' }, { status: 502, headers: corsHeaders });
  }
}

interface MiniAppTradeSummary {
  tradeId: string;
  side: 'buy' | 'sell';
  pay: string;
  receive: string;
  minimum?: string;
  route: string;
  steps: number;
  feeNote: string;
  expiresInSeconds: number;
}

function lifiSummary(trade: PendingTrade, pay: string, receiveSymbol: string, decimals: number, route: string, feeNote: string): MiniAppTradeSummary {
  return {
    tradeId: trade.id,
    side: trade.kind,
    pay,
    receive: `≈ ${formatUnits(trade.quote.estimate.toAmount, decimals, 6)} ${receiveSymbol}`,
    minimum: `${formatUnits(trade.quote.estimate.toAmountMin, decimals, 6)} ${receiveSymbol}`,
    route,
    steps: 1,
    feeNote,
    expiresInSeconds: 90,
  };
}

/** Mini App summary for trades that land in a NEAR token (Ref swaps, NEAR Intents in, LI.FI hub hops). */
function nearBoundSummary(trade: PendingTrade, env: Env): MiniAppTradeSummary {
  const base = { tradeId: trade.id, side: trade.kind, expiresInSeconds: 90 };
  if (trade.venue === 'ref') {
    const swap = trade.nearSwap!;
    const fee = BigInt(swap.fee?.amount ?? '0');
    return {
      ...base,
      pay: `${formatUnits(BigInt(swap.quote.amountIn) + fee, swap.tokenInDecimals, 6)} ${swap.tokenInSymbol}`,
      receive: `≈ ${formatUnits(swap.quote.expectedOut, swap.tokenOutDecimals, 6)} ${swap.tokenOutSymbol}`,
      minimum: `${formatUnits(swap.quote.minOut, swap.tokenOutDecimals, 6)} ${swap.tokenOutSymbol}`,
      route: `Ref Finance · ${swap.quote.hops} hop${swap.quote.hops === 1 ? '' : 's'}`,
      steps: 1,
      feeNote: fee > 0n ? '0.5% Hopr fee included' : trade.sourceContinuationId ? 'Hopr fee already paid in step 1' : 'No platform fee',
    };
  }
  const chainName = getChainById(trade.fundingChainId)?.name ?? 'your chain';
  const pay = `${formatUnits(trade.displayAmount, nativeDecimalsOf(trade.fundingChainId), 6)} ${trade.displaySymbol}`;
  const feeNote = trade.feeBps
    ? `0.5% platform fee · charged once${trade.venue === 'intents' && !env.ONECLICK_JWT ? ' + 0.25% 1Click routing fee' : ''}`
    : 'Hopr fee already paid in step 1';
  if (trade.hubContinuation) {
    return {
      ...base, pay, feeNote, steps: 3,
      receive: `≈ ${formatUnits(trade.quote.estimate.toAmount, 18, 6)} ETH on Base → ${trade.hubContinuation.targetSymbol}`,
      route: `${chainName} → Base · LI.FI, then NEAR Intents + Ref Finance`,
    };
  }
  const intents = trade.intents!;
  const out = `${formatUnits(intents.expectedOut, intents.outDecimals, 6)} ${intents.outSymbol}`;
  return {
    ...base, pay, feeNote,
    receive: intents.continuation ? `≈ ${out} → ${intents.continuation.targetSymbol}` : `≈ ${out}`,
    route: intents.continuation ? `${chainName} → NEAR · NEAR Intents, then Ref Finance` : `${chainName} → NEAR · NEAR Intents`,
    steps: intents.continuation ? 2 : 1,
  };
}

/** Mini App quote for a NEAR (NEP-141) token, paid from NEAR or any other supported chain. */
async function prepareMiniAppNearTrade(userId: string, wallet: NonNullable<Awaited<ReturnType<typeof getCustodialWallet>>>, body: { side?: string; tokenAddress?: string; fundingChainId?: number; amount?: string; percent?: number }, slippage: number, env: Env): Promise<MiniAppTradeSummary> {
  const tokenId = typeof body.tokenAddress === 'string' ? body.tokenAddress.trim().toLowerCase() : '';
  if (!isNearAccountId(tokenId)) throw new Error('Unsupported NEAR token.');
  const rpc = nearRpcOptions(env);
  if (body.side === 'buy') {
    const amount = String(body.amount ?? '');
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(amount) || !(Number(amount) > 0)) throw new Error('Enter a valid amount.');
    const fundingChainId = Number(body.fundingChainId) || NEAR_CHAIN_ID;
    if (fundingChainId !== NEAR_CHAIN_ID) {
      const funding = getChainById(fundingChainId);
      if (!funding) throw new Error('Unsupported funding chain.');
      const trade = await prepareIncomingNearBuy({
        userId, wallet, fundingChainId, amountUnits: decimalToUnits(amount, funding.type === 'SVM' ? 9 : 18), tokenAddress: tokenId, slippage,
      }, env);
      return nearBoundSummary(trade, env);
    }
    const metadata = await getTokenMetadata(tokenId, rpc);
    const trade = await prepareNearSwap({
      userId, kind: 'buy', tokenIn: NEAR_TOKEN, tokenOut: { id: tokenId, symbol: metadata.symbol, decimals: metadata.decimals },
      amountInUnits: parseUnits(amount, NEAR_DECIMALS).toString(), slippage,
    }, env);
    return nearBoundSummary(trade, env);
  }
  if (body.side === 'sell') {
    const percent = Number(body.percent);
    if (![25, 50, 100].includes(percent)) throw new Error('Sell 25%, 50% or 100%.');
    const accountId = await ensureNearWallet(userId, env);
    const [metadata, held] = await Promise.all([
      getTokenMetadata(tokenId, rpc),
      viewFunction<string>(tokenId, 'ft_balance_of', { account_id: accountId }, rpc).catch(() => '0'),
    ]);
    const amount = (BigInt(held) * BigInt(percent)) / 100n;
    if (amount === 0n) throw new Error(`Your NEAR wallet holds no ${metadata.symbol}.`);
    const trade = await prepareNearSwap({
      userId, kind: 'sell', tokenIn: { id: tokenId, symbol: metadata.symbol, decimals: metadata.decimals }, tokenOut: NEAR_TOKEN, amountInUnits: amount.toString(), slippage,
    }, env);
    return nearBoundSummary(trade, env);
  }
  throw new Error('side must be buy or sell.');
}

/**
 * Quote a Mini App trade with the user's Hopr (bot) wallet — the same flow
 * as the bot's buttons, confirmed later via /api/trade/execute.
 */
async function handleTelegramTradePrepare(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const auth = await getTelegramRequestUser(request, env);
  if (!auth) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
  const userId = String(auth.user.id);
  const body = auth.body as { side?: string; tokenChainId?: number; tokenAddress?: string; tokenSymbol?: string; tokenDecimals?: number; fundingChainId?: number; amount?: string; percent?: number; slippage?: number };
  try {
    if (!env.ENCRYPTION_KEY || !env.TELEGRAM_STATE) throw new Error('Trading is not configured on this bot.');
    const wallet = await getCustodialWallet(userId, env);
    if (!wallet) throw new Error('Create your Hopr wallet in the bot first.');
    const slippage = Math.min(0.2, Math.max(0.001, Number(body.slippage) || 0.01));
    if (Number(body.tokenChainId) === NEAR_CHAIN_ID) {
      return Response.json(await prepareMiniAppNearTrade(userId, wallet, body, slippage, env), { headers: corsHeaders });
    }
    const tokenChain = getChainById(Number(body.tokenChainId));
    const tokenAddress = typeof body.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
    if (!tokenChain || !tokenAddress) throw new Error('Unsupported token.');
    const symbol = (body.tokenSymbol ?? 'token').slice(0, 20);
    const tokenDecimals = Number.isInteger(body.tokenDecimals) ? Number(body.tokenDecimals) : 18;

    if (body.side === 'buy') {
      const amount = String(body.amount ?? '');
      if (!/^\d{1,12}(\.\d{1,18})?$/.test(amount) || !(Number(amount) > 0)) throw new Error('Enter a valid amount.');
      const fundingChainId = Number(body.fundingChainId) || tokenChain.id;
      if (fundingChainId === NEAR_CHAIN_ID) {
        const trade = await prepareNearIntentsBuy({ userId, wallet, amountYocto: parseUnits(amount, NEAR_DECIMALS).toString(), targetChainId: tokenChain.id, targetTokenAddress: tokenAddress, targetSymbol: symbol, slippage }, env);
        const intents = trade.intents!;
        const summary: MiniAppTradeSummary = {
          tradeId: trade.id,
          side: 'buy',
          pay: `${amount} NEAR`,
          receive: intents.continuation
            ? `≈ ${formatUnits(intents.expectedOut, intents.outDecimals, 6)} ${intents.outSymbol} → ${symbol}`
            : `≈ ${formatUnits(intents.expectedOut, intents.outDecimals, 6)} ${symbol}`,
          route: intents.continuation ? `NEAR Intents → ${getChainById(trade.toChainId)?.name ?? tokenChain.name}, then LI.FI` : 'NEAR Intents',
          steps: intents.continuation ? 2 : 1,
          feeNote: `0.5% platform fee · charged once${env.ONECLICK_JWT ? '' : ' + 0.25% 1Click routing fee'}`,
          expiresInSeconds: 90,
        };
        return Response.json(summary, { headers: corsHeaders });
      }
      const fundingChain = getChainById(fundingChainId);
      if (!fundingChain) throw new Error('Unsupported funding chain.');
      const trade = await prepareBuy({
        userId,
        wallet,
        fundingChainKey: fundingChain.key,
        fundingTokenAddress: 'native',
        fundingAmountUnits: decimalToUnits(amount, fundingChain.type === 'EVM' ? 18 : 9),
        targetChainId: tokenChain.id,
        targetTokenAddress: tokenAddress,
        slippage,
      }, env);
      await writeTelegramProfile(auth.user.id, { ...(await readTelegramProfile(auth.user.id, env).catch(() => null) ?? {}), lastTokenAddress: tokenAddress, lastTokenChainId: tokenChain.id, lastTokenSymbol: symbol }, env).catch(() => undefined);
      const route = fundingChain.id === tokenChain.id ? `${tokenChain.name} · LI.FI` : `${fundingChain.name} → ${tokenChain.name} · LI.FI`;
      return Response.json(lifiSummary(trade, `${amount} ${fundingChain.nativeSymbol}`, symbol, tokenDecimals, route, '0.5% Hopr fee included'), { headers: corsHeaders });
    }

    if (body.side === 'sell') {
      const percent = Number(body.percent);
      if (![25, 50, 100].includes(percent)) throw new Error('Sell 25%, 50% or 100%.');
      if (!env.DB) throw new Error('Positions need the DB binding.');
      const open = await env.DB.prepare(
        `SELECT id, purchased_amount, funding_chain_id FROM user_trades WHERE user_id = ?1 AND target_token_address = ?2 AND status IN ('SUBMITTED','CONFIRMED') ORDER BY created_at DESC LIMIT 1`
      ).bind(userId, tokenAddress).first<{ id: string; purchased_amount: string; funding_chain_id: string }>();
      if (!open) throw new Error(`No open ${symbol} position in your Hopr wallet.`);
      const trade = await prepareSell({ userId, wallet, originalTradeDbId: open.id, sellAmountUnits: ((BigInt(open.purchased_amount) * BigInt(percent)) / 100n).toString(), slippage }, env);
      const proceeds = getChainById(Number(open.funding_chain_id));
      return Response.json(lifiSummary(trade, `${percent}% of ${symbol}`, proceeds?.nativeSymbol ?? 'native', proceeds?.type === 'SVM' ? 9 : 18, `${tokenChain.name} → ${proceeds?.name ?? 'funding chain'} · LI.FI`, '0.5% Hopr fee included'), { headers: corsHeaders });
    }
    throw new Error('side must be buy or sell.');
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'No quote available.' }, { status: 400, headers: corsHeaders });
  }
}

/** Mini App step 2 of a NEAR-funded buy: pending while bridging, then a fresh LI.FI quote. */
async function handleTelegramTradeContinue(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const auth = await getTelegramRequestUser(request, env);
  if (!auth) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
  const userId = String(auth.user.id);
  const id = typeof auth.body.continuationId === 'string' && /^[0-9a-f]{8}$/.test(auth.body.continuationId) ? auth.body.continuationId : '';
  if (!id) return Response.json({ error: 'continuationId is required.' }, { status: 400, headers: corsHeaders });
  try {
    const wallet = await getCustodialWallet(userId, env);
    if (!wallet) throw new Error('Wallet not found.');
    const step = await continueNearFundedBuy(userId, id, wallet, nativeBalanceUnits, env);
    if (step.status !== 'ready') return Response.json(step, { headers: corsHeaders });
    if (step.trade.venue === 'ref' || step.trade.venue === 'intents') {
      return Response.json({ status: 'ready', ...nearBoundSummary(step.trade, env) }, { headers: corsHeaders });
    }
    const chain = getChainById(step.continuation.hubChainId ?? step.continuation.targetChainId)!;
    const tokenDecimals = Number(auth.body.tokenDecimals) || 18;
    return Response.json({
      status: 'ready',
      ...lifiSummary(step.trade, `${formatUnits(step.delivered, chain.type === 'SVM' ? 9 : 18, 6)} ${chain.nativeSymbol}`, step.continuation.targetSymbol, tokenDecimals, `${chain.name} · LI.FI`, 'Hopr fee already paid in step 1'),
    }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ status: 'failed', detail: error instanceof Error ? error.message : 'Step 2 failed.' }, { headers: corsHeaders });
  }
}
