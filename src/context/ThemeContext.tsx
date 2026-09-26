import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { flushSync } from 'react-dom';

type Theme = 'dark' | 'light';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleThemeAt: (x: number, y: number) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const saved = localStorage.getItem('hopr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.setAttribute('data-theme', theme);
    localStorage.setItem('hopr-theme', theme);
  }, [theme]);

  const toggleTheme = () => setThemeState(prev => prev === 'dark' ? 'light' : 'dark');
  const setTheme = (t: Theme) => setThemeState(t);

  const toggleThemeAt = (x: number, y: number) => {
    const next = themeRef.current === 'dark' ? 'light' : 'dark';
    const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!doc.startViewTransition || reduceMotion) {
      setThemeState(next);
      return;
    }

    const root = document.documentElement;
    root.style.setProperty('--theme-reveal-x', `${x}px`);
    root.style.setProperty('--theme-reveal-y', `${y}px`);
    const transition = doc.startViewTransition(() => flushSync(() => setThemeState(next)));
    transition.ready.then(() => {
      const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 260, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
      );
    }).catch(() => undefined);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, toggleThemeAt }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
