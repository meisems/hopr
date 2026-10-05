import { MessageCircle, Palette, Play, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import { useBlackHoleSettings, type IntroStyle } from '../context/BlackHoleContext';
import { useTheme } from '../context/ThemeContext';
import { useTelegramBotUrl } from '../services/telegramLinks';
import PageHeader from './PageHeader';
import BrandLogo from './BrandLogo';

interface SettingsPageProps { onBack: () => void; onPreviewBlackHole: () => void; }

const INTROS: { value: IntroStyle; label: string; hint: string }[] = [
  { value: 'hop', label: 'Hop', hint: 'Light & quick · 2s' },
  { value: 'blackhole', label: 'Black hole', hint: 'Ray-traced · needs WebGL' },
  { value: 'off', label: 'Off', hint: 'Straight to the dashboard' },
];

/** Website settings are appearance only; trade settings, wallets and keys live in the Telegram bot. */
export default function SettingsPage({ onBack, onPreviewBlackHole }: SettingsPageProps) {
  const { settings, setSpin, setInclination, setIntro } = useBlackHoleSettings();
  const { theme, preference } = useTheme();
  const botUrl = useTelegramBotUrl();

  return <div className="text-white">
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
      <PageHeader icon={SettingsIcon} title="Settings" subtitle="Appearance — trade settings live in the Telegram bot (/settings)" onBack={onBack} />

      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><Palette className="w-4 h-4 text-brand-300" /><h2 className="font-semibold">Appearance</h2></div>
            <p className="mt-1 text-sm text-gray-500">{preference === 'system' ? `Following your device setting — currently ${theme}. Changes apply instantly.` : `Always ${preference}, regardless of your device setting.`}</p>
          </div>
          <ThemeToggle size="lg" />
        </div>
      </section>

      <section className="panel p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-brand-300" /><h2 className="font-semibold">Loading intro</h2></div>
            <p className="mt-1 text-sm text-gray-500">Plays once per visit when you open the dashboard.</p>
          </div>
          <button onClick={onPreviewBlackHole} className="pressable inline-flex items-center gap-1.5 rounded-xl border border-brand-400/30 bg-brand-500/10 px-3 py-2 text-sm font-semibold text-brand-200 hover:bg-brand-500/20">
            <Play className="h-3.5 w-3.5" /> Preview
          </button>
        </div>
        <div role="radiogroup" aria-label="Loading intro" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {INTROS.map(({ value, label, hint }) => {
            const active = settings.intro === value;
            return (
              <button
                key={value}
                role="radio"
                aria-checked={active}
                onClick={() => setIntro(value)}
                className={`pressable rounded-xl border px-4 py-3 text-left ${active ? 'border-brand-400/50 bg-brand-500/15' : 'border-gray-800 bg-gray-800/30 hover:border-gray-700'}`}
              >
                <span className="flex items-center justify-between text-sm font-semibold text-white">
                  {label}
                  <span className={`h-3.5 w-3.5 rounded-full border-2 ${active ? 'border-brand-400 bg-brand-400 shadow-[inset_0_0_0_2px_var(--color-gray-900)]' : 'border-gray-600'}`} />
                </span>
                <span className="mt-0.5 block text-xs text-gray-500">{hint}</span>
              </button>
            );
          })}
        </div>

        {settings.intro === 'blackhole' && (
          <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-800/20 p-4">
            <div><div className="flex justify-between text-sm"><label htmlFor="settings-spin">Spin parameter</label><span className="font-mono text-brand-200">{settings.spin.toFixed(2)}</span></div><input id="settings-spin" type="range" min="0" max="0.998" step="0.001" value={settings.spin} onChange={(event) => setSpin(Number(event.target.value))} className="mt-3 w-full accent-brand-400" /></div>
            <div><div className="flex justify-between text-sm"><label htmlFor="settings-inclination">Viewing inclination</label><span className="font-mono text-brand-200">{settings.inclination}°</span></div><input id="settings-inclination" type="range" min="0" max="90" step="1" value={settings.inclination} onChange={(event) => setInclination(Number(event.target.value))} className="mt-3 w-full accent-brand-400" /></div>
          </div>
        )}
      </section>

      <section className="panel panel-glow relative overflow-hidden p-6">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-500/15 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">Trading</p><h2 className="mt-2 text-2xl font-bold tracking-tight">Wallets, slippage and trades live in the bot</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-400">Create or import wallets, pick your pay-from chain and slippage, and track every token you hold across 7 chains from the Hopr Telegram bot.</p></div><BrandLogo className="h-12 w-12 shrink-0 rounded-[22%]" /></div>
        {botUrl && <a href={botUrl} target="_blank" rel="noreferrer" className="btn-primary pressable relative mt-5 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"><MessageCircle className="w-4 h-4" />Open the Hopr bot</a>}
      </section>
    </main>
  </div>;
}
