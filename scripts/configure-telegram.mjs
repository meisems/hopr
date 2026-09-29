import { pathToFileURL } from 'node:url';

export const TELEGRAM_COMMANDS = [
  { command: 'start', description: '⚡ Start Hopr' },
  { command: 'menu', description: '◆ Open the main menu' },
  { command: 'app', description: '🚀 Open the Hopr Mini App' },
  { command: 'help', description: '❓ Every command, explained' },
  { command: 'wallet', description: '👛 Wallet balances' },
  { command: 'balances', description: '🔄 Refresh native balances' },
  { command: 'positions', description: '📊 Open positions with live prices' },
  { command: 'pools', description: '📡 Launchpad pools, liquidity & volume' },
  { command: 'swap', description: 'Ⓝ Swap on NEAR, e.g. /swap 1 near usdc' },
  { command: 'referral', description: '🎁 Refer & earn 25% of friends’ fees' },
  { command: 'settings', description: '⚙️ Funding chain & slippage' },
];

/** Shown on the bot's profile and on the empty-chat "What can this bot do?" screen. */
export const TELEGRAM_SHORT_DESCRIPTION = 'Hop across chains — scan and trade any token on Solana, Base, Arbitrum, BNB, NEAR and more.';
export const TELEGRAM_DESCRIPTION = [
  '⚡ Hopr — your cross-chain trading terminal in Telegram.',
  '',
  '🔎 Paste any token address for a live market card',
  '💱 Buy & sell with live quotes — you confirm every trade',
  '👛 Encrypted multi-chain wallet (EVM + Solana + NEAR)',
  '⛓ Solana · Base · Arbitrum · BNB · Robinhood · Arc · NEAR',
  '',
  'Tap Start to begin.',
].join('\n');

function validateConfiguration({ token, webhookSecret, webhookUrl, miniAppUrl }) {
  const missing = [];
  if (!token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!webhookSecret) missing.push('TELEGRAM_WEBHOOK_SECRET');
  if (!webhookUrl) missing.push('TELEGRAM_WEBHOOK_URL');
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must contain only letters, numbers, underscores, or hyphens (1–256 characters).');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    throw new Error('TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL.');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('TELEGRAM_WEBHOOK_URL must use HTTPS.');
  }
  if (miniAppUrl) {
    let parsedMiniAppUrl;
    try {
      parsedMiniAppUrl = new URL(miniAppUrl);
    } catch {
      throw new Error('TELEGRAM_MINI_APP_URL must be a valid HTTPS URL.');
    }
    if (parsedMiniAppUrl.protocol !== 'https:') throw new Error('TELEGRAM_MINI_APP_URL must use HTTPS.');
  }
}

async function callTelegramApi(token, method, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Telegram API request failed (${method}); check network access and try again.`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram API returned an invalid response (${method}).`);
  }
  if (!response.ok || !result?.ok) {
    const description = typeof result?.description === 'string' ? `: ${result.description}` : '';
    throw new Error(`Telegram API rejected ${method}${description}`);
  }
  return result.result;
}

export async function configureTelegram({ token, webhookSecret, webhookUrl, miniAppUrl, fetchImpl = fetch }) {
  validateConfiguration({ token, webhookSecret, webhookUrl, miniAppUrl });

  await callTelegramApi(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
  }, fetchImpl);
  await callTelegramApi(token, 'setMyCommands', { commands: TELEGRAM_COMMANDS }, fetchImpl);
  await callTelegramApi(token, 'setMyShortDescription', { short_description: TELEGRAM_SHORT_DESCRIPTION }, fetchImpl);
  await callTelegramApi(token, 'setMyDescription', { description: TELEGRAM_DESCRIPTION }, fetchImpl);
  await callTelegramApi(token, 'setChatMenuButton', {
    menu_button: miniAppUrl ? { type: 'web_app', text: 'Open Hopr', web_app: { url: miniAppUrl } } : { type: 'commands' },
  }, fetchImpl);

  return { webhook: true, commands: TELEGRAM_COMMANDS.map(({ command }) => command), menuButton: miniAppUrl ? 'web_app' : 'commands' };
}

async function main() {
  try {
    const result = await configureTelegram({
      token: process.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
      miniAppUrl: process.env.TELEGRAM_MINI_APP_URL,
    });
    console.log(`Telegram configured: webhook, slash-command suggestions (${result.commands.map((command) => `/${command}`).join(', ')}), bot description, and menu button.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Telegram configuration failed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
