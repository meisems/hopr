interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_TELEGRAM_BOT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
