import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowDown, Zap, Clock, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';
import { SUPPORTED_CHAINS } from '../services/chainDetector';
import { mockWalletBalances } from '../data/mockData';
import ChainLogo from './ChainLogo';
import ThemeToggle from './ThemeToggle';

interface BridgePageProps {
  onBack: () => void;
}

export default function BridgePage({ onBack }: BridgePageProps) {
  const [fromChain, setFromChain] = useState(SUPPORTED_CHAINS[0]);
  const [toChain, setToChain] = useState(SUPPORTED_CHAINS[2]);
  const [amount, setAmount] = useState('1.0');

  const fromBalance = mockWalletBalances.find((b) => b.chainId === fromChain.id);
  const numericAmount = parseFloat(amount) || 0;
  const estFee = useMemo(() => Math.max(0.15, numericAmount * 0.003), [numericAmount]);
  const estReceive = Math.max(0, numericAmount - estFee);
  const estTime = fromChain.type === 'SVM' || toChain.type === 'SVM' ? '~35s' : '~20s';

  const swapDirection = () => {
    setFromChain(toChain);
    setToChain(fromChain);
  };

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur-xl safe-area-top">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
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
                <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-brand-400" />
                <h1 className="text-base sm:text-lg font-semibold text-white">Bridge</h1>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        <div className="max-w-md mx-auto bg-gray-900/60 rounded-2xl border border-gray-800/50 p-5 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Bridge preview</h2>
            <p className="text-xs text-gray-500 mt-0.5">Illustrative route only; no live quote or transfer is available.</p>
          </div>

          {/* From */}
          <div className="bg-gray-800/30 rounded-xl border border-gray-800/40 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>From</span>
              {fromBalance && <span>Balance: {fromBalance.balance.toLocaleString()} {fromBalance.nativeSymbol}</span>}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={fromChain.id}
                onChange={(e) => setFromChain(SUPPORTED_CHAINS.find((c) => c.id === Number(e.target.value))!)}
                className="flex-shrink-0 flex items-center gap-2 bg-gray-900/60 border border-gray-700/40 rounded-lg pl-2 pr-1 py-2 text-sm text-white appearance-none"
              >
                {SUPPORTED_CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1 min-w-0 bg-transparent text-right text-lg font-semibold text-white focus:outline-none"
                placeholder="0.0"
              />
            </div>
          </div>

          {/* Swap direction */}
          <div className="flex justify-center -my-1">
            <button
              onClick={swapDirection}
              className="w-8 h-8 rounded-full bg-gray-800 border border-gray-700/50 flex items-center justify-center hover:bg-gray-700 hover:rotate-180 transition-all duration-300"
              aria-label="Swap direction"
            >
              <ArrowDown className="w-4 h-4 text-brand-400" />
            </button>
          </div>

          {/* To */}
          <div className="bg-gray-800/30 rounded-xl border border-gray-800/40 p-3 space-y-2">
            <div className="text-xs text-gray-500">To</div>
            <div className="flex items-center gap-2">
              <select
                value={toChain.id}
                onChange={(e) => setToChain(SUPPORTED_CHAINS.find((c) => c.id === Number(e.target.value))!)}
                className="flex-shrink-0 flex items-center gap-2 bg-gray-900/60 border border-gray-700/40 rounded-lg pl-2 pr-1 py-2 text-sm text-white appearance-none"
              >
                {SUPPORTED_CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <div className="flex-1 text-right text-lg font-semibold text-gray-300">
                ≈ {estReceive.toFixed(4)}
              </div>
            </div>
          </div>

          {/* Chain badges row for a clearer visual of the route */}
          <div className="flex items-center justify-center gap-3 py-1">
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-800/40 rounded-full">
              <ChainLogo chainKey={fromChain.key} size={16} />
              <span className="text-xs text-gray-300">{fromChain.name}</span>
            </div>
            <ArrowDown className="w-3.5 h-3.5 text-gray-600 -rotate-90" />
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-800/40 rounded-full">
              <ChainLogo chainKey={toChain.key} size={16} />
              <span className="text-xs text-gray-300">{toChain.name}</span>
            </div>
          </div>

          {/* Illustrative fee / time placeholders */}
          <div className="space-y-1.5 text-xs text-gray-400 border-t border-gray-800/40 pt-3">
            <div className="flex justify-between"><span>Illustrative fee (not quoted)</span><span className="text-gray-300">≈ {estFee.toFixed(4)}</span></div>
            <div className="flex justify-between items-center"><span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Placeholder time</span><span className="text-gray-300">{estTime}</span></div>
          </div>

          <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm text-amber-100/90" role="status">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" />
            <span>Bridge execution is not implemented. No wallet was signed and no transaction was sent.</span>
          </div>
        </div>
      </main>
    </div>
  );
}
