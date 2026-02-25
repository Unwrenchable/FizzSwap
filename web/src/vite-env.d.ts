/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOLANA_RPC: string | undefined;
  readonly VITE_SOLANA_PROGRAM_ID: string | undefined;
  readonly VITE_RELAYER_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
