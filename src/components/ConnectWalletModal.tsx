import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, ExternalLink, Loader2, LogOut, X } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import type { Vm } from '../services/chains';
import type { NearWalletOption } from '../services/wallets/near';
import { isMobileDevice, walletAppLinks, walletConnectEnabled } from '../services/wallets/mobile';
import ChainLogo from './ChainLogo';

const SECTIONS: Array<{ vm: Vm; title: string; logo: string; hint: string; install: { name: string; url: string } }> = [
  { vm: 'evm', title: 'EVM', logo: 'base', hint: 'Base · Arbitrum · BNB · Robinhood · Arc', install: { name: 'MetaMask', url: 'https://metamask.io/download/' } },
  { vm: 'svm', title: 'Solana', logo: 'sol', hint: 'Solana', install: { name: 'Phantom', url: 'https://phantom.com/download' } },
  { vm: 'near', title: 'NEAR', logo: 'near', hint: 'NEAR Protocol', install: { name: 'Meteor', url: 'https://wallet.meteorwallet.app/' } },
];

function short(address: string) {
  return address.length > 18 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function WalletButton({ name, icon, busy, onClick, disabled, badge }: { name: string; icon?: string; busy: boolean; onClick: () => void; disabled?: boolean; badge?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className="pressable flex w-full items-center gap-3 rounded-xl border border-gray-800/70 bg-gray-800/40 px-3 py-2.5 text-left text-sm font-medium text-white hover:border-brand-400/40 hover:bg-gray-800/70 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon ? <img src={icon} alt="" className="h-7 w-7 rounded-lg" /> : <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-700 text-xs font-bold">{name.slice(0, 1)}</span>}
      <span className="flex-1">{name}</span>
      {badge && <span className="rounded-md bg-gray-900/70 px-1.5 py-0.5 text-[10px] text-gray-400">{badge}</span>}
      {busy && <Loader2 className="h-4 w-4 animate-spin text-brand-300" />}
    </button>
  );
}

/** One place to connect EVM, Solana and NEAR wallets. */
export default function ConnectWalletModal() {
  const wallet = useWallet();
  const { walletModal, closeWalletModal } = wallet;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [nearWallets, setNearWallets] = useState<NearWalletOption[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!walletModal.open) return;
    setError('');
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && closeWalletModal();
    window.addEventListener('keydown', onKey);
    if (!nearWallets) {
      void import('../services/wallets/near')
        .then(({ listNearWallets }) => listNearWallets())
        .then(setNearWallets)
        .catch(() => setNearWallets([]));
    }
    return () => window.removeEventListener('keydown', onKey);
  }, [walletModal.open]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(/reject|denied|cancel/i.test(message) ? 'Connection request was rejected in the wallet.' : message);
    } finally {
      setBusy(null);
    }
  };

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(value);
    window.setTimeout(() => setCopied(null), 1500);
  };

  const mobile = isMobileDevice();
  const appLinks = walletModal.open ? walletAppLinks() : { evm: [], svm: [] };
  const connected: Record<Vm, { address: string; walletName: string } | null> = { evm: wallet.evm, svm: wallet.svm, near: wallet.near };
  const sections = walletModal.focus ? [...SECTIONS].sort((a, b) => (a.vm === walletModal.focus ? -1 : b.vm === walletModal.focus ? 1 : 0)) : SECTIONS;

  return (
    <AnimatePresence>
      {walletModal.open && (
        <motion.div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeWalletModal}>
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Connect wallets"
            onClick={(event) => event.stopPropagation()}
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-gray-800/70 bg-gray-900 p-5 shadow-2xl sm:rounded-3xl"
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Connect wallets</h2>
                <p className="mt-0.5 text-xs text-gray-500">Connect one per ecosystem. Hopr never sees your keys — every trade is signed in your wallet.</p>
              </div>
              <button onClick={closeWalletModal} className="pressable rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>

            <div className="space-y-4">
              {sections.map((section) => {
                const current = connected[section.vm];
                return (
                  <section key={section.vm} className={`rounded-2xl border p-3 ${walletModal.focus === section.vm ? 'border-brand-400/40 bg-brand-500/5' : 'border-gray-800/70'}`}>
                    <div className="mb-2.5 flex items-center gap-2">
                      <ChainLogo chainKey={section.logo} size={20} />
                      <h3 className="text-sm font-semibold text-white">{section.title}</h3>
                      <span className="truncate text-[11px] text-gray-500">{section.hint}</span>
                    </div>

                    {current ? (
                      <div className="flex items-center gap-2 rounded-xl bg-green-500/10 px-3 py-2.5">
                        <span className="h-2 w-2 rounded-full bg-green-400" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-sm text-white">{short(current.address)}</div>
                          <div className="text-[11px] text-gray-500">{current.walletName}</div>
                        </div>
                        <button onClick={() => copy(current.address)} className="pressable rounded-lg p-1.5 text-gray-400 hover:text-white" aria-label="Copy address">
                          {copied === current.address ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => void run(`${section.vm}-out`, async () => (section.vm === 'evm' ? wallet.disconnectEvm() : section.vm === 'svm' ? wallet.disconnectSolana() : wallet.disconnectNear()))}
                          className="pressable rounded-lg p-1.5 text-gray-400 hover:text-red-300"
                          aria-label={`Disconnect ${section.title}`}
                        >
                          <LogOut className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="grid gap-2">
                        {section.vm === 'evm' && wallet.evmWallets.map((item) => (
                          <WalletButton key={item.id} name={item.name} icon={item.icon} busy={busy === item.id} onClick={() => void run(item.id, () => wallet.connectEvm(item.id))} />
                        ))}
                        {section.vm === 'evm' && walletConnectEnabled && (
                          <WalletButton name="WalletConnect" icon="/brand/walletconnect.svg" badge={mobile ? 'Any mobile wallet' : 'QR code'} busy={busy === 'walletconnect'}
                            onClick={() => { closeWalletModal(); void run('walletconnect', () => wallet.connectEvm('walletconnect')); }} />
                        )}
                        {section.vm === 'svm' && wallet.solanaWallets.filter((item) => item.provider).map((item) => (
                          <WalletButton key={item.id} name={item.name} busy={busy === item.id} onClick={() => void run(item.id, () => wallet.connectSolana(item.id))} />
                        ))}
                        {section.vm === 'near' && (nearWallets === null
                          ? <div className="flex items-center gap-2 px-1 py-2 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading NEAR wallets…</div>
                          : nearWallets.map((item) => (
                            <WalletButton key={item.id} name={item.name} icon={item.iconUrl} busy={busy === item.id} disabled={!item.available} badge={item.available ? undefined : 'Not installed'} onClick={() => void run(item.id, () => wallet.connectNear(item.id))} />
                          )))}
                        {mobile && ((section.vm === 'evm' && !wallet.evmWallets.length) || (section.vm === 'svm' && !wallet.solanaWallets.some((item) => item.provider))) && (
                          <div className="rounded-xl border border-gray-800/70 p-2.5">
                            <p className="mb-2 text-[11px] text-gray-500">Open Hopr inside your wallet app to connect and trade:</p>
                            <div className="grid grid-cols-2 gap-1.5">
                              {appLinks[section.vm === 'evm' ? 'evm' : 'svm'].map((link) => (
                                <a key={link.id} href={link.href} className="pressable flex items-center justify-between rounded-lg bg-gray-800/60 px-2.5 py-2 text-xs font-medium text-white hover:bg-gray-800">
                                  {link.name} <ExternalLink className="h-3 w-3 text-gray-500" />
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                        {!mobile && ((section.vm === 'evm' && !wallet.evmWallets.length) || (section.vm === 'svm' && !wallet.solanaWallets.some((item) => item.provider))) && (
                          <a href={section.install.url} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl border border-dashed border-gray-700 px-3 py-2.5 text-sm text-gray-400 hover:text-white">
                            No {section.title} wallet detected — install {section.install.name}
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            {error && <p className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
            {wallet.telegramWallet && (
              <p className="mt-3 text-[11px] leading-relaxed text-gray-500">Your Telegram trading wallet is synced separately and stays in custody of the Hopr bot.</p>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
