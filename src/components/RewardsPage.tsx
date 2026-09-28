import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Gift, Loader2, PenLine, Send, Share2, Users, Wallet } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { formatUsd } from '../services/chainDetector';
import { getNetwork } from '../services/chains';
import { apiUrl, TELEGRAM_BOT_URL } from '../services/api';
import {
  claimReferralRewards,
  getReferralCode,
  getReferralStats,
  inTelegram,
  inviteAwaitingSignature,
  pendingReferralCode,
  REFERRAL_SHARE_PERCENT,
  referralLink,
  referralsEnabled,
  telegramReferralLink,
  type ReferralIdentity,
  type ReferralStats,
} from '../services/referrals';
import ChainLogo from './ChainLogo';
import PageHeader from './PageHeader';

type Vm = 'evm' | 'svm' | 'near';
const VM_LABEL: Record<Vm, string> = { evm: 'EVM', svm: 'Solana', near: 'NEAR' };
const VM_LOGO: Record<Vm, string> = { evm: 'base', svm: 'sol', near: 'near' };

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? 'border-brand-400/30 bg-brand-500/10' : 'border-gray-800/50 bg-gray-900/60'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold ${accent ? 'text-brand-200' : 'text-white'}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-gray-500">{hint}</div>}
    </div>
  );
}

function LinkRow({ label, icon, link, onCopy, copied }: { label: string; icon: React.ReactNode; link: string; onCopy: (link: string) => void; copied: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-20 shrink-0 items-center gap-1.5 text-xs text-gray-400">{icon}{label}</span>
      <div className="flex min-w-0 flex-1 items-center rounded-xl border border-gray-700/60 bg-gray-950/60 px-3 py-2 font-mono text-xs text-gray-200 sm:text-sm">
        <span className="truncate">{link}</span>
      </div>
      <button onClick={() => onCopy(link)} aria-label={`Copy ${label} link`} className="pressable rounded-xl border border-gray-700 bg-gray-800/70 p-2.5 text-white hover:bg-gray-800">
        {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** Referral program: share a link, earn 25% of the Hopr fees your friends pay. */
export default function RewardsPage({ onBack }: { onBack: () => void }) {
  const wallet = useWallet();
  const telegram = inTelegram();
  const connected = (['evm', 'svm', 'near'] as const).filter((vm) => wallet.addressFor(vm));
  const [vm, setVm] = useState<Vm | null>(connected[0] ?? null);
  const address = vm ? wallet.addressFor(vm) : null;
  // In the Mini App the Telegram user owns the code (same as /referral in the bot).
  const identity: ReferralIdentity | null = telegram ? { telegram: true } : address ? { wallet: address } : null;
  const identityKey = telegram ? 'telegram' : address ?? '';
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [claimMessage, setClaimMessage] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [botUrl, setBotUrl] = useState(TELEGRAM_BOT_URL);
  const [accepting, setAccepting] = useState<Vm | null>(null);
  const [inviteNotice, setInviteNotice] = useState('');

  useEffect(() => {
    if (!vm || !wallet.addressFor(vm)) setVm(connected[0] ?? null);
  }, [connected.join(',')]);

  useEffect(() => {
    if (botUrl || !referralsEnabled) return;
    fetch(apiUrl('/api/config'))
      .then((response) => response.json() as Promise<{ telegramBot?: string | null }>)
      .then((config) => config.telegramBot && setBotUrl(`https://t.me/${config.telegramBot}`))
      .catch(() => undefined);
  }, [botUrl]);

  const load = useCallback(async () => {
    if (!identity || !referralsEnabled) return;
    setLoading(true);
    setError('');
    try {
      await getReferralCode(identity);
      setStats(await getReferralStats(identity));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Referral service unavailable.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  useEffect(() => {
    setStats(null);
    void load();
  }, [load]);

  const webLink = stats?.code ? referralLink(stats.code) : '';
  const tgLink = stats?.code && botUrl ? telegramReferralLink(stats.code, botUrl) : '';
  const primaryLink = telegram ? tgLink || webLink : webLink;
  const shareText = 'Trade any token on any chain in one tap with Hopr — join with my link:';

  const copy = (link: string) => {
    void navigator.clipboard?.writeText(link).catch(() => undefined);
    setCopied(link);
    window.setTimeout(() => setCopied(''), 1500);
  };

  const share = async () => {
    if (telegram && primaryLink && window.Telegram?.WebApp?.openTelegramLink) {
      window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(primaryLink)}&text=${encodeURIComponent(shareText)}`);
      return;
    }
    if (navigator.share) await navigator.share({ title: 'Hopr', text: shareText, url: primaryLink }).catch(() => undefined);
    else copy(primaryLink);
  };

  const claim = async () => {
    if (!identity) return;
    setClaiming(true);
    setClaimMessage('');
    try {
      const result = await claimReferralRewards(identity);
      setClaimMessage(`Payout of ${formatUsd(result.amountUsd)} requested — it will be sent in USDC to ${result.payoutWallet.slice(0, 6)}…${result.payoutWallet.slice(-4)}.`);
      await load();
    } catch (reason) {
      setClaimMessage(reason instanceof Error ? reason.message : 'Claim failed.');
    } finally {
      setClaiming(false);
    }
  };

  // Wallets that still have to sign the invite they arrived with.
  const invite = pendingReferralCode();
  const awaiting = connected.filter((option) => inviteAwaitingSignature(wallet.addressFor(option)));
  const accept = async (option: Vm) => {
    setAccepting(option);
    setInviteNotice('');
    const bound = await wallet.acceptReferralInvite(option);
    setAccepting(null);
    setInviteNotice(bound ? 'Invite accepted — thanks for joining!' : 'The invite was not applied (the signature was declined, or this wallet already has a referrer).');
  };

  const needsIdentity = !telegram && !address;

  return (
    <div className="text-white">
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <PageHeader icon={Gift} title="Rewards" subtitle={`Invite traders and earn ${REFERRAL_SHARE_PERCENT}% of the Hopr fees they pay`} onBack={onBack} />

        {invite && awaiting.length > 0 && (
          <section className="flex flex-col gap-3 rounded-2xl border border-brand-400/30 bg-brand-500/10 p-4 sm:flex-row sm:items-center">
            <PenLine className="h-5 w-5 shrink-0 text-brand-300" />
            <div className="flex-1 text-sm">
              <p className="font-medium text-white">You were invited with code <span className="font-mono">{invite}</span></p>
              <p className="text-xs text-gray-400">Accept it with a free signature — no transaction, no gas, no fee change.</p>
              {inviteNotice && <p className="mt-1 text-xs text-brand-200">{inviteNotice}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {awaiting.map((option) => (
                <button key={option} onClick={() => void accept(option)} disabled={accepting !== null}
                  className="pressable flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-brand-500 to-brand-400 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">
                  {accepting === option ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChainLogo chainKey={VM_LOGO[option]} size={14} />} Accept with {VM_LABEL[option]}
                </button>
              ))}
            </div>
          </section>
        )}

        {!referralsEnabled ? (
          <section className="rounded-2xl border border-gray-800/50 bg-gray-900/60 p-6 text-sm text-gray-400">
            The referral program runs on the Hopr API. Set <code className="text-gray-300">VITE_API_URL</code> to your deployed worker to enable it.
          </section>
        ) : needsIdentity ? (
          <section className="rounded-2xl border border-gray-800/50 bg-gray-900/60 p-8 text-center">
            <Wallet className="mx-auto mb-3 h-10 w-10 text-gray-600" />
            <p className="text-sm text-gray-300">Connect a wallet to get your referral link.</p>
            <p className="mt-1 text-xs text-gray-500">Rewards are paid to the wallet that owns the link. In Telegram, use /referral in the bot.</p>
            <button onClick={() => wallet.openWalletModal()} className="pressable mt-4 rounded-xl bg-gradient-to-r from-brand-500 to-brand-400 px-5 py-2.5 text-sm font-semibold text-white">Connect wallet</button>
          </section>
        ) : (
          <>
            <section className="overflow-hidden rounded-2xl border border-brand-400/30 bg-gradient-to-br from-brand-500/15 via-gray-900/70 to-gray-900/60 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-brand-300">Your invite links</p>
                  <p className="mt-1 text-sm text-gray-400">
                    {telegram
                      ? 'Your Telegram account’s code — the same one /referral shows in the bot.'
                      : `Earn ${REFERRAL_SHARE_PERCENT}% of the Hopr fees paid by everyone who joins with it.`}
                  </p>
                </div>
                {!telegram && connected.length > 1 && (
                  <div className="flex rounded-xl border border-gray-800/70 bg-gray-900/60 p-1">
                    {connected.map((option) => (
                      <button key={option} onClick={() => setVm(option)} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${vm === option ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>
                        <ChainLogo chainKey={VM_LOGO[option]} size={14} /> {VM_LABEL[option]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-4 space-y-2">
                {loading && !stats ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading your code…</div>
                ) : (
                  <>
                    {tgLink && <LinkRow label="Telegram" icon={<Send className="h-3.5 w-3.5" />} link={tgLink} onCopy={copy} copied={copied === tgLink} />}
                    {webLink && <LinkRow label="Web" icon={<Share2 className="h-3.5 w-3.5" />} link={webLink} onCopy={copy} copied={copied === webLink} />}
                  </>
                )}
              </div>
              {primaryLink && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <button onClick={() => void share()} className="pressable flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-500 to-brand-400 px-3 py-1.5 font-semibold text-white"><Share2 className="h-3.5 w-3.5" /> Share</button>
                  <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(primaryLink)}`} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-800 px-2.5 py-1.5 text-gray-300 hover:text-white">Post on X</a>
                  {!telegram && <a href={`https://t.me/share/url?url=${encodeURIComponent(tgLink || primaryLink)}&text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-800 px-2.5 py-1.5 text-gray-300 hover:text-white">Share on Telegram</a>}
                </div>
              )}
              {stats?.referredBy && <p className="mt-3 text-[11px] text-gray-500">You joined with code <span className="font-mono text-gray-400">{stats.referredBy}</span>.</p>}
            </section>

            {error && <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{error}</p>}

            <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
              <Stat label="Friends" value={String(stats?.referredUsers ?? 0)} />
              <Stat label="Their volume" value={formatUsd(stats?.volumeUsd ?? 0)} hint="Verified with route providers" />
              <Stat label="Fees they paid" value={formatUsd(stats?.feesUsd ?? 0)} hint="0.5% trades · 1% bridges" />
              <Stat label={`You earned (${REFERRAL_SHARE_PERCENT}%)`} value={formatUsd(stats?.earnedUsd ?? 0)} hint={stats?.pendingTrades ? `${stats.pendingTrades} trade(s) verifying` : undefined} accent />
              <Stat label="Paid out" value={formatUsd(stats?.paidUsd ?? 0)} hint={stats?.requestedUsd ? `${formatUsd(stats.requestedUsd)} requested` : undefined} />
              <div className="rounded-2xl border border-green-500/25 bg-green-500/5 p-4">
                <div className="text-xs text-gray-500">Claimable</div>
                <div className="mt-1 font-mono text-xl font-semibold text-green-400">{formatUsd(stats?.claimableUsd ?? 0)}</div>
                <button onClick={() => void claim()} disabled={claiming || !stats || (stats.claimableUsd ?? 0) < stats.minPayoutUsd}
                  className="pressable mt-2 w-full rounded-lg bg-green-600 py-1.5 text-xs font-semibold text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-40">
                  {claiming ? 'Requesting…' : `Claim (min ${formatUsd(stats?.minPayoutUsd ?? 5)})`}
                </button>
              </div>
            </section>
            {claimMessage && <p className="rounded-xl border border-gray-700/50 bg-gray-800/40 px-3 py-2 text-sm text-gray-200">{claimMessage}</p>}

            <section className="overflow-hidden rounded-2xl border border-gray-800/50 bg-gray-900/60">
              <div className="flex items-center gap-2 border-b border-gray-800/50 px-4 py-3"><Users className="h-4 w-4 text-brand-300" /><h2 className="text-sm font-semibold">Referred trades</h2></div>
              {!stats?.recent?.length ? (
                <p className="px-4 py-10 text-center text-sm text-gray-500">No referred trades yet. Share your link — rewards appear here once trades are verified.</p>
              ) : (
                <ul className="divide-y divide-gray-800/50 text-sm">
                  {stats.recent.map((trade, index) => (
                    <li key={`${trade.createdAt}-${index}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="flex min-w-0 items-center gap-2 text-gray-300">
                        <ChainLogo chainKey={getNetwork(trade.chainId)?.key ?? ''} size={16} />
                        <span className="truncate font-mono">{trade.wallet}</span>
                        <span className="hidden text-xs text-gray-500 sm:inline">{new Date(trade.createdAt).toLocaleDateString()}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="hidden font-mono text-gray-400 sm:inline">{trade.volumeUsd ? formatUsd(trade.volumeUsd) : '—'}</span>
                        <span className="font-mono text-gray-500" title="Hopr fee paid">{trade.feeUsd ? formatUsd(trade.feeUsd) : ''}</span>
                        <span className="font-mono text-green-400">{trade.rewardUsd ? `+${formatUsd(trade.rewardUsd)}` : ''}</span>
                        <span title={trade.reason ?? undefined} className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${trade.status === 'verified' ? 'bg-green-500/10 text-green-400' : trade.status === 'pending' ? 'bg-yellow-500/10 text-yellow-300' : 'bg-gray-800 text-gray-400'}`}>{trade.status}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <section className="rounded-2xl border border-gray-800/50 bg-gray-900/40 p-5 text-sm text-gray-400">
          <h2 className="mb-3 text-sm font-semibold text-white">How it works</h2>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Share your web or Telegram link. Friends who open it are linked to you for good (first link wins). Wallets accept the invite with a free signature; in Telegram the account itself is linked.</li>
            <li>You earn <span className="text-white">{REFERRAL_SHARE_PERCENT}% of the Hopr platform fee</span> on every trade they make — 0.5% on trades and 1% on bridges, so 0.125% / 0.25% of their volume. It comes out of Hopr&apos;s fee; they pay nothing extra.</li>
            <li>It syncs everywhere: trades in the Telegram bot, the Mini App and on the web all count toward the same account.</li>
            <li>Every trade is verified with the route provider (LI.FI, NEAR Intents, or the NEAR chain for Ref Finance swaps) before it counts. Claim once you reach the minimum; payouts are sent in USDC to your wallet.</li>
          </ol>
        </section>
      </main>
    </div>
  );
}
