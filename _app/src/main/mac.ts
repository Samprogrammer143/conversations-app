// What a Mac needs that Windows doesn't, or does differently: the menu bar icon's
// images, start at login, and the app menu (the Mac's menu bar always has one: without
// it Cmd+C and Cmd+V do nothing in a text box).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { app, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import { log } from "./log";
import { macTerminalLine, shQuote } from "./launch";
import { defaultDataDir } from "../shared/dirs";

export const isMac = process.platform === "darwin";

/** The tray icon's file. On a Mac a "template" image: black on clear, drawn light or dark to match the menu bar. */
export function trayIconFile(badge: boolean, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return badge ? "trayBadgeTemplate.png" : "trayTemplate.png";
  return badge ? "tray-badge.ico" : "tray.ico";
}

// ------------------------------------------------------------ start at login

const AGENT = "com.samcan.conversations.login";
export const launchAgentFile = (home = os.homedir()) => path.join(home, "Library", "LaunchAgents", `${AGENT}.plist`);

/** The .app the running copy is part of (…/Conversations.app/Contents/MacOS/Conversations), or null. */
export function appBundle(exe = process.execPath): string | null {
  const m = exe.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A LaunchAgent that opens the app at login, out of sight (`open -g`, with --hidden as on
 * Windows). macOS's own login items need an app signed with a paid Apple account and
 * can't pass --hidden; launchd reads this file at every login, signed or not.
 */
export function launchAgentPlist(bundle: string): string {
  const args = ["/usr/bin/open", "-g", "-a", bundle, "--args", "--hidden"];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${AGENT}</string>`,
    // (So macOS's Login Items list shows it as Conversations, not "open".)
    "  <key>AssociatedBundleIdentifiers</key><string>com.samcan.conversations</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Starts the app at login, or stops doing so. Windows: its own login entry; Mac: the LaunchAgent. */
export function setStartAtLogin(on: boolean): void {
  if (!isMac) {
    app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
    return;
  }
  const file = launchAgentFile();
  const bundle = appBundle();
  try {
    // Written, not loaded: loading it now would open the app again at once.
    if (on && bundle) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, launchAgentPlist(bundle));
    } else fs.rmSync(file, { force: true });
  } catch (e) {
    log("app", `could not ${on ? "set" : "clear"} start at login: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------ GitHub sign-in

/** GitHub's own command line tool: on PATH, from Homebrew, or the copy the Mac set-up fetched. */
export function findGh(envPath = process.env.PATH ?? "", dataDir = defaultDataDir()): string | null {
  const dirs = [...envPath.split(":").filter((d) => d.startsWith("/")), "/opt/homebrew/bin", "/usr/local/bin", path.posix.join(dataDir, "gh")];
  for (const d of dirs) {
    const p = path.posix.join(d, "gh");
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * Signing in to GitHub on a Mac, which has no Git Credential Manager (Windows' git brings
 * it): gh signs in through the browser in a Terminal window and hands git the login.
 * Answers with what to tell you, as the Windows sign-in's result does.
 */
export function macGitHubSignIn(): { ok: boolean; err?: string } {
  const gh = findGh();
  if (!gh) return { ok: false, err: "Signing in to GitHub on a Mac uses GitHub's own tool: install it (brew install gh, or cli.github.com), then try again." };
  const q = shQuote(gh);
  openTerminal(macTerminalLine(`${q} auth login --hostname github.com --git-protocol https --web && ${q} auth setup-git --hostname github.com`), "sign in to GitHub");
  return { ok: false, err: "Finish signing in to GitHub in the Terminal window that opened, then choose Sync now." };
}

/**
 * Runs an osascript command that opens Terminal. The first time, macOS asks whether
 * Conversations may control Terminal; if that was refused, it says where to allow it
 * rather than nothing happening.
 */
export function openTerminal(c: { file: string; args: string[] }, what: string): void {
  // (Up to three minutes: the first time, osascript waits while macOS asks you whether to allow it.)
  execFile(c.file, c.args, { timeout: 180_000 }, (err, _out, stderr) => {
    if (!err) return;
    log("app", `could not open Terminal to ${what}: ${String(stderr || err.message).trim().split("\n").pop()}`);
    const refused = /-1743|not allowed|not authori[sz]ed/i.test(String(stderr) + err.message);
    void dialog.showMessageBox({
      type: "warning",
      message: refused ? "Conversations isn't allowed to open Terminal" : "Terminal didn't open",
      detail: refused ? "Allow it in System Settings, Privacy & Security, Automation: turn on Terminal under Conversations. Then try again." : `Conversations couldn't open Terminal to ${what}. Try again in a moment.`,
    });
  });
}

// ------------------------------------------------------------ the app menu

export function macAppMenu(actions: { settings: () => void; quit: () => void; quitLabel: string }): Menu {
  const name = app.name;
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: actions.settings },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        // The app's own Quit: it tidies up (chats, sync, the open-windows record) before going.
        { label: actions.quitLabel, accelerator: "Cmd+Q", click: actions.quit },
      ],
    },
    { role: "editMenu" },
    // Reload and the developer tools only while developing: a reload loses the window's state.
    { label: "View", submenu: [...(app.isPackaged ? [] : ([{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }] as MenuItemConstructorOptions[])), { role: "togglefullscreen" }] },
    // (The Window menu's own role has no Close: Cmd+W needs it here.)
    { role: "window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }, { type: "separator" }, { role: "front" }] },
  ];
  return Menu.buildFromTemplate(template);
}
