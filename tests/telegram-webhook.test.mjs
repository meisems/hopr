import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const workerSource = await readFile(new URL('../workers/index.ts', import.meta.url), 'utf8');
const workerJavaScript = ts.transpileModule(workerSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(workerJavaScript).toString('base64')}`);
const worker = workerModule.default;
const env = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret' };

async function sendUpdate(update, { method = 'POST', secret = env.TELEGRAM_WEBHOOK_SECRET } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: true });
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method,
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
      body: method === 'POST' ? JSON.stringify(update) : undefined,
    }), env, {});
    return { response, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('help command sends available commands and inline navigation buttons', async () => {
  const { response, calls } = await sendUpdate({
    message: { chat: { id: 321 }, text: '/help@HoprBot' },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/sendMessage'), true);
  assert.equal(calls[0].body.chat_id, 321);
  assert.match(calls[0].body.text, /not connected to this Telegram bot yet/);
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, [
    [
      { text: 'Wallet', callback_data: 'wallet' },
      { text: 'Settings', callback_data: 'settings' },
    ],
    [{ text: 'Help', callback_data: 'help' }],
  ]);
});

test('inline Settings button is answered and routed to the settings command response', async () => {
  const { response, calls } = await sendUpdate({
    callback_query: {
      id: 'callback-1',
      data: 'settings',
      message: { chat: { id: 456 } },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), [
    'answerCallbackQuery', 'sendMessage',
  ]);
  assert.deepEqual(calls[0].body, { callback_query_id: 'callback-1' });
  assert.match(calls[1].body.text, /trading settings are not connected yet/);
});

test('rejects an incorrect webhook secret without calling Telegram', async () => {
  const { response, calls } = await sendUpdate(
    { message: { chat: { id: 321 }, text: '/start' } },
    { secret: 'wrong-secret' },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test('rejects non-POST webhook methods', async () => {
  const { response, calls } = await sendUpdate({}, { method: 'GET' });
  assert.equal(response.status, 405);
  assert.deepEqual(calls, []);
});

test('ignores unknown inline callback actions safely', async () => {
  const { response, calls } = await sendUpdate({
    callback_query: {
      id: 'callback-2',
      data: 'trade:buy',
      message: { chat: { id: 789 } },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/answerCallbackQuery'), true);
  assert.equal(calls[0].body.show_alert, true);
  assert.equal(calls[0].body.text, 'This button is no longer available.');
});
