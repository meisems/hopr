import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type WalletState = {
  evmAddress: string | null;
  solanaAddress: string | null;
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
}

const STORAGE_KEY = 'hopr-connected-wallets';
const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function readWallets(): WalletState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as WalletState;
    return {
      evmAddress: typeof stored.evmAddress === 'string' ? stored.evmAddress : null,
      solanaAddress: typeof stored.solanaAddress === 'string' ? stored.solanaAddress : null,
    };
  } catch {
    return { evmAddress: null, solanaAddress: null };
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<WalletState>(() => readWallets());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
  }, [wallets]);

  const connectEvm = async () => {
    if (!window.ethereum) throw new Error('No EVM wallet detected. Install MetaMask or another EVM wallet.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[];
    const address = accounts?.[0] ?? null;
    setWallets((current) => ({ ...current, evmAddress: address }));
    return address;
  };

  const connectSolana = async () => {
    if (!window.solana) throw new Error('No Solana wallet detected. Install Phantom or another Solana wallet.');
    const result = await window.solana.connect();
    const address = result.publicKey?.toString() ?? null;
    setWallets((current) => ({ ...current, solanaAddress: address }));
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
