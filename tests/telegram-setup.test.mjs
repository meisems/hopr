import test from 'node:test';
import assert from 'node:assert/strict';
import { configureTelegram, TELEGRAM_COMMANDS, TELEGRAM_DESCRIPTION, TELEGRAM_SHORT_DESCRIPTION } from '../scripts/configure-telegram.mjs';

const config = {
  token: '123456:example-token',
  webhookSecret: 'a_secure-test-secret_123',
  webhookUrl: 'https://bot.example.workers.dev/telegram/webhook',
};

function successfulFetchRecorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  return { calls, fetchImpl };
}

test('registers webhook, command suggestions, then the native command menu', async () => {
  const { calls, fetchImpl } = successfulFetchRecorder();
  const result = await configureTelegram({ ...config, fetchImpl });

  assert.deepEqual(calls.map(({ url }) => url.split('/').at(-1)), [
    'setWebhook', 'setMyCommands', 'setMyShortDescription', 'setMyDescription', 'setChatMenuButton',
  ]);
  assert.deepEqual(calls[0].body, {
    url: config.webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ['message', 'callback_query'],
  });
  assert.deepEqual(calls[1].body, { commands: TELEGRAM_COMMANDS });
  assert.deepEqual(calls[2].body, { short_description: TELEGRAM_SHORT_DESCRIPTION });
  assert.deepEqual(calls[3].body, { description: TELEGRAM_DESCRIPTION });
  assert.ok(TELEGRAM_SHORT_DESCRIPTION.length <= 120, 'Telegram caps short descriptions at 120 characters');
  assert.ok(TELEGRAM_DESCRIPTION.length <= 512, 'Telegram caps descriptions at 512 characters');
  assert.ok(TELEGRAM_COMMANDS.every(({ description }) => description.length <= 256));
  assert.deepEqual(calls[4].body, { menu_button: { type: 'commands' } });
  assert.deepEqual(result.commands, ['start', 'menu', 'app', 'help', 'wallet', 'balances', 'positions', 'pools', 'swap', 'referral', 'settings']);
  assert.equal(calls[0].url.includes(config.token), true);
});

test('registers the Mini App as the native menu button when configured', async () => {
  const { calls, fetchImpl } = successfulFetchRecorder();
  const miniAppUrl = 'https://hopr.example/';
  const result = await configureTelegram({ ...config, miniAppUrl, fetchImpl });

  assert.deepEqual(calls.at(-1).body, { menu_button: { type: 'web_app', text: 'Open Hopr', web_app: { url: miniAppUrl } } });
  assert.equal(result.menuButton, 'web_app');
});

test('validates required variables before making a request', async () => {
  let requested = false;
  await assert.rejects(
    configureTelegram({ ...config, token: '', fetchImpl: async () => { requested = true; } }),
    /TELEGRAM_BOT_TOKEN/,
  );
  assert.equal(requested, false);
});

test('rejects non-HTTPS webhook URLs before making a request', async () => {
  let requested = false;
  await assert.rejects(
    configureTelegram({ ...config, webhookUrl: 'http://bot.example/webhook', fetchImpl: async () => { requested = true; } }),
    /must use HTTPS/,
  );
  assert.equal(requested, false);
});

test('rejects invalid webhook secrets before making a request', async () => {
  let requested = false;
  await assert.rejects(
    configureTelegram({ ...config, webhookSecret: 'contains spaces', fetchImpl: async () => { requested = true; } }),
    /must contain only letters/,
  );
  assert.equal(requested, false);
});

test('stops and reports Telegram API errors without exposing the bot token', async () => {
  let calls = 0;
  const failingFetch = async () => {
    calls += 1;
    return { ok: false, json: async () => ({ ok: false, description: 'webhook rejected' }) };
  };
  await assert.rejects(
    configureTelegram({ ...config, fetchImpl: failingFetch }),
    (error) => error.message.includes('webhook rejected') && !error.message.includes(config.token),
  );
  assert.equal(calls, 1);
});
