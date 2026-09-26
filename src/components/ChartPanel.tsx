import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { DetectedToken, formatUsd } from '../services/chainDetector';
import { TrendingUp, TrendingDown, Clock, BarChart3, Loader2 } from 'lucide-react';
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

type RangeKey = '15M' | '30M' | '1H' | '4H' | 'ALL';
type ChartPoint = { timestamp: number; price: number; volume: number };

type RangeConfig = {
  timeframe: 'minute' | 'hour' | 'day';
  aggregate: number;
  limit: number;
};

const TIME_RANGES: RangeKey[] = ['15M', '30M', '1H', '4H', 'ALL'];
const RANGE_CONFIG: Record<RangeKey, RangeConfig> = {
  '15M': { timeframe: 'minute', aggregate: 1, limit: 15 },
  '30M': { timeframe: 'minute', aggregate: 1, limit: 30 },
  '1H': { timeframe: 'minute', aggregate: 1, limit: 60 },
  '4H': { timeframe: 'minute', aggregate: 5, limit: 48 },
  ALL: { timeframe: 'day', aggregate: 1, limit: 100 },
};

function formatTime(timestamp: number, range: RangeKey) {
  return new Date(timestamp).toLocaleString([], range === 'ALL'
    ? { month: 'short', day: 'numeric' }
    : { hour: 'numeric', minute: '2-digit' });
}

export default function ChartPanel({ token }: ChartPanelProps) {
  const [timeRange, setTimeRange] = useState<RangeKey>('1H');
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [chartStatus, setChartStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [chartError, setChartError] = useState('');

  useEffect(() => {
    if (!token?.pairAddress || !token.geckoNetwork) {
      setChartData([]);
      setChartStatus('empty');
      setChartError('');
      return;
    }

    const controller = new AbortController();
    const range = RANGE_CONFIG[timeRange];
    setChartData([]);
    setChartStatus('loading');
    setChartError('');

    fetch(`https://api.geckoterminal.com/api/v2/networks/${token.geckoNetwork}/pools/${token.pairAddress}/ohlcv/${range.timeframe}?aggregate=${range.aggregate}&limit=${range.limit}&currency=usd`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } }; error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Historical chart data could not be loaded.');
        const rows = data.data?.attributes?.ohlcv_list ?? [];
        const points = rows
          .map(([timestamp, , , , close, volume]) => ({ timestamp: timestamp * 1000, price: close, volume }))
          .filter((point) => Number.isFinite(point.price) && point.price > 0)
          .sort((a, b) => a.timestamp - b.timestamp);
        setChartData(points);
        setChartStatus(points.length > 0 ? 'ready' : 'empty');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setChartData([]);
        setChartStatus('error');
        setChartError(error instanceof Error ? error.message : 'Historical chart data could not be loaded.');
      });

    return () => controller.abort();
  }, [timeRange, token?.address, token?.geckoNetwork, token?.pairAddress]);

  const priceChange = token?.change24h ?? 0;
  const isPositive = priceChange >= 0;

  if (!token) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-900/40 rounded-2xl border border-gray-800/50">
        <div className="text-center">
          <div className="flex justify-center mb-4"><BarChart3 className="w-16 h-16 text-gray-600" /></div>
          <p className="text-gray-400 text-sm">Search for a token to view its chart</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-900/40 rounded-2xl border border-gray-800/50 overflow-hidden">
      <div className="p-3 sm:p-4 border-b border-gray-800/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"><ChainLogo chainKey={getChainKey(token.chainId)} size={32} /></div>
            <div>
              <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-white">{token.symbol}/USD</span><span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: token.chainColor + '22', color: token.chainColor }}>{token.chainName}</span></div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap"><span className="text-base sm:text-lg font-bold text-white">{token.priceUsd < 0.01 ? `$${token.priceUsd.toFixed(8)}` : `$${token.priceUsd.toFixed(4)}`}</span><span className={`flex items-center gap-0.5 text-xs sm:text-sm font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>{isPositive ? <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> : <TrendingDown className="w-3 h-3 sm:w-3.5 sm:h-3.5" />}{isPositive ? '+' : ''}{priceChange.toFixed(2)}%</span></div>
            </div>
          </div>
          <div className="flex items-center gap-0.5 sm:gap-1 bg-gray-800/60 rounded-lg p-1 overflow-x-auto">
            {TIME_RANGES.map((range) => <button key={range} onClick={() => setTimeRange(range)} aria-pressed={timeRange === range} className={`px-2 sm:px-2.5 py-1 text-xs rounded-md font-medium transition-all whitespace-nowrap ${timeRange === range ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700/60'}`}>{range}</button>)}
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 min-h-0">
        {chartStatus === 'loading' ? <div className="h-full min-h-64 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading real market history…</div> : chartStatus === 'ready' ? <>
          <ResponsiveContainer width="100%" height="70%"><AreaChart data={chartData}><defs><linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={isPositive ? '#10B981' : '#EF4444'} stopOpacity={0.3} /><stop offset="95%" stopColor={isPositive ? '#10B981' : '#EF4444'} stopOpacity={0} /></linearGradient></defs><XAxis dataKey="timestamp" hide /><YAxis hide domain={['auto', 'auto']} /><Tooltip contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '12px', fontSize: '12px' }} labelStyle={{ color: '#9CA3AF' }} formatter={(value: number) => [formatUsd(value), 'Price']} labelFormatter={(label: number) => formatTime(label, timeRange)} /><Area type="monotone" dataKey="price" stroke={isPositive ? '#10B981' : '#EF4444'} strokeWidth={2} fill="url(#priceGradient)" /></AreaChart></ResponsiveContainer>
          <ResponsiveContainer width="100%" height="25%"><BarChart data={chartData}><XAxis dataKey="timestamp" hide /><YAxis hide /><Bar dataKey="volume" fill="#6366F1" opacity={0.3} radius={[2, 2, 0, 0]} /></BarChart></ResponsiveContainer>
        </> : <div className="h-full min-h-64 flex items-center justify-center text-center px-6"><div><BarChart3 className="w-10 h-10 text-gray-500 mx-auto mb-3" /><p className="text-sm text-gray-400">{chartStatus === 'error' ? chartError : token.pairAddress ? 'No historical candles are available for this range.' : 'No market pool is available for this token yet.'}</p><p className="text-xs text-gray-500 mt-1">Hopr only displays chart data returned by the market-data provider.</p></div></div>}
      </div>

      <div className="px-3 sm:px-4 pb-3 sm:pb-4 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3"><div className="text-xs text-gray-500 flex items-center gap-1"><Clock className="w-3 h-3" /> 24h Vol</div><div className="text-xs sm:text-sm font-semibold text-white mt-1">{formatUsd(token.volume24h)}</div></div>
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3"><div className="text-xs text-gray-500">Liquidity</div><div className="text-xs sm:text-sm font-semibold text-white mt-1">{formatUsd(token.liquidity)}</div></div>
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3"><div className="text-xs text-gray-500">MCap/FDV</div><div className="text-xs sm:text-sm font-semibold text-white mt-1">{formatUsd(token.fdv)}</div></div>
        <div className="bg-gray-800/40 rounded-xl p-2 sm:p-3"><div className="text-xs text-gray-500">Decimals</div><div className="text-xs sm:text-sm font-semibold text-white mt-1">{token.decimals}</div></div>
      </div>
    </div>
  );
}
