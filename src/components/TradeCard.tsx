import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowDownUp, CheckCircle2, ExternalLink, Loader2, Rocket, Settings, TrendingDown, Wallet, XCircle, Zap } from 'lucide-react';
import { DetectedToken, formatUsd } from '../services/chainDetector';
import { getNetwork, NETWORKS, type Network } from '../services/chains';
import {
  describePlan,
  executePlan,
  feeBpsFor,
  getAssetBalance,
  nativeGasReserve,
  planRoute,
  previewPlan,
  PROVIDER_LABEL,
  stepProvider,
  waitForSourceConfirmation,
  type Asset,
  type RouteQuote,
  type RouteRequest,
} from '../services/router';
import { addActivity, updateActivity } from '../services/activity';
import { formatUnits, getTokenMetadata, parseUnits } from '../services/nearService';
import { getErc20Decimals } from '../services/wallets/evm';
import { getSplBalance } from '../services/wallets/solana';
import { useWallet } from '../context/WalletContext';
import { notify, usePreferences } from '../services/preferences';
import { reportReferralTrade } from '../services/referrals';
import ChainLogo from './ChainLogo';
import NearTradeCard from './NearTradeCard';
import HoprWalletTradeCard from './HoprWalletTradeCard';

interface TradeCardProps {
  token: DetectedToken | null;
}

type Phase = 'idle' | 'quoting' | 'approving' | 'signing' | 'confirming' | 'bridging' | 'done' | 'error';

const SELL_PRESETS = [25, 50, 100];
const SLIPPAGES = [0.5, 1, 3, 5];

/** Exact decimal string (no separators) for amounts sent back into parseUnits. */
function unitsToDecimal(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${units / base}.${fraction}` : `${units / base}`;
}

/** On-chain decimals for the traded token (market APIs don't report them reliably). */
async function resolveDecimals(token: DetectedToken): Promise<number> {
  const network = getNetwork(token.chainId);
  if (!network) return token.decimals;
  if (network.vm === 'evm') return getErc20Decimals(token.chainId, token.address).catch(() => token.decimals);
  if (network.vm === 'svm') return (await getSplBalance('11111111111111111111111111111111', token.address).catch(() => ({ decimals: token.decimals }))).decimals || token.decimals;
  return (await getTokenMetadata(token.address, { urls: [network.rpcUrl] }).catch(() => ({ decimals: token.decimals }))).decimals;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  quoting: 'Finding the best route…',
  approving: 'Approve the token in your wallet…',
  signing: 'Confirm in your wallet…',
  confirming: 'Waiting for confirmation…',
  bridging: 'Bridging — funds are on the way…',
  done: 'Done',
  error: '',
};

export default function TradeCard({ token }: TradeCardProps) {
  const wallet = useWallet();
  const [prefs] = usePreferences();
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [fundingChainId, setFundingChainId] = useState<number | null>(null);
  const [slippage, setSlippage] = useState(prefs.slippagePercent);
  const [showSettings, setShowSettings] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [quote, setQuote] = useState<RouteQuote | null>(null);
  const [explorerUrl, setExplorerUrl] = useState<string | undefined>();
  const [decimals, setDecimals] = useState<number | null>(null);
  const [fundingBalance, setFundingBalance] = useState<bigint | null>(null);
  const [holdings, setHoldings] = useState<bigint | null>(null);
  const [routePreview, setRoutePreview] = useState<{ path: string; via: string; steps: number } | null>(null);
  const [useExternalWallet, setUseExternalWallet] = useState(false);

  const tokenNetwork = token ? getNetwork(token.chainId) : undefined;
  // Default funding chain: Settings' choice, else the token's own chain (a same-chain swap is cheapest).
  const funding: Network = getNetwork(fundingChainId ?? prefs.defaultFundingChainId ?? token?.chainId ?? 8453) ?? NETWORKS[0];
  const busy = phase === 'quoting' || phase === 'approving' || phase === 'signing' || phase === 'confirming';

  useEffect(() => {
    setFundingChainId(null);
    setQuote(null);
    setPhase('idle');
    setMessage('');
    setDecimals(null);
    setHoldings(null);
    if (token) void resolveDecimals(token).then(setDecimals);
  }, [token?.address, token?.chainId]);

  const tokenAsset: Asset | null = useMemo(() => (token && decimals !== null
    ? { chainId: token.chainId, address: token.address, symbol: token.symbol, decimals }
    : null), [token?.address, token?.chainId, token?.symbol, decimals]);
  const nativeAsset: Asset = { chainId: funding.id, address: 'native', symbol: funding.nativeSymbol, decimals: funding.nativeDecimals };

  const fundingAddress = wallet.addressFor(funding.vm);
  const tokenAddressOwner = tokenNetwork ? wallet.addressFor(tokenNetwork.vm) : null;

  const refreshBalances = useCallback(async () => {
    const [paid, held] = await Promise.all([
      fundingAddress ? getAssetBalance(nativeAsset, fundingAddress).catch(() => undefined) : null,
      tokenAsset && tokenAddressOwner ? getAssetBalance(tokenAsset, tokenAddressOwner).catch(() => undefined) : null,
    ]);
    // undefined = read failed with nothing cached: keep what is on screen rather than blanking it.
    if (paid !== undefined) setFundingBalance(paid);
    if (held !== undefined) setHoldings(held);
  }, [fundingAddress, funding.id, tokenAsset, tokenAddressOwner]);

  // A different chain or wallet means a different balance: clear it until the new read lands.
  useEffect(() => {
    setFundingBalance(null);
  }, [funding.id, fundingAddress]);

  // Balances are tracked live: read now, then every 20 s (and after each trade).
  useEffect(() => {
    void refreshBalances();
    const timer = window.setInterval(() => void refreshBalances(), 20_000);
    return () => window.clearInterval(timer);
  }, [refreshBalances]);

  // Preview how the trade will route (e.g. "NEAR → ETH → DEGEN · NEAR Intents + LI.FI").
  useEffect(() => {
    if (!tokenAsset) return;
    let cancelled = false;
    const from = mode === 'buy' ? nativeAsset : tokenAsset;
    const to = mode === 'buy' ? tokenAsset : nativeAsset;
    planRoute({ kind: 'swap', from, to, amount: 1n, fromAddress: '', toAddress: '', slippage: 0.01 })
      .then((legs) => {
        if (cancelled) return;
        const providers = [...new Set(legs.map((leg) => PROVIDER_LABEL[stepProvider(leg)]))];
        setRoutePreview({ path: describePlan(legs), via: providers.join(' + '), steps: legs.length });
      })
      .catch(() => !cancelled && setRoutePreview(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenAsset, funding.id, mode]);

  // Inside the Telegram Mini App, trades default to the user's Hopr (bot) wallet — Telegram's
  // browser has no wallet extensions. NEAR tokens use Ref Finance; others use LI.FI / NEAR Intents.
  const inTelegramApp = Boolean(window.Telegram?.WebApp?.initData);
  if (token?.chainType === 'NEAR' && inTelegramApp && wallet.telegramWallet?.nearAddress && !wallet.near) {
    return <NearTradeCard token={token} />;
  }
  if (token && token.chainType !== 'NEAR' && inTelegramApp && wallet.telegramWallet && !useExternalWallet) {
    return <HoprWalletTradeCard token={token} onUseExternal={() => setUseExternalWallet(true)} />;
  }

  if (!token || !tokenNetwork) {
    return (
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="text-center py-8">
          <ArrowDownUp className="mx-auto mb-3 h-10 w-10 text-gray-600" />
          <p className="text-sm text-gray-400">Select a token to trade</p>
          <p className="mt-1 text-xs text-gray-500">Scan an address or pick one from Trending</p>
        </div>
      </div>
    );
  }

  const missingWallet = (vm: Network['vm']) => {
    const names = { evm: 'an EVM', svm: 'a Solana', near: 'a NEAR' };
    setPhase('error');
    setMessage(`Connect ${names[vm]} wallet to continue.`);
    wallet.openWalletModal(vm);
  };

  const run = async (side: 'buy' | 'sell', amount: bigint) => {
    if (!tokenAsset) return;
    const tokenAssetValue = tokenAsset;
    const from = side === 'buy' ? nativeAsset : tokenAsset;
    const to = side === 'buy' ? tokenAsset : nativeAsset;
    const fromNetwork = getNetwork(from.chainId)!;
    const toNetwork = getNetwork(to.chainId)!;
    const fromAddress = wallet.addressFor(fromNetwork.vm);
    const toAddress = wallet.addressFor(toNetwork.vm);
    if (!fromAddress) return missingWallet(fromNetwork.vm);
    if (!toAddress) return missingWallet(toNetwork.vm);

    setQuote(null);
    setExplorerUrl(undefined);
    setPhase('quoting');
    setMessage('');
    try {
      const balance = await getAssetBalance(from, fromAddress);
      const reserve = from.address === 'native' ? nativeGasReserve(from.chainId) : 0n;
      if (balance < amount + reserve) {
        throw new Error(`Not enough ${from.symbol} on ${fromNetwork.shortName}. You have ${formatUnits(balance, from.decimals, 6)}${reserve ? ' (keep a little for gas)' : ''}.`);
      }
      // One step for most pairs; NEAR ↔ tokens NEAR Intents doesn't list hop through a hub asset.
      // Every step is quoted up front, so a plan can't strand funds half-way.
      const { legs } = await previewPlan({ kind: 'swap', from, to, amount, fromAddress, toAddress, slippage: slippage / 100 });
      const isTraded = (asset: Asset) => asset.chainId === tokenAssetValue.chainId && asset.address.toLowerCase() === tokenAssetValue.address.toLowerCase();
      let last: { quote: RouteQuote; entryId: string; txHash: string; trackType: string } | null = null;
      setPhase('signing');
      await executePlan(legs, wallet.getSigners(), {
        onProgress: (progress) => {
          setPhase(/approve/i.test(progress) ? 'approving' : /on the way|arrive|waiting/i.test(progress) ? 'bridging' : /finding/i.test(progress) ? 'quoting' : 'signing');
          setMessage(progress);
        },
        onStepSent: (_step, stepQuote, result) => {
          const leg: RouteRequest = stepQuote.request;
          setQuote(stepQuote);
          setExplorerUrl(result.explorerUrl);
          if (feeBpsFor(leg) > 0) {
            reportReferralTrade({ wallet: leg.fromAddress, txHash: result.txHash, chainId: leg.from.chainId, provider: stepQuote.provider, depositAddress: stepQuote.intents?.depositAddress });
          }
          // The step that buys (or sells) the token is the trade; hub moves are recorded as bridges.
          const tradeStep = side === 'buy' ? isTraded(leg.to) : isTraded(leg.from);
          const entry = addActivity({
            kind: tradeStep ? 'swap' : 'bridge',
            side: tradeStep ? side : undefined,
            provider: stepQuote.provider,
            from: { ...leg.from, amount: leg.amount.toString() },
            to: { ...leg.to, amount: stepQuote.expectedOut.toString() },
            amountInUsd: stepQuote.amountInUsd,
            amountOutUsd: stepQuote.amountOutUsd,
            wallet: leg.fromAddress,
            txHash: result.txHash,
            explorerUrl: result.explorerUrl,
            track: result.track,
            status: result.track.type === 'final' ? 'done' : 'pending',
          });
          last = { quote: stepQuote, entryId: entry.id, txHash: result.txHash, trackType: result.track.type };
        },
      });
      const final = last as { quote: RouteQuote; entryId: string; txHash: string; trackType: string } | null;
      if (!final) throw new Error('The trade did not go through.');
      const finalLeg = final.quote.request;
      setPhase('confirming');
      setMessage('Waiting for the transaction to confirm…');
      if (final.txHash) await waitForSourceConfirmation(finalLeg.from.chainId, final.txHash).catch(() => undefined);
      if (finalLeg.from.chainId !== finalLeg.to.chainId && final.trackType !== 'final') {
        setPhase('bridging');
        setMessage(`Sent on ${getNetwork(finalLeg.from.chainId)?.shortName}. ${toNetwork.shortName} delivery usually takes ~${Math.max(1, Math.round((final.quote.durationSeconds ?? 60) / 60))} min — track it in History.`);
      } else {
        if (final.trackType === 'lifi') updateActivity(final.entryId, { status: 'done' });
        setPhase('done');
        const out = final.quote.expectedOut;
        const summary = side === 'buy' ? `Bought ≈ ${formatUnits(out, to.decimals, 6)} ${to.symbol}.` : `Sold for ≈ ${formatUnits(out, to.decimals, 6)} ${to.symbol}.`;
        setMessage(summary);
        notify('Trade complete', summary);
      }
      window.setTimeout(() => void refreshBalances(), 3000);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The trade did not go through.';
      setPhase('error');
      setMessage(/reject|denied|cancel/i.test(text) ? 'You rejected the request in your wallet. Nothing was sent.' : text);
    }
  };

  const buy = (amountText: string) => {
    try {
      void run('buy', parseUnits(amountText, funding.nativeDecimals));
    } catch {
      setPhase('error');
      setMessage('Enter a valid amount.');
    }
  };

  const sell = (percent: number) => {
    if (!holdings || holdings === 0n) {
      setPhase('error');
      if (!tokenAddressOwner) return missingWallet(tokenNetwork.vm);
      setMessage(`Your connected ${tokenNetwork.shortName} wallet holds no ${token.symbol}.`);
      return;
    }
    void run('sell', (holdings * BigInt(percent)) / 100n);
  };

  const crossChain = funding.id !== token.chainId;
  const outDecimals = mode === 'buy' ? decimals ?? token.decimals : funding.nativeDecimals;
  const outSymbol = mode === 'buy' ? token.symbol : funding.nativeSymbol;

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      <div className="flex border-b border-gray-800/50">
        {(['buy', 'sell'] as const).map((side) => (
          <button
            key={side}
            onClick={() => { setMode(side); setPhase('idle'); setQuote(null); }}
            className={`flex-1 py-3.5 text-sm font-semibold capitalize transition-all ${mode === side
              ? side === 'buy' ? 'text-green-400 bg-green-400/5 border-b-2 border-green-400' : 'text-red-400 bg-red-400/5 border-b-2 border-red-400'
              : 'text-gray-400 hover:text-white'}`}
          >
            {side}
          </button>
        ))}
        <button onClick={() => setShowSettings(!showSettings)} aria-label="Trade settings" className={`px-4 transition-all ${showSettings ? 'text-brand-400' : 'text-gray-400 hover:text-white'}`}>
          <Settings className="w-4 h-4" />
        </button>
      </div>

      <AnimatePresence>
        {showSettings && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-b border-gray-800/50">
            <div className="p-4">
              <label className="mb-2 block text-xs text-gray-400">Slippage tolerance</label>
              <div className="flex gap-2">
                {SLIPPAGES.map((value) => (
                  <button key={value} onClick={() => setSlippage(value)} className={`pressable rounded-lg px-3 py-1.5 text-xs font-medium ${slippage === value ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>{value}%</button>
                ))}
              </div>
              {slippage >= 5 && <p className="mt-2 flex items-center gap-1 text-xs text-yellow-400"><AlertTriangle className="h-3 w-3" /> High slippage can fill at a worse price.</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="p-4 space-y-4">
        {/* Pay-with chain (buy) / receive-on chain (sell) */}
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
            <span>{mode === 'buy' ? 'Pay with' : 'Receive on'}</span>
            {crossChain && <span className="flex items-center gap-1 text-brand-300"><Zap className="h-3 w-3" /> Cross-chain in one tap</span>}
          </div>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {NETWORKS.map((network) => {
              const active = funding.id === network.id;
              const connected = Boolean(wallet.addressFor(network.vm));
              return (
                <button
                  key={network.id}
                  onClick={() => { setFundingChainId(network.id); setPhase('idle'); }}
                  title={`${network.name} (${network.nativeSymbol})${connected ? '' : ' — wallet not connected'}`}
                  className={`pressable relative flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[10px] font-medium ${active ? 'border-brand-400/60 bg-brand-500/15 text-white' : 'border-gray-800/70 bg-gray-800/30 text-gray-400 hover:text-white'}`}
                >
                  <ChainLogo chainKey={network.key} size={20} />
                  {network.nativeSymbol}
                  {connected && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-green-400" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Balances */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-gray-800/40 p-3">
            <div className="text-xs text-gray-500">{funding.nativeSymbol} on {funding.shortName}</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-white">{fundingAddress ? (fundingBalance === null ? '…' : formatUnits(fundingBalance, funding.nativeDecimals, 5)) : '—'}</div>
          </div>
          <div className="rounded-xl bg-gray-800/40 p-3">
            <div className="truncate text-xs text-gray-500">Your {token.symbol}</div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-white">{tokenAddressOwner ? (holdings === null || decimals === null ? '…' : formatUnits(holdings, decimals, 5)) : '—'}</div>
          </div>
        </div>

        {/* Status */}
        <AnimatePresence mode="wait">
          {phase !== 'idle' && (
            <motion.div key={phase} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              className={`rounded-xl border p-3 ${phase === 'error' ? 'border-amber-500/20 bg-amber-500/10' : phase === 'done' ? 'border-green-500/20 bg-green-500/10' : 'border-gray-700/50 bg-gray-800/40'}`}
            >
              <div className="flex items-start gap-2">
                {phase === 'error' ? <XCircle className="h-5 w-5 shrink-0 text-amber-300" />
                  : phase === 'done' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-green-300" />
                    : phase === 'bridging' ? <Zap className="h-5 w-5 shrink-0 text-brand-300" />
                      : <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-300" />}
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-sm text-gray-200">{message || PHASE_LABEL[phase]}</p>
                  {quote && phase !== 'error' && (
                    <p className="font-mono text-[11px] text-gray-400">
                      ≈ {formatUnits(quote.expectedOut, outDecimals, 6)} {outSymbol} · min {formatUnits(quote.minOut, outDecimals, 6)}
                      {quote.amountInUsd ? ` · ${formatUsd(quote.amountInUsd)}` : ''} · {quote.via}
                    </p>
                  )}
                  {explorerUrl && (
                    <a href={explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-300 hover:text-brand-200">View transaction <ExternalLink className="h-3 w-3" /></a>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!fundingAddress && (
          <button onClick={() => wallet.openWalletModal(funding.vm)} className="pressable flex w-full items-center justify-center gap-2 rounded-xl border border-brand-400/30 bg-brand-500/15 py-2.5 text-sm font-semibold text-brand-100 hover:bg-brand-500/25">
            <Wallet className="h-4 w-4" /> Connect {funding.vm === 'evm' ? 'EVM' : funding.vm === 'svm' ? 'Solana' : 'NEAR'} wallet
          </button>
        )}

        {mode === 'buy' ? (
          <>
            <div>
              <div className="mb-2 text-xs text-gray-500">One-tap buy ({funding.nativeSymbol})</div>
              <div className="grid grid-cols-4 gap-2">
                {funding.quickBuy.map((preset) => (
                  <button key={preset} onClick={() => buy(preset)} disabled={busy || decimals === null}
                    className="pressable flex items-center justify-center gap-1 rounded-xl bg-gradient-to-r from-green-600/85 to-emerald-600/85 py-2.5 text-sm font-semibold text-white hover:from-green-500 hover:to-emerald-500 disabled:opacity-50">
                    <Rocket className="h-3.5 w-3.5" /> {preset}
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
                placeholder={`Custom ${funding.nativeSymbol} amount`}
                className="min-w-0 flex-1 rounded-xl border border-gray-700/50 bg-gray-800/60 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-brand-500/50 focus:outline-none"
              />
              <button onClick={() => buy(customAmount)} disabled={busy || decimals === null || !(Number(customAmount) > 0)}
                className="pressable rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:from-green-500 hover:to-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
                Buy
              </button>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {SELL_PRESETS.map((percent) => (
              <button key={percent} onClick={() => sell(percent)} disabled={busy || decimals === null}
                className="pressable flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-red-600/85 to-rose-600/85 py-3 text-sm font-semibold text-white hover:from-red-500 hover:to-rose-500 disabled:opacity-50">
                <TrendingDown className="h-3.5 w-3.5" /> {percent}%
              </button>
            ))}
          </div>
        )}

        <div className="space-y-1 border-t border-gray-800/50 pt-3 text-[11px] text-gray-500">
          <div className="flex justify-between gap-3"><span>Route</span><span className="truncate text-right text-gray-400">{crossChain ? `${funding.shortName} → ${tokenNetwork.shortName}` : tokenNetwork.shortName} · {routePreview?.via ?? '…'}</span></div>
          {routePreview && routePreview.steps > 1 && (
            <div className="flex justify-between gap-3"><span>Path</span><span className="truncate text-right text-gray-400">{routePreview.path} · {routePreview.steps} steps</span></div>
          )}
          <div className="flex justify-between"><span>Hopr fee</span><span className="text-gray-400">0.5% · charged once</span></div>
          <div className="flex justify-between"><span>Slippage</span><span className="text-gray-400">{slippage}%</span></div>
          <div className="flex justify-between"><span>Execution</span><span className="text-gray-400">Signed in your wallet · non-custodial</span></div>
        </div>
      </div>
    </div>
  );
}
