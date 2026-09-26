import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { DetectedToken, formatUsd } from '../services/chainDetector';
import { generateChartData } from '../data/mockData';
import { TrendingUp, TrendingDown, Clock, BarChart3 } from 'lucide-react';
import ChainLogo from './ChainLogo';
import { useState } from 'react';

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

const TIME_RANGES = ['1H', '4H', '1D', '1W', '1M', 'ALL'];

export default function ChartPanel({ token }: ChartPanelProps) {
  const [timeRange, setTimeRange] = useState('1M');
  
  const chartData = useMemo(() => generateChartData(30), [token?.address]);
  
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
          
          {/* Time range selector */}
          <div className="flex items-center gap-0.5 sm:gap-1 bg-gray-800/60 rounded-lg p-1 overflow-x-auto">
            {TIME_RANGES.map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-2 sm:px-2.5 py-1 text-xs rounded-md font-medium transition-all whitespace-nowrap ${
                  timeRange === range
                    ? 'bg-purple-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700/60'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 p-4 min-h-0">
        <ResponsiveContainer width="100%" height="70%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={isPositive ? '#10B981' : '#EF4444'} stopOpacity={0.3} />
                <stop offset="95%" stopColor={isPositive ? '#10B981' : '#EF4444'} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="timestamp" hide />
            <YAxis hide domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '12px', fontSize: '12px' }}
              labelStyle={{ color: '#9CA3AF' }}
              formatter={(value: number) => [formatUsd(value), 'Price']}
              labelFormatter={(label: number) => new Date(label).toLocaleDateString()}
            />
            <Area
              type="monotone"
              dataKey="price"
              stroke={isPositive ? '#10B981' : '#EF4444'}
              strokeWidth={2}
              fill="url(#priceGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
        
        {/* Volume bars */}
        <ResponsiveContainer width="100%" height="25%">
          <BarChart data={chartData}>
            <XAxis dataKey="timestamp" hide />
            <YAxis hide />
            <Bar dataKey="volume" fill="#6366F1" opacity={0.3} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
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
