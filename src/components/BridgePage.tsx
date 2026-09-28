import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, CheckCircle2, Clock, ExternalLink, Loader2, Wallet, XCircle, Zap } from 'lucide-react';
import { formatUsd } from '../services/chainDetector';
import { getNetwork, NETWORKS, explorerTxLink, type Network } from '../services/chains';
import { executePlan, feeBpsFor, getAssetBalance, nativeGasReserve, previewPlan, waitForSourceConfirmation, type Asset, type RouteQuote } from '../services/router';
import { addActivity, useActivity } from '../services/activity';
import { formatUnits, isNearAccountId, parseUnits } from '../services/nearService';
import { useWallet } from '../context/WalletContext';
import { getPreferences } from '../services/preferences';
import { reportReferralTrade } from '../services/referrals';
import ChainLogo from './ChainLogo';
import PageHeader from './PageHeader';

type AssetKind = 'native' | 'usdc';

function assetFor(network: Network, kind: AssetKind): Asset {
  if (kind === 'usdc' && network.usdc) return { chainId: network.id, address: network.usdc.address, symbol: 'USDC', decimals: network.usdc.decimals };
  return { chainId: network.id, address: 'native', symbol: network.nativeSymbol, decimals: network.nativeDecimals };
}

function isValidRecipient(network: Network, address: string): boolean {
  if (network.vm === 'evm') return /^0x[a-fA-F0-9]{40}$/.test(address);
  if (network.vm === 'svm') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return isNearAccountId(address.toLowerCase());
}

/** Placeholder addresses let LI.FI price a route before a wallet is connected (quotes only). */
const PREVIEW_ADDRESS: Record<Network['vm'], string> = {
  evm: '0x1111111111111111111111111111111111111111',
  svm: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  near: 'hopr-preview.near',
};

function AssetPicker({ label, network, kind, onNetwork, onKind, exclude }: {
  label: string; network: Network; kind: AssetKind; onNetwork: (network: Network) => void; onKind: (kind: AssetKind) => void; exclude?: number;
}) {
  return (
    <div>
      <div className="mb-2 text-xs text-gray-500">{label}</div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"><ChainLogo chainKey={network.key} size={20} /></span>
          <select
            value={network.id}
            onChange={(event) => onNetwork(getNetwork(Number(event.target.value))!)}
            className="w-full appearance-none rounded-xl border border-gray-700/60 bg-gray-800/60 py-2.5 pl-10 pr-3 text-sm font-medium text-white focus:border-brand-500/50 focus:outline-none"
          >
            {NETWORKS.filter((item) => item.id !== exclude).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="flex rounded-xl border border-gray-700/60 bg-gray-800/60 p-1">
          {(['native', 'usdc'] as const).map((option) => {
            const available = option === 'native' || Boolean(network.usdc);
            const text = option === 'native' ? network.nativeSymbol : 'USDC';
            return (
              <button key={option} disabled={!available} onClick={() => onKind(option)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${kind === option ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-white disabled:opacity-30'}`}>
                {text}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function BridgePage({ onBack }: { onBack: () => void }) {
  const wallet = useWallet();
  const activity = useActivity();
  const [fromNetwork, setFromNetwork] = useState<Network>(getNetwork(8453)!);
  const [toNetwork, setToNetwork] = useState<Network>(getNetwork(42161)!);
  const [fromKind, setFromKind] = useState<AssetKind>('native');
  const [toKind, setToKind] = useState<AssetKind>('native');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(() => Math.min(2, getPreferences().slippagePercent));
  const [customRecipient, setCustomRecipient] = useState('');
  const [useCustomRecipient, setUseCustomRecipient] = useState(false);
  const [preview, setPreview] = useState<RouteQuote | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [previewError, setPreviewError] = useState('');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<'idle' | 'working' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);

  const from = assetFor(fromNetwork, fromKind);
  const to = assetFor(toNetwork, toKind);
  const fromAddress = wallet.addressFor(fromNetwork.vm);
  const connectedRecipient = wallet.addressFor(toNetwork.vm);
  const recipient = useCustomRecipient ? customRecipient.trim() : connectedRecipient ?? '';
  const recipientValid = recipient ? isValidRecipient(toNetwork, recipient) : false;

  const amountUnits = useMemo(() => {
    try {
      return amount && Number(amount) > 0 ? parseUnits(amount, from.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [amount, from.decimals]);

  useEffect(() => {
    if (!fromNetwork.usdc) setFromKind('native');
    if (!toNetwork.usdc) setToKind('native');
  }, [fromNetwork.id, toNetwork.id]);

  useEffect(() => {
    setBalance(null);
    if (!fromAddress) return;
    let cancelled = false;
    void getAssetBalance(from, fromAddress).then((value) => !cancelled && setBalance(value)).catch(() => undefined);
    return () => { cancelled = true; };
  }, [fromAddress, from.chainId, from.address]);

  // Live preview quote (side-effect free).
  useEffect(() => {
    setPreview(null);
    if (amountUnits <= 0n || (from.chainId === to.chainId && from.address === to.address)) {
      setPreviewState('idle');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewState('loading');
      setPreviewError('');
      try {
        // Routes NEAR Intents can't take directly (e.g. Arc ↔ NEAR) are previewed end to end across their steps.
        const quote = await previewPlan({
          kind: 'bridge', from, to, amount: amountUnits, slippage: slippage / 100,
          fromAddress: fromAddress ?? PREVIEW_ADDRESS[fromNetwork.vm],
          toAddress: recipientValid ? recipient : PREVIEW_ADDRESS[toNetwork.vm],
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPreview(quote);
        setPreviewState('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreviewState('error');
        setPreviewError(error instanceof Error ? error.message : 'No route found.');
      }
    }, 600);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [amountUnits, from.chainId, from.address, to.chainId, to.address, slippage, fromAddress, recipientValid ? recipient : '']);

  const flip = () => {
    setFromNetwork(toNetwork);
    setToNetwork(fromNetwork);
    setFromKind(toKind);
    setToKind(fromKind);
    setAmount('');
  };

  const setMax = () => {
    if (balance === null) return;
    const reserve = from.address === 'native' ? nativeGasReserve(from.chainId) : 0n;
    const max = balance > reserve ? balance - reserve : 0n;
    setAmount(formatUnits(max, from.decimals, from.decimals).replace(/,/g, ''));
  };

  const bridge = async () => {
    if (!fromAddress) return wallet.openWalletModal(fromNetwork.vm);
    if (!recipientValid) {
      if (!useCustomRecipient && !connectedRecipient) return wallet.openWalletModal(toNetwork.vm);
      setPhase('error');
      setMessage(`Enter a valid ${toNetwork.name} address.`);
      return;
    }
    setPhase('working');
    setMessage('Getting a fresh route…');
    try {
      const current = await getAssetBalance(from, fromAddress);
      const reserve = from.address === 'native' ? nativeGasReserve(from.chainId) : 0n;
      if (current < amountUnits + reserve) throw new Error(`Not enough ${from.symbol} on ${fromNetwork.shortName}.`);
      // Quote every step first (with the via-Base fallback) so nothing is sent unless the whole route works.
      const { legs } = await previewPlan({ kind: 'bridge', from, to, amount: amountUnits, fromAddress, toAddress: recipient, slippage: slippage / 100 });
      let last: { chainId: number; txHash: string } | null = null;
      await executePlan(legs, wallet.getSigners(), {
        onProgress: (progress) => setMessage(progress),
        onStepSent: (_step, quote, result) => {
          const leg = quote.request;
          if (feeBpsFor(leg) > 0) {
            reportReferralTrade({ wallet: leg.fromAddress, txHash: result.txHash, chainId: leg.from.chainId, provider: quote.provider, depositAddress: quote.intents?.depositAddress });
          }
          const entry = addActivity({
            kind: 'bridge',
            provider: quote.provider,
            from: { ...leg.from, amount: leg.amount.toString() },
            to: { ...leg.to, amount: quote.expectedOut.toString() },
            amountInUsd: quote.amountInUsd,
            amountOutUsd: quote.amountOutUsd,
            wallet: leg.fromAddress,
            txHash: result.txHash,
            explorerUrl: result.explorerUrl,
            track: result.track,
            status: result.track.type === 'final' ? 'done' : 'pending',
          });
          setActiveEntryId(entry.id);
          last = { chainId: leg.from.chainId, txHash: result.txHash };
        },
      });
      setMessage('Waiting for the source transaction to confirm…');
      const sent = last as { chainId: number; txHash: string } | null;
      if (sent?.txHash) await waitForSourceConfirmation(sent.chainId, sent.txHash).catch(() => undefined);
      setPhase('idle');
      setMessage('');
      setAmount('');
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Bridge failed.';
      setPhase('error');
      setMessage(/reject|denied|cancel/i.test(text) ? 'You rejected the request in your wallet. Nothing was sent.' : text);
    }
  };

  const active = activity.find((entry) => entry.id === activeEntryId);
  const recentBridges = activity.filter((entry) => entry.kind === 'bridge').slice(0, 5);
  const insufficient = balance !== null && amountUnits > 0n && amountUnits > balance;

  return (
    <div className="text-white">
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <PageHeader icon={Zap} title="Bridge" subtitle="Move native coins and USDC between 7 chains — signed in your own wallet" onBack={onBack} />

        <section className="rounded-2xl border border-gray-800/50 bg-gray-900/60 p-5 space-y-4">
          <AssetPicker label="From" network={fromNetwork} kind={fromKind} onNetwork={setFromNetwork} onKind={setFromKind} />

          <div className="rounded-xl bg-gray-800/40 p-3">
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>Amount</span>
              <span className="flex items-center gap-2">
                {fromAddress ? <>Balance: <span className="font-mono text-gray-300">{balance === null ? '…' : formatUnits(balance, from.decimals, 6)}</span></> : 'Wallet not connected'}
                {balance !== null && balance > 0n && <button onClick={setMax} className="rounded-md bg-brand-500/20 px-1.5 py-0.5 font-semibold text-brand-200 hover:bg-brand-500/30">MAX</button>}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <input type="number" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0"
                className="min-w-0 flex-1 bg-transparent font-mono text-2xl font-semibold text-white placeholder-gray-600 focus:outline-none" />
              <span className="text-sm font-semibold text-gray-300">{from.symbol}</span>
            </div>
            {insufficient && <p className="mt-1 text-xs text-red-400">Amount exceeds your balance.</p>}
          </div>

          <div className="flex justify-center">
            <button onClick={flip} className="pressable rounded-full border border-gray-700 bg-gray-800 p-2 hover:border-brand-500/50" aria-label="Swap direction">
              <ArrowDown className="h-5 w-5 text-brand-400" />
            </button>
          </div>

          <AssetPicker label="To" network={toNetwork} kind={toKind} onNetwork={setToNetwork} onKind={setToKind} />

          <div className="rounded-xl bg-gray-800/40 p-3">
            <div className="text-xs text-gray-500">You receive (estimated)</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="font-mono text-2xl font-semibold text-white">
                {previewState === 'loading' ? <Loader2 className="h-6 w-6 animate-spin text-gray-500" /> : preview ? formatUnits(preview.expectedOut, to.decimals, 6) : '0.0'}
              </div>
              <span className="text-sm font-semibold text-gray-300">{to.symbol}{toNetwork.vm === 'near' && to.address === 'native' ? ' (as wNEAR)' : ''}</span>
            </div>
            {preview && <div className="mt-1 text-xs text-gray-500">Minimum {formatUnits(preview.minOut, to.decimals, 6)} {to.symbol}{preview.amountOutUsd ? ` · ${formatUsd(preview.amountOutUsd)}` : ''}</div>}
            {previewState === 'error' && <p className="mt-1 text-xs text-amber-300">{previewError}</p>}
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>Recipient on {toNetwork.shortName}</span>
              <button onClick={() => setUseCustomRecipient(!useCustomRecipient)} className="text-brand-300 hover:text-brand-200">{useCustomRecipient ? 'Use my wallet' : 'Send elsewhere'}</button>
            </div>
            {useCustomRecipient ? (
              <input value={customRecipient} onChange={(event) => setCustomRecipient(event.target.value)} placeholder={`${toNetwork.name} address`}
                className={`mt-1.5 w-full rounded-xl border bg-gray-800/60 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-500 focus:outline-none ${customRecipient && !recipientValid ? 'border-red-500/50' : 'border-gray-700/60 focus:border-brand-500/50'}`} />
            ) : (
              <div className="mt-1.5 rounded-xl border border-gray-800/70 px-3 py-2.5 font-mono text-sm text-gray-300">
                {connectedRecipient ?? <button onClick={() => wallet.openWalletModal(toNetwork.vm)} className="font-sans text-brand-300 hover:text-brand-200">Connect a {toNetwork.vm === 'evm' ? 'EVM' : toNetwork.vm === 'svm' ? 'Solana' : 'NEAR'} wallet to receive</button>}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Slippage</span>
            <div className="flex gap-1">
              {[0.5, 1, 2].map((value) => (
                <button key={value} onClick={() => setSlippage(value)} className={`rounded-md px-2 py-1 font-medium ${slippage === value ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>{value}%</button>
              ))}
            </div>
          </div>

          {preview && (
            <div className="space-y-1.5 rounded-xl border border-gray-800/70 p-3 text-xs">
              <div className="flex justify-between"><span className="text-gray-500">Route</span><span className="text-gray-300">{preview.via}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Estimated time</span><span className="flex items-center gap-1 text-gray-300"><Clock className="h-3 w-3" />{preview.durationSeconds ? `~${Math.max(1, Math.round(preview.durationSeconds / 60))} min` : 'a few minutes'}</span></div>
              {preview.gasUsd ? <div className="flex justify-between"><span className="text-gray-500">Network fee</span><span className="text-gray-300">≈ {formatUsd(preview.gasUsd)}</span></div> : null}
              {preview.fees.map((fee) => <div key={fee} className="flex justify-between"><span className="text-gray-500">Fees</span><span className="text-gray-300">{fee}</span></div>)}
            </div>
          )}

          {phase !== 'idle' && message && (
            <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${phase === 'error' ? 'border-amber-500/20 bg-amber-500/10 text-amber-200' : 'border-gray-700/50 bg-gray-800/40 text-gray-200'}`}>
              {phase === 'error' ? <XCircle className="h-4 w-4 shrink-0" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
              {message}
            </div>
          )}

          <button
            onClick={() => void bridge()}
            disabled={phase === 'working' || amountUnits <= 0n || insufficient || (fromNetwork.id === toNetwork.id && fromKind === toKind)}
            className="pressable flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-brand-400 py-3.5 text-base font-semibold text-white shadow-[0_10px_30px_-12px_rgba(63,176,170,0.8)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!fromAddress ? <><Wallet className="h-5 w-5" /> Connect {fromNetwork.shortName} wallet</>
              : phase === 'working' ? <><Loader2 className="h-5 w-5 animate-spin" /> Bridging…</>
                : <><Zap className="h-5 w-5" /> Bridge {from.symbol} → {toNetwork.shortName}</>}
          </button>
        </section>

        {active && (
          <section className="mt-4 rounded-2xl border border-brand-400/30 bg-brand-500/5 p-4">
            <div className="mb-3 text-sm font-semibold text-white">Transfer in progress</div>
            <ol className="space-y-2 text-sm">
              <li className="flex items-center gap-2 text-gray-200"><CheckCircle2 className="h-4 w-4 text-green-400" /> Sent {formatUnits(active.from.amount, active.from.decimals, 6)} {active.from.symbol} on {getNetwork(active.from.chainId)?.shortName}
                {active.explorerUrl && <a href={active.explorerUrl} target="_blank" rel="noreferrer" className="text-brand-300"><ExternalLink className="h-3.5 w-3.5" /></a>}</li>
              <li className="flex items-center gap-2 text-gray-200">
                {active.status === 'done' ? <CheckCircle2 className="h-4 w-4 text-green-400" /> : active.status === 'pending' ? <Loader2 className="h-4 w-4 animate-spin text-brand-300" /> : <XCircle className="h-4 w-4 text-red-400" />}
                {active.status === 'done' ? `Delivered on ${getNetwork(active.to.chainId)?.shortName}` : active.status === 'pending' ? `Delivering to ${getNetwork(active.to.chainId)?.shortName}${active.statusDetail ? ` · ${active.statusDetail}` : ''}` : active.statusDetail ?? 'Transfer failed'}
                {active.receivingTxHash && explorerTxLink(active.to.chainId, active.receivingTxHash) && <a href={explorerTxLink(active.to.chainId, active.receivingTxHash)} target="_blank" rel="noreferrer" className="text-brand-300"><ExternalLink className="h-3.5 w-3.5" /></a>}
              </li>
            </ol>
          </section>
        )}

        {recentBridges.length > 0 && (
          <section className="mt-4 rounded-2xl border border-gray-800/50 bg-gray-900/40 p-4">
            <div className="mb-2 text-sm font-semibold text-white">Your recent bridges</div>
            <div className="space-y-1.5">
              {recentBridges.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between rounded-xl bg-gray-800/30 px-3 py-2 text-xs">
                  <span className="flex items-center gap-1.5 text-gray-300">
                    <ChainLogo chainKey={getNetwork(entry.from.chainId)?.key ?? ''} size={16} /> → <ChainLogo chainKey={getNetwork(entry.to.chainId)?.key ?? ''} size={16} />
                    <span className="font-mono">{formatUnits(entry.from.amount, entry.from.decimals, 5)} {entry.from.symbol}</span>
                  </span>
                  <span className={entry.status === 'done' ? 'text-green-400' : entry.status === 'pending' ? 'text-brand-300' : 'text-red-400'}>{entry.status}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
