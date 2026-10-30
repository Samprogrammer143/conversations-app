// Open in CLI: carry a conversation on in Claude Code in Windows Terminal, with
// exactly one writer and in the folder where --resume finds it. The rules are in
// handover.ts; this file connects them to the PC.

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { app, dialog, type BrowserWindow } from "electron";
import { hasWindowsTerminal, refreshClaude } from "./claude";
import { encodePowerShell, focusScript, terminalCommand } from "./launch";
import { handOver, type PullOutcome } from "./handover";
import { folderForTranscript, safeFolderName } from "./resume-folder";
import { sessionProcesses } from "./chat/terminals";
import { detectEngineVersion, runEngineSerial } from "./sync/engine-bridge";
import { settings } from "./settings";
import { log } from "./log";

/**
 * A chat from another PC, whose folder isn't known here: says what is being asked first
 * (Windows' folder picker shows no explanation), then your copy of the project or a new folder.
 */
export async function chooseFolder(win: BrowserWindow | null, projectLabel: string, fromOtherPc = true): Promise<string | null> {
  const ask: Electron.MessageBoxOptions = {
    type: "question",
    title: "Conversations",
    message: `Where should Claude work on this PC?`,
    detail: fromOtherPc
      ? `This chat ran in ${projectLabel} on another PC, and this PC doesn't know that folder. Pick your copy of the project, or start with a new empty folder. The whole conversation comes along, but files that are only on the other PC don't.`
      : `This PC doesn't know where ${projectLabel} is yet. Pick your copy of the project, or start with a new empty folder.`,
    buttons: ["Pick my copy", "New empty folder", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const { response } = win ? await dialog.showMessageBox(win, ask) : await dialog.showMessageBox(ask);
  if (response === 2) return null;
  if (response === 1) {
    // New and empty, as it says: one that already has files gets a number.
    const base = path.join(app.getPath("documents"), safeFolderName(projectLabel));
    let dir = base;
    try {
      for (let i = 2; fs.existsSync(dir) && (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length); i++) dir = `${base} ${i}`;
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      log("cli", `could not make ${dir}: ${(e as Error).message}`);
      return null;
    }
  }
  const opts = { title: `Your copy of ${projectLabel}`, properties: ["openDirectory" as const], buttonLabel: "Use this folder" };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

/** Downloads, the Desktop or the home folder: fine for one chat, never remembered as a project's folder. */
export function isGenericFolder(p: string): boolean {
  const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return (["downloads", "desktop", "home"] as const).some((n) => same(p, app.getPath(n)));
}

export function launchInTerminal(folder: string, exe: string, args: string[]): void {
  const c = terminalCommand(folder, exe, args, hasWindowsTerminal());
  const child = spawn(c.file, c.args, { cwd: folder, detached: true, stdio: "ignore", windowsHide: c.file !== "wt.exe" });
  child.on("error", (e) => log("cli", `could not start ${c.file}: ${e.message}`));
  child.unref();
}

/** Best effort: the window of a running Claude Code comes to the front (Windows Terminal: its window, not the tab). */
export function focusProcessWindow(pid: number) {
  if (process.platform !== "win32") return;
  let script: string;
  try {
    script = focusScript(pid);
  } catch {
    return;
  }
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => child.kill(), 15_000);
  child.on("error", () => clearTimeout(timer));
  child.on("close", () => clearTimeout(timer));
}

const isDir = (p: string | null | undefined): p is string => {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Brings the newest copy of a conversation into cwd's Claude Code folder.
 * null when this PC's sync engine can't (version 2).
 */
export async function pullConversation(id: string, cwd: string, into = false): Promise<PullOutcome | null> {
  if ((await detectEngineVersion()) < 3) return null;
  const r = await runEngineSerial<{ ok?: boolean; code?: string; dest?: string; err?: string }>(["pull", id, "--cwd", cwd, "--json", ...(into ? ["--into-cwd"] : [])], { timeoutMs: 5 * 60_000 });
  if (r.json?.code === "live") return { ok: false, live: true };
  if (r.json?.ok && r.json.dest) return { ok: true, dest: r.json.dest };
  const err = r.json?.err ?? r.stderr.split(/\r?\n/).find((l) => l.trim()) ?? null;
  log("cli", `pull of ${id.slice(0, 8)} failed: ${err ?? `exit ${r.code}`}`);
  return { ok: false, err };
}

export async function openInCli(args: {
  id: string;
  projectId: string;
  projectLabel: string;
  /** The project's folder on this PC, if known. */
  folder: string | null;
  /** The folder the conversation itself ran in. */
  recordedCwd: string | null;
  win: BrowserWindow | null;
  stopAppSession: (id: string) => Promise<void>;
  appLastWriteAt: (id: string) => number;
  localTranscript: (id: string) => string | null;
}): Promise<{ ok: boolean; message: string }> {
  const claude = await refreshClaude();
  if (!claude.found || !claude.path) return { ok: false, message: "Claude Code isn't installed on this PC" };
  // In a workspace other than the first, its own `claude-<id>` command (it carries the workspace's folders).
  const exe = process.env.CONVERSATIONS_CLAUDE_LAUNCHER || claude.path;
  let projectFolder = isDir(args.folder) ? args.folder : null;
  const recordedCwd = isDir(args.recordedCwd) ? args.recordedCwd : null;
  let picked: string | null = null;
  // The chat's own file on this PC can say which folder it belongs to here.
  if (!projectFolder && !recordedCwd) {
    const local = args.localTranscript(args.id);
    projectFolder = local ? folderForTranscript(local, []) : null;
  }
  if (!projectFolder && !recordedCwd) {
    picked = projectFolder = await chooseFolder(args.win, args.projectLabel);
    if (!projectFolder) return { ok: false, message: "Open in CLI needs the project's folder" };
    if (!isGenericFolder(projectFolder)) settings.set({ folders: { ...settings.get().folders, [args.projectId]: projectFolder } });
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
        chooseFolder: async () => picked ?? chooseFolder(args.win, args.projectLabel),
        pullInto: (id, cwd) => pullConversation(id, cwd, true),
        localTranscript: args.localTranscript,
        appLastWriteAt: args.appLastWriteAt,
        mtimeOf: (f) => {
          try {
            return fs.statSync(f).mtimeMs;
          } catch {
            return null;
          }
        },
        folderFor: (t, c) => folderForTranscript(t, c),
        launch: (folder, id) => launchInTerminal(folder, exe, ["--resume", id]),
        focus: focusProcessWindow,
      },
    );
    if (!r.ok) log("cli", `Open in CLI for ${args.id.slice(0, 8)} refused: ${r.message}`);
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return { ok: false, message: `Couldn't start Windows Terminal: ${(e as Error).message}` };
  }
}

export async function newChatInCli(folder: string): Promise<{ ok: boolean; message: string }> {
  const claude = await refreshClaude();
  if (!claude.found || !claude.path) return { ok: false, message: "Claude Code isn't installed on this PC" };
  launchInTerminal(folder, process.env.CONVERSATIONS_CLAUDE_LAUNCHER || claude.path, []);
  return { ok: true, message: "Claude Code started in Windows Terminal" };
}
