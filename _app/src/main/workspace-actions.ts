// What the window can do with workspaces: list them, add one (its sync is set up
// by the installer of the first workspace's engine, against the new repository),
// sign in to its Claude account, and the `claude-<id>` command that starts Claude
// Code in it from any terminal. The list of workspaces is shared through the first
// workspace's repository, so every PC can set up the ones the others have.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { WorkspaceInfo } from "../shared/types";
import { addWorkspace, baseEngine, baseEnv, baseRepoDir, isWorkspaceId, listWorkspaces, mainAccountRecord, mainRemote, newWorkspaceId, removeWorkspace, folders as folderOf, type Workspace } from "./workspace";
import { log } from "./log";

const local = () => process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

/** Is this workspace's Claude Code signed in? (Only whether a login exists is read, never the login itself.) */
export function signedIn(w: Workspace): boolean {
  try {
    if (fs.existsSync(path.join(w.claudeDir, ".credentials.json"))) return true;
    // Claude Code keeps its account record beside the folder for the usual one, inside it otherwise.
    const cfg = w.id === "main" ? mainAccountRecord() : path.join(w.claudeDir, ".claude.json");
    return !!JSON.parse(fs.readFileSync(cfg, "utf8"))?.oauthAccount;
  } catch {
    return false;
  }
}

/** The workspaces the window shows: this PC's, then those other PCs have that are not set up here. */
export function workspacesForWindow(): { current: string; workspaces: WorkspaceInfo[] } {
  const { current, workspaces } = listWorkspaces();
  const here: WorkspaceInfo[] = workspaces.map((w) => ({ id: w.id, name: w.name, remote: w.remote, setUp: w.id === "main" || fs.existsSync(path.join(w.syncHome, "repo", ".git")), signedIn: signedIn(w), disconnected: w.disconnected }));
  const elsewhere = readShared().filter((s) => !here.some((h) => h.id === s.id)).map((s) => ({ ...s, setUp: false, signedIn: false, disconnected: false }));
  return { current, workspaces: [...here, ...elsewhere] };
}

// ------------------------------------------------------------ the shared list

/** One file per workspace, written by the first workspace's engine under its sync lock. */
const sharedDir = () => path.join(baseRepoDir(), "_shared", "workspaces");

function readShared(): { id: string; name: string; remote: string }[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(sharedDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: { id: string; name: string; remote: string }[] = [];
  for (const f of files) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(sharedDir(), f), "utf8"));
      if (w && isWorkspaceId(w.id) && w.id !== "main" && `${w.id}.json` === f && typeof w.name === "string" && typeof w.remote === "string" && isRemote(w.remote)) out.push({ id: w.id, name: w.name, remote: w.remote });
    } catch {}
  }
  return out;
}

/** Adds a workspace to the list the other PCs see; offline, it goes up with the next upload. */
export async function shareWorkspace(w: { id: string; name: string; remote: string }) {
  const r = await run([baseEngine(), "share-workspace", "--id", w.id, "--name", w.name, "--remote", w.remote], baseEnv(), 2 * 60_000);
  if (r.code !== 0 || !/"ok":\s*true/.test(r.out)) log("app", `could not share workspace ${w.id}: ${r.out.trim().slice(-300)}`);
}

/** Runs a script of the first workspace's tools with this app's Node, and its output. */
function run(argv: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += "\nthe setup took too long and was stopped";
      // The whole tree: a clone or push it started must not keep running.
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      else child.kill();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * The same repository, however it is written: https or SSH, case, a trailing .git or
 * slash, backslashes ("git@github.com:me/x.git" and "https://github.com/me/x/" are one).
 */
export const repoKey = (u: string) =>
  u
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i, "$1/")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/^https?:\/\/(?:[^@/]+@)?/i, "")
    .toLowerCase();
const sameRepo = (a: string, b: string) => repoKey(a) === repoKey(b);

// ------------------------------------------------------------ adding one

/** A repository address the installer can clone: https, ssh, or a local folder (tests). */
export function isRemote(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 400 || /[\s"'`<>|;&$]/.test(v)) return false;
  return /^https:\/\/[^/]+\/.+/.test(v) || /^git@[^:]+:.+/.test(v) || (path.isAbsolute(v) && fs.existsSync(v));
}

function baseMachine(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(baseRepoDir()), "config.json"), "utf8"));
    if (typeof cfg?.machine === "string" && cfg.machine) return cfg.machine;
  } catch {}
  return os.hostname();
}

/**
 * Sets up a workspace on this PC: its sync folder and Claude Code folder, its
 * repository cloned (started, when empty), the hooks and skills in its Claude
 * Code, and its `claude-<id>` command. The PC keeps the same name as in the first
 * workspace. Nothing of the first workspace changes.
 */
export async function setUpWorkspace(input: { id?: string; name: string; remote: string }): Promise<{ ok: boolean; id?: string; err?: string }> {
  const name = input.name.trim().slice(0, 40);
  if (!name) return { ok: false, err: "Give the workspace a name" };
  if (!isRemote(input.remote)) return { ok: false, err: "That doesn't look like a repository address (https://github.com/you/repo)" };
  const remote = input.remote.trim();
  // Another workspace's repository would mix the two accounts' conversations.
  const main = mainRemote();
  if (main && sameRepo(main, remote)) return { ok: false, err: "That's the repository of your first workspace. A new workspace needs its own, new repository." };
  const known = listWorkspaces().workspaces;
  const retry = input.id && isWorkspaceId(input.id) && input.id !== "main" ? input.id : null;
  const clash = known.find((w) => w.remote && w.id !== retry && sameRepo(w.remote, remote));
  if (clash) return { ok: false, err: `That repository is already the ${clash.name} workspace's.` };
  // A retry (a setup that failed, or one set up on another PC) keeps its id; a new one gets a free one.
  const id = retry ?? newWorkspaceId(name);
  const isNew = !known.some((w) => w.id === id);
  // Registered only once it works, so a failed setup leaves nothing behind but its folders.
  const w: Workspace = { id, name, remote, ...folderOf(id), disconnected: false };
  // Folders this attempt makes are cleared again if it fails, so a corrected retry starts clean.
  const made = [w.syncHome, w.claudeDir].filter((d) => !fs.existsSync(d));
  fs.mkdirSync(w.claudeDir, { recursive: true });
  const installer = path.join(path.dirname(baseEngine()), "install.mjs");
  const r = await run([installer, "--remote", remote, "--machine", baseMachine()], { ...baseEnv(), CLAUDE_CONFIG_DIR: w.claudeDir, CLAUDE_SYNC_HOME: w.syncHome }, 10 * 60_000);
  if (r.code !== 0) {
    const why = r.out.trim().split(/\r?\n/).filter(Boolean).pop() ?? "the setup stopped";
    log("app", `workspace ${id} setup failed: ${r.out.trim().slice(-600)}`);
    if (isNew) removeWorkspace(id);
    for (const d of made) {
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {}
    }
    const github = /could not read from remote|authentication failed|permission denied|repository not found|returned error: 40[34]/i.test(r.out);
    return { ok: false, id, err: github ? "GitHub didn't let this PC into that repository. Check the address, and that you can open it on github.com while signed in." : why };
  }
  addWorkspace({ id, name, remote });
  await shareWorkspace({ id, name, remote });
  writeLauncher(w);
  seedSettings(w);
  log("app", `workspace ${id} set up on this PC`);
  return { ok: true, id };
}

/**
 * A new workspace starts with this app's settings (theme, sync timing, start at
 * login and so on) and no welcome: it is the same app, in another account.
 */
function seedSettings(w: Workspace) {
  const target = path.join(w.dataDir, "settings.json");
  if (fs.existsSync(target)) return;
  let s: Record<string, unknown> = {};
  try {
    s = JSON.parse(fs.readFileSync(path.join(listWorkspaces().workspaces[0].dataDir, "settings.json"), "utf8"));
  } catch {}
  // Project folders belong to the other account's projects; this one finds its own.
  delete s.folders;
  try {
    fs.mkdirSync(w.dataDir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ ...s, welcomed: true }, null, 2));
  } catch (e) {
    log("app", `could not start ${w.id}'s settings: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------ claude-<id>

/** Where `claude-<id>.cmd` goes: a folder Windows already looks in for commands. */
function launcherDir(): string {
  // Tests keep their launcher out of the real command folder.
  if (process.env.CONVERSATIONS_LAUNCHER_DIR) return process.env.CONVERSATIONS_LAUNCHER_DIR;
  return path.join(local(), "Microsoft", "WindowsApps");
}

export function launcherPath(w: Workspace): string | null {
  if (process.platform !== "win32") return null;
  return path.join(launcherDir(), `claude-${w.id}.cmd`);
}

/** The claude.exe the launcher starts (the app's own detection result is not needed here). */
function claudeExe(): string {
  const npm = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (fs.existsSync(npm)) return npm;
  const native = path.join(os.homedir(), ".local", "bin", "claude.exe");
  return fs.existsSync(native) ? native : "claude";
}

/**
 * `claude-<id>` starts Claude Code in that workspace from any terminal. It sets the
 * workspace's folders itself, so it works in a terminal opened before the app
 * started, and in a Windows Terminal tab that keeps an older environment.
 */
export function writeLauncher(w: Workspace): boolean {
  const file = launcherPath(w);
  if (!file) return false;
  const q = (s: string) => s.replace(/%/g, "%%");
  const exe = claudeExe();
  // The first workspace runs as the app was started: its folders as they were set, or none ("set X=" clears it).
  const env = w.id === "main" ? baseEnv() : { CLAUDE_CONFIG_DIR: w.claudeDir, CLAUDE_SYNC_HOME: w.syncHome };
  const set = (k: string) => `set "${k}=${q(env[k as keyof typeof env] ?? "")}"`;
  const body = ["@echo off", set("CLAUDE_CONFIG_DIR"), set("CLAUDE_SYNC_HOME"), `${exe === "claude" ? "claude" : `"${q(exe)}"`} %*`, ""].join("\r\n");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return true;
  } catch (e) {
    log("app", `could not write ${file}: ${(e as Error).message}`);
    return false;
  }
}
