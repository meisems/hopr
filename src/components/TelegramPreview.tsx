import { useEffect, useState } from 'react';
import { Bot, Copy, CheckCircle2, ExternalLink, Send, Plus, Pencil, WalletCards, X } from 'lucide-react';

type Network = 'EVM' | 'Solana';
type BotWallet = { id: string; name: string; network: Network; address: string; source: 'generated' | 'imported' };

const STORAGE_KEY = 'hopr-telegram-wallets';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function randomHex(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generatedAddress(network: Network) {
  if (network === 'EVM') return `0x${randomHex(20)}`;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function shortAddress(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function loadWallets(): BotWallet[] {
  try {
    const wallets = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(wallets) ? wallets : [];
  } catch {
    return [];
  }
}

export default function TelegramPreview() {
  const [copied, setCopied] = useState(false);
  const [wallets, setWallets] = useState<BotWallet[]>(loadWallets);
  const [managerOpen, setManagerOpen] = useState(false);
  const [network, setNetwork] = useState<Network>('EVM');
  const [walletName, setWalletName] = useState('');
  const [importAddress, setImportAddress] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
  }, [wallets]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText('@HoprBot');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const addWallet = (source: BotWallet['source']) => {
    setError('');
    const address = source === 'generated' ? generatedAddress(network) : importAddress.trim();
    if (!address) {
      setError('Enter a wallet address to import.');
      return;
    }
    const name = walletName.trim() || `${network} wallet ${wallets.filter((wallet) => wallet.network === network).length + 1}`;
    setWallets((current) => [...current, { id: `${Date.now()}-${randomHex(4)}`, name, network, address, source }]);
    setWalletName('');
    setImportAddress('');
  };

  const saveRename = (id: string) => {
    const name = editingName.trim();
    if (name) setWallets((current) => current.map((wallet) => wallet.id === id ? { ...wallet, name } : wallet));
    setEditingId(null);
    setEditingName('');
  };

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800/50 flex items-center justify-between">
        <div className="flex items-center gap-2"><div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center"><Bot className="w-4 h-4 text-white" /></div><div><div className="text-sm font-semibold text-white">@HoprBot</div><div className="text-[10px] text-green-400">ready to connect</div></div></div>
        <button onClick={handleCopy} className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-400 hover:bg-blue-500/20 transition-all">{copied ? <CheckCircle2 className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? 'Copied!' : 'Copy Link'}</button>
      </div>

      <div className="p-4 min-h-[260px] flex items-center justify-center bg-[#0e1621]/50"><div className="max-w-xs text-center"><div className="mx-auto mb-4 w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center"><Send className="w-5 h-5 text-blue-400" /></div><h3 className="text-sm font-semibold text-white">Your Telegram activity will appear here</h3><p className="mt-2 text-xs leading-relaxed text-gray-400">Use the wallet manager below to create or import multiple bot wallets. Real activity appears after a wallet is selected.</p></div></div>

      <div className="px-4 py-3 border-t border-gray-800/50"><button onClick={() => setManagerOpen((open) => !open)} className="w-full flex items-center justify-between rounded-xl bg-brand-500/10 border border-brand-400/20 px-3 py-2.5 text-sm text-brand-200 hover:bg-brand-500/20"><span className="flex items-center gap-2"><WalletCards className="w-4 h-4" /> Bot wallets <span className="text-xs text-gray-400">({wallets.length})</span></span>{managerOpen ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}</button>
        {managerOpen && <div className="mt-3 space-y-3">
          {wallets.length === 0 ? <p className="text-xs text-gray-500 py-2">No bot wallets yet. Generate or import one below.</p> : <div className="space-y-2">{wallets.map((wallet) => <div key={wallet.id} className="flex items-center gap-2 p-2.5 rounded-xl bg-gray-800/40 border border-gray-700/40"><div className="min-w-0 flex-1"><div className="flex items-center gap-2">{editingId === wallet.id ? <input autoFocus value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && saveRename(wallet.id)} className="min-w-0 w-28 px-2 py-1 bg-gray-900 border border-brand-400/40 rounded text-xs text-white" /> : <span className="text-xs font-medium text-white truncate">{wallet.name}</span>}<span className="text-[10px] text-brand-300">{wallet.network}</span></div><div className="text-[10px] text-gray-500 font-mono truncate">{shortAddress(wallet.address)} · {wallet.source}</div></div>{editingId === wallet.id ? <button onClick={() => saveRename(wallet.id)} className="text-xs text-green-400">Save</button> : <button onClick={() => { setEditingId(wallet.id); setEditingName(wallet.name); }} className="p-1 text-gray-400 hover:text-white" aria-label={`Rename ${wallet.name}`}><Pencil className="w-3.5 h-3.5" /></button>}</div>)}</div>}
          <div className="grid grid-cols-2 gap-2"><button onClick={() => addWallet('generated')} className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-500/20 border border-brand-400/30 text-xs text-brand-200 hover:bg-brand-500/30"><Plus className="w-3.5 h-3.5" /> Generate</button><button onClick={() => addWallet('imported')} className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/50 text-xs text-gray-200 hover:bg-gray-700/60"><Plus className="w-3.5 h-3.5" /> Import</button></div>
          <div className="grid grid-cols-2 gap-2"><select value={network} onChange={(event) => setNetwork(event.target.value as Network)} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white"><option value="EVM">EVM</option><option value="Solana">Solana</option></select><input value={walletName} onChange={(event) => setWalletName(event.target.value)} placeholder="Wallet name (optional)" className="min-w-0 px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-500" /></div>
          <input value={importAddress} onChange={(event) => setImportAddress(event.target.value)} placeholder="Address for Import (required for import)" className="w-full px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-500" />
          {error && <p className="text-xs text-red-300">{error}</p>}
          <p className="text-[10px] leading-relaxed text-gray-500">Wallet profiles are stored locally for this interface. A production Telegram bot should encrypt imported signing secrets server-side and never expose them in chat.</p>
        </div>}
      </div>

      <div className="px-4 py-2 bg-gray-800/30 flex items-center justify-between"><span className="text-[10px] text-gray-500">One-tap cross-chain trading via Telegram</span><a href="#" className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"><ExternalLink className="w-2.5 h-2.5" /> Open Bot</a></div>
    </div>
  );
}
