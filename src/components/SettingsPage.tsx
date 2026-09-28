import { useState } from 'react';
import { Bell, Globe, Lock, Palette, Settings as SettingsIcon, Shield, Wallet, Zap } from 'lucide-react';
import { NETWORKS } from '../services/chains';
import { usePreferences } from '../services/preferences';
import ChainLogo from './ChainLogo';
import ThemeToggle from './ThemeToggle';
import { useBlackHoleSettings } from '../context/BlackHoleContext';
import { useTheme } from '../context/ThemeContext';
import PageHeader from './PageHeader';

interface SettingsPageProps { onBack: () => void; onOpenWallets: () => void; onPreviewBlackHole: () => void; }

export default function SettingsPage({ onBack, onOpenWallets, onPreviewBlackHole }: SettingsPageProps) {
  const { settings, setSpin, setInclination } = useBlackHoleSettings();
  const { theme, preference } = useTheme();
  const inTelegram = Boolean(window.Telegram?.WebApp?.initData);
  const [prefs, setPrefs] = usePreferences();
  const [notificationHint, setNotificationHint] = useState('');

  const toggleNotifications = async () => {
    if (prefs.notifications) return setPrefs({ notifications: false });
    if (typeof Notification === 'undefined') return setNotificationHint('not supported in this browser');
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return setNotificationHint('blocked in browser settings');
    setNotificationHint('');
    setPrefs({ notifications: true });
  };

  return <div className="text-white">
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <PageHeader icon={SettingsIcon} title="Settings" subtitle="Appearance, trading defaults and wallet security" onBack={onBack} />
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><Palette className="w-4 h-4 text-brand-300" /><h2 className="font-semibold">Appearance</h2></div>
            <p className="mt-1 text-sm text-gray-500">{preference === 'system' ? `Following your ${inTelegram ? 'Telegram' : 'device'} setting — currently ${theme}. Changes apply instantly.` : `Always ${preference}, regardless of your ${inTelegram ? 'Telegram' : 'device'} setting.`}</p>
          </div>
          <ThemeToggle size="lg" />
        </div>
      </section>
      <section className="rounded-2xl border border-brand-400/20 bg-gradient-to-br from-brand-500/10 via-gray-900/70 to-brand-500/10 p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.24em] text-brand-300">Account security</p><h2 className="mt-2 text-2xl font-bold">Manage wallets separately</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-400">Create, import, select, back up, and permanently delete wallets from the dedicated wallet vault. Private-key reveal is always protected by multiple acknowledgements.</p></div><Shield className="w-8 h-8 text-brand-300 shrink-0" /></div>
        <button onClick={onOpenWallets} className="mt-5 inline-flex items-center gap-2 rounded-xl border border-brand-300/30 bg-brand-500/15 px-4 py-2.5 text-sm font-semibold text-brand-100 hover:bg-brand-500/25"><Wallet className="w-4 h-4" />Open Wallet Vault</button>
      </section>
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5 space-y-4">
        <div className="flex items-center gap-2"><Globe className="w-4 h-4 text-brand-300" /><h2 className="font-semibold">Default "pay with" chain</h2></div>
        <p className="text-xs text-gray-500">Used by one-tap buys. "Token's chain" pays in the token's own native coin (cheapest); any other chain buys cross-chain in one tap.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button onClick={() => setPrefs({ defaultFundingChainId: null })} className={`pressable rounded-xl border p-3 text-xs ${prefs.defaultFundingChainId === null ? 'border-brand-400/60 bg-brand-500/15 text-brand-200' : 'border-gray-700/50 bg-gray-800/40 text-gray-400 hover:text-white'}`}>
            <span className="block text-base">⚡</span><span className="mt-1 block">Token&apos;s chain</span>
          </button>
          {NETWORKS.map((network) => (
            <button key={network.id} onClick={() => setPrefs({ defaultFundingChainId: network.id })} className={`pressable rounded-xl border p-3 text-xs ${prefs.defaultFundingChainId === network.id ? 'border-brand-400/60 bg-brand-500/15 text-brand-200' : 'border-gray-700/50 bg-gray-800/40 text-gray-400 hover:text-white'}`}>
              <span className="flex justify-center"><ChainLogo chainKey={network.key} size={22} /></span>
              <span className="mt-1 block">{network.shortName} · {network.nativeSymbol}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5 space-y-4">
        <div className="flex items-center gap-2"><Zap className="w-4 h-4 text-yellow-300" /><h2 className="font-semibold">Trading defaults</h2></div>
        <div>
          <label className="text-sm text-gray-300">Default slippage</label>
          <div className="mt-2 flex flex-wrap gap-2">
            {[0.5, 1, 3, 5].map((value) => (
              <button key={value} onClick={() => setPrefs({ slippagePercent: value })} className={`pressable rounded-lg px-3 py-2 text-sm font-medium ${prefs.slippagePercent === value ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>{value}%</button>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">Applied to new quotes on the trade card and bridge. One-tap amounts are set per chain (e.g. 0.005–0.1 ETH, 0.05–1 SOL, 1–25 NEAR).</p>
        </div>
        <button onClick={() => void toggleNotifications()} className="flex w-full items-center justify-between rounded-xl border border-gray-800 bg-gray-800/30 px-3 py-3 text-sm">
          <span className="flex items-center gap-2"><Bell className="w-4 h-4 text-yellow-300" />Trade notifications{notificationHint && <span className="text-xs text-gray-500">· {notificationHint}</span>}</span>
          <span role="switch" aria-checked={prefs.notifications} className={`relative h-6 w-11 rounded-full transition-colors duration-200 ${prefs.notifications ? 'bg-brand-500' : 'bg-gray-700'}`}><span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${prefs.notifications ? 'translate-x-5' : ''}`} /></span>
        </button>
      </section>
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5 space-y-4"><div className="flex items-center gap-2"><Zap className="w-4 h-4 text-orange-300" /><h2 className="font-semibold">Black-hole visualization</h2></div><div><div className="flex justify-between text-sm"><label htmlFor="settings-spin">Spin parameter</label><span className="font-mono text-orange-200">{settings.spin.toFixed(2)}</span></div><input id="settings-spin" type="range" min="0" max="0.998" step="0.001" value={settings.spin} onChange={(event) => setSpin(Number(event.target.value))} className="mt-3 w-full accent-orange-400" /></div><div><div className="flex justify-between text-sm"><label htmlFor="settings-inclination">Viewing inclination</label><span className="font-mono text-orange-200">{settings.inclination}°</span></div><input id="settings-inclination" type="range" min="0" max="90" step="1" value={settings.inclination} onChange={(event) => setInclination(Number(event.target.value))} className="mt-3 w-full accent-orange-400" /></div><button onClick={onPreviewBlackHole} className="w-full rounded-xl border border-orange-400/30 bg-orange-500/15 px-3 py-2.5 text-sm font-semibold text-orange-100">Preview black-hole animation</button></section>
      <div className="flex items-start gap-3 rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-xs leading-relaxed text-yellow-200/80"><Lock className="mt-0.5 h-4 w-4 shrink-0" />Hopr never asks for private keys for browser-wallet connections. Only reveal keys from the Wallet Vault when you fully understand the risk and have a secure backup destination.</div>
    </main>
  </div>;
}
