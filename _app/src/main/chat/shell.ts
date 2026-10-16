// "!" in the composer: a shell command run straight away in the conversation's
// folder, as Claude Code's bash mode runs it. The command and what it printed go
// into the conversation the way the CLI writes them, so Claude sees them with
// your next message and a terminal that resumes the chat shows them too.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Stopped by you, or by the time limit. */
  stopped: "you" | "timeout" | null;
}

/** Each stream keeps this much, as Claude Code does; longer output keeps its start and end. */
export const MAX_OUTPUT = 30_000;
export const TIME_LIMIT_MS = 10 * 60_000;

const exists = (p: string | undefined | null): p is string => {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The shell Claude Code uses on Windows: Git Bash (its own setting first, then the
 * git on PATH, then the usual places). Elsewhere, the user's shell. Null when none.
 */
export function findShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): { file: string; args: (cmd: string) => string[]; name: "bash" | "powershell" | "sh" } | null {
  if (platform !== "win32") {
    const sh = env.SHELL && exists(env.SHELL) ? env.SHELL : "/bin/bash";
    return { file: sh, args: (c) => ["-c", c], name: "sh" };
  }
  const candidates: string[] = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    if (exists(path.join(dir, "git.exe"))) {
      // ...\Git\cmd\git.exe or ...\Git\bin\git.exe: bash is in ...\Git\bin.
      candidates.push(path.join(dir, "..", "bin", "bash.exe"), path.join(dir, "bash.exe"));
    }
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")]) {
    if (root) candidates.push(path.join(root, "Git", "bin", "bash.exe"));
  }
  const bash = candidates.map((c) => path.resolve(c)).find(exists);
  if (bash) return { file: bash, args: (c) => ["-c", c], name: "bash" };
  const ps = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (exists(ps)) return { file: ps, args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c], name: "powershell" };
  return null;
}

/** Keeps the start and the end of output longer than the limit. */
export function clipOutput(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n… ${s.length - max} characters not kept …\n\n${s.slice(-half)}`;
}

/**
 * Collects a stream's output without holding all of it: the first and last
 * MAX_OUTPUT / 2 characters, and how many were left out between them.
 */
export class OutputKeeper {
  private head = "";
  private tail = "";
  private total = 0;

  add(s: string) {
    this.total += s.length;
    // Each half a little under the limit, so the marker fits and clipOutput never cuts again.
    const half = MAX_OUTPUT / 2 - 150;
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (s) this.tail = (this.tail + s).slice(-half);
  }

  /** What was kept, with the number of characters left out (clipOutput's wording). */
  text(): string {
    const dropped = this.total - this.head.length - this.tail.length;
    return dropped > 0 ? `${this.head}\n\n… ${dropped} characters not kept …\n\n${this.tail}` : this.head + this.tail;
  }
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The two transcript messages the CLI writes for a bash-mode command. */
export function shellMessages(command: string, r: ShellResult): [string, string] {
  // Room is left for the note below, so the whole stays within the limit and is clipped once.
  let stderr = clipOutput(r.stderr, MAX_OUTPUT - 200);
  if (r.stopped === "you") stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}Stopped in the Conversations app.`;
  if (r.stopped === "timeout") stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}Stopped after ${TIME_LIMIT_MS / 60_000} minutes.`;
  return [`<bash-input>${escapeXml(command)}</bash-input>`, `<bash-stdout>${escapeXml(clipOutput(r.stdout))}</bash-stdout><bash-stderr>${escapeXml(clipOutput(stderr))}</bash-stderr>`];
}

/** Runs a helper without blocking the app's main process, giving up after a few seconds. */
function runQuietly(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const p = spawn(file, args, { windowsHide: true, stdio: "ignore" });
      const t = setTimeout(() => {
        p.kill();
        resolve();
      }, 5000);
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

/**
 * Ends a command and everything it started, including children it left running
 * after its shell exited. Git Bash emulates fork, so what a command starts can
 * lose its Windows parent and escape taskkill's tree: it is ended through Git
 * Bash's own process group first, and the Windows tree after.
 */
async function killTree(child: ChildProcess, bashGroup: { bash: string; pidFile: string } | null): Promise<void> {
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
    msysPid = bashGroup ? fs.readFileSync(bashGroup.pidFile, "utf8").trim() : "";
  } catch {}
  if (bashGroup && /^\d+$/.test(msysPid)) {
    await runQuietly(bashGroup.bash, ["-c", `kill -TERM -- -${msysPid} 2>/dev/null; sleep 0.3; kill -KILL -- -${msysPid} 2>/dev/null; true`]);
  }
  if (child.pid && child.exitCode === null) await runQuietly("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
}

export interface RunningShell {
  done: Promise<ShellResult>;
  stop(): void;
}

/** Runs one command in a folder with no input, collecting what it prints. */
export function runShell(command: string, cwd: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: ReturnType<typeof findShell> } = {}): RunningShell {
  const shell = opts.shell === undefined ? findShell(opts.env) : opts.shell;
  if (!shell) {
    return { done: Promise.resolve({ stdout: "", stderr: "No shell was found on this PC (Git for Windows provides the one Claude Code uses).", code: null, stopped: null }), stop: () => {} };
  }
  const env = { ...(opts.env ?? process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  // Git Bash starts in the folder it is given, as a terminal opened there would.
  env.CHERE_INVOKING = "1";
  let stopped: ShellResult["stopped"] = null;
  let child: ChildProcess;
  // Bash gets the command through the environment, so Windows never re-quotes it,
  // and notes its own process id first, so Stop can end everything it starts.
  const bashGroup = shell.name === "bash" && process.platform === "win32" ? { bash: shell.file, pidFile: path.join(os.tmpdir(), `conversations-shell-${process.pid}-${crypto.randomUUID()}.pid`) } : null;
  let args = shell.args(command);
  if (bashGroup) {
    env.CONVERSATIONS_SHELL_COMMAND = command;
    const pidPath = bashGroup.pidFile.replace(/\\/g, "/").replace(/'/g, `'\\''`);
    args = ["-c", `echo $$ > '${pidPath}'; eval "$CONVERSATIONS_SHELL_COMMAND"`];
  }
  try {
    // Elsewhere the command gets its own process group, so Stop reaches what it starts.
    child = spawn(shell.file, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch (e) {
    return { done: Promise.resolve({ stdout: "", stderr: (e as Error).message, code: null, stopped: null }), stop: () => {} };
  }
  const out = new OutputKeeper();
  const err = new OutputKeeper();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => out.add(d));
  child.stderr?.on("data", (d: string) => err.add(d));
  let finishNow: (() => void) | null = null;
  let settledFlag = false;
  const end = (why: "you" | "timeout") => {
    stopped ??= why;
    void killTree(child, bashGroup);
    // Whatever still holds the output open, the command counts as over in a moment.
    setTimeout(() => finishNow?.(), 3000).unref?.();
  };
  const timer = setTimeout(() => end("timeout"), opts.timeoutMs ?? TIME_LIMIT_MS);
  const done = new Promise<ShellResult>((resolve) => {
    const finish = (code: number | null, extraErr = "") => {
      if (settledFlag) return;
      settledFlag = true;
      clearTimeout(timer);
      // The pid file stays a moment longer, in case Stop is still reading it.
      if (bashGroup) setTimeout(() => fs.rm(bashGroup.pidFile, { force: true }, () => {}), 10_000).unref?.();
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
    // The shell has exited: something it left running (cmd &) may still hold the
    // output open. What has arrived is the result; the rest is not waited for.
    child.on("exit", () => setTimeout(() => finishNow?.(), 1500).unref?.());
  });
  return { done, stop: () => (settledFlag ? undefined : end("you")) };
}

/** Removes pid notes left in the temp folder by commands that were running when the app last closed. */
export function sweepPidFiles(dir = os.tmpdir(), olderThanMs = 60_000) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^conversations-shell-\d+-[0-9a-f-]{36}\.pid$/.test(name)) continue;
      const f = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(f).mtimeMs > olderThanMs) fs.rmSync(f, { force: true });
      } catch {}
    }
  } catch {}
}
