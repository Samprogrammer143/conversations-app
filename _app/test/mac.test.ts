// The Mac's differences, checked on any system: the login shell's PATH, finding Claude
// Code, the menu bar icon, start at login, the claude-<id> command, the flyout's place,
// and which PC a Mac's entries come from.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Conversations", isPackaged: false, setLoginItemSettings: () => {}, getPath: () => "/tmp" },
  Menu: { buildFromTemplate: (t: unknown) => t },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  screen: {},
  shell: {},
}));
vi.mock("../src/main/log", () => ({ log: () => {} }));

const { mergePath, parseShellPath, usualMacFolders } = await import("../src/shared/login-path");
const { knownCandidates, onPath } = await import("../src/main/claude");
const { appBundle, findGh, launchAgentPlist, trayIconFile } = await import("../src/main/mac");
const { launcherScript } = await import("../src/main/workspace-actions");
const { flyoutBounds } = await import("../src/main/windows");
const { profilePrefix } = await import("../src/main/index/indexer");
const { macFocusCommand, macTerminalCommand, shQuote } = await import("../src/main/launch");
const { processNameFromPs } = await import("../src/main/chat/terminals");

describe("Open in Terminal on a Mac", () => {
  it("passes the command to AppleScript as an argument, quoted for the shell", () => {
    const c = macTerminalCommand("/Users/alex/it's a & b", "/Users/alex/.local/bin/claude", ["--resume", "abc"]);
    expect(c.file).toBe("/usr/bin/osascript");
    const line = c.args[c.args.length - 1];
    expect(line).toBe(`cd '/Users/alex/it'\\''s a & b' && exec '/Users/alex/.local/bin/claude' '--resume' 'abc'`);
    // The script's own text never contains the folder.
    expect(c.args.slice(0, -1).join(" ")).not.toContain("alex");
    expect(c.args.filter((a) => a === "-e").length).toBe(6);
  });
  it("quotes for a POSIX shell", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("$HOME `x` \"y\"")).toBe(`'$HOME \`x\` "y"'`);
  });
  it("brings a Terminal tab forward only for a real terminal device", () => {
    expect(macFocusCommand("ttys003")?.args.at(-1)).toBe("/dev/ttys003");
    expect(macFocusCommand("??")).toBeNull();
    expect(macFocusCommand("ttys003; rm -rf ~")).toBeNull();
  });
});

describe("which programs are Claude Code on a Mac", () => {
  it("reads the name it was started with, not the versioned file", () => {
    expect(processNameFromPs("claude --resume abc\n")).toBe("claude");
    expect(processNameFromPs("/Users/alex/.local/bin/claude")).toBe("claude");
    expect(processNameFromPs("node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe("claude");
    expect(processNameFromPs("/usr/bin/vim notes.txt")).toBe("vim");
    expect(processNameFromPs("")).toBeNull();
  });
});

describe("the login shell's PATH", () => {
  it("is read from between the marks, whatever the shell prints around it", () => {
    expect(parseShellPath("Last login: today\n__CONVERSATIONS_PATH__/opt/homebrew/bin:/usr/bin__CONVERSATIONS_PATH__\n")).toBe("/opt/homebrew/bin:/usr/bin");
    expect(parseShellPath("no marks here")).toBeNull();
    expect(parseShellPath("__CONVERSATIONS_PATH____CONVERSATIONS_PATH__")).toBeNull();
  });
  it("comes first, then what the app was given, then the usual folders, each once", () => {
    const usual = usualMacFolders("/Users/alex");
    expect(usual).toContain("/Users/alex/.local/bin");
    const merged = mergePath("/Users/alex/.nvm/bin:/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/usr/sbin:/sbin", usual).split(":");
    expect(merged.slice(0, 3)).toEqual(["/Users/alex/.nvm/bin", "/opt/homebrew/bin", "/usr/bin"]);
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged).toContain("/usr/local/bin");
  });
  it("still has the usual folders when the shell can't be asked", () => {
    expect(mergePath(null, "/usr/bin:/bin", usualMacFolders("/Users/alex")).split(":")).toContain("/opt/homebrew/bin");
  });
});

describe("finding Claude Code", () => {
  it("looks where a Mac installs it", () => {
    const c = knownCandidates("darwin", "/Users/alex", {});
    expect(c[0]).toBe("/Users/alex/.local/bin/claude");
    expect(c).toContain("/opt/homebrew/bin/claude");
    expect(c).toContain("/Users/alex/.npm-global/bin/claude");
    expect(c.every((p) => !p.endsWith(".exe"))).toBe(true);
  });
  it("tries a path set for it first", () => {
    expect(knownCandidates("darwin", "/Users/alex", { CONVERSATIONS_CLAUDE_PATH: "/x/claude" })[0]).toBe("/x/claude");
  });
  it("keeps the Windows places on Windows", () => {
    const c = knownCandidates("win32", "C:\\Users\\alex", { APPDATA: "C:\\Users\\alex\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\alex\\AppData\\Local" });
    expect(c.length).toBe(3);
    expect(c.every((p) => p.endsWith("claude.exe"))).toBe(true);
  });
  it("checks each PATH folder, skipping relative ones", () => {
    expect(onPath("/opt/homebrew/bin:bin:/usr/local/bin")).toEqual(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
  });
});

describe("the menu bar icon", () => {
  it("is a template image on a Mac and the .ico on Windows", () => {
    expect(trayIconFile(false, "darwin")).toBe("trayTemplate.png");
    expect(trayIconFile(true, "darwin")).toBe("trayBadgeTemplate.png");
    expect(trayIconFile(false, "win32")).toBe("tray.ico");
    expect(trayIconFile(true, "win32")).toBe("tray-badge.ico");
  });
});

describe("start at login on a Mac", () => {
  it("knows the .app the running copy is part of", () => {
    expect(appBundle("/Applications/Conversations.app/Contents/MacOS/Conversations")).toBe("/Applications/Conversations.app");
    expect(appBundle("/Users/alex/Applications/Conversations.app/Contents/MacOS/Conversations")).toBe("/Users/alex/Applications/Conversations.app");
    expect(appBundle("C:\\Program Files\\Conversations\\Conversations.exe")).toBeNull();
  });
  it("opens the app out of sight, with the same --hidden as Windows", () => {
    const plist = launchAgentPlist("/Users/a&b/Applications/Conversations.app");
    expect(plist).toContain("<string>/usr/bin/open</string>");
    expect(plist).toContain("<string>-g</string>");
    expect(plist).toContain("<string>--hidden</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("/Users/a&amp;b/Applications/Conversations.app");
    expect(plist).not.toContain("a&b");
  });
});

describe("GitHub's sign-in tool on a Mac", () => {
  it("is a gh program, or nothing", () => {
    // (Homebrew's folders are always looked in: a test Mac may have gh there.)
    const gh = findGh("/no/such/folder", "/no/such/data");
    expect(gh === null || gh.endsWith("/gh")).toBe(true);
  });
});

describe("the claude-<id> command", () => {
  it("is a shell script on a Mac that sets the workspace's folders", () => {
    const s = launcherScript("darwin", "/Users/alex/.local/bin/claude", { CLAUDE_CONFIG_DIR: "/Users/alex/.claude-work", CLAUDE_SYNC_HOME: "/Users/alex/Library/Application Support/claude-conversation-sync-work" }, "Work");
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    expect(s).toContain("export CLAUDE_CONFIG_DIR='/Users/alex/.claude-work'");
    expect(s).toContain("export CLAUDE_SYNC_HOME='/Users/alex/Library/Application Support/claude-conversation-sync-work'");
    expect(s).toContain(`exec '/Users/alex/.local/bin/claude' "$@"`);
  });
  it("quotes a folder with a quote in it, and clears what the first workspace doesn't set", () => {
    const s = launcherScript("darwin", "claude", { CLAUDE_CONFIG_DIR: "/Users/o'brien/.claude-x" }, "X");
    expect(s).toContain(`export CLAUDE_CONFIG_DIR='/Users/o'\\''brien/.claude-x'`);
    expect(s).toContain("unset CLAUDE_SYNC_HOME");
    expect(s).toContain(`exec claude "$@"`);
  });
  it("stays a .cmd on Windows", () => {
    const s = launcherScript("win32", "C:\\x\\claude.exe", { CLAUDE_CONFIG_DIR: "C:\\Users\\a\\.claude-w", CLAUDE_SYNC_HOME: "D:\\100%" }, "W");
    expect(s).toBe(['@echo off', 'set "CLAUDE_CONFIG_DIR=C:\\Users\\a\\.claude-w"', 'set "CLAUDE_SYNC_HOME=D:\\100%%"', '"C:\\x\\claude.exe" %*', ""].join("\r\n"));
  });
});

describe("the tray popover's place", () => {
  const screenBounds = { x: 0, y: 0, width: 1512, height: 982 };
  it("opens just below a Mac's menu bar icon", () => {
    const area = { x: 0, y: 25, width: 1512, height: 957 };
    const b = flyoutBounds(area, screenBounds, { x: 1200, y: 0, width: 24, height: 24 }, 420);
    expect(b.y).toBe(31);
    expect(b.x).toBe(Math.round(1212 - 190));
  });
  it("opens above the Windows taskbar, as before", () => {
    const area = { x: 0, y: 0, width: 1512, height: 934 };
    const b = flyoutBounds(area, screenBounds, { x: 1400, y: 940, width: 24, height: 40 }, 420);
    expect(b.y).toBe(934 - 420 - 12);
    expect(b.x).toBe(1512 - 380 - 12);
  });
});

describe("which PC an entry comes from", () => {
  it("knows a Mac's home folder", () => {
    expect(profilePrefix("/Users/Alex/Projects/site")).toBe("/users/alex");
    expect(profilePrefix("/home/alex/x")).toBe("/home/alex");
    expect(profilePrefix("/tmp/x")).toBeNull();
  });
  it("still knows a Windows user folder, either slash", () => {
    expect(profilePrefix("C:\\Users\\Alex\\site")).toBe("c:\\users\\alex");
    expect(profilePrefix("C:/Users/Alex/site")).toBe("c:\\users\\alex");
  });
});
