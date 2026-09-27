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
    ready: () => void;
    expand?: () => void;
    close?: () => void;
  }

  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}
