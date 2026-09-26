import { pathToFileURL } from 'node:url';

export const TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Start the Hopr bot' },
  { command: 'menu', description: 'Open the Hopr action menu' },
  { command: 'help', description: 'Show available commands and bot status' },
  { command: 'wallet', description: 'Check a public wallet balance' },
  { command: 'setwallet', description: 'Link a public wallet address' },
  { command: 'balances', description: 'Refresh linked native-token balances' },
  { command: 'settings', description: 'View funding-chain and slippage preferences' },
];

function validateConfiguration({ token, webhookSecret, webhookUrl }) {
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

export async function configureTelegram({ token, webhookSecret, webhookUrl, fetchImpl = fetch }) {
  validateConfiguration({ token, webhookSecret, webhookUrl });

  await callTelegramApi(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
  }, fetchImpl);
  await callTelegramApi(token, 'setMyCommands', TELEGRAM_COMMANDS, fetchImpl);
  await callTelegramApi(token, 'setChatMenuButton', { menu_button: { type: 'commands' } }, fetchImpl);

  return { webhook: true, commands: TELEGRAM_COMMANDS.map(({ command }) => command), menuButton: 'commands' };
}

async function main() {
  try {
    const result = await configureTelegram({
      token: process.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    });
    console.log(`Telegram configured: webhook, slash-command suggestions (${result.commands.map((command) => `/${command}`).join(', ')}), and command menu.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Telegram configuration failed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
