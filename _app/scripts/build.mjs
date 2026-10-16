// Builds the app into dist/: the background process and its index worker
// (ESM, run by Electron's Node), the preload bridge (CommonJS, sandboxed), and
// the window (Vite + React).
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeNotices } from "./notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const t0 = Date.now();
fs.rmSync(path.join(dist, "main"), { recursive: true, force: true });
fs.rmSync(path.join(dist, "preload"), { recursive: true, force: true });

await esbuild({
  absWorkingDir: root,
  entryPoints: { main: "src/main/main.ts", "index-worker": "src/main/index/worker.ts" },
  outdir: "dist/main",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  // Some bundled packages still call require(); give ESM a working one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  sourcemap: "linked",
  legalComments: "linked",
  logLevel: "warning",
});

await esbuild({
  absWorkingDir: root,
  entryPoints: ["src/preload/preload.ts"],
  outfile: "dist/preload/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "chrome140",
  external: ["electron"],
  logLevel: "warning",
});

await vite({ configFile: path.join(root, "vite.config.ts"), logLevel: "warn" });

// The installer's shell (see src/shell/shell.ts): kept apart from dist/, which is
// the app code that also ships through the sync repository.
await esbuild({
  absWorkingDir: root,
  entryPoints: ["src/shell/shell.ts"],
  outfile: "dist-shell/shell.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  logLevel: "warning",
});

// What older installs (shell 1) find where the app used to be, in a conversations
// repository: it runs the app from the app's own repository (src/shell/forwarder.ts).
fs.rmSync(path.join(root, "dist-forwarder"), { recursive: true, force: true });
await esbuild({
  absWorkingDir: root,
  entryPoints: ["src/shell/forwarder.ts"],
  outfile: "dist-forwarder/main/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  logLevel: "warning",
});

// Claude's Agent SDK must never be inside the app's code: its licence doesn't allow
// shipping it in the public repository. The app loads it from the PC (src/main/chat/sdk.ts).
for (const f of ["main/main.mjs", "main/index-worker.mjs"]) {
  const text = fs.readFileSync(path.join(dist, f), "utf8");
  if (/node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk/.test(text)) throw new Error(`dist/${f} contains Claude's Agent SDK: import it only through src/main/chat/sdk.ts (types with "import type")`);
}

// The licences of what the bundles include travel with them.
writeNotices(root, path.join(dist, "THIRD-PARTY-NOTICES.txt"));

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// The shell compares this with the copy it was installed with (see src/shell/choose.ts).
fs.writeFileSync(path.join(dist, "app.json"), `${JSON.stringify({ version: pkg.version, minShell: "1.0.0", builtAt: new Date().toISOString() }, null, 2)}\n`);
fs.writeFileSync(path.join(root, "dist-forwarder", "app.json"), `${JSON.stringify({ version: pkg.version, minShell: "1.0.0", forwarder: true, builtAt: new Date().toISOString() }, null, 2)}\n`);

console.log(`built in ${Date.now() - t0} ms`);
