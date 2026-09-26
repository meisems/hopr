import { motion } from 'framer-motion';
import { useTheme } from '../context/ThemeContext';

export default function ThemeToggle() {
  const { theme, toggleThemeAt } = useTheme();
  const isDark = theme === 'dark';

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    toggleThemeAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  return (
    <button
      onClick={handleClick}
      className="relative w-14 h-7 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 dark:from-slate-700 dark:to-slate-900 transition-all duration-300 hover:scale-105 active:scale-95"
      aria-label="Toggle theme"
    >
      <motion.div
        className="absolute top-1 w-5 h-5 rounded-full bg-white shadow-lg flex items-center justify-center"
        animate={{
          x: isDark ? 4 : 32,
          rotate: isDark ? 0 : 360,
        }}
        transition={{
          type: 'spring',
          stiffness: 500,
          damping: 30,
        }}
      >
        {isDark ? (
          <svg className="w-3 h-3 text-slate-800" fill="currentColor" viewBox="0 0 20 20">
            <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
          </svg>
        ) : (
          <svg className="w-3 h-3 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
          </svg>
        )}
      </motion.div>
      
      {/* Background stars for dark mode */}
      <div className="absolute inset-0 overflow-hidden rounded-full">
        {[...Array(3)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-0.5 h-0.5 bg-white rounded-full"
            style={{
              top: `${20 + i * 25}%`,
              left: `${15 + i * 20}%`,
            }}
            animate={{
              opacity: isDark ? [0, 1, 0] : 0,
              scale: isDark ? [0.5, 1, 0.5] : 0.5,
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              delay: i * 0.3,
            }}
          />
        ))}
      </div>
    </button>
  );
}
