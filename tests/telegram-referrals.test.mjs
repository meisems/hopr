import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../workers/index.ts';

const env = () => ({
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_WEBHOOK_SECRET: 'test-secret',
  TELEGRAM_BOT_USERNAME: 'HoprBot',
  PUBLIC_APP_URL: 'https://hopr.app',
  DB: createD1(),
});

const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** D1 over in-memory SQLite with every migration applied, in order. */
function createD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      const statement = db.prepare(sql);
      const run = (args) => ({
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
      });
      return { ...run([]), bind: (...params) => run(params.map((value) => (value === undefined ? null : value))) };
    },
  };
}

async function send(update, workerEnv) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('api.telegram.org')) {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
      body: JSON.stringify(update),
    }), workerEnv, {});
    assert.equal(response.status, 200);
    return calls;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const message = (chatId, text, type = 'private') => ({ message: { chat: { id: chatId, type }, from: { first_name: 'Sam' }, text } });

test('/referral shows the Telegram invite link, web link and earnings; /start ref_<code> links the friend', async () => {
  const workerEnv = env();
  const panel = await send(message(100, '/referral'), workerEnv);
  const text = plain(panel.at(-1).body.text);
  const code = text.match(/Code  ([a-z0-9]{8})/)[1];
  assert.match(text, new RegExp(`Telegram  https://t\\.me/HoprBot\\?start=ref_${code}`));
  assert.match(text, new RegExp(`Web  https://hopr\\.app/\\?ref=${code}`));
  assert.match(text, /Earn 25% of HOPR fee revenue after the routing provider's share/);
  assert.match(text, /Friends  0/);
  const buttons = panel.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.match(buttons.find((button) => button.text === '📤 Share invite').url, /t\.me\/share\/url/);
  assert.ok(!buttons.some((button) => button.callback_data === 'referral:claim'), 'no claim button below the minimum');

  // The same code every time (bot and Mini App share the tg:<id> identity).
  const again = plain((await send(message(100, '/referral'), workerEnv)).at(-1).body.text);
  assert.match(again, new RegExp(`Code  ${code}`));

  const welcome = await send(message(200, `/start ref_${code}`), workerEnv);
  assert.match(plain(welcome.at(-1).body.text), /Invite accepted/);
  const binding = workerEnv.DB.raw.prepare('SELECT code, telegram_user_id FROM referral_bindings WHERE wallet = ?').get('tg:200');
  assert.deepEqual({ ...binding }, { code, telegram_user_id: '200' });

  // A second invite, or the referrer's own link, does not change anything.
  const self = await send(message(100, `/start ref_${code}`), workerEnv);
  assert.doesNotMatch(plain(self.at(-1).body.text), /Invite accepted/);

  const updated = plain((await send(message(100, '/referral'), workerEnv)).at(-1).body.text);
  assert.match(updated, /Friends  1/);
});

test('/referral stays private in groups and the menu has a Refer & Earn button', async () => {
  const workerEnv = env();
  const group = await send(message(-5, '/referral', 'group'), workerEnv);
  assert.match(plain(group.at(-1).body.text), /private chat/);
  const menu = await send(message(300, '/menu'), workerEnv);
  assert.ok(menu.at(-1).body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'referral'));
});
