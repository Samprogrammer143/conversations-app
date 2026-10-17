// Conversations: every Claude Code conversation from all your PCs, in one place.
//
// One process: a tray agent that starts at login and keeps everything current,
// and a window that is a view over the local index (so it opens instantly).

// First: the workspace this app runs in decides every folder the rest of it reads.
import { baseEngine, baseEnv, baseRepoDir, currentWorkspace, engineOverridden, isWorkspaceId, listWorkspaces, markRelaunch, prepareSwitch, renameWorkspace, setDisconnected } from "./workspace";
import { shareWorkspace, isRemote, launcherPath, setUpWorkspace, workspacesForWindow, writeLauncher } from "./workspace-actions";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, session as electronSession, shell, Tray, type IpcMainInvokeEvent } from "electron";
import type { EditField } from "../shared/api";
import type { AppInfo, Attachment, ListQuery, Settings } from "../shared/types";
import { IndexService } from "./index/service";
import { conversationDetail, deviceSummaries, itemsPage, listConversations, markSeen, search, sidebarData, type PendingEdits, type QueryContext } from "./index/queries";
import { readDevices } from "./sync/repo-read";
import { SyncScheduler } from "./sync/scheduler";
import { detectEngineVersion, runEngineSerial } from "./sync/engine-bridge";
import { sanitizeSettingsPatch, settings } from "./settings";
import { appDataDir, appRepoDir, engineScriptPath, readSyncConfig, repoDir, syncDir, thisMachine } from "./paths";
import { claudeDefaultModel, claudeInstall, hasWindowsTerminal, refreshClaude } from "./claude";
import { createFlyout, createMainWindow, createSettingsWindow, createWelcomeWindow, placeFlyout, setTitleBarColors, themeColors, type WindowFiles } from "./windows";
import { chooseFolder, launchInTerminal, newChatInCli, openInCli, pullConversation } from "./cli";
import { ChatManager, type ResumePrep } from "./chat/manager";
import { knownModels } from "./chat/models";
import { lastUsage, refreshUsage } from "./chat/usage";
import { ComposerStore, isComposerKey } from "./composer-state";
import { sweepPidFiles } from "./chat/shell";
import { clearApproval, notifyApproval, parseProtocolArgs, pruneApprovals, registerProtocol } from "./chat/notify";
import { isOpenInTerminal, readRegistry, sessionProcesses, thisPidDomain } from "./chat/terminals";
import { NO_FOLDER, NOT_HERE, OPEN_ON_THIS_PC } from "./handover";
import { folderForTranscript } from "./resume-folder";
import { displayRemote } from "./remote-display";
import { checkEdit, isDecision, isEffort, isModelName, isPermissionMode, isRequestId, isUuid } from "./validate";
import { EditsOverlay } from "./edits-overlay";
import { StartupQueue } from "./startup-queue";
import { cleanStages, writeRunningMark } from "../shell/stages";
import { log, logPath } from "./log";
import { loadSdk, sdkLoadedFrom } from "./chat/sdk";
import { authStatus, cancelAllLogins, cancelLogin, startLogin, submitLoginCode } from "./auth";

// A programming mistake must never take the tray agent (and sync) down with it.
// Logged, never shown as a dialog: the window shows nothing and the app carries on.
process.on("uncaughtException", (e) => log("app", `uncaught exception: ${(e as Error)?.stack || e}`));
process.on("unhandledRejection", (e) => log("app", `unhandled rejection: ${(e as Error)?.stack || e}`));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..");
const files: WindowFiles = {
  preload: path.join(DIST, "preload", "preload.cjs"),
  page: process.env.CONVERSATIONS_DEV_URL || path.join(DIST, "renderer", "index.html"),
};
const RESOURCES = app.isPackaged ? process.resourcesPath : path.resolve(DIST, "..", "resources");
files.icon = path.join(RESOURCES, "icon.ico");
// The app code's own version (it can be newer than the installer, via the repository).
const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIST, "app.json"), "utf8")).version || app.getVersion();
  } catch {
    return app.getVersion();
  }
})();

// A sandbox (development, tests) keeps its own Electron profile too, so its
// single-instance lock never collides with the installed app's.
if (process.env.CONVERSATIONS_DATA_DIR) app.setPath("userData", path.join(process.env.CONVERSATIONS_DATA_DIR, "electron"));
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId("com.samcan.conversations");

let mainWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let flyout: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const index = new IndexService();
const overlay = new EditsOverlay();
const pending: PendingEdits = overlay.pending as PendingEdits;

/** The conversation's transcript on this PC, from the index. */
function localTranscript(id: string): string | null {
  if (!index.ready) return null;
  return (index.db.prepare("SELECT local_path FROM conversations WHERE id = ?").get(id) as { local_path?: string } | undefined)?.local_path ?? null;
}

/** The folder the conversation itself ran in, when that folder is on this PC. */
function recordedCwdOnThisPc(id: string): string | null {
  if (!index.ready) return null;
  const cwd = (index.db.prepare("SELECT cwd FROM conversations WHERE id = ?").get(id) as { cwd?: string | null } | undefined)?.cwd ?? null;
  try {
    return cwd && fs.statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * Before the app continues a conversation: the newest copy from GitHub, and the
 * folder Claude Code must start in for --resume to find it (where the conversation
 * ran, when that is on this PC; otherwise the project's folder).
 */
async function prepareResume(id: string, projectFolder: string): Promise<ResumePrep> {
  const recorded = recordedCwdOnThisPc(id);
  const pulled = await pullConversation(id, recorded ?? projectFolder);
  if (pulled?.live) {
    // Left alone by the download because it is in use here. Something still has it open: no.
    const procs = await sessionProcesses(id, { anyKind: true });
    if (procs?.length) return { refuse: OPEN_ON_THIS_PC };
    // Otherwise it was only written to in the last two minutes: carry on with this PC's copy.
  }
  const transcript = (pulled?.ok ? pulled.dest : null) ?? localTranscript(id);
  if (!transcript) return { refuse: NOT_HERE };
  const folder = folderForTranscript(transcript, [recorded, projectFolder]);
  return folder ? { cwd: folder } : { refuse: NO_FOLDER };
}

const chat = new ChatManager({
  claudePath: () => claudeInstall().path,
  machine: () => thisMachine(),
  localTranscript,
  syncBeforeResume: prepareResume,
  terminalHas: (id) => isOpenInTerminal(id),
});

// Conversations the app has chatted in are marked for every PC (the _state log's
// "app" field), so other PCs' indexes show them although Claude Code ran them
// through the SDK. Each is marked once; the list of marked ones is kept here.
const ownedFile = () => path.join(appDataDir(), "app-owned.json");
let ownedMarked: Set<string> | null = null;
const ownedMarking = new Set<string>();
async function markAppOwned(id: string) {
  if (!ownedMarked) {
    try {
      const v = JSON.parse(fs.readFileSync(ownedFile(), "utf8"));
      ownedMarked = new Set(Array.isArray(v) ? v.filter((x: unknown) => typeof x === "string") : []);
    } catch {
      ownedMarked = new Set();
    }
  }
  if (ownedMarked.has(id) || ownedMarking.has(id)) return;
  if ((await detectEngineVersion()) < 3) return;
  ownedMarking.add(id);
  try {
    const r = await runEngineSerial<{ ok: boolean; nothing?: boolean }>(["edit", "--json", "--ops", JSON.stringify([{ session: id, field: "app", value: true }])]);
    // "nothing" means this engine doesn't know the field yet: try again next time.
    if (r.ok && !r.json?.nothing) {
      ownedMarked.add(id);
      const tmp = `${ownedFile()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...ownedMarked]));
      fs.renameSync(tmp, ownedFile());
    } else log("chat", `couldn't mark ${id.slice(0, 8)} as an app conversation: ${r.json?.nothing ? "the sync engine doesn't know the field yet" : r.stderr.split("\n")[0]}`);
  } catch (e) {
    log("chat", `marking ${id.slice(0, 8)} failed: ${(e as Error).message}`);
  } finally {
    ownedMarking.delete(id);
  }
}

/** Index writes from the main thread wait at most a moment for the index worker, then try again later. */
function quickWrite(what: string, fn: () => void, retries = 2) {
  if (!index.ready) return;
  const db = index.db;
  const before = (db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined)?.timeout ?? 4000;
  try {
    db.exec("PRAGMA busy_timeout = 150");
    fn();
  } catch (e) {
    if (retries > 0 && /busy|locked/i.test((e as Error).message)) setTimeout(() => quickWrite(what, fn, retries - 1), 1000);
    else log("index", `${what} failed: ${(e as Error).message}`);
  } finally {
    db.exec(`PRAGMA busy_timeout = ${Number(before) || 4000}`);
  }
}
let scheduler: SyncScheduler;

const ctx = (): QueryContext => ({ thisMachine: thisMachine(), now: Date.now(), running: chat.runningIds(), pending });
const devices = () => (index.ready ? deviceSummaries(index.db, ctx(), readDevices(repoDir())) : []);
const folders = (): Record<string, string> => ({ ...inferredFolders(), ...(readSyncConfig()?.folders ?? {}), ...settings.get().folders });

/**
 * Where each project lives on this PC, worked out from its conversations: the
 * existing folder its conversations here ran in most often (the newest on a tie).
 * A folder you chose, or one set in the sync config, always wins over this.
 */
let inferred: { at: number; map: Record<string, string> } | null = null;
function inferredFolders(): Record<string, string> {
  if (inferred && Date.now() - inferred.at < 60_000) return inferred.map;
  const map: Record<string, string> = {};
  if (index.ready) {
    const rows = index.db
      .prepare("SELECT project_id AS p, cwd, COUNT(*) AS n, MAX(last_at) AS last FROM conversations WHERE item_count >= 0 AND cwd IS NOT NULL AND local_path IS NOT NULL GROUP BY project_id, cwd ORDER BY n DESC, last DESC")
      .all() as { p: string; cwd: string }[];
    for (const r of rows) {
      if (map[r.p]) continue;
      try {
        if (fs.statSync(r.cwd).isDirectory()) map[r.p] = r.cwd;
      } catch {}
    }
  }
  inferred = { at: Date.now(), map };
  return map;
}

/** Unsent messages and per-chat choices, kept for the window. */
const composer = new ComposerStore();

/** The conversation the window last opened: kept current even while another program writes it. */
let shownId: string | null = null;

/** Conversations being written right now: in a Claude Code process on this PC (a terminal, this app, any SDK run), or on screen. */
function liveConversationIds(): string[] {
  const ids = new Set<string>();
  const domain = thisPidDomain();
  for (const e of readRegistry() ?? []) if (!e.pidDomain || e.pidDomain === domain) ids.add(e.sessionId);
  for (const id of chat.openIds?.() ?? []) ids.add(id);
  if (shownId) ids.add(shownId);
  return [...ids];
}

function broadcast(event: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`event:${event}`, payload);
}

// The usage meters: fresh numbers on start, on focus, after a reply, and every five
// minutes while the window is on screen. Each ask costs nothing but a short process.
async function updateUsage(minGapMs = 60_000) {
  const before = lastUsage();
  const u = await refreshUsage(claudeInstall().path, minGapMs);
  if (u !== before) broadcast("usage", u);
  return u;
}

let welcomeWin: BrowserWindow | null = null;

/** First run: the welcome window alone; the main window opens when it closes. */
function showWelcome() {
  welcomeWin = createWelcomeWindow(files);
  welcomeWin.on("closed", () => {
    welcomeWin = null;
    if (!settings.get().welcomed) settings.set({ welcomed: true });
    showMain();
  });
}

/** The one main window: made on first use, reused after (never two). */
function ensureMain(show: boolean): BrowserWindow {
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

function makeMain(show: boolean): BrowserWindow {
  const w = createMainWindow(files, { show });
  w.on("close", (e) => {
    // Closing the window keeps the tray agent (and sync) running.
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
    void updateUsage(2 * 60_000);
  });
  w.on("blur", state);
  return w;
}

function appIcon(name: string) {
  const p = path.join(RESOURCES, name);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
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

/** The tray's menu, rebuilt whenever "Pause sync" changes (in Settings, the popover or the menu itself). */
function trayMenuTemplate(paused: boolean): Electron.MenuItemConstructorOptions[] {
  return [
    ...(updateReady ? ([{ label: `Restart to update to ${updateReady}`, click: () => restartForUpdate() }, { type: "separator" }] as Electron.MenuItemConstructorOptions[]) : []),
    { label: "Open Conversations", click: showMain },
    { label: "Sync now", click: () => void scheduler.syncNow() },
    { label: "Pause sync", type: "checkbox", checked: paused, click: (item) => scheduler.setPaused(item.checked) },
    { type: "separator" },
    { label: "Settings", click: () => openSettings() },
    { type: "separator" },
    { label: "Quit Conversations", click: () => quit() },
  ];
}

let trayPaused: boolean | null = null;
let trayUpdate: string | null = null;
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

function openSettings(section?: string) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = createSettingsWindow(files, mainWin, section);
  settingsWin.on("closed", () => (settingsWin = null));
}

// A newer version of the app code, committed in the sync repository, loads at
// the next start. The app says so, in the window and the tray, instead of
// leaving it to a restart nobody knows they need.
let updateReady: string | null = null;
const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
// This PC's copy of the app's repository is brought up to date (and set up, the first
// time) by the engine's `app` command, every ten minutes; not while developing or testing,
// unless the test names its own copy.
let appRefreshAt = 0;
function refreshAppRepo() {
  // (A workspace sets CONVERSATIONS_ENGINE for everything it starts: what counts is how the app was started.)
  if (engineOverridden() && !process.env.CONVERSATIONS_APP_HOME) return;
  if (Date.now() - appRefreshAt < 10 * 60_000) return;
  appRefreshAt = Date.now();
  const child = spawn(process.execPath, [engineScriptPath(), "app", "--json"], { env: { ...baseEnv(), ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore" });
  child.on("error", (e) => log("app", `could not update the app's repository: ${e.message}`));
  // Claude's Agent SDK may only now be installed on this PC (a first start right after the move).
  child.on("exit", () => void retrySdk());
}
let sdkTriedAt = 0;
async function retrySdk() {
  if (sdkLoadedFrom() || Date.now() - sdkTriedAt < 30_000) return;
  sdkTriedAt = Date.now();
  const r = await loadSdk(app.getAppPath(), app.isPackaged ? process.resourcesPath : null);
  if (r.ok) log("app", `Agent SDK from ${r.from}`);
}
function checkForUpdate() {
  refreshAppRepo();
  void retrySdk();
  // The app's code comes from the app's own repository (on a PC still on the old layout,
  // from the first workspace's conversations repository), whichever workspace this is.
  const source = fs.existsSync(path.join(appRepoDir(), ".git")) ? appRepoDir() : baseRepoDir();
  execFile("git", ["-C", source, "show", "HEAD:_app/dist/app.json"], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
    if (err) return;
    try {
      const v = String(JSON.parse(stdout).version || "");
      if (v && newer(v, APP_VERSION) && v !== updateReady) {
        updateReady = v;
        log("app", `version ${v} is ready; it loads at the next start`);
        refreshTrayMenu();
        broadcast("update-ready", v);
      }
    } catch {}
  });
}
function restartForUpdate() {
  // The restart starts from the launch environment: the shell finds the app's code in
  // the first workspace's repository, and the workspace is chosen again from the registry.
  markRelaunch();
  // Tests start the app again themselves (their runner can't follow a relaunch).
  if (!process.env.CONVERSATIONS_TEST_NO_RELAUNCH) app.relaunch({ args: process.argv.slice(1).filter((a) => a !== "--hidden") });
  quit();
}

function quit() {
  quitting = true;
  chat.closeAll();
  cancelAllLogins();
  scheduler?.stop();
  index.stop();
  app.quit();
}

function applySettings(s: Settings, patch: Partial<Settings>) {
  if ("syncAutomatically" in patch) refreshTrayMenu();
  if ("theme" in patch) nativeTheme.themeSource = s.theme;
  if ("startAtLogin" in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ["--hidden"] });
  if ("theme" in patch) for (const w of [mainWin, settingsWin]) if (w && !w.isDestroyed()) setTitleBarColors(w);
  broadcast("settings-changed", s);
}

async function appInfo(): Promise<AppInfo> {
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
    windowsTerminal: hasWindowsTerminal(),
  };
}

const EDIT_TEXT: Record<EditField, (v: unknown) => string> = {
  pinned: (v) => (v ? "Pinned" : "Unpinned"),
  title: () => "Renamed",
  archived: (v) => (v ? "Archived" : "Unarchived"),
  deleted: (v) => (v ? "Deleted" : "Restored"),
};

async function applyEdit(id: string, field: EditField, value: boolean | string | null) {
  if (field === "deleted" && value === true) {
    // Never delete under a writer: Claude would recreate the file a moment later.
    if (chat.isRunning(id)) return { ok: false, err: "Claude is still working in this conversation. Stop it first, then delete it." };
    if (await chat.openInTerminal(id)) return { ok: false, err: "This conversation is open in a terminal on this PC. Close it there first, then delete it." };
    // An idle chat in the app is simply closed first.
    if (chat.isOpenInApp(id)) await chat.release(id);
  }
  // Shown at once; GitHub catches up in the background. Taken back if the engine refuses it.
  const before = overlay.apply(id, field, value);
  broadcast("index-changed", [id]);
  if ((await detectEngineVersion()) < 3) return { ok: true, queued: true, err: "Saved on this PC; the sync engine on this PC needs its update to share it" };
  const r = await runEngineSerial<{ ok: boolean; queued?: boolean; pushed?: boolean; err?: string }>(["edit", "--json", "--ops", JSON.stringify([{ session: id, field, value }])]);
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

function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (_e: IpcMainInvokeEvent, ...args: unknown[]) => fn(...args));
}

const BAD_ID = "That conversation id isn't valid";

/** An absolute path to an existing folder on this PC. */
function isUsableFolder(p: string): boolean {
  try {
    return path.isAbsolute(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Images a message can carry: the types the API accepts, 5 MB each, ten at a time.
const IMAGE_TYPES: Record<string, Attachment["mediaType"]> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;

/** The attachments from the window, checked; null when any of them is not acceptable. */
function validAttachments(raw: unknown): Attachment[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return null;
  const types = new Set(Object.values(IMAGE_TYPES));
  const out: Attachment[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    if (!a || typeof a !== "object" || typeof a.data !== "string" || typeof a.mediaType !== "string" || !types.has(a.mediaType as Attachment["mediaType"])) return null;
    if (a.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9+/=]+$/.test(a.data)) return null;
    out.push({ name: String(a.name ?? "image").slice(0, 200), mediaType: a.mediaType as Attachment["mediaType"], data: a.data });
  }
  return out;
}
const isProjectId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 400;

function registerIpc() {
  handle("app:info", appInfo);
  handle("app:openExternal", (url: unknown) => (typeof url === "string" && /^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));
  // Folders only ("Show in folder"): opening a file would run it.
  handle("app:openPath", (p: unknown) => {
    try {
      if (typeof p === "string" && path.isAbsolute(p) && fs.statSync(p).isDirectory()) return shell.openPath(p);
    } catch {}
    return "Only folders can be opened";
  });
  handle("app:updateReady", () => updateReady);
  handle("app:restart", () => restartForUpdate());
  // Workspaces: one Claude account each; switching restarts the app into the other one.
  // Each workspace's Claude account as Claude Code reports it (cached for a minute).
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
      }),
    );
    return { ...r, workspaces };
  });
  handle("workspace:switch", (id: unknown, force: unknown) => {
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
  handle("workspace:add", async (input: unknown) => {
    const i = (input ?? {}) as { id?: unknown; name?: unknown; remote?: unknown };
    if (typeof i.name !== "string" || !isRemote(i.remote)) return { ok: false, err: "Give it a name and the repository's address" };
    return setUpWorkspace({ id: isWorkspaceId(i.id) ? i.id : undefined, name: i.name, remote: i.remote });
  });
  // Signs a workspace's Claude Code in (or into another account), with no terminal:
  // `claude auth login` for its Claude folder, run by the app. It opens Claude's sign-in in
  // the browser; the window asks for the code the page ends on (signInCode). Once signed
  // in, idle chats in this workspace start again with the login. (No id: the workspace
  // this window is in.)
  handle("workspace:signIn", async (id: unknown) => {
    const w = id == null ? currentWorkspace() : listWorkspaces().workspaces.find((x) => x.id === id);
    if (!w) return { ok: false, err: "There's no such workspace" };
    const claudePath = claudeInstall().path;
    if (!claudePath) return { ok: false, err: "Claude Code isn't installed on this PC" };
    // Tests sign in with a stand-in ("<node>|<script>"), never with a real browser sign-in.
    const fake = app.isPackaged ? undefined : process.env.CONVERSATIONS_TEST_LOGIN?.split("|");
    const r = fake?.length === 2 ? await startLogin(w, fake[0], [fake[1]]) : await startLogin(w, claudePath);
    log("app", r.ok ? `sign-in started for workspace ${w.id}` : `sign-in for workspace ${w.id} didn't start: ${r.err}`);
    return { ...r, id: w.id, name: w.name };
  });
  handle("workspace:signInCode", async (id: unknown, code: unknown) => {
    const w = listWorkspaces().workspaces.find((x) => x.id === id);
    if (!w || typeof code !== "string") return { ok: false, err: "There's no such workspace" };
    const r = await submitLoginCode(w.id, code);
    if (!r.ok) return r;
    const s = await authStatus(w, claudeInstall().path ?? null, true);
    log("app", `workspace ${w.id} signed in${s?.email ? ` as ${s.email}` : ""}`);
    broadcast("workspaces-changed", null);
    // Sessions started before the sign-in still run without it.
    if (w.id === currentWorkspace().id) void chat.releaseIdle();
    return { ok: true, email: s?.email ?? null };
  });
  handle("workspace:signInCancel", (id: unknown) => {
    if (typeof id === "string") cancelLogin(id);
  });
  // Leaves a workspace out of Conversations on this PC (its Claude Code chats stay as they
  // are). The one the app is in can go only when another one is there to switch to.
  handle("workspace:disconnect", (id: unknown, force: unknown) => {
    const all = listWorkspaces().workspaces;
    const target = all.find((w) => w.id === id);
    if (!isWorkspaceId(id) || !target) return { ok: false, err: "There's no such workspace" };
    if (target.disconnected) return { ok: true };
    const forWindow = workspacesForWindow().workspaces;
    const next = all.find((w) => w.id !== id && !w.disconnected && forWindow.some((f) => f.id === w.id && f.setUp));
    if (!next) return { ok: false, err: "Add another workspace first: Conversations needs one to show" };
    // On a PC still on the old layout the app's updates come through the first workspace's
    // repository, which only its sync brings: it stays until this PC has the app's own.
    if (id === "main" && !fs.existsSync(path.join(appRepoDir(), ".git"))) return { ok: false, err: "This PC still gets the app's updates through this workspace: it can be disconnected after its next update" };
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
  handle("workspace:reconnect", (id: unknown) => {
    if (!isWorkspaceId(id) || !listWorkspaces().workspaces.some((w) => w.id === id)) return { ok: false, err: "There's no such workspace" };
    setDisconnected(id, false);
    log("app", `reconnected workspace ${id}`);
    broadcast("workspaces-changed", null);
    // A first workspace that never synced here (a PC set up keeping its earlier chats out):
    // the window says so before going to it.
    const w = listWorkspaces().workspaces.find((x) => x.id === id);
    return { ok: true, synced: !!w && fs.existsSync(path.join(w.syncHome, "config.json")) };
  });
  handle("workspace:rename", (id: unknown, name: unknown) => {
    if (!isWorkspaceId(id) || typeof name !== "string" || !name.trim()) return;
    renameWorkspace(id, name.trim().slice(0, 40));
    broadcast("workspaces-changed", null);
    // The other PCs see the new name too.
    const w = listWorkspaces().workspaces.find((x) => x.id === id);
    if (w && w.remote) void shareWorkspace({ id: w.id, name: w.name, remote: w.remote });
  });
  handle("app:pickFolder", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWin;
    const opts: Electron.OpenDialogOptions = { title: "New chat in which folder?", buttonLabel: "Chat here", properties: ["openDirectory"] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const p = r.filePaths[0];
    return p && isUsableFolder(p) ? p : null;
  });
  handle("app:pickFiles", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWin;
    const opts: Electron.OpenDialogOptions = { title: "Attach", properties: ["openFile", "multiSelections"] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const images: Attachment[] = [];
    const paths: string[] = [];
    for (const p of r.filePaths) {
      const type = IMAGE_TYPES[path.extname(p).toLowerCase()];
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue;
      }
      if (type && size <= MAX_IMAGE_BYTES) images.push({ name: path.basename(p), mediaType: type, data: fs.readFileSync(p).toString("base64") });
      else paths.push(p);
    }
    return { images, paths };
  });
  handle("app:showSettings", (section?: unknown) => openSettings(typeof section === "string" && /^[a-z-]{1,32}$/.test(section) ? section : undefined));
  handle("app:toggleFlyout", () => toggleFlyout());
  handle("app:showMain", (conversationId?: unknown) => {
    flyout?.hide();
    showMain();
    if (isUuid(conversationId)) mainWin?.webContents.send("event:open-conversation", conversationId);
  });
  handle("app:copyText", (text: unknown) => clipboard.writeText(String(text ?? "")));
  handle("app:checkClaude", async () => {
    const c = await refreshClaude(true);
    return { found: c.found, version: c.version, path: c.path, signedIn: c.signedIn, defaultModel: claudeDefaultModel() };
  });
  handle("app:finishWelcome", () => {
    settings.set({ welcomed: true });
    if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close();
  });

  handle("list:sidebar", () => (index.ready ? { ...sidebarData(index.db, ctx(), readDevices(repoDir()), folders()), pcCount: devices().length } : null));
  handle("list:conversations", (q: ListQuery) => (index.ready && q && typeof q === "object" ? listConversations(index.db, q, ctx()) : { rows: [], counts: { all: 0, updated: 0, live: 0 } }));
  handle("list:detail", (id: unknown) => {
    if (!index.ready || !isUuid(id)) return null;
    shownId = id;
    return conversationDetail(index.db, id, ctx(), folders());
  });
  handle("list:items", (id: unknown, before: unknown, limit: unknown) => {
    if (!index.ready || !isUuid(id)) return { items: [], firstSeq: 0, total: 0 };
    const b = typeof before === "number" && Number.isInteger(before) && before >= 0 ? before : null;
    const n = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(500, limit) : 120;
    return itemsPage(index.db, id, b, n);
  });
  handle("list:markSeen", (id: unknown) => {
    if (!isUuid(id)) return;
    quickWrite("mark seen", () => markSeen(index.db, id));
    broadcast("index-changed", [id]);
  });
  handle("list:search", (text: unknown, opts?: { includeTools?: boolean }) => {
    const q = String(text ?? "").slice(0, 500);
    if (!index.ready) return { query: q, hits: [], suggestion: null, searchedConversations: 0, pcCount: 0, tookMs: 0 };
    return search(index.db, q, ctx(), { includeTools: !!opts?.includeTools });
  });
  handle("list:image", (key: unknown) => (typeof key === "string" && key.length <= 4000 ? index.image(key) : null));

  handle("edit:apply", (id: unknown, field: unknown, value: unknown) => {
    if (!isUuid(id)) return { ok: false, err: BAD_ID };
    const edit = checkEdit(field, value);
    if (!edit) return { ok: false, err: "That change isn't valid" };
    return applyEdit(id, edit.field, edit.value);
  });

  handle("sync:status", () => scheduler.status());
  handle("sync:now", () => scheduler.syncNow());
  handle("sync:setPaused", (paused: unknown) => scheduler.setPaused(paused === true));
  handle("sync:openLog", () => shell.openPath(path.join(syncDir(), "sync.log")));
  handle("sync:setUploadQuiet", (seconds: unknown) => scheduler.setUploadQuiet(typeof seconds === "number" ? seconds : NaN));

  handle("cli:open", async (id: unknown) => {
    if (!isUuid(id)) return { ok: false, message: BAD_ID };
    const d = conversationDetail(index.db, id, ctx(), folders());
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
      localTranscript,
    });
  });
  handle("cli:newChat", async (projectId: unknown) => {
    const pid = isProjectId(projectId) ? projectId : null;
    const f = folders();
    let folder = pid ? f[pid] : null;
    if (!folder && pid) {
      folder = await chooseFolder(mainWin, pid.split("/").pop() ?? "the project");
      if (folder) settings.set({ folders: { ...settings.get().folders, [pid]: folder } });
    }
    return newChatInCli(folder ?? app.getPath("home"));
  });

  handle("chat:send", async (rawId: unknown, text: unknown, opts?: { projectId?: unknown; folder?: unknown; model?: unknown; permissionMode?: unknown; effort?: unknown; attachments?: unknown; shell?: unknown; draftKey?: unknown }) => {
    if (rawId !== null && !isUuid(rawId)) return { ok: false, err: BAD_ID };
    const id = rawId as string | null;
    const value = String(text ?? "").trim();
    const attachments = validAttachments(opts?.attachments);
    if (attachments === null) return { ok: false, err: "Only PNG, JPEG, GIF or WebP images up to 5 MB can be attached, at most 10 at a time" };
    if (!value && !attachments.length) return { ok: false, err: "Nothing to send" };
    if (value.length > 200_000) return { ok: false, err: "That message is too long to send" };
    let cwd: string | null = null;
    if (id) {
      const d = conversationDetail(index.db, id, ctx(), folders());
      if (!d) return { ok: false, err: "That conversation isn't on this PC yet" };
      cwd = d.folder;
      if (!cwd || !fs.existsSync(cwd)) {
        cwd = await chooseFolder(mainWin, d.row.projectLabel);
        if (!cwd) return { ok: false, err: "Chat needs the project's folder on this PC" };
        settings.set({ folders: { ...settings.get().folders, [d.row.projectId]: cwd } });
      }
    } else if (typeof opts?.folder === "string" && isUsableFolder(opts.folder)) {
      // A folder you picked for this chat.
      cwd = opts.folder;
    } else {
      const asked = opts?.projectId;
      const pid = isProjectId(asked) ? asked : null;
      cwd = pid ? folders()[pid] ?? null : null;
      if (!cwd && pid && pid !== "folder:_home" && !pid.startsWith("folder:")) {
        cwd = await chooseFolder(mainWin, pid.split("/").pop() ?? "the project");
        if (cwd) settings.set({ folders: { ...settings.get().folders, [pid]: cwd } });
      }
      cwd ??= app.getPath("home");
    }
    // Only the modes the app offers; anything else (bypassPermissions, dontAsk, auto) falls back to the setting.
    const askedMode = opts?.permissionMode;
    const askedModel = opts?.model;
    const mode = isPermissionMode(askedMode) ? askedMode : settings.get().defaultPermissionMode;
    const model = isModelName(askedModel) ? askedModel : settings.get().defaultModel;
    const effort = isEffort(opts?.effort) ? opts.effort : null;
    // "!" in the composer: the text is a shell command to run in the conversation's folder.
    if (opts?.shell === true) {
      if (!value) return { ok: false, err: "Type a command after the !" };
      if (attachments.length) return { ok: false, err: "Images can't go with a ! command" };
      return chat.shell({ id, text: "", command: value, cwd, model, permissionMode: mode, effort, draftKey: isComposerKey(opts.draftKey) ? opts.draftKey : undefined });
    }
    return chat.send({ id, text: value || "(image)", cwd, model, permissionMode: mode, effort, attachments });
  });
  handle("chat:stop", (id: unknown) => (isUuid(id) ? chat.stop(id) : undefined));
  // A "!" command in a new chat has no conversation id yet: it is stopped by the composer's key.
  handle("chat:stopShell", (key: unknown) => (isComposerKey(key) ? chat.stopDraftShell(key) : undefined));
  handle("chat:respond", (requestId: unknown, decision: unknown) => {
    if (!isRequestId(requestId)) return;
    clearApproval(requestId);
    // Anything but a known answer is a No.
    chat.respond(requestId, isDecision(decision) ? decision : "deny");
    updateTrayBadge();
  });
  handle("chat:setModel", (id: unknown, model: unknown) => (isUuid(id) && isModelName(model) ? chat.setModel(id, model) : undefined));
  handle("chat:setEffort", (id: unknown, level: unknown) => (isUuid(id) && isEffort(level) ? chat.setEffort(id, level) : undefined));
  // The folder Claude Code runs in for this conversation (or new chat): it decides the skills and MCP servers.
  const chatFolder = (rawId: unknown, projectId: unknown, folder: unknown): { id: string | null; cwd: string } => {
    let cwd: string | null = null;
    const id = isUuid(rawId) ? rawId : null;
    if (typeof folder === "string" && isUsableFolder(folder)) cwd = folder;
    else if (id && index.ready) {
      const d = conversationDetail(index.db, id, ctx(), folders());
      cwd = d?.folder ?? d?.row.cwd ?? null;
    } else if (isProjectId(projectId)) cwd = folders()[projectId] ?? null;
    if (!cwd || !fs.existsSync(cwd)) cwd = app.getPath("home");
    return { id, cwd };
  };
  handle("chat:commands", (rawId: unknown, projectId: unknown, folder: unknown) => {
    const { id, cwd } = chatFolder(rawId, projectId, folder);
    return chat.commands(id, cwd);
  });
  // /mcp: the chat's MCP servers, and reconnect / enable / disable in its running session.
  handle("chat:mcp", async (rawId: unknown, projectId: unknown, folder: unknown, opts?: { model?: unknown; effort?: unknown; permissionMode?: unknown }) => {
    const { id, cwd } = chatFolder(rawId, projectId, folder);
    // A chat started for /mcp starts as the next message would: the chat's model, effort and mode.
    const model = isModelName(opts?.model) ? opts.model : settings.get().defaultModel;
    const effort = isEffort(opts?.effort) ? opts.effort : null;
    const permissionMode = isPermissionMode(opts?.permissionMode) ? opts.permissionMode : settings.get().defaultPermissionMode;
    try {
      return { ok: true, ...(await chat.mcp(id, cwd, { model, effort, permissionMode })) };
    } catch (e) {
      return { ok: false, live: false, servers: [], err: (e as Error).message.slice(0, 300) };
    }
  });
  handle("chat:mcpAction", (rawId: unknown, name: unknown, action: unknown, opts?: { model?: unknown; effort?: unknown; permissionMode?: unknown }) => {
    if (!isUuid(rawId)) return { ok: false, err: BAD_ID };
    if (typeof name !== "string" || !/^[^\u0000-\u001f]{1,200}$/.test(name)) return { ok: false, err: "That isn't a server name" };
    if (action !== "reconnect" && action !== "enable" && action !== "disable") return { ok: false, err: "Unknown action" };
    // If it has to start the chat again, it starts as the next message would.
    const startWith = {
      model: isModelName(opts?.model) ? opts.model : settings.get().defaultModel,
      effort: isEffort(opts?.effort) ? opts.effort : null,
      permissionMode: isPermissionMode(opts?.permissionMode) ? opts.permissionMode : settings.get().defaultPermissionMode,
    };
    return chat.mcpAction(rawId, name, action, chatFolder(rawId, null, null).cwd, startWith);
  });
  handle("chat:setPermissionMode", (id: unknown, mode: unknown) => (isUuid(id) && isPermissionMode(mode) ? chat.setPermissionMode(id, mode) : undefined));
  handle("chat:status", (id: unknown) => (isUuid(id) ? chat.status(id) : null));
  handle("chat:models", () => chat.models());
  handle("composer:load", () => composer.get());
  handle("composer:save", (patch: unknown) => composer.save(patch));
  handle("chat:usage", async () => {
    // The last reading at once (a fresh one follows as an event when it is a few
    // minutes old); with no reading yet, the first one, so a window that asks
    // before it arrives never misses it.
    const u = lastUsage();
    if (!u) return updateUsage(0);
    if (Date.now() - u.at > 3 * 60_000) void updateUsage();
    return u;
  });
  handle("chat:pending", () => chat.pendingPermissions());

  handle("settings:get", () => settings.get());
  handle("settings:set", (patch: unknown) => {
    const { patch: clean, rejected } = sanitizeSettingsPatch(patch);
    if (rejected.length) log("settings", `refused from the window: ${rejected.join(", ")}`);
    return Object.keys(clean).length ? settings.set(clean) : settings.get();
  });

  ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on("window:toggleMaximize", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.on("window:flyoutHeight", (_e, height: number) => {
    if (flyout && tray && Number.isFinite(height)) placeFlyout(flyout, tray.getBounds(), Math.max(160, Math.min(640, Math.round(height))));
  });
  ipcMain.on("window:titleBarColors", (e, colors: { background: string; symbols: string }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) setTitleBarColors(w, colors);
  });
}

function openConversation(id: string) {
  flyout?.hide();
  showMain();
  mainWin?.webContents.send("event:open-conversation", id);
}

let lastWaiting = "";
function updateTrayBadge(onlyIfChanged = false) {
  const waiting = chat.pendingPermissions();
  const key = waiting.map((p) => p.requestId).join(",");
  if (onlyIfChanged && key === lastWaiting) return;
  lastWaiting = key;
  // Notifications for requests that ended without an answer here come down too.
  pruneApprovals(new Set(waiting.map((p) => p.requestId)));
  if (!tray) return;
  tray.setImage(appIcon(waiting.length ? "tray-badge.ico" : "tray.ico"));
  tray.setToolTip(waiting.length ? "Conversations · Claude needs your approval" : "Conversations");
  broadcast("chat-pending", waiting);
}

// Requests from a second instance arriving while this one is still starting up
// are kept and replayed once the windows exist, so none makes a second window.
const secondInstances = new StartupQueue<string[]>((argv) => handleSecondInstance(argv));

function handleSecondInstance(argv: string[]) {
  // A button on the approval notification, or simply starting the app again.
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

app.on("second-instance", (_e, argv) => secondInstances.push(argv));
app.on("window-all-closed", () => {
  /* the tray keeps running */
});
app.on("before-quit", () => {
  quitting = true;
  cancelAllLogins();
  composer.closing = true;
  composer.flush();
});

// The forwarder an older shell runs first names its own staged copy: kept when tidying,
// and not passed on to the chats and terminals this app starts.
const forwarderStage = process.env.CONVERSATIONS_FORWARDER_STAGE || null;
delete process.env.CONVERSATIONS_FORWARDER_STAGE;

void app.whenReady().then(async () => {
  // Claude's Agent SDK lives on this PC, not in the app's code (see chat/sdk.ts).
  const sdk = await loadSdk(app.getAppPath(), app.isPackaged ? process.resourcesPath : null);
  if (sdk.ok) log("app", `Agent SDK from ${sdk.from}`);
  else log("app", `Agent SDK not found: ${sdk.err}`);
  const s = settings.load();
  nativeTheme.themeSource = s.theme;
  nativeTheme.on("updated", () => {
    for (const w of [mainWin, settingsWin]) if (w && !w.isDestroyed()) setTitleBarColors(w);
  });
  settings.on("change", applySettings);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ["--hidden"] });
  // The window never needs the camera, microphone, notifications API and so on.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  void refreshClaude();
  registerIpc();
  log("app", `starting ${APP_VERSION} on ${thisMachine()}; data in ${appDataDir()}`);

  // A damaged index is rebuilt (see IndexService.start); if even that fails the
  // app still comes up, with the tray and sync, and says so in the log.
  try {
    await index.start(path.join(HERE, "index-worker.mjs"));
    index.watchLive(liveConversationIds);
  } catch (e) {
    log("index", `the index is not available: ${(e as Error).stack || e}`);
  }
  index.on("changed", (ids: string[]) => {
    // Edits GitHub now knows about no longer need the local overlay.
    overlay.settle(ids);
    broadcast("index-changed", ids);
  });

  scheduler = new SyncScheduler({
    isWindowVisible: () => !!mainWin && mainWin.isVisible() && !mainWin.isMinimized(),
    devices,
    pendingUploads: (sessions) => {
      if (!index.ready) return 0;
      const rows = index.db.prepare("SELECT id, local_mtime_ms FROM conversations WHERE local_mtime_ms IS NOT NULL AND item_count >= 0").all() as { id: string; local_mtime_ms: number }[];
      // Only conversations that sync knows: older local-only files are not waiting for anything.
      return rows.filter((r) => {
        const pushed = sessions[r.id]?.pushedAt;
        return !!pushed && r.local_mtime_ms > Date.parse(pushed) + 5000;
      }).length;
    },
    onDownloaded: () => index.scan("download"),
    appVersion: APP_VERSION,
    skipIds: () => [...chat.openIds()],
  });
  scheduler.on("status", (st) => broadcast("sync-status", st));
  void scheduler.start();
  // The model menu's list, fetched quietly once the app has settled.
  setTimeout(() => knownModels(claudeInstall().path), 20_000).unref();
  setTimeout(checkForUpdate, 15_000).unref();
  setInterval(checkForUpdate, 2 * 60_000).unref();
  // In another workspace, the first one still syncs now and then: it brings the
  // app's updates and keeps its own conversations current for /resume.
  // (Not when the first workspace is disconnected on this PC, or was never set up here.)
  const mainHere = listWorkspaces().workspaces[0];
  if (currentWorkspace().id !== "main" && !mainHere.disconnected && fs.existsSync(path.join(mainHere.syncHome, "config.json"))) {
    const keepMainCurrent = () => {
      const child = spawn(process.execPath, [baseEngine(), "pull-all", "--json"], { env: { ...baseEnv(), ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: "ignore" });
      child.on("error", (e) => log("sync", `main workspace sync could not start: ${e.message}`));
    };
    setTimeout(keepMainCurrent, 45_000).unref();
    setInterval(keepMainCurrent, 10 * 60_000).unref();
  }
  // With more than one workspace, Open in CLI starts Claude Code through the workspace's
  // own command, which sets its folders: a Windows Terminal window another workspace
  // opened keeps that workspace's environment for its new tabs.
  if (listWorkspaces().workspaces.length > 1) {
    const launcher = launcherPath(currentWorkspace());
    if (launcher && writeLauncher(currentWorkspace())) process.env.CONVERSATIONS_CLAUDE_LAUNCHER = launcher;
  }
  setTimeout(() => void updateUsage(0), 4_000).unref();
  setTimeout(() => sweepPidFiles(), 30_000).unref();
  setInterval(() => {
    if (mainWin?.isVisible() && !mainWin.isMinimized()) void updateUsage(4 * 60_000);
  }, 5 * 60_000).unref();

  registerProtocol();
  let lastBusy = new Set<string>();
  let usageAfterReply: NodeJS.Timeout | null = null;
  chat.on("status", (st) => {
    broadcast("chat-status", st);
    // The list's Live marks follow the app's own running chats.
    const busy = chat.runningIds();
    // A reply just finished: the meters moved.
    if ([...lastBusy].some((x) => !busy.has(x))) {
      if (usageAfterReply) clearTimeout(usageAfterReply);
      usageAfterReply = setTimeout(() => void updateUsage(30_000), 4_000);
    }
    const flipped = [...busy].filter((x) => !lastBusy.has(x)).concat([...lastBusy].filter((x) => !busy.has(x)));
    lastBusy = busy;
    if (flipped.length) broadcast("index-changed", flipped);
    updateTrayBadge(true);
  });
  // Claude Code moved a chat to a new conversation (/clear): the window follows it.
  chat.on("rekeyed", (before: string, after: string) => {
    broadcast("index-changed", [before, after]);
    if (shownId !== before) return;
    // Opened once the index has it (Claude Code writes the new file a moment later), for up to 15 s.
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
  // Every conversation the app chats in (new or continued) stays visible, here and on the other PCs.
  chat.on("owned", (id: string, cwd: string) => {
    index.own(id, cwd);
    void markAppOwned(id);
  });
  // pull-all leaves conversations the app has open alone; once one closes, it is brought up to date.
  chat.on("closed", () => scheduler?.retrySoon());
  chat.on("changed", () => updateTrayBadge());
  chat.on("permission", (p) => {
    updateTrayBadge();
    const watching = !!mainWin && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused();
    if (!watching) {
      const title = (index.db.prepare("SELECT title FROM conversations WHERE id = ?").get(p.conversationId) as { title?: string } | undefined)?.title ?? "A conversation";
      notifyApproval(p, title, () => openConversation(p.conversationId));
    }
  });

  buildTray();
  const hidden = process.argv.includes("--hidden");
  if (!settings.get().welcomed && !hidden) showWelcome();
  else ensureMain(!hidden);
  void themeColors;

  // This is the primary instance (it holds the lock): record which staged copy it
  // runs from, then tidy old copies. A second instance never does either.
  const stageRoot = process.env.CONVERSATIONS_STAGE_ROOT;
  const appDist = process.env.CONVERSATIONS_APP_DIST;
  if (stageRoot && appDist) {
    try {
      writeRunningMark(stageRoot, appDist);
      const gone = cleanStages(stageRoot, appDist, undefined, forwarderStage ? [forwarderStage] : []);
      if (gone.length) log("app", `removed ${gone.length} old copy/copies of the app`);
    } catch (e) {
      log("app", `could not tidy old app copies: ${(e as Error).message}`);
    }
  }

  // Start-up is done: anything a second instance asked for in the meantime happens now.
  secondInstances.finish();
});
