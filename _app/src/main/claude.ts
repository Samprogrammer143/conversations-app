// Finds this PC's Claude Code: the executable the in-app chat and Open in CLI use.
// The app never reads credentials; "signed in" only checks that Claude Code has
// a login on this PC. Nothing here blocks the app: the PATH lookup and the
// version check run as background processes, and their result is kept.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { claudeDir } from "./paths";
import { log } from "./log";

export interface ClaudeInstall {
  found: boolean;
  path: string | null;
  version: string | null;
  signedIn: boolean | null;
}

const KEEP_MS = 60_000;
let cached: { at: number; value: ClaudeInstall } | null = null;
let refreshing: Promise<ClaudeInstall> | null = null;

/** Runs a program and returns its output (empty on any failure). Never blocks. */
function run(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done();
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", done);
    child.on("close", done);
  });
}

/** The usual install places (no process started). */
function knownCandidates(): string[] {
  const out: string[] = [];
  if (process.env.CONVERSATIONS_CLAUDE_PATH) out.push(process.env.CONVERSATIONS_CLAUDE_PATH);
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  // Native installer, then npm global install (whose bin is a real .exe since 2.1).
  out.push(path.join(home, ".local", "bin", "claude.exe"));
  out.push(path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  out.push(path.join(local, "Programs", "claude", "claude.exe"));
  return out;
}

/** Anything on PATH, with a .cmd shim resolved to the executable it starts. */
async function pathCandidates(): Promise<string[]> {
  const out: string[] = [];
  const where = await run("where.exe", ["claude"], 10_000);
  for (const line of where.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (line.toLowerCase().endsWith(".exe")) out.push(line);
    else if (line.toLowerCase().endsWith(".cmd")) {
      try {
        const m = fs.readFileSync(line, "utf8").match(/"%dp0%\\([^"]+\.exe)"/i);
        if (m) out.push(path.join(path.dirname(line), m[1]));
      } catch {}
    }
  }
  return out;
}

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function signedInNow(): boolean | null {
  try {
    if (fs.existsSync(path.join(claudeDir(), ".credentials.json"))) return true;
    // Claude Code keeps its account record beside the usual folder, but inside one set by CLAUDE_CONFIG_DIR (a workspace).
    const record = process.env.CLAUDE_CONFIG_DIR ? path.join(claudeDir(), ".claude.json") : path.join(os.homedir(), ".claude.json");
    const cfg = JSON.parse(fs.readFileSync(record, "utf8"));
    return !!cfg?.oauthAccount;
  } catch {
    return null;
  }
}

/** The last known install, at once. Before the first full look: the usual places only, version unknown. */
export function claudeInstall(): ClaudeInstall {
  if (cached) return cached.value;
  const exe = knownCandidates().find(isFile) ?? null;
  return { found: !!exe, path: exe, version: null, signedIn: signedInNow() };
}

/**
 * An npm install of Claude Code whose update stopped halfway: its package is there
 * but bin/claude.exe isn't (npm can block the install step that puts the program in
 * place, leaving only claude.exe.old.*). Its own install step is run again, at most
 * every ten minutes. Returns whether the program is there afterwards.
 */
let repairedAt = 0;
export async function repairNpmInstall(pkg = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code"), node = process.execPath): Promise<boolean> {
  const exe = path.join(pkg, "bin", "claude.exe");
  const step = path.join(pkg, "install.cjs");
  if (isFile(exe) || !isFile(step) || Date.now() - repairedAt < 10 * 60_000) return isFile(exe);
  repairedAt = Date.now();
  log("app", "Claude Code's program is missing after an update; running its install step again");
  await new Promise<void>((done) => {
    // Electron runs the script as plain Node (needs the RunAsNode fuse, on in this app's builds).
    const child = spawn(node, [step], { cwd: pkg, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", () => done());
    child.on("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
  const ok = isFile(exe);
  log("app", ok ? "Claude Code repaired" : "Claude Code could not be repaired: reinstall it");
  return ok;
}

/** Looks again (PATH and version) in the background; kept for a minute unless forced. */
export function refreshClaude(force = false): Promise<ClaudeInstall> {
  if (!force && cached && Date.now() - cached.at < KEEP_MS) return Promise.resolve(cached.value);
  refreshing ??= (async () => {
    let exe = knownCandidates().find(isFile) ?? null;
    if (!exe) exe = (await pathCandidates()).find(isFile) ?? null;
    // Half way through an update: repaired in the background (never holding up this look), then looked at again.
    if (!exe) void repairNpmInstall().then((ok) => ok && void refreshClaude(true));
    const version = exe ? ((await run(exe, ["--version"], 15_000)).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null) : null;
    const value: ClaudeInstall = { found: !!exe, path: exe, version, signedIn: signedInNow() };
    cached = { at: Date.now(), value };
    return value;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** The model Claude Code starts with on this PC (its settings), if one is set. */
export function claudeDefaultModel(): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir(), "settings.json"), "utf8"));
    return typeof s?.model === "string" && s.model.trim() ? s.model.trim() : null;
  } catch {
    return null;
  }
}

let terminal: boolean | null = null;

/** Windows Terminal is installed. Answers at once; a PATH lookup runs in the background the first time. */
export function hasWindowsTerminal(): boolean {
  if (terminal !== null) return terminal;
  const alias = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "wt.exe");
  if (fs.existsSync(alias)) return (terminal = true);
  void run("where.exe", ["wt"], 10_000).then((out) => (terminal = out.trim().length > 0));
  return false;
}
