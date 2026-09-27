import { useState } from 'react';
import { Wallet, ChevronDown, ChevronUp, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { mockWalletBalances } from '../data/mockData';
import { formatNumber, formatUsd } from '../services/chainDetector';
import { useWallet } from '../context/WalletContext';
import ChainLogo from './ChainLogo';
import { motion, AnimatePresence } from 'framer-motion';

function getChainKey(chainId: number): string {
  const map: Record<number, string> = {
    1151111081099710: 'sol',
    42161: 'arb',
    8453: 'base',
    56: 'bsc',
    4663: 'rhc',
    5042: 'arc',
  };
  return map[chainId] || 'sol';
}

export default function WalletPanel() {
  const { source, isTelegramSyncing, telegramUser, createTelegramWallet } = useWallet();
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [walletMessage, setWalletMessage] = useState('');
  const { evmAddress, solanaAddress } = useWallet();

  const totalBalance = mockWalletBalances.reduce((sum, b) => sum + b.usdValue, 0);
  const hasWallet = Boolean(evmAddress || solanaAddress);

  const handleRefresh = async () => {
    setRefreshing(true);
    await new Promise(r => setTimeout(r, 1500));
    setRefreshing(false);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleCreateTelegramWallet = async () => {
    setWalletMessage('');
    try {
      await createTelegramWallet();
      setWalletMessage('Your encrypted HOPR wallet is ready.');
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : 'Wallet creation failed.');
    }
  };

  const evmDisplay = evmAddress ? `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}` : 'Not connected';
  const solDisplay = solanaAddress ? `${solanaAddress.slice(0, 6)}...${solanaAddress.slice(-4)}` : 'Not connected';

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-gray-800/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-purple-400" />
            <h3 className="font-semibold text-white">Portfolio</h3>
          </div>
          <button
            onClick={handleRefresh}
            className={`p-1.5 rounded-lg hover:bg-gray-800 transition-colors ${refreshing ? 'animate-spin' : ''}`}
          >
            <RefreshCw className="w-4 h-4 text-gray-400" />
          </button>
        </div>
        <div className="mt-2">
          <div className="text-2xl font-bold text-white">{hasWallet ? formatUsd(totalBalance) : '—'}</div>
          <div className="text-xs text-gray-500">
            {isTelegramSyncing ? 'Syncing Telegram wallet…' : source === 'telegram' ? `Synced from Telegram${telegramUser?.username ? ` · @${telegramUser.username}` : ''}` : hasWallet ? `Across ${mockWalletBalances.length} chains` : 'Connect a wallet to view balances'}
          </div>
          {telegramUser && !hasWallet && !isTelegramSyncing && (
            <button onClick={handleCreateTelegramWallet} className="mt-3 w-full rounded-xl border border-brand-400/30 bg-gradient-to-r from-brand-500/20 via-purple-500/15 to-brand-400/20 px-3 py-2.5 text-left transition hover:border-brand-300/60 hover:from-brand-500/30">
              <span className="block text-sm font-semibold text-brand-200">Create your HOPR wallet</span>
              <span className="mt-0.5 block text-xs text-gray-400">Encrypted custody, ready across supported chains</span>
            </button>
          )}
          {walletMessage && <div className="mt-2 text-xs text-brand-200">{walletMessage}</div>}
        </div>
      </div>

      {/* Wallet addresses */}
      <div className="px-4 py-3 border-b border-gray-800/30 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">EVM:</span>
            <span className="text-xs text-gray-300 font-mono">{evmDisplay}</span>
          </div>
          <button onClick={() => evmAddress && handleCopy(evmAddress)} disabled={!evmAddress} className="p-1 hover:bg-gray-800 rounded transition-colors">
            {evmAddress && copied === evmAddress ? <span className="text-xs text-green-400">✓</span> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">SOL:</span>
            <span className="text-xs text-gray-300 font-mono">{solDisplay}</span>
          </div>
          <button onClick={() => solanaAddress && handleCopy(solanaAddress)} disabled={!solanaAddress} className="p-1 hover:bg-gray-800 rounded transition-colors">
            {solanaAddress && copied === solanaAddress ? <span className="text-xs text-green-400">✓</span> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
      </div>

      {/* Chain balances */}
      <div className="px-4 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-between w-full py-2 text-xs text-gray-400 hover:text-white transition-colors"
        >
          <span>Chain Breakdown</span>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-2 pb-2">
                {mockWalletBalances.length === 0 ? (
                  <p className="py-3 text-xs text-gray-500">No chain balances available yet.</p>
                ) : mockWalletBalances.map((balance) => {
                  const chainKey = getChainKey(balance.chainId);
                  return (
                    <div key={balance.chainId} className="flex items-center justify-between py-2 px-3 bg-gray-800/30 rounded-xl">
                      <div className="flex items-center gap-2">
                        <ChainLogo chainKey={chainKey} size={24} />
                        <div>
                          <div className="text-xs font-medium text-white">{balance.chainName}</div>
                          <div className="text-xs text-gray-500">{formatNumber(balance.balance)} {balance.nativeSymbol}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-medium text-white">{formatUsd(balance.usdValue)}</div>
                        <div className="text-xs text-gray-500">{formatNumber(totalBalance > 0 ? (balance.usdValue / totalBalance) * 100 : 0)}%</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-800/30">
        <button className="w-full py-2 text-xs text-purple-400 hover:text-purple-300 flex items-center justify-center gap-1 transition-colors">
          <ExternalLink className="w-3 h-3" /> Open in Telegram Bot
        </button>
      </div>
    </div>
  );
}
