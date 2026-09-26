import test from 'node:test';
import assert from 'node:assert/strict';
import { configureTelegram, TELEGRAM_COMMANDS } from '../scripts/configure-telegram.mjs';

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
    'setWebhook', 'setMyCommands', 'setChatMenuButton',
  ]);
  assert.deepEqual(calls[0].body, {
    url: config.webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ['message', 'callback_query'],
  });
  assert.deepEqual(calls[1].body, TELEGRAM_COMMANDS);
  assert.deepEqual(calls[2].body, { menu_button: { type: 'commands' } });
  assert.deepEqual(result.commands, ['start', 'help', 'wallet', 'settings']);
  assert.equal(calls[0].url.includes(config.token), true);
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
