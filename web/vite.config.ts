import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ include: ["buffer", "crypto", "process"] }),
  ],
  define: {
    "process.env.VITE_SOLANA_RPC": JSON.stringify(process.env.VITE_SOLANA_RPC || ""),
    "process.env.VITE_SOLANA_PROGRAM_ID": JSON.stringify(process.env.VITE_SOLANA_PROGRAM_ID || ""),
    "process.env.VITE_RELAYER_URL": JSON.stringify(process.env.VITE_RELAYER_URL || ""),
  },
});
