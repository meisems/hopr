import { useId, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Monitor, Moon, Sun } from 'lucide-react';
import { ThemePreference, useTheme } from '../context/ThemeContext';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
];

interface ThemeToggleProps {
  /** `lg` shows text labels; used on the Settings page. */
  size?: 'sm' | 'lg';
}

/**
 * Three-way appearance switch. "System" tracks the OS setting live; the
 * other two pin a theme. The new theme is
 * revealed from the clicked segment via a View Transition where supported.
 */
export default function ThemeToggle({ size = 'sm' }: ThemeToggleProps) {
  const { preference, theme, setPreference } = useTheme();
  const pillId = useId();
  const large = size === 'lg';

  const [blackHole, setBlackHole] = useState<{ x: number; y: number; key: number } | null>(null);

  const choose = (value: ThemePreference, event: React.MouseEvent<HTMLButtonElement>) => {
    if (value === preference) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    // The black-hole flourish is decorative only: it never blocks further input.
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setBlackHole({ ...origin, key: Date.now() });
    setPreference(value, origin);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = OPTIONS.findIndex((option) => option.value === preference);
    const next = OPTIONS[(index + (event.key === 'ArrowRight' ? 1 : OPTIONS.length - 1)) % OPTIONS.length];
    setPreference(next.value);
    (event.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLButtonElement | null)?.focus();
  };

  return (
    <>
    <div
      role="radiogroup"
      aria-label={`Appearance (currently ${theme})`}
      onKeyDown={onKeyDown}
      className={`theme-toggle relative inline-flex items-center rounded-full border border-gray-800/80 bg-gray-900/70 p-0.5 backdrop-blur ${large ? 'w-full gap-1 sm:w-auto' : ''}`}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={value === 'system' ? `System (${theme})` : label}
            tabIndex={active ? 0 : -1}
            data-value={value}
            onClick={(event) => choose(value, event)}
            className={`relative z-0 inline-flex items-center justify-center gap-1.5 rounded-full font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-brand-400/60 ${
              large ? 'h-9 flex-1 px-2.5 text-sm sm:flex-none sm:px-3.5' : 'h-7 w-7'
            } ${active ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                className="absolute inset-0 -z-10 rounded-full border border-gray-700/70 bg-gray-800 shadow-sm"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <Icon className={large ? 'hidden h-4 w-4 min-[400px]:block' : 'h-3.5 w-3.5'} strokeWidth={2.2} />
            {large && <span>{label}</span>}
          </button>
        );
      })}
    </div>

    <AnimatePresence>
      {blackHole && (
        <motion.div
          key={blackHole.key}
          aria-hidden
          className="fixed inset-0 z-[100] pointer-events-none overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 0.6, times: [0, 0.12, 0.7, 1], ease: 'easeInOut' }}
          onAnimationComplete={() => setBlackHole((current) => (current?.key === blackHole.key ? null : current))}
        >
          <motion.div
            className="absolute rounded-full"
            style={{ left: blackHole.x, top: blackHole.y, width: '14vmin', height: '14vmin', x: '-50%', y: '-50%', background: 'radial-gradient(circle, #000 0 34%, rgba(0,0,0,0.96) 38%, rgba(124,92,250,0.7) 48%, rgba(84,51,204,0.18) 66%, transparent 72%)', boxShadow: '0 0 60px 16px rgba(124,92,250,0.3)' }}
            initial={{ scale: 0.1, rotate: 0 }}
            animate={{ scale: [0.1, 0.8, 1, 2.4], rotate: 300, opacity: [1, 1, 1, 0] }}
            transition={{ duration: 0.6, times: [0, 0.2, 0.5, 1], ease: 'easeIn' }}
          />
          {[0, 1].map((ring) => (
            <motion.div
              key={ring}
              className="absolute rounded-full border"
              style={{ left: blackHole.x, top: blackHole.y, width: `${18 + ring * 8}vmin`, height: `${6 + ring * 3}vmin`, x: '-50%', y: '-50%', borderColor: ring === 0 ? 'rgba(183,163,255,0.85)' : 'rgba(62,240,200,0.45)', borderWidth: ring === 0 ? 2 : 1, rotate: ring === 0 ? -12 : 12 }}
              initial={{ scale: 0.15, opacity: 0 }}
              animate={{ scale: [0.15, 1, 2.2], opacity: [0, 0.9, 0] }}
              transition={{ duration: 0.55, delay: ring * 0.04, ease: 'easeOut' }}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
}
