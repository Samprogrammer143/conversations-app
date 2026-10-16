// Open in CLI: carry a conversation on in Claude Code in Windows Terminal, with
// exactly one writer and in the folder where --resume finds it. The rules are in
// handover.ts; this file connects them to the PC.

import fs from "node:fs";
import { spawn } from "node:child_process";
import { dialog, type BrowserWindow } from "electron";
import { hasWindowsTerminal, refreshClaude } from "./claude";
import { encodePowerShell, focusScript, terminalCommand } from "./launch";
import { handOver, type PullOutcome } from "./handover";
import { folderForTranscript } from "./resume-folder";
import { sessionProcesses } from "./chat/terminals";
import { detectEngineVersion, runEngineSerial } from "./sync/engine-bridge";
import { settings } from "./settings";
import { log } from "./log";

export async function chooseFolder(win: BrowserWindow | null, projectLabel: string): Promise<string | null> {
  const opts = { title: `Where is ${projectLabel} on this PC?`, properties: ["openDirectory" as const], buttonLabel: "Use this folder" };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
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
export async function pullConversation(id: string, cwd: string): Promise<PullOutcome | null> {
  if ((await detectEngineVersion()) < 3) return null;
  const r = await runEngineSerial<{ ok?: boolean; code?: string; dest?: string; err?: string }>(["pull", id, "--cwd", cwd, "--json"], { timeoutMs: 5 * 60_000 });
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
