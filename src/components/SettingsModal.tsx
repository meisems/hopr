import { useState } from 'react';
import { X, Zap, Shield, Bell, Globe } from 'lucide-react';
import { SUPPORTED_CHAINS } from '../services/chainDetector';
import { motion } from 'framer-motion';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [defaultChain, setDefaultChain] = useState('sol');
  const [quickBuyAmounts, setQuickBuyAmounts] = useState(['0.1', '0.5', '1.0', '2.0']);
  const [defaultSlippage, setDefaultSlippage] = useState('3');
  const [autoApprove, setAutoApprove] = useState(true);
  const [notifications, setNotifications] = useState(true);

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-lg bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-lg transition-colors">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="p-5 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Default Funding Chain */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Globe className="w-4 h-4 text-purple-400" />
              <label className="text-sm font-medium text-white">Default Funding Chain</label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {SUPPORTED_CHAINS.map((chain) => (
                <button
                  key={chain.id}
                  onClick={() => setDefaultChain(chain.key)}
                  className={`px-3 py-3 rounded-xl text-xs font-medium transition-all border ${
                    defaultChain === chain.key
                      ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                      : 'border-gray-700/50 bg-gray-800/40 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  <div className="text-lg mb-1">{chain.icon}</div>
                  {chain.name}
                </button>
              ))}
            </div>
          </div>

          {/* Quick Buy Presets */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-4 h-4 text-yellow-400" />
              <label className="text-sm font-medium text-white">Quick-Buy Presets</label>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {quickBuyAmounts.map((amount, idx) => (
                <input
                  key={idx}
                  type="text"
                  value={amount}
                  onChange={(e) => {
                    const newAmounts = [...quickBuyAmounts];
                    newAmounts[idx] = e.target.value;
                    setQuickBuyAmounts(newAmounts);
                  }}
                  className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white text-center focus:outline-none focus:border-purple-500"
                />
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">Amounts in native token of funding chain</p>
          </div>

          {/* Default Slippage */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-4 h-4 text-blue-400" />
              <label className="text-sm font-medium text-white">Default Slippage</label>
            </div>
            <div className="flex items-center gap-2">
              {[0.5, 1, 3, 5, 10].map((s) => (
                <button
                  key={s}
                  onClick={() => setDefaultSlippage(s.toString())}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                    defaultSlippage === s.toString()
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-white'
                  }`}
                >
                  {s}%
                </button>
              ))}
            </div>
          </div>

          {/* Toggles */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-green-400" />
                <span className="text-sm text-white">Auto-approve tokens</span>
              </div>
              <button
                onClick={() => setAutoApprove(!autoApprove)}
                className={`w-11 h-6 rounded-full transition-all ${autoApprove ? 'bg-purple-600' : 'bg-gray-700'}`}
              >
                <div className={`w-5 h-5 bg-white rounded-full transition-transform ${autoApprove ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-yellow-400" />
                <span className="text-sm text-white">Trade notifications</span>
              </div>
              <button
                onClick={() => setNotifications(!notifications)}
                className={`w-11 h-6 rounded-full transition-all ${notifications ? 'bg-purple-600' : 'bg-gray-700'}`}
              >
                <div className={`w-5 h-5 bg-white rounded-full transition-transform ${notifications ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
              </button>
            </div>
          </div>

          {/* Security notice */}
          <div className="p-3 bg-yellow-500/5 border border-yellow-500/20 rounded-xl">
            <p className="text-xs text-yellow-400/80">
              🔐 Private keys are encrypted with AES-256-GCM and never leave your device unencrypted. 
              Keys are only decrypted in memory for the duration needed to sign transactions.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-800 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={onClose} className="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-xl transition-colors">
            Save Changes
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
