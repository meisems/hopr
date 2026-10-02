import { useState } from 'react';
import { Check, Copy, MessageCircle, Send, Shield, Zap } from 'lucide-react';
import type { DetectedToken } from '../services/chainDetector';
import { telegramTokenLink, useTelegramBotUrl } from '../services/telegramLinks';

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
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-500/25 bg-brand-500/15">
          <MessageCircle className="h-5 w-5 text-brand-300" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-white">{token ? `Trade ${token.symbol} on Telegram` : 'Trading lives in Telegram'}</h3>
          <p className="text-xs text-gray-500">This site is view-only · buy &amp; sell in the Hopr bot</p>
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-gray-400">
        {token
          ? 'Open the bot to get a live quote for this token, pay from any of the 7 chains, and confirm before anything is signed.'
          : 'Scan any token here to check its chart, liquidity and volume — then trade it in one tap from the Hopr Telegram bot.'}
      </p>

      {token && !direct && (
        <button onClick={copyAddress} className="pressable mt-3 flex w-full items-center justify-between gap-2 rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-2 text-left">
          <span className="truncate font-mono text-xs text-gray-300">{token.address}</span>
          {copied ? <Check className="h-4 w-4 shrink-0 text-green-400" /> : <Copy className="h-4 w-4 shrink-0 text-gray-500" />}
        </button>
      )}

      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="pressable mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-500"
        >
          <Send className="h-4 w-4" />
          {token ? (direct ? `Open ${token.symbol} in the bot` : 'Open the bot · paste the address') : 'Open the Hopr bot'}
        </a>
      ) : (
        <p className="mt-4 rounded-xl border border-gray-800 bg-gray-800/30 px-3 py-2.5 text-center text-xs text-gray-500">Open the Hopr Telegram bot to trade.</p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] text-gray-500">
        <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-yellow-300" />Any chain pays for any token</span>
        <span className="flex items-center gap-1.5"><Shield className="h-3.5 w-3.5 text-brand-300" />Quote first, you confirm</span>
      </div>
    </div>
  );
}
