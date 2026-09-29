import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, ExternalLink, Loader2, Rocket, Shield, TrendingDown, Wallet, XCircle, Zap } from 'lucide-react';
import { NEAR_CHAIN_ID, type DetectedToken } from '../services/chainDetector';
import { getNetwork, NETWORKS } from '../services/chains';
import { apiUrl } from '../services/api';
import { getAssetBalance } from '../services/router';
import { formatUnits } from '../services/nearService';
import { useWallet } from '../context/WalletContext';
import ChainLogo from './ChainLogo';

const SELL_PRESETS = [25, 50, 100];
const SLIPPAGES = [0.5, 1, 3, 5];

interface TradeSummary {
  tradeId: string;
  side: 'buy' | 'sell';
  pay: string;
  receive: string;
  minimum?: string;
  route: string;
  steps: number;
  feeNote: string;
  expiresInSeconds: number;
}

type Status = 'idle' | 'quoting' | 'ready' | 'executing' | 'bridging' | 'done' | 'error';

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: window.Telegram?.WebApp?.initData ?? '', ...body }),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

const haptic = (style: 'light' | 'medium') => window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style);

/**
 * Trading panel inside the Telegram Mini App for EVM, Solana and NEAR tokens,
 * signed by the user's Hopr (bot) wallet — the same wallet, quotes and
 * confirm step as the bot's buttons. Any chain can pay for any token: cross-VM
 * routes run as steps (NEAR Intents, LI.FI, Ref Finance) that continue automatically.
 */
export default function HoprWalletTradeCard({ token }: { token: DetectedToken }) {
  const tokenNetwork = getNetwork(token.chainId);
  // Every supported chain can pay for every token.
  const fundingOptions = NETWORKS;
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [fundingChainId, setFundingChainId] = useState(token.chainId);
  const [slippage, setSlippage] = useState(1);
  const [customAmount, setCustomAmount] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [summary, setSummary] = useState<TradeSummary | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [explorerUrl, setExplorerUrl] = useState('');
  const pollRef = useRef<number | null>(null);
  const funding = getNetwork(fundingChainId) ?? NETWORKS[0];
  const { telegramWallet } = useWallet();
  const [fundingBalance, setFundingBalance] = useState<bigint | null>(null);
  const [holding, setHolding] = useState<bigint | null>(null);
  const [balanceRetry, setBalanceRetry] = useState(false);
  const ownerFor = (vm: string | undefined) => (vm === 'evm' ? telegramWallet?.evmAddress : vm === 'svm' ? telegramWallet?.solanaAddress : telegramWallet?.nearAddress) ?? null;
  const balanceKey = `${funding.id}:${token.chainId}:${token.address}:${ownerFor(funding.vm)}:${ownerFor(tokenNetwork?.vm)}`;
  const currentBalanceKey = useRef(balanceKey);
  currentBalanceKey.current = balanceKey;

  // Live balances of the Hopr wallet: the coin you pay with and the token you hold.
  const refreshBalances = async () => {
    const requestedKey = balanceKey;
    const fundingOwner = ownerFor(funding.vm);
    const tokenOwner = ownerFor(tokenNetwork?.vm);
    const [paid, held] = await Promise.all([
      fundingOwner ? getAssetBalance({ chainId: funding.id, address: 'native', symbol: funding.nativeSymbol, decimals: funding.nativeDecimals }, fundingOwner).catch(() => null) : null,
      tokenOwner ? getAssetBalance({ chainId: token.chainId, address: token.address, symbol: token.symbol, decimals: token.decimals }, tokenOwner).catch(() => null) : null,
    ]);
    if (currentBalanceKey.current !== requestedKey) return;
    setBalanceRetry((!!fundingOwner && paid === null) || (!!tokenOwner && held === null));
    if (paid !== null) setFundingBalance(paid);
    if (held !== null) setHolding(held);
  };

  useEffect(() => {
    currentBalanceKey.current = balanceKey;
    setFundingBalance(null);
    setHolding(null);
    setBalanceRetry(false);
    void refreshBalances();
    const timer = window.setInterval(() => void refreshBalances(), 20_000);
    return () => { window.clearInterval(timer); currentBalanceKey.current = ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceKey]);

  useEffect(() => {
    setFundingChainId(token.chainId);
    setSummary(null);
    setStatus('idle');
    setMessage('');
  }, [token.address, token.chainId]);

  useEffect(() => {
    if (status !== 'ready') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => () => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = status === 'ready' && secondsLeft === 0;

  const showQuote = (next: TradeSummary) => {
    setSummary(next);
    setExpiresAt(Date.now() + next.expiresInSeconds * 1000);
    setNow(Date.now());
    setStatus('ready');
    setMessage('');
  };

  const quote = async (side: 'buy' | 'sell', value: string | number) => {
    setSummary(null);
    setExplorerUrl('');
    setStatus('quoting');
    setMessage('Finding the best route…');
    haptic('light');
    try {
      showQuote(await call<TradeSummary>('/api/telegram/trade/prepare', {
        side,
        tokenChainId: token.chainId,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        fundingChainId,
        slippage: slippage / 100,
        ...(side === 'buy' ? { amount: String(value) } : { percent: value }),
      }));
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'No quote available right now.');
    }
  };

  /** Step 2 of a NEAR-funded buy: poll until the bridge lands, then show the swap quote. */
  const pollContinuation = (continuationId: string, attempt = 0) => {
    pollRef.current = window.setTimeout(async () => {
      try {
        const step = await call<{ status: string; detail?: string } & Partial<TradeSummary>>('/api/telegram/trade/continue', { continuationId, tokenDecimals: token.decimals });
        if (step.status === 'ready' && step.tradeId) {
          haptic('light');
          showQuote(step as TradeSummary);
          setMessage('The bridge landed. Confirm the next step to continue the buy.');
          return;
        }
        if (step.status === 'failed') {
          setStatus('error');
          setMessage(step.detail ?? 'Step 2 is unavailable.');
          return;
        }
        setMessage(`Bridging (${step.detail ?? 'in progress'})…`);
        if (attempt < 150) pollContinuation(continuationId, attempt + 1);
      } catch {
        if (attempt < 150) pollContinuation(continuationId, attempt + 1);
      }
    }, 6000);
  };

  const confirm = async () => {
    if (!summary) return;
    setStatus('executing');
    setMessage('Signing with your Hopr wallet…');
    try {
      const result = await call<{ txHash: string; explorerUrl?: string; continuationId?: string; venue?: string }>('/api/trade/execute', { tradeId: summary.tradeId });
      haptic('medium');
      setExplorerUrl(result.explorerUrl ?? '');
      setSummary(null);
      if (result.continuationId) {
        setStatus('bridging');
        setMessage(result.venue === 'lifi' ? 'Sent · bridging through LI.FI (usually 1–3 min)…' : 'Sent · bridging through NEAR Intents (usually 1–3 min)…');
        pollContinuation(result.continuationId);
        return;
      }
      window.setTimeout(() => void refreshBalances(), 4000);
      setStatus('done');
      setMessage(result.venue === 'intents' ? 'Submitted through NEAR Intents — tokens arrive in 1–3 minutes.' : 'Trade submitted. It is on-chain now; cross-chain delivery can take a few minutes.');
    } catch (error) {
      setSummary(null);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'The trade was not submitted.');
    }
  };

  const busy = status === 'quoting' || status === 'executing' || status === 'bridging';
  const presets = funding.quickBuy;

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-800/50 bg-gray-900/60">
      <div className="flex border-b border-gray-800/50">
        {(['buy', 'sell'] as const).map((side) => (
          <button key={side} onClick={() => { setMode(side); setSummary(null); setStatus('idle'); }}
            className={`flex-1 py-3.5 text-sm font-semibold capitalize transition-all ${mode === side
              ? side === 'buy' ? 'border-b-2 border-green-400 bg-green-400/5 text-green-400' : 'border-b-2 border-red-400 bg-red-400/5 text-red-400'
              : 'text-gray-400 hover:text-white'}`}>
            {side}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between rounded-xl bg-gray-800/40 px-3 py-2.5 text-xs">
          <span className="flex items-center gap-1.5 text-gray-300"><Shield className="h-3.5 w-3.5 text-brand-300" /> Hopr wallet · same as the bot</span>
        </div>

        {mode === 'buy' && (
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
              <span>Pay with</span>
              {fundingChainId !== token.chainId && <span className="flex items-center gap-1 text-brand-300"><Zap className="h-3 w-3" /> Cross-chain in one tap</span>}
            </div>
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
              {fundingOptions.map((network) => (
                <button key={network.id} onClick={() => { setFundingChainId(network.id); setStatus('idle'); setSummary(null); }}
                  className={`pressable flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[10px] font-medium ${fundingChainId === network.id ? 'border-brand-400/60 bg-brand-500/15 text-white' : 'border-gray-800/70 bg-gray-800/30 text-gray-400 hover:text-white'}`}>
                  <ChainLogo chainKey={network.key} size={20} />
                  {network.nativeSymbol}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-gray-800/40 p-3">
            <div className="text-xs text-gray-500">{funding.nativeSymbol} on {funding.shortName}</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-white">{fundingBalance === null ? <span className="text-gray-500">syncing…</span> : formatUnits(fundingBalance, funding.nativeDecimals, 5)}</div>
          </div>
          <div className="rounded-xl bg-gray-800/40 p-3">
            <div className="truncate text-xs text-gray-500">Your {token.symbol}</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-white">{holding === null ? <span className="text-gray-500">syncing…</span> : formatUnits(holding, token.decimals, 5)}</div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {balanceRetry && <span role="status" className="text-[11px] text-amber-400">Last loaded balances · refresh pending</span>}
          <span className="mr-1 text-xs text-gray-500">Slippage</span>
          {SLIPPAGES.map((value) => (
            <button key={value} onClick={() => setSlippage(value)} className={`pressable rounded-lg px-2.5 py-1 text-xs font-medium ${slippage === value ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>{value}%</button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {status !== 'idle' && (
            <motion.div key={status} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              className={`rounded-xl border p-3 ${status === 'error' ? 'border-amber-500/20 bg-amber-500/10' : status === 'done' ? 'border-green-500/20 bg-green-500/10' : 'border-gray-700/50 bg-gray-800/40'}`}>
              {status === 'ready' && summary ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span className="font-semibold uppercase tracking-wide text-gray-400">{summary.steps > 1 ? `Quote · ${summary.steps} steps` : 'Quote'}</span>
                    <span className={`font-mono ${secondsLeft <= 15 ? 'text-amber-300' : ''}`}>{expired ? 'expired' : `${secondsLeft}s`}</span>
                  </div>
                  {message && <p className="text-xs text-brand-200">{message}</p>}
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">You pay</dt><dd className="text-right font-mono text-white">{summary.pay}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">You get</dt><dd className="text-right font-mono text-white">{summary.receive}</dd></div>
                    {summary.minimum && <div className="flex justify-between gap-3"><dt className="text-gray-500">Minimum</dt><dd className="text-right font-mono text-gray-300">{summary.minimum}</dd></div>}
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">Route</dt><dd className="text-right text-gray-300">{summary.route}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-gray-500">Fee</dt><dd className="text-right text-gray-300">{summary.feeNote}</dd></div>
                  </dl>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => void confirm()} disabled={expired} className="pressable flex-1 rounded-xl bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-50">
                      {expired ? 'Quote expired' : summary.steps > 1 ? 'Confirm step 1' : 'Confirm'}
                    </button>
                    <button onClick={() => { setSummary(null); setStatus('idle'); }} className="pressable rounded-xl border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-300 hover:text-white">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  {status === 'error' ? <XCircle className="h-5 w-5 shrink-0 text-amber-300" />
                    : status === 'done' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-green-300" />
                      : status === 'bridging' ? <Zap className="h-5 w-5 shrink-0 animate-pulse text-brand-300" />
                        : <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-300" />}
                  <div className="space-y-1">
                    <p className="text-sm text-gray-200">{message}</p>
                    {explorerUrl && <a href={explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-200">View transaction <ExternalLink className="h-3 w-3" /></a>}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {mode === 'buy' ? (
          <>
            <div>
              <div className="mb-2 text-xs text-gray-500">Quick buy ({funding.nativeSymbol})</div>
              <div className="grid grid-cols-4 gap-2">
                {presets.map((preset) => (
                  <button key={preset} onClick={() => void quote('buy', preset)} disabled={busy}
                    className="pressable flex items-center justify-center gap-1 rounded-xl bg-gradient-to-r from-green-600/85 to-emerald-600/85 py-2.5 text-sm font-semibold text-white hover:from-green-500 hover:to-emerald-500 disabled:opacity-50">
                    <Rocket className="h-3.5 w-3.5" /> {preset}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <input type="number" min="0" inputMode="decimal" value={customAmount} onChange={(event) => setCustomAmount(event.target.value)} placeholder={`Custom ${funding.nativeSymbol} amount`}
                className="min-w-0 flex-1 rounded-xl border border-gray-700/50 bg-gray-800/60 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-brand-500/50 focus:outline-none" />
              <button onClick={() => void quote('buy', customAmount)} disabled={busy || !(Number(customAmount) > 0)}
                className="pressable rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                Quote
              </button>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {SELL_PRESETS.map((percent) => (
              <button key={percent} onClick={() => void quote('sell', percent)} disabled={busy}
                className="pressable flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-red-600/85 to-rose-600/85 py-3 text-sm font-semibold text-white hover:from-red-500 hover:to-rose-500 disabled:opacity-50">
                <TrendingDown className="h-3.5 w-3.5" /> {percent}%
              </button>
            ))}
          </div>
        )}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-gray-500">
          <Wallet className="mt-0.5 h-3 w-3 shrink-0" />
          {mode === 'sell'
            ? token.chainId === NEAR_CHAIN_ID
              ? `Sells the ${token.symbol} in your Hopr NEAR wallet for NEAR on Ref Finance.`
              : `Sells your Hopr-wallet ${token.symbol} position back to the coin you bought it with.`
            : `Buys ${token.symbol} on ${tokenNetwork?.name ?? 'its chain'}. Every trade shows a live quote first and only executes when you confirm. 0.5% Hopr fee.`}
        </p>
      </div>
    </div>
  );
}
