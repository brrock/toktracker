import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// Must match the gateway's policy for /sandbox/ (apps/gateway/src/app.ts).
const SANDBOX_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SANDBOX_OUTPUT = "sandbox/[name]-[hash].js";

// The dev server has no gateway in front of its worker scripts, so give the
// query sandbox the same network-free policy there as in production.
const sandboxPolicyInDevelopment = (): Plugin => ({
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.includes("query.worker.ts")) {
        response.setHeader("Content-Security-Policy", SANDBOX_POLICY);
      }
      next();
    });
  },
  name: "toktracker-sandbox-policy",
});

// https://vite.dev/config/
export default defineConfig({
  build: {
    // The gateway's CSP only allows same-origin fonts, so never inline font
    // subsets as data: URIs.
    assetsInlineLimit: (file) =>
      file.endsWith(".woff2") || file.endsWith(".wasm") ? false : undefined,
  },
  clearScreen: false,
  plugins: [react(), tailwindcss(), sandboxPolicyInDevelopment()],
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
  worker: {
    format: "es",
    // Worker bundles live under /sandbox/, which the gateway serves with the
    // sandbox policy instead of the page policy.
    rolldownOptions: {
      output: {
        chunkFileNames: SANDBOX_OUTPUT,
        entryFileNames: SANDBOX_OUTPUT,
      },
    },
  },
});
