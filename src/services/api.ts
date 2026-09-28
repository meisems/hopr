const configuredApiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const API_BASE_URL = configuredApiUrl.replace(/\/$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

/** Public link to the Telegram bot (e.g. https://t.me/HoprBot). Links to it are hidden when unset. */
export const TELEGRAM_BOT_URL = ((import.meta.env.VITE_TELEGRAM_BOT_URL as string | undefined) ?? '').trim();
