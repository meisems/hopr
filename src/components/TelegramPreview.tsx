import { useState, useEffect } from 'react';
import { Send, Bot, Copy, CheckCircle2, ExternalLink, Coins, MapPin, Link2, DollarSign, CreditCard, Target, Rocket, Pencil, RefreshCw, TrendingDown, Settings, BarChart3, X, Clock, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ChainLogo from './ChainLogo';

export default function TelegramPreview() {
  const [showProgress, setShowProgress] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [copied, setCopied] = useState(false);

  const steps = [
    { icon: Loader2, label: 'Step 1/3: Swapping on Solana...' },
    { icon: Loader2, label: 'Step 2/3: Bridging via LI.FI...' },
    { icon: Loader2, label: 'Step 3/3: Delivering MPEPE on Base...' },
  ];

  const handleBuyClick = () => {
    setShowProgress(true);
    setCurrentStep(0);
  };

  useEffect(() => {
    if (showProgress && currentStep < steps.length) {
      const timer = setTimeout(() => {
        setCurrentStep(prev => prev + 1);
      }, 1500);
      return () => clearTimeout(timer);
    }
    if (showProgress && currentStep >= steps.length) {
      const timer = setTimeout(() => {
        setShowProgress(false);
        setCurrentStep(0);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [showProgress, currentStep]);

  const handleCopy = () => {
    navigator.clipboard.writeText('@HoprBot');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">@HoprBot</div>
            <div className="text-[10px] text-green-400">online</div>
          </div>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-400 hover:bg-blue-500/20 transition-all"
        >
          {copied ? <CheckCircle2 className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
      </div>

      {/* Chat area */}
      <div className="p-4 space-y-3 min-h-[320px] bg-[#0e1621]/50">
        {/* User message */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex justify-end"
        >
          <div className="max-w-[80%] px-3 py-2 bg-[#2b5278] rounded-xl rounded-br-sm">
            <p className="text-sm text-white font-mono">0x946102eA7Df8c2652a1B3a96e23B8b0a703410a5</p>
          </div>
        </motion.div>

        {/* Bot response */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
          className="flex justify-start"
        >
          <div className="max-w-[90%] space-y-3">
            {/* Token info card */}
            <div className="px-3 py-2.5 bg-[#182533] rounded-xl rounded-bl-sm border border-gray-700/30 space-y-1.5">
              <div className="flex items-center gap-2">
                <ChainLogo chainKey="base" size={20} />
                <span className="text-sm font-semibold text-white">MPEPE</span>
                <span className="text-xs text-gray-400">| Moon Pepe</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-300">
                <MapPin className="w-3 h-3 text-blue-400" />
                <span>Chain: Base (8453)</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-300">
                <Link2 className="w-3 h-3 text-blue-400" />
                <span className="font-mono">Address: 0x9461...10a5</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-300">
                <DollarSign className="w-3 h-3 text-green-400" />
                <span>Price: $0.0000123 | Liq: $890K | MC: $1.23M</span>
              </div>
              <div className="border-t border-gray-700/30 my-2" />
              <div className="flex items-center gap-1.5 text-xs text-gray-300">
                <CreditCard className="w-3 h-3 text-purple-400" />
                <span>Paid via: Solana (Bal: 45.82 SOL)</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-300">
                <Target className="w-3 h-3 text-yellow-400" />
                <span className="font-mono">Recipient: 0x7a3B...9f2E</span>
              </div>
            </div>
            
            {/* Inline buttons */}
            <div className="space-y-1.5 mt-2">
              {/* Buy buttons */}
              <div className="flex gap-1.5 flex-wrap">
                {['0.1', '0.5', '1.0'].map((amount) => (
                  <button
                    key={amount}
                    onClick={amount === '0.5' ? handleBuyClick : undefined}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/20 transition-all"
                  >
                    <Rocket className="w-3 h-3" /> Buy {amount}
                  </button>
                ))}
              </div>
              {/* Custom + Change chain */}
              <div className="flex gap-1.5 flex-wrap">
                <button className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-gray-700/30 text-gray-300 hover:bg-gray-700/50 border border-gray-600/20 transition-all">
                  <Pencil className="w-3 h-3" /> Custom
                </button>
                <button className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-gray-700/30 text-gray-300 hover:bg-gray-700/50 border border-gray-600/20 transition-all">
                  <RefreshCw className="w-3 h-3" /> Change Chain
                </button>
              </div>
              {/* Sell buttons */}
              <div className="flex gap-1.5 flex-wrap">
                {['25%', '50%', '100%'].map((percent) => (
                  <button
                    key={percent}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/20 transition-all"
                  >
                    <TrendingDown className="w-3 h-3" /> Sell {percent}
                  </button>
                ))}
              </div>
              {/* Settings + DexScreener + Dismiss */}
              <div className="flex gap-1.5 flex-wrap">
                <button className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-gray-700/30 text-gray-300 hover:bg-gray-700/50 border border-gray-600/20 transition-all">
                  <Settings className="w-3 h-3" /> Settings
                </button>
                <button className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-gray-700/30 text-gray-300 hover:bg-gray-700/50 border border-gray-600/20 transition-all">
                  <BarChart3 className="w-3 h-3" /> DexScreener
                </button>
                <button className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-gray-700/30 text-gray-300 hover:bg-gray-700/50 border border-gray-600/20 transition-all">
                  <X className="w-3 h-3" /> Dismiss
                </button>
              </div>
            </div>

            {/* Progress indicator */}
            <AnimatePresence>
              {showProgress && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="px-3 py-2.5 bg-[#182533] rounded-xl border border-purple-500/20"
                >
                  {currentStep < steps.length ? (
                    <div className="space-y-1.5">
                      {steps.slice(0, currentStep + 1).map((step, idx) => {
                        const Icon = step.icon;
                        return (
                          <div key={idx} className="text-xs text-purple-300 flex items-center gap-1.5">
                            <Icon className="w-3.5 h-3.5 animate-spin" />
                            {step.label}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-green-400 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Trade completed! 50,000,000 MPEPE delivered to Base wallet.
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>

      {/* Input area */}
      <div className="px-4 py-3 border-t border-gray-800/50 flex items-center gap-2">
        <input
          type="text"
          placeholder="Paste token address..."
          className="flex-1 px-3 py-2 bg-[#182533] border border-gray-700/30 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/30"
          readOnly
        />
        <button className="p-2 bg-blue-500 rounded-xl hover:bg-blue-400 transition-colors">
          <Send className="w-4 h-4 text-white" />
        </button>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 bg-gray-800/30 flex items-center justify-between">
        <span className="text-[10px] text-gray-500">One-tap cross-chain trading via Telegram</span>
        <a href="#" className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300">
          <ExternalLink className="w-2.5 h-2.5" /> Open Bot
        </a>
      </div>
    </div>
  );
}
