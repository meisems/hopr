/** Vite build-time variables (empty outside Vite, e.g. in Node tests). */
const viteEnv = (import.meta.env ?? {}) as Record<string, string | undefined>;
const configuredApiUrl = viteEnv.VITE_API_URL ?? '';

export const API_BASE_URL = configuredApiUrl.replace(/\/$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

/** Public link to the Telegram bot (e.g. https://t.me/HoprBot). Links to it are hidden when unset. */
export const TELEGRAM_BOT_URL = (viteEnv.VITE_TELEGRAM_BOT_URL ?? '').trim();

export { viteEnv };
