import { useState } from 'react';
import { Check, Copy, Route, Send, ShieldCheck, Zap } from 'lucide-react';
import type { DetectedToken } from '../services/chainDetector';
import { telegramTokenLink, useTelegramBotUrl } from '../services/telegramLinks';
import BrandLogo from './BrandLogo';

const PERKS = [
  { icon: Zap, text: 'Pay from any of 7 chains' },
  { icon: Route, text: 'Best route picked for you' },
  { icon: ShieldCheck, text: 'Live quote first — you confirm' },
];

/**
 * Browser stand-in for the trade card: the website is for checking tokens,
 * trading happens in the Telegram bot. The button opens the bot straight on
 * the scanned token's trading panel.
 */
export default function TelegramTradeCard({ token }: { token: DetectedToken | null }) {
  const botUrl = useTelegramBotUrl();
  const { url, direct } = telegramTokenLink(botUrl, token?.address);
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    if (!token) return;
    void navigator.clipboard?.writeText(token.address).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="panel panel-glow relative overflow-hidden p-5">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-brand-500/20 blur-3xl" />
      <div className="relative flex items-center gap-3">
        <BrandLogo className="h-11 w-11 shrink-0 rounded-[22%] shadow-[0_8px_24px_-10px_var(--brand-glow)]" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-300">Trade in Telegram</p>
          <h3 className="truncate text-base font-semibold text-white">{token ? `Buy or sell ${token.symbol}` : 'One tap to the Hopr bot'}</h3>
        </div>
      </div>

      <p className="relative mt-4 text-sm leading-relaxed text-gray-400">
        {token
          ? 'Open the bot on this token for a live quote. Pay from any chain you hold — nothing is signed until you confirm.'
          : 'This site is view-only. Scan a token to check its chart, liquidity and volume — then trade it from the bot.'}
      </p>

      {token && !direct && (
        <button onClick={copyAddress} className="pressable relative mt-3 flex w-full items-center justify-between gap-2 rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-2 text-left hover:border-brand-400/40">
          <span className="truncate font-mono text-xs text-gray-300">{token.address}</span>
          {copied ? <Check className="h-4 w-4 shrink-0 text-mint-400" /> : <Copy className="h-4 w-4 shrink-0 text-gray-500" />}
        </button>
      )}

      <ul className="relative mt-4 space-y-2">
        {PERKS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-2.5 text-[13px] text-gray-300">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-500/15"><Icon className="h-3.5 w-3.5 text-brand-300" /></span>
            {text}
          </li>
        ))}
      </ul>

      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="btn-primary pressable relative mt-5 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold">
          <Send className="h-4 w-4" />
          {token ? (direct ? `Open ${token.symbol} in the bot` : 'Open the bot · paste the address') : 'Open the Hopr bot'}
        </a>
      ) : (
        <p className="relative mt-5 rounded-xl border border-dashed border-gray-700 px-3 py-2.5 text-center text-xs text-gray-500">Open the Hopr Telegram bot to trade.</p>
      )}
    </div>
  );
}
