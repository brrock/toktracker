import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  build: {
    // The gateway's CSP only allows same-origin fonts, so never inline font
    // subsets as data: URIs.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
  clearScreen: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: Number(process.env.TOKTRACKER_DASHBOARD_PORT ?? 5173),
    proxy: {
      "/api": process.env.TOKTRACKER_GATEWAY ?? "http://localhost:3000",
    },
    strictPort: true,
  },
});
