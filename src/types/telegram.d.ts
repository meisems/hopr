export {};

declare global {
  interface TelegramWebAppUser {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
  }

  interface TelegramWebApp {
    initData: string;
    initDataUnsafe?: { user?: TelegramWebAppUser };
    colorScheme?: 'light' | 'dark';
    ready: () => void;
    expand?: () => void;
    close?: () => void;
    setHeaderColor?: (color: string) => void;
    setBackgroundColor?: (color: string) => void;
    onEvent?: (event: string, handler: () => void) => void;
    offEvent?: (event: string, handler: () => void) => void;
    HapticFeedback?: {
      impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
      selectionChanged: () => void;
    };
  }

  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}
