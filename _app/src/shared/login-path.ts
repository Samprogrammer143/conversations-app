// A Mac app started from the Finder, the Dock or at login gets launchd's PATH:
// /usr/bin:/bin:/usr/sbin:/sbin. The user's own tools (Homebrew's git, node and npm,
// Claude Code in ~/.local/bin, whatever their MCP servers run) are on the PATH their login
// shell sets up, so that is read from the shell, and everything the app starts after that
// inherits it. Only PATH is taken from the shell. Elsewhere this does nothing.

import { spawn } from "node:child_process";
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

/**
 * The login shell's PATH, asked as Terminal starts it (interactive and login, so .zshrc's
 * additions such as nvm count too). The shell is stopped the moment it has printed PATH, so
 * an rc file that leaves something running in the background can't keep it waiting, and
 * after `timeoutMs` at the most. Null if it can't tell.
 */
export function readLoginShellPath(shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh", timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child: ReturnType<typeof spawn>;
    try {
      // A process group of its own, so what the rc files start goes with it.
      child = spawn(shell, ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_DISABLE_COMPFIX: "true" },
      });
    } catch {
      resolve(null);
      return;
    }
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(parseShellPath(out)), timeoutMs);
    child.stdout?.on("data", (d) => {
      out += d;
      const value = parseShellPath(out);
      if (value) finish(value);
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseShellPath(out)));
  });
}

/**
 * Gives the app the user's PATH without holding up its start: the PATH the shell gave last
 * time (kept in `cacheFile`) is used at once, and the shell is asked again in the background.
 * When it answers, PATH is updated for everything started from then on, and kept for next time.
 */
export function useLoginShellPath(cacheFile?: string): Promise<void> {
  // Once per app: what it starts inherits both the PATH and this mark.
  if (process.platform !== "darwin" || process.env.CONVERSATIONS_LOGIN_PATH) return Promise.resolve();
  process.env.CONVERSATIONS_LOGIN_PATH = "1";
  const given = process.env.PATH;
  let remembered: string | null = null;
  try {
    if (cacheFile) remembered = JSON.parse(fs.readFileSync(cacheFile, "utf8"))?.path ?? null;
  } catch {}
  process.env.PATH = mergePath(remembered, given, usualMacFolders());
  return readLoginShellPath().then((fresh) => {
    if (!fresh) return;
    process.env.PATH = mergePath(fresh, given, usualMacFolders());
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ path: fresh, at: new Date().toISOString() }));
    } catch {}
  });
}
