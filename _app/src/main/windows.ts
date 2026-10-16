// The app's windows: the main window, Settings, and the tray flyout.
// Native caption buttons and Snap layouts come from titleBarOverlay; Mica sits
// behind the sidebar; everything else is drawn by the page.

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, nativeTheme, screen, shell, type Rectangle } from "electron";
import { appDataDir } from "./paths";
import { settings } from "./settings";

export interface WindowFiles {
  preload: string;
  /** file:// path of the renderer's index.html, or a dev server URL. */
  page: string;
  icon?: string;
}

const LIGHT = { window: "#f3f3f6", content: "#ffffff", symbols: "#1d1d1f" };
const DARK = { window: "#18181a", content: "#1e1e1e", symbols: "#f5f5f7" };
export const themeColors = () => (nativeTheme.shouldUseDarkColors ? DARK : LIGHT);

function boundsFile() {
  return path.join(appDataDir(), "window.json");
}

function savedBounds(): { bounds?: Rectangle; maximized?: boolean } {
  try {
    const v = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    const area = screen.getDisplayMatching(v.bounds).workArea;
    // Ignore a position that is no longer on any screen.
    if (v.bounds.x < area.x - 50 || v.bounds.y < area.y - 50 || v.bounds.x > area.x + area.width - 100) return { maximized: v.maximized };
    return v;
  } catch {
    return {};
  }
}

function loadPage(win: BrowserWindow, files: WindowFiles, hash: string) {
  if (files.page.startsWith("http")) void win.loadURL(`${files.page}#${hash}`);
  else void win.loadFile(files.page, { hash });
}

function lockDown(win: BrowserWindow) {
  // Links open in the browser; the window itself never navigates away.
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

export function createMainWindow(files: WindowFiles, { show }: { show: boolean }): BrowserWindow {
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
    icon: files.icon,
    backgroundColor: useMica ? "#00000000" : c.window,
    backgroundMaterial: useMica ? "mica" : "none",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: c.content, symbolColor: c.symbols, height: 52 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: files.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: ["--window-kind=main"],
    },
  });
  lockDown(win);
  loadPage(win, files, "/");
  if (saved.maximized) win.maximize();
  win.once("ready-to-show", () => {
    if (show) win.show();
  });
  const persist = () => {
    try {
      fs.writeFileSync(boundsFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {}
  };
  win.on("resized", persist);
  win.on("moved", persist);
  win.on("maximize", persist);
  win.on("unmaximize", persist);
  return win;
}

export function setTitleBarColors(win: BrowserWindow, colors?: { background: string; symbols: string }) {
  const c = themeColors();
  try {
    win.setTitleBarOverlay({ color: colors?.background ?? c.content, symbolColor: colors?.symbols ?? c.symbols, height: 52 });
  } catch {}
}

export function createSettingsWindow(files: WindowFiles, parent: BrowserWindow | null, section?: string): BrowserWindow {
  const c = themeColors();
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Settings",
    icon: files.icon,
    backgroundColor: c.window,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: c.content, symbolColor: c.symbols, height: 52 },
    autoHideMenuBar: true,
    webPreferences: { preload: files.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--window-kind=settings"] },
  });
  lockDown(win);
  loadPage(win, files, `/settings/${section ?? "general"}`);
  win.once("ready-to-show", () => {
    if (parent && !parent.isDestroyed()) {
      const p = parent.getBounds();
      win.setPosition(Math.round(p.x + (p.width - 860) / 2), Math.round(p.y + (p.height - 640) / 2));
    }
    win.show();
  });
  return win;
}

/** First run (S6): its own 560 × 643 window. Windows draws the 8 px corners and shadow. */
export function createWelcomeWindow(files: WindowFiles): BrowserWindow {
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
    icon: files.icon,
    backgroundColor: c.content,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    webPreferences: { preload: files.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--window-kind=welcome"] },
  });
  lockDown(win);
  loadPage(win, files, "/welcome");
  win.once("ready-to-show", () => win.show());
  return win;
}

export function createFlyout(files: WindowFiles): BrowserWindow {
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
    webPreferences: { preload: files.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--window-kind=flyout"] },
  });
  lockDown(win);
  loadPage(win, files, "/flyout");
  win.on("blur", () => win.hide());
  return win;
}

/** Places the flyout above the tray, 12 px clear of the taskbar, as Windows 11 does. */
export function placeFlyout(win: BrowserWindow, trayBounds: Rectangle, height: number) {
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const area = display.workArea;
  const width = 380;
  const h = Math.min(height, area.height - 24);
  const x = Math.min(area.x + area.width - width - 12, Math.max(area.x + 12, trayBounds.x + trayBounds.width / 2 - width / 2));
  const y = area.y + area.height - h - 12;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width, height: Math.round(h) });
}
