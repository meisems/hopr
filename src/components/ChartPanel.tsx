import { DetectedToken, formatUsd } from '../services/chainDetector';
import { TrendingUp, TrendingDown, Clock, BarChart3 } from 'lucide-react';
import ChainLogo from './ChainLogo';

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

interface ChartPanelProps {
  token: DetectedToken | null;
}

export default function ChartPanel({ token }: ChartPanelProps) {
  const chartData: never[] = [];
  
  const priceChange = token?.change24h ?? 0;
  const isPositive = priceChange >= 0;

  if (!token) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-900/40 rounded-2xl border border-gray-800/50">
        <div className="text-center">
          <div className="flex justify-center mb-4">
            <BarChart3 className="w-16 h-16 text-gray-600" />
          </div>
          <p className="text-gray-400 text-sm">Search for a token to view its chart</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-900/40 rounded-2xl border border-gray-800/50 overflow-hidden">
      {/* Header */}
      <div className="p-3 sm:p-4 border-b border-gray-800/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0">
              <ChainLogo chainKey={getChainKey(token.chainId)} size={32} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-white">{token.symbol}/USD</span>
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: token.chainColor + '22', color: token.chainColor }}>
                  {token.chainName}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="text-base sm:text-lg font-bold text-white">
                  {token.priceUsd < 0.01 ? `$${token.priceUsd.toFixed(8)}` : `$${token.priceUsd.toFixed(4)}`}
                </span>
                <span className={`flex items-center gap-0.5 text-xs sm:text-sm font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                  {isPositive ? <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> : <TrendingDown className="w-3 h-3 sm:w-3.5 sm:h-3.5" />}
                  {isPositive ? '+' : ''}{priceChange.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
          
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 p-4 min-h-0">
        {chartData.length === 0 ? (
          <div className="h-full min-h-64 flex items-center justify-center text-center px-6">
            <div>
              <BarChart3 className="w-10 h-10 text-gray-500 mx-auto mb-3" />
              <p className="text-sm text-gray-400">No historical chart data is available for this token.</p>
              <p className="text-xs text-gray-500 mt-1">Hopr will not invent or combine chart history.</p>
            </div>
          </div>
        ) : null}
      </div>

      {/* Stats */}
      <div className="px-3 sm:px-4 pb-3 sm:pb-4 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3">
          <div className="text-xs text-gray-500 flex items-center gap-1"><Clock className="w-3 h-3" /> 24h Vol</div>
          <div className="text-xs sm:text-sm font-semibold text-white mt-1">{formatUsd(token.liquidity * 0.3)}</div>
        </div>
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3">
          <div className="text-xs text-gray-500">Liquidity</div>
          <div className="text-xs sm:text-sm font-semibold text-white mt-1">{formatUsd(token.liquidity)}</div>
        </div>
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3">
          <div className="text-xs text-gray-500">MCap/FDV</div>
          <div className="text-xs sm:text-sm font-semibold text-white mt-1">{formatUsd(token.fdv)}</div>
        </div>
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3">
          <div className="text-xs text-gray-500">Decimals</div>
          <div className="text-xs sm:text-sm font-semibold text-white mt-1">{token.decimals}</div>
        </div>
      </div>
    </div>
  );
}
