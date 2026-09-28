import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { DetectedToken, formatTokenPrice, formatUsd, chainKeyForId, formatAddress, formatAge, tokenExplorerUrl } from '../services/chainDetector';
import { TrendingUp, TrendingDown, Clock, BarChart3, Loader2, Copy, Check } from 'lucide-react';
import ChainLogo from './ChainLogo';


function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-gray-800/40 p-2 sm:p-3">
      <div className="flex items-center gap-1 text-xs text-gray-500">{icon}{label}</div>
      <div className="mt-1 font-mono text-xs font-semibold text-white sm:text-sm">{value}</div>
    </div>
  );
}

function TokenAvatar({ token }: { token: DetectedToken }) {
  const [failed, setFailed] = useState(false);
  if (!token.imageUrl || failed) return <ChainLogo chainKey={chainKeyForId(token.chainId)} size={40} />;
  return (
    <span className="relative h-10 w-10 shrink-0">
      <img src={token.imageUrl} alt="" onError={() => setFailed(true)} className="h-10 w-10 rounded-full bg-gray-800 object-cover" />
      <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-gray-900"><ChainLogo chainKey={chainKeyForId(token.chainId)} size={16} /></span>
    </span>
  );
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

const OHLCV_CACHE = new Map<string, { at: number; points: ChartPoint[] }>();
const OHLCV_TTL_MS = 60_000;

/** Live embedded candle chart (DexScreener pair page, else GeckoTerminal pool) for the "Candles" view. */
function embedUrl(token: DetectedToken | null): string | undefined {
  if (!token) return undefined;
  const params = 'embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15';
  if (token.pairUrl) return `${token.pairUrl}${token.pairUrl.includes('?') ? '&' : '?'}${params}`;
  if (token.geckoNetwork && token.pairAddress) return `https://www.geckoterminal.com/${token.geckoNetwork}/pools/${token.pairAddress}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`;
  return undefined;
}

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
  const [retryKey, setRetryKey] = useState(0);

  const [source, setSource] = useState<'hopr' | 'embed'>('hopr');

  useEffect(() => {
    setSource('hopr');
  }, [token?.address]);

  useEffect(() => {
    if (!token?.pairAddress || !token.geckoNetwork) {
      setChartData([]);
      setChartStatus('empty');
      setChartError('');
      return;
    }

    const controller = new AbortController();
    const range = RANGE_CONFIG[timeRange];
    const cacheKey = `${token.geckoNetwork}:${token.pairAddress}:${timeRange}`;
    const cached = OHLCV_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < OHLCV_TTL_MS) {
      setChartData(cached.points);
      setChartStatus(cached.points.length ? 'ready' : 'empty');
      setChartError('');
      return;
    }
    setChartData([]);
    setChartStatus('loading');
    setChartError('');

    const url = `https://api.geckoterminal.com/api/v2/networks/${token.geckoNetwork}/pools/${token.pairAddress}/ohlcv/${range.timeframe}?aggregate=${range.aggregate}&limit=${range.limit}&currency=usd`;
    const load = async (attempt: number): Promise<ChartPoint[]> => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.status === 429) throw new Error('RATE_LIMITED');
        const data = await response.json() as { data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } }; errors?: Array<{ title?: string }> };
        if (!response.ok) throw new Error(data.errors?.[0]?.title ?? 'Historical chart data could not be loaded.');
        return (data.data?.attributes?.ohlcv_list ?? [])
          .map(([timestamp, , , , close, volume]) => ({ timestamp: timestamp * 1000, price: close, volume }))
          .filter((point) => Number.isFinite(point.price) && point.price > 0)
          .sort((a, b) => a.timestamp - b.timestamp);
      } catch (error) {
        // The free API rate-limits bursts (browsers often report its 429s as network errors): back off and retry.
        const retryable = (error instanceof Error && error.message === 'RATE_LIMITED') || error instanceof TypeError;
        if (!retryable || attempt >= 2 || controller.signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1) ** 2));
        return load(attempt + 1);
      }
    };

    load(0)
      .then((points) => {
        if (controller.signal.aborted) return;
        OHLCV_CACHE.set(cacheKey, { at: Date.now(), points });
        setChartData(points);
        setChartStatus(points.length > 0 ? 'ready' : 'empty');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setChartData([]);
        setChartStatus('error');
        setChartError(error instanceof Error && error.message !== 'RATE_LIMITED' && !(error instanceof TypeError)
          ? error.message
          : 'The price-history API is busy. Showing the live DexScreener chart instead.');
        // Keep a chart on screen: fall back to the embedded live chart.
        if (embedUrl(token)) setSource('embed');
      });

    return () => controller.abort();
  }, [timeRange, token?.address, token?.geckoNetwork, token?.pairAddress, retryKey]);

  const priceChange = token?.change24h ?? 0;
  const isPositive = priceChange >= 0;
  const displaySymbol = token && token.symbol !== 'UNKNOWN' ? token.symbol : token?.name ?? 'Token';
  const quoteSymbol = token?.pairedAsset?.symbol || 'USD';
  const [copied, setCopied] = useState(false);
  const explorerUrl = token ? tokenExplorerUrl(token.chainId, token.address) : undefined;
  const changes = token?.priceChanges;
  const timeframes = ([['5m', changes?.m5], ['1h', changes?.h1], ['6h', changes?.h6]] as Array<[string, number | undefined]>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]));
  const txnTotal = (token?.txns24h?.buys ?? 0) + (token?.txns24h?.sells ?? 0);
  const buyShare = txnTotal > 0 ? Math.round(((token?.txns24h?.buys ?? 0) / txnTotal) * 100) : 0;
  const copyAddress = () => {
    if (!token) return;
    void navigator.clipboard?.writeText(token.address).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <TokenAvatar token={token} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold tracking-tight text-white">{displaySymbol}<span className="text-gray-500">/{quoteSymbol}</span></span>
                <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: token.chainColor + '22', color: token.chainColor }}>{token.chainName}</span>
                {token.launchpad && <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] text-brand-200">{token.launchpad}</span>}
                {token.liquiditySource && !token.launchpad && <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-400">{token.liquiditySource}</span>}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xl font-semibold tracking-tight text-white sm:text-2xl">{formatTokenPrice(token.priceUsd)}</span>
                <span className={`flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold ${isPositive ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>{isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{isPositive ? '+' : ''}{priceChange.toFixed(2)}%</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button onClick={copyAddress} className="pressable flex items-center gap-1 rounded-md bg-gray-800/60 px-1.5 py-0.5 font-mono text-[11px] text-gray-400 hover:text-white" title="Copy contract address">
                  {formatAddress(token.address)} {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                </button>
                {(token.pairUrl || token.pairAddress) && (
                  <a href={token.pairUrl ?? `https://dexscreener.com/search?q=${encodeURIComponent(token.address)}`} target="_blank" rel="noreferrer" className="pressable rounded-md bg-gray-800/60 px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-white">DexScreener ↗</a>
                )}
                {explorerUrl && <a href={explorerUrl} target="_blank" rel="noreferrer" className="pressable rounded-md bg-gray-800/60 px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-white">Explorer ↗</a>}
              </div>
            </div>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex items-center gap-0.5 overflow-x-auto rounded-lg bg-gray-800/60 p-1 sm:gap-1">
              {TIME_RANGES.map((range) => <button key={range} onClick={() => setTimeRange(range)} aria-pressed={timeRange === range} className={`whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium transition-all sm:px-2.5 ${timeRange === range ? 'bg-brand-600 text-white' : 'text-gray-400 hover:bg-gray-700/60 hover:text-white'}`}>{range}</button>)}
            </div>
            {timeframes.length > 0 && (
              <div className="flex gap-1">
                {timeframes.map(([label, value]) => (
                  <span key={label} className="flex items-center gap-1 rounded-md border border-gray-800/70 px-1.5 py-0.5 font-mono text-[11px]">
                    <span className="text-gray-500">{label}</span>
                    <span className={value >= 0 ? 'text-green-400' : 'text-red-400'}>{value >= 0 ? '+' : ''}{Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)}%</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 min-h-0">
        {embedUrl(token) && (
          <div className="mb-2 flex justify-end">
            <div className="flex rounded-lg bg-gray-800/60 p-0.5 text-[11px] font-medium">
              <button onClick={() => setSource('hopr')} className={`rounded-md px-2 py-1 ${source === 'hopr' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>Price line</button>
              <button onClick={() => setSource('embed')} className={`rounded-md px-2 py-1 ${source === 'embed' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>Candles</button>
            </div>
          </div>
        )}
        {source === 'embed' && embedUrl(token) ? (
          <iframe
            key={embedUrl(token)}
            src={embedUrl(token)}
            title={`${displaySymbol} live chart`}
            className="h-[420px] w-full rounded-xl border-0 bg-gray-950"
            loading="lazy"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        ) : chartStatus === 'loading' ? <div className="h-full min-h-64 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading real price history…</div> : chartStatus === 'ready' ? <>
          <ResponsiveContainer width="100%" height="72%">
            <AreaChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <defs><linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={isPositive ? '#10B981' : '#EF4444'} stopOpacity={0.3} /><stop offset="95%" stopColor={isPositive ? '#10B981' : '#EF4444'} stopOpacity={0} /></linearGradient></defs>
              <XAxis dataKey="timestamp" tickFormatter={(value: number) => formatTime(value, timeRange)} tick={{ fill: 'var(--color-gray-500)', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis orientation="right" domain={['auto', 'auto']} tickFormatter={(value: number) => formatTokenPrice(value)} tick={{ fill: 'var(--color-gray-500)', fontSize: 10, fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} width={84} />
              <Tooltip contentStyle={{ backgroundColor: 'var(--color-gray-900)', border: '1px solid var(--color-gray-700)', borderRadius: '12px', fontSize: '12px', boxShadow: 'var(--card-shadow-hover)' }} labelStyle={{ color: 'var(--color-gray-500)' }} itemStyle={{ color: 'var(--color-gray-200)' }} cursor={{ stroke: 'var(--color-gray-600)', strokeDasharray: '3 3' }} formatter={(value: number) => [formatTokenPrice(value), 'Price']} labelFormatter={(label: number) => formatTime(label, timeRange)} />
              <Area type="monotone" dataKey="price" stroke={isPositive ? '#10B981' : '#EF4444'} strokeWidth={2} fill="url(#priceGradient)" />
            </AreaChart>
          </ResponsiveContainer>
          <ResponsiveContainer width="100%" height="22%"><BarChart data={chartData} margin={{ top: 4, right: 88, bottom: 0, left: 0 }}><XAxis dataKey="timestamp" hide /><YAxis hide /><Bar dataKey="volume" fill="#3fb0aa" opacity={0.28} radius={[2, 2, 0, 0]} /></BarChart></ResponsiveContainer>
          </> : <div className="h-full min-h-64 flex items-center justify-center text-center px-6"><div><BarChart3 className="w-10 h-10 text-gray-500 mx-auto mb-3" /><p className="text-sm text-gray-400">{chartStatus === 'error' ? chartError : token.pairAddress ? 'No historical candles are available for this range.' : 'No liquidity pool is available for this token yet.'}</p>{chartStatus === 'error' && <button onClick={() => setRetryKey((key) => key + 1)} className="pressable mt-3 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white">Retry</button>}</div></div>}
      </div>

      <div className="grid grid-cols-2 gap-2 px-3 pb-3 sm:grid-cols-3 sm:gap-3 sm:px-4 sm:pb-4">
        <Stat label="24h Volume" icon={<Clock className="h-3 w-3" />} value={formatUsd(token.volume24h)} />
        <Stat label={token.launchpad ? `${token.launchpad} Liquidity` : 'Liquidity'} value={formatUsd(token.liquidity)} />
        <Stat label="MCap / FDV" value={formatUsd(token.fdv)} />
        <div className="rounded-xl bg-gray-800/40 p-2 sm:p-3">
          <div className="flex items-center justify-between text-xs text-gray-500"><span>24h Txns</span>{txnTotal > 0 && <span className="font-mono text-[10px]"><span className="text-green-400">{buyShare}%</span> buys</span>}</div>
          <div className="mt-1 font-mono text-xs font-semibold text-white sm:text-sm">{txnTotal > 0 ? txnTotal.toLocaleString('en-US') : '—'}</div>
          {txnTotal > 0 && <div className="pressure-bar mt-1.5" role="img" aria-label={`${buyShare}% buys`}><span className="bg-green-500" style={{ width: `${buyShare}%` }} /><span className="flex-1 bg-red-500/80" /></div>}
        </div>
        <Stat label="Pair age" value={formatAge(token.pairCreatedAt) ?? '—'} />
        <Stat label="Decimals" value={String(token.decimals)} />
      </div>
    </div>
  );
}
