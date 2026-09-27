import { useState } from 'react';
import { ArrowLeft, Bell, Globe, Lock, Shield, Wallet, Zap } from 'lucide-react';
import { SUPPORTED_CHAINS } from '../services/chainDetector';
import ChainLogo from './ChainLogo';
import ThemeToggle from './ThemeToggle';
import { useBlackHoleSettings } from '../context/BlackHoleContext';

interface SettingsPageProps { onBack: () => void; onOpenWallets: () => void; onPreviewBlackHole: () => void; }

export default function SettingsPage({ onBack, onOpenWallets, onPreviewBlackHole }: SettingsPageProps) {
  const { settings, setSpin, setInclination } = useBlackHoleSettings();
  const [defaultChain, setDefaultChain] = useState('sol');
  const [quickBuyAmounts, setQuickBuyAmounts] = useState(['0.1', '0.5', '1.0', '2.0']);
  const [slippage, setSlippage] = useState('3');
  const [notifications, setNotifications] = useState(true);

  return <div className="min-h-screen bg-[#0a0b0f] text-white">
    <header className="navbar-dark sticky top-0 z-40 border-b border-gray-800/50 bg-gray-900/80 backdrop-blur-xl safe-area-top">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
        <button onClick={onBack} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white rounded-lg"><ArrowLeft className="w-4 h-4" />Back to Dashboard</button>
        <div className="flex items-center gap-3"><h1 className="text-lg font-semibold">Settings</h1><ThemeToggle /></div>
      </div>
    </header>
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <section className="rounded-2xl border border-brand-400/20 bg-gradient-to-br from-brand-500/10 via-gray-900/70 to-purple-500/10 p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.24em] text-brand-300">Account security</p><h2 className="mt-2 text-2xl font-bold">Manage wallets separately</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-400">Create, import, select, back up, and permanently delete wallets from the dedicated wallet vault. Private-key reveal is always protected by multiple acknowledgements.</p></div><Shield className="w-8 h-8 text-brand-300 shrink-0" /></div>
        <button onClick={onOpenWallets} className="mt-5 inline-flex items-center gap-2 rounded-xl border border-brand-300/30 bg-brand-500/15 px-4 py-2.5 text-sm font-semibold text-brand-100 hover:bg-brand-500/25"><Wallet className="w-4 h-4" />Open Wallet Vault</button>
      </section>
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5 space-y-5"><div className="flex items-center gap-2"><Globe className="w-4 h-4 text-purple-300" /><h2 className="font-semibold">Default funding chain</h2></div><div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{SUPPORTED_CHAINS.map((chain) => <button key={chain.key} onClick={() => setDefaultChain(chain.key)} className={`rounded-xl border p-3 text-xs ${defaultChain === chain.key ? 'border-purple-400/60 bg-purple-500/15 text-purple-200' : 'border-gray-700/50 bg-gray-800/40 text-gray-400'}`}><ChainLogo chainKey={chain.key} size={24} /><span className="mt-2 block">{chain.name}</span></button>)}</div></section>
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5 space-y-4"><div className="flex items-center gap-2"><Zap className="w-4 h-4 text-yellow-300" /><h2 className="font-semibold">Trading defaults</h2></div><div><label className="text-sm text-gray-300">Quick-buy presets</label><div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">{quickBuyAmounts.map((amount, index) => <input key={index} value={amount} onChange={(event) => setQuickBuyAmounts(quickBuyAmounts.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} className="rounded-xl border border-gray-700 bg-gray-800/60 px-3 py-2 text-center text-sm text-white" />)}</div><p className="mt-2 text-xs text-gray-500">Native-token amounts used by quick-buy controls.</p></div><div><label className="text-sm text-gray-300">Default slippage</label><div className="mt-2 flex flex-wrap gap-2">{['0.5', '1', '3', '5', '10'].map((value) => <button key={value} onClick={() => setSlippage(value)} className={`rounded-lg px-3 py-2 text-sm ${slippage === value ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400'}`}>{value}%</button>)}</div></div><button onClick={() => setNotifications(!notifications)} className="flex w-full items-center justify-between rounded-xl border border-gray-800 bg-gray-800/30 px-3 py-3 text-sm"><span className="flex items-center gap-2"><Bell className="w-4 h-4 text-yellow-300" />Trade notifications</span><span className={notifications ? 'text-green-300' : 'text-gray-500'}>{notifications ? 'On' : 'Off'}</span></button></section>
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5 space-y-4"><div className="flex items-center gap-2"><Zap className="w-4 h-4 text-orange-300" /><h2 className="font-semibold">Black-hole visualization</h2></div><div><div className="flex justify-between text-sm"><label htmlFor="settings-spin">Spin parameter</label><span className="font-mono text-orange-200">{settings.spin.toFixed(2)}</span></div><input id="settings-spin" type="range" min="0" max="0.998" step="0.001" value={settings.spin} onChange={(event) => setSpin(Number(event.target.value))} className="mt-3 w-full accent-orange-400" /></div><div><div className="flex justify-between text-sm"><label htmlFor="settings-inclination">Viewing inclination</label><span className="font-mono text-orange-200">{settings.inclination}°</span></div><input id="settings-inclination" type="range" min="0" max="90" step="1" value={settings.inclination} onChange={(event) => setInclination(Number(event.target.value))} className="mt-3 w-full accent-orange-400" /></div><button onClick={onPreviewBlackHole} className="w-full rounded-xl border border-orange-400/30 bg-orange-500/15 px-3 py-2.5 text-sm font-semibold text-orange-100">Preview black-hole animation</button></section>
      <div className="flex items-start gap-3 rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-xs leading-relaxed text-yellow-200/80"><Lock className="mt-0.5 h-4 w-4 shrink-0" />Hopr never asks for private keys for browser-wallet connections. Only reveal keys from the Wallet Vault when you fully understand the risk and have a secure backup destination.</div>
    </main>
  </div>;
}
