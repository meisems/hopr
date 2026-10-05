import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { flushSync } from 'react-dom';

export type ResolvedTheme = 'dark' | 'light';
/** `system` follows the OS and reacts live to changes. */
export type ThemePreference = ResolvedTheme | 'system';

interface ThemeContextType {
  /** The theme actually painted right now. */
  theme: ResolvedTheme;
  /** What the user picked. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference, origin?: { x: number; y: number }) => void;
  toggleTheme: () => void;
  setTheme: (theme: ResolvedTheme) => void;
  toggleThemeAt: (x: number, y: number) => void;
}

// New key: the old 'hopr-theme' value was written automatically, so it does not reflect a real choice.
const STORAGE_KEY = 'hopr-theme-preference';
const THEME_COLORS: Record<ResolvedTheme, string> = { dark: '#08080d', light: '#f6f6fa' };
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // Storage can be blocked (private mode, sandboxed iframes).
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

function paint(theme: ResolvedTheme, preference: ThemePreference) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-preference', preference);
  root.style.colorScheme = theme;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = THEME_COLORS[theme];
  });
}

/** Browsers without View Transitions get a short, global colour cross-fade instead. */
function crossFade() {
  const root = document.documentElement;
  root.classList.add('theme-fading');
  window.setTimeout(() => root.classList.remove('theme-fading'), 320);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [theme, setThemeState] = useState<ResolvedTheme>(() => resolve(readPreference()));
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const preferenceRef = useRef(preference);
  preferenceRef.current = preference;

  useEffect(() => {
    paint(theme, preference);
  }, [theme, preference]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Keep theme switching usable if storage is blocked.
    }
  }, [preference]);

  // Stay in sync with the OS / Telegram while in system mode, and with other tabs.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onSystemChange = () => {
      if (preferenceRef.current !== 'system') return;
      const next = systemTheme();
      if (next === themeRef.current) return;
      crossFade();
      setThemeState(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const value = event.newValue;
      if (value !== 'light' && value !== 'dark' && value !== 'system') return;
      crossFade();
      setPreferenceState(value);
      setThemeState(resolve(value));
    };
    media.addEventListener('change', onSystemChange);
    window.addEventListener('storage', onStorage);
    return () => {
      media.removeEventListener('change', onSystemChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference, origin?: { x: number; y: number }) => {
    const nextTheme = resolve(next);
    const apply = () => {
      setPreferenceState(next);
      setThemeState(nextTheme);
    };
    if (nextTheme === themeRef.current) {
      apply();
      return;
    }

    const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || reduceMotion) {
      if (!reduceMotion) crossFade();
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth - 48;
    const y = origin?.y ?? 32;
    const transition = doc.startViewTransition(() => flushSync(apply));
    transition.ready.then(() => {
      const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    }).catch(() => undefined);
  }, []);

  const toggleThemeAt = useCallback((x: number, y: number) => {
    setPreference(themeRef.current === 'dark' ? 'light' : 'dark', { x, y });
  }, [setPreference]);

  const value = useMemo<ThemeContextType>(() => ({
    theme,
    preference,
    setPreference,
    toggleTheme: () => setPreference(themeRef.current === 'dark' ? 'light' : 'dark'),
    setTheme: (next) => setPreference(next),
    toggleThemeAt,
  }), [theme, preference, setPreference, toggleThemeAt]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
