// Claude conversation sync engine, version 3.
//
// The library behind sync.mjs (Claude Code's hooks and the /push and /pull
// commands) and the Conversations app. There is exactly one sync system: a
// private git repository on GitHub, kept in a working copy on each PC.
//
// Repo layout (version 2, still written; version 3 only adds files):
//   <key>/<session id>/transcript.jsonl   the conversation (.jsonl.gz above 90 MB)
//                     /files/...          subagent transcripts and saved tool outputs
//                     /meta.json          title, PCs, sizes, git remote
//   _devices/<pc>.json                    one file per PC: versions, last push and pull
//   _state/<pc>.jsonl                     one append-only log per PC: pins, renames,
//                                         archive and delete, ordered by a hybrid clock
// <key> is the folder name a conversation was first uploaded from. Version 3
// identifies a project by its normalised git remote instead, so worktrees and
// renamed folders of one repository are one project.
//
// Nothing in here exits the process or prints: callers get return values or a
// SyncError. Needs Node 18+ and git.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

export const ENGINE_VERSION = 3;

// A workspace's hooks name its sync folder with `--sync-home <folder>`: an argument
// works in every shell Claude Code may run a hook in, an environment prefix does not.
// It goes into the environment, so the background uploads it starts use it too.
{
  const i = process.argv.indexOf("--sync-home");
  if (i > 1 && process.argv[i + 1]) process.env.CLAUDE_SYNC_HOME = process.argv[i + 1];
}

export const HOME = os.homedir();
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
export const LEGACY_SYNC_DIR = path.join(CLAUDE_DIR, "conversation-sync");

export function defaultSyncDir() {
  if (process.env.CLAUDE_SYNC_HOME) return process.env.CLAUDE_SYNC_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "claude-conversation-sync");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "claude-conversation-sync");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "claude-conversation-sync");
}

// Use the new location; fall back to an older install inside ~/.claude until
// install.mjs has moved it.
export const SYNC_DIR = (() => {
  const fresh = defaultSyncDir();
  if (fs.existsSync(path.join(fresh, "config.json"))) return fresh;
  if (fs.existsSync(path.join(LEGACY_SYNC_DIR, "config.json"))) return LEGACY_SYNC_DIR;
  return fresh;
})();
export const REPO_DIR = path.join(SYNC_DIR, "repo");
export const CONFIG_PATH = path.join(SYNC_DIR, "config.json");
export const STATE_PATH = path.join(SYNC_DIR, "state.json");
export const LOG_PATH = path.join(SYNC_DIR, "sync.log");
export const LOCK_PATH = path.join(SYNC_DIR, "repo.lock");
export const BACKUP_DIR = path.join(SYNC_DIR, "backups");
export const RESULT_DIR = path.join(SYNC_DIR, "results");

// The app's own repository: the Conversations app and this engine, code only, public.
// Every PC keeps one read-only clone of it, shared by all its workspaces; the
// conversations live in their own repositories (one per workspace).
export const APP_REPO_URL = process.env.CONVERSATIONS_APP_REPO_URL || "https://github.com/Samprogrammer143/conversations-app.git";
export function defaultAppDir() {
  if (process.env.CONVERSATIONS_APP_HOME) return process.env.CONVERSATIONS_APP_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "conversations-app");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "conversations-app");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "conversations-app");
}
export const APP_DIR = defaultAppDir();
const APP_REFRESH_MS = Number(process.env.CONVERSATIONS_APP_REFRESH_MS) || 10 * 60 * 1000;

function appGit(args, cwd = APP_DIR) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, timeout: 5 * 60_000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
}

/** Clones the app's repository when this PC has none yet (it is public: no sign-in). */
export function ensureAppClone() {
  if (fs.existsSync(path.join(APP_DIR, ".git"))) return { ok: true, existed: true, dir: APP_DIR };
  fs.mkdirSync(path.dirname(APP_DIR), { recursive: true });
  // Into a temporary folder first: a clone cut off half way never looks like a finished one.
  const tmp = `${APP_DIR}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const c = appGit(["-c", "core.longpaths=true", "clone", "--quiet", APP_REPO_URL, tmp], path.dirname(APP_DIR));
  if (!c.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, offline: true, err: c.err };
  }
  appGit(["config", "core.autocrlf", "false"], tmp);
  appGit(["config", "core.longpaths", "true"], tmp);
  try {
    fs.renameSync(tmp, APP_DIR);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // Another process finished the same clone first.
    if (fs.existsSync(path.join(APP_DIR, ".git"))) return { ok: true, existed: true, dir: APP_DIR };
    return { ok: false, err: e.message };
  }
  log(`cloned the app's repository into ${APP_DIR}`);
  return { ok: true, cloned: true, dir: APP_DIR, runtime: ensureRuntime() };
}

/**
 * Brings this PC's copy of the app's repository up to date: fast-forward only, at
 * most every ten minutes (force: now), and only a clean clone on main. A folder
 * someone works in, or one with commits of its own, is left alone.
 */
export function refreshApp({ force = false } = {}) {
  if (!fs.existsSync(path.join(APP_DIR, ".git"))) return { ok: true, skipped: "no-clone" };
  const stamp = path.join(APP_DIR, ".git", "conversations-refreshed");
  if (!force) {
    try {
      if (Date.now() - fs.statSync(stamp).mtimeMs < APP_REFRESH_MS) return { ok: true, skipped: "recent" };
    } catch {}
  }
  try {
    fs.writeFileSync(stamp, new Date().toISOString());
  } catch {}
  if (appGit(["rev-parse", "--abbrev-ref", "HEAD"]).out !== "main") return { ok: true, skipped: "not-main" };
  const dirty = appGit(["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty.ok || dirty.out) return { ok: true, skipped: "changed" };
  const before = appGit(["rev-parse", "HEAD"]).out;
  const f = appGit(["fetch", "--quiet", "origin", "main"]);
  if (!f.ok) return { ok: false, offline: true, err: f.err };
  const m = appGit(["merge", "--ff-only", "--quiet", "origin/main"]);
  if (!m.ok) return { ok: false, err: m.err };
  const after = appGit(["rev-parse", "HEAD"]).out;
  if (before !== after) log(`the app's repository updated to ${after.slice(0, 12)}`);
  const runtime = ensureRuntime();
  return { ok: true, updated: before !== after, from: before, to: after, runtime };
}

// What the app needs at run time that is not its own code (Claude's Agent SDK), as
// npm packages. They are installed on each PC from npm, never kept in the repository,
// into one folder per version of the list, so an update never touches the files a
// running app uses: <app folder>-runtime/<hash of the lock file>/.
export const RUNTIME_ROOT = `${APP_DIR}-runtime`;
const runtimeLock = (appDir = APP_DIR) => path.join(appDir, "_app", "runtime", "package-lock.json");
export function runtimeDirFor(appDir = APP_DIR) {
  try {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(runtimeLock(appDir))).digest("hex").slice(0, 12);
    return path.join(RUNTIME_ROOT, hash);
  } catch {
    return null;
  }
}

/**
 * npm, run directly (Node's own npm-cli.js beside node.exe on Windows) rather than
 * through a shell, so a timeout stops npm itself and not just the shell around it.
 */
function npmCommand() {
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean)) {
      const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
      const node = path.join(dir, "node.exe");
      if (fs.existsSync(cli) && fs.existsSync(node)) return { cmd: node, pre: [cli], shell: false };
    }
    return { cmd: "npm", pre: [], shell: true };
  }
  return { cmd: "npm", pre: [], shell: false };
}

/** Installs the run-time packages for the app's current lock file, when they are not yet. */
export function ensureRuntime() {
  const dir = runtimeDirFor();
  if (!dir) return { ok: true, skipped: "no-runtime-list" };
  if (fs.existsSync(path.join(dir, ".ready"))) return { ok: true, dir };
  // What an install that was stopped half way left behind.
  try {
    for (const n of fs.readdirSync(RUNTIME_ROOT)) {
      const p = path.join(RUNTIME_ROOT, n);
      if (n.endsWith(".tmp") && Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(path.dirname(runtimeLock()), f), path.join(tmp, f));
  // Exactly the locked versions, no install scripts, and no optional platform builds of
  // Claude Code: the app always runs the claude this PC already has.
  const npm = npmCommand();
  const r = spawnSync(npm.cmd, [...npm.pre, "ci", "--omit=dev", "--omit=optional", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: tmp, encoding: "utf8", windowsHide: true, shell: npm.shell, env: { ...process.env, npm_config_update_notifier: "false" }, timeout: 10 * 60_000 });
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const err = ((r.stderr || "") + (r.error?.message || "")).trim().split(/\r?\n/).slice(-3).join(" ");
    log(`could not install the app's run-time packages: ${err}`);
    return { ok: false, offline: /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRE/i.test(err), err };
  }
  fs.writeFileSync(path.join(tmp, ".ready"), new Date().toISOString());
  try {
    fs.renameSync(tmp, dir);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(path.join(dir, ".ready"))) return { ok: false, err: "could not finish the run-time folder" };
  }
  log(`installed the app's run-time packages in ${dir}`);
  // Older versions go, except the newest few: an app started before the update may still use one.
  try {
    const old = fs
      .readdirSync(RUNTIME_ROOT)
      .map((n) => path.join(RUNTIME_ROOT, n))
      .filter((p) => p !== dir && fs.existsSync(path.join(p, ".ready")))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const p of old.slice(2)) fs.rmSync(p, { recursive: true, force: true });
  } catch {}
  return { ok: true, installed: true, dir };
}

export const GZIP_OVER_BYTES = Number(process.env.CLAUDE_SYNC_GZIP_OVER_BYTES) || 90 * 1024 * 1024; // GitHub rejects files over 100 MB
export const SKIP_FILE_OVER_BYTES = Number(process.env.CLAUDE_SYNC_MAX_FILE_BYTES) || 95 * 1024 * 1024;
export const PUSH_DEBOUNCE_MS = Number(process.env.CLAUDE_SYNC_DEBOUNCE_MS) || 2 * 60 * 1000;
// Session start never downloads in the hook itself: a detached worker does,
// and the hook waits this long for it before letting Claude start. A slow or
// large download then finishes in the background instead of being cut off.
export const STARTUP_WAIT_MS = Number(process.env.CLAUDE_SYNC_STARTUP_WAIT_MS) || 12 * 1000;
export const RESUME_WAIT_MS = Number(process.env.CLAUDE_SYNC_RESUME_WAIT_MS) || 40 * 1000; // the hook's own limit is 60 s
export const WORKER_LOCK_WAIT_MS = 10 * 60 * 1000;
export const GC_EVERY_PUSHES = 15;
// A transcript written to this recently may belong to a running Claude session,
// so background downloads leave it alone until it goes quiet.
export const LIVE_WINDOW_MS = Number(process.env.CLAUDE_SYNC_LIVE_WINDOW_MS) || 2 * 60 * 1000;
const TEXT_FILE = /\.(txt|json|jsonl|md|log|csv|html?|xml|ya?ml|m?js|ts|tsx|py|sh|env|ini|toml|sql)$/i;

// Top-level folders in the repo that never hold conversations.
const NOT_PROJECTS = new Set(["_sync", "_app", "_devices", "_state", "_tools", "_shared"]);
export const isProjectFolder = (name) => !name.startsWith(".") && !name.startsWith("C--") && !name.startsWith("-") && !NOT_PROJECTS.has(name);

// The rules file every chat on every PC reads (each PC's global CLAUDE.md imports it).
export const SHARED_DIR = path.join(REPO_DIR, "_shared");
export const RULES_PATH = path.join(SHARED_DIR, "CLAUDE.md");
/** Staged with every commit, so an edit to the shared rules goes up with the next upload. */
const sharedPaths = () => (fs.existsSync(SHARED_DIR) ? [SHARED_DIR] : []);

export const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0", // never hang a background push on a password prompt
  GCM_INTERACTIVE: "never",
};

export class SyncError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.code = code;
  }
}

let lockHeld = false;
process.on("exit", () => {
  if (lockHeld) releaseLock();
});

// ---------------------------------------------------------------- utilities

export const argText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
export const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Session ids from files (the repo, edit logs, meta.json) are only trusted when they
// are UUIDs: they become file names, and a crafted one must never reach outside a folder.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (id) => typeof id === "string" && UUID.test(id);

const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

/** p itself when nothing is there yet, otherwise a sibling name no file has: never write over a backup. */
export function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = p.endsWith(".jsonl") ? ".jsonl" : path.extname(p);
  const base = ext ? p.slice(0, -ext.length) : p;
  for (let i = 0; ; i++) {
    const q = `${base}.${stamp()}-${process.pid}${i ? `-${i}` : ""}${ext}`;
    if (!fs.existsSync(q)) return q;
  }
}

// ----------------------------------------------- cloud-synced Claude folder
//
// Some PCs keep ~/.claude inside OneDrive (or Dropbox, Google Drive, iCloud), which
// copies every PC's project folders onto every other PC. The engine then only ever
// writes to folders that belong to this PC (see ownedDirs); this tells the app and
// the log that the Claude folder is shared that way.

const CLOUD_PARTS = /^(onedrive|onedrive - .+|dropbox|dropbox \(.+\)|google ?drive|my drive|icloud ?drive|icloud~.+|mobile documents|cloudstorage)$/i;

/** The cloud folder ~/.claude really lives in, or null. */
export function cloudSyncedClaudeDir(dir = CLAUDE_DIR) {
  let real;
  try { real = fs.realpathSync.native(dir); } catch { return null; }
  const roots = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean);
  for (const r of roots) {
    const rel = path.relative(path.resolve(r), real);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return path.resolve(r);
  }
  const parts = real.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (CLOUD_PARTS.test(parts[i])) return parts.slice(0, i + 1).join(path.sep) || null;
  }
  return null;
}

let cloudWarned = false;
function warnIfCloudSynced() {
  if (cloudWarned) return;
  cloudWarned = true;
  const cloud = cloudSyncedClaudeDir();
  if (!cloud) return;
  const st = loadState();
  if (st.cloudWarnedAt && Date.now() - Date.parse(st.cloudWarnedAt) < 24 * 3600_000) return;
  log(`warning: the Claude folder ${CLAUDE_DIR} is inside ${cloud}, which copies other PCs' project folders here. Sync only writes to this PC's own folders; moving the Claude folder out of ${cloud} is recommended.`);
  try { updateState((s) => { s.cloudWarnedAt = new Date().toISOString(); }); } catch {}
}

// ------------------------------------------- conversations open right now
//
// Claude Code records each running session in ~/.claude/sessions/<pid>.json, with
// the conversation id and the PC ("pidDomain"). A conversation is live when such a
// session on this PC is still running, or when its transcript was written in the
// last LIVE_WINDOW_MS. Nothing live is ever pulled into, merged into, moved,
// retired or deleted.

const thisPidDomain = () => `${process.platform}:${os.hostname().toLowerCase()}`;

/** Map of conversation id -> number of running Claude Code processes on this PC that have it open. */
export function openSessions() {
  const out = new Map();
  const dir = path.join(CLAUDE_DIR, "sessions");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  const domain = thisPidDomain();
  for (const f of files) {
    const s = readJson(path.join(dir, f), null);
    if (!s || !isUuid(s.sessionId) || !Number.isInteger(s.pid)) continue;
    // ~/.claude can be shared between PCs by a cloud folder: only this PC's processes count.
    if (s.pidDomain && String(s.pidDomain).toLowerCase() !== domain) continue;
    if (!processAlive(s.pid)) continue;
    out.set(s.sessionId.toLowerCase(), (out.get(s.sessionId.toLowerCase()) || 0) + 1);
  }
  return out;
}

// A file dated in the future (the clock was set back) counts as written now, not as
// written for ever: beyond five minutes of skew it is treated as old.
const writtenRecently = (p) => {
  try {
    const age = Date.now() - fs.statSync(p).mtimeMs;
    return age < LIVE_WINDOW_MS && age > -5 * 60_000;
  } catch { return false; }
};

/** Is this conversation being used on this PC: open in Claude Code, or one of its copies written to just now? */
export function isLive(id, copies, open = openSessions(), { allowOpen = 0 } = {}) {
  if ((open.get(String(id).toLowerCase()) || 0) > allowOpen) return true;
  return copies.some(writtenRecently);
}

export function log(msg) {
  try {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > 1024 * 1024) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
    } catch {}
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

export function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// Written aside, then renamed into place, so a reader never sees half a file. On Windows
// the rename fails (EPERM) while another process has the file open for reading, so it is
// tried again for a moment.
export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (e) {
      if (Date.now() > deadline || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      sleep(5 + Math.floor(Math.random() * 30));
    }
  }
}

// state.json is read, changed and written back by every hook, worker and the app at
// once. A small lock of its own (never the repo lock, which a download can hold for
// minutes) makes each change atomic, so no update is lost.
const STATE_LOCK_PATH = `${STATE_PATH}.lock`;
let stateLockDepth = 0;
function withStateLock(fn) {
  if (stateLockDepth > 0) {
    stateLockDepth++;
    try { return fn(); } finally { stateLockDepth--; }
  }
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.writeFileSync(STATE_LOCK_PATH, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      // Windows answers EPERM, not EEXIST, when the file is being removed at that very moment.
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      let st = null;
      try { st = fs.statSync(STATE_LOCK_PATH); } catch {}
      // A lock older than a few seconds was left by a process that died holding it.
      if (st && Date.now() - st.mtimeMs > 5_000) {
        try { fs.unlinkSync(STATE_LOCK_PATH); } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new SyncError("The sync state file is busy.", "busy");
      sleep(5 + Math.floor(Math.random() * 20));
    }
  }
  stateLockDepth = 1;
  try {
    return fn();
  } finally {
    stateLockDepth = 0;
    try { fs.unlinkSync(STATE_LOCK_PATH); } catch {}
  }
}

export const loadConfig = () => readJson(CONFIG_PATH, null);

// Settings the app may change in config.json, with the values each one accepts.
export const UPLOAD_QUIET_CHOICES = [60, 120, 300];
const SETTABLE = {
  uploadQuietSeconds: (v) => (UPLOAD_QUIET_CHOICES.includes(Number(v)) ? Number(v) : undefined),
};

/** How long the Stop hook waits after a reply before uploading (Settings > Sync, "Upload after a reply"). */
export function uploadQuietMs(config = loadConfig()) {
  const v = Number(config?.uploadQuietSeconds);
  return UPLOAD_QUIET_CHOICES.includes(v) ? v * 1000 : PUSH_DEBOUNCE_MS;
}

/** Sets whitelisted config values: { key: value }. Throws a SyncError for anything else. */
export function setConfigValues(values) {
  const patch = {};
  for (const [k, raw] of Object.entries(values)) {
    if (!Object.hasOwn(SETTABLE, k)) throw new SyncError(`${k} cannot be set here.`, "usage");
    const v = SETTABLE[k](raw);
    if (v === undefined) throw new SyncError(`${k} cannot be ${raw}. Allowed: ${UPLOAD_QUIET_CHOICES.join(", ")}.`, "usage");
    patch[k] = v;
  }
  const config = saveConfig(patch);
  return { uploadQuietSeconds: uploadQuietMs(config) / 1000 };
}

export function saveConfig(patch) {
  return withStateLock(() => {
    const config = { ...(loadConfig() || {}), ...patch };
    for (const [k, v] of Object.entries(config)) if (v === undefined || v === null) delete config[k];
    writeJson(CONFIG_PATH, config);
    return config;
  });
}

// A read that fails while another process renames the file into place is tried again,
// so a momentary error never comes back as an empty state (and gets written back as such).
export function loadState() {
  let s = null;
  for (let i = 0; i < 20 && s === null; i++) {
    if (!fs.existsSync(STATE_PATH)) break;
    s = readJson(STATE_PATH, null);
    if (s === null) sleep(5 + Math.floor(Math.random() * 20));
  }
  s ??= {};
  s.sessions ??= {};
  return s;
}

export function updateState(fn) {
  return withStateLock(() => {
    const s = loadState();
    fn(s);
    writeJson(STATE_PATH, s);
    return s;
  });
}

export function patchSession(id, patch) {
  return updateState((s) => {
    const cur = { ...(s.sessions[id] || {}), ...patch };
    for (const [k, v] of Object.entries(cur)) if (v === undefined) delete cur[k];
    s.sessions[id] = cur;
  });
}

export function git(args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd: opts.cwd ?? REPO_DIR,
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 120_000,
    windowsHide: true,
  });
  const res = { ok: r.status === 0, code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
  if (!res.ok && !opts.quiet) log(`git ${args.join(" ")} failed (${r.status}): ${res.err}`);
  return res;
}

export const toGitPath = (p) => p.split(path.sep).join("/");
export const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function webUrl(remote) {
  const m = String(remote).match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export function sessionUrl(config, key, id) {
  const base = webUrl(config.remote);
  return base ? `${base}/tree/main/${encodeURIComponent(key)}/${id}` : `${key}/${id}`;
}

export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(iso) {
  if (!iso) return "?";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const machineName = (config) => config?.machine || os.hostname();
export const deviceSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pc";

// ------------------------------------------------------------ lock (repo)

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by someone else
  }
}

// The lock file is created complete in one step (written aside, then hard-linked into
// place), so nobody ever reads it half-written. A lock is only taken over when its
// process has gone (or after LOCK_MAX_AGE_MS, far beyond any git timeout, in case the
// process id was reused), and only by one process at a time: taking over needs a
// second, short-lived lock.
const LOCK_MAX_AGE_MS = 3 * 3600_000;
const LOCK_BLANK_GRACE_MS = 30_000; // an empty lock file from an older engine, still being written
// A lock held this long by a running process is checked once more: is that still the
// process that took it? Windows reuses process ids quickly.
const LOCK_VERIFY_AFTER_MS = 10 * 60_000;

// What a lock says about its holder: the process, when it started (ms since 1970), its
// program, and how long the PC had been up (s). Uptime only grows while the PC runs, so
// a lock written at a higher uptime than now was left before a restart.
const PROC_START_MS = Math.round(Date.now() - process.uptime() * 1000);
const PROC_EXE = path.basename(process.execPath).toLowerCase();
const lockContent = () => JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname(), start: PROC_START_MS, exe: PROC_EXE, up: Math.round(os.uptime()) });

// The program and start time of a running process, from the system (null when it
// cannot tell). Only asked for a lock held a long time, and remembered per process.
const procInfoCache = new Map();
export function processInfo(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (procInfoCache.has(pid)) return procInfoCache.get(pid);
  let info = null;
  try {
    if (process.platform === "win32") {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessName; try { $p.StartTime.ToFileTimeUtc() } catch { '' }`], { encoding: "utf8", timeout: 20_000, windowsHide: true });
      const [name = "", ft = ""] = r.status === 0 ? r.stdout.trim().split(/\r?\n/).map((s) => s.trim()) : [];
      if (name) info = { name: name.toLowerCase(), start: /^\d+$/.test(ft) ? Number(BigInt(ft) / 10000n) - 11644473600000 : null };
    } else if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")).toLowerCase();
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]); // field 22: start time after boot
      const btime = Number(fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)/m)?.[1]);
      info = { name, start: Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + ticks * 10 : null }; // 100 ticks a second
    } else {
      const r = spawnSync("ps", ["-o", "comm=,lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000, env: { ...process.env, LC_ALL: "C" } });
      const m = r.status === 0 ? r.stdout.trim().match(/^(.*?)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})$/) : null;
      if (m) info = { name: path.basename(m[1]).toLowerCase(), start: Date.parse(m[2]) || null };
    }
  } catch {}
  procInfoCache.set(pid, info);
  return info;
}

/** Is the running process with the holder's id still the holder? false when it is clearly another one. */
function sameProcess(held) {
  const info = processInfo(held.pid);
  if (!info) return true; // cannot tell: trust the process id
  if (held.exe && info.name && info.name !== String(held.exe).toLowerCase().replace(/\.exe$/, "") && info.name !== String(held.exe).toLowerCase()) return false;
  if (Number.isFinite(held.start) && Number.isFinite(info.start) && Math.abs(info.start - held.start) > 10_000) return false;
  return true;
}

function tryCreateLock(p, content) {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, p);
    return true;
  } catch (e) {
    // Taken (EEXIST), or being removed at that very moment (Windows says EPERM then).
    if (["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(e.code)) return false;
    // A file system without hard links: fall back to exclusive create.
    try {
      fs.writeFileSync(p, content, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function lockIsStale(p, { verify = true } = {}) {
  let st;
  try { st = fs.statSync(p); } catch { return false; } // gone already
  const held = readJson(p, null);
  if (!held) return Date.now() - st.mtimeMs > LOCK_BLANK_GRACE_MS;
  if (held.pid === process.pid && !lockHeld) return true; // our own, left over from an interrupted call
  if (!processAlive(held.pid)) return true;
  if (Number.isFinite(held.up) && os.uptime() + 60 < held.up) return true; // taken before the PC restarted
  const age = Date.now() - (Number(held.at) || 0);
  if (age > LOCK_MAX_AGE_MS) return true;
  // A process with that id is running, but is it the one that took the lock?
  if (verify && age > LOCK_VERIFY_AFTER_MS && (Number.isFinite(held.start) || held.exe) && !sameProcess(held)) return true;
  return false;
}

function takeOverStaleLock() {
  const steal = `${LOCK_PATH}.takeover`;
  if (!tryCreateLock(steal, JSON.stringify({ pid: process.pid, at: Date.now() }))) {
    if (lockIsStale(steal) || Date.now() - (readJson(steal, {}).at || 0) > 30_000) {
      try { fs.unlinkSync(steal); } catch {}
    }
    return;
  }
  try {
    // Checked again now that no one else can be taking it over.
    if (lockIsStale(LOCK_PATH)) {
      const held = readJson(LOCK_PATH, null);
      try { fs.unlinkSync(LOCK_PATH); } catch {}
      log(`took over a stale sync lock${held ? ` from process ${held.pid}` : ""}`);
    }
  } finally {
    try { fs.unlinkSync(steal); } catch {}
  }
}

function releaseLock() {
  try {
    const held = readJson(LOCK_PATH, null);
    if (!held || held.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {}
  lockHeld = false;
}

/** Runs fn holding the repo lock. Re-entrant within one process. */
export function withLock(fn, waitMs = 60_000) {
  if (lockHeld) return fn();
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const cap = Number(process.env.CLAUDE_SYNC_LOCK_WAIT_MS); // tests: give up sooner
  const deadline = Date.now() + (cap > 0 ? Math.min(cap, waitMs) : waitMs);
  for (;;) {
    if (tryCreateLock(LOCK_PATH, lockContent())) {
      lockHeld = true;
      break;
    }
    if (lockIsStale(LOCK_PATH)) {
      takeOverStaleLock();
      continue;
    }
    if (Date.now() > deadline) throw new SyncError("Another sync is still running. Try again in a minute.", "busy");
    sleep(300);
  }
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

/** Who holds the repo lock right now, if anyone (for status displays: never asks the system about the holder). */
export function lockHolder() {
  const held = readJson(LOCK_PATH, null);
  if (!held || lockIsStale(LOCK_PATH, { verify: false })) return null;
  return held;
}

// ------------------------------------------------------- project identity

export function gitTopLevel(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], { cwd, quiet: true, timeout: 10_000 });
  return r.ok && r.out ? path.resolve(r.out) : null;
}

export function gitRemoteOf(dir) {
  const r = git(["config", "--get", "remote.origin.url"], { cwd: dir, quiet: true, timeout: 10_000 });
  return r.ok && r.out ? r.out : null;
}

/**
 * One spelling per repository, whatever the URL form: "host/owner/repo" (lower case).
 * Handles https and ssh URLs (with ports and user names), scp-style "git@host:path",
 * GitLab subgroups (every path segment is kept) and Azure DevOps's three URL forms.
 * Anything else (a local path) is returned lower-cased as it is.
 */
export function normaliseRemote(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (!s) return null;
  let host = null;
  let rest = null;
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (scheme && scheme[1].toLowerCase() !== "file") {
    // [user[:password]@]host[:port]/path
    const m = scheme[2].match(/^(?:[^@/]*@)?([^/:?#]+)(?::\d+)?(\/[^?#]*)?/);
    if (m) {
      host = m[1];
      rest = m[2] || "";
    }
  } else if (!scheme) {
    const m = s.match(/^(?:[^@/\\\s]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9-]{2,}):(?!\\|\/\/)(.+)$/);
    if (m && !/^[A-Za-z]$/.test(m[1])) {
      host = m[1];
      rest = m[2];
    }
  }
  if (host === null) return s.toLowerCase();
  host = host.toLowerCase().replace(/^www\./, "");
  let parts = String(rest).split("/").filter(Boolean);
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, "");
  parts = parts.filter(Boolean);
  // Azure DevOps: dev.azure.com/org/project/_git/repo, org.visualstudio.com/project/_git/repo,
  // ssh.dev.azure.com:v3/org/project/repo -> dev.azure.com/org/project/repo
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    host = "dev.azure.com";
    if (parts[0]?.toLowerCase() === "v3") parts = parts.slice(1);
  } else if (host.endsWith(".visualstudio.com")) {
    parts = [host.slice(0, -".visualstudio.com".length), ...parts.filter((p) => p.toLowerCase() !== "defaultcollection")];
    host = "dev.azure.com";
  }
  if (host === "dev.azure.com") parts = parts.filter((p) => p.toLowerCase() !== "_git");
  if (!parts.length) return host;
  return `${host}/${parts.join("/")}`.toLowerCase();
}

/** A remote URL fit to store: user names, passwords and tokens in it are dropped. */
export function remoteWithoutCredentials(url) {
  if (!url) return url ?? null;
  const s = String(url);
  const m = s.match(/^([a-z][a-z0-9+.-]*:\/\/)([^@/]*@)(.*)$/i);
  if (!m) return s;
  // ssh://git@host keeps its (non-secret) login name; anything with a password goes.
  if (/^ssh:\/\//i.test(m[1]) && !m[2].includes(":")) return s;
  return m[1] + m[3];
}

/** Version 3 project identity: the normalised git remote, or the folder key for folders outside git. */
export function projectIdOf(remote, key) {
  return normaliseRemote(remote) ?? `folder:${key}`;
}

/** Display name for a project id: the repository name, "Home folder", or the folder name. */
export function projectLabel(projectId) {
  if (projectId === "folder:_home") return "Home folder";
  if (projectId.startsWith("folder:")) return projectId.slice("folder:".length);
  return projectId.split("/").pop();
}

export function folderKey(top) {
  if (samePath(top, HOME)) return "_home";
  return path.basename(top).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "_root";
}

export function projectInfo(cwd) {
  const abs = path.resolve(cwd);
  const top = gitTopLevel(abs) ?? abs;
  const key = folderKey(top);
  const remote = gitRemoteOf(top);
  return { key, root: top, remote, id: projectIdOf(remote, key) };
}

// Claude Code keeps a folder's sessions in ~/.claude/projects/<encoded path>: every
// character that is not a letter or digit becomes "-", and names over 200
// characters are cut to 200 plus a hash.
export function projectDirFor(cwd) {
  const enc = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
  const direct = path.join(PROJECTS_DIR, enc);
  if (fs.existsSync(direct)) return direct;
  try {
    const names = fs.readdirSync(PROJECTS_DIR);
    const hit =
      names.find((d) => d.toLowerCase() === enc.toLowerCase()) ||
      (enc.length > 200 ? names.find((d) => d.toLowerCase().startsWith(enc.slice(0, 200).toLowerCase())) : null);
    if (hit) return path.join(PROJECTS_DIR, hit);
  } catch {}
  return direct;
}

export function findLocalTranscripts(id) {
  const out = [];
  if (!isUuid(id)) return out;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
      if (fs.existsSync(p)) out.push(p);
    }
  } catch {}
  return out;
}

// ------------------------------------------------- folders this PC owns
//
// A ~/.claude/projects folder belongs to this PC when its working folder exists
// here: its name decodes to a folder on this PC, or a conversation in it was written
// from one. With ~/.claude in a cloud folder, other PCs' folders appear here too; the
// engine reads them but never writes to, appends to, moves or retires anything in them.

const ownCache = new Map();

/** Encoded names (lower case) of the project folders known to be this PC's. */
export function knownOwnedNames(extraCwds = []) {
  const names = new Set();
  const add = (cwd) => { if (cwd && isDir(cwd)) names.add(encodeCwd(cwd)); };
  add(HOME);
  for (const f of Object.values(loadConfig()?.folders || {})) add(f);
  for (const c of extraCwds) add(c);
  for (const [d, v] of Object.entries(loadState().folderCache || {})) if (v?.folder && isDir(v.folder)) names.add(d.toLowerCase());
  return names;
}

// The working folder a projects folder name stands for, when that folder exists here.
// Claude Code names the folder after its working folder: every character that is not a
// letter or digit becomes "-". That is not reversible ("a b" and "a-b" give one name), so
// the folders on this PC are walked from the drive down, following every entry whose own
// name encodes to the next part. Windows short names (ALEXAN~1, written ALEXAN-1) are
// tried as well. Names over 200 characters are cut and hashed by Claude Code, and are
// never matched this way.
const decodeCache = new Map();
export function localDirForProjectName(name) {
  if (decodeCache.has(name)) return decodeCache.get(name);
  let root = null;
  let rest = "";
  if (name.length <= 200) {
    if (process.platform === "win32") {
      const m = name.match(/^([A-Za-z])--(.*)$/);
      if (m) {
        root = `${m[1].toUpperCase()}:\\`;
        rest = m[2];
      }
    } else if (name.startsWith("-")) {
      root = "/";
      rest = name.slice(1);
    }
  }
  const fold = process.platform === "linux" ? (s) => s : (s) => s.toLowerCase();
  let budget = 300; // folders read, at most
  const walk = (dir, r) => {
    if (!r) return dir;
    if (--budget < 0) return null;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const fr = fold(r);
    for (const e of entries) {
      const enc = fold(e.name.replace(/[^A-Za-z0-9]/g, "-"));
      if (!enc || (fr !== enc && !fr.startsWith(`${enc}-`))) continue;
      const p = path.join(dir, e.name);
      if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(p))) continue;
      const hit = fr === enc ? p : walk(p, r.slice(enc.length + 1));
      if (hit) return hit;
    }
    const s = process.platform === "win32" ? r.match(/^([A-Za-z0-9]{1,6})-(\d{1,6})(?=-|$)/) : null;
    if (s && isDir(path.join(dir, `${s[1]}~${s[2]}`))) {
      const p = path.join(dir, `${s[1]}~${s[2]}`);
      const hit = r.length === s[0].length ? p : walk(p, r.slice(s[0].length + 1));
      if (hit) return hit;
    }
    return null;
  };
  const found = root && isDir(root) ? walk(root, rest) : null;
  decodeCache.set(name, found);
  return found;
}

export function ownsProjectDir(dir, known = knownOwnedNames()) {
  const name = path.basename(dir).toLowerCase();
  if (known.has(name)) return true;
  for (const n of known) if (n.length > 200 && name.startsWith(n.slice(0, 200))) return true;
  const k = path.resolve(dir).toLowerCase();
  if (!ownCache.has(k)) {
    // Its name stands for a folder that exists here (also when it only holds downloaded
    // conversations), or a conversation in it was written here.
    let owned = !!localDirForProjectName(path.basename(dir));
    if (!owned) {
      const cwd = ownCwdOf(dir);
      owned = !!cwd && isDir(cwd);
    }
    ownCache.set(k, owned);
  }
  return ownCache.get(k);
}

/** This PC's own copies of a conversation (other PCs' cloud-synced copies left out). */
export const ownedLocalTranscripts = (id, known = knownOwnedNames()) => findLocalTranscripts(id).filter((p) => ownsProjectDir(path.dirname(p), known));

export function resolveSession({ session, transcript, cwd }) {
  if (argText(transcript) && fs.existsSync(transcript)) {
    return { id: path.basename(transcript, ".jsonl"), transcript, guessed: false };
  }
  const id = argText(session) || process.env.CLAUDE_SYNC_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (id) {
    const inDir = path.join(projectDirFor(cwd), `${id}.jsonl`);
    const p = fs.existsSync(inDir) ? inDir : ownedLocalTranscripts(id)[0] ?? findLocalTranscripts(id)[0];
    if (!p) throw new SyncError(`No local transcript found for session ${id}.`, "not-found");
    return { id, transcript: p, guessed: false };
  }
  // Last resort: the transcript in this folder written to most recently is the
  // conversation that is running right now.
  const dir = projectDirFor(cwd);
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const st = fs.statSync(path.join(dir, f));
      if (!best || st.mtimeMs > best.mtimeMs) best = { f, mtimeMs: st.mtimeMs };
    }
  } catch {}
  if (!best) throw new SyncError(`No conversations found for ${cwd}.`, "not-found");
  return { id: best.f.replace(/\.jsonl$/, ""), transcript: path.join(dir, best.f), guessed: true };
}

// ------------------------------------------------------ transcript reading

export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (content.some((c) => c?.type === "tool_result")) return null;
    return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  }
  return null;
}

export function inspectTranscript(buf) {
  const info = { title: null, firstPrompt: null, prompts: 0, firstAt: null, lastAt: null, lines: 0, headless: false, version: null, cwd: null };
  let customTitle = null;
  let sawSdk = false;
  let sawInteractive = false;
  for (const line of completeLines(buf)) {
    if (!line.trim()) continue;
    info.lines++;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.timestamp) {
      info.firstAt ??= j.timestamp;
      info.lastAt = j.timestamp;
    }
    if (typeof j.version === "string") info.version = j.version;
    if (typeof j.cwd === "string") info.cwd = j.cwd;
    // Headless means it only ever ran through the Agent SDK or `claude -p` ("sdk-..."):
    // a conversation that ran in an interactive Claude Code at any point is not, whichever
    // came first (the same rule as the app's parser).
    if (typeof j.entrypoint === "string") {
      if (j.entrypoint.startsWith("sdk")) sawSdk = true;
      else sawInteractive = true;
    }
    if (j.type === "custom-title" && (j.customTitle || j.title)) customTitle = j.customTitle || j.title;
    else if (j.type === "ai-title" && j.aiTitle) info.title = j.aiTitle;
    else if (j.type === "summary" && j.summary && !info.title) info.title = j.summary;
    if (j.type === "user" && !j.isMeta && !j.isCompactSummary && !j.isSidechain) {
      const body = textOf(j.message?.content)?.trimStart() ?? "";
      if (body && !body.startsWith("<") && !body.startsWith("Base directory for this skill")) {
        info.prompts++;
        info.firstPrompt ??= body.trim().replace(/\s+/g, " ").slice(0, 160);
      }
    }
  }
  info.title = customTitle || info.title || info.firstPrompt || "(untitled)";
  info.headless = sawSdk && !sawInteractive;
  return info;
}

// ------------------------------------------------------------ line merging
//
// A transcript is an append-only log of JSON lines. Syncing two copies means
// appending to each side the lines it lacks. A final line without a newline is
// still being written by Claude and is left for the next sync.

export function completeLines(buf) {
  const text = buf.toString("utf8");
  const parts = text.split("\n");
  parts.pop(); // "" after a trailing newline, or an unfinished last line
  return parts.filter((l) => l.trim());
}

// The top-level "uuid" of a transcript line, or null.
function lineUuid(line) {
  if (!line.includes('"uuid"')) return null;
  try {
    const j = JSON.parse(line);
    return typeof j?.uuid === "string" ? j.uuid : null;
  } catch {
    return null;
  }
}

export function missingLines(from, into) {
  const intoLines = into ? completeLines(into) : [];
  const have = new Set(intoLines);
  let haveIds = null; // built only when some line is not there word for word
  const out = [];
  const seen = new Set();
  const seenIds = new Set();
  for (const l of completeLines(from)) {
    if (have.has(l) || seen.has(l)) continue;
    // One entry can read differently in two copies (redacted under other rules, or allowed
    // on one PC only). An entry that is already there under its uuid is not added again.
    const id = lineUuid(l);
    if (id) {
      haveIds ??= new Set(intoLines.map(lineUuid).filter(Boolean));
      if (haveIds.has(id) || seenIds.has(id)) continue;
      seenIds.add(id);
    }
    seen.add(l);
    out.push(l);
  }
  return out;
}

export function withLinesAppended(buf, lines) {
  let base = buf ? buf.toString("utf8") : "";
  if (base && !base.endsWith("\n")) base = base.slice(0, base.lastIndexOf("\n") + 1); // drop an unfinished line
  return Buffer.from(base + (lines.length ? lines.join("\n") + "\n" : ""), "utf8");
}

// ---------------------------------------------------------------- redaction

export const SECRET_PATTERNS = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{30,}/g],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["Google refresh token", /\b1\/\/0[0-9A-Za-z_-]{40,}/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/g],
  ["Stripe live key", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g],
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ["PostHog personal key", /\bphx_[A-Za-z0-9]{30,}/g],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}/g],
  ["Supabase access token", /\bsbp_(?:v0_)?[A-Za-z0-9]{30,}/g],
  ["Brevo key", /\bx(?:keysib|smtpsib)-[A-Za-z0-9]{32,}(?:-[A-Za-z0-9]{8,})?/g],
  ["Figma token", /\bfig[dou]_[A-Za-z0-9_-]{30,}/g],
  ["Linear key", /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["Password in a URL", /\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:@\/"'<>\\]{1,64}:[^\s@\/"'<>\\]{3,200}@(?=[A-Za-z0-9.-])/g],
  ["Private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]{0,8000}?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/g],
];
const ANY_SECRET = new RegExp(SECRET_PATTERNS.map(([, re]) => `(?:${re.source})`).join("|"));

export function redactString(str, ctx) {
  let out = str;
  for (const [kind, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      const fp = sha(m).slice(0, 12);
      if (ctx.allow.has(fp)) return m;
      ctx.found.set(fp, kind);
      ctx.hits++;
      return `[REDACTED ${kind} ${fp}]`;
    });
  }
  return out;
}

// Walks a parsed JSONL entry and redacts string values, skipping base64 payloads
// (images, PDFs) so their data can never be corrupted.
function redactValue(v, ctx, key, parent) {
  if (typeof v === "string") {
    if (key === "data" && parent?.type === "base64") return v;
    return ANY_SECRET.test(v) ? redactString(v, ctx) : v;
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, ctx, null, v));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactValue(x, ctx, k, v);
    return o;
  }
  return v;
}

export function redactJsonl(buf, ctx) {
  const text = buf.toString("utf8");
  if (!ANY_SECRET.test(text)) return buf;
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !ANY_SECRET.test(line)) continue;
    const before = ctx.hits;
    let replaced;
    try {
      replaced = JSON.stringify(redactValue(JSON.parse(line), ctx, null, null));
    } catch {
      replaced = redactString(line, ctx);
    }
    if (ctx.hits !== before) {
      lines[i] = replaced;
      changed = true;
    }
  }
  return changed ? Buffer.from(lines.join("\n"), "utf8") : buf;
}

export function redactFile(file, buf, ctx) {
  if (file.endsWith(".jsonl")) return redactJsonl(buf, ctx);
  if (!TEXT_FILE.test(file)) return buf;
  const text = buf.toString("utf8");
  if (!ANY_SECRET.test(text)) return buf;
  const out = redactString(text, ctx);
  return out === text ? buf : Buffer.from(out, "utf8");
}

export const newRedactionCtx = (allow) => ({ allow, found: new Map(), hits: 0 });

export function redactionSummary(ctx) {
  if (!ctx.found.size) return null;
  const byKind = {};
  for (const kind of ctx.found.values()) byKind[kind] = (byKind[kind] || 0) + 1;
  return Object.entries(byKind).map(([k, n]) => `${n} × ${k}`).join(", ");
}

// ------------------------------------------------------------ repo access

export function ensureRepo() {
  const config = loadConfig();
  if (!config?.remote) throw new SyncError("Conversation sync is not set up on this PC.", "not-set-up");
  if (!fs.existsSync(path.join(REPO_DIR, ".git"))) {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    withLock(() => {
      if (fs.existsSync(path.join(REPO_DIR, ".git"))) return; // another process cloned it meanwhile
      // What an interrupted clone left behind is set aside, never mixed in.
      if (fs.existsSync(REPO_DIR)) fs.renameSync(REPO_DIR, uniquePath(`${REPO_DIR}.incomplete`));
      // A new PC downloads today's files, not every old version of them.
      const r = git(["-c", "core.longpaths=true", "clone", "--filter=blob:none", config.remote, REPO_DIR], { cwd: SYNC_DIR, timeout: 30 * 60_000 });
      if (!r.ok) throw new SyncError(`Could not clone ${config.remote}: ${r.err}`, "clone-failed");
    }, 30 * 60_000);
  }
  git(["config", "core.autocrlf", "false"], { quiet: true });
  git(["config", "core.safecrlf", "false"], { quiet: true });
  git(["config", "core.longpaths", "true"], { quiet: true }); // Windows: allow paths over 260 characters
  if (!git(["config", "user.email"], { quiet: true }).out) {
    const machine = machineName(config);
    git(["config", "user.email", `${machine.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@conversation-sync.local`], { quiet: true });
    git(["config", "user.name", `Conversation sync (${machine})`], { quiet: true });
  }
  return config;
}

// Last contact with GitHub, kept in state.json for the app's status line.
function noteSyncResult({ ok, error, fetched, pushed }) {
  try {
    updateState((s) => {
      const now = new Date().toISOString();
      if (ok) {
        if (fetched) s.lastFetchAt = now;
        if (pushed) s.lastPushAt = now;
        s.lastOkAt = now;
        delete s.lastError;
        delete s.failingSince;
      } else {
        s.lastError = { at: now, message: String(error || "unknown error").split("\n")[0].slice(0, 300) };
        s.failingSince ??= now;
      }
    });
  } catch {}
}

// git's own lock files, left behind by a git process that was killed (a timeout, a
// shutdown in the middle of an upload). Only called while holding the repo lock, so no
// git command of this tool can be using them; a minute's age rules out anyone else.
const GIT_LOCK_STALE_MS = Number(process.env.CLAUDE_SYNC_GIT_LOCK_STALE_MS) || 60_000;
function clearStaleGitLocks() {
  const gitDir = path.join(REPO_DIR, ".git");
  const rels = ["index.lock", "HEAD.lock", "ORIG_HEAD.lock", "packed-refs.lock", "config.lock", "shallow.lock"];
  for (const sub of ["refs/heads", "refs/remotes/origin"]) {
    try {
      for (const f of fs.readdirSync(path.join(gitDir, sub))) if (f.endsWith(".lock")) rels.push(`${sub}/${f}`);
    } catch {}
  }
  for (const rel of rels) {
    const p = path.join(gitDir, rel);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < GIT_LOCK_STALE_MS) continue;
      fs.unlinkSync(p);
      log(`removed a stale git lock file: .git/${rel}`);
    } catch {}
  }
}

const currentBranch = () => git(["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).out || "main";

// Another PC changed what this PC's unpushed commits change: both carried on one
// conversation at once, or a delete made offline met another PC's update. Rather than
// stopping for good, start again from GitHub's version and re-apply what only this PC
// knows: the lines of its own edit log and its deletes. The conversations those commits
// uploaded are marked as waiting, so the same sync uploads them again from ~/.claude.
export function recoverFromConflict(branch = currentBranch()) {
  const config = loadConfig() || {};
  const rel = toGitPath(path.relative(REPO_DIR, statePath(config)));
  const mine = git(["show", `HEAD:${rel}`], { quiet: true });
  const theirs = git(["show", `origin/${branch}:${rel}`], { quiet: true });
  const onGitHub = new Set(theirs.ok ? theirs.out.split("\n").filter((l) => l.trim()) : []);
  const unpushed = mine.ok ? mine.out.split("\n").filter((l) => l.trim() && !onGitHub.has(l)) : [];
  const dropped = git(["log", "--format=%s", `origin/${branch}..HEAD`], { quiet: true }).out.split("\n").filter(Boolean);
  // The conversations the set-aside commits uploaded, and where each one was uploaded from.
  const touched = new Map();
  for (const f of git(["-c", "core.quotepath=false", "log", "--name-only", "--format=", `origin/${branch}..HEAD`], { quiet: true }).out.split("\n")) {
    const [key, id] = f.trim().split("/");
    if (!key || !isProjectFolder(key) || !isUuid(id) || touched.has(id)) continue;
    const meta = git(["show", `HEAD:${key}/${id}/meta.json`], { quiet: true });
    let cwd = null;
    try { cwd = JSON.parse(meta.out).machines?.[machineName(config)]?.cwd ?? null; } catch {}
    touched.set(id, cwd);
  }
  // Rules edited here and on another PC at once: GitHub's version wins, this PC's is kept as a copy.
  const rulesRel = toGitPath(path.relative(REPO_DIR, RULES_PATH));
  const myRules = git(["show", `HEAD:${rulesRel}`], { quiet: true });
  const theirRules = git(["show", `origin/${branch}:${rulesRel}`], { quiet: true });
  if (myRules.ok && myRules.out !== theirRules.out) {
    const copy = path.join(SYNC_DIR, `rules-from-this-pc-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}.md`);
    try { fs.writeFileSync(copy, myRules.out); log(`shared rules were edited on two PCs at once; this PC's version is kept at ${copy}`); } catch {}
  }
  const reset = git(["reset", "--quiet", "--hard", `origin/${branch}`]);
  if (!reset.ok) return { ok: false, err: reset.err };
  git(["clean", "-fdq"], { quiet: true });
  for (const [id, cwd] of touched) markPending(id, { cwd, reason: "conflict" });
  log(`conflict with GitHub resolved: started again from GitHub's version, setting aside ${dropped.length} unpushed commit(s) [${dropped.join("; ").slice(0, 300)}], re-applying ${unpushed.length} edit(s) and uploading ${touched.size} conversation(s) again`);
  if (!unpushed.length) return { ok: true, dropped };
  const p = statePath(config);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let cur = "";
  try { cur = fs.readFileSync(p, "utf8"); } catch {}
  fs.writeFileSync(p, `${cur && !cur.endsWith("\n") ? `${cur}\n` : cur}${unpushed.join("\n")}\n`);
  const paths = [rel];
  for (const l of unpushed) {
    let op;
    try { op = JSON.parse(l); } catch { continue; }
    if (op?.field !== "deleted" || op.value !== true || !isUuid(op.session)) continue;
    const key = findSessionKey(op.session);
    if (!key) continue;
    fs.rmSync(path.join(REPO_DIR, key, op.session), { recursive: true, force: true });
    paths.push(toGitPath(path.join(key, op.session)));
  }
  const add = git(["add", "-A", "--", ...paths]);
  if (!add.ok) return { ok: false, err: add.err };
  const c = git(["commit", "--quiet", "-m", `Edit: ${unpushed.length} edit(s) re-applied after a conflict (${machineName(config)})`]);
  if (!c.ok) return { ok: false, err: c.err };
  return { ok: true, dropped };
}

// The clone belongs to this tool, so anything uncommitted in it is left over from
// an interrupted run and can be discarded; unpushed commits are kept and replayed.
// The shared rules file is the one thing a person edits inside the clone. An edit there
// is committed before anything uncommitted is discarded, so it rides along with the
// rebase and goes up with the next push.
function commitSharedEdits() {
  if (!fs.existsSync(SHARED_DIR)) return;
  const st = git(["status", "--porcelain", "--", "_shared"], { quiet: true });
  if (!st.ok || !st.out.trim()) return;
  const add = git(["add", "-A", "--", "_shared"]);
  if (!add.ok) return;
  const c = git(["commit", "--quiet", "-m", `Rules: shared CLAUDE.md (${machineName(loadConfig() || {})})`]);
  if (c.ok) log("shared rules edited on this PC: committed, going up with the next upload");
}

export function refreshRepo() {
  sleep(Number(process.env.CLAUDE_SYNC_TEST_FETCH_DELAY_MS) || 0); // tests only: a slow download
  clearStaleGitLocks();
  git(["rebase", "--abort"], { quiet: true });
  commitSharedEdits();
  const clean = git(["reset", "--quiet", "--hard", "HEAD"]);
  if (!clean.ok) {
    noteSyncResult({ ok: false, error: clean.err });
    return { ok: false, err: `the sync folder is busy: ${clean.err}`, code: "git-busy" };
  }
  git(["clean", "-fdq"], { quiet: true });
  const f = git(["fetch", "--quiet", "origin"], { timeout: 10 * 60_000 });
  if (!f.ok) {
    noteSyncResult({ ok: false, error: f.err });
    return { ok: false, err: f.err };
  }
  const branch = currentBranch();
  if (!git(["rev-parse", "--verify", "--quiet", `origin/${branch}`], { quiet: true }).ok) {
    noteSyncResult({ ok: true, fetched: true });
    return { ok: true, branch };
  }
  const r = git(["rebase", "--quiet", `origin/${branch}`], { timeout: 10 * 60_000 });
  if (!r.ok) {
    git(["rebase", "--abort"], { quiet: true });
    const rec = recoverFromConflict(branch);
    if (!rec.ok) {
      noteSyncResult({ ok: false, error: rec.err || r.err });
      return { ok: false, err: rec.err || r.err };
    }
    noteSyncResult({ ok: true, fetched: true });
    return { ok: true, branch, recovered: true, dropped: rec.dropped };
  }
  noteSyncResult({ ok: true, fetched: true });
  return { ok: true, branch };
}

export function readRemoteTranscript(dir) {
  const plain = path.join(dir, "transcript.jsonl");
  const gz = path.join(dir, "transcript.jsonl.gz");
  if (fs.existsSync(plain)) return fs.readFileSync(plain);
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz));
  return null;
}

/** How a transcript is stored in the repo: as it is, or compressed above GZIP_OVER_BYTES. */
export function encodeRemoteTranscript(buf) {
  return buf.length > GZIP_OVER_BYTES ? { gz: true, data: zlib.gzipSync(buf, { level: 9 }) } : { gz: false, data: buf };
}

export function writeRemoteTranscript(dir, buf, stored = encodeRemoteTranscript(buf)) {
  fs.mkdirSync(dir, { recursive: true });
  const plain = path.join(dir, "transcript.jsonl");
  const gz = path.join(dir, "transcript.jsonl.gz");
  fs.writeFileSync(stored.gz ? gz : plain, stored.data);
  const other = stored.gz ? plain : gz;
  if (fs.existsSync(other)) fs.unlinkSync(other);
}

export function listFiles(root) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

// A session's own folder holds subagent transcripts (.jsonl, append-only like the
// conversation itself) and saved tool outputs (written once). Neither direction ever
// replaces a file: logs are merged line by line, and any other file is only added
// when the other side does not have it yet.

function writeNew(dst, buf) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dst);
}

function appendLines(dst, lines) {
  if (!lines.length) return;
  const text = fs.readFileSync(dst, "utf8");
  fs.appendFileSync(dst, (text && !text.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
}

// Local session folder -> repo, redacting on the way. Returns changed files.
export function pushFiles(from, to, ctx, dryRun) {
  const changed = [];
  for (const src of listFiles(from)) {
    if (fs.statSync(src).size > SKIP_FILE_OVER_BYTES) continue;
    const rel = path.relative(from, src);
    const buf = redactFile(src, fs.readFileSync(src), ctx);
    const dst = path.join(to, rel);
    if (!fs.existsSync(dst)) {
      changed.push(rel);
      if (!dryRun) writeNew(dst, buf);
      continue;
    }
    if (!rel.endsWith(".jsonl")) continue; // already uploaded once; never overwritten
    const remote = fs.readFileSync(dst);
    const missing = missingLines(buf, remote);
    if (!missing.length) continue;
    changed.push(rel);
    if (!dryRun) fs.writeFileSync(dst, withLinesAppended(remote, missing));
  }
  return changed;
}

// Repo -> local session folder. Adds files and appends missing log lines; never
// replaces or deletes a local file, so nothing this PC has not uploaded yet is lost
// and its own unredacted text stays as it is.
export function pullFiles(from, to, allow = new Set()) {
  for (const src of listFiles(from)) {
    const dst = path.join(to, path.relative(from, src));
    const buf = fs.readFileSync(src);
    if (!fs.existsSync(dst)) {
      writeNew(dst, src.endsWith(".jsonl") ? withLinesAppended(null, completeLines(buf)) : buf);
      continue;
    }
    if (!dst.endsWith(".jsonl")) continue;
    appendLines(dst, missingLines(buf, redactJsonl(fs.readFileSync(dst), newRedactionCtx(allow))));
  }
}

// Pushes HEAD, replaying it on top of whatever another PC pushed first. When that
// replay hit a conflict, refreshRepo started again from GitHub's version: edit-log
// commits were re-applied (so pushing again is right), but an upload's own commit was
// set aside, and with redo the caller is told so it can merge again.
function pushHead({ redo = false } = {}) {
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = git(["push", "--quiet", "origin", "HEAD"], { timeout: 20 * 60_000 });
    if (p.ok) {
      noteSyncResult({ ok: true, pushed: true });
      return { ok: true };
    }
    lastErr = p.err;
    const rf = refreshRepo();
    if (!rf.ok) return { ok: false, err: rf.err || p.err };
    if (rf.recovered && redo) return { ok: false, recovered: true, err: "another PC changed it at the same time" };
  }
  noteSyncResult({ ok: false, error: lastErr });
  return { ok: false, err: `push kept being rejected: ${lastErr}` };
}

/** Unpushed commits in the working copy. */
export function aheadCount() {
  const a = git(["rev-list", "--count", `origin/${currentBranch()}..HEAD`], { quiet: true });
  return a.ok ? Number(a.out) || 0 : 0;
}

/**
 * Stages paths, commits and pushes. Every git step is checked: a stale git lock or
 * any other failure is reported, never mistaken for "nothing to upload".
 */
export function commitAndPush(message, paths, { redo = false } = {}) {
  const add = git(["add", "-A", "--", ...[...paths, ...sharedPaths()].map(toGitPath)]);
  if (!add.ok) return { ok: false, err: `git add failed: ${add.err}`, code: "git-error" };
  const d = git(["diff", "--cached", "--quiet"], { quiet: true });
  if (d.code !== 0 && d.code !== 1) return { ok: false, err: `git diff failed: ${d.err}`, code: "git-error" };
  if (d.code === 0) {
    // Nothing new to commit, but an earlier commit may still be waiting to go up.
    if (!aheadCount()) return { ok: true, nothing: true };
    const p = pushHead({ redo });
    return p.ok ? { ok: true, nothing: true } : { ok: false, err: p.err, committed: !p.recovered, recovered: !!p.recovered };
  }
  const c = git(["commit", "--quiet", "-m", message]);
  if (!c.ok) return { ok: false, err: `git commit failed: ${c.err}`, code: "git-error" };
  const p = pushHead({ redo });
  return p.ok ? { ok: true } : { ok: false, err: p.err, committed: !p.recovered, recovered: !!p.recovered };
}

export function findSessionKey(id) {
  try {
    for (const d of fs.readdirSync(REPO_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || !isProjectFolder(d.name)) continue;
      if (fs.existsSync(path.join(REPO_DIR, d.name, id, "meta.json"))) return d.name;
    }
  } catch {}
  return null;
}

// ------------------------------------------------- conversations in the repo

// "PC|working folder" pairs a conversation was uploaded from, from its meta.json.
const placesOf = (meta) => Object.entries(meta.machines || {}).map(([pc, v]) => `${pc}|${String(v?.cwd ?? "").toLowerCase()}`);

/**
 * Every conversation in the working copy, from every PC, with its version 3 project
 * id. A conversation uploaded without a git remote (older engines, or a folder that
 * was not a repository yet) joins a repository only when another conversation
 * uploaded from the same PC and the same working folder names that repository. A
 * folder name alone proves nothing: two repositories can share one.
 */
export function listRemoteSessions() {
  const out = [];
  let keys = [];
  try { keys = fs.readdirSync(REPO_DIR, { withFileTypes: true }); } catch { return out; }
  const placeRemote = new Map(); // "PC|cwd" -> { remote, at } of the newest conversation there that has one
  for (const d of keys) {
    if (!d.isDirectory() || !isProjectFolder(d.name)) continue;
    const kdir = path.join(REPO_DIR, d.name);
    let ids = [];
    try { ids = fs.readdirSync(kdir); } catch { continue; }
    for (const id of ids) {
      if (!isUuid(id)) continue;
      const meta = readJson(path.join(kdir, id, "meta.json"), null);
      if (!meta || meta.sessionId !== id) continue;
      const remote = normaliseRemote(meta.gitRemote);
      if (remote) {
        const at = String(meta.updatedAt ?? "");
        for (const p of placesOf(meta)) {
          const cur = placeRemote.get(p);
          if (!cur || at > cur.at || (at === cur.at && remote < cur.remote)) placeRemote.set(p, { remote, at });
        }
      }
      out.push({ ...meta, key: d.name, dir: path.join(kdir, id) });
    }
  }
  for (const s of out) {
    s.projectId = normaliseRemote(s.gitRemote) ?? placesOf(s).map((p) => placeRemote.get(p)?.remote).filter(Boolean).sort()[0] ?? `folder:${s.key}`;
    s.projectLabel = projectLabel(s.projectId);
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** The conversations that belong with a folder: everything with its project id (its repository, or its folder outside git). */
export function remoteSessions(project) {
  const want = projectIdOf(project.remote, project.key);
  return listRemoteSessions().filter((s) => s.projectId === want);
}

// ------------------------------------------------------------ device registry
//
// _devices/<pc>.json says which engine, app and Claude Code each PC runs and
// when it last synced. It only changes as part of a commit that is being made
// anyway, or when this PC's versions change.

/**
 * This PC's file name in _devices and _state. Two PCs whose names only differ in case
 * or punctuation ("Laptop", "laptop") would share one; the second PC to arrive then
 * gets its own, and keeps it (saved in config.json).
 */
export function pcSlug(config) {
  if (config?.slug) return config.slug;
  // Read again from disk: another sync on this PC may have settled it a moment ago.
  const saved = loadConfig() || {};
  if (saved.slug) {
    if (config) config.slug = saved.slug;
    return saved.slug;
  }
  const base = deviceSlug(machineName(config));
  let pcId = saved.pcId ?? config?.pcId;
  if (!pcId) {
    pcId = crypto.randomUUID();
    try { saveConfig({ pcId }); } catch {}
  }
  if (config) config.pcId = pcId;
  const taken = readJson(path.join(REPO_DIR, "_devices", `${base}.json`), null);
  // Its own file: the same id, or (written before ids existed, or with a lost config) the same PC and name.
  const mine = !taken || taken.pcId === pcId || (taken.hostname === os.hostname() && taken.name === machineName(config));
  const slug = mine ? base : `${base}-${pcId.slice(0, 6)}`;
  if (!mine) log(`another PC already uses the name "${base}" in the sync repo; this PC is "${slug}"`);
  // Only remembered once the repo has been read, so a PC that has not cloned yet decides later.
  if (fs.existsSync(path.join(REPO_DIR, ".git"))) {
    try { saveConfig({ slug }); } catch {}
    if (config) config.slug = slug;
  }
  return slug;
}

export const devicePath = (config) => path.join(REPO_DIR, "_devices", `${pcSlug(config)}.json`);

export function readDevices() {
  const dir = path.join(REPO_DIR, "_devices");
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const d = readJson(path.join(dir, f), null);
      if (d?.name) out.push({ ...d, slug: f.replace(/\.json$/, "") });
    }
  } catch {}
  return out;
}

function deviceRecord(config, patch = {}) {
  const prev = readJson(devicePath(config), {});
  const st = loadState();
  return {
    name: machineName(config),
    pcId: config.pcId ?? prev.pcId ?? null,
    engine: ENGINE_VERSION,
    app: config.appVersion ?? prev.app ?? null,
    claudeCode: patch.claudeCode ?? st.claudeCodeVersion ?? prev.claudeCode ?? null,
    platform: process.platform,
    hostname: os.hostname(),
    lastPushAt: patch.lastPushAt ?? prev.lastPushAt ?? null,
    lastPullAt: st.lastPullAt ?? prev.lastPullAt ?? null,
    lastSeenAt: new Date().toISOString(),
  };
}

/** Writes this PC's device file into the working copy; returns its repo-relative path. */
export function writeDevice(config, patch = {}) {
  const p = devicePath(config);
  writeJson(p, deviceRecord(config, patch));
  return path.relative(REPO_DIR, p);
}

/** Whether this PC's device file is missing or names other versions than it runs now. */
export function deviceOutOfDate(config) {
  const prev = readJson(devicePath(config), null);
  if (!prev) return true;
  return prev.engine !== ENGINE_VERSION || (!!config.appVersion && prev.app !== config.appVersion) || prev.name !== machineName(config);
}

/** Records this PC's versions on GitHub when they changed (an engine or app upgrade). */
export function announceDevice() {
  const config = ensureRepo();
  // A PC that has not settled its file name yet decides it after fetching (pcSlug).
  if (config.slug && !deviceOutOfDate(config)) return { ok: true, nothing: true };
  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return { ok: false, offline: rf.code !== "git-busy", code: rf.code, err: rf.err };
    if (!deviceOutOfDate(config)) return { ok: true, nothing: true };
    const rel = writeDevice(config);
    return commitAndPush(`Device: ${machineName(config)} runs engine ${ENGINE_VERSION}${config.appVersion ? `, app ${config.appVersion}` : ""}`, [rel]);
  });
}

// ----------------------------------------------------- per-PC edit logs
//
// Pins, renames, archive and delete are appended to _state/<pc>.jsonl. Each PC
// writes only its own file, so git never sees a conflict. Readers merge every
// log and, per conversation and field, the entry with the highest hybrid
// logical clock wins.

// app: the conversation was started or carried on in the Conversations app, so the
// app shows it on every PC although Claude Code ran it through the Agent SDK.
export const STATE_FIELDS = new Set(["pinned", "title", "archived", "deleted", "app"]);
const validValue = (field, v) => v === null || (field === "title" ? typeof v === "string" && v.length <= 500 : typeof v === "boolean");
const stateDir = () => path.join(REPO_DIR, "_state");
export const statePath = (config) => path.join(stateDir(), `${pcSlug(config)}.jsonl`);

const parseHlc = (h) => {
  const [ms = "0", count = "0"] = String(h || "").split("-");
  return { ms: Number(ms) || 0, count: Number(count) || 0 };
};

/** Hybrid logical clock stamp: sortable as a string, unique per PC, later than anything seen. */
export function nextHlc(config, seenMax = "") {
  const node = pcSlug(config);
  let stamp;
  updateState((s) => {
    const last = parseHlc(s.hlc);
    const seen = parseHlc(seenMax);
    const prev = last.ms > seen.ms || (last.ms === seen.ms && last.count >= seen.count) ? last : seen;
    const ms = Math.max(Date.now(), prev.ms);
    const count = ms === prev.ms ? prev.count + 1 : 0;
    stamp = `${String(ms).padStart(15, "0")}-${String(count).padStart(4, "0")}-${node}`;
    s.hlc = stamp;
  });
  return stamp;
}

/** Reads every PC's log. Returns { sessions: Map(id -> {field: {value, hlc, pc, at}}), maxHlc }. */
export function readStateLogs() {
  const sessions = new Map();
  let maxHlc = "";
  let files = [];
  try { files = fs.readdirSync(stateDir()).filter((f) => f.endsWith(".jsonl")); } catch {}
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(path.join(stateDir(), f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let op;
      try { op = JSON.parse(line); } catch { continue; }
      if (!isUuid(op?.session) || !STATE_FIELDS.has(op.field) || typeof op.hlc !== "string" || !validValue(op.field, op.value ?? null)) continue;
      if (op.hlc > maxHlc) maxHlc = op.hlc;
      const cur = sessions.get(op.session) || {};
      if (!cur[op.field] || op.hlc > cur[op.field].hlc) cur[op.field] = { value: op.value, hlc: op.hlc, pc: op.pc, at: op.at };
      sessions.set(op.session, cur);
    }
  }
  return { sessions, maxHlc };
}

/** Plain merged view: { [id]: { pinned, title, archived, deleted, <field>At, <field>By } }. */
export function mergedState() {
  const { sessions } = readStateLogs();
  const out = {};
  for (const [id, fields] of sessions) {
    const o = {};
    for (const [field, e] of Object.entries(fields)) {
      o[field] = e.value;
      o[`${field}At`] = e.at;
      o[`${field}By`] = e.pc;
    }
    out[id] = o;
  }
  return out;
}

export const isDeleted = (state, id) => state?.[id]?.deleted === true;

/**
 * Appends edits to this PC's log and uploads them. ops: [{ session, field, value }].
 * Edits are committed even when GitHub cannot be reached; they upload with the next sync.
 */
export function appendStateOps(ops, { push = true } = {}) {
  const config = ensureRepo();
  const clean = (ops || []).filter((o) => o && isUuid(o.session) && STATE_FIELDS.has(o.field) && validValue(o.field, o.value ?? null));
  if (!clean.length) return { ok: true, nothing: true };
  // A conversation that is open on this PC is never deleted from under it.
  const open = openSessions();
  if (clean.some((o) => o.field === "deleted" && o.value === true && isLive(o.session, ownedLocalTranscripts(o.session), open))) {
    return { ok: false, code: "live", err: "That conversation is open in Claude Code on this PC, or was written to in the last two minutes. Close it first, then delete it." };
  }
  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok && rf.code === "git-busy") return { ok: false, code: "git-error", err: rf.err };
    const { maxHlc } = readStateLogs();
    const machine = machineName(config);
    const now = new Date().toISOString();
    const lines = clean.map((o) => JSON.stringify({ hlc: nextHlc(config, maxHlc), pc: machine, at: now, session: o.session, field: o.field, value: o.value ?? null }));
    const p = statePath(config);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let cur = "";
    try { cur = fs.readFileSync(p, "utf8"); } catch {}
    fs.appendFileSync(p, (cur && !cur.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
    const paths = [path.relative(REPO_DIR, p)];
    for (const o of clean) {
      // Delete takes the conversation's files out of the repo; git history keeps a copy.
      if (o.field === "deleted" && o.value === true) {
        const key = findSessionKey(o.session);
        if (key) {
          fs.rmSync(path.join(REPO_DIR, key, o.session), { recursive: true, force: true });
          paths.push(path.join(key, o.session));
        }
      }
    }
    const state = mergedState();
    clearRestoredSkips(state);
    paths.push(...pruneResurrected(state));
    if (deviceOutOfDate(config)) paths.push(writeDevice(config));
    const label = clean.map((o) => `${o.field} ${o.session.slice(0, 8)}`).join(", ").slice(0, 80);
    // Every git step is checked: an edit that did not make it into a commit would be
    // wiped by the next sync, so it is reported as failed instead.
    const add = git(["add", "-A", "--", ...[...paths, ...sharedPaths()].map(toGitPath)]);
    if (!add.ok) return { ok: false, code: "git-error", err: `git add failed: ${add.err}` };
    const d = git(["diff", "--cached", "--quiet"], { quiet: true });
    if (d.code === 0) return { ok: true, nothing: true };
    if (d.code !== 1) return { ok: false, code: "git-error", err: `git diff failed: ${d.err}` };
    const c = git(["commit", "--quiet", "-m", `Edit: ${label} (${machine})`]);
    if (!c.ok) return { ok: false, code: "git-error", err: `git commit failed: ${c.err}` };
    if (!push || !rf.ok) return { ok: true, queued: true, err: rf.ok ? undefined : rf.err };
    const pr = pushHead();
    if (pr.ok) uploadPending(); // uploads waiting on this PC go up while GitHub is reachable
    return pr.ok ? { ok: true, pushed: true } : { ok: true, queued: true, err: pr.err };
  });
}

/**
 * Uploads what is waiting on this PC: commits made while GitHub could not be reached,
 * and conversations whose upload did not finish (or that a conflict set aside).
 */
export function pushPending() {
  ensureRepo();
  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return { ok: false, offline: rf.code !== "git-busy", code: rf.code, err: rf.err };
    const up = uploadPending();
    const extra = up.uploaded.length || up.failed.length ? { reuploaded: up.uploaded, stillWaiting: up.failed } : {};
    if (!aheadCount()) return up.failed.length ? { ok: false, err: "some conversations could not be uploaded yet", ...extra } : { ok: true, nothing: !up.uploaded.length, ...extra };
    return { ...pushHead(), ...extra };
  });
}

/** Where the shared rules file is, and whether this PC has changes to it that GitHub lacks. */
export function rulesStatus() {
  const exists = fs.existsSync(RULES_PATH);
  const rel = toGitPath(path.relative(REPO_DIR, RULES_PATH));
  const st = git(["status", "--porcelain", "--", rel], { quiet: true });
  const modified = st.ok && st.out.trim().length > 0;
  const unpushed = aheadCount() > 0 && git(["log", "--format=%h", `origin/${currentBranch()}..HEAD`, "--", rel], { quiet: true }).out.trim().length > 0;
  return { ok: true, path: RULES_PATH, exists, modified, unpushed };
}

/** Uploads the shared rules now rather than with the next conversation upload. */
export function pushRules() {
  ensureRepo();
  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return { ok: false, offline: rf.code !== "git-busy", code: rf.code, err: rf.err };
    if (!fs.existsSync(RULES_PATH)) return { ok: false, err: `no shared rules file at ${RULES_PATH}` };
    // The refresh above already committed any edit; "nothing" means there was nothing to push either.
    const ahead = aheadCount();
    const r = commitAndPush(`Rules: shared CLAUDE.md (${machineName(loadConfig() || {})})`, [SHARED_DIR]);
    return { ...r, nothing: !!r.nothing && ahead === 0, ...rulesStatus() };
  });
}

// Workspaces this person has, so every PC can offer to set them up: one small file
// each (two PCs adding different ones never touch the same file), under the lock.
export const WORKSPACES_DIR = path.join(SHARED_DIR, "workspaces");
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function shareWorkspace({ id, name, remote }) {
  if (!WORKSPACE_ID.test(String(id)) || id === "main" || !String(name || "").trim() || !String(remote || "").trim()) return { ok: false, code: "bad-args", err: "a workspace needs an id, a name and a repository" };
  ensureRepo();
  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok && rf.code === "git-busy") return { ok: false, code: rf.code, err: rf.err };
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    const file = path.join(WORKSPACES_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, name: String(name).trim().slice(0, 40), remote: String(remote).trim() }, null, 2) + "\n");
    // Offline, the commit waits for the next upload.
    return { ...commitAndPush(`Workspaces: ${String(name).trim().slice(0, 40)} (${machineName(loadConfig() || {})})`, [WORKSPACES_DIR]), offline: !rf.ok };
  });
}

// A conversation skipped as deleted is uploaded again once it is restored.
function clearRestoredSkips(state) {
  const ids = Object.entries(loadState().sessions).filter(([id, v]) => v?.skip === "deleted" && !isDeleted(state, id)).map(([id]) => id);
  if (!ids.length) return;
  updateState((s) => {
    for (const id of ids) if (s.sessions[id]) delete s.sessions[id].skip;
  });
  log(`restored conversation(s) will upload again: ${ids.join(", ")}`);
}

// A PC still on version 2 does not know about deletes, and can upload a deleted
// conversation again. Its folder goes again with the next commit this PC makes.
function pruneResurrected(state) {
  const paths = [];
  for (const [id, f] of Object.entries(state)) {
    if (f.deleted !== true || !isUuid(id)) continue;
    const key = findSessionKey(id);
    if (!key) continue;
    fs.rmSync(path.join(REPO_DIR, key, id), { recursive: true, force: true });
    paths.push(path.join(key, id));
    log(`removed deleted conversation ${id} that an older PC uploaded again`);
  }
  return paths;
}

// Moves a file or folder, also across drives.
function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Moves one of this PC's copies of a conversation (and its session folder) into
 * backups/<kind>/<project folder>/. An earlier backup of the same conversation is
 * never replaced: it gets the lines it lacks, or the copy is kept under its own name.
 */
function retireCopy(p, kind) {
  const destDir = path.join(BACKUP_DIR, kind, path.basename(path.dirname(p)));
  fs.mkdirSync(destDir, { recursive: true });
  let to = path.join(destDir, path.basename(p));
  const raw = fs.readFileSync(p);
  if (fs.existsSync(to) && raw.length && raw[raw.length - 1] === 0x0a) {
    appendLines(to, missingLines(raw, fs.readFileSync(to)));
    fs.unlinkSync(p);
  } else {
    to = uniquePath(to);
    move(p, to);
  }
  const sibling = p.replace(/\.jsonl$/, "");
  if (fs.existsSync(sibling)) move(sibling, uniquePath(to.replace(/\.jsonl$/, "")));
  log(`moved ${kind} copy ${p} -> ${to}`);
  return to;
}

// This PC's copies of a deleted conversation go to the backup folder, so a delete on
// one PC removes it everywhere and nothing is ever lost for good. A copy that is open
// in Claude Code here is left until it closes.
function retireDeletedCopies(state, open = openSessions(), known = knownOwnedNames()) {
  const moved = new Set();
  for (const [id, fields] of Object.entries(state)) {
    if (fields.deleted !== true || !isUuid(id)) continue;
    const copies = ownedLocalTranscripts(id, known);
    if (!copies.length) continue;
    if (isLive(id, copies, open)) {
      log(`deleted conversation ${id} is still open on this PC; it moves to the backup folder once it closes`);
      continue;
    }
    for (const p of copies) {
      try {
        retireCopy(p, "deleted");
        moved.add(id);
      } catch (e) {
        log(`could not move deleted conversation ${p}: ${e.message}`);
      }
    }
  }
  return [...moved];
}

// ------------------------------------------------------------------- push

/**
 * Uploads one conversation. Returns { ok, auto, id, key, msg, ... }, or undefined
 * when an automatic upload decided there was nothing to do.
 */
export function pushSession(args) {
  const cwd = path.resolve(argText(args.cwd) ?? process.cwd());
  const auto = !!args.auto;
  const dryRun = !!args["dry-run"];
  const config = ensureRepo();
  const { id, transcript, guessed } = resolveSession({ session: args.session, transcript: args.transcript, cwd });

  sleep(Number(args.after) || 0); // trailing debounce: upload whatever the conversation looks like by then

  const project = projectInfo(cwd);
  const allow = new Set(config.allow || []);
  const known = loadState().sessions[id];
  const raw = fs.readFileSync(transcript);

  // Scripted runs (only ever the Agent SDK or `claude -p`) are not uploaded, unless the
  // Conversations app ran them (it says so in the environment, or with its "app" edit).
  const includeHeadless = () => process.env.CLAUDE_SYNC_INCLUDE_HEADLESS === "1" || mergedState()[id]?.app === true;

  if (auto) {
    if (known?.skip) {
      // A skip is final, except a delete that was undone, and a scripted run that has
      // since been carried on in Claude Code itself or claimed by the app.
      const lifted =
        (known.skip === "deleted" && !isDeleted(mergedState(), id)) ||
        (known.skip === "headless" && (includeHeadless() || !inspectTranscript(raw).headless));
      if (!lifted) return;
      patchSession(id, { skip: undefined });
      log(`${id} is no longer skipped (${known.skip})`);
    }
    if (!known?.pushedAt && !known?.pulledAt) {
      if ((config.exclude || []).includes(project.key)) {
        patchSession(id, { skip: "excluded" });
        log(`skip ${id}: project ${project.key} is excluded`);
        return;
      }
      const first = inspectTranscript(raw);
      if (first.headless && !includeHeadless()) {
        patchSession(id, { skip: "headless" });
        log(`skip ${id}: headless run`);
        return;
      }
      if (first.prompts === 0) {
        log(`skip ${id}: no typed prompts yet`);
        return;
      }
    }
  }

  const ctx = newRedactionCtx(allow);
  const local = redactJsonl(raw, ctx);
  const localSha = sha(local);
  // Nothing new since the last upload (an upload waiting to be retried always goes).
  if (auto && !args.retry && known?.pushedAt && known.sha256 === localSha && !known.pending) return;

  let res;
  try {
    // Hooks upload in the background, so they can wait for a long download to finish.
    res = withLock(() => uploadOne(), auto ? WORKER_LOCK_WAIT_MS : 60_000);
  } catch (e) {
    // Whatever went wrong (the lock held too long, a file that could not be written, a
    // damaged archive), the upload is remembered and tried again by the next sync.
    if (!dryRun) {
      try { markPending(id, { transcript, cwd, reason: e?.code === "busy" ? "busy" : "failed" }); } catch {}
    }
    if (e?.code !== "busy" || dryRun) throw e;
    res = { ok: false, auto, id, busy: true, pending: true, msg: "Another sync is still running. This conversation uploads with the next sync." };
  }
  // Anything but a finished upload (out of reach, the lock held too long, a git problem)
  // is retried by the next sync on this PC, from the transcript as it is then.
  if (res && !res.ok && !res.dryRun && !res.tooBig && !res.pending) {
    markPending(id, { transcript, cwd, reason: res.busy ? "busy" : res.offline ? "offline" : "failed" });
    res.pending = true;
  }
  return res;

  function uploadOne() {
    for (let attempt = 0; ; attempt++) {
      const rf = refreshRepo();
      if (!rf.ok && rf.code === "git-busy") return { ok: false, auto, id, msg: `Could not upload: ${rf.err}`, code: "git-error" };
      if (!rf.ok) return { ok: false, auto, id, msg: `Could not reach GitHub: ${rf.err}`, offline: true };

      const state = mergedState();
      if (isDeleted(state, id)) {
        patchSession(id, { skip: "deleted" });
        return { ok: true, auto, id, deleted: true, msg: "This conversation was deleted on another PC, so it is not uploaded again." };
      }
      clearRestoredSkips(state);

      // Keep a conversation in one project folder even if it is later opened from
      // a folder with another name.
      const key = findSessionKey(id) ?? project.key;
      const dir = path.join(REPO_DIR, key, id);
      const metaPath = path.join(dir, "meta.json");
      const meta = readJson(metaPath, {});
      const remote = readRemoteTranscript(dir);
      const toAdd = remote ? missingLines(local, remote) : null;
      const remoteOnly = remote ? missingLines(remote, local).length : 0;

      const siblingDir = transcript.replace(/\.jsonl$/, "");
      const changedFiles = fs.existsSync(siblingDir) ? pushFiles(siblingDir, path.join(dir, "files"), ctx, dryRun) : [];
      const redacted = redactionSummary(ctx);
      const transcriptChanged = remote === null || toAdd.length > 0;
      const merged = remote === null ? withLinesAppended(null, completeLines(local)) : withLinesAppended(remote, toAdd);
      const info = inspectTranscript(merged);

      if (dryRun) {
        const what = remote === null ? "not on GitHub yet" : toAdd.length ? `${toAdd.length} new entries to upload` : "transcript already on GitHub";
        return { ok: true, auto, id, key, dryRun: true, msg: `Dry run, nothing uploaded. "${info.title}" (${humanBytes(merged.length)}, ${info.prompts} prompts): ${what}, ${changedFiles.length} session files to update.${redacted ? `\nWould redact: ${redacted}` : ""}\nTarget: ${sessionUrl(config, key, id)}` };
      }

      // GitHub refuses any file over 100 MB, and one refused commit would hold back
      // every later upload from this PC. Such a transcript is never committed.
      const stored = transcriptChanged ? encodeRemoteTranscript(merged) : null;
      if (stored && stored.data.length > SKIP_FILE_OVER_BYTES) {
        git(["checkout", "--", "."], { quiet: true });
        git(["clean", "-fdq"], { quiet: true });
        patchSession(id, { skip: "too-big" });
        log(`not uploading ${id}: ${humanBytes(stored.data.length)} even compressed, over GitHub's limit`);
        return { ok: false, auto, id, key, tooBig: true, msg: `"${info.title}" is too large to upload (${humanBytes(stored.data.length)} even compressed; GitHub accepts files up to 100 MB). It stays on this PC only. Other conversations keep syncing.` };
      }

      if (stored) writeRemoteTranscript(dir, merged, stored);
      const machine = machineName(config);
      const now = new Date().toISOString();
      const changed = transcriptChanged || changedFiles.length > 0;
      const paths = [path.join(key, id)];
      if (changed || !meta.machines?.[machine]) {
        const gitRemote = remoteWithoutCredentials(project.remote ?? meta.gitRemote ?? null);
        writeJson(metaPath, {
          sessionId: id,
          project: key,
          title: info.title,
          firstPrompt: info.firstPrompt,
          prompts: info.prompts,
          startedAt: info.firstAt,
          lastMessageAt: info.lastAt,
          bytes: merged.length,
          sha256: sha(merged),
          gitRemote,
          projectId: projectIdOf(gitRemote, key),
          createdAt: meta.createdAt ?? now,
          updatedAt: changed ? now : meta.updatedAt ?? now,
          lastPushedFrom: changed ? machine : meta.lastPushedFrom ?? machine,
          machines: { ...(meta.machines || {}), [machine]: { cwd, lastPushAt: now } },
        });
        // The device file rides along with a commit that is being made anyway.
        if (info.version) updateState((s) => { s.claudeCodeVersion = info.version; });
        paths.push(writeDevice(config, { lastPushAt: now, claudeCode: info.version ?? undefined }));
      }
      paths.push(...pruneResurrected(state));

      const res = commitAndPush(`${remote ? "Update" : "Add"} ${key}: ${info.title.slice(0, 60)} (${machine})`, paths, { redo: true });
      // Another PC uploaded the same conversation at the same moment: merge again on top of it.
      if (!res.ok && res.recovered && attempt < 3) {
        log(`upload of ${id} met another PC's upload of it; merging again`);
        continue;
      }
      if (!res.ok) return { ok: false, auto, id, key, msg: `Upload failed: ${res.err}`, offline: !!res.committed };

      const st = updateState((s) => {
        // Only mark GitHub's copy as already on this PC when nothing came from elsewhere;
        // otherwise the next start must still download the other PC's entries.
        s.sessions[id] = { ...(s.sessions[id] || {}), key, sha256: localSha, remoteSha: remoteOnly ? undefined : sha(merged), pushedAt: now };
        if (remoteOnly) delete s.sessions[id].remoteSha;
        delete s.sessions[id].pending;
        if (s.sessions[id].skip === "too-big") delete s.sessions[id].skip;
        s.pushCount = (s.pushCount || 0) + 1;
      });
      if (auto && st.pushCount % GC_EVERY_PUSHES === 0) git(["gc", "--quiet"], { quiet: true, timeout: 30 * 60_000 });

      const what = res.nothing ? "Already up to date" : remote ? "Updated" : "Uploaded";
      const lines = [`${what}: "${info.title}" (${humanBytes(merged.length)}, ${info.prompts} prompts)${guessed ? " [detected as the most recently active conversation in this folder]" : ""}`];
      if (redacted) lines.push(`Redacted in the uploaded copy: ${redacted}`);
      if (remoteOnly) lines.push(`GitHub also has ${remoteOnly} newer entries from ${meta.lastPushedFrom ?? "another PC"} that this window does not show. Both are kept. To see them here: exit, reopen Claude in this folder, and /resume this conversation.`);
      lines.push(sessionUrl(config, key, id));
      // Other conversations waiting to upload again go up with this one.
      const others = uploadPending({ exclude: id });
      if (others.uploaded.length) log(`also uploaded ${others.uploaded.length} conversation(s) that were waiting: ${others.uploaded.join(", ")}`);
      return { ok: true, auto, id, key, nothing: !!res.nothing, uploaded: !res.nothing, remoteOnly, title: info.title, msg: lines.join("\n") };
    }
  }
}

// ------------------------------------------------------- uploads waiting
//
// An upload that could not finish (GitHub out of reach, another sync holding the lock
// too long, a git problem, or a conflict with another PC that set this PC's queued
// commit aside) is remembered in state.json as pending, with where its transcript is.
// The next sync of any kind on this PC (an upload, push-pending, pull-all, an edit, a
// session start) uploads it again from the transcript as it is then.

export function markPending(id, { transcript = null, cwd = null, reason = "failed" } = {}) {
  if (!isUuid(id)) return;
  updateState((s) => {
    const cur = s.sessions[id] || {};
    s.sessions[id] = { ...cur, pending: { at: new Date().toISOString(), reason, transcript: transcript ?? cur.pending?.transcript ?? null, cwd: cwd ?? cur.pending?.cwd ?? null } };
  });
}

function clearPending(id) {
  updateState((s) => {
    if (s.sessions[id]) delete s.sessions[id].pending;
  });
}

/** Conversations waiting to be uploaded again. */
export const pendingIds = (st = loadState()) => Object.entries(st.sessions || {}).filter(([id, v]) => v?.pending && isUuid(id)).map(([id]) => id);

let drainingPending = false;

/**
 * Uploads every conversation waiting to go up again. Returns the ids uploaded, failed
 * (kept for next time) and dropped (nothing left to upload: no transcript here, deleted,
 * skipped, or too big for GitHub).
 */
export function uploadPending({ exclude = null } = {}) {
  const out = { uploaded: [], failed: [], dropped: [] };
  if (drainingPending) return out;
  const ids = pendingIds().filter((x) => x !== exclude);
  if (!ids.length) return out;
  drainingPending = true;
  try {
    return withLock(() => {
      const known = knownOwnedNames();
      for (const id of ids) {
        const p = loadState().sessions[id]?.pending;
        if (!p) continue;
        const transcript = (p.transcript && fs.existsSync(p.transcript) ? p.transcript : null) ?? ownedLocalTranscripts(id, known)[0] ?? null;
        if (!transcript) {
          clearPending(id);
          out.dropped.push(id);
          log(`pending upload of ${id} dropped: its transcript is no longer on this PC`);
          continue;
        }
        let cwd = p.cwd && isDir(p.cwd) ? p.cwd : null;
        if (!cwd) {
          const c = inspectTranscript(fs.readFileSync(transcript)).cwd;
          cwd = (c && isDir(c) ? c : null) ?? localDirForProjectName(path.basename(path.dirname(transcript))) ?? HOME;
        }
        let r;
        try {
          r = pushSession({ session: id, transcript, cwd, auto: true, retry: true });
        } catch (e) {
          r = { ok: false, busy: e?.code === "busy", msg: String(e?.message || e) };
        }
        if (r?.ok && !r.deleted) out.uploaded.push(id);
        else if (!r || r.ok || r.tooBig) {
          clearPending(id); // skipped, deleted or too big: nothing more to do for it
          out.dropped.push(id);
        } else {
          out.failed.push(id);
          if (r.offline || r.busy) break; // the others would fail the same way; next time
        }
      }
      return out;
    });
  } finally {
    drainingPending = false;
  }
}

/** Retries waiting uploads, if any (a background worker, after its own job). */
export function drainPendingUploads() {
  if (!loadConfig()?.remote || !fs.existsSync(path.join(REPO_DIR, ".git"))) return null;
  // Also a commit left between "git commit" and "git push" by a process that died.
  if (!pendingIds().length && !aheadCount()) return null;
  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return { ok: false, offline: rf.code !== "git-busy", err: rf.err };
    const up = uploadPending();
    if (aheadCount()) pushHead();
    return { ok: true, ...up };
  }, WORKER_LOCK_WAIT_MS);
}

// ------------------------------------------------------------------- pull

const sizeOf = (p) => {
  try { return fs.statSync(p).size; } catch { return -1; }
};
const mtimeOf = (p) => {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
};
/** The copy with the most in it (the newest on a tie). */
const biggest = (copies) => [...copies].sort((a, b) => sizeOf(b) - sizeOf(a) || mtimeOf(b) - mtimeOf(a))[0];

/**
 * Brings this PC's copy of one conversation up to date with GitHub by appending the
 * entries it lacks, or creates it in targetDir. Only this PC's own project folders
 * are touched (see ownsProjectDir), and a conversation that is live here is left
 * alone. When this PC has more than one copy (an old folder name, a short-path
 * spelling), whatever the others have that the one staying lacks is added to it, and
 * they go to the backup folder, so `claude --resume <id>` finds exactly one.
 *
 * opts.allowOpen: how many running Claude Code processes may have it open (1 when the
 * process resuming it right now asks); with it, recent writes do not count as live.
 */
export function pullOne(s, targetDir, allow, { open = openSessions(), known = knownOwnedNames(), allowOpen = 0 } = {}) {
  const remote = readRemoteTranscript(s.dir);
  if (!remote) return { status: "missing" };
  if (!isUuid(s.sessionId)) return { status: "missing" };
  const copies = ownedLocalTranscripts(s.sessionId, known);
  const live = allowOpen ? (open.get(s.sessionId.toLowerCase()) || 0) > allowOpen : isLive(s.sessionId, copies, open);
  if (live) return { status: "live" };
  if (!copies.length && !ownsProjectDir(targetDir, known)) return { status: "no-folder" };
  const dest = copies.find((p) => samePath(path.dirname(p), targetDir)) ?? (copies.length ? biggest(copies) : path.join(targetDir, `${s.sessionId}.jsonl`));
  let status = "same";
  let added = 0;
  for (const other of copies) {
    if (samePath(other, dest)) continue;
    try {
      const extra = missingLines(fs.readFileSync(other), fs.readFileSync(dest));
      if (extra.length) {
        appendLines(dest, extra);
        added += extra.length;
        status = "updated";
      }
      const otherFiles = other.replace(/\.jsonl$/, "");
      if (fs.existsSync(otherFiles)) pullFiles(otherFiles, dest.replace(/\.jsonl$/, ""), allow);
      retireCopy(other, "duplicates");
    } catch (e) {
      log(`could not merge duplicate ${other}: ${e.message}`);
    }
  }
  if (!fs.existsSync(dest)) {
    writeNew(dest, withLinesAppended(null, completeLines(remote)));
    status = "downloaded";
  } else {
    const missing = missingLines(remote, redactJsonl(fs.readFileSync(dest), newRedactionCtx(allow)));
    if (missing.length) {
      appendLines(dest, missing); // append-only, like Claude itself
      added += missing.length;
      status = "updated";
    }
  }
  const files = path.join(s.dir, "files");
  if (fs.existsSync(files)) pullFiles(files, dest.replace(/\.jsonl$/, ""), allow);
  const st = fs.statSync(dest);
  const nowIso = new Date().toISOString();
  // grewAt: when a download last changed this PC's copy, so a window opened just before it can be told it is behind.
  patchSession(s.sessionId, { key: s.key, remoteSha: s.sha256, pulledAt: nowIso, localSize: st.size, ...(status !== "same" ? { grewAt: nowIso } : {}) });
  return { status, added, dest };
}

// Every conversation for this folder, brought up to date. Used when Claude starts.
export function autoPull(cwd, currentId) {
  const config = loadConfig();
  if (!config?.remote || !fs.existsSync(path.join(REPO_DIR, ".git"))) return [];
  const results = [];
  withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return log(`auto-pull: could not reach GitHub: ${rf.err}`);
    warnIfCloudSynced();
    updateState((s) => { s.lastPullAt = new Date().toISOString(); });
    const project = projectInfo(cwd);
    const targetDir = projectDirFor(cwd);
    const allow = new Set(config.allow || []);
    const known = knownOwnedNames([cwd]);
    const open = openSessions();
    const st = loadState();
    const state = mergedState();
    clearRestoredSkips(state);
    retireDeletedCopies(state, open, known);
    for (const s of remoteSessions(project)) {
      if (s.sessionId === currentId || isDeleted(state, s.sessionId)) continue;
      const knownS = st.sessions[s.sessionId];
      const copies = ownedLocalTranscripts(s.sessionId, known);
      // Nothing new on GitHub since this PC last synced it, and one copy in the right place.
      if (knownS?.remoteSha === s.sha256 && copies.length === 1 && samePath(path.dirname(copies[0]), targetDir)) continue;
      const r = pullOne(s, targetDir, allow, { open, known });
      if (r.status === "live") log(`auto-pull: left ${s.sessionId} alone, it is open on this PC`);
      if (r.status === "downloaded" || r.status === "updated") results.push({ ...r, title: s.title, from: s.lastPushedFrom, updatedAt: s.updatedAt });
    }
  }, WORKER_LOCK_WAIT_MS);
  return results;
}

// The conversation being resumed right now, checked against GitHub. The Claude
// process resuming it has it open; any other process having it open makes it live.
export function refreshCurrent(cwd, id) {
  const config = loadConfig();
  if (!config?.remote || !fs.existsSync(path.join(REPO_DIR, ".git"))) return null;
  let result = null;
  withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return log(`resume check: could not reach GitHub: ${rf.err}`);
    const key = findSessionKey(id);
    if (!key) return;
    const dir = path.join(REPO_DIR, key, id);
    const meta = readJson(path.join(dir, "meta.json"), null);
    if (!meta) return;
    const known = loadState().sessions[id];
    if (known?.remoteSha === meta.sha256) return;
    const r = pullOne({ ...meta, key, dir, sessionId: id }, projectDirFor(cwd), new Set(config.allow || []), { known: knownOwnedNames([cwd]), allowOpen: 1 });
    if (r.status === "live") log(`resume check: ${id} is also open in another Claude Code window on this PC; not adding to it`);
    if (r.added) result = { added: r.added, from: meta.lastPushedFrom, updatedAt: meta.updatedAt };
  }, WORKER_LOCK_WAIT_MS);
  return result;
}

// ------------------------------------------------- project folders on this PC

// The working folder a ~/.claude/projects folder belongs to. Transcripts can hold
// other PCs' paths (a conversation downloaded from elsewhere, or a folder another
// sync tool copied here), so only a cwd whose encoded name is this folder counts.
const encodeCwd = (cwd) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
function ownCwdOf(dir) {
  const name = path.basename(dir).toLowerCase();
  const matches = (cwd) => {
    const enc = encodeCwd(cwd);
    return enc === name || (enc.length > 200 && name.startsWith(enc.slice(0, 200)));
  };
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 30)
      .map((x) => x.f);
  } catch { return null; }
  for (const f of files) {
    try {
      const fd = fs.openSync(path.join(dir, f), "r");
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const m of buf.subarray(0, n).toString("utf8").matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
        let cwd;
        try { cwd = JSON.parse(`"${m[1]}"`); } catch { continue; }
        if (matches(cwd)) return cwd;
      }
    } catch {}
  }
  return null;
}

/**
 * Where each project lives on this PC: { [projectId]: folder }. Folders chosen in
 * the app (config.folders) win; otherwise every local transcript folder whose
 * working folder exists here is asked for its git remote. Cached in state.json.
 */
const FOLDER_CACHE_VERSION = 3;

export function localProjectFolders({ refresh = false } = {}) {
  const config = loadConfig() || {};
  const st = loadState();
  // Project ids are recomputed when the way remotes are spelled changes (FOLDER_CACHE_VERSION).
  const fresh = refresh || st.folderCacheVersion !== FOLDER_CACHE_VERSION;
  const cache = fresh ? {} : { ...(st.folderCache || {}) };
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  let changed = false;
  const counts = {};
  for (const d of dirs) {
    // How many transcripts, and when the newest was written: an unidentified folder is
    // looked at again whenever that changes (a count alone can come back to where it was).
    let sig = "";
    try {
      const files = fs.readdirSync(path.join(PROJECTS_DIR, d)).filter((f) => f.endsWith(".jsonl"));
      counts[d] = files.length;
      sig = `${files.length}:${Math.max(0, ...files.map((f) => mtimeOf(path.join(PROJECTS_DIR, d, f))))}`;
    } catch {
      counts[d] = 0;
    }
    // Known folders are trusted; unidentified ones are looked at again when their contents change.
    if (cache[d]?.folder || (cache[d] && cache[d].sig === sig)) continue;
    changed = true;
    cache[d] = { folder: null, n: counts[d], sig };
    // The working folder a conversation in it was written from, or else the folder on this
    // PC that its name stands for (it may hold only conversations downloaded from elsewhere).
    let cwd = ownCwdOf(path.join(PROJECTS_DIR, d));
    if (!cwd || !fs.existsSync(cwd)) cwd = localDirForProjectName(d);
    if (!cwd || !fs.existsSync(cwd)) continue;
    const top = gitTopLevel(cwd) ?? cwd;
    // Keep the folder spelled as Claude Code saw it (git may answer with the long
    // form of a short 8.3 path), so downloads land in this very projects folder.
    cache[d] = { folder: cwd, projectId: projectIdOf(gitRemoteOf(top), folderKey(top)), n: counts[d], sig };
  }
  if (changed || fresh) updateState((s) => {
    s.folderCache = cache;
    s.folderCacheVersion = FOLDER_CACHE_VERSION;
  });
  // Several folders can hold one repository (worktrees, a second checkout). The one
  // with the most conversations is normally the main checkout, so new chats go there.
  const best = {};
  for (const [d, v] of Object.entries(cache)) {
    if (!v?.folder || !fs.existsSync(v.folder)) continue;
    const count = counts[d] ?? 0;
    if (!best[v.projectId] || count > best[v.projectId].count) best[v.projectId] = { folder: v.folder, count };
  }
  const out = {};
  for (const [id, v] of Object.entries(best)) out[id] = v.folder;
  out["folder:_home"] ??= HOME;
  return { ...out, ...(config.folders || {}) };
}

/**
 * Brings every conversation on GitHub up to date on this PC (the app's background
 * download). This PC's copies are updated where they are; new ones go into their
 * project's folder when this PC has one. Live conversations (open in Claude Code
 * here, or written in the last two minutes) and the ids in skip are left alone.
 */
export function pullAll({ intoLocal = true, lockWaitMs = 60_000, skip = [] } = {}) {
  const config = ensureRepo();
  const skipIds = new Set((skip || []).filter(isUuid).map((x) => x.toLowerCase()));
  const summary = { ok: true, downloaded: [], updated: [], skippedLive: [], noFolder: 0, retired: [] };
  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return { ok: false, offline: rf.code !== "git-busy", code: rf.code, err: rf.err };
    warnIfCloudSynced();
    updateState((s) => { s.lastPullAt = new Date().toISOString(); });
    const state = mergedState();
    clearRestoredSkips(state);
    // Deleted conversations a PC on version 2 uploaded again are taken out again.
    const resurrected = pruneResurrected(state);
    if (resurrected.length) {
      const r = commitAndPush(`Remove ${resurrected.length} deleted conversation(s) uploaded again by an older PC (${machineName(config)})`, resurrected);
      if (!r.ok) log(`could not remove re-uploaded deleted conversations: ${r.err}`);
    }
    const folders = localProjectFolders();
    const known = knownOwnedNames(Object.values(folders));
    const open = openSessions();
    summary.retired = retireDeletedCopies(state, open, known);
    // Uploads that did not finish (or that a conflict set aside) go up now.
    const reupload = () => {
      const up = uploadPending();
      if (up.uploaded.length) summary.reuploaded = up.uploaded;
      if (up.failed.length) summary.stillWaiting = up.failed;
    };
    if (!intoLocal) {
      reupload();
      return summary;
    }
    const allow = new Set(config.allow || []);
    const st = loadState();
    for (const s of listRemoteSessions()) {
      if (isDeleted(state, s.sessionId) || skipIds.has(s.sessionId.toLowerCase())) continue;
      const knownS = st.sessions[s.sessionId];
      const copies = ownedLocalTranscripts(s.sessionId, known);
      if (copies.length === 1 && knownS?.remoteSha === s.sha256) continue;
      let targetDir;
      if (copies.length) targetDir = path.dirname(biggest(copies));
      else if (folders[s.projectId]) targetDir = projectDirFor(folders[s.projectId]);
      else {
        summary.noFolder++;
        continue;
      }
      const r = pullOne(s, targetDir, allow, { open, known });
      if (r.status === "live") summary.skippedLive.push(s.sessionId);
      else if (r.status === "downloaded") summary.downloaded.push({ id: s.sessionId, title: s.title, from: s.lastPushedFrom });
      else if (r.status === "updated") summary.updated.push({ id: s.sessionId, title: s.title, from: s.lastPushedFrom, added: r.added });
      else if (r.status === "no-folder") summary.noFolder++;
    }
    reupload();
    // A commit left between "git commit" and "git push" by a process that died goes up too.
    if (aheadCount()) {
      const p = pushHead();
      if (!p.ok) log(`could not push commits left behind: ${p.err}`);
    }
    const head = git(["rev-parse", `origin/${currentBranch()}`], { quiet: true }).out || null;
    updateState((s) => { s.pullAllHead = head; });
    return summary;
  }, lockWaitMs);
}

/**
 * Has GitHub's branch moved? Cheap: one ls-remote, no lock. changed compares with the
 * last fetch (by anything, hooks included); changedSincePullAll with the last pull-all,
 * which is what tells the app its local copies may be behind.
 */
export function checkRemote() {
  const config = loadConfig();
  if (!config?.remote || !fs.existsSync(path.join(REPO_DIR, ".git"))) return { ok: false, err: "not set up" };
  const branch = currentBranch();
  const r = git(["ls-remote", "origin", `refs/heads/${branch}`], { quiet: true, timeout: 30_000 });
  if (!r.ok) {
    noteSyncResult({ ok: false, error: r.err });
    return { ok: false, offline: true, err: r.err };
  }
  const remoteHead = r.out.split(/\s+/)[0] || null;
  const localHead = git(["rev-parse", `origin/${branch}`], { quiet: true }).out || null;
  let pullAllHead = null;
  try {
    const st = updateState((s) => {
      s.lastCheckAt = new Date().toISOString();
      s.lastOkAt = s.lastCheckAt;
      delete s.lastError;
      delete s.failingSince;
    });
    pullAllHead = st.pullAllHead ?? null;
  } catch {}
  return { ok: true, changed: !!remoteHead && remoteHead !== localHead, changedSincePullAll: !!remoteHead && remoteHead !== pullAllHead, remoteHead, localHead };
}

// ------------------------------------------------------------------ status

/** Everything the app shows about sync, read from local files and git (no network). */
export function status() {
  const config = loadConfig();
  const st = loadState();
  const repoReady = fs.existsSync(path.join(REPO_DIR, ".git"));
  let ahead = 0;
  let head = null;
  if (repoReady) {
    head = git(["rev-parse", "HEAD"], { quiet: true }).out || null;
    ahead = aheadCount();
  }
  return {
    engine: ENGINE_VERSION,
    setUp: !!config?.remote,
    remote: config?.remote ?? null,
    webUrl: config?.remote ? webUrl(config.remote) : null,
    machine: machineName(config),
    syncDir: SYNC_DIR,
    repoDir: REPO_DIR,
    projectsDir: PROJECTS_DIR,
    repoReady,
    head,
    // Commits not on GitHub yet, plus conversations whose upload waits to be retried
    // (both go up with push-pending).
    unpushedCommits: ahead + pendingIds(st).length,
    pendingUploads: pendingIds(st).length,
    lastFetchAt: st.lastFetchAt ?? null,
    lastPushAt: st.lastPushAt ?? null,
    lastPullAt: st.lastPullAt ?? null,
    lastCheckAt: st.lastCheckAt ?? null,
    lastOkAt: st.lastOkAt ?? null,
    lastError: st.lastError ?? null,
    failingSince: st.failingSince ?? null,
    busy: lockHolder(),
    cloudSyncedClaudeDir: cloudSyncedClaudeDir(),
    uploadQuietSeconds: uploadQuietMs(config) / 1000,
    sessions: st.sessions,
    devices: repoReady ? readDevices() : [],
    config: config ? { exclude: config.exclude || [], folders: config.folders || {}, appVersion: config.appVersion ?? null } : null,
  };
}

// ------------------------------------------------------------------ setup

export function setup({ remote, machine }) {
  if (!argText(remote)) throw new SyncError("Usage: setup --remote <git url of your private conversations repo> [--machine <name>]", "usage");
  const existing = loadConfig() || {};
  const config = { ...existing, remote, machine: argText(machine) || existing.machine || os.hostname() };
  writeJson(CONFIG_PATH, config);
  ensureRepo();
  return config;
}
