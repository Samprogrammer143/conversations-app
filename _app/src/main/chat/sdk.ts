// Claude's Agent SDK, found on this PC instead of built into the app: its licence
// doesn't allow shipping it inside the app's public repository. Each PC installs it
// from npm (the engine's ensureRuntime, into <app folder>-runtime/<lock hash>/);
// the installer brings a copy too, for a PC that hasn't installed it yet.
//
// loadSdk() runs once at start, before anything calls query().

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Sdk from "@anthropic-ai/claude-agent-sdk";
import { appRepoDir } from "../paths";

const PKG = path.join("node_modules", "@anthropic-ai", "claude-agent-sdk");
let mod: typeof Sdk | null = null;
let loadedFrom: string | null = null;

const hasSdk = (dir: string) => fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "sdk.mjs"));

/**
 * Where to look, best first. `installDir` is the app's folder (Electron's app path: a
 * development checkout has the SDK in its node_modules), `resourcesDir` the installed
 * app's resources (the installer's copy).
 */
export function sdkCandidates(installDir: string | null, resourcesDir: string | null = null): string[] {
  const out: string[] = [];
  if (process.env.CONVERSATIONS_SDK_DIR) out.push(process.env.CONVERSATIONS_SDK_DIR);
  // Developing (not installed): the checkout's own SDK, the version being worked on.
  if (installDir && !resourcesDir) out.push(path.join(installDir, PKG));
  const appDir = appRepoDir();
  const root = `${appDir}-runtime`;
  // The version the app's repository lists now.
  try {
    const lock = fs.readFileSync(path.join(appDir, "_app", "runtime", "package-lock.json"));
    const hash = crypto.createHash("sha256").update(lock).digest("hex").slice(0, 12);
    if (fs.existsSync(path.join(root, hash, ".ready"))) out.push(path.join(root, hash, PKG));
  } catch {}
  // Any other finished install, newest first (the list moved on, the new one isn't in yet).
  try {
    const dirs = fs
      .readdirSync(root)
      .map((n) => path.join(root, n))
      .filter((d) => fs.existsSync(path.join(d, ".ready")))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const d of dirs) out.push(path.join(d, PKG));
  } catch {}
  // The installer's copy, or a development checkout's.
  if (resourcesDir) out.push(path.join(resourcesDir, "sdk", PKG));
  if (installDir) out.push(path.join(installDir, PKG));
  return [...new Set(out)];
}

export async function loadSdk(installDir: string | null, resourcesDir: string | null = null): Promise<{ ok: boolean; from: string | null; err?: string }> {
  if (mod) return { ok: true, from: loadedFrom };
  let lastErr = "Claude's Agent SDK isn't installed on this PC";
  for (const dir of sdkCandidates(installDir, resourcesDir)) {
    if (!hasSdk(dir)) continue;
    try {
      mod = (await import(pathToFileURL(path.join(dir, "sdk.mjs")).href)) as typeof Sdk;
      loadedFrom = dir;
      return { ok: true, from: dir };
    } catch (e) {
      lastErr = `${dir}: ${(e as Error).message}`;
    }
  }
  return { ok: false, from: null, err: lastErr };
}

export const sdkLoadedFrom = () => loadedFrom;

/** The SDK's query(), once loadSdk() found it. */
export const query: typeof Sdk.query = ((...args: Parameters<typeof Sdk.query>) => {
  if (!mod) throw new Error("Claude's Agent SDK isn't installed on this PC yet: the app installs it with its next update, or reinstall Conversations");
  return mod.query(...args);
}) as typeof Sdk.query;
