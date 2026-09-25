// Chain Detection Engine
// Automatically resolves which blockchain a token address belongs to

export interface ChainInfo {
  id: number;
  name: string;
  key: string;
  type: 'EVM' | 'SVM';
  nativeToken: string;
  nativeSymbol: string;
  color: string;
}

export const SUPPORTED_CHAINS: ChainInfo[] = [
  { id: 1151111081099710, name: 'Solana', key: 'sol', type: 'SVM', nativeToken: 'SOL', nativeSymbol: 'SOL', color: '#9945FF' },
  { id: 42161, name: 'Arbitrum One', key: 'arb', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#28A0F0' },
  { id: 8453, name: 'Base', key: 'base', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#0052FF' },
  { id: 56, name: 'BNB Chain', key: 'bsc', type: 'EVM', nativeToken: 'BNB', nativeSymbol: 'BNB', color: '#F0B90B' },
  { id: 4663, name: 'Robinhood Chain', key: 'rhc', type: 'EVM', nativeToken: 'ETH', nativeSymbol: 'ETH', color: '#00C853' },
  { id: 5042, name: 'Arc Chain', key: 'arc', type: 'EVM', nativeToken: 'USDC', nativeSymbol: 'USDC', color: '#FF6D00' },
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
  fdv: number;
  change24h: number;
}

// Base58 character set for Solana address validation
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function isBase58(str: string): boolean {
  if (str.length < 32 || str.length > 44) return false;
  return [...str].every(c => BASE58_CHARS.includes(c));
}

function isEvmAddress(str: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(str);
}

// Simulated token database for demo purposes
const MOCK_TOKENS: Record<string, DetectedToken> = {
  'So11111111111111111111111111111111': {
    address: 'So11111111111111111111111111111111',
    name: 'Wrapped SOL',
    symbol: 'SOL',
    decimals: 9,
    chainId: 1151111081099710,
    chainType: 'SVM',
    chainName: 'Solana',
    chainColor: '#9945FF',
    priceUsd: 178.42,
    liquidity: 892000000,
    fdv: 82000000000,
    change24h: 3.2,
  },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    chainId: 1151111081099710,
    chainType: 'SVM',
    chainName: 'Solana',
    chainColor: '#9945FF',
    priceUsd: 1.0,
    liquidity: 450000000,
    fdv: 32000000000,
    change24h: 0.01,
  },
  '0x1234567890abcdef1234567890abcdef12345678': {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    name: 'Robinhood Token',
    symbol: 'RHT',
    decimals: 18,
    chainId: 4663,
    chainType: 'EVM',
    chainName: 'Robinhood Chain',
    chainColor: '#00C853',
    priceUsd: 0.00234,
    liquidity: 1250000,
    fdv: 2340000,
    change24h: 15.7,
  },
  '0xabcdef1234567890abcdef1234567890abcdef12': {
    address: '0xabcdef1234567890abcdef1234567890abcdef12',
    name: 'Arc Protocol',
    symbol: 'ARC',
    decimals: 18,
    chainId: 5042,
    chainType: 'EVM',
    chainName: 'Arc Chain',
    chainColor: '#FF6D00',
    priceUsd: 0.087,
    liquidity: 3400000,
    fdv: 8700000,
    change24h: -2.4,
  },
  '0x946102eA7Df8c2652a1B3a96e23B8b0a703410a5': {
    address: '0x946102eA7Df8c2652a1B3a96e23B8b0a703410a5',
    name: 'Moon Pepe',
    symbol: 'MPEPE',
    decimals: 18,
    chainId: 8453,
    chainType: 'EVM',
    chainName: 'Base',
    chainColor: '#0052FF',
    priceUsd: 0.0000123,
    liquidity: 890000,
    fdv: 1230000,
    change24h: 42.5,
  },
};

export async function detectChain(address: string): Promise<DetectedToken | null> {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 400));

  // Check if it's a known mock token
  if (MOCK_TOKENS[address]) {
    return MOCK_TOKENS[address];
  }

  // Solana detection
  if (isBase58(address)) {
    return {
      address,
      name: `SPL Token ${address.slice(0, 6)}`,
      symbol: `SPL${address.slice(0, 3).toUpperCase()}`,
      decimals: 9,
      chainId: 1151111081099710,
      chainType: 'SVM',
      chainName: 'Solana',
      chainColor: '#9945FF',
      priceUsd: Math.random() * 10,
      liquidity: Math.random() * 5000000,
      fdv: Math.random() * 50000000,
      change24h: (Math.random() - 0.5) * 40,
    };
  }

  // EVM detection
  if (isEvmAddress(address)) {
    // Simulate probing different chains
    const evmChains = SUPPORTED_CHAINS.filter(c => c.type === 'EVM');
    const detectedChain = evmChains[Math.floor(Math.random() * evmChains.length)];
    
    return {
      address,
      name: `ERC-20 Token ${address.slice(2, 8)}`,
      symbol: `TKN${address.slice(2, 5).toUpperCase()}`,
      decimals: 18,
      chainId: detectedChain.id,
      chainType: 'EVM',
      chainName: detectedChain.name,
      chainColor: detectedChain.color,
      priceUsd: Math.random() * 5,
      liquidity: Math.random() * 10000000,
      fdv: Math.random() * 100000000,
      change24h: (Math.random() - 0.5) * 60,
    };
  }

  return null;
}

export function getChainById(chainId: number): ChainInfo | undefined {
  return SUPPORTED_CHAINS.find(c => c.id === chainId);
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
