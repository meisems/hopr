import { ArrowLeft, Coins } from 'lucide-react';
import PositionsTable from './PositionsTable';
import ThemeToggle from './ThemeToggle';

interface PositionsPageProps {
  onBack: () => void;
}

export default function PositionsPage({ onBack }: PositionsPageProps) {
  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Header */}
      <header className="navbar-dark sticky top-0 z-40 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur-xl safe-area-top">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2 sm:gap-4">
              <button
                onClick={onBack}
                className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-2 text-xs sm:text-sm text-gray-400 hover:text-white hover:bg-gray-800/50 rounded-lg transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Back to Dashboard</span>
              </button>
              <div className="h-6 w-px bg-gray-800 hidden sm:block" />
              <div className="flex items-center gap-2">
                <Coins className="w-4 h-4 sm:w-5 sm:h-5 text-brand-400" />
                <h1 className="text-base sm:text-lg font-semibold text-white">Positions</h1>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <PositionsTable />
      </main>
    </div>
  );
}
