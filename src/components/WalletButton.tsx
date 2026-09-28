import { Wallet } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import ChainLogo from './ChainLogo';

/** Header wallet chip: "Connect" when empty, otherwise the connected ecosystems and first address. */
export default function WalletButton() {
  const { evm, svm, near, openWalletModal } = useWallet();
  const connected = [
    evm && { key: 'base', address: evm.address },
    svm && { key: 'sol', address: svm.address },
    near && { key: 'near', address: near.address },
  ].filter((item): item is { key: string; address: string } => Boolean(item));

  if (!connected.length) {
    return (
      <button
        onClick={() => openWalletModal()}
        className="pressable flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-brand-500 to-brand-400 px-3 py-2 text-sm font-semibold text-white shadow-[0_6px_20px_-10px_rgba(63,176,170,0.9)] hover:brightness-110"
      >
        <Wallet className="h-4 w-4" />
        <span className="hidden sm:inline">Connect</span>
      </button>
    );
  }

  const first = connected[0].address;
  return (
    <button
      onClick={() => openWalletModal()}
      className="pressable flex items-center gap-2 rounded-xl border border-gray-800/70 bg-gray-900/60 py-1.5 pl-1.5 pr-3 text-sm font-medium text-white hover:border-brand-400/40"
      aria-label="Manage wallets"
    >
      <span className="flex -space-x-1.5">
        {connected.map((item) => <span key={item.key} className="rounded-full ring-2 ring-gray-900"><ChainLogo chainKey={item.key} size={20} /></span>)}
      </span>
      <span className="hidden font-mono text-xs sm:inline">{first.length > 14 ? `${first.slice(0, 5)}…${first.slice(-4)}` : first}</span>
    </button>
  );
}
