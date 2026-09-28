import { ArrowRight, Loader2, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { formatTokenPrice, formatUsd } from '../services/chainDetector';
import { getNetwork } from '../services/chains';
import { formatUnits } from '../services/nearService';
import { usePositions, type Position } from '../hooks/usePositions';
import ChainLogo from './ChainLogo';

/** Session key the dashboard reads to open a token picked from Positions on another page. */
export const OPEN_TOKEN_KEY = 'hopr-open-token';

interface PositionsTableProps {
  /** Open the token's trading panel (sell from the trade card). */
  onOpenToken?: (address: string) => void;
}

function Pnl({ position }: { position: Position }) {
  if (position.pnlUsd === null) return <span className="text-gray-500">—</span>;
  const up = position.pnlUsd >= 0;
  return (
    <span className={`inline-flex items-center gap-1 font-mono ${up ? 'text-green-400' : 'text-red-400'}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? '+' : '−'}{formatUsd(Math.abs(position.pnlUsd))}
      {position.pnlPercent !== null && <span className="text-[11px] opacity-80">({up ? '+' : ''}{position.pnlPercent.toFixed(1)}%)</span>}
    </span>
  );
}

export default function PositionsTable({ onOpenToken }: PositionsTableProps) {
  const { positions, totals, loading, refresh } = usePositions();
  const chains = new Set(positions.map((position) => position.chainId)).size;

  const open = (address: string) => {
    if (onOpenToken) return onOpenToken(address);
    try {
      sessionStorage.setItem(OPEN_TOKEN_KEY, address);
    } catch {
      // Fall through: the dashboard just won't auto-open the token.
    }
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return (
    <div className="bg-gray-900/60 rounded-2xl border border-gray-800/50 overflow-hidden">
      <div className="p-4 border-b border-gray-800/50">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Active Positions</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {positions.length ? `${positions.length} position${positions.length === 1 ? '' : 's'} across ${chains} chain${chains === 1 ? '' : 's'} · live prices` : 'Tokens you buy on Hopr appear here'}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-gray-500">Total value</div>
              <div className="font-mono text-sm font-semibold text-white">{formatUsd(totals.value)}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500">Total PnL</div>
              <div className={`font-mono text-sm font-semibold ${totals.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{totals.pnl >= 0 ? '+' : '−'}{formatUsd(Math.abs(totals.pnl))}</div>
            </div>
            <button onClick={() => void refresh()} className="pressable rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Refresh positions">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-gray-500">No positions yet. Scan a token and use one-tap buy — it shows up here with live PnL.</div>
      ) : (
        <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-gray-800/30 text-xs text-gray-500">
                  {['Token', 'Chain', 'Holdings', 'Price', 'Value', 'PnL', ''].map((heading, index) => (
                    <th key={heading || index} className={`px-4 py-3 font-medium whitespace-nowrap ${index < 2 ? 'text-left' : 'text-right'}`}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => {
                  const network = getNetwork(position.chainId);
                  return (
                    <tr key={position.key} className="border-b border-gray-800/20 text-sm last:border-0 hover:bg-gray-800/20">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {position.token?.imageUrl ? <img src={position.token.imageUrl} alt="" className="h-7 w-7 rounded-full" /> : <ChainLogo chainKey={network?.key ?? ''} size={28} />}
                          <div>
                            <div className="font-semibold text-white">{position.symbol}</div>
                            <div className="font-mono text-[11px] text-gray-500">{position.address.slice(0, 6)}…{position.address.slice(-4)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-300"><span className="inline-flex items-center gap-1.5"><ChainLogo chainKey={network?.key ?? ''} size={16} />{network?.shortName}</span></td>
                      <td className="px-4 py-3 text-right font-mono text-gray-200">{position.holdings === null ? <Loader2 className="ml-auto h-4 w-4 animate-spin text-gray-500" /> : formatUnits(position.holdings, position.decimals, 4)}</td>
                      <td className="px-4 py-3 text-right font-mono text-gray-300">
                        {position.priceUsd === null ? '—' : formatTokenPrice(position.priceUsd)}
                        {position.change24h !== null && <div className={`text-[11px] ${position.change24h >= 0 ? 'text-green-400' : 'text-red-400'}`}>{position.change24h >= 0 ? '+' : ''}{position.change24h.toFixed(1)}%</div>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-white">{position.valueUsd === null ? '—' : formatUsd(position.valueUsd)}</td>
                      <td className="px-4 py-3 text-right"><Pnl position={position} /></td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => open(position.address)} className="pressable inline-flex items-center gap-1 rounded-lg border border-gray-700 bg-gray-800/60 px-2.5 py-1.5 text-xs font-medium text-gray-200 hover:border-brand-400/40 hover:text-white">
                          Trade <ArrowRight className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 p-3 sm:hidden">
            {positions.map((position) => {
              const network = getNetwork(position.chainId);
              return (
                <button key={position.key} onClick={() => open(position.address)} className="pressable flex w-full items-center justify-between rounded-xl bg-gray-800/30 p-3 text-left">
                  <div className="flex items-center gap-2">
                    <ChainLogo chainKey={network?.key ?? ''} size={24} />
                    <div>
                      <div className="text-sm font-semibold text-white">{position.symbol}</div>
                      <div className="font-mono text-[11px] text-gray-500">{position.holdings === null ? '…' : formatUnits(position.holdings, position.decimals, 4)}</div>
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-mono font-semibold text-white">{position.valueUsd === null ? '—' : formatUsd(position.valueUsd)}</div>
                    <div className="text-xs"><Pnl position={position} /></div>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
