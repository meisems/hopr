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
  prepareBuy,
  prepareSell,
  confirmTrade,
} from './trading';
import { getChainById, SUPPORTED_CHAINS } from '../src/services/chainDetector';
import {
  generateDualWallet,
  decryptPrivateKey,
  encryptPrivateKey,
  packEncryptedSecret,
  unpackEncryptedSecret,
  importEvmKey,
  importSolanaKey,
} from '../src/services/walletService';

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
}

interface TelegramMessage {
  chat?: { id: number; type?: string };
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

function telegramActionKeyboard(env: Env) {
  return {
    inline_keyboard: [
    [
      { text: 'Wallet', callback_data: 'wallet' },
      { text: 'Settings', callback_data: 'settings' },
    ],
    [
      { text: 'Link wallet', callback_data: 'wallet:link' },
      { text: 'Help', callback_data: 'help' },
    ],
    ...(env.TELEGRAM_MINI_APP_URL ? [[{ text: 'Open Hopr Mini App', web_app: { url: env.TELEGRAM_MINI_APP_URL } }]] : []),
  ],
  };
}

function telegramTokenKeyboard(address: string) {
  return {
    inline_keyboard: [
      [
        { text: '🟢 Buy 0.1', callback_data: 'trade:buy:0.1' },
        { text: '🟢 Buy 0.5', callback_data: 'trade:buy:0.5' },
        { text: '🟢 Buy 1.0', callback_data: 'trade:buy:1.0' },
      ],
      [{ text: '✎ Custom / X%', callback_data: 'trade:custom' }, { text: '↻ Change chain', callback_data: 'settings' }],
      [
        { text: '🔴 Sell 25%', callback_data: 'trade:sell:25' },
        { text: '🔴 Sell 50%', callback_data: 'trade:sell:50' },
        { text: '🔴 Sell 100%', callback_data: 'trade:sell:100' },
      ],
      [
        { text: '📊 Chart', url: `https://dexscreener.com/search?q=${encodeURIComponent(address)}` },
        { text: '🔄 Refresh', callback_data: `token:refresh:${address}` },
        { text: '🛡 Audit', callback_data: 'help' },
      ],
      [
        { text: '⚙ Settings', callback_data: 'settings' },
        { text: '▥ DexScreener', url: `https://dexscreener.com/search?q=${encodeURIComponent(address)}` },
        { text: '× Dismiss', callback_data: 'dismiss' },
      ],
    ],
  };
}

function telegramTradeConfirmationKeyboard(tradeId: string) {
  return {
    inline_keyboard: [[
      { text: 'Confirm and submit', callback_data: `trade:confirm:${tradeId}` },
      { text: 'Cancel', callback_data: 'trade:cancel' },
    ]],
  };
}

const TELEGRAM_WALLET_PROMPTS = {
  evm: 'Reply to this message with a public EVM address only.',
  solana: 'Reply to this message with a public Solana address only.',
};

const telegramDetectionMemoryCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const ARGUS_PORTAL_7 = '0xB021Be536808f551b31789422Fd28a6c9c6e97Da';
const ARGUS_LAUNCHES_SELECTOR = '0x1f2d8550';

const TELEGRAM_CHAINS = [
  { id: 1151111081099710, name: 'Solana', symbol: 'SOL' },
  { id: 42161, name: 'Arbitrum One', symbol: 'ETH' },
  { id: 8453, name: 'Base', symbol: 'ETH' },
  { id: 56, name: 'BNB Chain', symbol: 'BNB' },
  { id: 4663, name: 'Robinhood Chain', symbol: 'ETH' },
  { id: 5042, name: 'Arc Chain', symbol: 'USDC' },
];

interface TelegramProfile {
  evmAddress?: string;
  solanaAddress?: string;
  fundingChainId?: number;
  slippagePercent?: number;
  lastTokenAddress?: string;
  lastTokenChainId?: number;
  lastTokenChainType?: 'EVM' | 'SVM';
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
        // Check rate limit (10 requests per minute)
        const rateLimit = await checkRateLimit(request, env, 10, 60000);
        
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
                'X-RateLimit-Limit': '10',
                'X-RateLimit-Remaining': '0',
              }
            }
          );
        }

        const response = await handleApiRequest(request, env, ctx, corsHeaders);
        
        // Add rate limit headers to response
        const headers = new Headers(response.headers);
        headers.set('X-RateLimit-Limit', '10');
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
    const recognized = ['help', 'wallet', 'settings', 'dismiss'].includes(data)
      || ['wallet:link', 'wallet:set:evm', 'wallet:set:solana', 'wallet:generate', 'wallet:import', 'wallet:export'].includes(data)
      || /^token:refresh:(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(data)
      || /^settings:chain:\d+$/.test(data)
      || /^settings:slippage:(0\.5|1|3|5)$/.test(data)
      || /^trade:(buy:(0\.1|0\.5|1\.0)|sell:(25|50|100)|custom|confirm:[0-9a-f-]+|cancel)$/.test(data);
    if (!recognized) {
      await telegramApiCall('answerCallbackQuery', env, {
        callback_query_id: callback.id,
        text: 'This button is no longer available.',
        show_alert: true,
      });
      return Response.json({ ok: true });
    }
    await telegramApiCall('answerCallbackQuery', env, { callback_query_id: callback.id });
    if ((data === 'wallet' || data.startsWith('wallet:') || data === 'settings' || data.startsWith('settings:')) && chatType !== 'private') {
      await sendTelegramMessage(chatId, 'For privacy, check wallet balances and manage personal settings in a private chat with this bot.', env);
      return Response.json({ ok: true });
    }
    await handleTelegramCallback(chatId, data, env);
    return Response.json({ ok: true });
  }

  const text = message?.text?.trim() ?? '';
  await handleTelegramMessage(chatId, message?.chat?.type, text, env, message?.reply_to_message);

  return Response.json({ ok: true });
}

async function handleTelegramMessage(
  chatId: number,
  chatType: string | undefined,
  text: string,
  env: Env,
  replyToMessage?: TelegramMessage['reply_to_message'],
): Promise<void> {
  const promptedNetwork = replyToMessage?.from?.is_bot
    ? (replyToMessage.text === TELEGRAM_WALLET_PROMPTS.evm ? 'evm' : replyToMessage.text === TELEGRAM_WALLET_PROMPTS.solana ? 'solana' : undefined)
    : undefined;
  if (promptedNetwork) {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, 'For privacy, link wallet addresses only in a private chat with this bot.', env);
      return;
    }
    await setTelegramWallet(chatId, [promptedNetwork, text], env);
    return;
  }

  const [rawCommand = '', ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];

  if (command === '/start') {
    await sendTelegramMessage(chatId, 'Welcome to Hopr. Use /help to see working commands. Token lookups, wallet balance reads, and personal settings are available.', env, telegramActionKeyboard(env));
    return;
  }
  if (command === '/menu') {
    await sendTelegramMessage(chatId, 'Choose a Hopr tool. Send a token address to open the full action panel.', env, telegramActionKeyboard(env));
    return;
  }
  if (command === '/app') {
    await sendTelegramMessage(chatId, env.TELEGRAM_MINI_APP_URL ? 'Open your secure Hopr Mini App to view your synced wallet and dashboard.' : 'The Hopr Mini App is not configured yet. Ask the bot owner to set TELEGRAM_MINI_APP_URL.', env, telegramActionKeyboard(env));
    return;
  }
  if (command === '/help' || !text) {
    await sendTelegramMessage(chatId, 'Hopr bot commands:\n/start - Start the bot\n/menu - Open the action menu\n/help - Show this help\n/wallet <address> - Read native balances for a public address\n/setwallet <evm|solana> <address> - Save a public address for read-only /wallet and /balances\n/importkey <evm|solana> <key> - Import a private key as your trading wallet (DM only)\n/exportkeys - Reveal your trading wallet\'s raw private keys (DM only)\n/balances [address] - Refresh native balances\n/settings - View/change funding-chain, slippage, and quick-buy presets\n\nSend a token contract address by itself for a live lookup. Buy/Sell buttons first show a live quote; only the explicit Confirm and submit button signs and submits the trade.', env, telegramActionKeyboard(env));
    return;
  }
  if (command === '/wallet' || command === '/balances') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, 'For privacy, check wallet balances in a private chat with this bot.', env);
      return;
    }
    if (args.length > 0) {
      const network = args[0]?.toLowerCase();
      const suppliedAddress = network === 'evm' || network === 'solana' ? args.slice(1).join(' ') : args.join(' ');
      const isEvmAddress = /^0x[a-fA-F0-9]{40}$/.test(suppliedAddress);
      const isSolanaAddress = suppliedAddress.length >= 32 && suppliedAddress.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(suppliedAddress);
      if ((!isEvmAddress && !isSolanaAddress)
        || (network === 'evm' && !isEvmAddress)
        || (network === 'solana' && !isSolanaAddress)) {
        await sendTelegramMessage(chatId, 'Usage: /wallet <public-address>, /wallet evm <address>, or /wallet solana <address>. Only public addresses are supported—never send a private key or seed phrase.', env);
        return;
      }
      await showTelegramWalletBalances(chatId, isEvmAddress ? suppliedAddress : undefined, isSolanaAddress ? suppliedAddress : undefined, env);
      return;
    }
    await showTelegramWallet(chatId, env);
    return;
  }
  if (command === '/setwallet') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, 'For privacy, link wallet addresses only in a private chat with this bot.', env);
      return;
    }
    await setTelegramWallet(chatId, args, env);
    return;
  }
  if (command === '/importkey') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, 'For your safety, only send private keys in a private chat with this bot — never in a group.', env);
      return;
    }
    await handleTelegramImportKey(chatId, args, env);
    return;
  }
  if (command === '/exportkeys') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, 'For your safety, export keys only in a private chat with this bot.', env);
      return;
    }
    await sendTelegramMessage(
      chatId,
      'This reveals your raw private keys in chat. Only continue if you understand anyone who sees this message controls your funds.',
      env,
      telegramExportWarningKeyboard(),
    );
    return;
  }
  if (command === '/settings') {
    if (chatType !== 'private') {
      await sendTelegramMessage(chatId, 'For privacy, manage personal settings in a private chat with this bot.', env);
      return;
    }
    await showTelegramSettings(chatId, env);
    return;
  }

  const address = normalizeTelegramAddress(text);
  if (address) {
    await lookupTelegramToken(chatId, address, env);
    return;
  }

  await sendTelegramMessage(chatId, 'I could not match that to a command or token address. Use /help, or send a complete EVM or Solana token address.', env, telegramActionKeyboard(env));
}

function normalizeTelegramAddress(text: string): string | null {
  const value = text.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) return value;
  if (value.length >= 32 && value.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return value;
  return null;
}

async function lookupTelegramToken(chatId: number, address: string, env: Env): Promise<void> {
  const response = await handleChainDetection(address, env, {});
  const token = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    await sendTelegramMessage(chatId, 'No indexed token market was found for that address. Check the address and chain, then try again.', env);
    return;
  }

  const numberOrZero = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const price = numberOrZero(token.priceUsd);
  const liquidity = numberOrZero(token.liquidity);
  const fdv = numberOrZero(token.fdv);
  const change = numberOrZero(token.change24h);
  const symbol = typeof token.symbol === 'string' ? token.symbol : 'Unknown';
  const name = typeof token.name === 'string' ? token.name : 'Unknown token';
  const chain = typeof token.chainName === 'string' ? token.chainName : 'Unknown chain';
  const dex = typeof token.dexId === 'string' ? token.dexId.toUpperCase() : 'DEX';
  const volume = numberOrZero(token.volume24h);
  const result = `🟣 ${symbol}  |  ${name}\n🔗 ${chain}\n\`${address}\`\n\n🏊 POOL INFO\n🏪 DEX: ${dex}\n💰 Market cap / FDV: $${fdv.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n💧 Liquidity: $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n📊 24h volume: $${volume.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n📈 Price: $${price.toPrecision(6)}  |  24h: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n\n🧾 TOKEN INFO\n🪙 Symbol: ${symbol}\n🌐 Network: ${chain}\n🛡️ Data: DexScreener indexed market\n\n⚡ Scan complete. Market data only — no transaction was submitted.`;

  // Do not make Telegram wait for D1/KV. The market result is the user-visible
  // response; persistence is best-effort and runs concurrently with delivery.
  if (env.DB || env.TELEGRAM_STATE) {
    void readTelegramProfile(chatId, env)
      .then((profile) => writeTelegramProfile(chatId, {
        ...(profile ?? {}),
        lastTokenAddress: address,
        lastTokenChainId: typeof token.chainId === 'number' ? token.chainId : undefined,
        lastTokenChainType: token.chainType === 'SVM' ? 'SVM' : 'EVM',
        lastTokenSymbol: symbol,
      }, env))
      .catch((error) => console.error('Telegram token profile persistence failed', error));
  }
  await sendTelegramMessage(chatId, result, env, telegramTokenKeyboard(address));
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
  const row = await env.DB.prepare(
    `SELECT evm_address, solana_address, funding_chain_id, slippage_percent,
            last_token_address, last_token_chain_id, last_token_chain_type, last_token_symbol
       FROM telegram_profiles WHERE chat_id = ?1`,
  ).bind(chatId).first<{
    evm_address?: string;
    solana_address?: string;
    funding_chain_id?: number;
    slippage_percent?: number;
    last_token_address?: string;
    last_token_chain_id?: number;
    last_token_chain_type?: 'EVM' | 'SVM';
    last_token_symbol?: string;
  }>();
  if (!row) return {};
  const profile: TelegramProfile = {
    evmAddress: row.evm_address,
    solanaAddress: row.solana_address,
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
  const now = Date.now();
  if (env.DB) {
    await env.DB.prepare(
      `INSERT INTO telegram_profiles
        (chat_id, evm_address, solana_address, funding_chain_id, slippage_percent,
         last_token_address, last_token_chain_id, last_token_chain_type, last_token_symbol, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT(chat_id) DO UPDATE SET
         evm_address = excluded.evm_address,
         solana_address = excluded.solana_address,
         funding_chain_id = excluded.funding_chain_id,
         slippage_percent = excluded.slippage_percent,
         last_token_address = excluded.last_token_address,
         last_token_chain_id = excluded.last_token_chain_id,
         last_token_chain_type = excluded.last_token_chain_type,
         last_token_symbol = excluded.last_token_symbol,
         updated_at = excluded.updated_at`,
    ).bind(
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
    ).run();
  }
  if (env.TELEGRAM_STATE) await env.TELEGRAM_STATE.put(telegramProfileKey(chatId), JSON.stringify(profile), { expirationTtl: 86400 });
  return true;
}

function shortenTelegramAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function setTelegramWallet(chatId: number, args: string[], env: Env): Promise<void> {
  if (!env.TELEGRAM_STATE && !env.DB) {
    await sendTelegramMessage(chatId, 'Wallet linking needs the TELEGRAM_STATE KV or DB binding. Ask the bot owner to enable persistence, then retry.', env);
    return;
  }
  const [network, suppliedAddress] = args;
  const address = suppliedAddress?.trim() ?? '';
  const isEvm = network?.toLowerCase() === 'evm' && /^0x[a-fA-F0-9]{40}$/.test(address);
  const isSolana = network?.toLowerCase() === 'solana' && address.length >= 32 && address.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(address);
  if (!isEvm && !isSolana) {
    await sendTelegramMessage(chatId, 'Usage: /setwallet evm 0x… or /setwallet solana <base58-address>. Only a public address is needed—never send a seed phrase or private key.', env);
    return;
  }

  const profile = await readTelegramProfile(chatId, env) ?? {};
  if (isEvm) profile.evmAddress = address;
  if (isSolana) profile.solanaAddress = address;
  if (!await writeTelegramProfile(chatId, profile, env)) {
    await sendTelegramMessage(chatId, 'Could not save your wallet address. Please try again later.', env);
    return;
  }
  await sendTelegramMessage(chatId, `${network?.toUpperCase()} public address linked: ${shortenTelegramAddress(address)}. Only native balances are read; no signing or transactions are performed. Use /wallet to check balances.`, env, telegramActionKeyboard(env));
}

async function showTelegramWallet(chatId: number, env: Env): Promise<void> {
  const profile = await readTelegramProfile(chatId, env);
  if (!profile) {
    await sendTelegramMessage(chatId, 'To check a wallet now, use /wallet <public-address> or /balances <public-address>. To save an address for later, the bot owner must configure the TELEGRAM_STATE KV or DB binding. Never send a private key or seed phrase.', env);
    return;
  }
  if (!profile.evmAddress && !profile.solanaAddress) {
    await sendTelegramMessage(chatId, 'No public wallet addresses are linked yet. Use /wallet <public-address> for a one-time balance check, or choose Link wallet below to save one. Never send private keys or seed phrases.', env, telegramWalletLinkKeyboard());
    return;
  }

  await showTelegramWalletBalances(chatId, profile.evmAddress, profile.solanaAddress, env);
}

async function showTelegramWalletBalances(chatId: number, evmAddress: string | undefined, solanaAddress: string | undefined, env: Env): Promise<void> {
  const lines = ['<b>Wallet 1</b>'];
  if (evmAddress) {
    const results = await Promise.all(TELEGRAM_CHAINS.filter((chain) => chain.id !== 1151111081099710).map(async (chain) => {
      try {
        const balance = await fetchEvmBalance(evmAddress, chain.id);
        return `${chainEmoji(chain.name)} <b>${escapeTelegramHtml(chain.name)}</b>: ${formatTelegramBalance(balance)} <code>${chain.symbol}</code>  <tg-spoiler>$—</tg-spoiler>`;
      } catch {
        return `${chainEmoji(chain.name)} <b>${escapeTelegramHtml(chain.name)}</b>: <i>unavailable</i>`;
      }
    }));
    lines.push(...results);
  }
  if (solanaAddress) {
    try {
      const balance = await fetchSolanaBalance(solanaAddress);
      lines.push(`◎ <b>Solana</b>: ${formatTelegramBalance(balance)} <code>SOL</code>  <tg-spoiler>$—</tg-spoiler>`);
    } catch {
      lines.push('◎ <b>Solana</b>: <i>unavailable</i>');
    }
  }
  lines.push('', '<b>Total:</b> USD pricing unavailable', '', `<b>EVM:</b> <code>${escapeTelegramHtml(evmAddress ?? 'not linked')}</code>`, `<b>SOL:</b> <code>${escapeTelegramHtml(solanaAddress ?? 'not linked')}</code>`);
  await sendTelegramMessage(chatId, lines.join('\n'), env, telegramWalletActionKeyboard(env), 'HTML');
}

function formatTelegramBalance(value: string | number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (amount !== 0 && Math.abs(amount) < 0.01) return amount.toExponential(2);
  return amount.toFixed(2);
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chainEmoji(name: string): string {
  const icons: Record<string, string> = { Base: '🔷', Ethereum: '♦️', Binance: '🟡', Abstract: '🟢', Avalanche: '🔺', HyperEVM: '◉', Arbitrum: '🔵', Ink: '🟣', Story: 'Ⓢ', 'X Layer': '▧', Plasma: '◒', UniChain: '🟪', Monad: '◈', MegaETH: 'Ⓜ️', Tempo: 'Ⓣ', Robinhood: '🟩', Arc: '◢', Stable: '₮' };
  return icons[name] ?? '•';
}

function telegramWalletActionKeyboard(env: Env) {
  return {
    inline_keyboard: [
      [{ text: '📥 Import a wallet', callback_data: 'wallet:import' }, { text: '💼 Preferred Wallet', callback_data: 'wallet:preferred' }],
      [{ text: '🔑 Export private key', callback_data: 'wallet:export' }, { text: '🗑 Delete wallet', callback_data: 'wallet:delete' }],
      [{ text: '📦 Create wallet', callback_data: 'wallet:generate' }, { text: '🔄 Refresh balances', callback_data: 'wallet' }],
      ...(env.TELEGRAM_MINI_APP_URL ? [[{ text: '↗ Open Wallet Vault', web_app: { url: env.TELEGRAM_MINI_APP_URL } }]] : []),
      [{ text: '⚙ Settings', callback_data: 'settings' }, { text: '❔ Help', callback_data: 'help' }],
    ],
  };
}

function telegramSettingsKeyboard() {
  const chainRows = TELEGRAM_CHAINS.reduce<Array<Array<{ text: string; callback_data: string }>>>((rows, chain, index) => {
    const row = Math.floor(index / 2);
    rows[row] ??= [];
    rows[row].push({ text: chain.name, callback_data: `settings:chain:${chain.id}` });
    return rows;
  }, []);
  return {
    inline_keyboard: [
      ...chainRows,
      [0.5, 1, 3, 5].map((slippage) => ({ text: `${slippage}% slippage`, callback_data: `settings:slippage:${slippage}` })),
      [{ text: 'Wallets', callback_data: 'wallet' }, { text: 'Help', callback_data: 'help' }],
    ],
  };
}

function telegramWalletLinkKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Link EVM (read-only)', callback_data: 'wallet:set:evm' },
        { text: 'Link Solana (read-only)', callback_data: 'wallet:set:solana' },
      ],
      [{ text: 'Create trading wallet', callback_data: 'wallet:generate' }],
      [{ text: 'Import private key', callback_data: 'wallet:import' }],
      [{ text: 'Help', callback_data: 'help' }],
    ],
  };
}

function telegramExportWarningKeyboard() {
  return {
    inline_keyboard: [[{ text: '⚠️ Reveal private keys', callback_data: 'wallet:export' }]],
  };
}

/**
 * Decrypts and sends the user's raw private keys, once, as a DM. Telegram
 * chat history is not a safe place to store a key long-term, so the message
 * is deleted automatically ~60 seconds after sending — the caller should
 * still tell the user to move funds to self-custody if they export.
 */
async function showTelegramWalletExport(chatId: number, env: Env): Promise<void> {
  const userId = String(chatId);
  if (!env.DB || !env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, 'Exporting keys requires the bot owner to configure DB and ENCRYPTION_KEY.', env, telegramActionKeyboard(env));
    return;
  }
  const row = await env.DB.prepare(
    `SELECT evm_address, evm_encrypted_key, solana_address, solana_encrypted_key FROM user_wallets WHERE user_id = ?1`
  )
    .bind(userId)
    .first<{ evm_address: string; evm_encrypted_key: string; solana_address: string; solana_encrypted_key: string }>();
  if (!row) {
    await sendTelegramMessage(chatId, 'No trading wallet on file yet. Use Create trading wallet first.', env, telegramWalletLinkKeyboard());
    return;
  }
  const evmKey = await decryptPrivateKey(unpackEncryptedSecret(row.evm_encrypted_key), env.ENCRYPTION_KEY);
  const solKey = await decryptPrivateKey(unpackEncryptedSecret(row.solana_encrypted_key), env.ENCRYPTION_KEY);
  const text = `⚠️ Anyone with these keys has full control of these wallets. This message self-deletes in ~60s — save the keys somewhere safe now and never share them.\n\nEVM (${shortenTelegramAddress(row.evm_address)}):\n\`${evmKey}\`\n\nSolana (${shortenTelegramAddress(row.solana_address)}):\n\`${solKey}\``;
  const sent = await telegramApiCall('sendMessage', env, { chat_id: chatId, text, parse_mode: 'Markdown' });
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
    await sendTelegramMessage(chatId, 'Importing a key requires the bot owner to configure DB and ENCRYPTION_KEY.', env);
    return;
  }
  const [network, rawKey] = args;
  const userId = String(chatId);
  try {
    if (network?.toLowerCase() === 'evm') {
      const { address, privateKey } = importEvmKey(rawKey ?? '');
      const encrypted = packEncryptedSecret(await encryptPrivateKey(privateKey, env.ENCRYPTION_KEY));
      await env.DB.prepare(
        `INSERT INTO user_wallets (user_id, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key)
         VALUES (?1, ?2, ?3, COALESCE((SELECT solana_address FROM user_wallets WHERE user_id = ?1), ''), COALESCE((SELECT solana_encrypted_key FROM user_wallets WHERE user_id = ?1), ''))
         ON CONFLICT(user_id) DO UPDATE SET evm_address = excluded.evm_address, evm_encrypted_key = excluded.evm_encrypted_key`
      ).bind(userId, address, encrypted).run();
      await sendTelegramMessage(chatId, `EVM key imported: ${shortenTelegramAddress(address)}. Delete your previous message containing the raw key now.`, env, telegramActionKeyboard(env));
    } else if (network?.toLowerCase() === 'solana') {
      const { address, privateKey } = importSolanaKey(rawKey ?? '');
      const encrypted = packEncryptedSecret(await encryptPrivateKey(privateKey, env.ENCRYPTION_KEY));
      await env.DB.prepare(
        `INSERT INTO user_wallets (user_id, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key)
         VALUES (?1, COALESCE((SELECT evm_address FROM user_wallets WHERE user_id = ?1), ''), COALESCE((SELECT evm_encrypted_key FROM user_wallets WHERE user_id = ?1), ''), ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET solana_address = excluded.solana_address, solana_encrypted_key = excluded.solana_encrypted_key`
      ).bind(userId, address, encrypted).run();
      await sendTelegramMessage(chatId, `Solana key imported: ${shortenTelegramAddress(address)}. Delete your previous message containing the raw key now.`, env, telegramActionKeyboard(env));
    } else {
      await sendTelegramMessage(chatId, 'Usage: /importkey evm <private-key> or /importkey solana <base58-secret-key>', env);
    }
  } catch {
    await sendTelegramMessage(chatId, 'That key could not be parsed. Double-check the format and try again — and delete the bad message either way.', env);
  }
}

async function showTelegramWalletGenerate(chatId: number, env: Env): Promise<void> {
  const userId = String(chatId);
  if (!env.DB) {
    await sendTelegramMessage(chatId, 'Creating a trading wallet requires the bot owner to configure the D1 database binding.', env, telegramActionKeyboard(env));
    return;
  }
  if (!env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, 'Creating a trading wallet requires the bot owner to set the ENCRYPTION_KEY secret.', env, telegramActionKeyboard(env));
    return;
  }
  const existing = await getCustodialWallet(userId, env);
  if (existing) {
    await sendTelegramMessage(
      chatId,
      `<b>✦ YOUR HOPR WALLET IS READY</b>\n\nYour secure cross-chain wallet is already active.\n\n<b>EVM</b>  <code>${shortenTelegramAddress(existing.evmAddress)}</code>\n<b>Solana</b>  <code>${shortenTelegramAddress(existing.solanaAddress)}</code>\n\n🔐 Keys are encrypted and kept protected by Hopr.\n⚡ Open the Mini App to view your synced wallet and dashboard.`,
      env,
      telegramActionKeyboard(env),
      'HTML',
    );
    return;
  }
  const wallet = await createCustodialWallet(userId, env);
  await sendTelegramMessage(
    chatId,
    `<b>✦ YOUR HOPR WALLET IS READY</b>\n\nWelcome to your private cross-chain command center.\n\n<b>EVM</b>  <code>${shortenTelegramAddress(wallet.evmAddress)}</code>\n<b>Solana</b>  <code>${shortenTelegramAddress(wallet.solanaAddress)}</code>\n\n━━━━━━━━━━━━━━━━━━\n<b>Next step</b>\nFund either address, then open the Mini App to see your wallet synced instantly.\n\n🔐 Encrypted key custody\n⚡ Cross-chain ready\n🛡 Confirmation required before trades\n━━━━━━━━━━━━━━━━━━`,
    env,
    telegramActionKeyboard(env),
    'HTML',
  );
}

async function showTelegramSettings(chatId: number, env: Env): Promise<void> {
  const profile = await readTelegramProfile(chatId, env);
  if (!profile) {
    await sendTelegramMessage(chatId, 'Personal settings need the TELEGRAM_STATE KV or DB binding. Ask the bot owner to enable persistence.', env);
    return;
  }
  const chain = TELEGRAM_CHAINS.find((item) => item.id === profile.fundingChainId) ?? TELEGRAM_CHAINS[0];
  const slippage = profile.slippagePercent ?? 1;
  await sendTelegramMessage(chatId, `Your Telegram trade preferences:\nFunding chain: ${chain.name}\nSlippage preference: ${slippage}%\n\nChoose a chain or slippage below. Quotes still require an explicit confirmation before submission.`, env, telegramSettingsKeyboard());
}

async function handleTelegramTradeAction(chatId: number, data: string, env: Env): Promise<void> {
  if (data === 'trade:custom') {
    await sendTelegramMessage(chatId, 'Custom trade amounts are not enabled yet. Use /settings to choose a funding chain and slippage.', env, telegramActionKeyboard(env));
    return;
  }
  if (data === 'trade:cancel') {
    await sendTelegramMessage(chatId, 'Trade cancelled. No transaction was signed or submitted.', env, telegramActionKeyboard(env));
    return;
  }
  const confirmMatch = data.match(/^trade:confirm:([0-9a-f-]+)$/);
  if (confirmMatch) {
    try {
      const rpcUrls = {
        evm: (chainId: number) => getChainById(chainId)?.rpcUrl ?? '',
        solana: SUPPORTED_CHAINS.find((c) => c.key === 'sol')!.rpcUrl,
      };
      const result = await confirmTrade(String(chatId), confirmMatch[1], rpcUrls, env);
      await sendTelegramMessage(chatId, `Trade submitted successfully.\nTransaction: ${result.txHash}\n\nThe transaction is now on-chain; final settlement may take additional time.`, env, telegramActionKeyboard(env));
    } catch (error) {
      await sendTelegramMessage(chatId, `Trade was not submitted: ${error instanceof Error ? error.message : 'unknown error'}`, env, telegramActionKeyboard(env));
    }
    return;
  }
  const profile = await readTelegramProfile(chatId, env);
  if (!profile?.lastTokenAddress || !profile.lastTokenChainId) {
    await sendTelegramMessage(chatId, 'Open a token lookup first (paste a contract address), then use the buy/sell buttons on that result.', env, telegramActionKeyboard(env));
    return;
  }

  const userId = String(chatId);
  const wallet = await getCustodialWallet(userId, env);
  if (!wallet) {
    await sendTelegramMessage(
      chatId,
      'Trading needs a Hopr trading wallet (Hopr holds the keys and signs only after you confirm a quote). Create one, or link a public address for read-only balance checks only.',
      env,
      telegramWalletLinkKeyboard(),
    );
    return;
  }
  if (!env.ENCRYPTION_KEY) {
    await sendTelegramMessage(chatId, 'Trading is not available: the bot owner has not set ENCRYPTION_KEY.', env, telegramActionKeyboard(env));
    return;
  }

  const buyMatch = data.match(/^trade:buy:(0\.1|0\.5|1\.0)$/);
  const sellMatch = data.match(/^trade:sell:(25|50|100)$/);
  if (!buyMatch && !sellMatch) return;

  const targetChain = getChainById(profile.lastTokenChainId);
  if (!targetChain) {
    await sendTelegramMessage(chatId, 'That chain is not supported for trading yet.', env, telegramActionKeyboard(env));
    return;
  }
  const slippage = (profile.slippagePercent ?? 1) / 100;

  try {
    if (buyMatch) {
      const amountDecimal = buyMatch[1];
      const fundingChainId = profile.fundingChainId ?? 8453;
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
        `QUOTE READY\n\nBUY ${amountDecimal} ${fundingChain.nativeSymbol} -> ${profile.lastTokenSymbol ?? 'token'}\nRoute: ${fundingChain.name} -> ${targetChain.name}\nMinimum output: ${trade.quote.estimate.toAmountMin} base units\nPlatform fee: 0.5% included\n\nTap Confirm and submit to sign this quote, or Cancel to discard it.`,
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
        await sendTelegramMessage(chatId, `No open ${profile.lastTokenSymbol ?? 'token'} position found for this wallet to sell.`, env, telegramActionKeyboard(env));
        return;
      }
      const sellUnits = (BigInt(openTrade.purchased_amount) * BigInt(percent)) / 100n;
      const trade = await prepareSell(
        { userId, wallet, originalTradeDbId: openTrade.id, sellAmountUnits: sellUnits.toString(), slippage },
        env,
      );
      await sendTelegramMessage(
        chatId,
        `QUOTE READY\n\nSELL ${percent}% of ${profile.lastTokenSymbol ?? 'tokens'}\nRoute: ${targetChain.name} -> original funding asset\nMinimum output: ${trade.quote.estimate.toAmountMin} base units\nPlatform fee: 0.5% included\n\nTap Confirm and submit to sign this quote, or Cancel to discard it.`,
        env,
        telegramTradeConfirmationKeyboard(trade.id),
      );
      return;
    }
  } catch (error) {
    await sendTelegramMessage(chatId, `Trade failed: ${error instanceof Error ? error.message : 'unknown error'}`, env, telegramActionKeyboard(env));
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

async function handleTelegramCallback(chatId: number, data: string, env: Env): Promise<void> {
  if (data === 'help') return handleTelegramMessage(chatId, 'private', '/help', env);
  if (data === 'wallet') return showTelegramWallet(chatId, env);
  if (data === 'settings') return showTelegramSettings(chatId, env);
  if (data === 'dismiss') return;
  const refreshMatch = data.match(/^token:refresh:(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (refreshMatch) {
    telegramDetectionMemoryCache.delete(`detect:${refreshMatch[1]}`);
    return lookupTelegramToken(chatId, refreshMatch[1], env);
  }
  if (data.startsWith('trade:')) {
    return handleTelegramTradeAction(chatId, data, env);
  }
  if (data === 'wallet:generate') {
    return showTelegramWalletGenerate(chatId, env);
  }
  if (data === 'wallet:preferred') {
    return sendTelegramMessage(chatId, '💼 The wallet shown above is your preferred wallet. Use the Wallet Vault in the Mini App to create, select, archive, or manage multiple wallets.', env, telegramWalletActionKeyboard(env));
  }
  if (data === 'wallet:delete') {
    return sendTelegramMessage(chatId, '⚠️ <b>Delete wallet permanently?</b>\n\nThis cannot be undone. If you did not back up the private keys, the wallet and its funds cannot be recovered.', env, { inline_keyboard: [[{ text: '🗑 Delete permanently', callback_data: 'wallet:delete:confirm' }], [{ text: 'Cancel', callback_data: 'wallet' }]] }, 'HTML');
  }
  if (data === 'wallet:delete:confirm') {
    if (!env.DB) return sendTelegramMessage(chatId, 'Wallet storage is not configured.', env);
    await env.DB.prepare('DELETE FROM wallet_accounts WHERE user_id = ?1').bind(String(chatId)).run().catch(() => undefined);
    await env.DB.prepare('DELETE FROM user_wallets WHERE user_id = ?1').bind(String(chatId)).run().catch(() => undefined);
    return sendTelegramMessage(chatId, '✅ Wallet deleted permanently. It cannot be recovered without a backup.', env, telegramActionKeyboard(env));
  }
  if (data === 'wallet:export') {
    return showTelegramWalletExport(chatId, env);
  }
  if (data === 'wallet:import') {
    return sendTelegramMessage(
      chatId,
      'Send /importkey evm <private-key> or /importkey solana <base58-secret-key> as a direct message (not in a group). Delete your message right after sending it.',
      env,
      telegramActionKeyboard(env),
    );
  }
  if (data === 'wallet:link') {
    if (!env.TELEGRAM_STATE && !env.DB) {
      return sendTelegramMessage(chatId, 'Saving a wallet requires the bot owner to configure the TELEGRAM_STATE KV or DB binding. For a one-time read-only balance check, use /wallet <public-address>.', env);
    }
    return sendTelegramMessage(chatId, 'Choose which public wallet address to link. Never send a private key or seed phrase.', env, telegramWalletLinkKeyboard());
  }

  const walletNetworkMatch = data.match(/^wallet:set:(evm|solana)$/);
  if (walletNetworkMatch) {
    if (!env.TELEGRAM_STATE && !env.DB) {
      return sendTelegramMessage(chatId, 'Saving a wallet requires the bot owner to configure the TELEGRAM_STATE KV or DB binding. For a one-time read-only balance check, use /wallet <public-address>.', env);
    }
    const network = walletNetworkMatch[1] as 'evm' | 'solana';
    return sendTelegramMessage(chatId, TELEGRAM_WALLET_PROMPTS[network], env, {
      force_reply: true,
      input_field_placeholder: network === 'evm' ? 'Public EVM address only' : 'Public Solana address only',
    });
  }

  const chainMatch = data.match(/^settings:chain:(\d+)$/);
  if (chainMatch) {
    const chainId = Number(chainMatch[1]);
    const chain = TELEGRAM_CHAINS.find((item) => item.id === chainId);
    if (!chain) return sendTelegramMessage(chatId, 'That chain option is no longer available. Open /settings and try again.', env);
    const profile = await readTelegramProfile(chatId, env);
    if (!profile || !await writeTelegramProfile(chatId, { ...profile, fundingChainId: chain.id }, env)) {
      return sendTelegramMessage(chatId, 'Settings storage is not available. Ask the bot owner to configure TELEGRAM_STATE.', env);
    }
    return showTelegramSettings(chatId, env);
  }

  const slippageMatch = data.match(/^settings:slippage:(0\.5|1|3|5)$/);
  if (slippageMatch) {
    const profile = await readTelegramProfile(chatId, env);
    if (!profile || !await writeTelegramProfile(chatId, { ...profile, slippagePercent: Number(slippageMatch[1]) }, env)) {
      return sendTelegramMessage(chatId, 'Settings storage is not available. Ask the bot owner to configure TELEGRAM_STATE.', env);
    }
    return showTelegramSettings(chatId, env);
  }

  await sendTelegramMessage(chatId, 'This button is no longer available. Use /help to see current commands.', env);
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  env: Env,
  replyMarkup?: Record<string, unknown>,
  parseMode?: 'HTML' | 'Markdown',
): Promise<void> {
  await telegramApiCall('sendMessage', env, {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
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

  // POST /api/trade/quote - LI.FI route quote and executable transaction payload
  if (path === '/api/trade/quote' && request.method === 'POST') {
    const body = await request.json() as TradeRequest & { toChainId?: number; toToken?: string };
    return handleTradeQuote(body, env, corsHeaders);
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

  const wallet = await getCustodialWallet(String(user.id), env);
  return Response.json({
    user: { id: user.id, firstName: user.first_name, lastName: user.last_name, username: user.username },
    wallet: wallet ? { evmAddress: wallet.evmAddress, solanaAddress: wallet.solanaAddress } : null,
    walletSource: wallet ? 'telegram' : null,
  }, { headers: corsHeaders });
}

async function handleTelegramWalletCreate(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.DB || !env.ENCRYPTION_KEY) {
    return Response.json({ error: 'Telegram wallet creation is not configured.' }, { status: 503, headers: corsHeaders });
  }
  const auth = await getTelegramRequestUser(request, env);
  if (!auth) return Response.json({ error: 'Telegram authentication expired or could not be verified.' }, { status: 401, headers: corsHeaders });
  try {
    const body = auth.body as { label?: string };
    const generated = generateDualWallet();
    const wallet = await storeWalletAccount(String(auth.user.id), generated, body.label || '', 'generated', env);
    return Response.json({ wallet: publicWallet(wallet), created: true }, { headers: corsHeaders });
  } catch (error) {
    console.error('Telegram wallet creation failed', error);
    return Response.json({ error: 'Wallet storage is unavailable. Apply migrations/0003_multi_wallets.sql to the production D1 database, then try again.' }, { status: 503, headers: corsHeaders });
  }
}

type WalletAccountRow = {
  id: string; user_id: string; label: string; source: string; evm_address: string | null; evm_encrypted_key: string | null;
  solana_address: string | null; solana_encrypted_key: string | null; is_active: number; created_at: string;
};

function publicWallet(row: WalletAccountRow | { id: string; label: string; source: string; evm_address: string | null; solana_address: string | null; is_active: number; created_at: string }) {
  return { id: row.id, label: row.label, source: row.source, evmAddress: row.evm_address, solanaAddress: row.solana_address, isActive: Boolean(row.is_active), createdAt: row.created_at };
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

async function storeWalletAccount(userId: string, wallet: { evmAddress: string | null; evmPrivateKey: string | null; solanaAddress: string | null; solanaPrivateKey: string | null }, label: string, source: 'generated' | 'imported', env: Env): Promise<WalletAccountRow> {
  if (!env.DB || !env.ENCRYPTION_KEY) throw new Error('Wallet storage is not configured.');
  const id = crypto.randomUUID();
  const evmEncrypted = wallet.evmPrivateKey ? packEncryptedSecret(await encryptPrivateKey(wallet.evmPrivateKey, env.ENCRYPTION_KEY)) : null;
  const solanaEncrypted = wallet.solanaPrivateKey ? packEncryptedSecret(await encryptPrivateKey(wallet.solanaPrivateKey, env.ENCRYPTION_KEY)) : null;
  const finalLabel = label.trim() || await nextWalletLabel(userId, env);
  await env.DB.prepare(`UPDATE wallet_accounts SET is_active = 0 WHERE user_id = ?1`).bind(userId).run();
  await env.DB.prepare(`INSERT INTO wallet_accounts (id, user_id, label, source, evm_address, evm_encrypted_key, solana_address, solana_encrypted_key, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)`).bind(id, userId, finalLabel.slice(0, 80), source, wallet.evmAddress, evmEncrypted, wallet.solanaAddress, solanaEncrypted).run();
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
  const body = checked.auth.body as { network?: string; privateKey?: string; label?: string; confirmRisk?: boolean };
  if (!body.confirmRisk || typeof body.privateKey !== 'string' || body.privateKey.length > 4096) return Response.json({ error: 'Confirm the private-key risk acknowledgement before importing.' }, { status: 400, headers: corsHeaders });
  try {
    const network = body.network;
    const imported = network === 'evm' ? importEvmKey(body.privateKey) : network === 'solana' ? importSolanaKey(body.privateKey) : null;
    if (!imported) throw new Error('Choose EVM or Solana.');
    const blank: { evmAddress: string | null; evmPrivateKey: string | null; solanaAddress: string | null; solanaPrivateKey: string | null } = { evmAddress: null, evmPrivateKey: null, solanaAddress: null, solanaPrivateKey: null };
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
  return new Response(JSON.stringify({ warning: 'Never share these keys. Anyone with them can permanently control the wallet.', evmPrivateKey, solanaPrivateKey }), { headers: { ...corsHeaders, 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', 'Content-Type': 'application/json' } });
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

async function handleChainDetection(
  address: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Check cache first
  const cacheKey = `detect:${address}`;
  const memoryCached = telegramDetectionMemoryCache.get(cacheKey);
  if (memoryCached && memoryCached.expiresAt > Date.now()) {
    return Response.json(memoryCached.value, { headers: { ...corsHeaders, 'X-Cache': 'MEMORY' } });
  }
  if (memoryCached) telegramDetectionMemoryCache.delete(cacheKey);
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) {
    const value = JSON.parse(cached) as Record<string, unknown>;
    telegramDetectionMemoryCache.set(cacheKey, { value, expiresAt: Date.now() + 300_000 });
    return Response.json(value, { headers: { ...corsHeaders, 'X-Cache': 'HIT' } });
  }

  // Detect chain
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(address);

  let result;

  if (isBase58) {
    // Solana token detection via DexScreener
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
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
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        fdv: pair.fdv || 0,
        change24h: pair.priceChange?.h24 || 0,
        volume24h: pair.volume?.h24 || 0,
        dexId: pair.dexId,
      };
    }
  } else if (isEvm) {
    const argusLaunch = await fetchArgusPortalLaunch(address);
    if (argusLaunch) {
      result = {
        address,
        name: argusLaunch.name,
        symbol: argusLaunch.symbol,
        decimals: 18,
        chainId: 5042,
        chainType: 'EVM',
        chainName: 'Arc Chain',
        chainColor: '#FF6D00',
        priceUsd: 0,
        liquidity: 0,
        fdv: 0,
        change24h: 0,
        volume24h: 0,
        liquiditySource: 'Argus Portal #7',
        launchpad: 'ArgusWorld',
        pairedAsset: { address: argusLaunch.quoteAsset, symbol: 'USDC' },
      };
    }
    // EVM token detection via DexScreener
    const response = result ? null : await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = response ? await response.json() : {};
    
    if (!result && data.pairs && data.pairs.length > 0) {
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
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        fdv: pair.fdv || 0,
        change24h: pair.priceChange?.h24 || 0,
        volume24h: pair.volume?.h24 || 0,
        pairedAsset: paired ? { address: paired.address, name: paired.name, symbol: paired.symbol } : chainInfo.id === 4663 ? { symbol: 'WETH', name: 'Wrapped Ether' } : undefined,
        dexId: pair.dexId,
      };
    }
  }

  if (!result) {
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

  // Cache for 5 minutes. Do not add KV write latency to the token response.
  telegramDetectionMemoryCache.set(cacheKey, { value: result, expiresAt: Date.now() + 300_000 });
  if (env.CACHE) {
    void env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 }).catch((error: unknown) => {
      console.error('Token detection cache write failed', error);
    });
  }

  return Response.json(result, { headers: { ...corsHeaders, 'X-Cache': 'MISS' } });
}

async function fetchGeckoLaunchpadPool(address: string, network: string): Promise<{ name: string; symbol: string; source: string; launchpad?: string; priceUsd: number; liquidity: number; volume24h: number; fdv: number; pairAddress: string; pairedAsset?: { symbol: string } } | null> {
  try {
    const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`);
    if (!response.ok) return null;
    const payload = await response.json() as { data?: Array<{ id?: string; attributes?: Record<string, unknown>; relationships?: { dex?: { data?: { id?: string } }; base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } }> };
    const pool = payload.data?.find((item) => Number(item.attributes?.reserve_in_usd ?? 0) > 0) ?? payload.data?.[0];
    if (!pool?.attributes || Number(pool.attributes.reserve_in_usd ?? 0) <= 0) return null;
    const attrs = pool.attributes;
    const source = String(pool.relationships?.dex?.data?.id?.split('_').pop() ?? 'GeckoTerminal').replace(/[_-]+/g, ' ');
    const normalized = source.toLowerCase().replace(/[^a-z]/g, '');
    const launchpad = normalized.includes('pump') ? 'Pump.fun' : normalized.includes('stonk') ? 'StonkFun' : normalized.includes('argus') ? 'ArgusWorld' : normalized.includes('tolly') ? 'TollyLabs' : normalized.includes('pons') ? 'PonsFamily' : undefined;
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

async function fetchArgusPortalLaunch(tokenAddress: string): Promise<{ creator: string; hook: string; locker: string; quoteAsset: string; name: string; symbol: string } | null> {
  try {
    const response = await fetch('https://rpc.mainnet.arc.io', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ARGUS_PORTAL_7, data: `${ARGUS_LAUNCHES_SELECTOR}${tokenAddress.slice(2).padStart(64, '0')}` }, 'latest'] }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { result?: string };
    const encoded = payload.result ?? '';
    if (!/^0x[0-9a-fA-F]+$/.test(encoded) || encoded.length !== 2 + 11 * 64) return null;
    const word = (index: number) => encoded.slice(2 + index * 64, 2 + (index + 1) * 64);
    const addressFromWord = (index: number) => `0x${word(index).slice(24)}`;
    const creator = addressFromWord(0);
    const hook = addressFromWord(4);
    const locker = addressFromWord(3);
    const quoteAsset = addressFromWord(10);
    if (/^0x0+$/.test(creator) || /^0x0+$/.test(hook) || /^0x0+$/.test(locker)) return null;
    const metadata = await fetchArgusTokenMetadata(tokenAddress);
    return { creator, hook, locker, quoteAsset, name: metadata.name, symbol: metadata.symbol };
  } catch {
    return null;
  }
}

async function fetchArgusTokenMetadata(address: string): Promise<{ name: string; symbol: string }> {
  const calls = [{ sig: '0x06fdde03', key: 'name' }, { sig: '0x95d89b41', key: 'symbol' }];
  const values = await Promise.all(calls.map(async ({ sig }) => {
    const response = await fetch('https://rpc.mainnet.arc.io', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: sig }, 'latest'] }),
    });
    const payload = await response.json() as { result?: string };
    return payload.result ?? '0x';
  }));
  const decode = (value: string) => {
    const clean = value.slice(2);
    const length = parseInt(clean.slice(64, 128), 16) || 0;
    const bytes = clean.slice(128, 128 + length * 2).match(/.{1,2}/g) ?? [];
    return new TextDecoder().decode(Uint8Array.from(bytes.map((byte) => parseInt(byte, 16))));
  };
  return { name: decode(values[0]) || 'Argus token', symbol: decode(values[1]) || 'UNKNOWN' };
}

async function handleWalletBalances(
  address: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Query balances across all chains
  const balances = await Promise.allSettled([
    // Solana balance
    fetchSolanaBalance(address),
    // EVM balances
    fetchEvmBalance(address, 42161),  // Arbitrum
    fetchEvmBalance(address, 8453),   // Base
    fetchEvmBalance(address, 56),     // BSC
    fetchEvmBalance(address, 4663),   // Robinhood
    fetchEvmBalance(address, 5042),   // Arc
  ]);

  const result = {
    address,
    balances: balances.map((b, i) => ({
      chainId: [1151111081099710, 42161, 8453, 56, 4663, 5042][i],
      balance: b.status === 'fulfilled' ? b.value : '0',
      error: b.status === 'rejected' ? b.reason.message : null,
    })),
  };

  return Response.json(result, { headers: corsHeaders });
}

async function fetchSolanaBalance(address: string): Promise<string> {
  const response = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address],
    }),
  });
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
  const data = await response.json() as { result?: { value?: number }; error?: { message?: string } };
  if (data.error || typeof data.result?.value !== 'number' || !Number.isFinite(data.result.value)) {
    throw new Error(data.error?.message ?? 'Invalid Solana RPC response');
  }
  return (data.result.value / 1e9).toString();
}

async function fetchEvmBalance(address: string, chainId: number): Promise<string> {
  const rpcUrls: Record<number, string> = {
    42161: 'https://arb1.arbitrum.io/rpc',
    8453: 'https://mainnet.base.org',
    56: 'https://bsc-dataseed.binance.org',
    4663: 'https://rpc.mainnet.chain.robinhood.com',
    5042: 'https://rpc.mainnet.arc.io',
  };

  const rpcUrl = rpcUrls[chainId];
  if (!rpcUrl) return '0';

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }),
  });
  if (!response.ok) throw new Error(`EVM RPC returned HTTP ${response.status}`);
  const data = await response.json() as { result?: string; error?: { message?: string } };
  if (data.error || typeof data.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data.result)) {
    throw new Error(data.error?.message ?? 'Invalid EVM RPC response');
  }
  const balance = BigInt(data.result);
  return (Number(balance) / 1e18).toString();
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
