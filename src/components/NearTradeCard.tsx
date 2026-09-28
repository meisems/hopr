import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, ExternalLink, Loader2, Rocket, Settings, TrendingDown, XCircle } from 'lucide-react';
import { DetectedToken, NEAR_CHAIN } from '../services/chainDetector';
import { apiUrl, TELEGRAM_BOT_URL } from '../services/api';
import { useWallet } from '../context/WalletContext';
import { useNearBalance } from '../hooks/useNearBalance';
import ChainLogo from './ChainLogo';

const BUY_PRESETS = ['0.5', '1', '5'];
const SELL_PRESETS = [25, 50, 100];
const QUOTE_TTL_SECONDS = 90;

interface NearQuote {
  tradeId?: string;
  execution: 'read_only' | 'custodial_confirmation';
  tokenIn: { symbol: string };
  tokenOut: { symbol: string };
  amountInFormatted: string;
  expectedOutFormatted: string;
  minOutFormatted: string;
  hops: number;
  slippagePercent: number;
  storageDepositYocto?: string;
}

/** Exact decimal string for smallest-unit amounts (no thousands separators, no rounding). */
function unitsToDecimal(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${units / base}.${fraction}` : `${units / base}`;
}

/**
 * Trading panel for NEAR (NEP-141) tokens. Quotes come from Ref Finance via
 * the worker. Inside the Telegram Mini App the synced custodial NEAR wallet
 * can confirm the swap (same two-step flow as the bot); in a regular browser
 * the quote is read-only.
 */
export default function NearTradeCard({ token }: { token: DetectedToken }) {
  // Custodial NEAR wallet synced from the Telegram bot (this card only renders inside the Mini App).
  const custodialNear = useWallet().telegramWallet?.nearAddress ?? null;
  const initData = window.Telegram?.WebApp?.initData ?? '';
  const canExecute = Boolean(initData && custodialNear);
  const holdings = useNearBalance(canExecute ? custodialNear : null);
  const held = holdings.balance?.tokens.find((item) => item.id === token.address);

  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [slippage, setSlippage] = useState(1);
  const [showSettings, setShowSettings] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'done'>('idle');
  const [message, setMessage] = useState('');
  const [quote, setQuote] = useState<NearQuote | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [explorerUrl, setExplorerUrl] = useState('');

  useEffect(() => {
    setQuote(null);
    setStatus('idle');
    setMessage('');
  }, [token.address]);

  useEffect(() => {
    if (!quote?.tradeId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [quote?.tradeId]);

  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = Boolean(quote?.tradeId) && secondsLeft === 0;

  const requestQuote = async (side: 'buy' | 'sell', amount: string) => {
    setQuote(null);
    setExplorerUrl('');
    setStatus('loading');
    setMessage('Finding the best Ref Finance route…');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
    try {
      const response = await fetch(apiUrl('/api/trade/quote'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain: 'near',
          tokenIn: side === 'buy' ? 'near' : token.address,
          tokenOut: side === 'buy' ? token.address : 'near',
          amount,
          slippage,
          ...(canExecute ? { initData } : {}),
        }),
      });
      const data = await response.json() as NearQuote & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'No NEAR quote is available right now.');
      setQuote(data);
      setExpiresAt(Date.now() + QUOTE_TTL_SECONDS * 1000);
      setNow(Date.now());
      setStatus('ready');
      setMessage('');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'No NEAR quote is available right now.');
    }
  };

  const sell = (percent: number) => {
    if (!held) {
      setStatus('error');
      setMessage(canExecute ? `Your NEAR wallet holds no ${token.symbol}.` : 'Open Hopr from Telegram to sell from your synced NEAR wallet.');
      return;
    }
    const units = (BigInt(held.balance) * BigInt(percent)) / 100n;
    void requestQuote('sell', unitsToDecimal(units, held.decimals));
  };

  const confirm = async () => {
    if (!quote?.tradeId) return;
    setStatus('loading');
    setMessage('Signing and executing on NEAR…');
    try {
      const response = await fetch(apiUrl('/api/trade/execute'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, tradeId: quote.tradeId }),
      });
      const data = await response.json() as { txHash?: string; confirmed?: boolean; explorerUrl?: string; error?: string };
      if (!response.ok || !data.txHash) throw new Error(data.error ?? 'The swap was not executed.');
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
      setQuote(null);
      setExplorerUrl(data.explorerUrl ?? `${NEAR_CHAIN.explorerTxUrl}${data.txHash}`);
      setStatus('done');
      setMessage(data.confirmed === false ? 'Submitted. NEAR is still finalising it — check the explorer.' : 'Swap executed. Tokens are in your NEAR wallet.');
      void holdings.refresh();
    } catch (error) {
      setQuote(null);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'The swap was not executed.');
    }
  };

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      <div className="flex border-b border-gray-800/50">
        {(['buy', 'sell'] as const).map((side) => (
          <button
            key={side}
            onClick={() => { setMode(side); setQuote(null); setStatus('idle'); }}
            className={`flex-1 py-3.5 text-sm font-semibold capitalize transition-all ${
              mode === side
                ? side === 'buy' ? 'text-green-400 bg-green-400/5 border-b-2 border-green-400' : 'text-red-400 bg-red-400/5 border-b-2 border-red-400'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            {side}
          </button>
        ))}
        <button onClick={() => setShowSettings(!showSettings)} aria-label="Slippage settings" className={`px-4 transition-all ${showSettings ? 'text-brand-400' : 'text-gray-400 hover:text-white'}`}>
          <Settings className="w-4 h-4" />
        </button>
      </div>

      <AnimatePresence>
        {showSettings && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-b border-gray-800/50">
            <div className="p-4">
              <label className="text-xs text-gray-400 mb-2 block">Slippage Tolerance</label>
              <div className="flex gap-2">
                {[0.5, 1, 3, 5].map((value) => (
                  <button key={value} onClick={() => setSlippage(value)} className={`pressable px-3 py-1.5 rounded-lg text-xs font-medium ${slippage === value ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                    {value}%
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between rounded-xl bg-gray-800/40 p-3">
          <div className="flex items-center gap-2.5">
            <ChainLogo chainKey="near" size={28} />
            <div>
              <div className="text-sm font-semibold text-white">{mode === 'buy' ? `NEAR → ${token.symbol}` : `${token.symbol} → NEAR`}</div>
              <div className="text-xs text-gray-500">Ref Finance · NEAR Protocol</div>
            </div>
          </div>
          {canExecute && (
            <div className="text-right">
              <div className="text-xs text-gray-500">{mode === 'buy' ? 'NEAR balance' : 'Holdings'}</div>
              <div className="font-mono text-sm text-gray-300">
                {holdings.loading && !holdings.balance ? '…' : mode === 'buy' ? `${holdings.balance?.near ?? '0'} NEAR` : `${held?.formatted ?? '0'} ${token.symbol}`}
              </div>
            </div>
          )}
        </div>

        <AnimatePresence mode="wait">
          {status !== 'idle' && (
            <motion.div key={status} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              className={`rounded-xl border p-3 ${status === 'error' ? 'border-amber-500/20 bg-amber-500/10' : status === 'done' ? 'border-green-500/20 bg-green-500/10' : 'border-gray-700/50 bg-gray-800/40'}`}
            >
              {status === 'ready' && quote ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span className="font-semibold uppercase tracking-wide text-gray-400">Quote</span>
                    {quote.tradeId && <span className={`font-mono ${secondsLeft <= 15 ? 'text-amber-300' : ''}`}>{expired ? 'expired' : `${secondsLeft}s`}</span>}
                  </div>
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">You pay</dt><dd className="font-mono text-white">{quote.amountInFormatted} {quote.tokenIn.symbol}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">You receive</dt><dd className="font-mono text-white">≈ {quote.expectedOutFormatted} {quote.tokenOut.symbol}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">Minimum</dt><dd className="font-mono text-gray-300">{quote.minOutFormatted} {quote.tokenOut.symbol}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">Route</dt><dd className="text-gray-300">Ref Finance · {quote.hops} hop{quote.hops === 1 ? '' : 's'} · {quote.slippagePercent}% slippage</dd></div>
                  </dl>
                  {quote.tradeId ? (
                    <div className="flex gap-2 pt-1">
                      <button onClick={confirm} disabled={expired} className="pressable flex-1 rounded-xl bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-50">Confirm swap</button>
                      <button onClick={() => { setQuote(null); setStatus('idle'); }} className="pressable rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-300 hover:text-white">Cancel</button>
                    </div>
                  ) : (
                    <p className="pt-1 text-xs leading-relaxed text-gray-400">
                      Read-only quote. Open Hopr inside Telegram to trade with your synced NEAR wallet.
                      {TELEGRAM_BOT_URL && <> <a href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer" className="font-medium text-brand-300 hover:text-brand-200">Open the bot →</a></>}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  {status === 'loading' ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-300" /> : status === 'done' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-green-300" /> : <XCircle className="h-5 w-5 shrink-0 text-amber-300" />}
                  <div className="space-y-1">
                    <p className="text-sm text-gray-200">{message}</p>
                    {status === 'done' && explorerUrl && (
                      <a href={explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-200">View on NearBlocks <ExternalLink className="h-3 w-3" /></a>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {mode === 'buy' ? (
          <>
            <div>
              <div className="text-xs text-gray-500 mb-2">Quick Buy (NEAR)</div>
              <div className="grid grid-cols-3 gap-2">
                {BUY_PRESETS.map((preset) => (
                  <button key={preset} onClick={() => requestQuote('buy', preset)} disabled={status === 'loading'} className="pressable py-2.5 bg-gradient-to-r from-green-600/80 to-emerald-600/80 hover:from-green-500 hover:to-emerald-500 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-1 disabled:opacity-60">
                    <Rocket className="w-3.5 h-3.5" /> {preset}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                value={customAmount}
                onChange={(event) => setCustomAmount(event.target.value)}
                placeholder="Custom NEAR amount..."
                className="flex-1 px-4 py-2.5 bg-gray-800/60 border border-gray-700/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:border-brand-500/50"
              />
              <button
                onClick={() => requestQuote('buy', customAmount)}
                disabled={!/^\d+(\.\d+)?$/.test(customAmount) || Number(customAmount) <= 0 || status === 'loading'}
                className="pressable px-5 py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-semibold text-white"
              >
                Quote
              </button>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {SELL_PRESETS.map((percent) => (
              <button key={percent} onClick={() => sell(percent)} disabled={status === 'loading'} className="pressable py-3 bg-gradient-to-r from-red-600/80 to-rose-600/80 hover:from-red-500 hover:to-rose-500 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-1.5 disabled:opacity-60">
                <TrendingDown className="w-3.5 h-3.5" /> {percent}%
              </button>
            ))}
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-gray-500">
          NEAR swaps route through Ref Finance on NEAR. Every swap shows a live quote first and only executes after you confirm.
        </p>
      </div>
    </div>
  );
}
