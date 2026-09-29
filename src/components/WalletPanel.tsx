import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronUp, Copy, ExternalLink, Plus, RefreshCw, Wallet } from 'lucide-react';
import { formatUsd } from '../services/chainDetector';
import { useWallet } from '../context/WalletContext';
import { usePortfolio } from '../hooks/usePortfolio';
import { TELEGRAM_BOT_URL } from '../services/api';
import ChainLogo from './ChainLogo';

function short(address: string) {
  return address.length > 18 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Live portfolio of the connected wallets: native balances on every chain, priced in USD. */
export default function WalletPanel() {
  const wallet = useWallet();
  const { rows, totalUsd, incomplete, loading, updatedAt, refresh } = usePortfolio();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [walletMessage, setWalletMessage] = useState('');

  const connections = [
    { vm: 'evm' as const, label: 'EVM', logo: 'base', info: wallet.evm },
    { vm: 'svm' as const, label: 'Solana', logo: 'sol', info: wallet.svm },
    { vm: 'near' as const, label: 'NEAR', logo: 'near', info: wallet.near },
  ];
  const anyConnected = connections.some((item) => item.info) || Boolean(wallet.telegramWallet);
  const funded = rows.filter((row) => row.balance === null || row.balance > 0n || row.stale);
  const empty = rows.filter((row) => row.balance === 0n && !row.stale);

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(value);
    window.setTimeout(() => setCopied(null), 1500);
  };

  const createTelegramWallet = async () => {
    setWalletMessage('');
    try {
      await wallet.createTelegramWallet();
      setWalletMessage('Your encrypted Hopr wallet is ready.');
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : 'Wallet creation failed.');
    }
  };

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      <div className="p-4 border-b border-gray-800/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-brand-400" />
            <h3 className="font-semibold text-white">Portfolio</h3>
          </div>
          <button onClick={() => void refresh()} className="pressable p-1.5 rounded-lg hover:bg-gray-800" aria-label="Refresh balances">
            <RefreshCw className={`w-4 h-4 text-gray-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="mt-2">
          <div className="font-mono text-2xl font-semibold tracking-tight text-white">{anyConnected && rows.some((row) => row.usd !== null) ? `${incomplete ? '≈ ' : ''}${formatUsd(totalUsd)}` : anyConnected ? 'Syncing…' : '—'}</div>
          {incomplete && <p className="text-[11px] text-amber-400">Partial estimate · retrying pending balances</p>}
          <div className="text-xs text-gray-500">
            {anyConnected
              ? `Native balances across ${rows.length} network${rows.length === 1 ? '' : 's'}${updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
              : 'Connect a wallet to see live balances'}
          </div>
        </div>
      </div>

      {/* Connections */}
      <div className="px-4 py-3 border-b border-gray-800/30 space-y-1.5">
        {connections.map(({ vm, label, logo, info }) => (
          <div key={vm} className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <ChainLogo chainKey={logo} size={16} />
              <span className="w-12 text-xs text-gray-500">{label}</span>
              {info ? <span className="truncate font-mono text-xs text-gray-300" title={info.address}>{short(info.address)}</span> : <span className="text-xs text-gray-600">Not connected</span>}
            </div>
            {info ? (
              <button onClick={() => copy(info.address)} className="p-1 hover:bg-gray-800 rounded transition-colors" aria-label={`Copy ${label} address`}>
                {copied === info.address ? <span className="text-xs text-green-400">✓</span> : <Copy className="w-3 h-3 text-gray-500" />}
              </button>
            ) : (
              <button onClick={() => wallet.openWalletModal(vm)} className="pressable flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-brand-300 hover:bg-gray-800">
                <Plus className="h-3 w-3" /> Connect
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Balances */}
      {anyConnected && (
        <div className="px-4 py-2">
          <button onClick={() => setExpanded(!expanded)} className="flex items-center justify-between w-full py-2 text-xs text-gray-400 hover:text-white transition-colors">
            <span>Chain breakdown</span>
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="space-y-1.5 pb-2">
                  {loading && !rows.length && [0, 1, 2].map((index) => <div key={index} className="skeleton h-11 rounded-xl" />)}
                  {funded.map((row) => (
                    <div key={row.network.id} className="flex items-center justify-between rounded-xl bg-gray-800/30 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <ChainLogo chainKey={row.network.key} size={22} />
                        <div>
                          <div className="text-xs font-medium text-white">{row.network.shortName}</div>
                          <div className="font-mono text-[11px] text-gray-500">{row.formatted} {row.network.nativeSymbol}</div>
                          {row.stale && <div className="text-[10px] text-amber-400">Last known {row.observedAt ? new Date(row.observedAt).toLocaleTimeString() : ''} · retrying</div>}
                        </div>
                      </div>
                      <div className="font-mono text-xs font-medium text-white">{row.usd === null ? '—' : formatUsd(row.usd)}</div>
                    </div>
                  ))}
                  {empty.length > 0 && (
                    <p className="px-1 pt-1 text-[11px] text-gray-600">Empty: {empty.map((row) => row.network.shortName).join(' · ')}</p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {wallet.telegramUser && !wallet.telegramWallet && !wallet.isTelegramSyncing && (
        <div className="px-4 pb-3">
          <button onClick={createTelegramWallet} className="w-full rounded-xl border border-brand-400/30 bg-gradient-to-r from-brand-500/20 to-brand-400/15 px-3 py-2.5 text-left transition hover:border-brand-300/60">
            <span className="block text-sm font-semibold text-brand-200">Create your Hopr Telegram wallet</span>
            <span className="mt-0.5 block text-xs text-gray-400">Encrypted custody for trading from the bot</span>
          </button>
          {walletMessage && <div className="mt-2 text-xs text-brand-200">{walletMessage}</div>}
        </div>
      )}

      <div className="px-4 py-3 border-t border-gray-800/30 flex items-center justify-between gap-2">
        <button onClick={() => wallet.openWalletModal()} className="pressable text-xs font-medium text-brand-300 hover:text-brand-200">Manage wallets</button>
        {TELEGRAM_BOT_URL && (
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noreferrer" className="pressable flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-white">
            <ExternalLink className="w-3 h-3" /> Telegram bot
          </a>
        )}
      </div>
    </div>
  );
}
