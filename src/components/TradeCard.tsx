import { useState } from 'react';
import { ArrowDownUp, Settings, AlertTriangle, Rocket, TrendingDown, Pencil, XCircle, BarChart3, Loader2, CheckCircle2 } from 'lucide-react';
import { DetectedToken, formatNumber, formatUsd, SUPPORTED_CHAINS } from '../services/chainDetector';
import { mockWalletBalances } from '../data/mockData';
import ChainLogo from './ChainLogo';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallet } from '../context/WalletContext';
import { apiUrl } from '../services/api';

interface TradeCardProps {
  token: DetectedToken | null;
}

type TradeMode = 'buy' | 'sell';
type TradeStatus = 'idle' | 'unavailable';
type DashboardQuote = {
  estimate?: { toAmount?: string; executionDuration?: number };
  transactionRequest?: { to: string; data?: string; value?: string; gasLimit?: string; chainId?: number };
};

const BUY_PRESETS = [0.1, 0.5, 1.0, 2.0];
const SELL_PRESETS = [25, 50, 75, 100];

export default function TradeCard({ token }: TradeCardProps) {
  const [mode, setMode] = useState<TradeMode>('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(3);
  const [showSettings, setShowSettings] = useState(false);
  const [fundingChain, setFundingChain] = useState(SUPPORTED_CHAINS.find((chain) => chain.key === 'bas') ?? SUPPORTED_CHAINS[0]);
  const [tradeStatus, setTradeStatus] = useState<TradeStatus>('idle');
  const [customAmount, setCustomAmount] = useState('');
  const [quoteStatus, setQuoteStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [quoteMessage, setQuoteMessage] = useState('');
  const [pendingQuote, setPendingQuote] = useState<DashboardQuote | null>(null);
  const { evmAddress, connectEvm } = useWallet();
  const [connectingWallet, setConnectingWallet] = useState(false);

  const userBalance = mockWalletBalances.find(b => b.chainId === fundingChain.id);

  const handleBuy = async (presetAmount?: number) => {
    if (!token) return;
    const nextAmount = presetAmount?.toString() ?? customAmount;
    setAmount(nextAmount);
    setPendingQuote(null);
    if (!evmAddress) {
      setQuoteStatus('error');
      setQuoteMessage('Connect an EVM wallet to buy this token. You can keep browsing and scanning without connecting.');
      return;
    }
    if (token.chainType !== 'EVM') {
      setQuoteStatus('error');
      setQuoteMessage('LI.FI quote previews from this dashboard currently require an EVM destination token.');
      return;
    }
    setQuoteStatus('loading');
    setQuoteMessage('Requesting a fresh LI.FI route quote…');
    try {
      const response = await fetch(apiUrl('/api/trade/quote'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: evmAddress, fromAddress: evmAddress, tokenAddress: token.address, toChainId: token.chainId, amount: nextAmount, fundingChain: String(fundingChain.id), slippage }),
      });
      const data = await response.json() as { quote?: DashboardQuote; error?: string };
      if (!response.ok || !data.quote) throw new Error(data.error ?? 'LI.FI could not return a quote.');
      const estimate = data.quote.estimate;
      const output = estimate?.toAmount ?? 'unavailable';
      const duration = typeof estimate?.executionDuration === 'number' ? `${Math.max(1, Math.round(estimate.executionDuration / 60))} min` : 'variable';
      if (!data.quote.transactionRequest) throw new Error('LI.FI returned no executable transaction for this route.');
      setPendingQuote(data.quote);
      setQuoteStatus('ready');
      setQuoteMessage(`Quote ready: ~${output} ${token.symbol} · estimated ${duration}. Platform fee: 0.5% included. Review the route, then confirm to submit from your wallet.`);
    } catch (error) {
      setQuoteStatus('error');
      setQuoteMessage(error instanceof Error ? error.message : 'Unable to request a LI.FI quote.');
    }
  };

  const handleConfirmBuy = async () => {
    if (!pendingQuote?.transactionRequest || !evmAddress || !window.ethereum) {
      setQuoteStatus('error');
      setQuoteMessage('Reconnect your EVM wallet before confirming this quote.');
      return;
    }
    setQuoteStatus('loading');
    setQuoteMessage('Confirm the transaction in your wallet…');
    try {
      const request = pendingQuote.transactionRequest;
      if (request.chainId) {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${request.chainId.toString(16)}` }],
        });
      }
      const txHash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: evmAddress,
          to: request.to,
          data: request.data ?? '0x',
          value: request.value ?? '0x0',
          ...(request.gasLimit ? { gas: request.gasLimit } : {}),
        }],
      }) as string;
      setPendingQuote(null);
      setQuoteStatus('ready');
      setQuoteMessage(`Trade submitted. Transaction: ${txHash}`);
    } catch (error) {
      setQuoteStatus('error');
      setQuoteMessage(error instanceof Error ? error.message : 'The wallet rejected the transaction.');
    }
  };

  const handleCancelQuote = () => {
    setPendingQuote(null);
    setQuoteStatus('idle');
    setQuoteMessage('');
  };

  const handleSell = (_percent: number) => {
    if (!token) return;
    setQuoteStatus('error');
    setQuoteMessage('No holdings are recorded for this dashboard, so a sell quote is unavailable. No transaction was sent.');
  };

  const handleConnectEvm = async () => {
    setConnectingWallet(true);
    setQuoteStatus('loading');
    setQuoteMessage('Opening your EVM wallet…');
    try {
      await connectEvm();
      setQuoteStatus('ready');
      setQuoteMessage('Wallet connected. Choose a buy amount to request a fresh quote.');
    } catch (error) {
      setQuoteStatus('error');
      setQuoteMessage(error instanceof Error ? error.message : 'Wallet connection was rejected.');
    } finally {
      setConnectingWallet(false);
    }
  };

  if (!token) {
    return (
      <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 p-6">
        <div className="text-center py-8">
          <div className="flex justify-center mb-3">
            <ArrowDownUp className="w-10 h-10 text-gray-600" />
          </div>
          <p className="text-gray-400 text-sm">Select a token to trade</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      {/* Mode toggle */}
      <div className="flex border-b border-gray-800/50">
        <button
          onClick={() => { setMode('buy'); setTradeStatus('idle'); }}
          className={`flex-1 py-3.5 text-sm font-semibold transition-all ${
            mode === 'buy' ? 'text-green-400 bg-green-400/5 border-b-2 border-green-400' : 'text-gray-400 hover:text-white'
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => { setMode('sell'); setTradeStatus('idle'); }}
          className={`flex-1 py-3.5 text-sm font-semibold transition-all ${
            mode === 'sell' ? 'text-red-400 bg-red-400/5 border-b-2 border-red-400' : 'text-gray-400 hover:text-white'
          }`}
        >
          Sell
        </button>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`px-4 transition-all ${showSettings ? 'text-purple-400' : 'text-gray-400 hover:text-white'}`}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Settings panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-gray-800/50"
          >
            <div className="p-4 space-y-4">
              <div>
                <label className="text-xs text-gray-400 mb-2 block">Funding Chain</label>
                <div className="grid grid-cols-3 gap-2">
                  {SUPPORTED_CHAINS.map((chain) => (
                    <button
                      key={chain.id}
                      onClick={() => setFundingChain(chain)}
                      className={`px-2 py-2 rounded-lg text-xs font-medium transition-all border ${
                        fundingChain.id === chain.id
                          ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                          : 'border-gray-700/50 bg-gray-800/40 text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      <div className="flex justify-center mb-1">
                        <ChainLogo chainKey={chain.key} size={20} />
                      </div>
                      <span className="block mt-0.5">{chain.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-2 block">Slippage Tolerance</label>
                <div className="flex items-center gap-2">
                  {[0.5, 1, 3, 5].map((s) => (
                    <button
                      key={s}
                      onClick={() => setSlippage(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        slippage === s ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                      }`}
                    >
                      {s}%
                    </button>
                  ))}
                  <input
                    type="number"
                    value={slippage}
                    onChange={(e) => setSlippage(parseFloat(e.target.value) || 0)}
                    className="w-16 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white text-center focus:outline-none focus:border-purple-500"
                  />
                  <span className="text-xs text-gray-400">%</span>
                </div>
                {slippage > 5 && (
                  <div className="flex items-center gap-1 mt-2 text-xs text-yellow-400">
                    <AlertTriangle className="w-3 h-3" /> High slippage may result in unfavorable trades
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="p-4 space-y-4">
        {/* Trade status */}
        <AnimatePresence mode="wait">
          {(tradeStatus !== 'idle' || quoteStatus !== 'idle') && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-2"
            >
              <div className={`flex items-start gap-2 p-3 rounded-xl ${quoteStatus === 'ready' ? 'bg-green-500/10 border border-green-500/20' : 'bg-amber-500/10 border border-amber-500/20'}`}>
                {quoteStatus === 'loading' ? <Loader2 className="w-5 h-5 text-blue-300 shrink-0 animate-spin" /> : quoteStatus === 'ready' ? <CheckCircle2 className="w-5 h-5 text-green-300 shrink-0" /> : <XCircle className="w-5 h-5 text-amber-300 shrink-0" />}
                <div className="flex-1 space-y-2">
                  <span className="block text-sm text-gray-200">{quoteMessage || 'Choose a buy amount to request a fresh quote.'}</span>
                  {quoteStatus === 'error' && !evmAddress && (
                    <button
                      onClick={handleConnectEvm}
                      disabled={connectingWallet}
                      className="px-3 py-1.5 rounded-lg bg-brand-500/20 border border-brand-400/30 text-xs font-medium text-brand-200 hover:bg-brand-500/30 disabled:opacity-50"
                    >
                      {connectingWallet ? 'Connecting…' : 'Connect EVM wallet'}
                    </button>
                  )}
                  {quoteStatus === 'ready' && pendingQuote && (
                    <div className="flex gap-2">
                      <button onClick={handleConfirmBuy} className="px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-400/30 text-xs font-medium text-green-200 hover:bg-green-500/30">Confirm and submit</button>
                      <button onClick={handleCancelQuote} className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-xs font-medium text-gray-300 hover:text-white">Cancel</button>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Buy mode */}
        {mode === 'buy' && tradeStatus === 'idle' && (
          <>
            {/* Funding source */}
            <div className="bg-gray-800/40 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-gray-500">You Pay</div>
                  <div className="text-lg font-semibold text-white mt-0.5">
                    {amount ? formatNumber(parseFloat(amount)) : '0.00'} {fundingChain.nativeSymbol}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-500">Balance</div>
                  <div className="text-sm text-gray-300">{userBalance ? `${formatNumber(userBalance.balance)} ${fundingChain.nativeSymbol}` : 'Not connected'}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full transition-all"
                    style={{ width: `${userBalance ? Math.min((parseFloat(amount || '0') / userBalance.balance) * 100, 100) : 0}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500">
                  {userBalance ? `≈ ${formatUsd(parseFloat(amount || '0') * (userBalance.usdValue / userBalance.balance))}` : '$0.00'}
                </span>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex justify-center">
              <div className="w-8 h-8 bg-gray-800 rounded-full flex items-center justify-center border border-gray-700">
                <ArrowDownUp className="w-4 h-4 text-purple-400" />
              </div>
            </div>

            {/* Receive */}
            <div className="bg-gray-800/40 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-gray-500">You Receive</div>
                  <div className="text-lg font-semibold text-white mt-0.5">
                    {token.symbol}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: token.chainColor + '22', color: token.chainColor }}>
                    {token.chainName}
                  </div>
                </div>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                ≈ {amount ? formatNumber(parseFloat(amount) * 100 / token.priceUsd) : '0.00'} {token.symbol}
              </div>
            </div>

            {/* Quick buy presets */}
            <div>
              <div className="text-xs text-gray-500 mb-2">Quick Buy ({fundingChain.nativeSymbol})</div>
              <div className="grid grid-cols-4 gap-2">
                {BUY_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    onClick={() => handleBuy(preset)}
                    className="py-2.5 bg-gradient-to-r from-green-600/80 to-emerald-600/80 hover:from-green-500 hover:to-emerald-500 rounded-xl text-sm font-semibold text-white transition-all active:scale-95 flex items-center justify-center gap-1"
                  >
                    <Rocket className="w-3.5 h-3.5" /> {preset}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom amount */}
            <div className="flex gap-2">
              <input
                type="number"
                value={customAmount}
                onChange={(e) => { setCustomAmount(e.target.value); setAmount(e.target.value); }}
                placeholder="Custom amount..."
                className="flex-1 px-4 py-2.5 bg-gray-800/60 border border-gray-700/50 rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:border-purple-500/50"
              />
              <button
                onClick={() => handleBuy()}
                disabled={!customAmount || parseFloat(customAmount) <= 0}
                className="px-6 py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-semibold text-white transition-all active:scale-95"
              >
                Buy Now
              </button>
            </div>
          </>
        )}

        {/* Sell mode */}
        {mode === 'sell' && tradeStatus === 'idle' && (
          <>
            <div className="bg-gray-800/40 rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-2">Sell {token.symbol}</div>
              <div className="text-sm text-gray-300">
                Holdings: <span className="text-white font-semibold">No holdings recorded</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Value: <span className="text-white">—</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Returns to: <span className="text-purple-400">{fundingChain.name} ({fundingChain.nativeSymbol})</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {SELL_PRESETS.map((percent) => (
                <button
                  key={percent}
                  onClick={() => handleSell(percent)}
                  className="py-3 bg-gradient-to-r from-red-600/80 to-rose-600/80 hover:from-red-500 hover:to-rose-500 rounded-xl text-sm font-semibold text-white transition-all active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <TrendingDown className="w-3.5 h-3.5" /> Sell {percent}%
                </button>
              ))}
            </div>

            <div className="text-xs text-gray-500 text-center">
              Proceeds automatically return to your {fundingChain.name} wallet
            </div>
          </>
        )}

        {/* Route info */}
        <div className="pt-2 border-t border-gray-800/50">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Trade route</span>
            <span>Preview only — unavailable</span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 mt-1">
            <span>Slippage</span>
            <span>{formatNumber(slippage)}%</span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 mt-1">
            <span>Execution</span>
            <span>Not implemented</span>
          </div>
        </div>
      </div>
    </div>
  );
}
