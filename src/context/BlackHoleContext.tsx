import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'hopr-black-hole-settings';
const DEFAULT_SETTINGS: BlackHoleSettings = { spin: 0.7, inclination: 65 };

export interface BlackHoleSettings {
  /** Dimensionless Kerr spin a*, clamped below the extremal limit. */
  spin: number;
  /** Viewing inclination from the spin axis in degrees. */
  inclination: number;
}

interface BlackHoleContextValue {
  settings: BlackHoleSettings;
  setSpin: (spin: number) => void;
  setInclination: (inclination: number) => void;
}

const BlackHoleContext = createContext<BlackHoleContextValue | undefined>(undefined);

function readSettings(): BlackHoleSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<BlackHoleSettings> | null;
    return {
      spin: typeof saved?.spin === 'number' && Number.isFinite(saved.spin)
        ? Math.min(0.998, Math.max(0, saved.spin))
        : DEFAULT_SETTINGS.spin,
      inclination: typeof saved?.inclination === 'number' && Number.isFinite(saved.inclination)
        ? Math.min(90, Math.max(0, saved.inclination))
        : DEFAULT_SETTINGS.inclination,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function BlackHoleSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<BlackHoleSettings>(readSettings);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Keep the controls usable if storage is blocked or unavailable.
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [settings]);

  const setSpin = useCallback((spin: number) => {
    setSettings((current) => ({ ...current, spin: Math.min(0.998, Math.max(0, spin)) }));
  }, []);
  const setInclination = useCallback((inclination: number) => {
    setSettings((current) => ({ ...current, inclination: Math.min(90, Math.max(0, inclination)) }));
  }, []);
  const value = useMemo(() => ({ settings, setSpin, setInclination }), [settings, setSpin, setInclination]);

  return <BlackHoleContext.Provider value={value}>{children}</BlackHoleContext.Provider>;
}

export function useBlackHoleSettings() {
  const context = useContext(BlackHoleContext);
  if (!context) throw new Error('useBlackHoleSettings must be used within BlackHoleSettingsProvider');
  return context;
}
