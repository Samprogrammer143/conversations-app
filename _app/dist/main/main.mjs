import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/main/workspace.ts
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// src/main/paths.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var HOME = os.homedir();
function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
}
function projectsDir() {
  return path.join(claudeDir(), "projects");
}
function defaultSyncDir() {
  if (process.env.CLAUDE_SYNC_HOME) return process.env.CLAUDE_SYNC_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "claude-conversation-sync");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "claude-conversation-sync");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "claude-conversation-sync");
}
function syncDir() {
  const fresh = defaultSyncDir();
  const legacy = path.join(claudeDir(), "conversation-sync");
  if (fs.existsSync(path.join(fresh, "config.json"))) return fresh;
  if (fs.existsSync(path.join(legacy, "config.json"))) return legacy;
  return fresh;
}
function repoDir() {
  return path.join(syncDir(), "repo");
}
function appRepoDir() {
  if (process.env.CONVERSATIONS_APP_HOME) return process.env.CONVERSATIONS_APP_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "conversations-app");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "conversations-app");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "conversations-app");
}
function engineScriptPath() {
  if (process.env.CONVERSATIONS_ENGINE) return process.env.CONVERSATIONS_ENGINE;
  const app3 = path.join(appRepoDir(), "_sync", "sync.mjs");
  if (fs.existsSync(app3)) return app3;
  return path.join(repoDir(), "_sync", "sync.mjs");
}
function appDataDir() {
  const base = process.env.CONVERSATIONS_DATA_DIR || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "Conversations") : path.join(HOME, ".conversations"));
  fs.mkdirSync(base, { recursive: true });
  return base;
}
function readSyncConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(syncDir(), "config.json"), "utf8"));
  } catch {
    return null;
  }
}
function thisMachine() {
  return readSyncConfig()?.machine || os.hostname();
}

// src/main/workspace.ts
var ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_SYNC_HOME", "CONVERSATIONS_DATA_DIR", "CONVERSATIONS_ENGINE"];
var local = () => process.env.LOCALAPPDATA || path2.join(os2.homedir(), "AppData", "Local");
var BASE = (() => {
  const relaunch = process.env.CONVERSATIONS_RELAUNCH;
  delete process.env.CONVERSATIONS_RELAUNCH;
  try {
    if (relaunch && process.env.CONVERSATIONS_BASE_ENV) return JSON.parse(process.env.CONVERSATIONS_BASE_ENV);
  } catch {
  }
  const b = {};
  for (const k of ENV_KEYS) if (process.env[k]) b[k] = process.env[k];
  process.env.CONVERSATIONS_BASE_ENV = JSON.stringify(b);
  return b;
})();
var baseDataDir = () => BASE.CONVERSATIONS_DATA_DIR || path2.join(local(), "Conversations");
var baseSyncHome = () => BASE.CLAUDE_SYNC_HOME || path2.join(local(), "claude-conversation-sync");
var baseClaudeDir = () => BASE.CLAUDE_CONFIG_DIR || path2.join(os2.homedir(), ".claude");
var registryFile = () => path2.join(baseDataDir(), "workspaces.json");
var engineOverridden = () => !!BASE.CONVERSATIONS_ENGINE;
var baseRepoDir = () => path2.join(baseSyncHome(), "repo");
var baseEngine = () => {
  if (BASE.CONVERSATIONS_ENGINE) return BASE.CONVERSATIONS_ENGINE;
  const app3 = path2.join(appRepoDir(), "_sync", "sync.mjs");
  return fs2.existsSync(app3) ? app3 : path2.join(baseRepoDir(), "_sync", "sync.mjs");
};
function baseEnv() {
  const env = { ...process.env };
  for (const k of ENV_KEYS) {
    if (BASE[k]) env[k] = BASE[k];
    else delete env[k];
  }
  return env;
}
function folders(id) {
  if (id === "main") return { claudeDir: baseClaudeDir(), syncHome: baseSyncHome(), dataDir: baseDataDir() };
  return { claudeDir: `${baseClaudeDir()}-${id}`, syncHome: `${baseSyncHome()}-${id}`, dataDir: path2.join(baseDataDir(), "workspaces", id) };
}
var isWorkspaceId = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v);
function readRegistry() {
  let text;
  try {
    text = fs2.readFileSync(registryFile(), "utf8");
  } catch {
    return { current: "main", extra: [] };
  }
  try {
    const r = JSON.parse(text);
    const extra = (Array.isArray(r.extra) ? r.extra : []).filter((w) => w && isWorkspaceId(w.id) && w.id !== "main" && typeof w.name === "string" && typeof w.remote === "string");
    const ids = ["main", ...extra.map((w) => w.id)];
    const disconnected = [...new Set((Array.isArray(r.disconnected) ? r.disconnected : []).filter((d) => ids.includes(d)))];
    const connected = ids.filter((d) => !disconnected.includes(d));
    let current = typeof r.current === "string" && ids.includes(r.current) ? r.current : "main";
    if (disconnected.includes(current) && connected.length) current = connected[0];
    return { current, mainName: typeof r.mainName === "string" && r.mainName.trim() ? r.mainName : void 0, extra, ...disconnected.length ? { disconnected } : {} };
  } catch {
    try {
      fs2.renameSync(registryFile(), `${registryFile()}.unreadable-${Date.now()}`);
    } catch {
    }
    return { current: "main", extra: [] };
  }
}
function writeRegistry(r) {
  const f = registryFile();
  fs2.mkdirSync(path2.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs2.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs2.renameSync(tmp, f);
}
function listWorkspaces() {
  const r = readRegistry();
  const off = new Set(r.disconnected ?? []);
  const main = { id: "main", name: r.mainName ?? "Main", remote: null, ...folders("main"), disconnected: off.has("main") };
  return { current: r.current, workspaces: [main, ...r.extra.map((w) => ({ ...w, ...folders(w.id), disconnected: off.has(w.id) }))] };
}
function setDisconnected(id, on) {
  const r = readRegistry();
  const set = new Set(r.disconnected ?? []);
  if (on) set.add(id);
  else set.delete(id);
  r.disconnected = [...set];
  if (!r.disconnected.length) delete r.disconnected;
  writeRegistry(r);
}
var currentWorkspace = () => {
  const { current, workspaces } = listWorkspaces();
  return workspaces.find((w) => w.id === current) ?? workspaces[0];
};
function newWorkspaceId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "workspace";
  const taken = new Set(listWorkspaces().workspaces.map((w) => w.id));
  let id = base === "main" ? "main-2" : base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}
function addWorkspace(w) {
  const r = readRegistry();
  r.extra = [...r.extra.filter((x) => x.id !== w.id), { id: w.id, name: w.name, remote: w.remote }];
  writeRegistry(r);
  return { ...w, ...folders(w.id), disconnected: (r.disconnected ?? []).includes(w.id) };
}
function renameWorkspace(id, name) {
  const r = readRegistry();
  if (id === "main") r.mainName = name;
  else r.extra = r.extra.map((w) => w.id === id ? { ...w, name } : w);
  writeRegistry(r);
}
function removeWorkspace(id) {
  if (id === "main") return;
  const r = readRegistry();
  r.extra = r.extra.filter((w) => w.id !== id);
  if (r.disconnected) r.disconnected = r.disconnected.filter((d) => d !== id);
  if (r.current === id) r.current = "main";
  writeRegistry(r);
}
function markRelaunch() {
  restoreBaseEnv();
  process.env.CONVERSATIONS_RELAUNCH = "1";
}
function restoreBaseEnv() {
  for (const k of ENV_KEYS) {
    if (BASE[k]) process.env[k] = BASE[k];
    else delete process.env[k];
  }
  delete process.env.CONVERSATIONS_CLAUDE_LAUNCHER;
}
function prepareSwitch(id) {
  const r = readRegistry();
  r.current = id;
  writeRegistry(r);
  restoreBaseEnv();
}
var mainAccountRecord = () => BASE.CLAUDE_CONFIG_DIR ? path2.join(BASE.CLAUDE_CONFIG_DIR, ".claude.json") : path2.join(os2.homedir(), ".claude.json");
function mainRemote() {
  try {
    const c = JSON.parse(fs2.readFileSync(path2.join(baseSyncHome(), "config.json"), "utf8"));
    return typeof c?.remote === "string" ? c.remote : null;
  } catch {
    return null;
  }
}
function workspaceEnv(w) {
  return w.id === "main" ? {} : { CLAUDE_CONFIG_DIR: w.claudeDir, CLAUDE_SYNC_HOME: w.syncHome };
}
(() => {
  const w = currentWorkspace();
  restoreBaseEnv();
  if (w.id === "main") return;
  process.env.CLAUDE_CONFIG_DIR = w.claudeDir;
  process.env.CLAUDE_SYNC_HOME = w.syncHome;
  process.env.CONVERSATIONS_DATA_DIR = w.dataDir;
  process.env.CONVERSATIONS_ENGINE = baseEngine();
})();

// src/main/workspace-actions.ts
import fs4 from "node:fs";
import os3 from "node:os";
import path4 from "node:path";
import { spawn } from "node:child_process";

// src/main/log.ts
import fs3 from "node:fs";
import path3 from "node:path";
var file = null;
function log(scope, message) {
  try {
    file ??= path3.join(appDataDir(), "app.log");
    try {
      if (fs3.statSync(file).size > 1024 * 1024) fs3.renameSync(file, `${file}.1`);
    } catch {
    }
    fs3.appendFileSync(file, `${(/* @__PURE__ */ new Date()).toISOString()} [${scope}] ${message}
`);
  } catch {
  }
  if (process.env.CONVERSATIONS_DEBUG) console.log(`[${scope}] ${message}`);
}

// src/main/workspace-actions.ts
var local2 = () => process.env.LOCALAPPDATA || path4.join(os3.homedir(), "AppData", "Local");
function signedIn(w) {
  try {
    if (fs4.existsSync(path4.join(w.claudeDir, ".credentials.json"))) return true;
    const cfg = w.id === "main" ? mainAccountRecord() : path4.join(w.claudeDir, ".claude.json");
    return !!JSON.parse(fs4.readFileSync(cfg, "utf8"))?.oauthAccount;
  } catch {
    return false;
  }
}
function workspacesForWindow() {
  const { current, workspaces } = listWorkspaces();
  const here = workspaces.map((w) => ({ id: w.id, name: w.name, remote: w.remote, setUp: w.id === "main" || fs4.existsSync(path4.join(w.syncHome, "repo", ".git")), signedIn: signedIn(w), disconnected: w.disconnected }));
  const elsewhere = readShared().filter((s) => !here.some((h) => h.id === s.id)).map((s) => ({ ...s, setUp: false, signedIn: false, disconnected: false }));
  return { current, workspaces: [...here, ...elsewhere] };
}
var sharedDir = () => path4.join(baseRepoDir(), "_shared", "workspaces");
function readShared() {
  let files2 = [];
  try {
    files2 = fs4.readdirSync(sharedDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files2) {
    try {
      const w = JSON.parse(fs4.readFileSync(path4.join(sharedDir(), f), "utf8"));
      if (w && isWorkspaceId(w.id) && w.id !== "main" && `${w.id}.json` === f && typeof w.name === "string" && typeof w.remote === "string" && isRemote(w.remote)) out.push({ id: w.id, name: w.name, remote: w.remote });
    } catch {
    }
  }
  return out;
}
async function shareWorkspace(w) {
  const r = await run([baseEngine(), "share-workspace", "--id", w.id, "--name", w.name, "--remote", w.remote], baseEnv(), 2 * 6e4);
  if (r.code !== 0 || !/"ok":\s*true/.test(r.out)) log("app", `could not share workspace ${w.id}: ${r.out.trim().slice(-300)}`);
}
function run(argv, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => out += d);
    const timer = setTimeout(() => {
      out += "\nthe setup took too long and was stopped";
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
var repoKey = (u) => u.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i, "$1/").replace(/^[^@/]+@([^:/]+):/, "$1/").replace(/^https?:\/\/(?:[^@/]+@)?/i, "").toLowerCase();
var sameRepo = (a, b) => repoKey(a) === repoKey(b);
function isRemote(v) {
  if (typeof v !== "string" || v.length > 400 || /[\s"'`<>|;&$]/.test(v)) return false;
  return /^https:\/\/[^/]+\/.+/.test(v) || /^git@[^:]+:.+/.test(v) || path4.isAbsolute(v) && fs4.existsSync(v);
}
function baseMachine() {
  try {
    const cfg = JSON.parse(fs4.readFileSync(path4.join(path4.dirname(baseRepoDir()), "config.json"), "utf8"));
    if (typeof cfg?.machine === "string" && cfg.machine) return cfg.machine;
  } catch {
  }
  return os3.hostname();
}
async function setUpWorkspace(input) {
  const name = input.name.trim().slice(0, 40);
  if (!name) return { ok: false, err: "Give the workspace a name" };
  if (!isRemote(input.remote)) return { ok: false, err: "That doesn't look like a repository address (https://github.com/you/repo)" };
  const remote = input.remote.trim();
  const main = mainRemote();
  if (main && sameRepo(main, remote)) return { ok: false, err: "That's the repository of your first workspace. A new workspace needs its own, new repository." };
  const known = listWorkspaces().workspaces;
  const retry = input.id && isWorkspaceId(input.id) && input.id !== "main" ? input.id : null;
  const clash = known.find((w2) => w2.remote && w2.id !== retry && sameRepo(w2.remote, remote));
  if (clash) return { ok: false, err: `That repository is already the ${clash.name} workspace's.` };
  const id = retry ?? newWorkspaceId(name);
  const isNew = !known.some((w2) => w2.id === id);
  const w = { id, name, remote, ...folders(id), disconnected: false };
  const made = [w.syncHome, w.claudeDir].filter((d) => !fs4.existsSync(d));
  fs4.mkdirSync(w.claudeDir, { recursive: true });
  const installer = path4.join(path4.dirname(baseEngine()), "install.mjs");
  const r = await run([installer, "--remote", remote, "--machine", baseMachine()], { ...baseEnv(), CLAUDE_CONFIG_DIR: w.claudeDir, CLAUDE_SYNC_HOME: w.syncHome }, 10 * 6e4);
  if (r.code !== 0) {
    const why = r.out.trim().split(/\r?\n/).filter(Boolean).pop() ?? "the setup stopped";
    log("app", `workspace ${id} setup failed: ${r.out.trim().slice(-600)}`);
    if (isNew) removeWorkspace(id);
    for (const d of made) {
      try {
        fs4.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {
      }
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
function seedSettings(w) {
  const target = path4.join(w.dataDir, "settings.json");
  if (fs4.existsSync(target)) return;
  let s = {};
  try {
    s = JSON.parse(fs4.readFileSync(path4.join(listWorkspaces().workspaces[0].dataDir, "settings.json"), "utf8"));
  } catch {
  }
  delete s.folders;
  try {
    fs4.mkdirSync(w.dataDir, { recursive: true });
    fs4.writeFileSync(target, JSON.stringify({ ...s, welcomed: true }, null, 2));
  } catch (e) {
    log("app", `could not start ${w.id}'s settings: ${e.message}`);
  }
}
function launcherDir() {
  if (process.env.CONVERSATIONS_LAUNCHER_DIR) return process.env.CONVERSATIONS_LAUNCHER_DIR;
  return path4.join(local2(), "Microsoft", "WindowsApps");
}
function launcherPath(w) {
  if (process.platform !== "win32") return null;
  return path4.join(launcherDir(), `claude-${w.id}.cmd`);
}
function claudeExe() {
  const npm = path4.join(process.env.APPDATA || path4.join(os3.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (fs4.existsSync(npm)) return npm;
  const native = path4.join(os3.homedir(), ".local", "bin", "claude.exe");
  return fs4.existsSync(native) ? native : "claude";
}
function writeLauncher(w) {
  const file4 = launcherPath(w);
  if (!file4) return false;
  const q = (s) => s.replace(/%/g, "%%");
  const exe = claudeExe();
  const env = w.id === "main" ? baseEnv() : { CLAUDE_CONFIG_DIR: w.claudeDir, CLAUDE_SYNC_HOME: w.syncHome };
  const set = (k) => `set "${k}=${q(env[k] ?? "")}"`;
  const body = ["@echo off", set("CLAUDE_CONFIG_DIR"), set("CLAUDE_SYNC_HOME"), `${exe === "claude" ? "claude" : `"${q(exe)}"`} %*`, ""].join("\r\n");
  try {
    fs4.mkdirSync(path4.dirname(file4), { recursive: true });
    fs4.writeFileSync(file4, body);
    return true;
  } catch (e) {
    log("app", `could not write ${file4}: ${e.message}`);
    return false;
  }
}

// src/main/main.ts
import fs25 from "node:fs";
import { execFile, spawn as spawn9 } from "node:child_process";
import path23 from "node:path";
import { fileURLToPath } from "node:url";
import { app as app2, BrowserWindow as BrowserWindow2, clipboard, dialog as dialog2, ipcMain, Menu, nativeImage, nativeTheme as nativeTheme2, session as electronSession, shell as shell2, Tray } from "electron";

// src/main/index/service.ts
import fs5 from "node:fs";
import os4 from "node:os";
import path5 from "node:path";
import zlib from "node:zlib";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

// src/main/index/db.ts
import { DatabaseSync } from "node:sqlite";
var SCHEMA_VERSION = 5;
function openDb(file4, { readOnly = false } = {}) {
  const db = new DatabaseSync(file4, { readOnly });
  db.exec("PRAGMA busy_timeout = 4000");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);
  }
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}
function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  const current = Number(row?.value || 0);
  if (current === SCHEMA_VERSION) return;
  const keepState = current > 0 ? safeAll(db, "SELECT conversation_id, seen_at, seen_last_at FROM local_state") : [];
  const keepApp = current > 0 ? safeAll(db, "SELECT conversation_id, cwd, created_at FROM app_sessions") : [];
  db.exec(`
    DROP TABLE IF EXISTS sources;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS items;
    DROP TABLE IF EXISTS fts;
    DROP TABLE IF EXISTS fts_rows;
    DROP TABLE IF EXISTS fts_title;
    DROP TABLE IF EXISTS fts_vocab;
    DROP TABLE IF EXISTS edits;
    DROP TABLE IF EXISTS local_state;
    DROP TABLE IF EXISTS app_sessions;
    DROP TABLE IF EXISTS machines;
    DROP TABLE IF EXISTS machine_activity;
  `);
  db.exec(`
    CREATE TABLE sources (
      path TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL
    );
    CREATE INDEX sources_conv ON sources(conversation_id);

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      sig TEXT NOT NULL,
      primary_path TEXT,
      local_path TEXT,
      repo_dir TEXT,
      folder_key TEXT,
      project_id TEXT NOT NULL,
      project_label TEXT NOT NULL,
      title TEXT NOT NULL,
      first_prompt TEXT,
      last_prompt TEXT,
      preview TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      last_at TEXT,
      prompts INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      last_pc TEXT,
      pcs TEXT NOT NULL DEFAULT '[]',
      cwd TEXT,
      git_branch TEXT,
      model TEXT,
      version TEXT,
      context_tokens INTEGER,
      peak_context_tokens INTEGER NOT NULL DEFAULT 0,
      local_mtime_ms INTEGER,
      item_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX conversations_last ON conversations(last_at DESC);
    CREATE INDEX conversations_project ON conversations(project_id);

    CREATE TABLE items (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    ) WITHOUT ROWID;

    CREATE VIRTUAL TABLE fts USING fts5(body, conversation_id UNINDEXED, seq UNINDEXED, role UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
    CREATE TABLE fts_rows (conversation_id TEXT NOT NULL, row INTEGER NOT NULL);
    CREATE INDEX fts_rows_conv ON fts_rows(conversation_id);
    CREATE VIRTUAL TABLE fts_title USING fts5(title, conversation_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '1 2 3');
    CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(fts, 'row');

    CREATE TABLE edits (
      conversation_id TEXT PRIMARY KEY,
      pinned INTEGER,
      title TEXT,
      archived INTEGER,
      deleted INTEGER,
      app INTEGER
    );

    CREATE TABLE local_state (
      conversation_id TEXT PRIMARY KEY,
      seen_at TEXT,
      seen_last_at TEXT
    );

    CREATE TABLE app_sessions (
      conversation_id TEXT PRIMARY KEY,
      cwd TEXT,
      created_at TEXT
    );

    CREATE TABLE machines (
      prefix TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE machine_activity (
      name TEXT PRIMARY KEY,
      last_push_at TEXT
    );
  `);
  const insState = db.prepare("INSERT OR REPLACE INTO local_state (conversation_id, seen_at, seen_last_at) VALUES (?, ?, ?)");
  for (const r of keepState) insState.run(r.conversation_id, r.seen_at, r.seen_last_at);
  const insApp = db.prepare("INSERT OR REPLACE INTO app_sessions (conversation_id, cwd, created_at) VALUES (?, ?, ?)");
  for (const r of keepApp) insApp.run(r.conversation_id, r.cwd, r.created_at);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
}
function safeAll(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

// src/main/index/service.ts
var IndexService = class _IndexService extends EventEmitter {
  db;
  worker;
  watchers = [];
  dirty = /* @__PURE__ */ new Set();
  dirtyAll = false;
  timer = null;
  periodic = null;
  hotTimer = null;
  /** Size and time of each live conversation's transcript at the last look. */
  hotSeen = /* @__PURE__ */ new Map();
  /** Where each live conversation's transcript is, found once. */
  hotPaths = /* @__PURE__ */ new Map();
  busy = false;
  queued = false;
  ready = false;
  firstRun = false;
  dbPath = path5.join(appDataDir(), "index.db");
  workerFile = "";
  restarts = 0;
  stopped = false;
  /** How many times a worker that died is started again before the index is left as it is. */
  static MAX_RESTARTS = 3;
  /**
   * Starts the worker and waits until the index is ready. If the worker dies
   * before that (a damaged index.db, a full disk), the index files are removed
   * and it is tried once more; after that the error is thrown, so the app can
   * carry on without an index instead of waiting forever.
   */
  async start(workerFile) {
    this.workerFile = workerFile;
    try {
      await this.spawnWorker();
    } catch (e) {
      log("index", `the index could not be opened (${e.message}); starting it afresh`);
      this.removeDbFiles();
      await this.spawnWorker();
    }
    this.db = openDb(this.dbPath, { readOnly: false });
    this.ready = true;
    this.scan("startup");
    this.watch();
    this.periodic = setInterval(() => this.scan("periodic"), 6e4);
  }
  removeDbFiles() {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        fs5.rmSync(`${this.dbPath}${suffix}`, { force: true });
      } catch {
      }
    }
  }
  /** The worker, and the promise of its "ready" message; rejected if it dies first. */
  spawnWorker() {
    const worker = new Worker(this.workerFile, {
      workerData: { dbPath: this.dbPath, opts: { projectsDir: projectsDir(), repoDir: repoDir(), home: os4.homedir(), thisMachine: thisMachine() } }
    });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let ready = false;
      worker.on("message", (m) => {
        if (m.type === "ready") {
          ready = true;
          resolve();
        } else this.onMessage(m);
      });
      worker.on("error", (e) => {
        log("index", `worker crashed: ${e.stack || e}`);
        if (!ready) reject(e);
      });
      worker.on("exit", (code) => {
        if (this.worker !== worker) return;
        if (!ready) {
          reject(new Error(`index worker exited with code ${code} before it was ready`));
          return;
        }
        this.busy = false;
        if (this.stopped) return;
        if (this.restarts >= _IndexService.MAX_RESTARTS) {
          log("index", `worker exited (code ${code}) ${this.restarts} times; the index is no longer updated until the app restarts`);
          return;
        }
        this.restarts++;
        log("index", `worker exited (code ${code}); starting it again (${this.restarts} of ${_IndexService.MAX_RESTARTS})`);
        this.spawnWorker().then(
          () => this.scan("restart"),
          (e) => log("index", `worker could not be started again: ${e.message}`)
        );
      });
    });
  }
  onMessage(m) {
    if (m.type === "scanned") {
      this.busy = false;
      const changed = [...m.changed ?? [], ...m.removed ?? []];
      if (changed.length || m.reason === "startup" || m.reason === "restart") this.emit("changed", changed, m);
      if (m.reason === "startup") log("index", `startup scan: ${m.changed.length} indexed of ${m.total} in ${m.ms} ms`);
      if (this.queued) {
        this.queued = false;
        this.flush();
      }
    } else if (m.type === "first-run") {
      this.firstRun = true;
      this.emit("first-run", m.total);
    } else if (m.type === "error") {
      this.busy = false;
      log("index", `worker error: ${String(m.message).slice(0, 500)}`);
    }
  }
  /** Full rescan (cheap: only changed files are read). */
  scan(reason = "manual") {
    this.dirtyAll = true;
    this.flushSoon(reason === "startup" ? 0 : 50, reason);
  }
  /** A conversation the app itself started: keep it even though it was made by the SDK. */
  own(id, cwd) {
    this.worker.postMessage({ type: "own", id, cwd });
  }
  watch() {
    const add = (dir, toId) => {
      if (!fs5.existsSync(dir)) return;
      try {
        const w = fs5.watch(dir, { recursive: true }, (_ev, file4) => {
          if (!file4) return this.scan("watch");
          const rel = String(file4);
          if (rel.startsWith(".git") || rel.includes(`${path5.sep}.git${path5.sep}`)) return;
          const id = toId(rel);
          if (id) {
            this.dirty.add(id);
            this.flushSoon(400);
          } else if (rel.startsWith("_state") || rel.startsWith("_devices")) {
            this.scan("edits");
          }
        });
        w.on("error", (e) => log("index", `watch error on ${dir}: ${e.message}`));
        this.watchers.push(w);
      } catch (e) {
        log("index", `cannot watch ${dir}: ${e.message}`);
      }
    };
    add(projectsDir(), (rel) => {
      const parts = rel.split(path5.sep);
      if (parts.length === 2 && parts[1].endsWith(".jsonl")) return parts[1].slice(0, -6);
      return null;
    });
    add(repoDir(), (rel) => {
      const parts = rel.split(path5.sep);
      if (parts.length === 3 && /^(transcript\.jsonl(\.gz)?|meta\.json)$/.test(parts[2])) return parts[1];
      return null;
    });
  }
  /**
   * Conversations that are being written right now (open in a terminal or in the
   * app, or on screen) are looked at every 1.5 s. Claude Code keeps a transcript
   * open while it runs, and Windows reports no change to a file another program
   * holds open, so the watcher alone would leave them stale until it closes.
   */
  watchLive(liveIds, everyMs = 1500) {
    if (this.hotTimer) clearInterval(this.hotTimer);
    this.hotTimer = setInterval(() => {
      try {
        this.pollLive(liveIds());
      } catch (e) {
        log("index", `live check failed: ${e.message}`);
      }
    }, everyMs);
    this.hotTimer.unref?.();
  }
  /** One look at the live conversations' transcripts; a size or time change marks them for the worker. */
  pollLive(ids) {
    if (!this.ready) return;
    const now = /* @__PURE__ */ new Set();
    let any = false;
    for (const id of ids) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || now.has(id)) continue;
      now.add(id);
      const file4 = this.livePath(id);
      if (!file4) continue;
      let sig;
      try {
        const st = fs5.statSync(file4);
        sig = `${st.size}:${st.mtimeMs}`;
      } catch {
        this.hotPaths.delete(id);
        continue;
      }
      const before = this.hotSeen.get(id);
      this.hotSeen.set(id, sig);
      if (before !== void 0 && before !== sig) {
        this.dirty.add(id);
        any = true;
      }
    }
    for (const id of [...this.hotSeen.keys()]) if (!now.has(id)) this.hotSeen.delete(id);
    for (const id of [...this.hotPaths.keys()]) if (!now.has(id)) this.hotPaths.delete(id);
    if (any) this.flushSoon(100);
  }
  /** This PC's transcript for a conversation: from the index, or found in the projects folder. */
  livePath(id) {
    const hit = this.hotPaths.get(id);
    if (hit && (hit.path || Date.now() - hit.at < 1e4)) return hit.path;
    let found = null;
    try {
      const row = this.db.prepare("SELECT local_path FROM conversations WHERE id = ?").get(id);
      if (row?.local_path && fs5.existsSync(row.local_path)) found = row.local_path;
    } catch {
    }
    if (!found) {
      try {
        for (const d of fs5.readdirSync(projectsDir(), { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const f = path5.join(projectsDir(), d.name, `${id}.jsonl`);
          if (fs5.existsSync(f)) {
            found = f;
            break;
          }
        }
      } catch {
      }
    }
    this.hotPaths.set(id, { path: found, at: Date.now() });
    return found;
  }
  flushSoon(ms, reason = "watch") {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(reason), ms);
  }
  flush(reason = "watch") {
    if (!this.ready) return;
    if (this.busy) {
      this.queued = true;
      return;
    }
    const only = this.dirtyAll ? void 0 : [...this.dirty];
    if (!this.dirtyAll && !only?.length) return;
    this.busy = true;
    this.dirty.clear();
    this.dirtyAll = false;
    this.worker.postMessage({ type: "scan", only, reason });
  }
  /** An image from a transcript, as a data URL. Only files under the two transcript folders can be read. */
  /** The last compressed transcript an image came from, already unpacked. */
  gzCache = null;
  async unpacked(file4) {
    const st = fs5.statSync(file4);
    const sig = `${st.size}:${st.mtimeMs}`;
    if (this.gzCache?.file === file4 && this.gzCache.sig === sig) return this.gzCache.buf;
    const buf = await new Promise((resolve, reject) => zlib.gunzip(fs5.readFileSync(file4), (err, out) => err ? reject(err) : resolve(out)));
    this.gzCache = { file: file4, sig, buf };
    return buf;
  }
  async image(key) {
    const [enc, offStr, blockStr] = key.split("|");
    const file4 = decodeURIComponent(enc ?? "");
    const offset = Number(offStr);
    const block = Number(blockStr);
    const allowed = [projectsDir(), repoDir()].some((root) => path5.resolve(file4).toLowerCase().startsWith(path5.resolve(root).toLowerCase() + path5.sep));
    if (!allowed || !Number.isFinite(offset) || !Number.isFinite(block)) return null;
    try {
      let line;
      if (file4.endsWith(".gz")) {
        const buf = await this.unpacked(file4);
        const end = buf.indexOf(10, offset);
        line = buf.toString("utf8", offset, end === -1 ? void 0 : end);
      } else {
        const fd = fs5.openSync(file4, "r");
        const chunks = [];
        let pos = offset;
        for (; ; ) {
          const b2 = Buffer.alloc(1024 * 1024);
          const n = fs5.readSync(fd, b2, 0, b2.length, pos);
          if (n <= 0) break;
          const nl = b2.subarray(0, n).indexOf(10);
          if (nl >= 0) {
            chunks.push(b2.subarray(0, nl));
            break;
          }
          chunks.push(b2.subarray(0, n));
          pos += n;
        }
        fs5.closeSync(fd);
        line = Buffer.concat(chunks).toString("utf8");
      }
      const entry = JSON.parse(line);
      const b = entry?.message?.content?.[block];
      if (b?.type !== "image" || b.source?.type !== "base64") return null;
      return `data:${b.source.media_type || "image/png"};base64,${b.source.data}`;
    } catch {
      return null;
    }
  }
  stop() {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    if (this.periodic) clearInterval(this.periodic);
    if (this.hotTimer) clearInterval(this.hotTimer);
    void this.worker?.terminate();
  }
};

// src/main/index/queries.ts
var LIVE_MS = 2 * 60 * 1e3;
var BASE2 = `
  SELECT c.*, e.pinned AS e_pinned, e.title AS e_title, e.archived AS e_archived, e.deleted AS e_deleted, s.seen_last_at
  FROM conversations c
  LEFT JOIN edits e ON e.conversation_id = c.id
  LEFT JOIN local_state s ON s.conversation_id = c.id
  WHERE c.item_count >= 0`;
function toRow(r, ctx2) {
  const p = ctx2.pending.get(r.id) ?? {};
  const pinned = p.pinned ?? r.e_pinned === 1;
  const archived = p.archived ?? r.e_archived === 1;
  const title = (p.title !== void 0 ? p.title : r.e_title) || r.title;
  const live = !!r.local_mtime_ms && ctx2.now - r.local_mtime_ms < LIVE_MS;
  const updated = !!r.last_pc && r.last_pc !== ctx2.thisMachine && !!r.last_at && (!r.seen_last_at || r.last_at > r.seen_last_at);
  let pcs = [];
  try {
    pcs = JSON.parse(r.pcs);
  } catch {
  }
  return {
    id: r.id,
    title,
    preview: r.preview || r.last_prompt || r.first_prompt || "",
    projectId: r.project_id,
    projectLabel: r.project_label,
    folderLabel: r.folder_key && r.folder_key !== r.project_label && !r.folder_key.startsWith("_") ? r.folder_key : null,
    lastAt: r.last_at,
    startedAt: r.started_at,
    lastPc: r.last_pc,
    pcs,
    prompts: r.prompts,
    bytes: r.bytes,
    pinned,
    archived,
    updated,
    live,
    runningHere: ctx2.running.has(r.id),
    onThisPc: !!r.local_path,
    cwd: r.cwd,
    model: r.model
  };
}
function allRows(db, ctx2) {
  const rows = db.prepare(`${BASE2} ORDER BY c.last_at DESC`).all();
  return rows.filter((r) => !(ctx2.pending.get(r.id)?.deleted ?? r.e_deleted === 1)).map((r) => toRow(r, ctx2));
}
function listConversations(db, q, ctx2) {
  let rows = allRows(db, ctx2);
  const scope = q.scope;
  if (scope.kind === "archived") rows = rows.filter((r) => r.archived);
  else {
    rows = rows.filter((r) => !r.archived);
    if (scope.kind === "pinned") rows = rows.filter((r) => r.pinned);
    else if (scope.kind === "project") {
      if (scope.id === "folder:*") rows = rows.filter((r) => r.projectId.startsWith("folder:") && r.projectId !== "folder:_home");
      else rows = rows.filter((r) => r.projectId === scope.id);
    } else if (scope.kind === "device") rows = rows.filter((r) => r.lastPc === scope.name || !r.lastPc && scope.name === ctx2.thisMachine);
  }
  const counts = { all: rows.length, updated: rows.filter((r) => r.updated).length, live: rows.filter((r) => r.live || r.runningHere).length };
  if (q.filter === "updated") rows = rows.filter((r) => r.updated);
  else if (q.filter === "live") rows = rows.filter((r) => r.live || r.runningHere);
  return { rows, counts };
}
function sidebarData(db, ctx2, devices2, folders3) {
  const rows = allRows(db, ctx2);
  const visible = rows.filter((r) => !r.archived);
  const byProject = /* @__PURE__ */ new Map();
  for (const r of visible) {
    const p = byProject.get(r.projectId) ?? { label: r.projectLabel, count: 0 };
    p.count++;
    byProject.set(r.projectId, p);
  }
  const local3 = new Set(db.prepare("SELECT DISTINCT project_id FROM conversations WHERE local_path IS NOT NULL AND item_count >= 0").all().map((r) => r.project_id));
  const projects = [];
  const otherIds = [];
  let otherCount = 0;
  for (const [id, p] of byProject) {
    if (id === "folder:_home") continue;
    if (id.startsWith("folder:")) {
      otherIds.push(id);
      otherCount += p.count;
      continue;
    }
    projects.push({ id, label: p.label, kind: "repo", count: p.count, folder: folders3[id] ?? null, onThisPc: local3.has(id) });
  }
  projects.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const home = byProject.get("folder:_home");
  if (home) projects.push({ id: "folder:_home", label: "Home folder", kind: "home", count: home.count, folder: folders3["folder:_home"] ?? null });
  return {
    total: visible.length,
    pinned: visible.filter((r) => r.pinned).length,
    archived: rows.filter((r) => r.archived).length,
    projects,
    otherFolders: { count: otherCount, ids: otherIds },
    devices: deviceSummaries(db, ctx2, devices2, rows),
    pcCount: 0
  };
}
function deviceSummaries(db, ctx2, devices2, rows) {
  const names = /* @__PURE__ */ new Set([ctx2.thisMachine]);
  for (const m of db.prepare("SELECT name FROM machines").all()) names.add(m.name);
  const pushed = new Map(db.prepare("SELECT name, last_push_at FROM machine_activity").all().map((r) => [r.name, r.last_push_at]));
  for (const n of pushed.keys()) names.add(n);
  for (const d of devices2) names.add(d.name);
  const list = rows ?? allRows(db, ctx2);
  const lastSeen = /* @__PURE__ */ new Map();
  for (const r of list) {
    if (!r.lastPc || !r.lastAt) continue;
    if (!lastSeen.has(r.lastPc) || r.lastAt > lastSeen.get(r.lastPc)) lastSeen.set(r.lastPc, r.lastAt);
  }
  const seenOf = (name) => {
    const d = devices2.find((x) => x.name === name);
    return [d?.lastSeenAt, d?.lastPushAt, pushed.get(name), lastSeen.get(name)].filter(Boolean).sort().pop() ?? null;
  };
  return [...names].sort((a, b) => a === ctx2.thisMachine ? -1 : b === ctx2.thisMachine ? 1 : String(seenOf(b) ?? "").localeCompare(String(seenOf(a) ?? "")) || a.localeCompare(b)).map((name) => {
    const d = devices2.find((x) => x.name === name);
    const seen = seenOf(name);
    const status = name === ctx2.thisMachine ? "current" : d && (d.engine ?? 0) >= 3 ? "current" : "old-sync";
    return {
      name,
      isThisPc: name === ctx2.thisMachine,
      lastSeenAt: seen,
      engine: d?.engine ?? null,
      app: d?.app ?? null,
      claudeCode: d?.claudeCode ?? null,
      status,
      color: "graphite",
      glyph: /laptop|book|surface/i.test(name) ? "laptop" : "monitor"
    };
  });
}
function conversationDetail(db, id, ctx2, folders3) {
  const r = db.prepare(`${BASE2} AND c.id = ?`).get(id);
  if (!r) return null;
  const row = toRow(r, ctx2);
  const where = row.folderLabel ?? row.projectLabel;
  const who = row.runningHere || row.live && row.lastPc === ctx2.thisMachine ? "Live on this PC" : `Last on ${row.lastPc === ctx2.thisMachine ? "this PC" : row.lastPc ?? "another PC"}`;
  const subtitle = [who, where, `${row.prompts} prompt${row.prompts === 1 ? "" : "s"}`].join("  \xB7  ");
  const folder = folders3[row.projectId] ?? (r.cwd && r.local_path ? r.cwd : null);
  const recentElsewhere = row.lastPc && row.lastPc !== ctx2.thisMachine && row.lastAt && ctx2.now - Date.parse(row.lastAt) < LIVE_MS ? { pc: row.lastPc, at: row.lastAt } : null;
  return {
    row,
    subtitle,
    totalItems: r.item_count,
    partial: false,
    bytes: r.bytes,
    folder,
    canContinue: !!folder,
    alsoOpenOn: recentElsewhere,
    contextPercent: contextPercent(db, r)
  };
}
function contextPercent(db, r) {
  if (!r.context_tokens || !r.model) return null;
  const peak = db.prepare("SELECT MAX(peak_context_tokens) AS p FROM conversations WHERE model = ?").get(r.model).p ?? 0;
  const window = peak > 2e5 && peak <= 1e6 ? 1e6 : /haiku/i.test(r.model) ? 2e5 : null;
  if (!window) return null;
  return Math.max(1, Math.min(100, Math.round(r.context_tokens / window * 100)));
}
function itemsPage(db, id, beforeSeq, limit) {
  const total = db.prepare("SELECT COUNT(*) AS n FROM items WHERE conversation_id = ?").get(id).n;
  const rows = beforeSeq == null ? db.prepare("SELECT json FROM items WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?").all(id, limit) : db.prepare("SELECT json FROM items WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(id, beforeSeq, limit);
  const items = rows.map((r) => JSON.parse(r.json)).reverse();
  return { items, firstSeq: items.length ? items[0].seq : 0, total };
}
function markSeen(db, id) {
  const r = db.prepare("SELECT last_at FROM conversations WHERE id = ?").get(id);
  db.prepare("INSERT OR REPLACE INTO local_state (conversation_id, seen_at, seen_last_at) VALUES (?, ?, ?)").run(id, (/* @__PURE__ */ new Date()).toISOString(), r?.last_at ?? null);
}
function ftsQuery(text) {
  const words = text.normalize("NFKC").split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 0).slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" ");
}
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function search(db, text, ctx2, { includeTools = false, limit = 20 } = {}) {
  const t0 = performance.now();
  const q = ftsQuery(text);
  const rows = allRows(db, ctx2);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hits = [];
  const seen = /* @__PURE__ */ new Set();
  if (q) {
    try {
      const titleHits = db.prepare("SELECT conversation_id AS id, bm25(fts_title) AS score FROM fts_title WHERE fts_title MATCH ? ORDER BY score LIMIT 50").all(q);
      for (const h of titleHits) {
        const r = byId.get(h.id);
        if (!r || seen.has(h.id)) continue;
        seen.add(h.id);
        hits.push({ id: r.id, title: r.title, projectLabel: r.projectLabel, lastPc: r.lastPc, lastAt: r.lastAt, snippet: null, field: "title" });
      }
    } catch {
    }
    try {
      const roles = includeTools ? "('prompt','reply','tool')" : "('prompt','reply')";
      const bodyHits = db.prepare(`SELECT conversation_id AS id, role, snippet(fts, 0, char(1), char(2), '\u2026', 10) AS snip, bm25(fts) AS score FROM fts WHERE fts MATCH ? AND role IN ${roles} ORDER BY score LIMIT 400`).all(q);
      for (const h of bodyHits) {
        const r = byId.get(h.id);
        if (!r) continue;
        if (seen.has(h.id)) {
          const existing = hits.find((x) => x.id === h.id);
          if (existing && !existing.snippet && existing.field === "title") continue;
          continue;
        }
        seen.add(h.id);
        hits.push({ id: r.id, title: r.title, projectLabel: r.projectLabel, lastPc: r.lastPc, lastAt: r.lastAt, snippet: h.snip.replace(/\s+/g, " "), field: h.role === "prompt" ? "prompt" : h.role === "tool" ? "tool" : "reply" });
      }
    } catch {
    }
  }
  const titleFirst = hits.filter((h) => h.field === "title");
  const rest = hits.filter((h) => h.field !== "title").sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  const out = [...titleFirst, ...rest].slice(0, limit);
  let suggestion = null;
  if (!out.length && q) {
    const word = text.trim().toLowerCase().split(/\s+/).pop() ?? "";
    if (word.length >= 3) {
      const candidates = db.prepare("SELECT term, doc FROM fts_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?").all(word[0], String.fromCharCode(word.charCodeAt(0) + 1), word.length - 2, word.length + 2);
      let best = null;
      for (const c of candidates) {
        const d = levenshtein(word, c.term);
        if (d === 0 || d > 2) continue;
        if (!best || d < best.d || d === best.d && c.doc > best.doc) best = { term: c.term, doc: c.doc, d };
      }
      if (best) {
        const again = search(db, best.term, ctx2, { includeTools, limit: 200 });
        if (again.hits.length) suggestion = { text: best.term, count: again.hits.length };
      }
    }
  }
  const pcs = new Set(rows.flatMap((r) => r.lastPc ? [r.lastPc] : []));
  return { query: text, hits: out, suggestion, searchedConversations: rows.length, pcCount: pcs.size, tookMs: Math.round(performance.now() - t0) };
}

// src/main/sync/repo-read.ts
import fs6 from "node:fs";
import path6 from "node:path";
function readJson(p) {
  try {
    return JSON.parse(fs6.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function readDevices(repoDir2) {
  const dir = path6.join(repoDir2, "_devices");
  const out = [];
  try {
    for (const f of fs6.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const d = readJson(path6.join(dir, f));
      if (d?.name) out.push({ ...d, slug: f.replace(/\.json$/, "") });
    }
  } catch {
  }
  return out;
}

// src/main/sync/scheduler.ts
import fs10 from "node:fs";
import os5 from "node:os";
import path8 from "node:path";
import { EventEmitter as EventEmitter3 } from "node:events";
import { spawn as spawn3 } from "node:child_process";
import { net } from "electron";

// src/main/settings.ts
import fs7 from "node:fs";
import path7 from "node:path";
import { EventEmitter as EventEmitter2 } from "node:events";

// src/main/validate.ts
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var isUuid = (v) => typeof v === "string" && UUID.test(v);
var isRequestId = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
var isModelName = (v) => typeof v === "string" && /^[A-Za-z0-9._:[\]-]{1,80}$/.test(v);
var EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
var isEffort = (v) => typeof v === "string" && EFFORT_LEVELS.includes(v);
var PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"];
var isPermissionMode = (v) => typeof v === "string" && PERMISSION_MODES.includes(v);
var DECISIONS = ["allow", "allow-always", "deny"];
var isDecision = (v) => typeof v === "string" && DECISIONS.includes(v);
function checkEdit(field, value) {
  if (field === "pinned" || field === "archived" || field === "deleted") return typeof value === "boolean" ? { field, value } : null;
  if (field === "title") {
    if (value === null) return { field, value: null };
    if (typeof value !== "string") return null;
    const t = value.replace(/\s+/g, " ").trim();
    if (t.length > 200) return null;
    return { field, value: t || null };
  }
  return null;
}

// src/main/settings.ts
var DEFAULT_SETTINGS = {
  theme: "system",
  windowMaterial: "mica",
  syncAutomatically: true,
  checkWhileOpenSeconds: 30,
  checkFromTraySeconds: 300,
  uploadDelay: "after-quiet",
  keepResumeUpToDate: true,
  startAtLogin: true,
  showArchived: false,
  defaultModel: null,
  defaultPermissionMode: "default",
  folders: {},
  welcomed: false
};
var isBool = (v) => typeof v === "boolean";
var isInt = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
function isFolders(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= 1e3 && entries.every(([k, p]) => k.length > 0 && k.length <= 400 && typeof p === "string" && p.length <= 1e3 && path7.isAbsolute(p));
}
var CHECKS = {
  theme: (v) => v === "system" || v === "light" || v === "dark",
  windowMaterial: (v) => v === "mica" || v === "solid",
  syncAutomatically: isBool,
  checkWhileOpenSeconds: (v) => isInt(v, 10, 3600),
  checkFromTraySeconds: (v) => isInt(v, 30, 86400),
  uploadDelay: (v) => v === "after-quiet" || v === "fast",
  keepResumeUpToDate: isBool,
  startAtLogin: isBool,
  showArchived: isBool,
  defaultModel: (v) => v === null || isModelName(v),
  defaultPermissionMode: isPermissionMode,
  folders: isFolders,
  welcomed: isBool
};
function sanitizeSettingsPatch(patch) {
  const out = {};
  const rejected = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { patch: {}, rejected: ["(not an object)"] };
  for (const [k, v] of Object.entries(patch)) {
    const check = CHECKS[k];
    if (check && Object.prototype.hasOwnProperty.call(CHECKS, k) && check(v)) out[k] = k === "folders" ? { ...v } : v;
    else rejected.push(k);
  }
  return { patch: out, rejected };
}
var SettingsStore = class extends EventEmitter2 {
  value = { ...DEFAULT_SETTINGS };
  file = "";
  load() {
    this.file = path7.join(appDataDir(), "settings.json");
    try {
      const raw = JSON.parse(fs7.readFileSync(this.file, "utf8"));
      this.value = { ...DEFAULT_SETTINGS, ...sanitizeSettingsPatch(raw).patch };
    } catch {
      this.value = { ...DEFAULT_SETTINGS };
    }
    return this.value;
  }
  get() {
    return this.value;
  }
  set(patch) {
    this.value = { ...this.value, ...patch };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs7.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs7.renameSync(tmp, this.file);
    this.emit("change", this.value, patch);
    return this.value;
  }
};
var settings = new SettingsStore();

// src/main/remote-display.ts
function stripUrlCredentials(text) {
  if (text == null) return null;
  return String(text).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, "$1");
}
function displayRemote(remote) {
  if (!remote || typeof remote !== "string") return null;
  const r = remote.trim();
  if (/^[a-z]:[\\/]/i.test(r) || /^(\\\\|\/|\.)/.test(r)) return r;
  let host;
  let repoPath;
  const scp = r.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const u = new URL(r);
      host = u.hostname;
      repoPath = decodeURIComponent(u.pathname);
    } catch {
      return stripUrlCredentials(r);
    }
  }
  repoPath = repoPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return host.toLowerCase() === "github.com" ? repoPath : `${host}/${repoPath}`;
}

// src/main/sync/engine-bridge.ts
import { spawn as spawn2 } from "node:child_process";
import fs8 from "node:fs";
function killTree(child) {
  if (!child.pid) return;
  const plain = () => {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  };
  if (process.platform !== "win32") return plain();
  const k = spawn2("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  k.on("error", plain);
  k.on("close", (code) => {
    if (code !== 0) plain();
  });
}
function engineScript() {
  return engineScriptPath();
}
var engineVersion = null;
function runEngine(args, { timeoutMs = 10 * 6e4, env = {} } = {}) {
  const script = engineScript();
  const t0 = Date.now();
  return new Promise((resolve) => {
    if (!fs8.existsSync(script)) {
      resolve({ ok: false, code: null, json: null, stderr: `Sync engine not found at ${script}`, stdout: "", ms: 0 });
      return;
    }
    const child = spawn2(process.execPath, [script, ...args], {
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => err += d);
    let settled = false;
    let grace = null;
    const timer = setTimeout(() => {
      log("engine", `${args[0]} took longer than ${Math.round(timeoutMs / 1e3)} s; stopping it and the git it started`);
      killTree(child);
      grace = setTimeout(() => {
        if (settled) return;
        settled = true;
        log("engine", `${args[0]} did not stop after being killed; giving up on it`);
        resolve({ ok: false, code: null, json: null, stderr: `${args[0]} timed out after ${Math.round(timeoutMs / 1e3)} s`, stdout: out, ms: Date.now() - t0 });
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (settled) return;
      settled = true;
      let json = null;
      const last2 = out.trim().split("\n").pop();
      if (last2) {
        try {
          json = JSON.parse(last2);
        } catch {
        }
      }
      const ms = Date.now() - t0;
      if (code !== 0) log("engine", `${args[0]} exited ${code} in ${ms} ms: ${err.split("\n")[0].slice(0, 300)}`);
      resolve({ ok: code === 0 && !!json && json.ok !== false, code, json, stderr: err, stdout: out, ms });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: null, json: null, stderr: String(e.message), stdout: out, ms: Date.now() - t0 });
    });
  });
}
var KILL_GRACE_MS = 1e4;
async function detectEngineVersion(force = false) {
  if (engineVersion !== null && !force) return engineVersion;
  const script = engineScript();
  if (!fs8.existsSync(script)) {
    engineVersion = null;
    return 0;
  }
  const r = await runEngine(["version"], { timeoutMs: 3e4 });
  const text = r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop() ?? "" : "";
  if (r.code === null) return engineVersion ?? 2;
  engineVersion = /^\d+$/.test(text) ? Number(text) : 2;
  return engineVersion;
}
var queue = Promise.resolve();
function runEngineSerial(args, opts) {
  const next = queue.then(() => runEngine(args, opts));
  queue = next.catch(() => void 0);
  return next;
}

// src/main/sync/pull-decision.ts
import fs9 from "node:fs";
var RETRY_SKIPPED_MS = 15e4;
function shouldPull(a) {
  if (a.force) return true;
  if (a.retryAt != null && (a.now ?? Date.now()) >= a.retryAt) return true;
  if (a.remoteHead) return a.remoteHead !== a.lastProcessed;
  return !!a.changed;
}
var HeadStore = class {
  constructor(file4) {
    this.file = file4;
  }
  file;
  get() {
    try {
      const v = JSON.parse(fs9.readFileSync(this.file, "utf8"));
      return typeof v?.head === "string" ? v.head : null;
    } catch {
      return null;
    }
  }
  set(head) {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs9.writeFileSync(tmp, JSON.stringify({ head, at: (/* @__PURE__ */ new Date()).toISOString() }));
      fs9.renameSync(tmp, this.file);
    } catch {
    }
  }
};

// src/main/sync/scheduler.ts
function repoSizeBytes(dir) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn3("git", ["count-objects", "-v"], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), 6e4);
    child.stdout?.on("data", (d) => out += d);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const kb = (name) => Number(out.match(new RegExp(`^${name}: (\\d+)`, "m"))?.[1] ?? 0);
      resolve(code === 0 ? (kb("size") + kb("size-pack")) * 1024 : null);
    });
  });
}
var ATTENTION_AFTER_MS = 3 * 6e4;
var SyncScheduler = class extends EventEmitter3 {
  constructor(opts) {
    super();
    this.opts = opts;
    this.heads = new HeadStore(path8.join(appDataDir(), "sync-head.json"));
    try {
      this.recent = JSON.parse(fs10.readFileSync(path8.join(appDataDir(), "activity.json"), "utf8"));
    } catch {
    }
  }
  opts;
  timer = null;
  running = false;
  phase = "idle";
  engine = null;
  recent = [];
  nextAt = null;
  repoSize = null;
  repoSizeAt = 0;
  engineVersion = 0;
  announced = false;
  lastEngineRefresh = 0;
  heads;
  /** When to run pull-all again for conversations it skipped while they were live. */
  retryPullAt = null;
  /** Requests to run pull-all again soon (a conversation the app had open was closed), and how many a finished pull-all covered. */
  retryRequests = 0;
  retryServed = 0;
  async start() {
    this.engineVersion = await detectEngineVersion();
    log("sync", `engine version ${this.engineVersion}`);
    await this.refreshEngineStatus();
    this.schedule(1500);
  }
  schedule(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    this.timer.unref?.();
    this.emitStatus();
  }
  /** Is a tick waiting to run? */
  get armed() {
    return this.timer !== null;
  }
  /** Window shown or focused: check soon instead of waiting for the tray interval, and re-arm if nothing is waiting. */
  nudge() {
    if (this.running) return;
    if (!this.timer || this.nextAt && this.nextAt - Date.now() > 3e3) this.schedule(500);
  }
  /**
   * A conversation the app had open (and pull-all therefore left alone) was closed:
   * run pull-all again soon, even if GitHub hasn't moved, so it is brought up to date.
   */
  retrySoon() {
    this.retryRequests++;
    if (!this.running && (!this.nextAt || this.nextAt - Date.now() > 3e3)) this.schedule(2e3);
  }
  get retryPending() {
    return this.retryRequests > this.retryServed;
  }
  async syncNow() {
    await this.tick(true);
  }
  setPaused(paused) {
    settings.set({ syncAutomatically: !paused });
    if (!paused) this.schedule(200);
    else this.emitStatus();
  }
  record(a) {
    this.recent.unshift({ ...a, at: (/* @__PURE__ */ new Date()).toISOString() });
    this.recent = this.recent.slice(0, 20);
    try {
      fs10.writeFileSync(path8.join(appDataDir(), "activity.json"), JSON.stringify(this.recent));
    } catch {
    }
  }
  async refreshEngineStatus() {
    const r = await runEngine(["status", "--json"], { timeoutMs: 6e4 });
    if (r.json && r.json.setUp !== void 0) this.engine = r.json;
    if (Date.now() - this.repoSizeAt > 10 * 6e4) {
      this.repoSizeAt = Date.now();
      void repoSizeBytes(repoDir()).then((size) => {
        if (size !== null && size !== this.repoSize) {
          this.repoSize = size;
          this.emitStatus();
        }
      });
    }
  }
  async tick(force = false) {
    if (this.running) return;
    const s = settings.get();
    if (!s.syncAutomatically && !force) {
      this.phase = "paused";
      this.schedule(s.checkFromTraySeconds * 1e3);
      return;
    }
    if (!readSyncConfig()?.remote) {
      this.phase = "not-set-up";
      this.engineVersion = 0;
      this.schedule(3e4);
      return;
    }
    this.running = true;
    try {
      if (this.engineVersion < 3) this.engineVersion = await detectEngineVersion(true);
      if (this.engineVersion < 3) {
        if (Date.now() - this.lastEngineRefresh > 10 * 6e4) {
          this.lastEngineRefresh = Date.now();
          await runEngineSerial(["pull", "list", "--cwd", os5.homedir()], { timeoutMs: 5 * 6e4 });
          this.opts.onDownloaded();
        }
        this.engineVersion = await detectEngineVersion(true);
        if (this.engineVersion < 3) {
          await this.refreshEngineStatus();
          this.phase = "idle";
          return;
        }
        log("sync", "the sync engine updated to version 3");
      }
      if (!this.announced) {
        this.announced = true;
        void runEngineSerial(["announce", "--json", "--app-version", this.opts.appVersion]);
      }
      if (!net.isOnline()) {
        this.phase = "offline";
        return;
      }
      this.phase = "checking";
      this.emitStatus();
      const check = await runEngine(["check", "--json"], { timeoutMs: 6e4 });
      if (!check.ok) {
        await this.refreshEngineStatus();
        const since = this.engine?.failingSince ? Date.parse(this.engine.failingSince) : Date.now();
        this.phase = Date.now() - since > ATTENTION_AFTER_MS ? "attention" : "offline";
        if (this.phase === "attention" && this.recent[0]?.kind !== "failed") this.record({ kind: "failed", text: "Upload failed: github.com didn't answer" });
        return;
      }
      const remoteHead = check.json?.remoteHead ?? null;
      if (shouldPull({ remoteHead, lastProcessed: this.heads.get(), changed: check.json?.changed, force, retryAt: this.retryPending ? 0 : this.retryPullAt })) {
        this.phase = "downloading";
        this.emitStatus();
        const args = ["pull-all", "--json"];
        if (!s.keepResumeUpToDate) args.push("--no-local");
        const skip = this.opts.skipIds?.() ?? [];
        if (skip.length) args.push("--skip", skip.join(","));
        const requests = this.retryRequests;
        const pull = await runEngineSerial(args);
        const res = pull.json;
        if (res?.ok) {
          this.retryServed = Math.max(this.retryServed, requests);
          if (remoteHead) this.heads.set(remoteHead);
          this.retryPullAt = res.skippedLive?.length ? Date.now() + RETRY_SKIPPED_MS : null;
          const got = [...res.downloaded ?? [], ...res.updated ?? []];
          if (got.length) {
            const froms = [...new Set(got.map((g) => g.from).filter(Boolean))];
            this.record({ kind: "downloaded", text: `Downloaded ${got.length}${froms.length === 1 ? ` from ${froms[0]}` : ""}` });
          }
          this.opts.onDownloaded();
        } else {
          this.retryServed = Math.max(this.retryServed, requests);
          this.retryPullAt = Date.now() + RETRY_SKIPPED_MS;
        }
      }
      await this.refreshEngineStatus();
      if ((this.engine?.unpushedCommits ?? 0) > 0) {
        this.phase = "uploading";
        this.emitStatus();
        const pp = await runEngineSerial(["push-pending", "--json"]);
        if (pp.ok) this.record({ kind: "uploaded", text: "Uploaded changes made while offline" });
        await this.refreshEngineStatus();
      }
      this.phase = "idle";
    } catch (e) {
      log("sync", `tick failed: ${e.stack || e}`);
      this.phase = "attention";
    } finally {
      this.running = false;
      const visible = this.opts.isWindowVisible();
      const secs = visible ? s.checkWhileOpenSeconds : s.checkFromTraySeconds;
      const next = this.retryPending && this.phase === "idle" ? 2 : this.phase === "offline" ? Math.min(secs, 30) : secs;
      this.schedule(next * 1e3);
    }
  }
  /** Called by the app after it uploads an edit, so the status reflects it at once. */
  noteEdit(text, queued) {
    this.record({ kind: queued ? "saved" : "edit", text });
    void this.refreshEngineStatus().then(() => this.emitStatus());
  }
  status() {
    const s = settings.get();
    const devices2 = this.opts.devices();
    const behind = devices2.filter((d) => d.status === "old-sync");
    const total = devices2.length;
    const current = total - behind.length;
    const e = this.engine;
    const lastSync = [e?.lastFetchAt, e?.lastPushAt, e?.lastCheckAt].filter(Boolean).sort().pop() ?? null;
    const pending2 = e ? this.opts.pendingUploads(e.sessions || {}) + (e.unpushedCommits || 0) : 0;
    const paused = !s.syncAutomatically;
    let headline;
    let detail;
    const time = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
    if (this.phase === "not-set-up") {
      headline = "Sync is not set up";
      detail = "Run the installer on this PC";
    } else if (paused) {
      headline = "Sync paused";
      detail = lastSync ? `Last synced ${time(lastSync)}` : "Resume in the sync menu";
    } else if (this.phase === "offline") {
      headline = "Offline";
      detail = lastSync ? `Last synced ${time(lastSync)}` : "Saved on this PC";
    } else if (this.phase === "attention") {
      headline = "Can't reach GitHub";
      detail = "Retrying \xB7 saved on this PC";
    } else if (this.phase === "downloading" || this.phase === "uploading" || this.phase === "checking") {
      headline = total > 1 && behind.length ? `${current} of ${total} PCs up to date` : this.phase === "checking" ? "Up to date" : "Syncing\u2026";
      detail = this.phase === "checking" ? lastSync ? `Last synced ${time(lastSync)}` : "Checking GitHub" : this.phase === "downloading" ? "Downloading\u2026" : "Uploading\u2026";
    } else if (behind.length) {
      headline = `${current} of ${total} PCs up to date`;
      detail = behind.length === 1 ? `${behind[0].name} needs the new sync` : `${behind.length} PCs need the new sync`;
    } else {
      headline = total > 1 ? `All ${total} PCs up to date` : "Up to date";
      detail = lastSync ? `Last synced ${time(lastSync)}` : "Up to date";
    }
    return {
      phase: paused ? "paused" : this.phase,
      machine: e?.machine ?? thisMachine(),
      headline,
      detail,
      lastSyncAt: lastSync,
      nextCheckInMs: this.nextAt ? Math.max(0, this.nextAt - Date.now()) : null,
      pendingUploads: pending2,
      failingSince: e?.failingSince ?? null,
      // git's messages can quote the remote, login included: never shown.
      lastError: stripUrlCredentials(e?.lastError?.message ?? null),
      repoSizeBytes: this.repoSize,
      repoWebUrl: stripUrlCredentials(e?.webUrl ?? null),
      uploadQuietSeconds: typeof e?.uploadQuietSeconds === "number" ? e.uploadQuietSeconds : null,
      cloudSyncedClaudeDir: typeof e?.cloudSyncedClaudeDir === "string" && e.cloudSyncedClaudeDir ? e.cloudSyncedClaudeDir : null,
      devices: devices2,
      recent: this.recent,
      paused
    };
  }
  emitStatus() {
    this.emit("status", this.status());
  }
  /** Settings > Sync > Upload after a reply. The hooks read it from the engine's config. */
  async setUploadQuiet(seconds) {
    if (![60, 120, 300].includes(seconds)) return { ok: false, err: "Choose 1, 2 or 5 minutes" };
    const r = await runEngineSerial(["config", "--json", "--set", `uploadQuietSeconds=${seconds}`], { timeoutMs: 3e4 });
    if (!r.json?.ok) return { ok: false, err: r.json?.err ?? "Couldn't change the setting" };
    await this.refreshEngineStatus();
    this.emitStatus();
    return { ok: true };
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
};

// src/main/claude.ts
import fs11 from "node:fs";
import os6 from "node:os";
import path9 from "node:path";
import { spawn as spawn4 } from "node:child_process";
var KEEP_MS = 6e4;
var cached = null;
var refreshing = null;
function run2(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    let child;
    try {
      child = spawn4(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      done();
    }, timeoutMs);
    child.stdout?.on("data", (d) => out += d);
    child.on("error", done);
    child.on("close", done);
  });
}
function knownCandidates() {
  const out = [];
  if (process.env.CONVERSATIONS_CLAUDE_PATH) out.push(process.env.CONVERSATIONS_CLAUDE_PATH);
  const home = os6.homedir();
  const appData = process.env.APPDATA || path9.join(home, "AppData", "Roaming");
  const local3 = process.env.LOCALAPPDATA || path9.join(home, "AppData", "Local");
  out.push(path9.join(home, ".local", "bin", "claude.exe"));
  out.push(path9.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  out.push(path9.join(local3, "Programs", "claude", "claude.exe"));
  return out;
}
async function pathCandidates() {
  const out = [];
  const where = await run2("where.exe", ["claude"], 1e4);
  for (const line of where.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (line.toLowerCase().endsWith(".exe")) out.push(line);
    else if (line.toLowerCase().endsWith(".cmd")) {
      try {
        const m = fs11.readFileSync(line, "utf8").match(/"%dp0%\\([^"]+\.exe)"/i);
        if (m) out.push(path9.join(path9.dirname(line), m[1]));
      } catch {
      }
    }
  }
  return out;
}
var isFile = (p) => {
  try {
    return fs11.statSync(p).isFile();
  } catch {
    return false;
  }
};
function signedInNow() {
  try {
    if (fs11.existsSync(path9.join(claudeDir(), ".credentials.json"))) return true;
    const record = process.env.CLAUDE_CONFIG_DIR ? path9.join(claudeDir(), ".claude.json") : path9.join(os6.homedir(), ".claude.json");
    const cfg = JSON.parse(fs11.readFileSync(record, "utf8"));
    return !!cfg?.oauthAccount;
  } catch {
    return null;
  }
}
function claudeInstall() {
  if (cached) return cached.value;
  const exe = knownCandidates().find(isFile) ?? null;
  return { found: !!exe, path: exe, version: null, signedIn: signedInNow() };
}
function refreshClaude(force = false) {
  if (!force && cached && Date.now() - cached.at < KEEP_MS) return Promise.resolve(cached.value);
  refreshing ??= (async () => {
    let exe = knownCandidates().find(isFile) ?? null;
    if (!exe) exe = (await pathCandidates()).find(isFile) ?? null;
    const version = exe ? (await run2(exe, ["--version"], 15e3)).match(/(\d+\.\d+\.\d+)/)?.[1] ?? null : null;
    const value = { found: !!exe, path: exe, version, signedIn: signedInNow() };
    cached = { at: Date.now(), value };
    return value;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
function claudeDefaultModel() {
  try {
    const s = JSON.parse(fs11.readFileSync(path9.join(claudeDir(), "settings.json"), "utf8"));
    return typeof s?.model === "string" && s.model.trim() ? s.model.trim() : null;
  } catch {
    return null;
  }
}
var terminal = null;
function hasWindowsTerminal() {
  if (terminal !== null) return terminal;
  const alias = path9.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "wt.exe");
  if (fs11.existsSync(alias)) return terminal = true;
  void run2("where.exe", ["wt"], 1e4).then((out) => terminal = out.trim().length > 0);
  return false;
}

// src/main/windows.ts
import fs12 from "node:fs";
import path10 from "node:path";
import { BrowserWindow, nativeTheme, screen, shell } from "electron";
var LIGHT = { window: "#f3f3f6", content: "#ffffff", symbols: "#1d1d1f" };
var DARK = { window: "#18181a", content: "#1e1e1e", symbols: "#f5f5f7" };
var themeColors = () => nativeTheme.shouldUseDarkColors ? DARK : LIGHT;
function boundsFile() {
  return path10.join(appDataDir(), "window.json");
}
function savedBounds() {
  try {
    const v = JSON.parse(fs12.readFileSync(boundsFile(), "utf8"));
    const area = screen.getDisplayMatching(v.bounds).workArea;
    if (v.bounds.x < area.x - 50 || v.bounds.y < area.y - 50 || v.bounds.x > area.x + area.width - 100) return { maximized: v.maximized };
    return v;
  } catch {
    return {};
  }
}
function loadPage(win, files2, hash) {
  if (files2.page.startsWith("http")) void win.loadURL(`${files2.page}#${hash}`);
  else void win.loadFile(files2.page, { hash });
}
function lockDown(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}
function createMainWindow(files2, { show }) {
  const saved = savedBounds();
  const c = themeColors();
  const useMica = settings.get().windowMaterial === "mica";
  const win = new BrowserWindow({
    width: saved.bounds?.width ?? 1440,
    height: saved.bounds?.height ?? 900,
    x: saved.bounds?.x,
    y: saved.bounds?.y,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Conversations",
    icon: files2.icon,
    backgroundColor: useMica ? "#00000000" : c.window,
    backgroundMaterial: useMica ? "mica" : "none",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: c.content, symbolColor: c.symbols, height: 52 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: files2.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: ["--window-kind=main"]
    }
  });
  lockDown(win);
  loadPage(win, files2, "/");
  if (saved.maximized) win.maximize();
  win.once("ready-to-show", () => {
    if (show) win.show();
  });
  const persist = () => {
    try {
      fs12.writeFileSync(boundsFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {
    }
  };
  win.on("resized", persist);
  win.on("moved", persist);
  win.on("maximize", persist);
  win.on("unmaximize", persist);
  return win;
}
function setTitleBarColors(win, colors) {
  const c = themeColors();
  try {
    win.setTitleBarOverlay({ color: colors?.background ?? c.content, symbolColor: colors?.symbols ?? c.symbols, height: 52 });
  } catch {
  }
}
function createSettingsWindow(files2, parent, section) {
  const c = themeColors();
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Settings",
    icon: files2.icon,
    backgroundColor: c.window,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: c.content, symbolColor: c.symbols, height: 52 },
    autoHideMenuBar: true,
    webPreferences: { preload: files2.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--window-kind=settings"] }
  });
  lockDown(win);
  loadPage(win, files2, `/settings/${section ?? "general"}`);
  win.once("ready-to-show", () => {
    if (parent && !parent.isDestroyed()) {
      const p = parent.getBounds();
      win.setPosition(Math.round(p.x + (p.width - 860) / 2), Math.round(p.y + (p.height - 640) / 2));
    }
    win.show();
  });
  return win;
}
function createWelcomeWindow(files2) {
  const c = themeColors();
  const win = new BrowserWindow({
    width: 560,
    height: 643,
    useContentSize: true,
    show: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    title: "Welcome to Conversations",
    icon: files2.icon,
    backgroundColor: c.content,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    webPreferences: { preload: files2.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--window-kind=welcome"] }
  });
  lockDown(win);
  loadPage(win, files2, "/welcome");
  win.once("ready-to-show", () => win.show());
  return win;
}
function createFlyout(files2) {
  const win = new BrowserWindow({
    width: 380,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    backgroundColor: "#00000000",
    backgroundMaterial: "acrylic",
    webPreferences: { preload: files2.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--window-kind=flyout"] }
  });
  lockDown(win);
  loadPage(win, files2, "/flyout");
  win.on("blur", () => win.hide());
  return win;
}
function placeFlyout(win, trayBounds, height) {
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const area = display.workArea;
  const width = 380;
  const h = Math.min(height, area.height - 24);
  const x = Math.min(area.x + area.width - width - 12, Math.max(area.x + 12, trayBounds.x + trayBounds.width / 2 - width / 2));
  const y = area.y + area.height - h - 12;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width, height: Math.round(h) });
}

// src/main/cli.ts
import fs15 from "node:fs";
import { spawn as spawn6 } from "node:child_process";
import { dialog } from "electron";

// src/main/launch.ts
var PS_SINGLE_QUOTES = /['‘’‚‛]/g;
var psQuote = (s) => `'${s.replace(PS_SINGLE_QUOTES, (q) => q + q)}'`;
var encodePowerShell = (script) => Buffer.from(script, "utf16le").toString("base64");
function terminalCommand(folder, exe, args, useWt) {
  if (useWt && ![folder, exe, ...args].some((a) => a.includes(";"))) return { file: "wt.exe", args: ["-d", folder, exe, ...args] };
  const script = `Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(folder)}${args.length ? ` -ArgumentList ${args.map(psQuote).join(",")}` : ""}`;
  return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)] };
}
function focusScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("not a process id");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Add-Type -Namespace ConvFocus -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'`,
    `$id = ${pid}`,
    "for ($i = 0; $i -lt 8 -and $id; $i++) {",
    "  $p = Get-Process -Id $id",
    "  if ($p -and $p.MainWindowHandle -ne 0) {",
    "    $h = $p.MainWindowHandle",
    "    if ([ConvFocus.W]::IsIconic($h)) { [void][ConvFocus.W]::ShowWindowAsync($h, 9) }",
    "    [void][ConvFocus.W]::SetForegroundWindow($h)",
    "    break",
    "  }",
    '  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ParentProcessId',
    "}"
  ].join("\n");
}

// src/main/handover.ts
var OPEN_ON_THIS_PC = "It's open in Claude Code on this PC \u2014 switch to that window.";
var WRITTEN_JUST_NOW = "It was written to on this PC in the last two minutes. If Claude Code has it open, switch to that window; otherwise try again in a moment.";
var NOT_HERE = "That conversation isn't on this PC yet, and it couldn't be downloaded.";
var NO_FOLDER = "Claude Code keeps this conversation under a folder that isn't on this PC, so it can't be continued here.";
var CONTINUING = "Continuing in Windows Terminal";
var EXIT_WAIT_MS = 5e3;
var OWN_WRITE_SLACK_MS = 15e3;
async function handOver(id, where, deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const refuse = (procs) => {
    deps.focus(procs[0].pid);
    return { ok: false, message: OPEN_ON_THIS_PC };
  };
  const open = await deps.terminals(id);
  if (open?.length) return refuse(open);
  await deps.stopAppSession(id);
  for (const t0 = now(); ; ) {
    const procs = await deps.processes(id);
    if (!procs?.length) break;
    if (now() - t0 >= EXIT_WAIT_MS) return refuse(procs);
    await sleep(150);
  }
  const preferred = where.recordedCwd ?? where.projectFolder;
  const pulled = preferred ? await deps.pull(id, preferred) : null;
  if (pulled?.live) {
    const procs = await deps.processes(id);
    if (procs?.length) return refuse(procs);
    const local3 = deps.localTranscript(id);
    const mtime = local3 ? deps.mtimeOf(local3) : null;
    const ours = deps.appLastWriteAt(id);
    if (!(ours > 0 && mtime !== null && mtime <= ours + OWN_WRITE_SLACK_MS)) return { ok: false, message: WRITTEN_JUST_NOW };
  }
  const transcript = (pulled?.ok ? pulled.dest : null) ?? deps.localTranscript(id);
  if (!transcript) return { ok: false, message: pulled && !pulled.ok && !pulled.live && pulled.err ? `Couldn't bring it to this PC: ${pulled.err}` : NOT_HERE };
  const folder = deps.folderFor(transcript, [where.recordedCwd, where.projectFolder]);
  if (!folder) return { ok: false, message: NO_FOLDER };
  deps.launch(folder, id);
  return { ok: true, message: CONTINUING, folder };
}

// src/main/resume-folder.ts
import fs13 from "node:fs";
import path11 from "node:path";
function encodeCwd(cwd) {
  return path11.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}
function cwdMatchesFolder(cwd, folderName) {
  const enc = encodeCwd(cwd).toLowerCase();
  const name = folderName.toLowerCase();
  return enc === name || enc.length > 200 && name.startsWith(enc.slice(0, 200));
}
var isDir = (p) => {
  try {
    return fs13.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
function recordedCwds(transcript, bytes = 256 * 1024) {
  let text = "";
  try {
    const fd = fs13.openSync(transcript, "r");
    try {
      const buf = Buffer.alloc(bytes);
      text = buf.toString("utf8", 0, fs13.readSync(fd, buf, 0, bytes, 0));
    } finally {
      fs13.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const c = JSON.parse(`"${m[1]}"`);
      if (typeof c === "string" && c && !out.includes(c)) out.push(c);
    } catch {
    }
  }
  return out;
}
function folderForTranscript(transcript, candidates, exists2 = isDir) {
  const name = path11.basename(path11.dirname(transcript));
  const fits = (c) => !!c && cwdMatchesFolder(c, name) && exists2(c);
  for (const c of candidates) if (fits(c)) return c;
  for (const c of recordedCwds(transcript)) if (fits(c)) return c;
  return null;
}

// src/main/chat/terminals.ts
import fs14 from "node:fs";
import os7 from "node:os";
import path12 from "node:path";
import { spawn as spawn5 } from "node:child_process";
function thisPidDomain() {
  return `${process.platform}:${os7.hostname().toLowerCase()}`;
}
function registryDir() {
  return path12.join(claudeDir(), "sessions");
}
var str = (v) => typeof v === "string" ? v : null;
function readRegistry2(dir = registryDir()) {
  let names;
  try {
    names = fs14.readdirSync(dir);
  } catch {
    return null;
  }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const v = JSON.parse(fs14.readFileSync(path12.join(dir, n), "utf8"));
      if (typeof v?.pid !== "number" || typeof v?.sessionId !== "string") continue;
      out.push({ pid: v.pid, sessionId: v.sessionId, cwd: str(v.cwd), kind: str(v.kind), entrypoint: str(v.entrypoint), pidDomain: str(v.pidDomain), status: str(v.status) });
    } catch {
    }
  }
  return out;
}
function isTerminalEntry(e, domain = thisPidDomain()) {
  if (!e.pidDomain || e.pidDomain.toLowerCase() !== domain.toLowerCase()) return false;
  if (e.entrypoint?.startsWith("sdk")) return false;
  return e.kind ? e.kind === "interactive" : e.entrypoint === "cli";
}
var probeProcess = async (pid) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return null;
  }
  if (process.platform !== "win32") return "?";
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn5("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      done("?");
    }, 5e3);
    child.stdout.on("data", (d) => out += d);
    child.on("error", () => done("?"));
    child.on("close", () => {
      const m = out.match(/^"([^"]+)","(\d+)"/m);
      done(m && Number(m[2]) === pid ? m[1] : null);
    });
  });
};
var isClaude = (image) => image === "?" || !!image && /^claude(\.exe)?$/i.test(image);
async function openTerminalSessions(opts = {}) {
  const entries = readRegistry2(opts.dir);
  if (!entries) return null;
  const domain = opts.domain ?? thisPidDomain();
  const probe = opts.probe ?? probeProcess;
  const open = /* @__PURE__ */ new Set();
  for (const e of entries) {
    if (opts.only && e.sessionId !== opts.only) continue;
    if (open.has(e.sessionId) || !isTerminalEntry(e, domain)) continue;
    if (isClaude(await probe(e.pid))) open.add(e.sessionId);
  }
  return open;
}
async function isOpenInTerminal(id, opts = {}) {
  const open = await openTerminalSessions({ ...opts, only: id });
  return open === null ? null : open.has(id);
}
async function sessionProcesses(id, opts = {}) {
  const entries = readRegistry2(opts.dir);
  if (!entries) return null;
  const domain = opts.domain ?? thisPidDomain();
  const probe = opts.probe ?? probeProcess;
  const out = [];
  for (const e of entries) {
    if (e.sessionId.toLowerCase() !== id.toLowerCase()) continue;
    const here = !e.pidDomain || e.pidDomain.toLowerCase() === domain.toLowerCase();
    if (!(opts.anyKind ? here : isTerminalEntry(e, domain))) continue;
    if (isClaude(await probe(e.pid))) out.push(e);
  }
  return out;
}

// src/main/cli.ts
async function chooseFolder(win, projectLabel) {
  const opts = { title: `Where is ${projectLabel} on this PC?`, properties: ["openDirectory"], buttonLabel: "Use this folder" };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}
function launchInTerminal(folder, exe, args) {
  const c = terminalCommand(folder, exe, args, hasWindowsTerminal());
  const child = spawn6(c.file, c.args, { cwd: folder, detached: true, stdio: "ignore", windowsHide: c.file !== "wt.exe" });
  child.on("error", (e) => log("cli", `could not start ${c.file}: ${e.message}`));
  child.unref();
}
function focusProcessWindow(pid) {
  if (process.platform !== "win32") return;
  let script;
  try {
    script = focusScript(pid);
  } catch {
    return;
  }
  const child = spawn6("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => child.kill(), 15e3);
  child.on("error", () => clearTimeout(timer));
  child.on("close", () => clearTimeout(timer));
}
var isDir2 = (p) => {
  try {
    return !!p && fs15.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
async function pullConversation(id, cwd) {
  if (await detectEngineVersion() < 3) return null;
  const r = await runEngineSerial(["pull", id, "--cwd", cwd, "--json"], { timeoutMs: 5 * 6e4 });
  if (r.json?.code === "live") return { ok: false, live: true };
  if (r.json?.ok && r.json.dest) return { ok: true, dest: r.json.dest };
  const err = r.json?.err ?? r.stderr.split(/\r?\n/).find((l) => l.trim()) ?? null;
  log("cli", `pull of ${id.slice(0, 8)} failed: ${err ?? `exit ${r.code}`}`);
  return { ok: false, err };
}
async function openInCli(args) {
  const claude = await refreshClaude();
  if (!claude.found || !claude.path) return { ok: false, message: "Claude Code isn't installed on this PC" };
  const exe = process.env.CONVERSATIONS_CLAUDE_LAUNCHER || claude.path;
  let projectFolder = isDir2(args.folder) ? args.folder : null;
  const recordedCwd = isDir2(args.recordedCwd) ? args.recordedCwd : null;
  if (!projectFolder && !recordedCwd) {
    projectFolder = await chooseFolder(args.win, args.projectLabel);
    if (!projectFolder) return { ok: false, message: "Open in CLI needs the project's folder" };
    settings.set({ folders: { ...settings.get().folders, [args.projectId]: projectFolder } });
  }
  try {
    const r = await handOver(
      args.id,
      { projectFolder, recordedCwd },
      {
        terminals: (id) => sessionProcesses(id),
        processes: (id) => sessionProcesses(id, { anyKind: true }),
        stopAppSession: args.stopAppSession,
        pull: pullConversation,
        localTranscript: args.localTranscript,
        appLastWriteAt: args.appLastWriteAt,
        mtimeOf: (f) => {
          try {
            return fs15.statSync(f).mtimeMs;
          } catch {
            return null;
          }
        },
        folderFor: (t, c) => folderForTranscript(t, c),
        launch: (folder, id) => launchInTerminal(folder, exe, ["--resume", id]),
        focus: focusProcessWindow
      }
    );
    if (!r.ok) log("cli", `Open in CLI for ${args.id.slice(0, 8)} refused: ${r.message}`);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return { ok: false, message: `Couldn't start Windows Terminal: ${e.message}` };
  }
}
async function newChatInCli(folder) {
  const claude = await refreshClaude();
  if (!claude.found || !claude.path) return { ok: false, message: "Claude Code isn't installed on this PC" };
  launchInTerminal(folder, process.env.CONVERSATIONS_CLAUDE_LAUNCHER || claude.path, []);
  return { ok: true, message: "Claude Code started in Windows Terminal" };
}

// src/main/chat/manager.ts
import { EventEmitter as EventEmitter5 } from "node:events";
import fs20 from "node:fs";

// src/main/chat/mcp.ts
import os8 from "node:os";

// src/main/chat/sdk.ts
import crypto from "node:crypto";
import fs16 from "node:fs";
import path13 from "node:path";
import { pathToFileURL } from "node:url";
var PKG = path13.join("node_modules", "@anthropic-ai", "claude-agent-sdk");
var mod = null;
var loadedFrom = null;
var hasSdk = (dir) => fs16.existsSync(path13.join(dir, "package.json")) && fs16.existsSync(path13.join(dir, "sdk.mjs"));
function sdkCandidates(installDir, resourcesDir = null) {
  const out = [];
  if (process.env.CONVERSATIONS_SDK_DIR) out.push(process.env.CONVERSATIONS_SDK_DIR);
  if (installDir && !resourcesDir) out.push(path13.join(installDir, PKG));
  const appDir = appRepoDir();
  const root = `${appDir}-runtime`;
  try {
    const lock = fs16.readFileSync(path13.join(appDir, "_app", "runtime", "package-lock.json"));
    const hash = crypto.createHash("sha256").update(lock).digest("hex").slice(0, 12);
    if (fs16.existsSync(path13.join(root, hash, ".ready"))) out.push(path13.join(root, hash, PKG));
  } catch {
  }
  try {
    const dirs = fs16.readdirSync(root).map((n) => path13.join(root, n)).filter((d) => fs16.existsSync(path13.join(d, ".ready"))).sort((a, b) => fs16.statSync(b).mtimeMs - fs16.statSync(a).mtimeMs);
    for (const d of dirs) out.push(path13.join(d, PKG));
  } catch {
  }
  if (resourcesDir) out.push(path13.join(resourcesDir, "sdk", PKG));
  if (installDir) out.push(path13.join(installDir, PKG));
  return [...new Set(out)];
}
async function loadSdk(installDir, resourcesDir = null) {
  if (mod) return { ok: true, from: loadedFrom };
  let lastErr = "Claude's Agent SDK isn't installed on this PC";
  for (const dir of sdkCandidates(installDir, resourcesDir)) {
    if (!hasSdk(dir)) continue;
    try {
      mod = await import(pathToFileURL(path13.join(dir, "sdk.mjs")).href);
      loadedFrom = dir;
      return { ok: true, from: dir };
    } catch (e) {
      lastErr = `${dir}: ${e.message}`;
    }
  }
  return { ok: false, from: null, err: lastErr };
}
var sdkLoadedFrom = () => loadedFrom;
var query = ((...args) => {
  if (!mod) throw new Error("Claude's Agent SDK isn't installed on this PC yet: the app installs it with its next update, or reinstall Conversations");
  return mod.query(...args);
});

// src/main/chat/mcp.ts
var STATUSES = /* @__PURE__ */ new Set(["connected", "failed", "needs-auth", "pending", "disabled"]);
function toMcpInfo(list) {
  const order = { failed: 0, "needs-auth": 1, pending: 2, connected: 3, disabled: 4 };
  return list.filter((s) => s && typeof s.name === "string" && s.name).map((s) => ({
    name: s.name,
    status: STATUSES.has(s.status) ? s.status : "failed",
    scope: s.source ?? s.scope ?? null,
    toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
    error: typeof s.error === "string" && s.error.trim() ? s.error.trim().slice(0, 400) : null
  })).sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
}
async function* nothing() {
  await new Promise(() => {
  });
}
async function probeMcp(claudePath, cwd, waitMs = 8e3) {
  const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const q = query({ prompt: nothing(), options: { cwd: cwd || os8.homedir(), pathToClaudeCodeExecutable: claudePath, settingSources: ["user", "project", "local"], extraArgs: { chrome: null }, env } });
  const timer = setTimeout(() => q.close(), waitMs + 2e4);
  try {
    const t0 = Date.now();
    let list = toMcpInfo(await q.mcpServerStatus());
    while (list.some((s) => s.status === "pending") && Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 500));
      list = toMcpInfo(await q.mcpServerStatus());
    }
    return list;
  } catch (e) {
    log("chat", `mcp status for ${cwd}: ${e.message}`);
    throw e;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

// src/main/chat/models.ts
import fs17 from "node:fs";
import os9 from "node:os";
import path14 from "node:path";
var MAX_AGE_MS = 12 * 60 * 60 * 1e3;
var file2 = () => path14.join(appDataDir(), "models.json");
function toChoices(list) {
  return list.filter((m) => m.value && m.displayName).map((m) => ({
    value: m.value,
    label: m.displayName,
    hint: m.description ?? "",
    current: !m.value.startsWith("claude-"),
    efforts: m.supportsEffort ? m.supportedEffortLevels ?? [] : []
  }));
}
function toCommands(list) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const c of [...list].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin))) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "", builtin: !!c.builtin, aliases: c.aliases ?? [] });
  }
  return out.sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
}
var COMMANDS_MAX_AGE_MS = 10 * 60 * 1e3;
var commandCache = /* @__PURE__ */ new Map();
var commandProbes = /* @__PURE__ */ new Map();
function rememberCommands(cwd, list) {
  if (list.length) commandCache.set(cwd.toLowerCase(), { at: Date.now(), list });
}
async function commandsFor(claudePath, cwd) {
  const key = cwd.toLowerCase();
  const hit = commandCache.get(key);
  if (hit && Date.now() - hit.at < COMMANDS_MAX_AGE_MS) return hit.list;
  if (!claudePath) return hit?.list ?? [];
  let probe = commandProbes.get(key);
  if (!probe) {
    probe = (async () => {
      const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
      delete env.ELECTRON_RUN_AS_NODE;
      const q = query({ prompt: nothing2(), options: { cwd, pathToClaudeCodeExecutable: claudePath, settingSources: ["user", "project", "local"], env } });
      const timer = setTimeout(() => q.close(), 3e4);
      try {
        const list = toCommands(await q.supportedCommands());
        rememberCommands(cwd, list);
        return list;
      } catch (e) {
        log("chat", `commands for ${cwd}: ${e.message}`);
        return hit?.list ?? [];
      } finally {
        clearTimeout(timer);
        q.close();
        commandProbes.delete(key);
      }
    })();
    commandProbes.set(key, probe);
  }
  return probe;
}
var cache = null;
var refreshing2 = null;
function load() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs17.readFileSync(file2(), "utf8"));
    if (Array.isArray(v.models)) cache = { at: Number(v.at) || 0, models: v.models };
  } catch {
  }
  return cache;
}
function remember(models) {
  if (!models.length) return;
  cache = { at: Date.now(), models };
  try {
    fs17.writeFileSync(file2(), JSON.stringify(cache));
  } catch {
  }
}
function knownModels(claudePath) {
  const c = load();
  if (claudePath && (!c || Date.now() - c.at > MAX_AGE_MS)) void refresh(claudePath);
  return c?.models ?? [];
}
async function* nothing2() {
  await new Promise(() => {
  });
}
function refresh(claudePath) {
  refreshing2 ??= (async () => {
    const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const q = query({ prompt: nothing2(), options: { cwd: os9.homedir(), pathToClaudeCodeExecutable: claudePath, settingSources: ["user"], env } });
    const timer = setTimeout(() => q.close(), 3e4);
    try {
      remember(toChoices(await q.supportedModels()));
    } catch (e) {
      log("chat", `model list: ${e.message}`);
    } finally {
      clearTimeout(timer);
      q.close();
      refreshing2 = null;
    }
  })();
  return refreshing2;
}

// src/main/chat/session.ts
import fs18 from "node:fs";
import path16 from "node:path";
import { EventEmitter as EventEmitter4 } from "node:events";

// src/main/chat/destructive.ts
import path15 from "node:path";
var SAFE = { destructive: false, deletesFiles: false, consequence: null };
function serverName(tool) {
  const s = tool.split("__")[1] ?? tool;
  if (/figma/i.test(s)) return "Figma";
  if (/posthog/i.test(s)) return "PostHog";
  if (/google-ads/i.test(s)) return "Google Ads";
  if (/supabase/i.test(s)) return "Supabase";
  if (/chrome/i.test(s)) return "Chrome";
  if (/linear/i.test(s)) return "Linear";
  return s.replace(/^claude_ai_/, "").replace(/[-_]+/g, " ");
}
function splitCommands(line) {
  const out = [];
  const chars = [...line];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === "&" && (/[<>]$/.test(word) || chars[i + 1] === ">")) {
      word += ch;
      inWord = true;
    } else if (";&|\n\r(){}".includes(ch)) endCommand();
    else if (/\s/.test(ch)) endWord();
    else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return out;
}
var commandName = (w) => path15.win32.basename(w).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
var PREFIXES = /* @__PURE__ */ new Set(["sudo", "time", "nohup", "exec", "command", "call", "start", "xargs", "env", "npx", "bunx", "pnpx", "!"]);
var KEYWORDS = /* @__PURE__ */ new Set(["if", "then", "else", "elif", "do", "while", "until", "for", "foreach", "where-object", "foreach-object", "%", "?"]);
var KNOWN = /* @__PURE__ */ new Set(["rm", "unlink", "shred", "rimraf", "del", "erase", "rd", "rmdir", "remove-item", "ri", "clear-content", "clc", "set-content", "out-file", "git", "find", "format", "format-volume", "dd", "robocopy", "reg", "powershell", "pwsh", "cmd", "bash", "sh", "zsh", "wsl", "iex", "invoke-expression"]);
var SQL_CLIENTS = /* @__PURE__ */ new Set(["psql", "pgcli", "sqlite3", "sqlite", "litecli", "sqlite-utils", "mysql", "mariadb", "mycli", "sqlcmd", "osql", "invoke-sqlcmd", "duckdb", "clickhouse", "clickhouse-client", "cockroach", "usql", "bq", "snowsql", "turso", "prisma", "wrangler"]);
var CLOUD_CLIS = { az: "Azure", aws: "AWS", gcloud: "Google Cloud", gsutil: "Google Cloud", vercel: "Vercel", netlify: "Netlify", fly: "Fly.io", flyctl: "Fly.io", heroku: "Heroku", firebase: "Firebase", doctl: "DigitalOcean", railway: "Railway", wrangler: "Cloudflare" };
var CLOUD_VERB = /^(delete|destroy|remove|rm|rb|purge|uninstall|wipe|drop|truncate)$|^(delete|remove|destroy)-|:(destroy|reset|delete|remove)$/;
function shortTarget(t, cwd) {
  const clean = t.replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "");
  if (["", ".", "*", "./*", ".\\*", "*.*"].includes(clean)) return `everything in ${path15.win32.basename(cwd) || cwd}`;
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  const s = parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
  return s.length > 56 ? `${s.slice(0, 26)}\u2026${s.slice(-26)}` : s;
}
function listOf(items) {
  const u = [...new Set(items)];
  if (u.length <= 1) return u[0] ?? "";
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  if (u.length === 3) return `${u[0]}, ${u[1]} and ${u[2]}`;
  return `${u[0]}, ${u[1]} and ${u.length - 2} more`;
}
var newEffects = () => ({ deletes: [], deletesUnnamed: false, sentences: [], permanent: false, maybe: false });
var isRedirect = (w) => /^(\d|\*|&)?[<>]/.test(w);
function plainArgs(args) {
  const out = [];
  let rest = false;
  for (const a of args) {
    if (!rest && a === "--") {
      rest = true;
      continue;
    }
    if (!rest && a.startsWith("-")) continue;
    if (isRedirect(a)) continue;
    out.push(a);
  }
  return out;
}
function psTargets(args) {
  const out = [];
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^-(path|literalpath|lp|pspath)$/i.test(a)) {
      if (args[k + 1] !== void 0) out.push(...list(args[++k]));
      continue;
    }
    const inline = a.match(/^-(path|literalpath|lp):(.+)$/i);
    if (inline) {
      out.push(...list(inline[2]));
      continue;
    }
    if (/^-(include|exclude|filter|erroraction|ea|warningaction|wa|informationaction|ia|credential|stream|errorvariable|ev|outvariable|ov)$/i.test(a)) {
      k++;
      continue;
    }
    if (a.startsWith("-") || isRedirect(a)) continue;
    out.push(...list(a));
  }
  return out;
}
function psFileArg(args) {
  const takesValue = /^-(value|encoding|stream|filter|include|exclude|width|inputobject|erroraction|ea|warningaction|wa|outvariable|ov|errorvariable|ev)$/i;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^-(path|literalpath|lp|pspath|filepath)$/i.test(a)) return args[k + 1] ?? null;
    const inline = a.match(/^-(path|literalpath|lp|filepath):(.+)$/i);
    if (inline) return inline[2];
    if (takesValue.test(a)) {
      k++;
      continue;
    }
    if (a.startsWith("-") || isRedirect(a)) continue;
    return a;
  }
  return null;
}
var cmdTargets = (args) => args.filter((a) => !/^\/[a-z](:.*)?$/i.test(a) && !a.startsWith("-") && !isRedirect(a));
var NULL_DEVICES = /^(\$null|nul:?|\/dev\/null|\\\\\.\\nul)$/i;
function takeRedirects(words) {
  const rest = [];
  const overwrites = [];
  for (let k = 0; k < words.length; k++) {
    const m = words[k].match(/^(\d|\*|&)?(>>?|<)(.*)$/);
    if (!m) {
      rest.push(words[k]);
      continue;
    }
    let target = m[3];
    if (!target && k + 1 < words.length) target = words[++k];
    if (m[2] !== ">" || !target) continue;
    if (target.startsWith("&") || NULL_DEVICES.test(target)) continue;
    overwrites.push(target);
  }
  return { rest, overwrites };
}
function existsHere(target, ctx2) {
  if (!ctx2.exists) return true;
  const t = target.replace(/^["']|["']$/g, "");
  if (/^[$%~/]/.test(t) || /[*?]/.test(t)) return true;
  const absolute = /^[a-z]:[\\/]/i.test(t) || t.startsWith("\\\\");
  if (!absolute && ctx2.movesAround) return true;
  try {
    return ctx2.exists(absolute ? t : path15.win32.resolve(ctx2.cwd, t));
  } catch {
    return true;
  }
}
function decodePowerShell(b64) {
  try {
    return Buffer.from(b64, "base64").toString("utf16le");
  } catch {
    return "";
  }
}
function say(fx, text, permanent = true) {
  if (!fx.sentences.includes(text)) fx.sentences.push(text);
  if (permanent) fx.permanent = true;
  else fx.maybe = true;
}
var nonFlags = (args) => args.filter((a) => !a.startsWith("-") && !isRedirect(a));
function analyse(input, ctx2, fx, depth) {
  const { rest: words, overwrites } = takeRedirects(input);
  for (const t of overwrites) if (existsHere(t, ctx2)) say(fx, `Overwrites ${shortTarget(t, ctx2.cwd)}.`);
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const n = commandName(w);
    if (PREFIXES.has(n)) {
      i++;
      while (i < words.length && words[i].startsWith("-")) i++;
      continue;
    }
    if (KEYWORDS.has(n)) {
      const j = words.findIndex((x, k) => k > i && KNOWN.has(commandName(x)));
      if (j < 0) return;
      i = j;
    }
    break;
  }
  if (i >= words.length) return;
  const cmd = commandName(words[i]);
  const args = words.slice(i + 1);
  const { cwd, folder } = ctx2;
  const recurse = (text) => {
    if (depth < 4) for (const c of splitCommands(text)) analyse(c, ctx2, fx, depth + 1);
  };
  const del = (targets) => {
    if (targets.length) fx.deletes.push(...targets.map((t) => shortTarget(t, cwd)));
    else fx.deletesUnnamed = true;
    fx.permanent = true;
  };
  const overwrite = (target, sentence) => {
    if (!target) return say(fx, sentence("a file"));
    if (existsHere(target, ctx2)) say(fx, sentence(shortTarget(target, cwd)));
  };
  if (CLOUD_CLIS[cmd]) {
    const shown2 = nonFlags(args).slice(0, 4);
    if (shown2.some((a) => CLOUD_VERB.test(a.toLowerCase()))) say(fx, `Runs "${[cmd, ...shown2].join(" ")}", which deletes things in ${CLOUD_CLIS[cmd]}.`);
    if (cmd !== "wrangler") return;
  }
  switch (cmd) {
    case "powershell":
    case "pwsh": {
      const k = args.findIndex((a) => /^-(c|command|ec|encodedcommand|e)$/i.test(a));
      if (k < 0) return;
      if (/^-(ec|encodedcommand|e)$/i.test(args[k])) recurse(decodePowerShell(args[k + 1] ?? ""));
      else recurse(args.slice(k + 1).join(" "));
      return;
    }
    case "cmd": {
      const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
      if (k >= 0) recurse(args.slice(k + 1).join(" "));
      return;
    }
    case "bash":
    case "sh":
    case "zsh":
    case "dash": {
      const k = args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (k >= 0 && args[k + 1]) recurse(args[k + 1]);
      return;
    }
    case "wsl": {
      let k = 0;
      while (k < args.length) {
        const a = args[k];
        if (/^(-d|--distribution|-u|--user|--cd|--shell-type)$/i.test(a)) k += 2;
        else if (/^(-e|--exec|--)$/.test(a)) {
          k++;
          break;
        } else if (a.startsWith("-")) k++;
        else break;
      }
      if (k < args.length && depth < 4) analyse(args.slice(k), ctx2, fx, depth + 1);
      return;
    }
    case "iex":
    case "invoke-expression":
      recurse(args.join(" "));
      return;
    case "rm":
    case "unlink":
    case "shred":
    case "rimraf":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      del(args.some((a) => /^-(recurse|force|path|literalpath)$/i.test(a)) ? psTargets(args) : plainArgs(args));
      return;
    case "del":
    case "erase":
    case "rd":
    case "rmdir":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      del(args.some((a) => /^-(recurse|force|path|literalpath)$/i.test(a)) ? psTargets(args) : cmdTargets(args));
      return;
    case "remove-item":
    case "ri":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      del(psTargets(args));
      return;
    case "clear-content":
    case "clc": {
      const t = psTargets(args).map((x) => shortTarget(x, cwd));
      say(fx, t.length ? `Empties ${listOf(t)}.` : "Empties files.");
      return;
    }
    case "set-content":
      if (args.some((a) => /^-whatif$/i.test(a))) return;
      overwrite(psFileArg(args), (t) => `Replaces the contents of ${t}.`);
      return;
    case "out-file":
      if (args.some((a) => /^-(append|noclobber|whatif)$/i.test(a))) return;
      overwrite(psFileArg(args), (t) => `Overwrites ${t}.`);
      return;
    case "tee":
      if (args.some((a) => /^(-a|--append)$/.test(a))) return;
      for (const t of plainArgs(args)) overwrite(t, (x) => `Overwrites ${x}.`);
      return;
    case "tee-object":
      if (args.some((a) => /^-append$/i.test(a))) return;
      overwrite(psFileArg(args), (t) => `Overwrites ${t}.`);
      return;
    case "format":
      if (args[0] && /^[a-z]:$/i.test(args[0])) say(fx, `Erases the drive ${args[0].toUpperCase()}.`);
      return;
    case "format-volume": {
      const k = args.findIndex((a) => /^-driveletter$/i.test(a));
      const letter = (k >= 0 ? args[k + 1] : nonFlags(args)[0])?.replace(/[:\\]+$/, "");
      say(fx, letter && /^[a-z]$/i.test(letter) ? `Erases the drive ${letter.toUpperCase()}:.` : "Erases a drive.");
      return;
    }
    case "clear-disk":
    case "remove-partition":
    case "initialize-disk":
      say(fx, cmd === "remove-partition" ? "Deletes a disk partition and everything on it." : "Erases a disk.");
      return;
    case "dd": {
      const of = args.find((a) => a.startsWith("of="));
      if (of) say(fx, `Overwrites ${shortTarget(of.slice(3), cwd)}.`);
      return;
    }
    case "robocopy":
      if (args.some((a) => /^\/(mir|purge)$/i.test(a)) && args[0] && args[1]) say(fx, `Deletes files in ${shortTarget(args[1], cwd)} that aren't in ${shortTarget(args[0], cwd)}.`);
      return;
    case "reg": {
      if (args[0]?.toLowerCase() !== "delete") return;
      const key = args.slice(1).find((a) => !a.startsWith("/"));
      const v = args.findIndex((a) => /^\/v$/i.test(a));
      if (v >= 0 && args[v + 1]) say(fx, `Deletes the registry value ${args[v + 1]}${key ? ` in ${key}` : ""}.`);
      else if (args.some((a) => /^\/va$/i.test(a))) say(fx, `Deletes every value in the registry key ${key ?? ""}.`.replace(" .", "."));
      else say(fx, key ? `Deletes the registry key ${key} and everything in it.` : "Deletes a registry key.");
      return;
    }
    case "remove-itemproperty":
    case "rp": {
      const k = args.findIndex((a) => /^-name$/i.test(a));
      const name = k >= 0 ? args[k + 1] : nonFlags(args)[1];
      const where = psTargets(args.filter((_, j) => j !== k && j !== k + 1))[0];
      say(fx, `Deletes the ${name ? `value ${name}` : "values"}${where ? ` in ${where}` : ""}.`);
      return;
    }
    case "sc":
      if (args[0]?.toLowerCase() === "delete" && args[1]) say(fx, `Deletes the Windows service ${args[1]}.`);
      return;
    case "find": {
      const deletes = args.includes("-delete") || args.some((a, k) => /^-exec(dir)?$/.test(a) && /^(rm|del|unlink|shred)$/.test(commandName(args[k + 1] ?? "")));
      if (!deletes) return;
      const dir = args.find((a) => !a.startsWith("-") && a !== "!") ?? ".";
      say(fx, `Deletes the files find matches in ${dir === "." ? folder : shortTarget(dir, cwd)}.`);
      return;
    }
    case "git":
      gitEffects(args, folder, cwd, fx);
      return;
    case "gh":
      ghEffects(args, fx);
      return;
    case "curl": {
      const m = methodOf(args, /^(-X|--request)$/, /^(?:-X|--request=)(.+)$/);
      if (m === "DELETE") say(fx, `Sends a DELETE request to ${urlShown(args)}.`);
      return;
    }
    case "wget": {
      const m = methodOf(args, /^--method$/, /^--method=(.+)$/);
      if (m === "DELETE") say(fx, `Sends a DELETE request to ${urlShown(args)}.`);
      return;
    }
    case "invoke-webrequest":
    case "iwr":
    case "invoke-restmethod":
    case "irm": {
      const m = methodOf(args, /^-method$/i, /^-method:(.+)$/i);
      if (m === "DELETE") say(fx, `Sends a DELETE request to ${urlShown(args)}.`);
      return;
    }
    case "terraform":
    case "tofu":
    case "pulumi": {
      const sub = nonFlags(args)[0]?.toLowerCase();
      const destroy = sub === "destroy" || sub === "apply" && args.some((a) => /^-{1,2}destroy$/.test(a)) || cmd === "pulumi" && sub === "down";
      if (!destroy) return;
      const target = args.find((a) => /^-target=/.test(a))?.slice(8);
      const tool = cmd === "pulumi" ? "Pulumi" : cmd === "tofu" ? "OpenTofu" : "Terraform";
      say(fx, target ? `Destroys ${target}, managed by ${tool}.` : `Destroys everything ${tool} manages for ${folder}.`);
      return;
    }
    case "kubectl":
    case "oc": {
      const pos = nonFlags(args);
      if (pos[0]?.toLowerCase() !== "delete") return;
      const k = args.findIndex((a) => /^(-f|--filename)$/.test(a));
      const file4 = k >= 0 ? args[k + 1] : args.find((a) => /^--filename=/.test(a))?.slice(11);
      const what = file4 ? `what ${shortTarget(file4, cwd)} describes` : pos.slice(1).join(" ") || "resources";
      say(fx, `Deletes ${what}${args.includes("--all") ? " (all of them)" : ""} from the Kubernetes cluster.`);
      return;
    }
    case "helm": {
      const pos = nonFlags(args);
      if (/^(uninstall|delete|del|un)$/i.test(pos[0] ?? "")) say(fx, `Uninstalls the Helm release${pos[1] ? ` ${pos[1]}` : ""} from the Kubernetes cluster.`);
      return;
    }
    case "supabase": {
      const pos = nonFlags(args).map((a) => a.toLowerCase());
      const where = args.includes("--linked") ? "the linked Supabase project's database" : args.some((a) => /^--db-url/.test(a)) ? "that database" : "the local Supabase database";
      if (pos[0] === "db" && pos[1] === "reset") say(fx, `Deletes all data in ${where} and rebuilds it from the migrations.`);
      else if (pos.some((a) => /^(delete|rm|remove|unset|drop)$/.test(a))) say(fx, `Runs "supabase ${pos.slice(0, 3).join(" ")}", which deletes things in Supabase.`);
      return;
    }
    case "docker":
    case "podman":
      dockerEffects(args, cmd, fx);
      return;
    case "docker-compose":
      dockerEffects(["compose", ...args], "docker", fx);
      return;
    default:
      if (cmd.startsWith("mkfs")) {
        const t = plainArgs(args).pop();
        say(fx, t ? `Formats ${t}.` : "Formats a drive.");
      }
  }
}
function methodOf(args, spaced, joined) {
  for (let k = 0; k < args.length; k++) {
    if (spaced.test(args[k]) && args[k + 1]) return args[k + 1].toUpperCase();
    const m = args[k].match(joined);
    if (m) return m[1].toUpperCase();
  }
  return null;
}
function urlShown(args) {
  const k = args.findIndex((a) => /^-uri$/i.test(a));
  const u = (k >= 0 ? args[k + 1] : void 0) ?? args.find((a) => /^https?:\/\//i.test(a));
  if (!u) return "a web address";
  const s = u.replace(/^https?:\/\/([^@/]*@)?/i, "").replace(/\?.*$/, "");
  return s.length > 60 ? `${s.slice(0, 59)}\u2026` : s;
}
function ghEffects(args, fx) {
  const pos = nonFlags(args);
  const sub = pos[0]?.toLowerCase();
  if (sub === "api") {
    const m = methodOf(args, /^(-X|--method)$/, /^(?:-X|--method=)(.+)$/);
    if (m !== "DELETE") return;
    const takesValue = /^(-X|--method|-H|--header|-f|--raw-field|-F|--field|--input|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/;
    let endpoint = null;
    for (let k = args.findIndex((a) => a.toLowerCase() === "api") + 1; k > 0 && k < args.length; k++) {
      if (takesValue.test(args[k])) k++;
      else if (!args[k].startsWith("-")) {
        endpoint = args[k];
        break;
      }
    }
    say(fx, `Sends a DELETE request to GitHub: ${endpoint ?? "an API address"}.`);
    return;
  }
  const verb = pos[1]?.toLowerCase();
  if (sub === "repo" && verb === "delete") return say(fx, pos[2] ? `Deletes the GitHub repository ${pos[2]}.` : "Deletes this GitHub repository.");
  if (verb === "delete" || sub === "extension" && verb === "remove") say(fx, `Deletes the GitHub ${sub}${pos[2] ? ` ${pos[2]}` : ""}.`);
}
function dockerEffects(args, cmd, fx) {
  const pos = nonFlags(args).map((a) => a.toLowerCase());
  const has = (re) => args.some((a) => re.test(a));
  const names = (from) => nonFlags(args).slice(from);
  if (pos[0] === "volume" && (pos[1] === "rm" || pos[1] === "remove")) {
    const v = names(2);
    return say(fx, v.length ? `Deletes the ${cmd === "podman" ? "Podman" : "Docker"} volume${v.length > 1 ? "s" : ""} ${listOf(v)} and the data in ${v.length > 1 ? "them" : "it"}.` : "Deletes Docker volumes and their data.");
  }
  if (pos[0] === "volume" && pos[1] === "prune") return say(fx, `Deletes ${has(/^(-a|--all)$/) ? "all" : "unused"} Docker volumes and their data.`);
  if (pos[0] === "system" && pos[1] === "prune") return say(fx, `Deletes unused Docker containers, networks, images and build cache${has(/^--volumes$/) ? ", and unused volumes with their data" : ""}.`);
  if (pos[0] === "compose" && pos[1] === "down" && has(/^(-v|--volumes)$/)) return say(fx, "Deletes this Compose project's volumes and their data.");
}
function gitEffects(args, folder, cwd, fx) {
  let k = 0;
  while (k < args.length) {
    const a = args[k];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") k += 2;
    else if (a.startsWith("-")) k++;
    else break;
  }
  const sub = (args[k] ?? "").toLowerCase();
  const rest = args.slice(k + 1);
  const has = (re) => rest.some((a) => re.test(a));
  const names = rest.filter((a) => !a.startsWith("-"));
  const changesTo = (paths) => paths.length === 0 || paths.some((p) => [".", "./", ":/", "*"].includes(p)) ? `Discards uncommitted changes in ${folder}.` : `Discards uncommitted changes to ${listOf(paths.map((p) => shortTarget(p, cwd)))}.`;
  switch (sub) {
    case "push": {
      const remote = names[0] ?? "the remote";
      const refs = names.slice(1);
      const deleting = has(/^(--delete|-d)$/) || refs.some((r) => r.startsWith(":"));
      const forcing = has(/^(--force|-f|--force-with-lease(=.*)?|--force-if-includes)$/) || refs.some((r) => r.startsWith("+"));
      const shown2 = refs.map((r) => r.replace(/^[+:]/, "")).filter(Boolean);
      if (has(/^--mirror$/)) say(fx, `Makes ${remote} match this repository exactly, deleting anything else there.`);
      else if (deleting) say(fx, `Deletes ${shown2.length ? listOf(shown2) : "the branch"} on ${remote}.`);
      else if (forcing) say(fx, `Overwrites ${shown2.length ? listOf(shown2) : "the branch"} on ${remote}.`);
      return;
    }
    case "reset":
      if (has(/^--hard$/)) say(fx, `Discards uncommitted changes in ${folder}.`);
      return;
    case "clean":
      if (has(/^(--force|-[a-zA-Z]*f[a-zA-Z]*)$/) && !has(/^(--dry-run|-[a-zA-Z]*n[a-zA-Z]*)$/)) say(fx, `Deletes untracked files in ${folder}${has(/^-[a-zA-Z]*[xX][a-zA-Z]*$/) ? ", including ignored ones" : ""}.`);
      return;
    case "branch":
      if (has(/^-D$/) || has(/^(-d|--delete)$/) && has(/^(-f|--force)$/)) say(fx, names.length ? `Deletes the branch${names.length > 1 ? "es" : ""} ${listOf(names)}, even if not merged.` : "Deletes a branch, even if not merged.");
      return;
    case "checkout": {
      const dd = rest.indexOf("--");
      if (dd >= 0) say(fx, changesTo(rest.slice(dd + 1)));
      else if (has(/^(-f|--force)$/) || names.includes(".")) say(fx, `Discards uncommitted changes in ${folder}.`);
      return;
    }
    case "restore": {
      const staged = has(/^(--staged|-S)$/);
      const worktree = has(/^(--worktree|-W)$/);
      if (staged && !worktree) return;
      const paths = [];
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a === "-s" || a === "--source") j++;
        else if (!a.startsWith("-")) paths.push(a);
      }
      say(fx, changesTo(paths));
      return;
    }
    case "stash":
      if (names[0] === "drop") say(fx, "Deletes a stashed change.");
      else if (names[0] === "clear") say(fx, "Deletes every stashed change.");
      return;
    case "update-ref":
      if (has(/^-d$/)) say(fx, names[0] ? `Deletes the ref ${names[0]}.` : "Deletes a ref.");
      return;
    case "filter-branch":
    case "filter-repo":
      say(fx, "Rewrites this repository's history.");
      return;
  }
}
var SQL_KINDS = "TABLE|DATABASE|SCHEMA|MATERIALIZED\\s+VIEW|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|EXTENSION|POLICY|ROLE|USER|SEQUENCE";
var NAME = '([\\w."`\\[\\]-]+)';
function sqlEffects(text, fx) {
  const name = (s) => s.replace(/["`[\]]/g, "");
  let m;
  const dropCol = new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${NAME}\\s+DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${NAME}`, "gi");
  while (m = dropCol.exec(text)) say(fx, `Deletes the column ${name(m[2])} from ${name(m[1])}.`);
  const drop = new RegExp(`\\bDROP\\s+(${SQL_KINDS})\\s+(?:IF\\s+EXISTS\\s+)?${NAME}`, "gi");
  while (m = drop.exec(text)) {
    const kind = m[1].toLowerCase().replace(/\s+/g, " ");
    say(fx, kind === "table" ? `Deletes the table ${name(m[2])} and all its rows.` : `Deletes the ${kind} ${name(m[2])}.`);
  }
  const trunc = new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?${NAME}`, "gi");
  while (m = trunc.exec(text)) say(fx, `Deletes every row in ${name(m[1])}.`);
  const delFrom = new RegExp(`\\bDELETE\\s+FROM\\s+(?:ONLY\\s+)?${NAME}`, "gi");
  while (m = delFrom.exec(text)) say(fx, `Deletes rows from ${name(m[1])}.`);
  for (const stmt of text.split(";")) {
    const u = stmt.match(new RegExp(`\\bUPDATE\\s+(?:ONLY\\s+)?${NAME}\\s+SET\\b`, "i"));
    if (u && !/\bWHERE\b/i.test(stmt)) say(fx, `Changes every row in ${name(u[1])}.`);
  }
  const alter = new RegExp(`\\bALTER\\s+(TABLE|DATABASE|SCHEMA)\\s+(?:IF\\s+EXISTS\\s+)?${NAME}(?![\\w."\`\\[\\]-]|\\s+DROP\\b)`, "gi");
  while (m = alter.exec(text)) say(fx, `Changes the ${m[1].toLowerCase()} ${name(m[2])}.`, false);
}
function sentenceOf(fx) {
  const parts = [];
  if (fx.deletes.length) parts.push(`Deletes ${listOf(fx.deletes)}.`);
  else if (fx.deletesUnnamed && !fx.sentences.length) parts.push("Deletes the files the command finds.");
  parts.push(...fx.sentences);
  if (!parts.length) return null;
  const shown2 = parts.slice(0, 3);
  if (parts.length > 3) shown2.push(`And ${parts.length - 3} more change${parts.length - 3 === 1 ? "" : "s"}.`);
  shown2.push(fx.permanent || !fx.maybe ? "It can't be undone." : "It may not be possible to undo.");
  return shown2.join(" ");
}
var MOVES = /* @__PURE__ */ new Set(["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location"]);
function classifyCommand(command, cwd, opts = {}) {
  const fx = newEffects();
  const commands = splitCommands(command);
  const ctx2 = { cwd, folder: path15.win32.basename(cwd) || cwd, movesAround: commands.some((c) => MOVES.has(commandName(c[0] ?? ""))), exists: opts.exists };
  for (const words of commands) analyse(words, ctx2, fx, 0);
  if (commands.some((c) => c.some((w) => SQL_CLIENTS.has(commandName(w))))) sqlEffects(command, fx);
  const destructive = fx.deletes.length > 0 || fx.deletesUnnamed || fx.sentences.length > 0;
  if (!destructive) return SAFE;
  return { destructive, deletesFiles: fx.deletes.length > 0 || fx.deletesUnnamed, consequence: sentenceOf(fx) };
}
var MCP_VERBS = /* @__PURE__ */ new Set(["delete", "drop", "remove", "truncate", "destroy", "purge", "wipe", "erase", "reset"]);
function nameWords(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_\-.]+/).filter(Boolean).map((w) => w.toLowerCase());
}
function strings(v, out = [], depth = 0, key = "") {
  if (out.length > 60 || depth > 6) return out;
  if (typeof v === "string") out.push(v.slice(0, 2e4));
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1, key);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, out, depth + 1, k);
  return out;
}
function sqlInputs(toolName, input) {
  if (/sql|query|migration|database|(^|[_\-.])db($|[_\-.])/i.test(toolName.split("__").slice(2).join("__"))) return strings(input);
  const out = [];
  for (const [k, v] of Object.entries(input)) if (/^(sql|query|statements?|migration)$/i.test(k)) strings(v, out);
  return out;
}
function classifyTool(toolName, input, cwd, opts = {}) {
  if (toolName === "Bash" || toolName === "PowerShell") return typeof input.command === "string" ? classifyCommand(input.command, cwd, opts) : SAFE;
  if (!toolName.startsWith("mcp__")) return SAFE;
  const fx = newEffects();
  for (const s of sqlInputs(toolName, input)) sqlEffects(s, fx);
  const words = nameWords(toolName.split("__").slice(2).join("__"));
  const at = words.findIndex((w) => MCP_VERBS.has(w));
  if (at >= 0) {
    fx.sentences.unshift(`Uses ${serverName(toolName)} to ${words.slice(at).join(" ")}.`);
    fx.permanent = true;
  }
  if (!fx.sentences.length) return SAFE;
  return { destructive: true, deletesFiles: false, consequence: sentenceOf(fx) };
}
function destructiveFallback(description) {
  const d = typeof description === "string" ? description.trim().replace(/[.\s]+$/, "") : "";
  return d && /\s/.test(d) ? `${d.charAt(0).toUpperCase()}${d.slice(1)}. It can't be undone.` : "It can't be undone.";
}

// src/main/chat/session.ts
var STREAM_EMIT_MS = 50;
var InputQueue = class {
  items = [];
  wake = null;
  closed = false;
  push(m) {
    this.items.push(m);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (; ; ) {
      while (this.items.length) yield this.items.shift();
      if (this.closed) return;
      await new Promise((r) => this.wake = r);
      this.wake = null;
    }
  }
};
var followLabel = (f) => "shell" in f ? f.label : f.text;
var SHELLS = { Bash: "Bash", PowerShell: "PowerShell" };
var short = (p) => p.replace(/\\/g, "/").split("/").slice(-2).join("/");
function describeActivity(name, input) {
  const s = (k) => typeof input[k] === "string" ? input[k] : "";
  if (name.startsWith("mcp__")) return `Using ${serverName(name)}`;
  switch (name) {
    case "Read":
      return `Reading ${short(s("file_path"))}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${short(s("file_path"))}`;
    case "Write":
      return `Writing ${short(s("file_path"))}`;
    case "Grep":
    case "Glob":
      return "Searching code";
    case "Bash":
    case "PowerShell": {
      const c = s("command").split("\n")[0];
      return c.length <= 40 ? `Running ${c}` : s("description") || "Running a command";
    }
    case "WebFetch":
      return "Reading a web page";
    case "WebSearch":
      return "Searching the web";
    case "Agent":
    case "Task":
      return s("description") ? `Agent: ${s("description")}` : "Running an agent";
    case "TodoWrite":
      return "Updating the to-do list";
    default:
      return `Using ${name}`;
  }
}
var ChatSession = class extends EventEmitter4 {
  constructor(opts) {
    super();
    this.opts = opts;
    this.id = opts.resume ?? null;
    this.cwd = opts.cwd;
    this.status = {
      conversationId: this.id ?? "",
      state: "starting",
      activity: null,
      model: null,
      permissionMode: opts.permissionMode,
      contextPercent: null,
      queued: [],
      error: null,
      permission: null,
      streamingText: "",
      turnTokens: null
    };
  }
  opts;
  id;
  cwd;
  q = null;
  input = new InputQueue();
  pending = /* @__PURE__ */ new Map();
  permissionQueue = [];
  toolNames = /* @__PURE__ */ new Map();
  streamText = "";
  streamTimer = null;
  /**
   * Follow-ups typed while Claude works. Each goes to Claude Code only when the turn
   * before it ends, so Stop can still cancel them. A "!" command's record waits its
   * turn here too, so it lands in the transcript in the order you typed it.
   */
  followUps = [];
  /** Shell records handed over that start no turn; each still reports a result, which is not a turn's end. */
  quietResults = 0;
  /**
   * Of those, the ones handed over before the message now running: Claude Code may
   * merge them into that message, and then they report no result of their own.
   */
  mergeable = 0;
  /** Tokens Claude has written this turn: finished API calls, and the one in progress. */
  turnDone = 0;
  msgTokens = 0;
  ended = false;
  lastActivity = Date.now();
  /** When this session last wrote to its transcript (for the single-writer check). */
  lastWriteAt = 0;
  /** Something has been handed to Claude Code (a message or a command's record). */
  used = false;
  status;
  get alive() {
    return !this.ended;
  }
  get busy() {
    return ["starting", "thinking", "running-tool", "writing", "waiting-approval"].includes(this.status.state);
  }
  set(patch) {
    this.status = { ...this.status, ...patch, conversationId: this.id ?? "" };
    this.lastActivity = Date.now();
    this.emit("status", this.status);
  }
  start(first, attachments = []) {
    this.send(first, attachments);
    this.open();
  }
  /** Starts Claude Code with a "!" command's record and no turn: it waits for your next message. */
  startShell(record) {
    this.handOverShell(record);
    this.set({ state: "idle", activity: null });
    this.open();
  }
  /** Starts Claude Code with nothing to say (for /mcp): its servers connect; it waits for your next message. */
  startIdle() {
    this.set({ state: "idle", activity: null });
    this.open();
  }
  open() {
    const env = { ...process.env, CLAUDE_SYNC_INCLUDE_HEADLESS: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        resume: this.opts.resume,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        pathToClaudeCodeExecutable: this.opts.claudePath,
        permissionMode: this.opts.permissionMode,
        model: this.opts.model ?? void 0,
        effort: this.opts.effort ?? void 0,
        // The same Claude in Chrome integration a terminal session has (`claude --chrome`).
        // When the extension isn't running, the browser tools are simply absent.
        extraArgs: { chrome: null },
        env,
        canUseTool: (toolName, input, o) => this.askPermission(toolName, input, o),
        stderr: (data) => log("claude", data.trim().slice(0, 400))
      }
    });
    void this.pump();
  }
  /** A message from the composer: sent now, or kept in the app's queue until Claude finishes. */
  send(text, attachments = []) {
    if (this.q && this.busy) {
      this.followUps.push({ text, attachments });
      this.set({ queued: this.followUps.map(followLabel) });
      return;
    }
    this.flushRecords();
    this.handOver({ text, attachments });
  }
  /** A "!" command's record: written now, or after the turn in progress, without starting one. */
  appendShell(record, label) {
    if (this.q && this.busy) {
      this.followUps.push({ shell: record, label });
      this.set({ queued: this.followUps.map(followLabel) });
      return;
    }
    this.flushRecords();
    this.handOverShell(record);
  }
  /** Records still queued while no turn runs (a stopped turn that never reported its end): written now, in order. */
  flushRecords() {
    const records = this.followUps.filter((f) => "shell" in f);
    if (!records.length) return;
    this.followUps = this.followUps.filter((f) => !("shell" in f));
    for (const r of records) this.handOverShell(r.shell);
    this.set({ queued: this.followUps.map(followLabel) });
  }
  /** The command and its output, as the CLI's bash mode records them: in the transcript, for Claude's next turn. */
  handOverShell(record) {
    this.used = true;
    for (const content of record) {
      this.quietResults++;
      this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, shouldQuery: false, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    }
    this.lastWriteAt = Date.now();
    this.lastActivity = Date.now();
  }
  /** The next queued item once a turn is over: records go straight in, a message starts the next turn. */
  nextFollowUp() {
    for (let next = this.followUps.shift(); next; next = this.followUps.shift()) {
      if ("shell" in next) {
        this.handOverShell(next.shell);
        this.set({ queued: this.followUps.map(followLabel) });
        continue;
      }
      this.handOver(next);
      return;
    }
  }
  /** Gives one message to Claude Code: its images first, then the text. */
  handOver(item) {
    this.used = true;
    const content = item.attachments.length ? [...item.attachments.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } })), { type: "text", text: item.text }] : item.text;
    const msg = { type: "user", message: { role: "user", content }, parent_tool_use_id: null, priority: "next", timestamp: (/* @__PURE__ */ new Date()).toISOString() };
    this.turnDone = 0;
    this.msgTokens = 0;
    this.mergeable = this.quietResults;
    this.set({ state: "thinking", activity: null, error: null, turnTokens: null, queued: this.followUps.map(followLabel) });
    this.input.push(msg);
  }
  /** The streamed copy of the reply, sent to the window at most STREAM_EMIT_MS apart. */
  queueStreamEmit() {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (this.status.streamingText !== this.streamText) this.set({ streamingText: this.streamText });
    }, STREAM_EMIT_MS);
  }
  clearStream() {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null;
    this.streamText = "";
  }
  async pump() {
    try {
      for await (const m of this.q) this.handle(m);
      this.finish(null);
    } catch (e) {
      this.finish(e);
    }
  }
  finish(err) {
    if (this.ended) return;
    this.ended = true;
    this.clearStream();
    const lostRecords = this.followUps.filter((f) => "shell" in f).length;
    if (lostRecords) log("chat", `session ${this.id} ended with ${lostRecords} command record(s) not yet written`);
    this.followUps = [];
    for (const p of this.pending.values()) p.resolve({ behavior: "deny", message: "The session ended." });
    this.pending.clear();
    if (err) {
      log("chat", `session ${this.id} ended with an error: ${err.message}`);
      this.set({ state: "error", activity: null, permission: null, streamingText: "", queued: [], error: { title: "Claude Code stopped", body: plainError(err.message) } });
    } else this.set({ state: this.status.state === "error" ? "error" : "idle", activity: null, permission: null, streamingText: "", queued: [] });
    this.emit("ended");
  }
  handle(m) {
    this.lastActivity = Date.now();
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          const isNew = !this.id;
          const before = this.id;
          this.id = m.session_id;
          this.set({ model: m.model, permissionMode: m.permissionMode });
          if (isNew) this.emit("created", this.id);
          else if (before && before !== m.session_id) this.emit("rekeyed", before, m.session_id);
        } else if (m.subtype === "commands_changed") {
          rememberCommands(this.cwd, toCommands(m.commands));
        } else if (m.subtype === "api_retry") {
          this.set({ activity: `Anthropic's API is busy \xB7 retrying (${m.attempt} of ${m.max_retries})` });
        } else if (m.subtype === "status" && m.permissionMode) {
          this.set({ permissionMode: m.permissionMode });
        }
        return;
      case "stream_event": {
        const ev = m.event;
        if (ev.type === "content_block_start") {
          const t = ev.content_block?.type;
          if (t === "thinking" || t === "redacted_thinking") this.set({ state: "thinking", activity: null });
          else if (t === "text") this.set({ state: "writing", activity: null });
          else if (t === "tool_use" && ev.content_block?.name) {
            this.toolNames.set(ev.content_block.id ?? "", ev.content_block.name);
            this.set({ state: "running-tool", activity: describeActivity(ev.content_block.name, {}) });
          }
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.streamText += ev.delta.text;
          this.queueStreamEmit();
        } else if (ev.type === "message_start") {
          this.clearStream();
          this.turnDone += this.msgTokens;
          this.msgTokens = 0;
        } else if (ev.type === "message_delta") {
          const out = m.event.usage?.output_tokens;
          if (typeof out === "number") {
            this.msgTokens = out;
            this.set({ turnTokens: this.turnDone + this.msgTokens });
          }
        }
        return;
      }
      case "assistant": {
        this.lastWriteAt = Date.now();
        this.clearStream();
        if (this.status.streamingText) this.set({ streamingText: "" });
        if (m.context_usage?.percentage != null) this.set({ contextPercent: Math.round(m.context_usage.percentage) });
        if (m.error) this.set({ error: { title: assistantErrorTitle(m.error), body: assistantErrorBody(m.error) } });
        const blocks = m.message?.content ?? [];
        const tool = [...blocks].reverse().find((b) => b.type === "tool_use");
        if (tool?.name) this.set({ state: "running-tool", activity: describeActivity(tool.name, tool.input ?? {}) });
        return;
      }
      case "user":
        this.lastWriteAt = Date.now();
        return;
      case "result": {
        this.lastWriteAt = Date.now();
        if (this.quietResults > 0 && m.subtype === "success" && m.num_turns === 0) {
          this.quietResults--;
          if (this.mergeable > 0) this.mergeable--;
          return;
        }
        this.quietResults = Math.max(0, this.quietResults - this.mergeable);
        this.mergeable = 0;
        this.clearStream();
        if (m.subtype === "success") this.set({ state: "idle", activity: null, streamingText: "" });
        else {
          const errors = "errors" in m && Array.isArray(m.errors) ? m.errors.join(" ") : "";
          this.set({ state: "error", activity: null, streamingText: "", error: { title: "Claude stopped before finishing", body: plainError(errors || m.subtype) } });
        }
        this.nextFollowUp();
        void this.refreshContext();
        return;
      }
      default:
        return;
    }
  }
  async refreshContext() {
    try {
      const u = await this.q?.getContextUsage();
      if (u && typeof u.percentage === "number") this.set({ contextPercent: Math.round(u.percentage) });
    } catch {
    }
  }
  // ------------------------------------------------------------ permissions
  askPermission(toolName, input, o) {
    const requestId = o.toolUseID || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const command = typeof input.command === "string" ? input.command : null;
    const verdict = classifyTool(toolName, input, this.cwd, { exists: (p) => fs18.existsSync(p) });
    const destructive = verdict.destructive || !!o.defaultToNo;
    const folder = path16.basename(this.cwd);
    const shell3 = SHELLS[toolName];
    const file4 = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    let title = o.title || `Allow ${o.displayName ?? toolName}?`;
    let what = o.displayName || toolName;
    let body = command;
    if (shell3) title = verdict.deletesFiles ? "Allow a command that permanently deletes files?" : verdict.destructive ? "Allow a command that can't be undone?" : destructive ? "Allow a risky command?" : "Allow Claude to run a command?";
    else if (toolName === "Read" || toolName === "NotebookRead") {
      title = `Allow Claude to read ${short(file4 || "a file")}?`;
      what = "Read file";
      body = file4 || null;
    } else if (toolName === "Grep" || toolName === "Glob") {
      title = `Allow Claude to search ${file4 ? short(file4) : "outside this folder"}?`;
      what = "Search";
      body = [String(input.pattern ?? ""), file4].filter(Boolean).join("\n") || null;
    } else if (toolName === "Write") {
      title = `Allow Claude to write ${short(file4 || "a file")}?`;
      what = "Write file";
      body = file4 || null;
    } else if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      title = `Allow Claude to edit ${short(file4 || "a file")}?`;
      what = "Edit file";
      body = file4 || null;
    } else if (toolName === "WebFetch") {
      const url = String(input.url ?? "");
      title = `Allow Claude to open ${url.replace(/^https?:\/\//, "").split("/")[0] || "a web page"}?`;
      what = "Web page";
      body = url || null;
    } else if (toolName.startsWith("mcp__")) {
      title = `Allow Claude to use ${serverName(toolName)}?`;
      what = serverName(toolName);
      body = `${toolName.split("__")[2] ?? toolName}
${JSON.stringify(input, null, 2).slice(0, 1200)}`;
    }
    const sentence = (t) => typeof t === "string" && /\s/.test(t.trim()) && t.trim().length > 12 && t.trim().length <= 300 ? t.trim() : null;
    const consequence = verdict.consequence ?? (verdict.destructive ? destructiveFallback(input.description) : sentence(input.description) ?? sentence(o.description) ?? (destructive ? "Check it carefully before allowing it." : null));
    const request = {
      requestId,
      conversationId: this.id ?? "",
      toolName,
      title,
      context: [shell3 ?? what, `in ${folder}`, this.opts.machine].join("  \xB7  "),
      body,
      consequence,
      destructive,
      allowAlways: !destructive && !o.suppressAlwaysAllowRule && !!o.suggestions?.length,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return new Promise((resolve) => {
      this.pending.set(requestId, { request, input, suggestions: o.suggestions ?? [], resolve });
      this.permissionQueue.push(requestId);
      o.signal.addEventListener("abort", () => this.respond(requestId, "deny", true));
      this.showNextPermission();
    });
  }
  showNextPermission() {
    const next = this.permissionQueue.find((id) => this.pending.has(id));
    const p = next ? this.pending.get(next) : null;
    this.set({ permission: p?.request ?? null, state: p ? "waiting-approval" : this.status.state === "waiting-approval" ? "running-tool" : this.status.state });
    if (p) this.emit("permission", p.request);
  }
  pendingRequests() {
    return [...this.pending.values()].map((p) => p.request);
  }
  respond(requestId, answer, aborted = false) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    let decision = isDecision(answer) ? answer : "deny";
    if (decision === "allow-always" && (!p.request.allowAlways || p.request.destructive)) {
      log("chat", `"Always allow" was not offered for ${p.request.toolName}; treated as Deny`);
      decision = "deny";
    }
    this.pending.delete(requestId);
    this.permissionQueue = this.permissionQueue.filter((id) => id !== requestId);
    if (decision === "deny") p.resolve({ behavior: "deny", message: aborted ? "Cancelled." : "The user denied this in the Conversations app.", decisionClassification: "user_reject" });
    else
      p.resolve({
        behavior: "allow",
        updatedInput: p.input,
        updatedPermissions: decision === "allow-always" ? p.suggestions : void 0,
        decisionClassification: decision === "allow-always" ? "user_permanent" : "user_temporary"
      });
    this.showNextPermission();
    return true;
  }
  // ------------------------------------------------------------ controls
  async interrupt() {
    this.followUps = this.followUps.filter((f) => "shell" in f);
    this.clearStream();
    this.set({ queued: this.followUps.map(followLabel) });
    try {
      for (const id of [...this.pending.keys()]) this.respond(id, "deny");
      await this.q?.interrupt();
      this.set({ state: "idle", activity: null, streamingText: "", queued: this.followUps.map(followLabel) });
    } catch (e) {
      log("chat", `interrupt failed: ${e.message}`);
    }
  }
  /** Waits (up to `ms`) until the command records handed over are in the transcript, before the session is closed. */
  async settle(ms = 3e3) {
    if (!this.busy) this.flushRecords();
    const t0 = Date.now();
    while (this.quietResults > 0 && !this.ended && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  }
  async setModel(model) {
    try {
      await this.q?.setModel(model);
      this.set({ model });
    } catch (e) {
      log("chat", `setModel failed: ${e.message}`);
    }
  }
  /** A new effort level for the rest of the session, as /effort sets it. */
  async setEffort(level) {
    try {
      await this.q?.applyFlagSettings({ effortLevel: level });
      this.opts.effort = level;
    } catch (e) {
      log("chat", `setEffort failed: ${e.message}`);
    }
  }
  async commands() {
    try {
      const list = toCommands(await this.q?.supportedCommands() ?? []);
      rememberCommands(this.cwd, list);
      return list;
    } catch {
      return [];
    }
  }
  async setPermissionMode(mode) {
    try {
      await this.q?.setPermissionMode(mode);
      this.set({ permissionMode: mode });
    } catch (e) {
      log("chat", `setPermissionMode failed: ${e.message}`);
    }
  }
  /** The MCP servers this session has, as /mcp would list them. */
  async mcpStatus() {
    return toMcpInfo(await this.q?.mcpServerStatus() ?? []);
  }
  /** Reconnects one MCP server in this session (throws with Claude Code's reason when it can't). */
  async mcpReconnect(name) {
    this.lastActivity = Date.now();
    await this.q?.reconnectMcpServer(name);
  }
  /** Turns one MCP server on or off, as /mcp enable and disable do. */
  async mcpToggle(name, enabled) {
    this.lastActivity = Date.now();
    await this.q?.toggleMcpServer(name, enabled);
  }
  async models() {
    try {
      const list = toChoices(await this.q?.supportedModels() ?? []);
      remember(list);
      return list;
    } catch {
      return [];
    }
  }
  close() {
    if (this.ended) return;
    this.input.close();
    try {
      this.q?.close();
    } catch {
    }
    this.finish(null);
  }
};
function assistantErrorTitle(e) {
  return {
    authentication_failed: "Claude Code isn't signed in on this PC",
    rate_limit: "You've reached your usage limit for now",
    overloaded: "Claude stopped before running anything",
    server_error: "Claude stopped before finishing",
    billing_error: "Claude Code can't bill this account"
  }[e] ?? "Claude stopped before finishing";
}
function assistantErrorBody(e) {
  return {
    authentication_failed: "Open a terminal, run claude and sign in, then try again. The conversation is saved up to here.",
    rate_limit: "The conversation is saved up to here. Try again when your limit resets.",
    overloaded: "Anthropic's API was overloaded and Claude Code's automatic retries ran out. The conversation is saved up to here.",
    server_error: "Anthropic's API returned an error. The conversation is saved up to here."
  }[e] ?? "The conversation is saved up to here.";
}
function plainError(msg) {
  const m = msg.trim();
  if (/ENOENT|not found|spawn/i.test(m)) return "Claude Code could not be started on this PC. Check that it is installed, then try again.";
  if (/auth|login|401/i.test(m)) return "Claude Code isn't signed in. Open a terminal, run claude and sign in.";
  return `${m.slice(0, 280)}${m.length > 280 ? "\u2026" : ""} The conversation is saved up to here.`;
}

// src/main/chat/shell.ts
import crypto2 from "node:crypto";
import fs19 from "node:fs";
import os10 from "node:os";
import path17 from "node:path";
import { spawn as spawn7 } from "node:child_process";
var MAX_OUTPUT = 3e4;
var TIME_LIMIT_MS = 10 * 6e4;
var exists = (p) => {
  try {
    return !!p && fs19.statSync(p).isFile();
  } catch {
    return false;
  }
};
function findShell(env = process.env, platform = process.platform) {
  if (platform !== "win32") {
    const sh = env.SHELL && exists(env.SHELL) ? env.SHELL : "/bin/bash";
    return { file: sh, args: (c) => ["-c", c], name: "sh" };
  }
  const candidates = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of (env.PATH ?? env.Path ?? "").split(path17.delimiter)) {
    if (!dir) continue;
    if (exists(path17.join(dir, "git.exe"))) {
      candidates.push(path17.join(dir, "..", "bin", "bash.exe"), path17.join(dir, "bash.exe"));
    }
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path17.join(env.LOCALAPPDATA, "Programs")]) {
    if (root) candidates.push(path17.join(root, "Git", "bin", "bash.exe"));
  }
  const bash = candidates.map((c) => path17.resolve(c)).find(exists);
  if (bash) return { file: bash, args: (c) => ["-c", c], name: "bash" };
  const ps = path17.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (exists(ps)) return { file: ps, args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c], name: "powershell" };
  return null;
}
function clipOutput(s, max = MAX_OUTPUT) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}

\u2026 ${s.length - max} characters not kept \u2026

${s.slice(-half)}`;
}
var OutputKeeper = class {
  head = "";
  tail = "";
  total = 0;
  add(s) {
    this.total += s.length;
    const half = MAX_OUTPUT / 2 - 150;
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (s) this.tail = (this.tail + s).slice(-half);
  }
  /** What was kept, with the number of characters left out (clipOutput's wording). */
  text() {
    const dropped = this.total - this.head.length - this.tail.length;
    return dropped > 0 ? `${this.head}

\u2026 ${dropped} characters not kept \u2026

${this.tail}` : this.head + this.tail;
  }
};
var escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function shellMessages(command, r) {
  let stderr = clipOutput(r.stderr, MAX_OUTPUT - 200);
  if (r.stopped === "you") stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}Stopped in the Conversations app.`;
  if (r.stopped === "timeout") stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}Stopped after ${TIME_LIMIT_MS / 6e4} minutes.`;
  return [`<bash-input>${escapeXml(command)}</bash-input>`, `<bash-stdout>${escapeXml(clipOutput(r.stdout))}</bash-stdout><bash-stderr>${escapeXml(clipOutput(stderr))}</bash-stderr>`];
}
function runQuietly(file4, args) {
  return new Promise((resolve) => {
    try {
      const p = spawn7(file4, args, { windowsHide: true, stdio: "ignore" });
      const t = setTimeout(() => {
        p.kill();
        resolve();
      }, 5e3);
      p.on("error", () => {
        clearTimeout(t);
        resolve();
      });
      p.on("close", () => {
        clearTimeout(t);
        resolve();
      });
    } catch {
      resolve();
    }
  });
}
async function killTree2(child, bashGroup) {
  if (process.platform !== "win32") {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    return;
  }
  let msysPid = "";
  try {
    msysPid = bashGroup ? fs19.readFileSync(bashGroup.pidFile, "utf8").trim() : "";
  } catch {
  }
  if (bashGroup && /^\d+$/.test(msysPid)) {
    await runQuietly(bashGroup.bash, ["-c", `kill -TERM -- -${msysPid} 2>/dev/null; sleep 0.3; kill -KILL -- -${msysPid} 2>/dev/null; true`]);
  }
  if (child.pid && child.exitCode === null) await runQuietly("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
}
function runShell(command, cwd, opts = {}) {
  const shell3 = opts.shell === void 0 ? findShell(opts.env) : opts.shell;
  if (!shell3) {
    return { done: Promise.resolve({ stdout: "", stderr: "No shell was found on this PC (Git for Windows provides the one Claude Code uses).", code: null, stopped: null }), stop: () => {
    } };
  }
  const env = { ...opts.env ?? process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.CHERE_INVOKING = "1";
  let stopped = null;
  let child;
  const bashGroup = shell3.name === "bash" && process.platform === "win32" ? { bash: shell3.file, pidFile: path17.join(os10.tmpdir(), `conversations-shell-${process.pid}-${crypto2.randomUUID()}.pid`) } : null;
  let args = shell3.args(command);
  if (bashGroup) {
    env.CONVERSATIONS_SHELL_COMMAND = command;
    const pidPath = bashGroup.pidFile.replace(/\\/g, "/").replace(/'/g, `'\\''`);
    args = ["-c", `echo $$ > '${pidPath}'; eval "$CONVERSATIONS_SHELL_COMMAND"`];
  }
  try {
    child = spawn7(shell3.file, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch (e) {
    return { done: Promise.resolve({ stdout: "", stderr: e.message, code: null, stopped: null }), stop: () => {
    } };
  }
  const out = new OutputKeeper();
  const err = new OutputKeeper();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => out.add(d));
  child.stderr?.on("data", (d) => err.add(d));
  let finishNow = null;
  let settledFlag = false;
  const end = (why) => {
    stopped ??= why;
    void killTree2(child, bashGroup);
    setTimeout(() => finishNow?.(), 3e3).unref?.();
  };
  const timer = setTimeout(() => end("timeout"), opts.timeoutMs ?? TIME_LIMIT_MS);
  const done = new Promise((resolve) => {
    const finish = (code, extraErr = "") => {
      if (settledFlag) return;
      settledFlag = true;
      clearTimeout(timer);
      if (bashGroup) setTimeout(() => fs19.rm(bashGroup.pidFile, { force: true }, () => {
      }), 1e4).unref?.();
      const errText = err.text();
      resolve({ stdout: out.text(), stderr: extraErr ? `${errText}${errText && !errText.endsWith("\n") ? "\n" : ""}${extraErr}` : errText, code, stopped });
    };
    finishNow = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(child.exitCode);
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
    child.on("exit", () => setTimeout(() => finishNow?.(), 1500).unref?.());
  });
  return { done, stop: () => settledFlag ? void 0 : end("you") };
}
function sweepPidFiles(dir = os10.tmpdir(), olderThanMs = 6e4) {
  try {
    for (const name of fs19.readdirSync(dir)) {
      if (!/^conversations-shell-\d+-[0-9a-f-]{36}\.pid$/.test(name)) continue;
      const f = path17.join(dir, name);
      try {
        if (Date.now() - fs19.statSync(f).mtimeMs > olderThanMs) fs19.rmSync(f, { force: true });
      } catch {
      }
    }
  } catch {
  }
}

// src/main/chat/manager.ts
var OPEN_IN_TERMINAL = "This conversation is open in a terminal on this PC. Carry on there, or close it first.";
var STILL_STARTING = "Claude Code is still starting for this conversation. Send it again in a moment.";
var STOPPED_BEFORE_START = "Stopped before Claude Code started.";
var LIVE_MS2 = 2 * 60 * 1e3;
var IDLE_CLOSE_MS = 15 * 60 * 1e3;
var UNUSED_CLOSE_MS = 2 * 60 * 1e3;
var NEW_CHAT_STARTING = "A new chat is already starting in this folder. Send it again in a moment.";
var SHELL_BUSY = "A command is already running in this conversation. Stop it or wait for it to finish.";
var SHELL_WHILE_WORKING = "Claude is working in this conversation. Run the command when it finishes, or press Stop first.";
var SHELL_RUNNING = "A command is running in this conversation. Send your message when it finishes, or press Stop.";
var draftShellKey = (draftKey) => `shell:${draftKey.toLowerCase()}`;
var shellLabel = (command) => {
  const one = command.trim().split("\n")[0];
  return `! ${one.length > 60 ? `${one.slice(0, 59)}\u2026` : one}`;
};
var ChatManager = class extends EventEmitter5 {
  constructor(deps) {
    super();
    this.deps = deps;
    this.reaper = setInterval(() => {
      for (const [id, s] of this.sessions) {
        if (!s.busy && Date.now() - s.lastActivity > (s.used === false ? UNUSED_CLOSE_MS : IDLE_CLOSE_MS)) {
          s.close();
          this.sessions.delete(id);
        }
      }
    }, 6e4);
    this.reaper.unref?.();
  }
  deps;
  sessions = /* @__PURE__ */ new Map();
  /** Conversations whose Claude Code is starting: registered before any await. */
  starting = /* @__PURE__ */ new Map();
  /**
   * New chats that have no conversation id yet (Claude Code gives one with its
   * first message, up to 60 s in): tracked under a draft id so Stop, release,
   * quit, approvals and the sync skip list all see them, and a second new chat
   * in the same folder waits.
   */
  drafts = /* @__PURE__ */ new Map();
  draftSeq = 0;
  /** When the app last wrote each conversation, kept after its session ends. */
  lastWrites = /* @__PURE__ */ new Map();
  /** /mcp looks in progress, by folder. */
  mcpProbes = /* @__PURE__ */ new Map();
  /** "!" commands running now, by conversation id (or a new chat's draft key). */
  shells = /* @__PURE__ */ new Map();
  reaper;
  isRunning(id) {
    if (this.starting.has(id) || this.shells.has(id)) return true;
    const s = this.sessions.get(id) ?? this.drafts.get(id)?.session;
    return !!s && s.alive && s.busy;
  }
  runningIds() {
    const busy = [...this.sessions].filter(([, s]) => s.alive && s.busy).map(([id]) => id);
    const draftsBusy = [...this.drafts].filter(([, d]) => d.session.alive && d.session.busy).map(([id]) => id);
    return /* @__PURE__ */ new Set([...busy, ...draftsBusy, ...this.starting.keys(), ...this.shells.keys()]);
  }
  /** Conversations the app has a Claude Code session for (running or idle), or is starting one for. Draft ids stand for new chats without an id yet. */
  openIds() {
    const alive = [...this.sessions].filter(([, s]) => s.alive).map(([id]) => id);
    const drafts = [...this.drafts].filter(([, d]) => d.session.alive).map(([id]) => id);
    return /* @__PURE__ */ new Set([...alive, ...drafts, ...this.starting.keys()]);
  }
  /** New chats that are starting (no conversation id yet) in this folder. */
  draftsIn(cwd) {
    const k = cwd.toLowerCase();
    return [...this.drafts].filter(([, d]) => d.session.alive && d.cwd.toLowerCase() === k).map(([id]) => id);
  }
  /** Is the app's own session for it alive (running or idle)? */
  isOpenInApp(id) {
    return this.starting.has(id) || !!this.sessions.get(id)?.alive || !!this.drafts.get(id)?.session.alive;
  }
  /** When the app's own session last wrote this conversation, or ended (0 if it never had one). */
  lastAppWriteAt(id) {
    return Math.max(this.lastWrites.get(id) ?? 0, this.sessions.get(id)?.lastWriteAt ?? 0);
  }
  status(id) {
    return this.shells.get(id)?.status ?? this.starting.get(id)?.status ?? this.sessions.get(id)?.status ?? this.drafts.get(id)?.session.status ?? null;
  }
  /**
   * "!" in the composer: runs the command in the conversation's folder now, then
   * writes it and its output into the conversation the way the CLI's bash mode
   * does. No turn starts; Claude sees it with your next message. A new chat
   * (no id) is started with the record.
   */
  async shell(args) {
    const claudePath = this.deps.claudePath();
    if (!claudePath) return { ok: false, err: "Chat needs Claude Code on this PC" };
    const id = args.id;
    const key = id ?? draftShellKey(args.draftKey ?? args.cwd);
    const refuse = () => {
      if (this.shells.has(key)) return SHELL_BUSY;
      if (id && this.starting.has(id)) return STILL_STARTING;
      if (id && this.isRunning(id)) return SHELL_WHILE_WORKING;
      if (!id && (this.draftsIn(args.cwd).length || this.draftShellIn(args.cwd))) return NEW_CHAT_STARTING;
      return null;
    };
    const early = refuse();
    if (early) return { ok: false, err: early };
    if (id && await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
    const late = refuse();
    if (late) return { ok: false, err: late };
    const live = id ? this.sessions.get(id) : void 0;
    const cwd = live?.alive ? live.cwd : args.cwd;
    const label = shellLabel(args.command);
    const base = live?.alive ? live.status : { conversationId: id ?? "", state: "idle", activity: null, model: null, permissionMode: args.permissionMode ?? "default", contextPercent: null, queued: [], error: null, permission: null, streamingText: "", turnTokens: null };
    const run3 = this.deps.runShell ? this.deps.runShell(args.command, cwd) : runShell(args.command, cwd);
    const entry = { run: run3, cwd: args.cwd, id, cancelled: null, status: { ...base, conversationId: id ?? "", state: "running-tool", activity: `Running ${label}`, error: null } };
    this.shells.set(key, entry);
    if (id) this.emit("status", entry.status);
    const ran = (err) => ({ ok: false, ran: true, err: `The command ran, but what it printed couldn't be added to the conversation: ${err}` });
    try {
      const r = await run3.done;
      if (entry.cancelled) return ran(entry.cancelled);
      const record = shellMessages(args.command, r);
      entry.status = { ...entry.status, activity: "Adding the output to the conversation" };
      if (id) this.emit("status", entry.status);
      const res = id ? await this.deliverShell(id, record, label, args, claudePath, entry) : await this.startNew({ ...args, text: "", shell: record }, claudePath);
      return res.ok ? res : ran(res.err ?? "Claude Code didn't start.");
    } finally {
      this.shells.delete(key);
      if (id) this.emit("status", this.status(id) ?? { ...base, state: "idle", activity: null });
    }
  }
  /** Writes a command's record into a conversation: the open session, one starting now, or one resumed for it. */
  async deliverShell(id, record, label, args, claudePath, entry) {
    const start = this.starting.get(id);
    if (start) await start.done;
    if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
    if (entry.cancelled) return { ok: false, err: entry.cancelled };
    const s = this.sessions.get(id);
    if (s?.alive && s.appendShell) {
      s.appendShell(record, label);
      this.emit("owned", id, s.cwd);
      return { ok: true, conversationId: id };
    }
    if (this.starting.has(id)) return { ok: false, err: STILL_STARTING };
    return this.resume(id, { ...args, text: "", shell: record }, claudePath);
  }
  /** A command running for a new chat (no conversation yet) in this folder. */
  draftShellIn(cwd) {
    const k = cwd.toLowerCase();
    return [...this.shells.values()].some((e) => !e.id && e.cwd.toLowerCase() === k);
  }
  /**
   * The /mcp panel: the running session's servers when the chat is open in the app
   * (they can be reconnected there), otherwise what a chat in its folder would have.
   */
  async mcp(id, cwd, opts = {}) {
    const claudePath = this.deps.claudePath();
    if (!claudePath) throw new Error("Claude Code isn't installed on this PC");
    let note;
    if (id) {
      const live = await this.ensureLive(id, cwd, opts, claudePath);
      if (live.s?.mcpStatus) return { live: true, servers: await this.settledStatus(live.s, live.fresh) };
      note = live.err;
    }
    const k = cwd.toLowerCase();
    let p = this.mcpProbes.get(k);
    if (!p) {
      p = (this.deps.probeMcp ?? probeMcp)(claudePath, cwd).finally(() => this.mcpProbes.delete(k));
      this.mcpProbes.set(k, p);
    }
    return { live: false, servers: await p, note };
  }
  /** The chat's Claude Code, running: the one open now, one starting, or one started now with nothing to send. */
  async ensureLive(id, cwd, opts, claudePath) {
    const open = this.sessions.get(id);
    if (open?.alive) return { s: open };
    const start = this.starting.get(id);
    if (start) await start.done;
    else {
      const r = await this.resume(id, { id, text: "", cwd, idle: true, model: opts.model ?? null, effort: opts.effort ?? null, permissionMode: opts.permissionMode ?? "default" }, claudePath);
      if (!r.ok) return { err: r.err === OPEN_IN_TERMINAL ? "This chat is open in a terminal on this PC: use /mcp there, or close it first." : r.err };
    }
    const s = this.sessions.get(id);
    return s?.alive ? { s, fresh: !start } : { err: "Claude Code didn't start for this chat." };
  }
  /** Right after a start most servers are still connecting: wait a little for them to settle. */
  async settledStatus(s, fresh, waitMs = 1e4) {
    let list = await s.mcpStatus();
    const t0 = Date.now();
    while (fresh && list.some((x) => x.status === "pending") && Date.now() - t0 < waitMs && s.alive) {
      await new Promise((r) => setTimeout(r, 500));
      list = await s.mcpStatus();
    }
    return list;
  }
  /** Reconnect, enable or disable one MCP server in the chat's running session. */
  async mcpAction(id, name, action, cwd = "", opts = {}) {
    let s = this.sessions.get(id);
    if (!s?.alive) {
      const claudePath = this.deps.claudePath();
      if (!claudePath) return { ok: false, err: "Chat needs Claude Code on this PC" };
      const live = await this.ensureLive(id, s?.cwd ?? cwd, opts, claudePath);
      if (!live.s) return { ok: false, err: live.err ?? "Claude Code didn't start for this chat." };
      s = live.s;
    }
    if (!s.mcpReconnect || !s.mcpToggle || !s.mcpStatus) return { ok: false, err: "This chat's Claude Code can't change its servers." };
    try {
      if (action === "reconnect") await s.mcpReconnect(name);
      else await s.mcpToggle(name, action === "enable");
      return { ok: true, servers: await s.mcpStatus() };
    } catch (e) {
      const why = e.message.replace(/\s+/g, " ").trim().slice(0, 300);
      return { ok: false, err: why || `Couldn't ${action} ${name}`, servers: await s.mcpStatus().catch(() => void 0) };
    }
  }
  /** Stop for a command running in a new chat, which has no conversation id to stop by. */
  stopDraftShell(draftKey) {
    this.shells.get(draftShellKey(draftKey))?.run.stop();
  }
  pendingPermissions() {
    return [...this.sessions.values(), ...[...this.drafts.values()].map((d) => d.session)].flatMap((s) => s.pendingRequests());
  }
  /** Is a Claude Code terminal on this PC using it (not this app)? */
  async openInTerminal(id) {
    try {
      const fromRegistry = this.deps.terminalHas ? await this.deps.terminalHas(id) : null;
      if (fromRegistry !== null) return fromRegistry;
    } catch (e) {
      log("chat", `session registry unreadable: ${e.message}`);
    }
    const p = this.deps.localTranscript(id);
    if (!p) return false;
    try {
      const mtime = fs20.statSync(p).mtimeMs;
      const ours = this.sessions.get(id)?.lastWriteAt ?? 0;
      return Date.now() - mtime < LIVE_MS2 && mtime > ours + 3e3;
    } catch {
      return false;
    }
  }
  async send(args) {
    const claudePath = this.deps.claudePath();
    if (!claudePath) return { ok: false, err: "Chat needs Claude Code on this PC" };
    if (!args.id) return this.startNew(args, claudePath);
    const id = args.id;
    if (this.shells.has(id)) return { ok: false, err: SHELL_RUNNING };
    if (this.starting.has(id)) return { ok: false, err: STILL_STARTING };
    if (this.sessions.get(id)?.alive) {
      if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
      const s = this.sessions.get(id);
      if (s?.alive) {
        s.send(args.text, args.attachments ?? []);
        this.emit("owned", id, s.cwd);
        return { ok: true, conversationId: id };
      }
    }
    return this.resume(id, args, claudePath);
  }
  resume(id, args, claudePath) {
    if (this.starting.has(id)) return Promise.resolve({ ok: false, err: STILL_STARTING });
    if (this.sessions.get(id)?.alive) return this.send(args);
    const start = {
      status: {
        conversationId: id,
        state: "starting",
        activity: "Starting Claude Code",
        model: null,
        permissionMode: args.permissionMode ?? "default",
        contextPercent: null,
        queued: [],
        error: null,
        permission: null,
        streamingText: "",
        turnTokens: null
      },
      cancelled: false,
      done: Promise.resolve({ ok: false })
    };
    this.starting.set(id, start);
    this.emit("status", start.status);
    start.done = this.runStart(id, args, claudePath, start);
    return start.done;
  }
  async runStart(id, args, claudePath, start) {
    let started = false;
    try {
      if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
      if (start.cancelled) return { ok: false, err: STOPPED_BEFORE_START };
      let cwd = args.cwd;
      try {
        const prep = await this.deps.syncBeforeResume(id, args.cwd);
        if (prep?.refuse) return { ok: false, err: prep.refuse };
        if (prep?.cwd) cwd = prep.cwd;
      } catch (e) {
        log("chat", `sync before resume failed: ${e.message}`);
      }
      if (start.cancelled) return { ok: false, err: STOPPED_BEFORE_START };
      if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
      if (start.cancelled) return { ok: false, err: STOPPED_BEFORE_START };
      const s = this.create({ resume: id, cwd, claudePath, machine: this.deps.machine(), model: args.model ?? null, permissionMode: args.permissionMode ?? "default", effort: args.effort ?? null });
      this.attach(s);
      this.sessions.set(id, s);
      this.starting.delete(id);
      if (args.shell && s.startShell) s.startShell(args.shell);
      else if (args.idle) s.startIdle?.();
      else s.start(args.text, args.attachments ?? []);
      started = true;
      if (!args.idle) this.emit("owned", id, cwd);
      return { ok: true, conversationId: id };
    } finally {
      if (!started) {
        if (this.starting.get(id) === start) this.starting.delete(id);
        this.emit("status", { ...start.status, state: "idle", activity: null });
        this.emit("changed");
        this.emit("closed", id);
      }
    }
  }
  async startNew(args, claudePath) {
    if (this.draftsIn(args.cwd).length || !args.shell && this.draftShellIn(args.cwd)) return { ok: false, err: NEW_CHAT_STARTING };
    const draftId = `draft:${++this.draftSeq}`;
    const s = this.create({ cwd: args.cwd, claudePath, machine: this.deps.machine(), model: args.model ?? null, permissionMode: args.permissionMode ?? "default", effort: args.effort ?? null });
    this.drafts.set(draftId, { session: s, cwd: args.cwd });
    this.attach(s);
    if (args.shell && s.startShell) s.startShell(args.shell);
    else s.start(args.text, args.attachments ?? []);
    const id = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6e4);
      s.once("created", (newId) => {
        clearTimeout(timer);
        resolve(newId);
      });
      s.once("ended", () => {
        clearTimeout(timer);
        resolve(s.id);
      });
    });
    this.drafts.delete(draftId);
    if (!id || !s.alive) {
      s.close();
      return { ok: false, err: s.status.error?.body ?? "Claude Code didn't start" };
    }
    this.sessions.set(id, s);
    this.emit("created", id, args.cwd);
    this.emit("owned", id, args.cwd);
    return { ok: true, conversationId: id };
  }
  /** The session behind a conversation id or a draft id. */
  sessionFor(id) {
    return this.sessions.get(id) ?? this.drafts.get(id)?.session;
  }
  create(opts) {
    return this.deps.createSession ? this.deps.createSession(opts) : new ChatSession(opts);
  }
  attach(s) {
    s.on("status", (st) => {
      const sh = st.conversationId ? this.shells.get(st.conversationId) : void 0;
      if (sh) {
        sh.status = { ...st, state: "running-tool", activity: sh.status.activity, error: null };
        this.emit("status", sh.status);
      } else this.emit("status", st);
    });
    s.on("permission", (p) => this.emit("permission", p));
    s.on("rekeyed", (before, after) => {
      if (this.sessions.get(before) === s) {
        this.sessions.delete(before);
        this.sessions.set(after, s);
      }
      this.lastWrites.set(before, Date.now());
      this.emit("owned", after, s.cwd);
      this.emit("rekeyed", before, after);
      this.emit("changed");
    });
    s.on("ended", () => {
      if (s.id) this.lastWrites.set(s.id, Math.max(s.lastWriteAt, Date.now()));
      if (s.id && this.sessions.get(s.id) === s && s.status.state !== "error") this.sessions.delete(s.id);
      this.emit("changed");
      if (s.id) this.emit("closed", s.id);
    });
  }
  /** Calls off a start in flight and waits until it has given up. */
  async cancelStart(id) {
    const start = this.starting.get(id);
    if (!start) return false;
    start.cancelled = true;
    await start.done;
    return true;
  }
  /** Stop: interrupts Claude, or calls off a start that hasn't reached Claude Code yet. A new chat without an id yet is closed. */
  async stop(id) {
    const sh = this.shells.get(id);
    if (sh) {
      sh.run.stop();
      return;
    }
    if (await this.cancelStart(id)) return;
    const draft = this.drafts.get(id);
    if (draft) {
      draft.session.close();
      return;
    }
    const s = this.sessions.get(id);
    if (!s) return;
    await s.interrupt();
  }
  /**
   * Ends the app's session entirely (Open in CLI hands the conversation over;
   * delete needs no writer). A start in flight is called off first, so when this
   * returns the app has no session for it and won't start one.
   */
  async release(id, opts = {}) {
    const sh = this.shells.get(id);
    if (sh) {
      sh.cancelled = "it was opened in a terminal, so the command was stopped.";
      sh.run.stop();
      await sh.run.done.catch(() => {
      });
    }
    await this.cancelStart(id);
    if (opts.onlyIdle && this.isRunning(id)) return;
    const s = this.sessionFor(id);
    if (!s) return;
    if (s.busy) await s.interrupt();
    await s.settle?.();
    s.close();
    this.sessions.delete(id);
    this.drafts.delete(id);
  }
  /** Ends every session that isn't working on something (after a sign-in: they start again with it). */
  async releaseIdle() {
    for (const id of [...this.sessions.keys()]) if (!this.isRunning(id)) await this.release(id, { onlyIdle: true });
  }
  respond(requestId, decision) {
    for (const s of this.sessions.values()) if (s.respond(requestId, decision)) return true;
    for (const d of this.drafts.values()) if (d.session.respond(requestId, decision)) return true;
    return false;
  }
  async setModel(id, model) {
    await this.sessions.get(id)?.setModel(model);
  }
  async setEffort(id, level) {
    await this.sessions.get(id)?.setEffort?.(level);
  }
  /** The commands of a live session in that folder when there is one; otherwise asked of Claude Code. */
  async commands(id, cwd) {
    const live = id ? this.sessions.get(id) : void 0;
    if (live?.alive && live.commands) {
      const list = await live.commands();
      if (list.length) return list;
    }
    return commandsFor(this.deps.claudePath(), cwd);
  }
  async setPermissionMode(id, mode) {
    await this.sessions.get(id)?.setPermissionMode(mode);
  }
  /** A live session's list when there is one; otherwise the list kept on disk (refreshed in the background). */
  async models() {
    for (const s of this.sessions.values()) {
      const list = await s.models();
      if (list.length) return list;
    }
    return knownModels(this.deps.claudePath());
  }
  closeAll() {
    clearInterval(this.reaper);
    for (const sh of this.shells.values()) {
      sh.cancelled = "the app was closing.";
      sh.run.stop();
    }
    for (const start of this.starting.values()) start.cancelled = true;
    for (const s of this.sessions.values()) s.close();
    for (const d of this.drafts.values()) d.session.close();
    this.sessions.clear();
    this.drafts.clear();
  }
};

// src/main/chat/usage.ts
import fs21 from "node:fs";
import os11 from "node:os";
import path18 from "node:path";
var file3 = () => path18.join(appDataDir(), "usage.json");
var clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
function meter(key, label, w) {
  if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return null;
  const resetsAt = typeof w.resets_at === "string" && Number.isFinite(Date.parse(w.resets_at)) ? w.resets_at : null;
  return { key, label, percent: clamp(w.utilization), resetsAt };
}
function toPlanUsage(raw, at = Date.now()) {
  if (!raw?.rate_limits_available || !raw.rate_limits) return null;
  const r = raw.rate_limits;
  const meters = [];
  const add = (m) => {
    if (m && !meters.some((x) => x.label.toLowerCase() === m.label.toLowerCase())) meters.push(m);
  };
  add(meter("session", "Current session", r.five_hour));
  add(meter("week", "Weekly \xB7 All models", r.seven_day));
  for (const m of Array.isArray(r.model_scoped) ? r.model_scoped : []) {
    const name = typeof m?.display_name === "string" ? m.display_name.trim() : "";
    if (name) add(meter(`week:${name.toLowerCase()}`, `Weekly \xB7 ${name}`, m));
  }
  add(meter("week:opus", "Weekly \xB7 Opus", r.seven_day_opus));
  add(meter("week:sonnet", "Weekly \xB7 Sonnet", r.seven_day_sonnet));
  return meters.length ? { at, plan: raw.subscription_type ?? null, meters } : null;
}
var last;
var inflight = null;
var lastAskAt = 0;
function lastUsage() {
  if (last === void 0) {
    try {
      const saved = JSON.parse(fs21.readFileSync(file3(), "utf8"));
      last = saved && Array.isArray(saved.meters) && typeof saved.at === "number" ? saved : null;
    } catch {
      last = null;
    }
  }
  return last;
}
async function* nothing3() {
  await new Promise(() => {
  });
}
function refreshUsage(claudePath, minGapMs = 6e4) {
  if (inflight) return inflight;
  if (!claudePath || Date.now() - lastAskAt < minGapMs) return Promise.resolve(lastUsage());
  lastAskAt = Date.now();
  inflight = (async () => {
    const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const q = query({ prompt: nothing3(), options: { cwd: os11.homedir(), pathToClaudeCodeExecutable: claudePath, settingSources: [], env } });
    const timer = setTimeout(() => q.close(), 3e4);
    try {
      const qq = q;
      const ask = qq.usage ?? qq.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof ask !== "function") {
        log("chat", "usage: this Claude Code has no usage call");
        return lastUsage();
      }
      const next = toPlanUsage(await ask.call(q, { skipBehaviors: true }));
      const words = (u) => u ? u.meters.map((m) => `${m.key} ${m.percent}%`).join(", ") : "no plan limits";
      if (words(next) !== words(lastUsage())) log("chat", `usage: ${words(next)}`);
      last = next;
      try {
        if (next) fs21.writeFileSync(file3(), JSON.stringify(next));
        else fs21.rmSync(file3(), { force: true });
      } catch {
      }
      return next;
    } catch (e) {
      log("chat", `usage: ${e.message}`);
      return lastUsage();
    } finally {
      clearTimeout(timer);
      q.close();
      inflight = null;
    }
  })();
  return inflight;
}

// src/main/composer-state.ts
import fs22 from "node:fs";
import path19 from "node:path";
var MAX_KEYS = 400;
var MAX_DRAFT = 1e5;
var RESERVED = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var isComposerKey = (k) => typeof k === "string" && k.length > 0 && k.length <= 600 && !/[\u0000-\u001f]/.test(k) && !RESERVED.has(k);
function cleanPrefs(v) {
  if (!v || typeof v !== "object") return null;
  const o = v;
  const out = {};
  if (isModelName(o.model)) out.model = o.model;
  if (isEffort(o.effort)) out.effort = o.effort;
  if (isPermissionMode(o.mode)) out.mode = o.mode;
  return Object.keys(out).length ? out : null;
}
function put(map, key, value) {
  const next = { ...map };
  delete next[key];
  if (value !== null) next[key] = value;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_KEYS))) delete next[k];
  return next;
}
var ComposerStore = class {
  constructor(file4 = path19.join(appDataDir(), "composer.json")) {
    this.file = file4;
  }
  file;
  state = { drafts: {}, prefs: {} };
  timer = null;
  loaded = false;
  get() {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const raw = JSON.parse(fs22.readFileSync(this.file, "utf8"));
        let drafts = {};
        let prefs = {};
        for (const [k, v] of Object.entries(raw.drafts ?? {})) if (isComposerKey(k) && typeof v === "string" && v) drafts = put(drafts, k, v.slice(0, MAX_DRAFT));
        for (const [k, v] of Object.entries(raw.prefs ?? {})) {
          const p = cleanPrefs(v);
          if (isComposerKey(k) && p) prefs = put(prefs, k, p);
        }
        this.state = { drafts, prefs };
      } catch {
      }
    }
    return this.state;
  }
  /** Applies a change from the window: a draft of "" or null and prefs of null remove the entry. */
  save(patch) {
    if (!patch || typeof patch !== "object") return;
    const p = patch;
    let { drafts, prefs } = this.get();
    if (p.drafts && typeof p.drafts === "object") {
      for (const [k, v] of Object.entries(p.drafts)) {
        if (!isComposerKey(k)) continue;
        drafts = put(drafts, k, typeof v === "string" && v.trim() ? v.slice(0, MAX_DRAFT) : null);
      }
    }
    if (p.prefs && typeof p.prefs === "object") {
      for (const [k, v] of Object.entries(p.prefs)) {
        if (isComposerKey(k)) prefs = put(prefs, k, cleanPrefs(v));
      }
    }
    this.state = { drafts, prefs };
    if (this.closing) this.flush();
    else this.writeSoon();
  }
  /** Set when the app starts quitting: from then on every save is written straight away. */
  closing = false;
  writeSoon() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
    this.timer.unref?.();
  }
  /** Writes now (also on quit, so a draft typed in the last moment is kept). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.loaded) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs22.mkdirSync(path19.dirname(this.file), { recursive: true });
      fs22.writeFileSync(tmp, JSON.stringify(this.state));
      fs22.renameSync(tmp, this.file);
    } catch (e) {
      log("app", `could not save the composer's drafts: ${e.message}`);
      try {
        fs22.rmSync(tmp, { force: true });
      } catch {
      }
    }
  }
};

// src/main/chat/notify.ts
import path20 from "node:path";
import { app, Notification } from "electron";
var PROTOCOL = "conversations";
var xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function registerProtocol() {
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
  else if (process.env.CONVERSATIONS_REGISTER_PROTOCOL === "1") app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path20.resolve(process.argv[1] ?? ".")]);
}
function parseProtocolArgs(argv) {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (!url) return null;
  const m = url.match(/^conversations:\/\/(review|deny)\/([^/?#]+)/);
  return m ? { action: m[1], requestId: decodeURIComponent(m[2]) } : null;
}
var shown = /* @__PURE__ */ new Map();
function notifyApproval(p, conversationTitle, onClick) {
  if (shown.has(p.requestId) || !Notification.isSupported()) return;
  const id = encodeURIComponent(p.requestId);
  const what = p.body ? ` (${p.body.split("\n")[0].slice(0, 80)})` : "";
  const body = `\u201C${conversationTitle}\u201D is waiting for you${what}.`;
  const n = new Notification({
    title: "Claude needs your approval",
    body,
    silent: false,
    toastXml: process.platform === "win32" ? `<toast launch="${PROTOCOL}://review/${id}" activationType="protocol">
  <visual><binding template="ToastGeneric"><text>Claude needs your approval</text><text>${xmlEscape(body)}</text></binding></visual>
  <actions>
    <action content="Review" activationType="protocol" arguments="${PROTOCOL}://review/${id}"/>
    <action content="Deny" activationType="protocol" arguments="${PROTOCOL}://deny/${id}"/>
  </actions>
</toast>` : void 0
  });
  n.on("click", onClick);
  n.on("failed", () => {
    if (shown.get(p.requestId) === n) shown.delete(p.requestId);
  });
  n.show();
  shown.set(p.requestId, n);
}
function clearApproval(requestId) {
  const n = shown.get(requestId);
  if (n) {
    try {
      n.close();
    } catch {
    }
    shown.delete(requestId);
  }
}
function pruneApprovals(waiting) {
  for (const id of [...shown.keys()]) if (!waiting.has(id)) clearApproval(id);
}

// src/main/edits-overlay.ts
var EditsOverlay = class {
  pending = /* @__PURE__ */ new Map();
  /** Shows an edit at once. Returns what to put back if it fails. */
  apply(id, field, value) {
    const p = this.pending.get(id) ?? {};
    const had = field in p;
    const previous = p[field];
    p[field] = value;
    this.pending.set(id, p);
    return { had, previous };
  }
  /** The engine refused it: the overlay goes back to what it was before this edit. */
  rollback(id, field, before) {
    const p = this.pending.get(id);
    if (!p) return;
    if (before.had) p[field] = before.previous;
    else delete p[field];
    if (Object.keys(p).length === 0) this.pending.delete(id);
  }
  /** The index caught up with GitHub for these conversations: nothing left to overlay. */
  settle(ids) {
    for (const id of ids) this.pending.delete(id);
  }
};

// src/main/startup-queue.ts
var StartupQueue = class {
  constructor(handle2) {
    this.handle = handle2;
  }
  handle;
  done = false;
  queued = [];
  /** Handles the item now, or keeps it until start-up is done. */
  push(item) {
    if (this.done) this.handle(item);
    else this.queued.push(item);
  }
  /** Start-up is done: everything kept so far is handled, in order, and anything later at once. */
  finish() {
    this.done = true;
    for (const item of this.queued.splice(0)) this.handle(item);
  }
  get pending() {
    return this.queued.length;
  }
};

// src/shell/stages.ts
import fs23 from "node:fs";
import path21 from "node:path";
var RUNNING_MARK = "running.json";
var processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
function readRunningMark(root, alive = processAlive) {
  try {
    const m = JSON.parse(fs23.readFileSync(path21.join(root, RUNNING_MARK), "utf8"));
    if (typeof m?.pid !== "number" || typeof m?.stage !== "string") return null;
    return alive(m.pid) ? m : null;
  } catch {
    return null;
  }
}
function writeRunningMark(root, stage, pid = process.pid) {
  fs23.mkdirSync(root, { recursive: true });
  const tmp = path21.join(root, `${RUNNING_MARK}.${pid}.tmp`);
  fs23.writeFileSync(tmp, JSON.stringify({ pid, stage, at: (/* @__PURE__ */ new Date()).toISOString() }));
  fs23.renameSync(tmp, path21.join(root, RUNNING_MARK));
}
function stagesToRemove(root, inUse, alive = processAlive, keepAlso = []) {
  let names;
  try {
    names = fs23.readdirSync(root).filter((d) => {
      try {
        return fs23.statSync(path21.join(root, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const keep = /* @__PURE__ */ new Set([path21.basename(inUse)]);
  const mark = readRunningMark(root, alive);
  if (mark) keep.add(path21.basename(mark.stage));
  for (const k of keepAlso) keep.add(path21.basename(k));
  const older = names.filter((d) => !keep.has(d) && !d.endsWith(".tmp")).map((d) => ({ d, t: fs23.statSync(path21.join(root, d)).mtimeMs })).sort((a, b) => b.t - a.t);
  return older.slice(1).map((o) => path21.join(root, o.d));
}
function cleanStages(root, inUse, alive = processAlive, keepAlso = []) {
  const gone = [];
  for (const p of stagesToRemove(root, inUse, alive, keepAlso)) {
    try {
      fs23.rmSync(p, { recursive: true, force: true });
      gone.push(p);
    } catch {
    }
  }
  return gone;
}

// src/main/auth.ts
import fs24 from "node:fs";
import os12 from "node:os";
import path22 from "node:path";
import { spawn as spawn8 } from "node:child_process";
var cache2 = /* @__PURE__ */ new Map();
var inFlight = /* @__PURE__ */ new Map();
var TTL = 6e4;
var TTL_UNKNOWN = 3e4;
function authEnv(w) {
  const env = { ...baseEnv(), ...workspaceEnv(w) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
function parseAuthStatus(out) {
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    if (typeof j?.loggedIn !== "boolean") return null;
    const email = j.loggedIn && typeof j.email === "string" ? j.email : null;
    return { loggedIn: j.loggedIn, email, key: [j.loggedIn, j.authMethod, j.orgId, email].map((x) => String(x ?? "")).join("|") };
  } catch {
    return null;
  }
}
function authStatus(w, claudePath, fresh = false, timeoutMs = 5e3) {
  const hit = cache2.get(w.id);
  if (!fresh && hit && Date.now() - hit.at < (hit.state ? TTL : TTL_UNKNOWN)) return Promise.resolve(hit.state);
  if (!claudePath) return Promise.resolve(null);
  const running = inFlight.get(w.id);
  if (running) return running;
  const p = new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      cache2.set(w.id, { at: Date.now(), state });
      inFlight.delete(w.id);
      resolve(state);
    };
    try {
      const child = spawn8(claudePath, ["auth", "status", "--json"], { env: authEnv(w), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
      child.stdout.on("data", (d) => out += d);
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        finish(parseAuthStatus(out));
      });
    } catch {
      finish(null);
    }
  });
  inFlight.set(w.id, p);
  return p;
}
function credentialsTime(w) {
  const dir = w.id === "main" ? baseEnv().CLAUDE_CONFIG_DIR || path22.join(os12.homedir(), ".claude") : w.claudeDir;
  try {
    return fs24.statSync(path22.join(dir, ".credentials.json")).mtimeMs;
  } catch {
    return 0;
  }
}
function signInTook(before, now, credsAt) {
  if (!now?.loggedIn) return false;
  if (before.state?.loggedIn) return before.state.key !== now.key;
  return credsAt !== before.credsAt || before.state?.loggedIn === false;
}
var watching = /* @__PURE__ */ new Map();
function watchSignIn(w, claudePath, before, onDone) {
  const me = Symbol(w.id);
  watching.set(w.id, me);
  const until = Date.now() + 10 * 6e4;
  const tick = async () => {
    if (watching.get(w.id) !== me) return;
    if (Date.now() > until) {
      watching.delete(w.id);
      return;
    }
    const credsAt = credentialsTime(w);
    const s = await authStatus(w, claudePath, true);
    if (watching.get(w.id) !== me) return;
    if (s && signInTook(before, s, credsAt)) {
      watching.delete(w.id);
      log("app", `workspace ${w.id} signed in${s.email ? ` as ${s.email}` : ""}`);
      onDone(s);
      return;
    }
    setTimeout(() => void tick(), 3e3).unref?.();
  };
  setTimeout(() => void tick(), 3e3).unref?.();
}

// src/main/main.ts
process.on("uncaughtException", (e) => log("app", `uncaught exception: ${e?.stack || e}`));
process.on("unhandledRejection", (e) => log("app", `unhandled rejection: ${e?.stack || e}`));
var HERE = path23.dirname(fileURLToPath(import.meta.url));
var DIST = path23.resolve(HERE, "..");
var files = {
  preload: path23.join(DIST, "preload", "preload.cjs"),
  page: process.env.CONVERSATIONS_DEV_URL || path23.join(DIST, "renderer", "index.html")
};
var RESOURCES = app2.isPackaged ? process.resourcesPath : path23.resolve(DIST, "..", "resources");
files.icon = path23.join(RESOURCES, "icon.ico");
var APP_VERSION = (() => {
  try {
    return JSON.parse(fs25.readFileSync(path23.join(DIST, "app.json"), "utf8")).version || app2.getVersion();
  } catch {
    return app2.getVersion();
  }
})();
if (process.env.CONVERSATIONS_DATA_DIR) app2.setPath("userData", path23.join(process.env.CONVERSATIONS_DATA_DIR, "electron"));
if (!app2.requestSingleInstanceLock()) {
  app2.quit();
  process.exit(0);
}
app2.setAppUserModelId("com.samcan.conversations");
var mainWin = null;
var settingsWin = null;
var flyout = null;
var tray = null;
var quitting = false;
var index = new IndexService();
var overlay = new EditsOverlay();
var pending = overlay.pending;
function localTranscript(id) {
  if (!index.ready) return null;
  return index.db.prepare("SELECT local_path FROM conversations WHERE id = ?").get(id)?.local_path ?? null;
}
function recordedCwdOnThisPc(id) {
  if (!index.ready) return null;
  const cwd = index.db.prepare("SELECT cwd FROM conversations WHERE id = ?").get(id)?.cwd ?? null;
  try {
    return cwd && fs25.statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}
async function prepareResume(id, projectFolder) {
  const recorded = recordedCwdOnThisPc(id);
  const pulled = await pullConversation(id, recorded ?? projectFolder);
  if (pulled?.live) {
    const procs = await sessionProcesses(id, { anyKind: true });
    if (procs?.length) return { refuse: OPEN_ON_THIS_PC };
  }
  const transcript = (pulled?.ok ? pulled.dest : null) ?? localTranscript(id);
  if (!transcript) return { refuse: NOT_HERE };
  const folder = folderForTranscript(transcript, [recorded, projectFolder]);
  return folder ? { cwd: folder } : { refuse: NO_FOLDER };
}
var chat = new ChatManager({
  claudePath: () => claudeInstall().path,
  machine: () => thisMachine(),
  localTranscript,
  syncBeforeResume: prepareResume,
  terminalHas: (id) => isOpenInTerminal(id)
});
var ownedFile = () => path23.join(appDataDir(), "app-owned.json");
var ownedMarked = null;
var ownedMarking = /* @__PURE__ */ new Set();
async function markAppOwned(id) {
  if (!ownedMarked) {
    try {
      const v = JSON.parse(fs25.readFileSync(ownedFile(), "utf8"));
      ownedMarked = new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    } catch {
      ownedMarked = /* @__PURE__ */ new Set();
    }
  }
  if (ownedMarked.has(id) || ownedMarking.has(id)) return;
  if (await detectEngineVersion() < 3) return;
  ownedMarking.add(id);
  try {
    const r = await runEngineSerial(["edit", "--json", "--ops", JSON.stringify([{ session: id, field: "app", value: true }])]);
    if (r.ok && !r.json?.nothing) {
      ownedMarked.add(id);
      const tmp = `${ownedFile()}.${process.pid}.tmp`;
      fs25.writeFileSync(tmp, JSON.stringify([...ownedMarked]));
      fs25.renameSync(tmp, ownedFile());
    } else log("chat", `couldn't mark ${id.slice(0, 8)} as an app conversation: ${r.json?.nothing ? "the sync engine doesn't know the field yet" : r.stderr.split("\n")[0]}`);
  } catch (e) {
    log("chat", `marking ${id.slice(0, 8)} failed: ${e.message}`);
  } finally {
    ownedMarking.delete(id);
  }
}
function quickWrite(what, fn, retries = 2) {
  if (!index.ready) return;
  const db = index.db;
  const before = db.prepare("PRAGMA busy_timeout").get()?.timeout ?? 4e3;
  try {
    db.exec("PRAGMA busy_timeout = 150");
    fn();
  } catch (e) {
    if (retries > 0 && /busy|locked/i.test(e.message)) setTimeout(() => quickWrite(what, fn, retries - 1), 1e3);
    else log("index", `${what} failed: ${e.message}`);
  } finally {
    db.exec(`PRAGMA busy_timeout = ${Number(before) || 4e3}`);
  }
}
var scheduler;
var ctx = () => ({ thisMachine: thisMachine(), now: Date.now(), running: chat.runningIds(), pending });
var devices = () => index.ready ? deviceSummaries(index.db, ctx(), readDevices(repoDir())) : [];
var folders2 = () => ({ ...inferredFolders(), ...readSyncConfig()?.folders ?? {}, ...settings.get().folders });
var inferred = null;
function inferredFolders() {
  if (inferred && Date.now() - inferred.at < 6e4) return inferred.map;
  const map = {};
  if (index.ready) {
    const rows = index.db.prepare("SELECT project_id AS p, cwd, COUNT(*) AS n, MAX(last_at) AS last FROM conversations WHERE item_count >= 0 AND cwd IS NOT NULL AND local_path IS NOT NULL GROUP BY project_id, cwd ORDER BY n DESC, last DESC").all();
    for (const r of rows) {
      if (map[r.p]) continue;
      try {
        if (fs25.statSync(r.cwd).isDirectory()) map[r.p] = r.cwd;
      } catch {
      }
    }
  }
  inferred = { at: Date.now(), map };
  return map;
}
var composer = new ComposerStore();
var shownId = null;
function liveConversationIds() {
  const ids = /* @__PURE__ */ new Set();
  const domain = thisPidDomain();
  for (const e of readRegistry2() ?? []) if (!e.pidDomain || e.pidDomain === domain) ids.add(e.sessionId);
  for (const id of chat.openIds?.() ?? []) ids.add(id);
  if (shownId) ids.add(shownId);
  return [...ids];
}
function broadcast(event, payload) {
  for (const w of BrowserWindow2.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`event:${event}`, payload);
}
async function updateUsage(minGapMs = 6e4) {
  const before = lastUsage();
  const u = await refreshUsage(claudeInstall().path, minGapMs);
  if (u !== before) broadcast("usage", u);
  return u;
}
var welcomeWin = null;
function showWelcome() {
  welcomeWin = createWelcomeWindow(files);
  welcomeWin.on("closed", () => {
    welcomeWin = null;
    if (!settings.get().welcomed) settings.set({ welcomed: true });
    showMain();
  });
}
function ensureMain(show) {
  if (!mainWin || mainWin.isDestroyed()) mainWin = makeMain(show);
  return mainWin;
}
function showMain() {
  if (welcomeWin && !welcomeWin.isDestroyed()) {
    welcomeWin.focus();
    return;
  }
  const w = ensureMain(true);
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  scheduler?.nudge();
}
function makeMain(show) {
  const w = createMainWindow(files, { show });
  w.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  const state = () => broadcast("window-state", { maximized: w.isMaximized(), focused: w.isFocused() });
  w.on("maximize", state);
  w.on("unmaximize", state);
  w.on("focus", () => {
    state();
    scheduler?.nudge();
    void updateUsage(2 * 6e4);
  });
  w.on("blur", state);
  return w;
}
function appIcon(name) {
  const p = path23.join(RESOURCES, name);
  return fs25.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}
function toggleFlyout() {
  if (!tray) return;
  flyout ??= createFlyout(files);
  if (flyout.isVisible()) {
    flyout.hide();
    return;
  }
  placeFlyout(flyout, tray.getBounds(), 420);
  flyout.show();
  flyout.focus();
}
function trayMenuTemplate(paused) {
  return [
    ...updateReady ? [{ label: `Restart to update to ${updateReady}`, click: () => restartForUpdate() }, { type: "separator" }] : [],
    { label: "Open Conversations", click: showMain },
    { label: "Sync now", click: () => void scheduler.syncNow() },
    { label: "Pause sync", type: "checkbox", checked: paused, click: (item) => scheduler.setPaused(item.checked) },
    { type: "separator" },
    { label: "Settings", click: () => openSettings() },
    { type: "separator" },
    { label: "Quit Conversations", click: () => quit() }
  ];
}
var trayPaused = null;
var trayUpdate = null;
function refreshTrayMenu() {
  if (!tray) return;
  const paused = !settings.get().syncAutomatically;
  if (paused === trayPaused && updateReady === trayUpdate) return;
  trayPaused = paused;
  trayUpdate = updateReady;
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(paused)));
}
function buildTray() {
  tray = new Tray(appIcon("tray.ico"));
  tray.setToolTip("Conversations");
  tray.on("click", toggleFlyout);
  tray.on("double-click", showMain);
  refreshTrayMenu();
}
function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = createSettingsWindow(files, mainWin, section);
  settingsWin.on("closed", () => settingsWin = null);
}
var updateReady = null;
var newer = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
var appRefreshAt = 0;
function refreshAppRepo() {
  if (engineOverridden() && !process.env.CONVERSATIONS_APP_HOME) return;
  if (Date.now() - appRefreshAt < 10 * 6e4) return;
  appRefreshAt = Date.now();
  const child = spawn9(process.execPath, [engineScriptPath(), "app", "--json"], { env: { ...baseEnv(), ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore" });
  child.on("error", (e) => log("app", `could not update the app's repository: ${e.message}`));
  child.on("exit", () => void retrySdk());
}
var sdkTriedAt = 0;
async function retrySdk() {
  if (sdkLoadedFrom() || Date.now() - sdkTriedAt < 3e4) return;
  sdkTriedAt = Date.now();
  const r = await loadSdk(app2.getAppPath(), app2.isPackaged ? process.resourcesPath : null);
  if (r.ok) log("app", `Agent SDK from ${r.from}`);
}
function checkForUpdate() {
  refreshAppRepo();
  void retrySdk();
  const source = fs25.existsSync(path23.join(appRepoDir(), ".git")) ? appRepoDir() : baseRepoDir();
  execFile("git", ["-C", source, "show", "HEAD:_app/dist/app.json"], { windowsHide: true, timeout: 2e4 }, (err, stdout) => {
    if (err) return;
    try {
      const v = String(JSON.parse(stdout).version || "");
      if (v && newer(v, APP_VERSION) && v !== updateReady) {
        updateReady = v;
        log("app", `version ${v} is ready; it loads at the next start`);
        refreshTrayMenu();
        broadcast("update-ready", v);
      }
    } catch {
    }
  });
}
function restartForUpdate() {
  markRelaunch();
  if (!process.env.CONVERSATIONS_TEST_NO_RELAUNCH) app2.relaunch({ args: process.argv.slice(1).filter((a) => a !== "--hidden") });
  quit();
}
function quit() {
  quitting = true;
  chat.closeAll();
  scheduler?.stop();
  index.stop();
  app2.quit();
}
function applySettings(s, patch) {
  if ("syncAutomatically" in patch) refreshTrayMenu();
  if ("theme" in patch) nativeTheme2.themeSource = s.theme;
  if ("startAtLogin" in patch && app2.isPackaged) app2.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ["--hidden"] });
  if ("theme" in patch) {
    for (const w of [mainWin, settingsWin]) if (w && !w.isDestroyed()) setTitleBarColors(w);
  }
  broadcast("settings-changed", s);
}
async function appInfo() {
  const claude = await refreshClaude();
  const cfg = readSyncConfig();
  return {
    version: APP_VERSION,
    machine: thisMachine(),
    platform: process.platform,
    claude: { found: claude.found, version: claude.version, path: claude.path, signedIn: claude.signedIn, defaultModel: claudeDefaultModel() },
    syncSetUp: !!cfg?.remote,
    // Shown in Settings: never the login a remote URL can carry.
    repo: displayRemote(cfg?.remote),
    firstRun: !settings.get().welcomed,
    windowsTerminal: hasWindowsTerminal()
  };
}
var EDIT_TEXT = {
  pinned: (v) => v ? "Pinned" : "Unpinned",
  title: () => "Renamed",
  archived: (v) => v ? "Archived" : "Unarchived",
  deleted: (v) => v ? "Deleted" : "Restored"
};
async function applyEdit(id, field, value) {
  if (field === "deleted" && value === true) {
    if (chat.isRunning(id)) return { ok: false, err: "Claude is still working in this conversation. Stop it first, then delete it." };
    if (await chat.openInTerminal(id)) return { ok: false, err: "This conversation is open in a terminal on this PC. Close it there first, then delete it." };
    if (chat.isOpenInApp(id)) await chat.release(id);
  }
  const before = overlay.apply(id, field, value);
  broadcast("index-changed", [id]);
  if (await detectEngineVersion() < 3) return { ok: true, queued: true, err: "Saved on this PC; the sync engine on this PC needs its update to share it" };
  const r = await runEngineSerial(["edit", "--json", "--ops", JSON.stringify([{ session: id, field, value }])]);
  if (!r.ok) {
    overlay.rollback(id, field, before);
    broadcast("index-changed", [id]);
    return { ok: false, err: r.json?.err ?? r.stderr.split("\n")[0] ?? "The change couldn't be saved" };
  }
  const queued = !!r.json?.queued;
  scheduler.noteEdit(`${EDIT_TEXT[field](value)} a conversation${queued ? " on this PC" : ""}`, queued);
  index.scan("edit");
  return { ok: true, queued, err: r.json?.err };
}
function handle(channel, fn) {
  ipcMain.handle(channel, (_e, ...args) => fn(...args));
}
var BAD_ID = "That conversation id isn't valid";
function isUsableFolder(p) {
  try {
    return path23.isAbsolute(p) && fs25.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
var IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
var MAX_IMAGES = 10;
function validAttachments(raw) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return null;
  const types = new Set(Object.values(IMAGE_TYPES));
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== "object" || typeof a.data !== "string" || typeof a.mediaType !== "string" || !types.has(a.mediaType)) return null;
    if (a.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/=]+$/.test(a.data)) return null;
    out.push({ name: String(a.name ?? "image").slice(0, 200), mediaType: a.mediaType, data: a.data });
  }
  return out;
}
var isProjectId = (v) => typeof v === "string" && v.length > 0 && v.length <= 400;
function registerIpc() {
  handle("app:info", appInfo);
  handle("app:openExternal", (url) => typeof url === "string" && /^https?:\/\//.test(url) ? shell2.openExternal(url) : void 0);
  handle("app:openPath", (p) => {
    try {
      if (typeof p === "string" && path23.isAbsolute(p) && fs25.statSync(p).isDirectory()) return shell2.openPath(p);
    } catch {
    }
    return "Only folders can be opened";
  });
  handle("app:updateReady", () => updateReady);
  handle("app:restart", () => restartForUpdate());
  handle("workspace:list", async () => {
    const r = workspacesForWindow();
    const all = listWorkspaces().workspaces;
    const claudePath = claudeInstall().path ?? null;
    const workspaces = await Promise.all(
      r.workspaces.map(async (info) => {
        const w = all.find((x) => x.id === info.id);
        if (!w || !info.setUp || w.disconnected) return info;
        const s = await authStatus(w, claudePath);
        return s ? { ...info, signedIn: s.loggedIn, account: s.email } : info;
      })
    );
    return { ...r, workspaces };
  });
  handle("workspace:switch", (id, force) => {
    if (!isWorkspaceId(id) || !workspacesForWindow().workspaces.some((w) => w.id === id && w.setUp)) return { ok: false, err: "That workspace isn't set up on this PC" };
    if (listWorkspaces().workspaces.some((w) => w.id === id && w.disconnected)) return { ok: false, err: "That workspace is disconnected on this PC: reconnect it first" };
    if (id === currentWorkspace().id) return { ok: true };
    const running = chat.runningIds().size;
    if (running && force !== true) return { ok: false, running };
    log("app", `switching to workspace ${id}`);
    prepareSwitch(id);
    restartForUpdate();
    return { ok: true };
  });
  handle("workspace:add", async (input) => {
    const i = input ?? {};
    if (typeof i.name !== "string" || !isRemote(i.remote)) return { ok: false, err: "Give it a name and the repository's address" };
    return setUpWorkspace({ id: isWorkspaceId(i.id) ? i.id : void 0, name: i.name, remote: i.remote });
  });
  handle("workspace:signIn", async (id) => {
    const w = id == null ? currentWorkspace() : listWorkspaces().workspaces.find((x) => x.id === id);
    if (!w) return { ok: false, err: "There's no such workspace" };
    if (!writeLauncher(w)) return { ok: false, err: "Signing in from the app works on Windows only" };
    const launcher = launcherPath(w);
    const claudePath = claudeInstall().path ?? null;
    const credsAt = credentialsTime(w);
    const state = authStatus(w, claudePath, true);
    launchInTerminal(app2.getPath("home"), launcher, ["auth", "login", "--claudeai"]);
    watchSignIn(w, claudePath, { state: await state, credsAt }, (s) => {
      broadcast("workspaces-changed", null);
      broadcast("toast", { text: `${w.name} is signed in${s.email ? ` as ${s.email}` : ""}` });
      if (w.id === currentWorkspace().id) void chat.releaseIdle();
    });
    return { ok: true };
  });
  handle("workspace:disconnect", (id, force) => {
    const all = listWorkspaces().workspaces;
    const target = all.find((w) => w.id === id);
    if (!isWorkspaceId(id) || !target) return { ok: false, err: "There's no such workspace" };
    if (target.disconnected) return { ok: true };
    const forWindow = workspacesForWindow().workspaces;
    const next = all.find((w) => w.id !== id && !w.disconnected && forWindow.some((f) => f.id === w.id && f.setUp));
    if (!next) return { ok: false, err: "Add another workspace first: Conversations needs one to show" };
    if (id === "main" && !fs25.existsSync(path23.join(appRepoDir(), ".git"))) return { ok: false, err: "This PC still gets the app's updates through this workspace: it can be disconnected after its next update" };
    if (id !== currentWorkspace().id) {
      setDisconnected(id, true);
      log("app", `disconnected workspace ${id}`);
      broadcast("workspaces-changed", null);
      return { ok: true };
    }
    const running = chat.runningIds().size;
    if (running && force !== true) return { ok: false, running };
    setDisconnected(id, true);
    log("app", `disconnected workspace ${id}; switching to ${next.id}`);
    prepareSwitch(next.id);
    restartForUpdate();
    return { ok: true, switchedTo: next.name };
  });
  handle("workspace:reconnect", (id) => {
    if (!isWorkspaceId(id) || !listWorkspaces().workspaces.some((w2) => w2.id === id)) return { ok: false, err: "There's no such workspace" };
    setDisconnected(id, false);
    log("app", `reconnected workspace ${id}`);
    broadcast("workspaces-changed", null);
    const w = listWorkspaces().workspaces.find((x) => x.id === id);
    return { ok: true, synced: !!w && fs25.existsSync(path23.join(w.syncHome, "config.json")) };
  });
  handle("workspace:rename", (id, name) => {
    if (!isWorkspaceId(id) || typeof name !== "string" || !name.trim()) return;
    renameWorkspace(id, name.trim().slice(0, 40));
    broadcast("workspaces-changed", null);
    const w = listWorkspaces().workspaces.find((x) => x.id === id);
    if (w && w.remote) void shareWorkspace({ id: w.id, name: w.name, remote: w.remote });
  });
  handle("app:pickFolder", async () => {
    const win = BrowserWindow2.getFocusedWindow() ?? mainWin;
    const opts = { title: "New chat in which folder?", buttonLabel: "Chat here", properties: ["openDirectory"] };
    const r = win ? await dialog2.showOpenDialog(win, opts) : await dialog2.showOpenDialog(opts);
    const p = r.filePaths[0];
    return p && isUsableFolder(p) ? p : null;
  });
  handle("app:pickFiles", async () => {
    const win = BrowserWindow2.getFocusedWindow() ?? mainWin;
    const opts = { title: "Attach", properties: ["openFile", "multiSelections"] };
    const r = win ? await dialog2.showOpenDialog(win, opts) : await dialog2.showOpenDialog(opts);
    const images = [];
    const paths = [];
    for (const p of r.filePaths) {
      const type = IMAGE_TYPES[path23.extname(p).toLowerCase()];
      let size = 0;
      try {
        size = fs25.statSync(p).size;
      } catch {
        continue;
      }
      if (type && size <= MAX_IMAGE_BYTES) images.push({ name: path23.basename(p), mediaType: type, data: fs25.readFileSync(p).toString("base64") });
      else paths.push(p);
    }
    return { images, paths };
  });
  handle("app:showSettings", (section) => openSettings(typeof section === "string" && /^[a-z-]{1,32}$/.test(section) ? section : void 0));
  handle("app:toggleFlyout", () => toggleFlyout());
  handle("app:showMain", (conversationId) => {
    flyout?.hide();
    showMain();
    if (isUuid(conversationId)) mainWin?.webContents.send("event:open-conversation", conversationId);
  });
  handle("app:copyText", (text) => clipboard.writeText(String(text ?? "")));
  handle("app:checkClaude", async () => {
    const c = await refreshClaude(true);
    return { found: c.found, version: c.version, path: c.path, signedIn: c.signedIn, defaultModel: claudeDefaultModel() };
  });
  handle("app:finishWelcome", () => {
    settings.set({ welcomed: true });
    if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close();
  });
  handle("list:sidebar", () => index.ready ? { ...sidebarData(index.db, ctx(), readDevices(repoDir()), folders2()), pcCount: devices().length } : null);
  handle("list:conversations", (q) => index.ready && q && typeof q === "object" ? listConversations(index.db, q, ctx()) : { rows: [], counts: { all: 0, updated: 0, live: 0 } });
  handle("list:detail", (id) => {
    if (!index.ready || !isUuid(id)) return null;
    shownId = id;
    return conversationDetail(index.db, id, ctx(), folders2());
  });
  handle("list:items", (id, before, limit) => {
    if (!index.ready || !isUuid(id)) return { items: [], firstSeq: 0, total: 0 };
    const b = typeof before === "number" && Number.isInteger(before) && before >= 0 ? before : null;
    const n = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 120;
    return itemsPage(index.db, id, b, n);
  });
  handle("list:markSeen", (id) => {
    if (!isUuid(id)) return;
    quickWrite("mark seen", () => markSeen(index.db, id));
    broadcast("index-changed", [id]);
  });
  handle("list:search", (text, opts) => {
    const q = String(text ?? "").slice(0, 500);
    if (!index.ready) return { query: q, hits: [], suggestion: null, searchedConversations: 0, pcCount: 0, tookMs: 0 };
    return search(index.db, q, ctx(), { includeTools: !!opts?.includeTools });
  });
  handle("list:image", (key) => typeof key === "string" && key.length <= 4e3 ? index.image(key) : null);
  handle("edit:apply", (id, field, value) => {
    if (!isUuid(id)) return { ok: false, err: BAD_ID };
    const edit = checkEdit(field, value);
    if (!edit) return { ok: false, err: "That change isn't valid" };
    return applyEdit(id, edit.field, edit.value);
  });
  handle("sync:status", () => scheduler.status());
  handle("sync:now", () => scheduler.syncNow());
  handle("sync:setPaused", (paused) => scheduler.setPaused(paused === true));
  handle("sync:openLog", () => shell2.openPath(path23.join(syncDir(), "sync.log")));
  handle("sync:setUploadQuiet", (seconds) => scheduler.setUploadQuiet(typeof seconds === "number" ? seconds : NaN));
  handle("cli:open", async (id) => {
    if (!isUuid(id)) return { ok: false, message: BAD_ID };
    const d = conversationDetail(index.db, id, ctx(), folders2());
    if (!d) return { ok: false, message: "That conversation isn't on this PC yet" };
    return openInCli({
      id,
      projectId: d.row.projectId,
      projectLabel: d.row.projectLabel,
      folder: d.folder,
      recordedCwd: d.row.cwd,
      win: mainWin,
      stopAppSession: (x) => chat.release(x),
      appLastWriteAt: (x) => chat.lastAppWriteAt(x),
      localTranscript
    });
  });
  handle("cli:newChat", async (projectId) => {
    const pid = isProjectId(projectId) ? projectId : null;
    const f = folders2();
    let folder = pid ? f[pid] : null;
    if (!folder && pid) {
      folder = await chooseFolder(mainWin, pid.split("/").pop() ?? "the project");
      if (folder) settings.set({ folders: { ...settings.get().folders, [pid]: folder } });
    }
    return newChatInCli(folder ?? app2.getPath("home"));
  });
  handle("chat:send", async (rawId, text, opts) => {
    if (rawId !== null && !isUuid(rawId)) return { ok: false, err: BAD_ID };
    const id = rawId;
    const value = String(text ?? "").trim();
    const attachments = validAttachments(opts?.attachments);
    if (attachments === null) return { ok: false, err: "Only PNG, JPEG, GIF or WebP images up to 5 MB can be attached, at most 10 at a time" };
    if (!value && !attachments.length) return { ok: false, err: "Nothing to send" };
    if (value.length > 2e5) return { ok: false, err: "That message is too long to send" };
    let cwd = null;
    if (id) {
      const d = conversationDetail(index.db, id, ctx(), folders2());
      if (!d) return { ok: false, err: "That conversation isn't on this PC yet" };
      cwd = d.folder;
      if (!cwd || !fs25.existsSync(cwd)) {
        cwd = await chooseFolder(mainWin, d.row.projectLabel);
        if (!cwd) return { ok: false, err: "Chat needs the project's folder on this PC" };
        settings.set({ folders: { ...settings.get().folders, [d.row.projectId]: cwd } });
      }
    } else if (typeof opts?.folder === "string" && isUsableFolder(opts.folder)) {
      cwd = opts.folder;
    } else {
      const asked = opts?.projectId;
      const pid = isProjectId(asked) ? asked : null;
      cwd = pid ? folders2()[pid] ?? null : null;
      if (!cwd && pid && pid !== "folder:_home" && !pid.startsWith("folder:")) {
        cwd = await chooseFolder(mainWin, pid.split("/").pop() ?? "the project");
        if (cwd) settings.set({ folders: { ...settings.get().folders, [pid]: cwd } });
      }
      cwd ??= app2.getPath("home");
    }
    const askedMode = opts?.permissionMode;
    const askedModel = opts?.model;
    const mode = isPermissionMode(askedMode) ? askedMode : settings.get().defaultPermissionMode;
    const model = isModelName(askedModel) ? askedModel : settings.get().defaultModel;
    const effort = isEffort(opts?.effort) ? opts.effort : null;
    if (opts?.shell === true) {
      if (!value) return { ok: false, err: "Type a command after the !" };
      if (attachments.length) return { ok: false, err: "Images can't go with a ! command" };
      return chat.shell({ id, text: "", command: value, cwd, model, permissionMode: mode, effort, draftKey: isComposerKey(opts.draftKey) ? opts.draftKey : void 0 });
    }
    return chat.send({ id, text: value || "(image)", cwd, model, permissionMode: mode, effort, attachments });
  });
  handle("chat:stop", (id) => isUuid(id) ? chat.stop(id) : void 0);
  handle("chat:stopShell", (key) => isComposerKey(key) ? chat.stopDraftShell(key) : void 0);
  handle("chat:respond", (requestId, decision) => {
    if (!isRequestId(requestId)) return;
    clearApproval(requestId);
    chat.respond(requestId, isDecision(decision) ? decision : "deny");
    updateTrayBadge();
  });
  handle("chat:setModel", (id, model) => isUuid(id) && isModelName(model) ? chat.setModel(id, model) : void 0);
  handle("chat:setEffort", (id, level) => isUuid(id) && isEffort(level) ? chat.setEffort(id, level) : void 0);
  const chatFolder = (rawId, projectId, folder) => {
    let cwd = null;
    const id = isUuid(rawId) ? rawId : null;
    if (typeof folder === "string" && isUsableFolder(folder)) cwd = folder;
    else if (id && index.ready) {
      const d = conversationDetail(index.db, id, ctx(), folders2());
      cwd = d?.folder ?? d?.row.cwd ?? null;
    } else if (isProjectId(projectId)) cwd = folders2()[projectId] ?? null;
    if (!cwd || !fs25.existsSync(cwd)) cwd = app2.getPath("home");
    return { id, cwd };
  };
  handle("chat:commands", (rawId, projectId, folder) => {
    const { id, cwd } = chatFolder(rawId, projectId, folder);
    return chat.commands(id, cwd);
  });
  handle("chat:mcp", async (rawId, projectId, folder, opts) => {
    const { id, cwd } = chatFolder(rawId, projectId, folder);
    const model = isModelName(opts?.model) ? opts.model : settings.get().defaultModel;
    const effort = isEffort(opts?.effort) ? opts.effort : null;
    const permissionMode = isPermissionMode(opts?.permissionMode) ? opts.permissionMode : settings.get().defaultPermissionMode;
    try {
      return { ok: true, ...await chat.mcp(id, cwd, { model, effort, permissionMode }) };
    } catch (e) {
      return { ok: false, live: false, servers: [], err: e.message.slice(0, 300) };
    }
  });
  handle("chat:mcpAction", (rawId, name, action, opts) => {
    if (!isUuid(rawId)) return { ok: false, err: BAD_ID };
    if (typeof name !== "string" || !/^[^\u0000-\u001f]{1,200}$/.test(name)) return { ok: false, err: "That isn't a server name" };
    if (action !== "reconnect" && action !== "enable" && action !== "disable") return { ok: false, err: "Unknown action" };
    const startWith = {
      model: isModelName(opts?.model) ? opts.model : settings.get().defaultModel,
      effort: isEffort(opts?.effort) ? opts.effort : null,
      permissionMode: isPermissionMode(opts?.permissionMode) ? opts.permissionMode : settings.get().defaultPermissionMode
    };
    return chat.mcpAction(rawId, name, action, chatFolder(rawId, null, null).cwd, startWith);
  });
  handle("chat:setPermissionMode", (id, mode) => isUuid(id) && isPermissionMode(mode) ? chat.setPermissionMode(id, mode) : void 0);
  handle("chat:status", (id) => isUuid(id) ? chat.status(id) : null);
  handle("chat:models", () => chat.models());
  handle("composer:load", () => composer.get());
  handle("composer:save", (patch) => composer.save(patch));
  handle("chat:usage", async () => {
    const u = lastUsage();
    if (!u) return updateUsage(0);
    if (Date.now() - u.at > 3 * 6e4) void updateUsage();
    return u;
  });
  handle("chat:pending", () => chat.pendingPermissions());
  handle("settings:get", () => settings.get());
  handle("settings:set", (patch) => {
    const { patch: clean, rejected } = sanitizeSettingsPatch(patch);
    if (rejected.length) log("settings", `refused from the window: ${rejected.join(", ")}`);
    return Object.keys(clean).length ? settings.set(clean) : settings.get();
  });
  ipcMain.on("window:minimize", (e) => BrowserWindow2.fromWebContents(e.sender)?.minimize());
  ipcMain.on("window:toggleMaximize", (e) => {
    const w = BrowserWindow2.fromWebContents(e.sender);
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on("window:close", (e) => BrowserWindow2.fromWebContents(e.sender)?.close());
  ipcMain.on("window:flyoutHeight", (_e, height) => {
    if (flyout && tray && Number.isFinite(height)) placeFlyout(flyout, tray.getBounds(), Math.max(160, Math.min(640, Math.round(height))));
  });
  ipcMain.on("window:titleBarColors", (e, colors) => {
    const w = BrowserWindow2.fromWebContents(e.sender);
    if (w) setTitleBarColors(w, colors);
  });
}
function openConversation(id) {
  flyout?.hide();
  showMain();
  mainWin?.webContents.send("event:open-conversation", id);
}
var lastWaiting = "";
function updateTrayBadge(onlyIfChanged = false) {
  const waiting = chat.pendingPermissions();
  const key = waiting.map((p) => p.requestId).join(",");
  if (onlyIfChanged && key === lastWaiting) return;
  lastWaiting = key;
  pruneApprovals(new Set(waiting.map((p) => p.requestId)));
  if (!tray) return;
  tray.setImage(appIcon(waiting.length ? "tray-badge.ico" : "tray.ico"));
  tray.setToolTip(waiting.length ? "Conversations \xB7 Claude needs your approval" : "Conversations");
  broadcast("chat-pending", waiting);
}
var secondInstances = new StartupQueue((argv) => handleSecondInstance(argv));
function handleSecondInstance(argv) {
  const parsed = parseProtocolArgs(argv);
  const action = parsed && isRequestId(parsed.requestId) ? parsed : null;
  if (action?.action === "deny") {
    clearApproval(action.requestId);
    chat.respond(action.requestId, "deny");
    updateTrayBadge();
    return;
  }
  if (action?.action === "review") {
    const p = chat.pendingPermissions().find((x) => x.requestId === action.requestId);
    if (p) return openConversation(p.conversationId);
  }
  showMain();
}
app2.on("second-instance", (_e, argv) => secondInstances.push(argv));
app2.on("window-all-closed", () => {
});
app2.on("before-quit", () => {
  quitting = true;
  composer.closing = true;
  composer.flush();
});
var forwarderStage = process.env.CONVERSATIONS_FORWARDER_STAGE || null;
delete process.env.CONVERSATIONS_FORWARDER_STAGE;
void app2.whenReady().then(async () => {
  const sdk = await loadSdk(app2.getAppPath(), app2.isPackaged ? process.resourcesPath : null);
  if (sdk.ok) log("app", `Agent SDK from ${sdk.from}`);
  else log("app", `Agent SDK not found: ${sdk.err}`);
  const s = settings.load();
  nativeTheme2.themeSource = s.theme;
  nativeTheme2.on("updated", () => {
    for (const w of [mainWin, settingsWin]) if (w && !w.isDestroyed()) setTitleBarColors(w);
  });
  settings.on("change", applySettings);
  if (app2.isPackaged) app2.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ["--hidden"] });
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  void refreshClaude();
  registerIpc();
  log("app", `starting ${APP_VERSION} on ${thisMachine()}; data in ${appDataDir()}`);
  try {
    await index.start(path23.join(HERE, "index-worker.mjs"));
    index.watchLive(liveConversationIds);
  } catch (e) {
    log("index", `the index is not available: ${e.stack || e}`);
  }
  index.on("changed", (ids) => {
    overlay.settle(ids);
    broadcast("index-changed", ids);
  });
  scheduler = new SyncScheduler({
    isWindowVisible: () => !!mainWin && mainWin.isVisible() && !mainWin.isMinimized(),
    devices,
    pendingUploads: (sessions) => {
      if (!index.ready) return 0;
      const rows = index.db.prepare("SELECT id, local_mtime_ms FROM conversations WHERE local_mtime_ms IS NOT NULL AND item_count >= 0").all();
      return rows.filter((r) => {
        const pushed = sessions[r.id]?.pushedAt;
        return !!pushed && r.local_mtime_ms > Date.parse(pushed) + 5e3;
      }).length;
    },
    onDownloaded: () => index.scan("download"),
    appVersion: APP_VERSION,
    skipIds: () => [...chat.openIds()]
  });
  scheduler.on("status", (st) => broadcast("sync-status", st));
  void scheduler.start();
  setTimeout(() => knownModels(claudeInstall().path), 2e4).unref();
  setTimeout(checkForUpdate, 15e3).unref();
  setInterval(checkForUpdate, 2 * 6e4).unref();
  const mainHere = listWorkspaces().workspaces[0];
  if (currentWorkspace().id !== "main" && !mainHere.disconnected && fs25.existsSync(path23.join(mainHere.syncHome, "config.json"))) {
    const keepMainCurrent = () => {
      const child = spawn9(process.execPath, [baseEngine(), "pull-all", "--json"], { env: { ...baseEnv(), ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore" });
      child.on("error", (e) => log("sync", `main workspace sync could not start: ${e.message}`));
    };
    setTimeout(keepMainCurrent, 45e3).unref();
    setInterval(keepMainCurrent, 10 * 6e4).unref();
  }
  if (listWorkspaces().workspaces.length > 1) {
    const launcher = launcherPath(currentWorkspace());
    if (launcher && writeLauncher(currentWorkspace())) process.env.CONVERSATIONS_CLAUDE_LAUNCHER = launcher;
  }
  setTimeout(() => void updateUsage(0), 4e3).unref();
  setTimeout(() => sweepPidFiles(), 3e4).unref();
  setInterval(() => {
    if (mainWin?.isVisible() && !mainWin.isMinimized()) void updateUsage(4 * 6e4);
  }, 5 * 6e4).unref();
  registerProtocol();
  let lastBusy = /* @__PURE__ */ new Set();
  let usageAfterReply = null;
  chat.on("status", (st) => {
    broadcast("chat-status", st);
    const busy = chat.runningIds();
    if ([...lastBusy].some((x) => !busy.has(x))) {
      if (usageAfterReply) clearTimeout(usageAfterReply);
      usageAfterReply = setTimeout(() => void updateUsage(3e4), 4e3);
    }
    const flipped = [...busy].filter((x) => !lastBusy.has(x)).concat([...lastBusy].filter((x) => !busy.has(x)));
    lastBusy = busy;
    if (flipped.length) broadcast("index-changed", flipped);
    updateTrayBadge(true);
  });
  chat.on("rekeyed", (before, after) => {
    broadcast("index-changed", [before, after]);
    if (shownId !== before) return;
    let tries = 0;
    const open = () => {
      const have = index.ready && !!index.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(after);
      if (have) {
        if (shownId === before) mainWin?.webContents.send("event:open-conversation", after);
      } else if (tries++ < 30) setTimeout(open, 500);
    };
    index.scan("rekey");
    open();
  });
  chat.on("owned", (id, cwd) => {
    index.own(id, cwd);
    void markAppOwned(id);
  });
  chat.on("closed", () => scheduler?.retrySoon());
  chat.on("changed", () => updateTrayBadge());
  chat.on("permission", (p) => {
    updateTrayBadge();
    const watching2 = !!mainWin && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused();
    if (!watching2) {
      const title = index.db.prepare("SELECT title FROM conversations WHERE id = ?").get(p.conversationId)?.title ?? "A conversation";
      notifyApproval(p, title, () => openConversation(p.conversationId));
    }
  });
  buildTray();
  const hidden = process.argv.includes("--hidden");
  if (!settings.get().welcomed && !hidden) showWelcome();
  else ensureMain(!hidden);
  void themeColors;
  const stageRoot = process.env.CONVERSATIONS_STAGE_ROOT;
  const appDist = process.env.CONVERSATIONS_APP_DIST;
  if (stageRoot && appDist) {
    try {
      writeRunningMark(stageRoot, appDist);
      const gone = cleanStages(stageRoot, appDist, void 0, forwarderStage ? [forwarderStage] : []);
      if (gone.length) log("app", `removed ${gone.length} old copy/copies of the app`);
    } catch (e) {
      log("app", `could not tidy old app copies: ${e.message}`);
    }
  }
  secondInstances.finish();
});
//# sourceMappingURL=main.mjs.map
