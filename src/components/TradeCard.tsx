import { useState } from 'react';
import { ArrowDownUp, Settings, Zap, Shield, AlertTriangle, CheckCircle2, Loader2, Rocket, TrendingDown, Pencil, XCircle, BarChart3 } from 'lucide-react';
import { DetectedToken, formatUsd, SUPPORTED_CHAINS } from '../services/chainDetector';
import { mockWalletBalances } from '../data/mockData';
import ChainLogo from './ChainLogo';
import { motion, AnimatePresence } from 'framer-motion';

interface TradeCardProps {
  token: DetectedToken | null;
}

type TradeMode = 'buy' | 'sell';
type TradeStatus = 'idle' | 'approving' | 'swapping' | 'bridging' | 'delivering' | 'complete' | 'error';

const BUY_PRESETS = [0.1, 0.5, 1.0, 2.0];
const SELL_PRESETS = [25, 50, 75, 100];

export default function TradeCard({ token }: TradeCardProps) {
  const [mode, setMode] = useState<TradeMode>('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(3);
  const [showSettings, setShowSettings] = useState(false);
  const [fundingChain, setFundingChain] = useState(SUPPORTED_CHAINS[0]);
  const [tradeStatus, setTradeStatus] = useState<TradeStatus>('idle');
  const [customAmount, setCustomAmount] = useState('');

  const userBalance = mockWalletBalances.find(b => b.chainId === fundingChain.id);

  const handleBuy = async (presetAmount?: number) => {
    const buyAmount = presetAmount ?? parseFloat(amount);
    if (!buyAmount || !token) return;
    
    setTradeStatus('approving');
    await new Promise(r => setTimeout(r, 1200));
    setTradeStatus('swapping');
    await new Promise(r => setTimeout(r, 1500));
    setTradeStatus('bridging');
    await new Promise(r => setTimeout(r, 2000));
    setTradeStatus('delivering');
    await new Promise(r => setTimeout(r, 1000));
    setTradeStatus('complete');
    setTimeout(() => setTradeStatus('idle'), 3000);
  };

  const handleSell = async (percent: number) => {
    if (!token) return;
    setTradeStatus('approving');
    await new Promise(r => setTimeout(r, 1000));
    setTradeStatus('swapping');
    await new Promise(r => setTimeout(r, 1500));
    setTradeStatus('bridging');
    await new Promise(r => setTimeout(r, 1800));
    setTradeStatus('complete');
    setTimeout(() => setTradeStatus('idle'), 3000);
  };

  const statusSteps = [
    { key: 'approving', label: 'Approving Token', icon: Shield },
    { key: 'swapping', label: `Swapping on ${fundingChain.name}`, icon: ArrowDownUp },
    { key: 'bridging', label: 'Bridging via LI.FI', icon: Zap },
    { key: 'delivering', label: `Delivering ${token?.symbol ?? ''} on ${token?.chainName ?? ''}`, icon: CheckCircle2 },
  ];

  const currentStepIndex = statusSteps.findIndex(s => s.key === tradeStatus);

  if (!token) {
    return (
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="text-center py-8">
          <div className="flex justify-center mb-3">
            <ArrowDownUp className="w-10 h-10 text-gray-600" />
          </div>
          <p className="text-gray-400 text-sm">Select a token to trade</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      {/* Mode toggle */}
      <div className="flex border-b border-gray-800/50">
        <button
          onClick={() => { setMode('buy'); setTradeStatus('idle'); }}
          className={`flex-1 py-3.5 text-sm font-semibold transition-all ${
            mode === 'buy' ? 'text-green-400 bg-green-400/5 border-b-2 border-green-400' : 'text-gray-400 hover:text-white'
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => { setMode('sell'); setTradeStatus('idle'); }}
          className={`flex-1 py-3.5 text-sm font-semibold transition-all ${
            mode === 'sell' ? 'text-red-400 bg-red-400/5 border-b-2 border-red-400' : 'text-gray-400 hover:text-white'
          }`}
        >
          Sell
        </button>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`px-4 transition-all ${showSettings ? 'text-purple-400' : 'text-gray-400 hover:text-white'}`}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Settings panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-gray-800/50"
          >
            <div className="p-4 space-y-4">
              <div>
                <label className="text-xs text-gray-400 mb-2 block">Funding Chain</label>
                <div className="grid grid-cols-3 gap-2">
                  {SUPPORTED_CHAINS.map((chain) => (
                    <button
                      key={chain.id}
                      onClick={() => setFundingChain(chain)}
                      className={`px-2 py-2 rounded-lg text-xs font-medium transition-all border ${
                        fundingChain.id === chain.id
                          ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                          : 'border-gray-700/50 bg-gray-800/40 text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      <div className="flex justify-center mb-1">
                        <ChainLogo chainKey={chain.key} size={20} />
                      </div>
                      <span className="block mt-0.5">{chain.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-2 block">Slippage Tolerance</label>
                <div className="flex items-center gap-2">
                  {[0.5, 1, 3, 5].map((s) => (
                    <button
                      key={s}
                      onClick={() => setSlippage(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        slippage === s ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                      }`}
                    >
                      {s}%
                    </button>
                  ))}
                  <input
                    type="number"
                    value={slippage}
                    onChange={(e) => setSlippage(parseFloat(e.target.value) || 0)}
                    className="w-16 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white text-center focus:outline-none focus:border-purple-500"
                  />
                  <span className="text-xs text-gray-400">%</span>
                </div>
                {slippage > 5 && (
                  <div className="flex items-center gap-1 mt-2 text-xs text-yellow-400">
                    <AlertTriangle className="w-3 h-3" /> High slippage may result in unfavorable trades
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="p-4 space-y-4">
        {/* Trade status */}
        <AnimatePresence mode="wait">
          {tradeStatus !== 'idle' && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-2"
            >
              {tradeStatus === 'complete' ? (
                <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-xl">
                  <CheckCircle2 className="w-5 h-5 text-green-400" />
                  <span className="text-sm text-green-400 font-medium">Trade completed successfully!</span>
                </div>
              ) : (
                <div className="p-3 bg-purple-500/10 border border-purple-500/20 rounded-xl">
                  <div className="flex items-center gap-2 mb-2">
                    <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                    <span className="text-sm text-purple-300 font-medium">Processing cross-chain trade...</span>
                  </div>
                  <div className="space-y-1.5">
                    {statusSteps.map((step, idx) => {
                      const Icon = step.icon;
                      const isActive = idx === currentStepIndex;
                      const isDone = idx < currentStepIndex;
                      return (
                        <div key={step.key} className={`flex items-center gap-2 text-xs ${isDone ? 'text-green-400' : isActive ? 'text-purple-300' : 'text-gray-600'}`}>
                          {isDone ? <CheckCircle2 className="w-3.5 h-3.5" /> : isActive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
                          <span>{step.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Buy mode */}
        {mode === 'buy' && tradeStatus === 'idle' && (
          <>
            {/* Funding source */}
            <div className="bg-gray-800/40 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-gray-500">You Pay</div>
                  <div className="text-lg font-semibold text-white mt-0.5">
                    {amount || '0.0'} {fundingChain.nativeSymbol}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-500">Balance</div>
                  <div className="text-sm text-gray-300">{userBalance ? `${userBalance.balance.toFixed(4)} ${fundingChain.nativeSymbol}` : 'Not connected'}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full transition-all"
                    style={{ width: `${userBalance ? Math.min((parseFloat(amount || '0') / userBalance.balance) * 100, 100) : 0}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500">
                  {userBalance ? `≈ $${(parseFloat(amount || '0') * (userBalance.usdValue / userBalance.balance)).toFixed(2)}` : '$0.00'}
                </span>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex justify-center">
              <div className="w-8 h-8 bg-gray-800 rounded-full flex items-center justify-center border border-gray-700">
                <ArrowDownUp className="w-4 h-4 text-purple-400" />
              </div>
            </div>

            {/* Receive */}
            <div className="bg-gray-800/40 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-gray-500">You Receive</div>
                  <div className="text-lg font-semibold text-white mt-0.5">
                    {token.symbol}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: token.chainColor + '22', color: token.chainColor }}>
                    {token.chainName}
                  </div>
                </div>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                ≈ {amount ? (parseFloat(amount) * 100 / token.priceUsd).toLocaleString() : '0'} {token.symbol}
              </div>
            </div>

            {/* Quick buy presets */}
            <div>
              <div className="text-xs text-gray-500 mb-2">Quick Buy ({fundingChain.nativeSymbol})</div>
              <div className="grid grid-cols-4 gap-2">
                {BUY_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    onClick={() => handleBuy(preset)}
                    className="py-2.5 bg-gradient-to-r from-green-600/80 to-emerald-600/80 hover:from-green-500 hover:to-emerald-500 rounded-xl text-sm font-semibold text-white transition-all active:scale-95 flex items-center justify-center gap-1"
                  >
                    <Rocket className="w-3.5 h-3.5" /> {preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom amount */}
            <div className="flex gap-2">
              <input
                type="number"
                value={customAmount}
                onChange={(e) => { setCustomAmount(e.target.value); setAmount(e.target.value); }}
                placeholder="Custom amount..."
                className="flex-1 px-4 py-2.5 bg-gray-800/60 border border-gray-700/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:border-purple-500/50"
              />
              <button
                onClick={() => handleBuy()}
                disabled={!customAmount || parseFloat(customAmount) <= 0}
                className="px-6 py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-semibold text-white transition-all active:scale-95"
              >
                Buy Now
              </button>
            </div>
          </>
        )}

        {/* Sell mode */}
        {mode === 'sell' && tradeStatus === 'idle' && (
          <>
            <div className="bg-gray-800/40 rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-2">Sell {token.symbol}</div>
              <div className="text-sm text-gray-300">
                Holdings: <span className="text-white font-semibold">No holdings recorded</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Value: <span className="text-white">—</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Returns to: <span className="text-purple-400">{fundingChain.name} ({fundingChain.nativeSymbol})</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {SELL_PRESETS.map((percent) => (
                <button
                  key={percent}
                  onClick={() => handleSell(percent)}
                  className="py-3 bg-gradient-to-r from-red-600/80 to-rose-600/80 hover:from-red-500 hover:to-rose-500 rounded-xl text-sm font-semibold text-white transition-all active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <TrendingDown className="w-3.5 h-3.5" /> Sell {percent}%
                </button>
              ))}
            </div>

            <div className="text-xs text-gray-500 text-center">
              Proceeds automatically return to your {fundingChain.name} wallet
            </div>
          </>
        )}

        {/* Route info */}
        <div className="pt-2 border-t border-gray-800/50">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Route</span>
            <span>{fundingChain.name} → LI.FI Bridge → {token.chainName}</span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 mt-1">
            <span>Slippage</span>
            <span>{slippage}%</span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 mt-1">
            <span>Est. Time</span>
            <span>~30-60s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
