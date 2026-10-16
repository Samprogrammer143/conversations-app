import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The page's Content-Security-Policy allows no network at all. Only the dev
// server (vite serve) adds itself, for hot reload; a build never contains it.
const devServerCsp = (): Plugin => ({
  name: "dev-server-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace("connect-src 'self'", "connect-src 'self' ws://localhost:5199 http://localhost:5199"),
});

// The window's code. Loaded from file:// by Electron, so every path is relative.
export default defineConfig({
  root: here("./src/renderer"),
  base: "./",
  plugins: [react(), devServerCsp()],
  build: {
    outDir: here("./dist/renderer"),
    emptyOutDir: true,
    target: "chrome140",
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5199, strictPort: true },
});
