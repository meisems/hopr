import { useState } from 'react';
import { X, Zap, Shield, Bell, Globe, Lock, Wallet, CheckCircle2, AlertCircle, Copy, Unplug } from 'lucide-react';
import { SUPPORTED_CHAINS } from '../services/chainDetector';
import ChainLogo from './ChainLogo';
import { motion } from 'framer-motion';
import { useWallet } from '../context/WalletContext';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Not connected';
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { evmAddress, solanaAddress, isReady, connectEvm, connectSolana, disconnectEvm, disconnectSolana } = useWallet();
  const [defaultChain, setDefaultChain] = useState('sol');
  const [quickBuyAmounts, setQuickBuyAmounts] = useState(['0.1', '0.5', '1.0', '2.0']);
  const [defaultSlippage, setDefaultSlippage] = useState('3');
  const [autoApprove, setAutoApprove] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const connect = async (kind: 'evm' | 'solana') => {
    setError('');
    try {
      if (kind === 'evm') await connectEvm();
      else await connectSolana();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet connection was rejected.');
    }
  };

  const copyAddress = async (address: string | null) => {
    if (address) await navigator.clipboard.writeText(address);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} className="w-full max-w-lg bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div><h2 className="text-lg font-semibold text-white">Settings</h2><p className="text-xs text-gray-500 mt-0.5">Dashboard access requires both wallets.</p></div>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        <div className="p-5 space-y-6 max-h-[75vh] overflow-y-auto">
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><Wallet className="w-4 h-4 text-brand-400" /><label className="text-sm font-medium text-white">Connected wallets</label></div>
              {isReady ? <span className="inline-flex items-center gap-1 text-xs text-green-400"><CheckCircle2 className="w-3.5 h-3.5" /> Dashboard unlocked</span> : <span className="text-xs text-yellow-400">Both required</span>}
            </div>
            <div className="space-y-2">
              {[
                { label: 'EVM wallet', address: evmAddress, connect: () => connect('evm'), disconnect: disconnectEvm, icon: 'EVM' },
                { label: 'Solana wallet', address: solanaAddress, connect: () => connect('solana'), disconnect: disconnectSolana, icon: 'SOL' },
              ].map((wallet) => (
                <div key={wallet.label} className="flex items-center gap-3 p-3 bg-gray-800/40 border border-gray-700/40 rounded-xl">
                  <div className="w-9 h-9 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-[10px] font-bold text-brand-300">{wallet.icon}</div>
                  <div className="min-w-0 flex-1"><div className="text-sm text-white">{wallet.label}</div><div className="text-xs text-gray-400 font-mono truncate">{shortAddress(wallet.address)}</div></div>
                  {wallet.address ? <div className="flex items-center gap-1"><button onClick={() => copyAddress(wallet.address)} className="p-1.5 text-gray-400 hover:text-white" aria-label={`Copy ${wallet.label} address`}><Copy className="w-3.5 h-3.5" /></button><button onClick={wallet.disconnect} className="p-1.5 text-gray-400 hover:text-red-300" aria-label={`Disconnect ${wallet.label}`}><Unplug className="w-3.5 h-3.5" /></button></div> : <button onClick={wallet.connect} className="px-3 py-1.5 rounded-lg bg-brand-500/20 border border-brand-400/30 text-xs font-medium text-brand-200 hover:bg-brand-500/30">Connect</button>}
                </div>
              ))}
            </div>
            {error && <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
            <p className="text-[11px] text-gray-500 mt-2">Connect one EVM wallet and one Solana wallet before using dashboard trading features.</p>
          </section>

          <div>
            <div className="flex items-center gap-2 mb-3"><Globe className="w-4 h-4 text-purple-400" /><label className="text-sm font-medium text-white">Default Funding Chain</label></div>
            <div className="grid grid-cols-3 gap-2">{SUPPORTED_CHAINS.map((chain) => <button key={chain.id} onClick={() => setDefaultChain(chain.key)} className={`px-3 py-3 rounded-xl text-xs font-medium transition-all border ${defaultChain === chain.key ? 'border-purple-500 bg-purple-500/10 text-purple-300' : 'border-gray-700/50 bg-gray-800/40 text-gray-400 hover:border-gray-600'}`}><div className="flex justify-center mb-1"><ChainLogo chainKey={chain.key} size={24} /></div>{chain.name}</button>)}</div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3"><Zap className="w-4 h-4 text-yellow-400" /><label className="text-sm font-medium text-white">Quick-Buy Presets</label></div>
            <div className="grid grid-cols-4 gap-2">{quickBuyAmounts.map((amount, idx) => <input key={idx} type="text" value={amount} onChange={(e) => { const next = [...quickBuyAmounts]; next[idx] = e.target.value; setQuickBuyAmounts(next); }} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white text-center focus:outline-none focus:border-purple-500" />)}</div>
            <p className="text-xs text-gray-500 mt-2">Amounts in native token of funding chain</p>
          </div>

          <div><div className="flex items-center gap-2 mb-3"><Shield className="w-4 h-4 text-blue-400" /><label className="text-sm font-medium text-white">Default Slippage</label></div><div className="flex items-center gap-2">{[0.5, 1, 3, 5, 10].map((s) => <button key={s} onClick={() => setDefaultSlippage(s.toString())} className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${defaultSlippage === s.toString() ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>{s}%</button>)}</div></div>

          <div className="space-y-3">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Zap className="w-4 h-4 text-green-400" /><span className="text-sm text-white">Auto-approve tokens</span></div><button onClick={() => setAutoApprove(!autoApprove)} className={`w-11 h-6 rounded-full transition-all ${autoApprove ? 'bg-purple-600' : 'bg-gray-700'}`}><div className={`w-5 h-5 bg-white rounded-full transition-transform ${autoApprove ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} /></button></div>
            <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Bell className="w-4 h-4 text-yellow-400" /><span className="text-sm text-white">Trade notifications</span></div><button onClick={() => setNotifications(!notifications)} className={`w-11 h-6 rounded-full transition-all ${notifications ? 'bg-purple-600' : 'bg-gray-700'}`}><div className={`w-5 h-5 bg-white rounded-full transition-transform ${notifications ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} /></button></div>
          </div>

          <div className="p-3 bg-yellow-500/5 border border-yellow-500/20 rounded-xl"><div className="flex items-start gap-2"><Lock className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" /><p className="text-xs text-yellow-400/80">Only connect wallets you control. The dashboard requests access from your installed wallet provider and does not receive private keys.</p></div></div>
        </div>
        <div className="p-5 border-t border-gray-800 flex justify-end"><button onClick={onClose} className="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-xl transition-colors">Done</button></div>
      </motion.div>
    </motion.div>
  );
}
