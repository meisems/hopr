// Every network the dashboard can connect a wallet to, bridge from/to, and
// trade on. SUPPORTED_CHAINS (chainDetector) stays the LI.FI chain list; this
// registry adds NEAR and the metadata wallets and routers need.

import { NEAR_CHAIN_ID } from './nearService';

export type Vm = 'evm' | 'svm' | 'near';

export interface Network {
  id: number;
  key: string; // ChainLogo key
  name: string;
  shortName: string;
  vm: Vm;
  nativeSymbol: string;
  nativeDecimals: number;
  color: string;
  rpcUrl: string;
  explorerTxUrl?: string;
  explorerAddressUrl?: string;
  /** LI.FI chain id, when LI.FI routes this chain. */
  lifiChainId?: number;
  /** NEAR Intents (1Click) blockchain code, when Intents routes this chain. */
  intentsChain?: string;
  /** Native-token amounts for one-tap buys. */
  quickBuy: string[];
  /** Canonical USDC on this chain, for bridging stablecoins. */
  usdc?: { address: string; decimals: number };
  /** EIP-3085 parameters so wallets can add the chain on first use. */
  addChain?: { chainName: string; rpcUrls: string[]; blockExplorerUrls?: string[] };
}

const env = import.meta.env as Record<string, string | undefined>;
const rpc = (key: string, fallback: string) => env[`VITE_RPC_${key}`]?.trim() || fallback;

export const SOLANA_CHAIN_ID = 1151111081099710;

export const NETWORKS: Network[] = [
  {
    id: 8453, key: 'base', name: 'Base', shortName: 'Base', vm: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18, color: '#0052FF',
    rpcUrl: rpc('BASE', 'https://mainnet.base.org'), explorerTxUrl: 'https://basescan.org/tx/', explorerAddressUrl: 'https://basescan.org/address/',
    lifiChainId: 8453, intentsChain: 'base', quickBuy: ['0.005', '0.01', '0.05', '0.1'],
    usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    addChain: { chainName: 'Base', rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  },
  {
    id: 42161, key: 'arb', name: 'Arbitrum One', shortName: 'Arbitrum', vm: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18, color: '#28A0F0',
    rpcUrl: rpc('ARB', 'https://arb1.arbitrum.io/rpc'), explorerTxUrl: 'https://arbiscan.io/tx/', explorerAddressUrl: 'https://arbiscan.io/address/',
    lifiChainId: 42161, intentsChain: 'arb', quickBuy: ['0.005', '0.01', '0.05', '0.1'],
    usdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    addChain: { chainName: 'Arbitrum One', rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'] },
  },
  {
    id: 56, key: 'bsc', name: 'BNB Chain', shortName: 'BNB', vm: 'evm', nativeSymbol: 'BNB', nativeDecimals: 18, color: '#F0B90B',
    rpcUrl: rpc('BSC', 'https://bsc-dataseed.binance.org'), explorerTxUrl: 'https://bscscan.com/tx/', explorerAddressUrl: 'https://bscscan.com/address/',
    lifiChainId: 56, intentsChain: 'bsc', quickBuy: ['0.01', '0.05', '0.1', '0.5'],
    usdc: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    addChain: { chainName: 'BNB Smart Chain', rpcUrls: ['https://bsc-dataseed.binance.org'], blockExplorerUrls: ['https://bscscan.com'] },
  },
  {
    id: 4663, key: 'rhc', name: 'Robinhood Chain', shortName: 'Robinhood', vm: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18, color: '#00C853',
    rpcUrl: rpc('RHC', 'https://rpc.mainnet.chain.robinhood.com'),
    lifiChainId: 4663, intentsChain: 'hood', quickBuy: ['0.005', '0.01', '0.05', '0.1'],
    addChain: { chainName: 'Robinhood Chain', rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  {
    id: 5042, key: 'arc', name: 'Arc Chain', shortName: 'Arc', vm: 'evm', nativeSymbol: 'USDC', nativeDecimals: 18, color: '#FF6D00',
    rpcUrl: rpc('ARC', 'https://rpc.mainnet.arc.io'),
    lifiChainId: 5042, quickBuy: ['10', '25', '50', '100'],
    addChain: { chainName: 'Arc', rpcUrls: ['https://rpc.mainnet.arc.io'] },
  },
  {
    id: SOLANA_CHAIN_ID, key: 'sol', name: 'Solana', shortName: 'Solana', vm: 'svm', nativeSymbol: 'SOL', nativeDecimals: 9, color: '#9945FF',
    rpcUrl: rpc('SOL', 'https://api.mainnet-beta.solana.com'), explorerTxUrl: 'https://solscan.io/tx/', explorerAddressUrl: 'https://solscan.io/account/',
    lifiChainId: SOLANA_CHAIN_ID, intentsChain: 'sol', quickBuy: ['0.05', '0.1', '0.5', '1'],
    usdc: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  },
  {
    id: NEAR_CHAIN_ID, key: 'near', name: 'NEAR', shortName: 'NEAR', vm: 'near', nativeSymbol: 'NEAR', nativeDecimals: 24, color: '#00EC97',
    rpcUrl: rpc('NEAR', 'https://free.rpc.fastnear.com'), explorerTxUrl: 'https://nearblocks.io/txns/', explorerAddressUrl: 'https://nearblocks.io/address/',
    intentsChain: 'near', quickBuy: ['1', '5', '10', '25'],
    usdc: { address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 },
  },
];

export function getNetwork(id: number): Network | undefined {
  return NETWORKS.find((network) => network.id === id);
}

export function networksForVm(vm: Vm): Network[] {
  return NETWORKS.filter((network) => network.vm === vm);
}

/** Native token placeholder addresses used by LI.FI. */
export const LIFI_NATIVE = {
  evm: '0x0000000000000000000000000000000000000000',
  svm: '11111111111111111111111111111111',
};

/** Wrapped SOL — how LI.FI and DEXes denote native SOL in routes. */
export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

export function isNativeAddress(address: string): boolean {
  const value = address.toLowerCase();
  return value === 'native' || value === 'near' || value === LIFI_NATIVE.evm || value === LIFI_NATIVE.svm
    || value === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || address === WRAPPED_SOL;
}

export function explorerTxLink(chainId: number, hash: string): string | undefined {
  const network = getNetwork(chainId);
  return network?.explorerTxUrl ? `${network.explorerTxUrl}${hash}` : undefined;
}
