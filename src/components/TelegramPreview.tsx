import { useState } from 'react';
import { Bot, Copy, CheckCircle2, ExternalLink, Send } from 'lucide-react';

export default function TelegramPreview() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText('@HoprBot');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">@HoprBot</div>
            <div className="text-[10px] text-green-400">ready to connect</div>
          </div>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-400 hover:bg-blue-500/20 transition-all"
        >
          {copied ? <CheckCircle2 className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
      </div>

      <div className="p-4 min-h-[320px] flex items-center justify-center bg-[#0e1621]/50">
        <div className="max-w-xs text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <Send className="w-5 h-5 text-blue-400" />
          </div>
          <h3 className="text-sm font-semibold text-white">Your Telegram activity will appear here</h3>
          <p className="mt-2 text-xs leading-relaxed text-gray-400">
            Connect a wallet and search for a token to start a real cross-chain trade. No demo balances or transactions are loaded.
          </p>
        </div>
      </div>

      <div className="px-4 py-3 border-t border-gray-800/50 flex items-center gap-2">
        <input
          type="text"
          placeholder="Paste token address..."
          className="flex-1 px-3 py-2 bg-[#182533] border border-gray-700/30 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/30"
          readOnly
        />
        <button disabled className="p-2 bg-blue-500/40 rounded-xl cursor-not-allowed" aria-label="Send token address">
          <Send className="w-4 h-4 text-white" />
        </button>
      </div>

      <div className="px-4 py-2 bg-gray-800/30 flex items-center justify-between">
        <span className="text-[10px] text-gray-500">One-tap cross-chain trading via Telegram</span>
        <a href="#" className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300">
          <ExternalLink className="w-2.5 h-2.5" /> Open Bot
        </a>
      </div>
    </div>
  );
}
