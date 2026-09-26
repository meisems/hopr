// Chain Detection Engine
// Automatically resolves which blockchain a token address belongs to.
//
// Solana: base58 address, verified against DexScreener.
// EVM: 0x-address, resolved via DexScreener first (fast path for indexed
// tokens), falling back to concurrent eth_getCode probes across every
// supported EVM chain for freshly-deployed tokens DexScreener hasn't
// indexed yet, then reading symbol()/name()/decimals() on the chain that
// returns bytecode.

export interface ChainInfo {
  id: number;
  name: string;
  key: string; // LI.FI chain key
  type: 'EVM' | 'SVM';
  nativeToken: string;
  nativeSymbol: string;
  color: string;
  rpcUrl: string;
}

// Public fallback RPCs. Override per-chain via VITE_RPC_<KEY> at build time
// or RPC_<KEY> worker secrets for production traffic.
export const SUPPORTED_CHAINS: ChainInfo[] = [
  { id: 1151111081099710, name: 'Solana', key: 'sol', type: 'SVM', nativeToken: 'SOL', nativeSymbol: 'SOL', color: '#9945FF', rpcUrl: 'https://api.mainnet-beta.solana.com' },
  { id: 42161, name: 'Arbitrum One', key: 'arb', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#28A0F0', rpcUrl: 'https://arb1.arbitrum.io/rpc' },
  { id: 8453, name: 'Base', key: 'bas', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#0052FF', rpcUrl: 'https://mainnet.base.org' },
  { id: 56, name: 'BNB Chain', key: 'bsc', type: 'EVM', nativeToken: 'BNB', nativeSymbol: 'BNB', color: '#F0B90B', rpcUrl: 'https://bsc-dataseed.binance.org' },
  { id: 4663, name: 'Robinhood Chain', key: 'rhc', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#00C853', rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' },
  { id: 5042, name: 'Arc Chain', key: 'arc', type: 'EVM', nativeToken: 'USDC', nativeSymbol: 'USDC', color: '#FF6D00', rpcUrl: 'https://rpc.mainnet.arc.io' },
];

export interface DetectedToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  chainId: number;
  chainType: 'EVM' | 'SVM';
  chainName: string;
  chainColor: string;
  priceUsd: number;
  liquidity: number;
  volume24h: number;
  fdv: number;
  change24h: number;
  /** DexScreener pool used to request real OHLCV history. */
  pairAddress?: string;
  geckoNetwork?: string;
  /** true if resolved via bytecode probing rather than an indexed DexScreener pair */
  freshDeployment: boolean;
}

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function isBase58(str: string): boolean {
  if (str.length < 32 || str.length > 44) return false;
  return [...str].every((c) => BASE58_CHARS.includes(c));
}

function isEvmAddress(str: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(str);
}

interface DexScreenerPair {
  chainId: string;
  pairAddress?: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  fdv?: number;
  priceChange?: { h24?: number };
}

async function fetchDexScreener(address: string): Promise<DexScreenerPair[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { pairs?: DexScreenerPair[] };
  return data.pairs ?? [];
}

// Maps DexScreener's chainId slugs to our numeric chain ids for the chains we support.
const DEXSCREENER_CHAIN_SLUGS: Record<string, number> = {
  solana: 1151111081099710,
  arbitrum: 42161,
  base: 8453,
  bsc: 56,
  robinhood: 4663,
  arc: 5042,
};

const GECKO_NETWORKS: Record<string, string> = {
  solana: 'solana',
  arbitrum: 'arbitrum',
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood-chain',
  arc: 'arc',
};

function pairToDetectedToken(pair: DexScreenerPair, chainId: number, chainInfo: ChainInfo): DetectedToken {
  return {
    address: pair.baseToken.address,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    decimals: chainInfo.type === 'SVM' ? 9 : 18, // refined by on-chain call where available
    chainId,
    chainType: chainInfo.type,
    chainName: chainInfo.name,
    chainColor: chainInfo.color,
    priceUsd: Number(pair.priceUsd ?? 0),
    liquidity: pair.liquidity?.usd ?? 0,
    volume24h: pair.volume?.h24 ?? 0,
    fdv: pair.fdv ?? 0,
    change24h: pair.priceChange?.h24 ?? 0,
    pairAddress: pair.pairAddress,
    geckoNetwork: GECKO_NETWORKS[pair.chainId.toLowerCase()],
    freshDeployment: false,
  };
}

/** eth_getCode probe: returns true if `address` has deployed bytecode on `rpcUrl`. */
async function hasBytecode(rpcUrl: string, address: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { result?: string };
    return !!data.result && data.result !== '0x';
  } catch {
    return false;
  }
}

async function readErc20Metadata(
  rpcUrl: string,
  address: string
): Promise<{ name: string; symbol: string; decimals: number } | null> {
  // Function selectors for name(), symbol(), decimals() with no args.
  const calls = [
    { sig: '0x06fdde03', key: 'name' as const },
    { sig: '0x95d89b41', key: 'symbol' as const },
    { sig: '0x313ce567', key: 'decimals' as const },
  ];

  try {
    const results = await Promise.all(
      calls.map(async ({ sig }) => {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: address, data: sig }, 'latest'],
          }),
        });
        const data = (await res.json()) as { result?: string };
        return data.result ?? '0x';
      })
    );

    const decodeString = (hex: string): string => {
      if (!hex || hex === '0x') return '';
      const clean = hex.slice(2);
      // ABI-encoded dynamic string: skip offset (32 bytes) + length (32 bytes) header
      const lenHex = clean.slice(64, 128);
      const len = parseInt(lenHex, 16) || 0;
      const strHex = clean.slice(128, 128 + len * 2);
      const bytes = strHex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [];
      return new TextDecoder().decode(new Uint8Array(bytes));
    };

    const name = decodeString(results[0]) || 'Unknown Token';
    const symbol = decodeString(results[1]) || 'UNKNOWN';
    const decimals = parseInt(results[2], 16) || 18;

    return { name, symbol, decimals };
  } catch {
    return null;
  }
}

/**
 * Probe every supported EVM chain concurrently for deployed bytecode at
 * `address`, and read ERC-20 metadata from whichever chain answers first
 * with non-empty code.
 */
async function probeEvmChains(address: string): Promise<DetectedToken | null> {
  const evmChains = SUPPORTED_CHAINS.filter((c) => c.type === 'EVM');

  const probes = await Promise.all(
    evmChains.map(async (chain) => ({
      chain,
      found: await hasBytecode(chain.rpcUrl, address),
    }))
  );

  const hit = probes.find((p) => p.found);
  if (!hit) return null;

  const metadata = await readErc20Metadata(hit.chain.rpcUrl, address);

  return {
    address,
    name: metadata?.name ?? 'Unknown Token',
    symbol: metadata?.symbol ?? 'UNKNOWN',
    decimals: metadata?.decimals ?? 18,
    chainId: hit.chain.id,
    chainType: 'EVM',
    chainName: hit.chain.name,
    chainColor: hit.chain.color,
    priceUsd: 0,
    liquidity: 0,
    volume24h: 0,
    fdv: 0,
    change24h: 0,
    freshDeployment: true,
  };
}

export async function detectChain(address: string): Promise<DetectedToken | null> {
  if (isBase58(address)) {
    const pairs = await fetchDexScreener(address);
    const solPair = pairs.find((p) => p.chainId === 'solana');
    const solChain = SUPPORTED_CHAINS.find((c) => c.key === 'sol')!;
    if (solPair) return pairToDetectedToken(solPair, solChain.id, solChain);

    // Not indexed yet — we can't probe Solana bytecode the same way as EVM,
    // so report it as a fresh/unverified Solana mint pending indexing.
    return {
      address,
      name: 'Unverified SPL Token',
      symbol: 'UNKNOWN',
      decimals: 9,
      chainId: solChain.id,
      chainType: 'SVM',
      chainName: solChain.name,
      chainColor: solChain.color,
      priceUsd: 0,
      liquidity: 0,
      volume24h: 0,
      fdv: 0,
      change24h: 0,
      freshDeployment: true,
    };
  }

  if (isEvmAddress(address)) {
    const pairs = await fetchDexScreener(address);
    const indexedPair = pairs.find((p) => p.chainId.toLowerCase() in DEXSCREENER_CHAIN_SLUGS && p.chainId.toLowerCase() !== 'solana');
    if (indexedPair) {
      const chainId = DEXSCREENER_CHAIN_SLUGS[indexedPair.chainId.toLowerCase()];
      const chainInfo = SUPPORTED_CHAINS.find((c) => c.id === chainId);
      if (chainInfo) return pairToDetectedToken(indexedPair, chainId, chainInfo);
    }

    // Not indexed (fresh deployment, or a chain DexScreener doesn't cover,
    // e.g. Robinhood Chain / Arc) — fall back to bytecode probing.
    return probeEvmChains(address);
  }

  return null;
}

export function getChainById(chainId: number): ChainInfo | undefined {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId);
}

export function getChainByKey(key: string): ChainInfo | undefined {
  return SUPPORTED_CHAINS.find((c) => c.key === key);
}

export function formatAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatUsd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(8)}`;
}
