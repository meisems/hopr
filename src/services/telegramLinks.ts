// Trading lives in the Telegram bot. The website is a read-only viewer, and
// its trade buttons hand the token over to the bot through a t.me deep link.

import { useEffect, useState } from 'react';
import { API_BASE_URL, apiUrl, TELEGRAM_BOT_URL } from './api';

let botUrlLookup: Promise<string> | null = null;

/** VITE_TELEGRAM_BOT_URL, else the bot username the worker reports in /api/config. */
function resolveBotUrl(): Promise<string> {
  if (TELEGRAM_BOT_URL) return Promise.resolve(TELEGRAM_BOT_URL.replace(/\/$/, ''));
  if (!API_BASE_URL) return Promise.resolve('');
  botUrlLookup ??= fetch(apiUrl('/api/config'))
    .then((response) => (response.ok ? response.json() : null))
    .then((config: { telegramBot?: string | null } | null) => (config?.telegramBot ? `https://t.me/${config.telegramBot}` : ''))
    .catch(() => '');
  return botUrlLookup;
}

/** Public bot link, or '' while unknown / not configured. */
export function useTelegramBotUrl(): string {
  const [url, setUrl] = useState(TELEGRAM_BOT_URL.replace(/\/$/, ''));
  useEffect(() => {
    if (url) return;
    let cancelled = false;
    void resolveBotUrl().then((resolved) => !cancelled && setUrl(resolved));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return url;
}

/**
 * Link that opens the bot on this token's trading panel. Telegram start
 * payloads allow only [A-Za-z0-9_-] (64 chars), so NEAR ids like
 * `token.near` fall back to the plain bot link.
 */
export function telegramTokenLink(botUrl: string, address?: string): { url: string; direct: boolean } {
  if (!botUrl) return { url: '', direct: false };
  const payload = address ? `t_${address}` : '';
  return payload && /^[A-Za-z0-9_-]{1,64}$/.test(payload)
    ? { url: `${botUrl}?start=${payload}`, direct: true }
    : { url: botUrl, direct: false };
}
