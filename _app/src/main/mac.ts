// What a Mac needs that Windows doesn't, or does differently: the menu bar icon's
// images, start at login, and the app menu (the Mac's menu bar always has one: without
// it Cmd+C and Cmd+V do nothing in a text box).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { log } from "./log";

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
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
