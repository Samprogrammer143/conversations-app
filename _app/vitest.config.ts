import { defineConfig } from "vitest/config";

// Tests run from the project root (vite.config.ts roots the window's build in src/renderer).
export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
