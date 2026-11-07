import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The phone app's code (src/phone): the window's React, built for Android's WebView.
// Capacitor (android/) takes it from dist-phone.
export default defineConfig({
  root: here("./src/phone"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: here("./dist-phone"),
    emptyOutDir: true,
    target: "chrome120",
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5299, strictPort: true, host: "127.0.0.1", fs: { allow: [here("./src"), here("./scripts"), here("./node_modules")] } },
});
