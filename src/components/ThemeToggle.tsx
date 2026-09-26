import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '../context/ThemeContext';

type BlackHoleOrigin = { x: number; y: number };

export default function ThemeToggle() {
  const { theme, toggleThemeAt } = useTheme();
  const [blackHole, setBlackHole] = useState<BlackHoleOrigin | null>(null);
  const isDark = theme === 'dark';

  const handleToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (blackHole) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    setBlackHole(origin);
    toggleThemeAt(origin.x, origin.y);
    window.setTimeout(() => setBlackHole(null), 720);
  };

  return (
    <>
      <button
        onClick={handleToggle}
        disabled={Boolean(blackHole)}
        className="relative z-[110] w-14 h-7 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 dark:from-slate-700 dark:to-slate-900 transition-all duration-150 hover:scale-105 active:scale-95 disabled:cursor-wait"
        aria-label="Toggle theme"
        aria-busy={Boolean(blackHole)}
      >
        <motion.div
          className="absolute top-1 w-5 h-5 rounded-full bg-white shadow-lg flex items-center justify-center"
          animate={{ x: isDark ? 4 : 32, rotate: isDark ? 0 : 360 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        >
          {isDark ? (
            <svg className="w-3 h-3 text-slate-800" fill="currentColor" viewBox="0 0 20 20"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" /></svg>
          ) : (
            <svg className="w-3 h-3 text-yellow-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" /></svg>
          )}
        </motion.div>

        <div className="absolute inset-0 overflow-hidden rounded-full">
          {[0, 1, 2].map((i) => <motion.div key={i} className="absolute w-0.5 h-0.5 bg-white rounded-full" style={{ top: `${20 + i * 25}%`, left: `${15 + i * 20}%` }} animate={{ opacity: isDark ? [0, 1, 0] : 0, scale: isDark ? [0.5, 1, 0.5] : 0.5 }} transition={{ duration: 2, repeat: Infinity, delay: i * 0.3 }} />)}
        </div>
      </button>

      <AnimatePresence>
        {blackHole && (
          <motion.div key="theme-black-hole" className="fixed inset-0 z-[100] pointer-events-none overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 1, 0] }} transition={{ duration: 0.72, times: [0, 0.12, 0.72, 1], ease: 'easeInOut' }}>
            <motion.div className="absolute rounded-full" style={{ left: blackHole.x, top: blackHole.y, width: '18vmin', height: '18vmin', x: '-50%', y: '-50%', background: 'radial-gradient(circle, #000 0 34%, rgba(0,0,0,0.98) 38%, rgba(63,176,170,0.7) 48%, rgba(39,117,119,0.18) 66%, transparent 72%)', boxShadow: '0 0 80px 20px rgba(63,176,170,0.35)' }} initial={{ scale: 0.1, rotate: 0 }} animate={{ scale: [0.1, 0.8, 1.05, 2.8], rotate: 360 }} transition={{ duration: 0.72, times: [0, 0.18, 0.48, 1], ease: 'easeIn' }} />
            {[0, 1].map((ring) => <motion.div key={ring} className="absolute rounded-full border pointer-events-none" style={{ left: blackHole.x, top: blackHole.y, width: `${22 + ring * 8}vmin`, height: `${8 + ring * 3}vmin`, x: '-50%', y: '-50%', borderColor: ring === 0 ? 'rgba(114,210,203,0.85)' : 'rgba(63,176,170,0.45)', borderWidth: ring === 0 ? 2 : 1, rotate: ring === 0 ? -12 : 12 }} initial={{ scale: 0.15, opacity: 0 }} animate={{ scale: [0.15, 1, 2.3], opacity: [0, 0.9, 0] }} transition={{ duration: 0.62, delay: ring * 0.04, ease: 'easeOut' }} />)}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
