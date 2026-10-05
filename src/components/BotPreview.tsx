import { useEffect, useState } from 'react';
import { BadgeCheck, Send } from 'lucide-react';
import BrandLogo from './BrandLogo';

/** Mirrors telegramActionKeyboard() in workers/index.ts. */
const KEYBOARD: string[][] = [
  ['🟢 Buy', '🔴 Sell'],
  ['💼 Portfolio', '🎯 Orders'],
  ['📡 Launch radar', '👀 Tracking'],
  ['💳 Wallets', '🎁 Refer & Earn'],
  ['⚙️ Settings', '❓ Help', '🔄 Refresh'],
];

const SAMPLE_HOLDINGS = [
  { chain: '🟣', symbol: 'SOL', amount: '4.82', usd: '$812.40' },
  { chain: '🔷', symbol: 'ETH', amount: '0.214', usd: '$598.12' },
  { chain: '🟡', symbol: 'BNB', amount: '0.61', usd: '$371.05' },
  { chain: 'Ⓝ', symbol: 'NEAR', amount: '96.3', usd: '$289.91' },
];

/**
 * A static picture of the Hopr bot's home screen, so visitors see what they
 * get before opening Telegram. Sample numbers only — nothing here is live.
 */
export default function BotPreview({ botUrl }: { botUrl: string }) {
  const [typing, setTyping] = useState(true);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => setTyping(false), reduced ? 0 : 900);
    return () => window.clearTimeout(timer);
  }, []);

  const Key = ({ label }: { label: string }) => {
    const className = 'tg-key pressable flex min-w-0 flex-1 items-center justify-center truncate px-2 py-2 text-[12px] font-medium text-gray-200';
    return botUrl
      ? <a href={botUrl} target="_blank" rel="noreferrer" className={className}>{label}</a>
      : <span className={className}>{label}</span>;
  };

  return (
    <figure className="panel panel-glow tg-window relative overflow-hidden" aria-label="Preview of the Hopr Telegram bot home screen">
      {/* Chat header */}
      <div className="flex items-center gap-3 border-b border-gray-800/70 px-4 py-3">
        <BrandLogo className="h-9 w-9 overflow-hidden rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-sm font-semibold text-white">Hopr <BadgeCheck className="h-3.5 w-3.5 text-brand-300" /></div>
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500"><span className="live-dot !h-1.5 !w-1.5" />bot · online</div>
        </div>
        <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-500">Preview</span>
      </div>

      <div className="space-y-2 px-3 pb-3 pt-4 sm:px-4">
        {/* The user's /start */}
        <div className="flex justify-end">
          <span className="rounded-2xl rounded-br-md bg-brand-600 px-3 py-1.5 font-mono text-xs text-white">/start</span>
        </div>

        {typing ? (
          <div className="tg-bubble inline-flex items-center px-3 py-2.5" aria-label="Hopr is typing"><span className="tg-typing"><span /><span /><span /></span></div>
        ) : (
          <div className="tg-msg-in space-y-2">
            <div className="tg-bubble px-3.5 py-3 text-[12.5px] leading-relaxed text-gray-300">
              <p className="font-semibold text-white">⚡ Welcome to Hopr</p>
              <p className="italic text-gray-500">Cross-chain trading terminal · 7 chains</p>

              <div className="mt-3 flex items-baseline justify-between gap-2">
                <span className="font-semibold text-white">💼 Portfolio</span>
                <span className="font-mono text-base font-semibold text-white">$2,071.48</span>
              </div>
              <ul className="mt-1 space-y-0.5 font-mono text-[11.5px] text-gray-400">
                {SAMPLE_HOLDINGS.map((holding, index) => (
                  <li key={holding.symbol} className="flex justify-between gap-2">
                    <span><span className="text-gray-600">{index === SAMPLE_HOLDINGS.length - 1 ? '└' : '├'}</span> {holding.chain} {holding.symbol} {holding.amount}</span>
                    <span className="text-gray-500">{holding.usd}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-3 font-semibold text-white">🚀 Trade</p>
              <p className="font-mono text-[11.5px] text-gray-400"><span className="text-gray-600">└</span> Paste any token address — Hopr finds the route, you confirm.</p>
              <p className="mt-2 text-right text-[10px] text-gray-600">🔐 keys encrypted · 12:04</p>
            </div>

            <div className="space-y-1.5" role="group" aria-label="Bot menu">
              {KEYBOARD.map((row) => (
                <div key={row.join()} className="flex gap-1.5">
                  {row.map((label) => <Key key={label} label={label} />)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-center gap-2 border-t border-gray-800/70 px-3 py-2.5">
        <span className="flex-1 truncate rounded-full bg-gray-800/70 px-3 py-2 text-xs text-gray-500">Paste a token address…</span>
        {botUrl ? (
          <a href={botUrl} target="_blank" rel="noreferrer" className="btn-primary pressable flex h-8 w-8 items-center justify-center rounded-full" aria-label="Open the Hopr bot">
            <Send className="h-3.5 w-3.5" />
          </a>
        ) : (
          <span className="btn-primary flex h-8 w-8 items-center justify-center rounded-full opacity-60" aria-hidden><Send className="h-3.5 w-3.5" /></span>
        )}
      </div>
    </figure>
  );
}
