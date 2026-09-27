import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { apiUrl } from '../services/api';

type WalletState = {
  evmAddress: string | null;
  solanaAddress: string | null;
  source: 'browser' | 'telegram' | null;
};

type EvmProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type SolanaProvider = {
  connect: () => Promise<{ publicKey?: { toString: () => string } }>;
  disconnect?: () => Promise<void>;
};

declare global {
  interface Window {
    ethereum?: EvmProvider;
    solana?: SolanaProvider;
  }
}

interface WalletContextValue extends WalletState {
  isReady: boolean;
  connectEvm: () => Promise<string | null>;
  connectSolana: () => Promise<string | null>;
  disconnectEvm: () => void;
  disconnectSolana: () => void;
  telegramUser: { id: number; firstName?: string; username?: string } | null;
  isTelegramSyncing: boolean;
};

const STORAGE_KEY = 'hopr-connected-wallets';
const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function readWallets(): WalletState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as WalletState;
    return {
      evmAddress: typeof stored.evmAddress === 'string' ? stored.evmAddress : null,
      solanaAddress: typeof stored.solanaAddress === 'string' ? stored.solanaAddress : null,
      source: stored.source === 'telegram' ? 'telegram' : stored.evmAddress || stored.solanaAddress ? 'browser' : null,
    };
  } catch {
    return { evmAddress: null, solanaAddress: null, source: null };
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<WalletState>(() => readWallets());
  const [telegramUser, setTelegramUser] = useState<WalletContextValue['telegramUser']>(null);
  const [isTelegramSyncing, setIsTelegramSyncing] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
      } catch {
        // Keep wallet state usable if storage is blocked.
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [wallets]);

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
          wallet?: { evmAddress?: string; solanaAddress?: string } | null;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? 'Telegram authentication failed');
        setTelegramUser(data.user ?? null);
        if (data.wallet) {
          setWallets({
            evmAddress: data.wallet.evmAddress ?? null,
            solanaAddress: data.wallet.solanaAddress ?? null,
            source: 'telegram',
          });
        }
      })
      .catch((error) => console.warn('Telegram wallet sync unavailable:', error instanceof Error ? error.message : error))
      .finally(() => setIsTelegramSyncing(false));
  }, []);

  const connectEvm = async () => {
    if (!window.ethereum) throw new Error('No EVM wallet detected. Install MetaMask or another EVM wallet.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[];
    const address = accounts?.[0] ?? null;
    setWallets((current) => ({ ...current, evmAddress: address, source: 'browser' }));
    return address;
  };

  const connectSolana = async () => {
    if (!window.solana) throw new Error('No Solana wallet detected. Install Phantom or another Solana wallet.');
    const result = await window.solana.connect();
    const address = result.publicKey?.toString() ?? null;
    setWallets((current) => ({ ...current, solanaAddress: address, source: 'browser' }));
    return address;
  };

  return (
    <WalletContext.Provider
      value={{
        ...wallets,
        isReady: Boolean(wallets.evmAddress && wallets.solanaAddress),
        connectEvm,
        connectSolana,
        disconnectEvm: () => setWallets((current) => ({ ...current, evmAddress: null })),
        disconnectSolana: () => setWallets((current) => ({ ...current, solanaAddress: null })),
        telegramUser,
        isTelegramSyncing,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used within WalletProvider');
  return context;
}
