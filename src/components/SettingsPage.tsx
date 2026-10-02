import { MessageCircle, Palette, Settings as SettingsIcon, Zap } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import { useBlackHoleSettings } from '../context/BlackHoleContext';
import { useTheme } from '../context/ThemeContext';
import { useTelegramBotUrl } from '../services/telegramLinks';
import PageHeader from './PageHeader';

interface SettingsPageProps { onBack: () => void; onPreviewBlackHole: () => void; }

/** Website settings are appearance only; trade settings, wallets and keys live in the Telegram bot. */
export default function SettingsPage({ onBack, onPreviewBlackHole }: SettingsPageProps) {
  const { settings, setSpin, setInclination } = useBlackHoleSettings();
  const { theme, preference } = useTheme();
  const botUrl = useTelegramBotUrl();

  return <div className="text-white">
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <PageHeader icon={SettingsIcon} title="Settings" subtitle="Appearance — trade settings live in the Telegram bot (/settings)" onBack={onBack} />
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><Palette className="w-4 h-4 text-brand-300" /><h2 className="font-semibold">Appearance</h2></div>
            <p className="mt-1 text-sm text-gray-500">{preference === 'system' ? `Following your device setting — currently ${theme}. Changes apply instantly.` : `Always ${preference}, regardless of your device setting.`}</p>
          </div>
          <ThemeToggle size="lg" />
        </div>
      </section>
      <section className="rounded-2xl border border-gray-800/60 bg-gray-900/60 p-5 space-y-4"><div className="flex items-center gap-2"><Zap className="w-4 h-4 text-orange-300" /><h2 className="font-semibold">Black-hole visualization</h2></div><div><div className="flex justify-between text-sm"><label htmlFor="settings-spin">Spin parameter</label><span className="font-mono text-orange-200">{settings.spin.toFixed(2)}</span></div><input id="settings-spin" type="range" min="0" max="0.998" step="0.001" value={settings.spin} onChange={(event) => setSpin(Number(event.target.value))} className="mt-3 w-full accent-orange-400" /></div><div><div className="flex justify-between text-sm"><label htmlFor="settings-inclination">Viewing inclination</label><span className="font-mono text-orange-200">{settings.inclination}°</span></div><input id="settings-inclination" type="range" min="0" max="90" step="1" value={settings.inclination} onChange={(event) => setInclination(Number(event.target.value))} className="mt-3 w-full accent-orange-400" /></div><button onClick={onPreviewBlackHole} className="w-full rounded-xl border border-orange-400/30 bg-orange-500/15 px-3 py-2.5 text-sm font-semibold text-orange-100">Preview black-hole animation</button></section>
      <section className="rounded-2xl border border-brand-400/20 bg-gradient-to-br from-brand-500/10 via-gray-900/70 to-brand-500/10 p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.24em] text-brand-300">Trading</p><h2 className="mt-2 text-2xl font-bold">Wallets, slippage and trades live in the bot</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-400">Create or import wallets, pick your pay-from chain and slippage, and track every token you hold across 7 chains from the Hopr Telegram bot.</p></div><MessageCircle className="w-8 h-8 text-brand-300 shrink-0" /></div>
        {botUrl && <a href={botUrl} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 rounded-xl border border-brand-300/30 bg-brand-500/15 px-4 py-2.5 text-sm font-semibold text-brand-100 hover:bg-brand-500/25"><MessageCircle className="w-4 h-4" />Open the Hopr bot</a>}
      </section>
    </main>
  </div>;
}
