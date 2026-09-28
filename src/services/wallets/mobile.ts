// Mobile wallet access. Phone browsers can't run wallet extensions, so on
// mobile we (1) deep-link Hopr into the wallet app's built-in browser — which
// injects the same EIP-1193 / Solana providers the desktop flow uses — and
// (2) offer WalletConnect (QR on desktop, app switch on mobile) when a project
// id is configured.

import type { Eip1193Provider } from './evm';
import { NETWORKS } from '../chains';

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPadOS
}

export interface DeepLinkWallet {
  id: string;
  name: string;
  href: string;
}

/** Links that open the current page inside each wallet's in-app browser. */
export function walletAppLinks(url = window.location.href): { evm: DeepLinkWallet[]; svm: DeepLinkWallet[] } {
  const encoded = encodeURIComponent(url);
  const withoutScheme = url.replace(/^https?:\/\//, '');
  const ref = encodeURIComponent(window.location.origin);
  return {
    evm: [
      { id: 'metamask', name: 'MetaMask', href: `https://metamask.app.link/dapp/${withoutScheme}` },
      { id: 'coinbase', name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${encoded}` },
      { id: 'trust', name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encoded}` },
      { id: 'okx', name: 'OKX Wallet', href: `https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encoded}`)}` },
    ],
    svm: [
      { id: 'phantom', name: 'Phantom', href: `https://phantom.app/ul/browse/${encoded}?ref=${ref}` },
      { id: 'solflare', name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${encoded}?ref=${ref}` },
    ],
  };
}

// ---------------------------------------------------------------------------
// WalletConnect (EVM)
// ---------------------------------------------------------------------------

const PROJECT_ID = ((import.meta.env ?? {}) as Record<string, string | undefined>).VITE_WALLETCONNECT_PROJECT_ID?.trim() ?? '';

/** WalletConnect needs a free project id from https://cloud.reown.com (VITE_WALLETCONNECT_PROJECT_ID). */
export const walletConnectEnabled = PROJECT_ID.length > 0;

type WalletConnectProvider = Eip1193Provider & {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  accounts: string[];
  session?: unknown;
};

let providerPromise: Promise<WalletConnectProvider> | null = null;

export function getWalletConnectProvider(): Promise<WalletConnectProvider> {
  if (!walletConnectEnabled) return Promise.reject(new Error('WalletConnect is not configured.'));
  providerPromise ??= (async () => {
    const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
    const evmNetworks = NETWORKS.filter((network) => network.vm === 'evm');
    const provider = await EthereumProvider.init({
      projectId: PROJECT_ID,
      showQrModal: true,
      optionalChains: evmNetworks.map((network) => network.id) as [number, ...number[]],
      rpcMap: Object.fromEntries(evmNetworks.map((network) => [network.id, network.rpcUrl])),
      metadata: {
        name: 'Hopr',
        description: 'Cross-chain trading terminal',
        url: window.location.origin,
        icons: [`${window.location.origin}/brand/logo-icon.png`],
      },
    });
    return provider as unknown as WalletConnectProvider;
  })().catch((error) => {
    providerPromise = null;
    throw error;
  });
  return providerPromise;
}

/** Open the WalletConnect modal (QR code on desktop, wallet picker on mobile) and return the account. */
export async function connectWalletConnect(): Promise<{ provider: WalletConnectProvider; address: string }> {
  const provider = await getWalletConnectProvider();
  if (!provider.session) await provider.connect();
  const address = provider.accounts?.[0];
  if (!address) throw new Error('WalletConnect did not return an account.');
  return { provider, address };
}

/** Resume an existing WalletConnect session after a reload, without prompting. */
export async function restoreWalletConnect(): Promise<{ provider: WalletConnectProvider; address: string } | null> {
  if (!walletConnectEnabled) return null;
  const provider = await getWalletConnectProvider().catch(() => null);
  const address = provider?.session ? provider.accounts?.[0] : undefined;
  return provider && address ? { provider, address } : null;
}

export async function disconnectWalletConnect(): Promise<void> {
  if (!providerPromise) return;
  const provider = await providerPromise.catch(() => null);
  await provider?.disconnect().catch(() => undefined);
}
