// Browser EVM wallets. Discovery uses EIP-6963 so every installed wallet
// (MetaMask, Rabby, Coinbase Wallet, OKX, Trust …) is listed separately
// instead of fighting over window.ethereum; window.ethereum is the fallback.

import { getNetwork } from '../chains';
import { jsonRpc } from '../rpcPool';

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

export interface EvmWalletInfo {
  id: string; // EIP-6963 rdns, or "injected"
  name: string;
  icon?: string;
  provider: Eip1193Provider;
}

interface Eip6963AnnounceEvent extends Event {
  detail: { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193Provider };
}

const discovered = new Map<string, EvmWalletInfo>();
const listeners = new Set<() => void>();
let started = false;

function notify() {
  listeners.forEach((listener) => listener());
}

/** Start EIP-6963 discovery once; wallets announce themselves asynchronously. */
export function startEvmDiscovery() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('eip6963:announceProvider', (event) => {
    const { info, provider } = (event as Eip6963AnnounceEvent).detail;
    discovered.set(info.rdns || info.uuid, { id: info.rdns || info.uuid, name: info.name, icon: info.icon, provider });
    notify();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function subscribeEvmWallets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listEvmWallets(): EvmWalletInfo[] {
  const wallets = [...discovered.values()];
  const injected = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (injected && !wallets.some((wallet) => wallet.provider === injected)) {
    wallets.push({ id: 'injected', name: 'Browser wallet', provider: injected });
  }
  return wallets;
}

export function findEvmWallet(id: string): EvmWalletInfo | undefined {
  return listEvmWallets().find((wallet) => wallet.id === id);
}

export async function connectEvmWallet(wallet: EvmWalletInfo): Promise<string> {
  const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' }) as string[];
  if (!accounts?.[0]) throw new Error('The wallet did not return an account.');
  return accounts[0];
}

/** Silent reconnect: returns the account only if this site is already authorised. */
export async function restoreEvmWallet(wallet: EvmWalletInfo): Promise<string | null> {
  const accounts = await wallet.provider.request({ method: 'eth_accounts' }).catch(() => []) as string[];
  return accounts?.[0] ?? null;
}

function hexChainId(chainId: number) {
  return `0x${chainId.toString(16)}`;
}

/** Switch the wallet to `chainId`, adding the chain first if the wallet doesn't know it. */
export async function switchEvmChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const current = await provider.request({ method: 'eth_chainId' }).catch(() => null) as string | null;
  if (current && Number.parseInt(current, 16) === chainId) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId(chainId) }] });
  } catch (error) {
    const code = (error as { code?: number; data?: { originalError?: { code?: number } } }).code
      ?? (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    const network = getNetwork(chainId);
    if (code !== 4902 || !network?.addChain) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexChainId(chainId),
        chainName: network.addChain.chainName,
        rpcUrls: network.addChain.rpcUrls,
        blockExplorerUrls: network.addChain.blockExplorerUrls,
        nativeCurrency: { name: network.nativeSymbol, symbol: network.nativeSymbol, decimals: network.nativeDecimals },
      }],
    });
  }
}

export interface EvmTx {
  to: string;
  data?: string;
  value?: string | bigint;
  gasLimit?: string;
}

function toHexQuantity(value: string | bigint | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const big = typeof value === 'bigint' ? value : BigInt(value);
  return `0x${big.toString(16)}`;
}

/** personal_sign a UTF-8 message (free, no transaction). Returns the 0x signature. */
export async function personalSign(provider: Eip1193Provider, address: string, message: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return await provider.request({ method: 'personal_sign', params: [hex, address] }) as string;
}

export async function sendEvmTransaction(provider: Eip1193Provider, from: string, chainId: number, tx: EvmTx): Promise<string> {
  await switchEvmChain(provider, chainId);
  return await provider.request({
    method: 'eth_sendTransaction',
    params: [{
      from,
      to: tx.to,
      data: tx.data ?? '0x',
      value: toHexQuantity(tx.value) ?? '0x0',
      ...(tx.gasLimit ? { gas: toHexQuantity(tx.gasLimit) } : {}),
    }],
  }) as string;
}

// ---------------------------------------------------------------------------
// JSON-RPC reads (through public/configured RPCs, not the wallet, so they
// work for any chain regardless of which chain the wallet is on).
// ---------------------------------------------------------------------------

async function rpcCall<T>(chainId: number, method: string, params: unknown[]): Promise<T> {
  if (!getNetwork(chainId)) throw new Error(`Unsupported chain ${chainId}`);
  // Fails over across the chain's RPC pool (see rpcPool.ts).
  return jsonRpc<T>(chainId, method, params);
}

export async function getEvmNativeBalance(chainId: number, address: string): Promise<bigint> {
  return BigInt(await rpcCall<string>(chainId, 'eth_getBalance', [address, 'latest']));
}

const pad32 = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export async function getErc20Balance(chainId: number, token: string, owner: string): Promise<bigint> {
  const result = await rpcCall<string>(chainId, 'eth_call', [{ to: token, data: `0x70a08231${pad32(owner)}` }, 'latest']);
  return result && result !== '0x' ? BigInt(result) : 0n;
}

export async function getErc20Decimals(chainId: number, token: string): Promise<number> {
  const result = await rpcCall<string>(chainId, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
  return result && result !== '0x' ? Number(BigInt(result)) : 18;
}

async function getErc20Allowance(chainId: number, token: string, owner: string, spender: string): Promise<bigint> {
  const result = await rpcCall<string>(chainId, 'eth_call', [{ to: token, data: `0xdd62ed3e${pad32(owner)}${pad32(spender)}` }, 'latest']);
  return result && result !== '0x' ? BigInt(result) : 0n;
}

/** Wait for a transaction to be mined; throws if it reverted. */
export async function waitForEvmReceipt(chainId: number, hash: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpcCall<{ status?: string } | null>(chainId, 'eth_getTransactionReceipt', [hash]).catch(() => null);
    if (receipt) {
      if (receipt.status === '0x0') throw new Error('The transaction reverted on-chain.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error('Timed out waiting for the transaction to confirm.');
}

/**
 * Make sure `spender` may move `amount` of `token`. Approves exactly the amount
 * needed (not unlimited) and waits for the approval to be mined.
 */
export async function ensureErc20Allowance(provider: Eip1193Provider, owner: string, chainId: number, token: string, spender: string, amount: bigint): Promise<string | null> {
  const current = await getErc20Allowance(chainId, token, owner, spender);
  if (current >= amount) return null;
  const hash = await sendEvmTransaction(provider, owner, chainId, {
    to: token,
    data: `0x095ea7b3${pad32(spender)}${amount.toString(16).padStart(64, '0')}`,
  });
  await waitForEvmReceipt(chainId, hash);
  return hash;
}

/** ERC-20 transfer calldata (used for NEAR Intents deposits). */
export function erc20TransferData(to: string, amount: bigint): string {
  return `0xa9059cbb${pad32(to)}${amount.toString(16).padStart(64, '0')}`;
}
