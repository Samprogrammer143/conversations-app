// A Mac app started from the Finder, the Dock or at login gets launchd's PATH:
// /usr/bin:/bin:/usr/sbin:/sbin. The user's own tools (Homebrew's git, node and npm,
// Claude Code in ~/.local/bin, whatever their MCP servers run) are on the PATH their login
// shell sets up, so that is read once, at start, and everything the app starts inherits it.
// Only PATH is taken from the shell. Elsewhere this does nothing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARK = "__CONVERSATIONS_PATH__";

/** The folders a Mac's tools are usually in, kept even if the shell can't be asked. */
export function usualMacFolders(home = os.homedir()): string[] {
  return ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.posix.join(home, ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
}

/** PATH as the login shell's output gives it (between the marks), or null. */
export function parseShellPath(out: string): string | null {
  const start = out.indexOf(MARK);
  const end = out.indexOf(MARK, start + MARK.length);
  if (start < 0 || end < 0) return null;
  const value = out.slice(start + MARK.length, end).trim();
  return value || null;
}

/** The PATH to use: the login shell's first, then what the app was given, then the usual folders; no repeats. */
export function mergePath(shellPath: string | null, current: string | undefined, usual: string[]): string {
  const parts = [...(shellPath ?? "").split(":"), ...(current ?? "").split(":"), ...usual];
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))].join(":");
}

export function useLoginShellPath(): void {
  // Once per app: what it starts inherits both the PATH and this mark.
  if (process.platform !== "darwin" || process.env.CONVERSATIONS_LOGIN_PATH) return;
  process.env.CONVERSATIONS_LOGIN_PATH = "1";
  let shellPath: string | null = null;
  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  try {
    // Interactive and login, as Terminal starts it, so .zshrc's additions (nvm and the like)
    // count too. No input, and a time limit, in case something in it waits for one.
    const out = execFileSync(shell, ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_DISABLE_COMPFIX: "true" },
    });
    shellPath = parseShellPath(out);
  } catch {}
  process.env.PATH = mergePath(shellPath, process.env.PATH, usualMacFolders());
}
