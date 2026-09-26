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
 */

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENCRYPTION_KEY: string;
  LIFI_API_KEY: string;
  ENVIRONMENT: string;
  RATE_LIMIT: KVNamespace; // For rate limiting
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_STATE?: KVNamespace;
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

const TELEGRAM_ACTION_KEYBOARD = {
  inline_keyboard: [
    [
      { text: 'Wallet', callback_data: 'wallet' },
      { text: 'Settings', callback_data: 'settings' },
    ],
    [
      { text: 'Link wallet', callback_data: 'wallet:link' },
      { text: 'Help', callback_data: 'help' },
    ],
  ],
};

const TELEGRAM_WALLET_PROMPTS = {
  evm: 'Reply to this message with a public EVM address only.',
  solana: 'Reply to this message with a public Solana address only.',
};

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
}

interface TradeRequest {
  userId: string;
  tokenAddress: string;
  amount: string;
  fundingChain: string;
  slippage: number;
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
    const recognized = ['help', 'wallet', 'settings'].includes(data)
      || ['wallet:link', 'wallet:set:evm', 'wallet:set:solana'].includes(data)
      || /^settings:chain:\d+$/.test(data)
      || /^settings:slippage:(0\.5|1|3|5)$/.test(data);
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
    await sendTelegramMessage(chatId, 'Welcome to Hopr. Use /help to see working commands. Token lookups, wallet balance reads, and personal settings are available.', env, TELEGRAM_ACTION_KEYBOARD);
    return;
  }
  if (command === '/help' || !text) {
    await sendTelegramMessage(chatId, 'Hopr bot commands:\n/start - Start the bot\n/help - Show this help\n/wallet <address> - Read native balances for a public address\n/setwallet <evm|solana> <address> - Save a public address for /wallet and /balances\n/balances [address] - Refresh native balances\n/settings - View/change funding-chain and slippage preferences\n\nSend a token contract address by itself for a live DexScreener lookup. Wallet reads are public/read-only. This bot does not sign or submit trades.', env, TELEGRAM_ACTION_KEYBOARD);
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

  await sendTelegramMessage(chatId, 'I could not match that to a command or token address. Use /help, or send a complete EVM or Solana token address.', env, TELEGRAM_ACTION_KEYBOARD);
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
  const result = `${symbol} — ${name}\nChain: ${chain}\nAddress: ${address}\nPrice: $${price.toPrecision(6)}\n24h: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\nLiquidity: $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}\nFDV: $${fdv.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n\nMarket data from DexScreener. This bot does not execute trades.`;
  await sendTelegramMessage(chatId, result, env, TELEGRAM_ACTION_KEYBOARD);
}

async function readTelegramProfile(chatId: number, env: Env): Promise<TelegramProfile | null> {
  if (!env.TELEGRAM_STATE) return null;
  const stored = await env.TELEGRAM_STATE.get(`telegram:${chatId}`);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as TelegramProfile;
  } catch {
    return {};
  }
}

async function writeTelegramProfile(chatId: number, profile: TelegramProfile, env: Env): Promise<boolean> {
  if (!env.TELEGRAM_STATE) return false;
  await env.TELEGRAM_STATE.put(`telegram:${chatId}`, JSON.stringify(profile));
  return true;
}

function shortenTelegramAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function setTelegramWallet(chatId: number, args: string[], env: Env): Promise<void> {
  if (!env.TELEGRAM_STATE) {
    await sendTelegramMessage(chatId, 'Wallet linking needs a Cloudflare KV binding named TELEGRAM_STATE. Ask the bot owner to enable it, then retry.', env);
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
  await sendTelegramMessage(chatId, `${network?.toUpperCase()} public address linked: ${shortenTelegramAddress(address)}. Only native balances are read; no signing or transactions are performed. Use /wallet to check balances.`, env, TELEGRAM_ACTION_KEYBOARD);
}

async function showTelegramWallet(chatId: number, env: Env): Promise<void> {
  const profile = await readTelegramProfile(chatId, env);
  if (!profile) {
    await sendTelegramMessage(chatId, 'To check a wallet now, use /wallet <public-address> or /balances <public-address>. To save an address for later, the bot owner must configure a Cloudflare KV binding named TELEGRAM_STATE. Never send a private key or seed phrase.', env);
    return;
  }
  if (!profile.evmAddress && !profile.solanaAddress) {
    await sendTelegramMessage(chatId, 'No public wallet addresses are linked yet. Use /wallet <public-address> for a one-time balance check, or choose Link wallet below to save one. Never send private keys or seed phrases.', env, telegramWalletLinkKeyboard());
    return;
  }

  await showTelegramWalletBalances(chatId, profile.evmAddress, profile.solanaAddress, env);
}

async function showTelegramWalletBalances(chatId: number, evmAddress: string | undefined, solanaAddress: string | undefined, env: Env): Promise<void> {
  const lines = ['Linked public wallets (read-only):'];
  if (evmAddress) {
    lines.push(`EVM ${shortenTelegramAddress(evmAddress)}:`);
    const results = await Promise.all(TELEGRAM_CHAINS.filter((chain) => chain.id !== 1151111081099710).map(async (chain) => {
      try {
        const balance = await fetchEvmBalance(evmAddress, chain.id);
        return `  ${chain.name}: ${Number(balance).toFixed(5)} ${chain.symbol}`;
      } catch {
        return `  ${chain.name}: unavailable`;
      }
    }));
    lines.push(...results);
  }
  if (solanaAddress) {
    try {
      const balance = await fetchSolanaBalance(solanaAddress);
      lines.push(`Solana ${shortenTelegramAddress(solanaAddress)}: ${Number(balance).toFixed(5)} SOL`);
    } catch {
      lines.push(`Solana ${shortenTelegramAddress(solanaAddress)}: unavailable`);
    }
  }
  lines.push('\nTo save addresses, use /setwallet <evm|solana> <address>.');
  await sendTelegramMessage(chatId, lines.join('\n'), env, TELEGRAM_ACTION_KEYBOARD);
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
        { text: 'Link EVM', callback_data: 'wallet:set:evm' },
        { text: 'Link Solana', callback_data: 'wallet:set:solana' },
      ],
      [{ text: 'Help', callback_data: 'help' }],
    ],
  };
}

async function showTelegramSettings(chatId: number, env: Env): Promise<void> {
  const profile = await readTelegramProfile(chatId, env);
  if (!profile) {
    await sendTelegramMessage(chatId, 'Personal settings need a Cloudflare KV binding named TELEGRAM_STATE. Ask the bot owner to enable it.', env);
    return;
  }
  const chain = TELEGRAM_CHAINS.find((item) => item.id === profile.fundingChainId) ?? TELEGRAM_CHAINS[0];
  const slippage = profile.slippagePercent ?? 1;
  await sendTelegramMessage(chatId, `Your trade preferences (display only; Telegram trading is not enabled):\nFunding chain: ${chain.name}\nSlippage preference: ${slippage}%\n\nChoose a chain or slippage below.`, env, telegramSettingsKeyboard());
}

async function handleTelegramCallback(chatId: number, data: string, env: Env): Promise<void> {
  if (data === 'help') return handleTelegramMessage(chatId, 'private', '/help', env);
  if (data === 'wallet') return showTelegramWallet(chatId, env);
  if (data === 'settings') return showTelegramSettings(chatId, env);
  if (data === 'wallet:link') {
    if (!env.TELEGRAM_STATE) {
      return sendTelegramMessage(chatId, 'Saving a wallet requires the bot owner to configure the TELEGRAM_STATE KV binding. For a one-time read-only balance check, use /wallet <public-address>.', env);
    }
    return sendTelegramMessage(chatId, 'Choose which public wallet address to link. Never send a private key or seed phrase.', env, telegramWalletLinkKeyboard());
  }

  const walletNetworkMatch = data.match(/^wallet:set:(evm|solana)$/);
  if (walletNetworkMatch) {
    if (!env.TELEGRAM_STATE) {
      return sendTelegramMessage(chatId, 'Saving a wallet requires the bot owner to configure the TELEGRAM_STATE KV binding. For a one-time read-only balance check, use /wallet <public-address>.', env);
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
): Promise<void> {
  await telegramApiCall('sendMessage', env, {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function telegramApiCall(method: string, env: Env, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let result: { ok?: boolean; description?: string };
  try {
    result = await response.json() as { ok?: boolean; description?: string };
  } catch {
    console.error(`Telegram API ${method} returned an invalid response (HTTP ${response.status})`);
    throw new Error(`Telegram API request failed (${method})`);
  }
  if (!response.ok || !result.ok) {
    console.error(`Telegram API ${method} failed with HTTP ${response.status}${result.description ? `: ${result.description}` : ''}`);
    throw new Error(`Telegram API request failed (${method})`);
  }
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

async function handleChainDetection(
  address: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Check cache first
  const cacheKey = `detect:${address}`;
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) {
    return Response.json(JSON.parse(cached), { headers: { ...corsHeaders, 'X-Cache': 'HIT' } });
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
      const pair = data.pairs[0];
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
      };
    }
  } else if (isEvm) {
    // EVM token detection via DexScreener
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      const chainMap: Record<string, { id: number; name: string; color: string }> = {
        'arbitrum': { id: 42161, name: 'Arbitrum One', color: '#28A0F0' },
        'base': { id: 8453, name: 'Base', color: '#0052FF' },
        'bsc': { id: 56, name: 'BNB Chain', color: '#F0B90B' },
        'robinhood': { id: 4663, name: 'Robinhood Chain', color: '#00C853' },
        'arc': { id: 5042, name: 'Arc Chain', color: '#FF6D00' },
      };
      
      const chainInfo = chainMap[pair.chainId] || { id: 0, name: pair.chainId, color: '#666' };
      
      result = {
        address,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        decimals: 18,
        chainId: chainInfo.id,
        chainType: 'EVM',
        chainName: chainInfo.name,
        chainColor: chainInfo.color,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        fdv: pair.fdv || 0,
        change24h: pair.priceChange?.h24 || 0,
      };
    }
  }

  if (!result) {
    return Response.json({ error: 'Token not found' }, { status: 404, headers: corsHeaders });
  }

  // Cache for 5 minutes
  if (env.CACHE) {
    ctx_wait(5 * 60); // Helper to set cache TTL
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
  }

  return Response.json(result, { headers: { ...corsHeaders, 'X-Cache': 'MISS' } });
}

function ctx_wait(seconds: number) {
  // Placeholder for cache TTL
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
