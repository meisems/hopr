import { Bot, Command, Search, ShieldCheck, WalletCards } from 'lucide-react';

const commands = [
  { command: '/start', description: 'Start the bot and open the command guide.' },
  { command: '/help', description: 'List commands and examples.' },
  { command: '/wallet <address>', description: 'Read public balances; the Wallet button can link an address for later.' },
  { command: '/setwallet evm <address>', description: 'Save a public EVM address for later balance checks.' },
  { command: '/setwallet solana <address>', description: 'Save a public Solana address for later balance checks.' },
  { command: '/balances [address]', description: 'Refresh saved balances or query a public address once.' },
  { command: '/settings', description: 'View and save funding-chain and slippage preferences.' },
];

export default function TelegramPreview() {
  return (
    <section className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden" aria-label="Telegram bot commands">
      <header className="px-4 py-3 border-b border-gray-800/50 flex items-center gap-3">
        <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">Telegram Bot Commands</h3>
          <p className="text-[10px] text-gray-400">Read-only wallet and token tools</p>
        </div>
      </header>

      <div className="p-4 space-y-4">
        <div className="rounded-xl bg-[#0e1621]/70 border border-gray-800/70 p-3">
          <div className="flex items-center gap-2 text-xs text-blue-300 font-medium mb-2">
            <Command className="w-3.5 h-3.5" /> Commands
          </div>
          <div className="space-y-2.5">
            {commands.map(({ command, description }) => (
              <div key={command} className="flex items-start gap-2">
                <code className="shrink-0 text-[11px] text-blue-300 font-mono">{command}</code>
                <span className="text-[11px] leading-relaxed text-gray-400">{description}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded-xl bg-gray-800/40 border border-gray-700/40 p-3">
            <div className="flex items-center gap-2 text-xs text-brand-300 font-medium">
              <Search className="w-3.5 h-3.5" /> Token lookup
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">Send an EVM or Solana token address to see indexed price, 24h change, liquidity, and FDV.</p>
          </div>
          <div className="rounded-xl bg-gray-800/40 border border-gray-700/40 p-3">
            <div className="flex items-center gap-2 text-xs text-green-300 font-medium">
              <WalletCards className="w-3.5 h-3.5" /> Persistent setup
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">Saved addresses and preferences require the Worker’s <code>TELEGRAM_STATE</code> KV binding.</p>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
          <ShieldCheck className="w-4 h-4 shrink-0 text-amber-300 mt-0.5" />
          <p className="text-[11px] leading-relaxed text-amber-100/80">Never send a seed phrase or private key. The bot only reads public data; signing, approvals, transfers, and trades are not enabled.</p>
        </div>
      </div>
    </section>
  );
}
