import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowDown, Zap, Clock, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { SUPPORTED_CHAINS } from '../services/chainDetector';
import { mockWalletBalances } from '../data/mockData';
import ChainLogo from './ChainLogo';
import ThemeToggle from './ThemeToggle';

const EVM_NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
const SOL_NATIVE_TOKEN = 'So11111111111111111111111111111111111111112';
const EVM_QUOTE_ADDRESS = '0x1111111111111111111111111111111111111111';
const SOL_QUOTE_ADDRESS = '11111111111111111111111111111111';

type LiveQuote = {
  estimate?: {
    toAmount?: string;
    toAmountMin?: string;
    executionDuration?: number;
    gasCosts?: Array<{ amountUSD?: string }>;
  };
};

function formatTokenAmount(raw: string | undefined, decimals: number) {
  if (!raw) return '—';
  try {
    const value = Number(raw) / (10 ** decimals);
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—';
  } catch {
    return '—';
  }
}

interface BridgePageProps {
  onBack: () => void;
}

export default function BridgePage({ onBack }: BridgePageProps) {
  const [fromChain, setFromChain] = useState(SUPPORTED_CHAINS[0]);
  const [toChain, setToChain] = useState(SUPPORTED_CHAINS[2]);
  const [amount, setAmount] = useState('1.0');
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [quoteError, setQuoteError] = useState('');

  const fromBalance = mockWalletBalances.find((b) => b.chainId === fromChain.id);
  const numericAmount = parseFloat(amount) || 0;

  useEffect(() => {
    if (numericAmount <= 0 || fromChain.id === toChain.id) {
      setQuote(null);
      setQuoteStatus('idle');
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setQuoteStatus('loading');
      setQuoteError('');
      try {
        const decimals = fromChain.type === 'SVM' ? 9 : 18;
        const fromAmount = BigInt(Math.round(numericAmount * (10 ** decimals))).toString();
        const params = new URLSearchParams({
          fromChain: String(fromChain.id),
          toChain: String(toChain.id),
          fromToken: fromChain.type === 'SVM' ? SOL_NATIVE_TOKEN : EVM_NATIVE_TOKEN,
          toToken: toChain.type === 'SVM' ? SOL_NATIVE_TOKEN : EVM_NATIVE_TOKEN,
          fromAmount,
          fromAddress: fromChain.type === 'SVM' ? SOL_QUOTE_ADDRESS : EVM_QUOTE_ADDRESS,
          toAddress: toChain.type === 'SVM' ? SOL_QUOTE_ADDRESS : EVM_QUOTE_ADDRESS,
          slippage: '0.03',
        });
        const response = await fetch(`https://li.quest/v1/quote?${params.toString()}`, { signal: controller.signal });
        const data = await response.json() as LiveQuote & { message?: string };
        if (!response.ok || !data.estimate?.toAmount) throw new Error(data.message ?? 'LI.FI did not return a route.');
        setQuote(data);
        setQuoteStatus('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setQuote(null);
        setQuoteStatus('error');
        setQuoteError(error instanceof Error ? error.message : 'Unable to fetch a live bridge quote.');
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fromChain.id, fromChain.type, numericAmount, toChain.id]);

  const receiveAmount = formatTokenAmount(quote?.estimate?.toAmount, toChain.type === 'SVM' ? 9 : 18);
  const minimumAmount = formatTokenAmount(quote?.estimate?.toAmountMin, toChain.type === 'SVM' ? 9 : 18);
  const gasCost = quote?.estimate?.gasCosts?.reduce((sum, item) => sum + Number(item.amountUSD ?? 0), 0) ?? 0;
  const executionTime = quote?.estimate?.executionDuration ? `${Math.max(1, Math.round(quote.estimate.executionDuration / 60))} min` : 'Variable';

  const swapDirection = () => {
    setFromChain(toChain);
    setToChain(fromChain);
  };

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      {/* Header */}
      <header className="navbar-dark sticky top-0 z-40 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur-xl safe-area-top">
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
            <h2 className="text-lg font-semibold text-white">Live bridge quote</h2>
            <p className="text-xs text-gray-500 mt-0.5">Read-only LI.FI route estimate. No wallet connection or transaction submission happens here.</p>
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
                {quoteStatus === 'loading' ? <Loader2 className="w-5 h-5 ml-auto animate-spin text-brand-400" /> : `≈ ${receiveAmount}`}
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

          {/* Live route details */}
          <div className="space-y-1.5 text-xs text-gray-400 border-t border-gray-800/40 pt-3">
            <div className="flex justify-between gap-3"><span>Minimum received</span><span className="text-gray-300">{minimumAmount} {toChain.nativeSymbol}</span></div>
            <div className="flex justify-between items-center"><span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Estimated time</span><span className="text-gray-300">{executionTime}</span></div>
            <div className="flex justify-between"><span>Estimated gas</span><span className="text-gray-300">{gasCost > 0 ? `$${gasCost.toFixed(4)}` : 'Included in route'}</span></div>
          </div>

          <div className={`flex items-start gap-2 p-3 rounded-xl text-sm leading-relaxed ${quoteStatus === 'error' ? 'bg-red-500/10 border border-red-500/25 text-red-200' : 'bg-amber-500/10 border border-amber-500/25 text-amber-100'}`} role="status" aria-live="polite">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" />
            <span>{quoteStatus === 'error' ? quoteError : 'This is a live quote only. Hopr does not sign, submit, or move funds from the Bridge page.'}</span>
          </div>
          {quoteStatus === 'ready' && <div className="flex items-center gap-2 text-xs text-green-300"><RefreshCw className="w-3.5 h-3.5" /> Quote refreshed from LI.FI for the current route.</div>}
        </div>
      </main>
    </div>
  );
}
