// Runs the sync engine (the repository's own _sync/sync.mjs, the code Claude
// Code's hooks run) as a child process. Electron runs it as plain Node, so a PC
// needs nothing installed besides git. Writes go one at a time; the engine's
// repo lock also keeps them apart from the hooks.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { engineScriptPath } from "../paths";
import { log } from "../log";

/**
 * Ends a process and everything it started. The engine runs git, and a git left
 * running would keep the working copy locked (index.lock) after the engine is gone.
 */
export function killTree(child: ChildProcess) {
  if (!child.pid) return;
  const plain = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  if (process.platform !== "win32") return plain();
  const k = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  k.on("error", plain);
  k.on("close", (code) => {
    if (code !== 0) plain();
  });
}

export interface EngineResult<T = Record<string, unknown>> {
  ok: boolean;
  code: number | null;
  json: T | null;
  stderr: string;
  /** Everything the engine printed (its JSON is the last line). */
  stdout: string;
  ms: number;
}

/** The engine the app uses: the sync working copy's, or a development copy. */
export function engineScript(): string {
  return engineScriptPath();
}

let engineVersion: number | null = null;

export function runEngine<T = Record<string, unknown>>(args: string[], { timeoutMs = 10 * 60_000, env = {} as Record<string, string> } = {}): Promise<EngineResult<T>> {
  const script = engineScript();
  const t0 = Date.now();
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) {
      resolve({ ok: false, code: null, json: null, stderr: `Sync engine not found at ${script}`, stdout: "", ms: 0 });
      return;
    }
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      log("engine", `${args[0]} took longer than ${Math.round(timeoutMs / 1000)} s; stopping it and the git it started`);
      killTree(child);
      // If the kill doesn't take, the caller still gets an answer rather than waiting forever.
      grace = setTimeout(() => {
        if (settled) return;
        settled = true;
        log("engine", `${args[0]} did not stop after being killed; giving up on it`);
        resolve({ ok: false, code: null, json: null, stderr: `${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`, stdout: out, ms: Date.now() - t0 });
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (settled) return;
      settled = true;
      let json: T | null = null;
      const last = out.trim().split("\n").pop();
      if (last) {
        try {
          json = JSON.parse(last) as T;
        } catch {}
      }
      const ms = Date.now() - t0;
      if (code !== 0) log("engine", `${args[0]} exited ${code} in ${ms} ms: ${err.split("\n")[0].slice(0, 300)}`);
      resolve({ ok: code === 0 && !!json && (json as { ok?: boolean }).ok !== false, code, json, stderr: err, stdout: out, ms });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: null, json: null, stderr: String(e.message), stdout: out, ms: Date.now() - t0 });
    });
  });
}

/** How long a killed engine process is given to go away before its caller is answered anyway. */
const KILL_GRACE_MS = 10_000;

/**
 * 3 for the version this app needs; 2 for a working copy that has not updated
 * yet; 0 when there is no engine on this PC (never remembered: the installer may
 * put one there while the app runs).
 */
export async function detectEngineVersion(force = false): Promise<number> {
  if (engineVersion !== null && !force) return engineVersion;
  const script = engineScript();
  if (!fs.existsSync(script)) {
    engineVersion = null;
    return 0;
  }
  const r = await runEngine<unknown>(["version"], { timeoutMs: 30_000 });
  // "version" prints a bare number, which isn't JSON: read the output's last line.
  const text = r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop() ?? "" : "";
  if (r.code === null) return engineVersion ?? 2; // couldn't run it just now: don't cache a guess
  engineVersion = /^\d+$/.test(text) ? Number(text) : 2;
  return engineVersion;
}

// One writer at a time from the app.
let queue: Promise<unknown> = Promise.resolve();
export function runEngineSerial<T = Record<string, unknown>>(args: string[], opts?: Parameters<typeof runEngine>[1]): Promise<EngineResult<T>> {
  const next = queue.then(() => runEngine<T>(args, opts));
  queue = next.catch(() => undefined);
  return next;
}
