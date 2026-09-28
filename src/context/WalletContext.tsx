import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { apiUrl } from '../services/api';
import type { Vm } from '../services/chains';
import type { Signers } from '../services/router';
import {
  connectEvmWallet,
  findEvmWallet,
  listEvmWallets,
  restoreEvmWallet,
  startEvmDiscovery,
  subscribeEvmWallets,
  type EvmWalletInfo,
} from '../services/wallets/evm';
import { connectSolanaWallet, findSolanaWallet, listSolanaWallets, type SolanaWalletInfo } from '../services/wallets/solana';

interface ConnectedWallet {
  address: string;
  walletId: string;
  walletName: string;
}

/** Custodial wallet created in the Telegram bot; shown read-only on the dashboard. */
interface TelegramWallet {
  evmAddress: string | null;
  solanaAddress: string | null;
  nearAddress: string | null;
}

interface WalletContextValue {
  evm: ConnectedWallet | null;
  svm: ConnectedWallet | null;
  near: ConnectedWallet | null;
  /** Convenience accessors for the browser-connected addresses. */
  evmAddress: string | null;
  solanaAddress: string | null;
  nearAddress: string | null;
  /** 'telegram' when the page runs inside the Telegram Mini App with a synced custodial wallet. */
  source: 'browser' | 'telegram' | null;
  telegramWallet: TelegramWallet | null;
  telegramUser: { id: number; firstName?: string; username?: string } | null;
  isTelegramSyncing: boolean;
  isReady: boolean;
  evmWallets: EvmWalletInfo[];
  solanaWallets: SolanaWalletInfo[];
  connectEvm: (walletId?: string) => Promise<string | null>;
  connectSolana: (walletId?: string) => Promise<string | null>;
  connectNear: (walletId: string) => Promise<string | null>;
  disconnectEvm: () => void;
  disconnectSolana: () => void;
  disconnectNear: () => Promise<void>;
  createTelegramWallet: () => Promise<void>;
  /** Signers for the router, from the currently connected wallets. */
  getSigners: () => Signers;
  addressFor: (vm: Vm) => string | null;
  walletModal: { open: boolean; focus: Vm | null };
  openWalletModal: (focus?: Vm) => void;
  closeWalletModal: () => void;
}

const STORAGE_KEY = 'hopr-wallet-connections-v2';
const WalletContext = createContext<WalletContextValue | undefined>(undefined);

type Remembered = { evmWalletId?: string; svmWalletId?: string; near?: boolean };

function readRemembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Remembered;
  } catch {
    return {};
  }
}

function remember(patch: Remembered) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readRemembered(), ...patch }));
  } catch {
    // Reconnect-on-reload is a convenience only.
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [evm, setEvm] = useState<ConnectedWallet | null>(null);
  const [svm, setSvm] = useState<ConnectedWallet | null>(null);
  const [near, setNear] = useState<ConnectedWallet | null>(null);
  const [evmWallets, setEvmWallets] = useState<EvmWalletInfo[]>([]);
  const [solanaWallets, setSolanaWallets] = useState<SolanaWalletInfo[]>([]);
  const [telegramWallet, setTelegramWallet] = useState<TelegramWallet | null>(null);
  const [telegramUser, setTelegramUser] = useState<WalletContextValue['telegramUser']>(null);
  const [isTelegramSyncing, setIsTelegramSyncing] = useState(false);
  const [walletModal, setWalletModal] = useState<{ open: boolean; focus: Vm | null }>({ open: false, focus: null });
  const evmProviderRef = useRef<EvmWalletInfo | null>(null);
  const svmProviderRef = useRef<SolanaWalletInfo | null>(null);

  // Wallet discovery + silent reconnect of previously approved wallets.
  useEffect(() => {
    startEvmDiscovery();
    const refresh = () => setEvmWallets(listEvmWallets());
    refresh();
    const unsubscribe = subscribeEvmWallets(refresh);
    setSolanaWallets(listSolanaWallets());
    // Some extensions inject a moment after load.
    const late = window.setTimeout(() => { refresh(); setSolanaWallets(listSolanaWallets()); }, 800);

    const saved = readRemembered();
    const restoreTimer = window.setTimeout(async () => {
      if (saved.evmWalletId) {
        const wallet = findEvmWallet(saved.evmWalletId);
        const address = wallet ? await restoreEvmWallet(wallet) : null;
        if (wallet && address) {
          evmProviderRef.current = wallet;
          setEvm({ address, walletId: wallet.id, walletName: wallet.name });
        }
      }
      if (saved.svmWalletId) {
        const wallet = findSolanaWallet(saved.svmWalletId);
        const address = wallet ? await connectSolanaWallet(wallet, true).catch(() => null) : null;
        if (wallet && address) {
          svmProviderRef.current = wallet;
          setSvm({ address, walletId: wallet.id, walletName: wallet.name });
        }
      }
      if (saved.near) {
        const { getNearAccount } = await import('../services/wallets/near');
        const account = await getNearAccount().catch(() => null);
        if (account) setNear({ address: account.accountId, walletId: account.walletId ?? 'near', walletName: account.walletId ?? 'NEAR wallet' });
      }
    }, 400);
    return () => {
      unsubscribe();
      window.clearTimeout(late);
      window.clearTimeout(restoreTimer);
    };
  }, []);

  // Follow account / disconnect changes made inside the EVM wallet.
  useEffect(() => {
    const provider = evmProviderRef.current?.provider;
    if (!evm || !provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      if (!accounts?.length) {
        setEvm(null);
        remember({ evmWalletId: undefined });
      } else {
        setEvm((current) => (current ? { ...current, address: accounts[0] } : current));
      }
    };
    provider.on('accountsChanged', onAccounts);
    return () => provider.removeListener?.('accountsChanged', onAccounts);
  }, [evm?.walletId]);

  // NEAR redirect wallets (MyNearWallet) finish sign-in after navigating back.
  useEffect(() => {
    if (!readRemembered().near) return;
    let unsubscribe: (() => void) | null = null;
    void import('../services/wallets/near').then(async ({ subscribeNearAccounts }) => {
      unsubscribe = await subscribeNearAccounts((accountId) => {
        setNear((current) => (accountId ? { address: accountId, walletId: current?.walletId ?? 'near', walletName: current?.walletName ?? 'NEAR wallet' } : null));
      });
    }).catch(() => undefined);
    return () => unsubscribe?.();
  }, [near?.walletId]);

  // Telegram Mini App: sync the custodial wallet created in the bot (display only).
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) return;
    webApp.ready();
    webApp.expand?.();
    setIsTelegramSyncing(true);
    fetch(apiUrl('/api/telegram/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: webApp.initData }),
    })
      .then(async (response) => {
        const data = await response.json() as {
          user?: { id: number; firstName?: string; username?: string };
          wallet?: { evmAddress?: string; solanaAddress?: string; nearAddress?: string | null } | null;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? 'Telegram authentication failed');
        setTelegramUser(data.user ?? null);
        if (data.wallet) {
          setTelegramWallet({
            evmAddress: data.wallet.evmAddress ?? null,
            solanaAddress: data.wallet.solanaAddress ?? null,
            nearAddress: data.wallet.nearAddress ?? null,
          });
        }
      })
      .catch((error) => console.warn('Telegram wallet sync unavailable:', error instanceof Error ? error.message : error))
      .finally(() => setIsTelegramSyncing(false));
  }, []);

  const connectEvm = useCallback(async (walletId?: string) => {
    const wallets = listEvmWallets();
    const wallet = (walletId ? wallets.find((item) => item.id === walletId) : undefined) ?? wallets[0];
    if (!wallet) throw new Error('No EVM wallet found. Install MetaMask, Rabby, or Coinbase Wallet.');
    const address = await connectEvmWallet(wallet);
    evmProviderRef.current = wallet;
    setEvm({ address, walletId: wallet.id, walletName: wallet.name });
    remember({ evmWalletId: wallet.id });
    return address;
  }, []);

  const connectSolana = useCallback(async (walletId?: string) => {
    const wallets = listSolanaWallets().filter((wallet) => wallet.provider);
    const wallet = (walletId ? wallets.find((item) => item.id === walletId) : undefined) ?? wallets[0];
    if (!wallet) throw new Error('No Solana wallet found. Install Phantom, Solflare, or Backpack.');
    const address = await connectSolanaWallet(wallet);
    if (!address) throw new Error('The wallet did not return an account.');
    svmProviderRef.current = wallet;
    setSvm({ address, walletId: wallet.id, walletName: wallet.name });
    remember({ svmWalletId: wallet.id });
    return address;
  }, []);

  const connectNear = useCallback(async (walletId: string) => {
    const { connectNearWallet, listNearWallets } = await import('../services/wallets/near');
    remember({ near: true });
    const accountId = await connectNearWallet(walletId);
    const name = (await listNearWallets()).find((wallet) => wallet.id === walletId)?.name ?? 'NEAR wallet';
    if (accountId) setNear({ address: accountId, walletId, walletName: name });
    return accountId;
  }, []);

  const disconnectEvm = useCallback(() => {
    evmProviderRef.current = null;
    setEvm(null);
    remember({ evmWalletId: undefined });
  }, []);

  const disconnectSolana = useCallback(() => {
    void svmProviderRef.current?.provider?.disconnect?.().catch(() => undefined);
    svmProviderRef.current = null;
    setSvm(null);
    remember({ svmWalletId: undefined });
  }, []);

  const disconnectNear = useCallback(async () => {
    const { disconnectNearWallet } = await import('../services/wallets/near');
    await disconnectNearWallet().catch(() => undefined);
    setNear(null);
    remember({ near: false });
  }, []);

  const createTelegramWallet = useCallback(async () => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.initData) throw new Error('Open Hopr from the Telegram Mini App to create a Telegram wallet.');
    setIsTelegramSyncing(true);
    try {
      const response = await fetch(apiUrl('/api/telegram/wallet/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: webApp.initData }),
      });
      const data = await response.json() as { wallet?: { evmAddress?: string; solanaAddress?: string; nearAddress?: string | null }; error?: string };
      if (!response.ok || !data.wallet) throw new Error(data.error ?? 'Unable to create a Telegram wallet.');
      setTelegramWallet({ evmAddress: data.wallet.evmAddress ?? null, solanaAddress: data.wallet.solanaAddress ?? null, nearAddress: data.wallet.nearAddress ?? null });
    } finally {
      setIsTelegramSyncing(false);
    }
  }, []);

  const getSigners = useCallback((): Signers => ({
    evm: evm && evmProviderRef.current ? { provider: evmProviderRef.current.provider, address: evm.address } : undefined,
    svm: svm && svmProviderRef.current?.provider ? { provider: svmProviderRef.current.provider, address: svm.address } : undefined,
    near: near ? { accountId: near.address } : undefined,
  }), [evm, svm, near]);

  const value = useMemo<WalletContextValue>(() => ({
    evm,
    svm,
    near,
    evmAddress: evm?.address ?? null,
    solanaAddress: svm?.address ?? null,
    nearAddress: near?.address ?? null,
    source: telegramWallet ? 'telegram' : evm || svm || near ? 'browser' : null,
    telegramWallet,
    telegramUser,
    isTelegramSyncing,
    isReady: Boolean(evm || svm || near),
    evmWallets,
    solanaWallets,
    connectEvm,
    connectSolana,
    connectNear,
    disconnectEvm,
    disconnectSolana,
    disconnectNear,
    createTelegramWallet,
    getSigners,
    addressFor: (vm: Vm) => (vm === 'evm' ? evm?.address : vm === 'svm' ? svm?.address : near?.address) ?? null,
    walletModal,
    openWalletModal: (focus?: Vm) => setWalletModal({ open: true, focus: focus ?? null }),
    closeWalletModal: () => setWalletModal({ open: false, focus: null }),
  }), [evm, svm, near, telegramWallet, telegramUser, isTelegramSyncing, evmWallets, solanaWallets, connectEvm, connectSolana, connectNear, disconnectEvm, disconnectSolana, disconnectNear, createTelegramWallet, getSigners, walletModal]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used within WalletProvider');
  return context;
}
