// Browser Solana wallets (Phantom, Solflare, Backpack, or any injected
// window.solana). @solana/web3.js is imported lazily so it only loads when a
// Solana transaction is actually built or signed.

import { getNetwork, SOLANA_CHAIN_ID } from '../chains';

interface SolanaPublicKeyLike { toString(): string }

export interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: SolanaPublicKeyLike | null;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: SolanaPublicKeyLike } | void>;
  disconnect?: () => Promise<void>;
  signAndSendTransaction?: (transaction: unknown, options?: unknown) => Promise<{ signature: string } | string>;
  signTransaction?: <T>(transaction: T) => Promise<T>;
}

export interface SolanaWalletInfo {
  id: 'phantom' | 'solflare' | 'backpack' | 'injected';
  name: string;
  installUrl: string;
  provider?: SolanaProvider;
}

type SolanaWindow = Window & {
  phantom?: { solana?: SolanaProvider };
  solflare?: SolanaProvider;
  backpack?: { solana?: SolanaProvider } & SolanaProvider;
  solana?: SolanaProvider;
};

export function listSolanaWallets(): SolanaWalletInfo[] {
  const w = window as SolanaWindow;
  const phantom = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined);
  const solflare = w.solflare?.isSolflare ? w.solflare : undefined;
  const backpack = w.backpack?.solana ?? (w.backpack?.connect ? w.backpack : undefined);
  const wallets: SolanaWalletInfo[] = [
    { id: 'phantom', name: 'Phantom', installUrl: 'https://phantom.com/download', provider: phantom },
    { id: 'solflare', name: 'Solflare', installUrl: 'https://solflare.com/download', provider: solflare },
    { id: 'backpack', name: 'Backpack', installUrl: 'https://backpack.app/download', provider: backpack },
  ];
  const generic = w.solana;
  if (generic && ![phantom, solflare, backpack].includes(generic)) {
    wallets.push({ id: 'injected', name: 'Browser wallet', installUrl: '', provider: generic });
  }
  return wallets;
}

export function findSolanaWallet(id: string): SolanaWalletInfo | undefined {
  return listSolanaWallets().find((wallet) => wallet.id === id && wallet.provider);
}

export async function connectSolanaWallet(wallet: SolanaWalletInfo, onlyIfTrusted = false): Promise<string | null> {
  if (!wallet.provider) throw new Error(`${wallet.name} is not installed.`);
  const result = await wallet.provider.connect(onlyIfTrusted ? { onlyIfTrusted: true } : undefined);
  const key = (result && 'publicKey' in result ? result.publicKey : undefined) ?? wallet.provider.publicKey;
  return key ? key.toString() : null;
}

function rpcUrl() {
  return getNetwork(SOLANA_CHAIN_ID)!.rpcUrl;
}

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error || payload.result === undefined) throw new Error(payload.error?.message ?? `Solana ${method} failed`);
  return payload.result;
}

export async function getSolBalance(address: string): Promise<bigint> {
  const result = await solanaRpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return BigInt(result.value);
}

/** SPL / Token-2022 balance of `mint` for `owner`, in smallest units, plus decimals. */
export async function getSplBalance(owner: string, mint: string): Promise<{ amount: bigint; decimals: number }> {
  const result = await solanaRpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }> }>(
    'getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  );
  let amount = 0n;
  let decimals = 0;
  for (const account of result.value) {
    const tokenAmount = account.account.data.parsed.info.tokenAmount;
    amount += BigInt(tokenAmount.amount);
    decimals = tokenAmount.decimals;
  }
  if (!result.value.length) {
    const supply = await solanaRpc<{ value: { decimals: number } }>('getTokenSupply', [mint]).catch(() => null);
    decimals = supply?.value.decimals ?? 0;
  }
  return { amount, decimals };
}

async function sendSigned(provider: SolanaProvider, transaction: unknown): Promise<string> {
  if (provider.signAndSendTransaction) {
    const result = await provider.signAndSendTransaction(transaction);
    return typeof result === 'string' ? result : result.signature;
  }
  if (!provider.signTransaction) throw new Error('This Solana wallet cannot sign transactions.');
  const signed = await provider.signTransaction(transaction) as { serialize: () => Uint8Array };
  const bytes = signed.serialize();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return solanaRpc<string>('sendTransaction', [btoa(binary), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
}

/** Sign and send a base64-serialized VersionedTransaction (as returned by LI.FI). */
export async function signAndSendSerialized(provider: SolanaProvider, base64Tx: string): Promise<string> {
  const { VersionedTransaction } = await import('@solana/web3.js');
  const bytes = Uint8Array.from(atob(base64Tx), (char) => char.charCodeAt(0));
  return sendSigned(provider, VersionedTransaction.deserialize(bytes));
}

/** Plain SOL transfer (used for NEAR Intents deposits). */
export async function sendSol(provider: SolanaProvider, from: string, to: string, lamports: bigint): Promise<string> {
  const { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
  const { blockhash } = (await solanaRpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const message = new TransactionMessage({
    payerKey: new PublicKey(from),
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports })],
  }).compileToV0Message();
  return sendSigned(provider, new VersionedTransaction(message));
}

/** Poll until a signature is confirmed; throws if the transaction failed. */
export async function waitForSolanaSignature(signature: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await solanaRpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>('getSignatureStatuses', [[signature]]).catch(() => null);
    const entry = status?.value[0];
    if (entry?.err) throw new Error('The Solana transaction failed.');
    if (entry && (entry.confirmationStatus === 'confirmed' || entry.confirmationStatus === 'finalized')) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Timed out waiting for Solana confirmation.');
}
