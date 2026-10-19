// Workspaces: one Claude account each. A workspace is its own Claude Code folder
// (login, settings, MCP servers, skills, conversations), its own sync folder and
// conversations repository, and its own app data (the index, drafts, settings).
//
// The first workspace is the setup that was here before: the usual folders, no
// environment. Another one is chosen by setting CLAUDE_CONFIG_DIR, CLAUDE_SYNC_HOME
// and CONVERSATIONS_DATA_DIR before the rest of the app reads any path, so every
// part of it (and every Claude Code and sync it starts) uses that workspace's
// folders. This module is imported first by main.ts for that reason.
//
// The app's code and the sync engine come from the app's own repository (one copy
// per PC, shared by every workspace); a workspace's repository holds only its
// conversations. (A PC still on the old layout runs them from the first
// workspace's repository until it moves.)
// Switching restarts the app into the other workspace, so nothing from one can
// mix with the other. Another workspace can also open in a window of its own: a
// second copy of the app, started for that workspace (`--workspace=<id>`), with its own
// tray icon and sync. Each copy keeps to the workspace it started in.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRepoDir } from "./paths";

export interface Workspace {
  /** "main" for the first one; a short name from the workspace's name otherwise. */
  id: string;
  name: string;
  /** The conversations repository (none recorded for the first one: it is the sync's own). */
  remote: string | null;
  claudeDir: string;
  syncHome: string;
  dataDir: string;
  /**
   * Left out of Conversations on this PC: not shown, not synced by the app, never
   * started in. Its Claude Code folder and chats stay as they are (a PC that already had
   * Claude Code, with another account's chats, keeps them out of Conversations this way).
   */
  disconnected: boolean;
}

interface Registry {
  current: string;
  /** The name shown for the first workspace. */
  mainName?: string;
  extra: Omit<Workspace, "claudeDir" | "syncHome" | "dataDir" | "disconnected">[];
  disconnected?: string[];
}

const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_SYNC_HOME", "CONVERSATIONS_DATA_DIR", "CONVERSATIONS_ENGINE"] as const;
type BaseEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

const local = () => process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

/**
 * The environment the app was started with, before a workspace changed it. Carried
 * across the app's own restart only (CONVERSATIONS_RELAUNCH): every chat and terminal
 * inherits it too, and a start from one of those must keep the folders it was given.
 */
const BASE: BaseEnv = (() => {
  const relaunch = process.env.CONVERSATIONS_RELAUNCH;
  delete process.env.CONVERSATIONS_RELAUNCH;
  try {
    if (relaunch && process.env.CONVERSATIONS_BASE_ENV) return JSON.parse(process.env.CONVERSATIONS_BASE_ENV) as BaseEnv;
  } catch {}
  const b: BaseEnv = {};
  for (const k of ENV_KEYS) if (process.env[k]) b[k] = process.env[k];
  process.env.CONVERSATIONS_BASE_ENV = JSON.stringify(b);
  return b;
})();

const baseDataDir = () => BASE.CONVERSATIONS_DATA_DIR || path.join(local(), "Conversations");
const baseSyncHome = () => BASE.CLAUDE_SYNC_HOME || path.join(local(), "claude-conversation-sync");
const baseClaudeDir = () => BASE.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const registryFile = () => path.join(baseDataDir(), "workspaces.json");

/** Whether the app was started with an engine of its own (development, tests), not the one a workspace sets. */
export const engineOverridden = () => !!BASE.CONVERSATIONS_ENGINE;
/** The first workspace's conversations repository (its shared list of workspaces lives there). */
export const baseRepoDir = () => path.join(baseSyncHome(), "repo");
/** The sync engine every workspace runs: the app repository's, else (old layout) the first workspace's. */
export const baseEngine = () => {
  if (BASE.CONVERSATIONS_ENGINE) return BASE.CONVERSATIONS_ENGINE;
  const app = path.join(appRepoDir(), "_sync", "sync.mjs");
  return fs.existsSync(app) ? app : path.join(baseRepoDir(), "_sync", "sync.mjs");
};
/** The environment the first workspace runs with (for keeping its sync current from another one). */
export function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ENV_KEYS) {
    if (BASE[k]) env[k] = BASE[k];
    else delete env[k];
  }
  return env;
}

export function folders(id: string): Pick<Workspace, "claudeDir" | "syncHome" | "dataDir"> {
  if (id === "main") return { claudeDir: baseClaudeDir(), syncHome: baseSyncHome(), dataDir: baseDataDir() };
  return { claudeDir: `${baseClaudeDir()}-${id}`, syncHome: `${baseSyncHome()}-${id}`, dataDir: path.join(baseDataDir(), "workspaces", id) };
}

export const isWorkspaceId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v);

function readRegistry(): Registry {
  let text: string;
  try {
    text = fs.readFileSync(registryFile(), "utf8");
  } catch {
    return { current: "main", extra: [] };
  }
  try {
    const r = JSON.parse(text) as Partial<Registry>;
    const extra = (Array.isArray(r.extra) ? r.extra : []).filter((w) => w && isWorkspaceId(w.id) && w.id !== "main" && typeof w.name === "string" && typeof w.remote === "string");
    const ids = ["main", ...extra.map((w) => w.id)];
    const disconnected = [...new Set((Array.isArray(r.disconnected) ? r.disconnected : []).filter((d) => ids.includes(d)))];
    // Never started in a disconnected workspace while a connected one exists.
    const connected = ids.filter((d) => !disconnected.includes(d));
    let current = typeof r.current === "string" && ids.includes(r.current) ? r.current : "main";
    if (disconnected.includes(current) && connected.length) current = connected[0];
    return { current, mainName: typeof r.mainName === "string" && r.mainName.trim() ? r.mainName : undefined, extra, ...(disconnected.length ? { disconnected } : {}) };
  } catch {
    // Unreadable: kept aside, so the next write never overwrites the only copy.
    try {
      fs.renameSync(registryFile(), `${registryFile()}.unreadable-${Date.now()}`);
    } catch {}
    return { current: "main", extra: [] };
  }
}

function writeRegistry(r: Registry) {
  const f = registryFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, f);
}

export function listWorkspaces(): { current: string; workspaces: Workspace[] } {
  const r = readRegistry();
  const off = new Set(r.disconnected ?? []);
  const main: Workspace = { id: "main", name: r.mainName ?? "Main", remote: null, ...folders("main"), disconnected: off.has("main") };
  return { current: r.current, workspaces: [main, ...r.extra.map((w) => ({ ...w, ...folders(w.id), disconnected: off.has(w.id) }))] };
}

/** Leaves a workspace out of Conversations on this PC, or brings it back. */
export function setDisconnected(id: string, on: boolean) {
  const r = readRegistry();
  const set = new Set(r.disconnected ?? []);
  if (on) set.add(id);
  else set.delete(id);
  r.disconnected = [...set];
  if (!r.disconnected.length) delete r.disconnected;
  writeRegistry(r);
}

/** The workspace this copy of the app is in: chosen once, when it starts (see the end of this file). */
let thisId: string | null = null;

export const currentWorkspace = (): Workspace => {
  const { current, workspaces } = listWorkspaces();
  return workspaces.find((w) => w.id === thisId) ?? workspaces.find((w) => w.id === current) ?? workspaces[0];
};

/** The workspace a plain start of the app opens: the one last switched to. */
export const defaultWorkspaceId = () => listWorkspaces().current;

/**
 * The workspace a start asks for: `--workspace=<id>` (a window of its own, or a restart
 * that stays where it was), or the one a notification's button names (`conversations://…?ws=<id>`).
 */
export function askedFor(argv: string[]): string | null {
  for (const a of argv) {
    const m = /^--workspace=([a-z0-9][a-z0-9-]{0,39})$/.exec(a);
    if (m) return m[1];
  }
  const url = argv.find((a) => a.startsWith("conversations://"));
  return (url && /[?&]ws=([a-z0-9][a-z0-9-]{0,39})(?:[&#]|$)/.exec(url)?.[1]) || null;
}

/** Where each open copy of the app records the workspace it is in (see open-windows.ts). */
export const openMarksDir = () => path.join(baseDataDir(), "open");

/** A short id from a name ("Work" -> "work"), not one already used. */
export function newWorkspaceId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "workspace";
  const taken = new Set(listWorkspaces().workspaces.map((w) => w.id));
  let id = base === "main" ? "main-2" : base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export function addWorkspace(w: { id: string; name: string; remote: string }): Workspace {
  const r = readRegistry();
  r.extra = [...r.extra.filter((x) => x.id !== w.id), { id: w.id, name: w.name, remote: w.remote }];
  writeRegistry(r);
  return { ...w, ...folders(w.id), disconnected: (r.disconnected ?? []).includes(w.id) };
}

export function renameWorkspace(id: string, name: string) {
  const r = readRegistry();
  if (id === "main") r.mainName = name;
  else r.extra = r.extra.map((w) => (w.id === id ? { ...w, name } : w));
  writeRegistry(r);
}

export function removeWorkspace(id: string) {
  if (id === "main") return;
  const r = readRegistry();
  r.extra = r.extra.filter((w) => w.id !== id);
  if (r.disconnected) r.disconnected = r.disconnected.filter((d) => d !== id);
  if (r.current === id) r.current = "main";
  writeRegistry(r);
}

/** Just before the app restarts itself: the next start keeps this one's launch environment. */
export function markRelaunch() {
  restoreBaseEnv();
  process.env.CONVERSATIONS_RELAUNCH = "1";
}

/** Puts the environment back to how the app was started: any restart (a switch, an update) starts from it. */
export function restoreBaseEnv() {
  for (const k of ENV_KEYS) {
    if (BASE[k]) process.env[k] = BASE[k];
    else delete process.env[k];
  }
  delete process.env.CONVERSATIONS_CLAUDE_LAUNCHER;
}

/** Records the workspace to start in, and puts the environment back for the restart. */
export function prepareSwitch(id: string) {
  const r = readRegistry();
  r.current = id;
  writeRegistry(r);
  restoreBaseEnv();
}

/** Where Claude Code keeps the first workspace's account record (beside the usual folder, inside one that was set). */
export const mainAccountRecord = () => (BASE.CLAUDE_CONFIG_DIR ? path.join(BASE.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json"));

/** The first workspace's repository address, from its sync settings. */
export function mainRemote(): string | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(baseSyncHome(), "config.json"), "utf8"));
    return typeof c?.remote === "string" ? c.remote : null;
  } catch {
    return null;
  }
}

/** The environment a workspace's Claude Code runs with (a sign-in terminal, its own `claude-<id>` command). */
export function workspaceEnv(w: Workspace): Record<string, string> {
  return w.id === "main" ? {} : { CLAUDE_CONFIG_DIR: w.claudeDir, CLAUDE_SYNC_HOME: w.syncHome };
}

// Applied once, now: everything imported after this module sees the workspace's folders.
(() => {
  // The one this start asked for, when it is here and connected; otherwise the default.
  const asked = askedFor(process.argv);
  const w = listWorkspaces().workspaces.find((x) => x.id === asked && !x.disconnected) ?? currentWorkspace();
  thisId = w.id;
  // Always from the launch environment: a start from a terminal another workspace opened
  // must not keep that workspace's folders.
  restoreBaseEnv();
  if (w.id === "main") return;
  process.env.CLAUDE_CONFIG_DIR = w.claudeDir;
  process.env.CLAUDE_SYNC_HOME = w.syncHome;
  process.env.CONVERSATIONS_DATA_DIR = w.dataDir;
  // The engine is the first workspace's; this workspace's repository has none.
  process.env.CONVERSATIONS_ENGINE = baseEngine();
})();
