import { useEffect, useState } from 'react';

/** Trading preferences from Settings, used by the trade card and bridge. */
export interface Preferences {
  /** Default "pay with" chain for buys; null = the token's own chain. */
  defaultFundingChainId: number | null;
  slippagePercent: number;
  /** Browser notification when a trade or bridge completes. */
  notifications: boolean;
}

const KEY = 'hopr-preferences-v1';
const DEFAULTS: Preferences = { defaultFundingChainId: null, slippagePercent: 1, notifications: false };
const listeners = new Set<(prefs: Preferences) => void>();

export function getPreferences(): Preferences {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Preferences>) };
  } catch {
    return DEFAULTS;
  }
}

export function setPreferences(patch: Partial<Preferences>) {
  const next = { ...getPreferences(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Keep working for this session.
  }
  listeners.forEach((listener) => listener(next));
}

export function usePreferences(): [Preferences, (patch: Partial<Preferences>) => void] {
  const [prefs, setPrefs] = useState(getPreferences);
  useEffect(() => {
    listeners.add(setPrefs);
    return () => { listeners.delete(setPrefs); };
  }, []);
  return [prefs, setPreferences];
}

/** Show a system notification if the user enabled them (no-op otherwise). */
export function notify(title: string, body: string) {
  if (!getPreferences().notifications || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: '/brand/logo-icon.png' });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}
