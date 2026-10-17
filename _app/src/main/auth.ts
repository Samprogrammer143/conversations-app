// Which Claude account each workspace's Claude Code is signed in with, as Claude Code
// itself reports it (`claude auth status`): a login file that exists isn't necessarily
// a login that works. Signing in runs `claude auth login` for that workspace's Claude
// folder from the app (no terminal): the browser shows Claude's sign-in, and the window
// asks for the code it ends on.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Workspace } from "./workspace";
import { baseEnv, workspaceEnv } from "./workspace";
import { log } from "./log";

export interface AuthState {
  loggedIn: boolean;
  email: string | null;
  /** What identifies the login (method, organisation, email): another sign-in changes it. */
  key: string;
}

const cache = new Map<string, { at: number; state: AuthState | null }>();
const inFlight = new Map<string, Promise<AuthState | null>>();
const TTL = 60_000;
// When Claude Code couldn't tell (an old version, a broken install): don't ask again at once.
const TTL_UNKNOWN = 30_000;

/** The environment Claude Code runs with for a workspace (its Claude folder and sync folder). */
export function authEnv(w: Workspace): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv(), ...workspaceEnv(w) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Parses `claude auth status --json` output. */
export function parseAuthStatus(out: string): AuthState | null {
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    if (typeof j?.loggedIn !== "boolean") return null;
    const email = j.loggedIn && typeof j.email === "string" ? j.email : null;
    return { loggedIn: j.loggedIn, email, key: [j.loggedIn, j.authMethod, j.orgId, email].map((x) => String(x ?? "")).join("|") };
  } catch {
    return null;
  }
}

/**
 * Asks Claude Code (cached for a minute; `fresh` asks again). Null when it can't tell,
 * within `timeoutMs`. One question per workspace at a time: callers share it.
 */
export function authStatus(w: Workspace, claudePath: string | null, fresh = false, timeoutMs = 5000): Promise<AuthState | null> {
  const hit = cache.get(w.id);
  if (!fresh && hit && Date.now() - hit.at < (hit.state ? TTL : TTL_UNKNOWN)) return Promise.resolve(hit.state);
  if (!claudePath) return Promise.resolve(null);
  const running = inFlight.get(w.id);
  if (running) return running;
  const p = new Promise<AuthState | null>((resolve) => {
    let out = "";
    let done = false;
    const finish = (state: AuthState | null) => {
      if (done) return;
      done = true;
      cache.set(w.id, { at: Date.now(), state });
      inFlight.delete(w.id);
      resolve(state);
    };
    try {
      const child = spawn(claudePath, ["auth", "status", "--json"], { env: authEnv(w) as NodeJS.ProcessEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        finish(parseAuthStatus(out));
      });
    } catch {
      finish(null);
    }
  });
  inFlight.set(w.id, p);
  return p;
}

// ------------------------------------------------------------ signing in

/**
 * A sign-in in progress: `claude auth login` run by the app itself (no terminal). It
 * opens Claude's sign-in in the browser, which ends on a page with a code; the window
 * asks for that code and hands it over here.
 */
interface LoginRun {
  child: ChildProcessWithoutNullStreams;
  out: string;
  exited: Promise<number | null>;
  submitting: boolean;
}
const logins = new Map<string, LoginRun>();
// The whole address (followed by a space or line end: a pipe can hand it over in pieces).
const URL_RE = /https:\/\/\S*oauth\S*(?=\s)/;
// Colours and links a terminal would draw (FORCE_COLOR may be set for this user).
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (s: string) => s.replace(ANSI_RE, "");

/** Only Claude's own sign-in pages are opened from the app. */
export function isClaudeSignInUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i.test(x.hostname);
  } catch {
    return false;
  }
}

/** Starts a sign-in for a workspace (a running one is replaced): the sign-in page's address. */
export function startLogin(w: Workspace, claudePath: string, argv = ["auth", "login", "--claudeai"]): Promise<{ ok: boolean; url?: string; err?: string }> {
  cancelLogin(w.id);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(claudePath, argv, { env: authEnv(w) as NodeJS.ProcessEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    return Promise.resolve({ ok: false, err: (e as Error).message });
  }
  // "close", not "exit": by then everything it printed has been read.
  const run: LoginRun = { child, out: "", submitting: false, exited: new Promise((resolve) => child.on("close", (code) => resolve(code))) };
  // Writing the code to one that has just ended must not throw in the app.
  child.stdin.on("error", () => {});
  logins.set(w.id, run);
  // A sign-in left open stops after a quarter of an hour.
  const stale = setTimeout(() => cancelLogin(w.id, run), 15 * 60_000);
  stale.unref?.();
  void run.exited.then(() => {
    clearTimeout(stale);
    if (logins.get(w.id) === run) logins.delete(w.id);
  });
  return new Promise((resolve) => {
    const onData = (d: Buffer) => {
      run.out += d;
      const m = URL_RE.exec(plain(run.out));
      if (m && !isClaudeSignInUrl(m[0])) {
        clearTimeout(timer);
        cancelLogin(w.id, run);
        resolve({ ok: false, err: "Claude Code offered a sign-in page that isn't Claude's" });
        return;
      }
      if (m) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        // Keep reading what it says later (an error after the code).
        child.stdout.on("data", (x: Buffer) => (run.out += x));
        child.stderr.on("data", (x: Buffer) => (run.out += x));
        resolve({ ok: true, url: m[0] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      cancelLogin(w.id, run);
      resolve({ ok: false, err: "Claude Code didn't start the sign-in" });
    }, 30_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, err: e.message });
    });
    void run.exited.then((code) => {
      clearTimeout(timer);
      resolve({ ok: false, err: lastLine(run.out) || `Claude Code stopped (${code})` });
    });
  });
}

/** Hands the code from the sign-in page to Claude Code; resolves once it has finished. */
export async function submitLoginCode(id: string, code: string): Promise<{ ok: boolean; err?: string }> {
  const run = logins.get(id);
  if (!run) return { ok: false, err: "That sign-in has ended: start it again" };
  if (run.submitting) return { ok: false, err: "Already signing in with a code" };
  const clean = code.trim();
  if (!clean || clean.length > 1000 || /[\r\n]/.test(clean)) return { ok: false, err: "That doesn't look like the code from the sign-in page" };
  const before = run.out.length;
  run.submitting = true;
  run.child.stdin.write(`${clean}\n`);
  let slow: NodeJS.Timeout | undefined;
  const code_ = await Promise.race([run.exited, new Promise<"slow">((r) => (slow = setTimeout(() => r("slow"), 60_000)))]).finally(() => clearTimeout(slow));
  if (code_ === 0) return { ok: true };
  if (code_ === "slow") {
    cancelLogin(id, run);
    return { ok: false, err: "Claude didn't answer in time: start the sign-in again" };
  }
  return { ok: false, err: lastLine(run.out.slice(before)) || "The sign-in didn't work: start it again" };
}

/** Ends every sign-in still running (the app is quitting). */
export function cancelAllLogins() {
  for (const id of [...logins.keys()]) cancelLogin(id);
}

export function cancelLogin(id: string, only?: LoginRun) {
  const run = logins.get(id);
  if (!run || (only && run !== only)) return;
  logins.delete(id);
  try {
    run.child.kill();
  } catch {}
}

/** The last thing Claude Code printed, without addresses or the prompt. */
function lastLine(out: string): string {
  const lines = plain(out)
    .replace(/https:\/\/\S+/g, "")
    .split(/\r?\n|>/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Paste code|^Opening browser|^If the browser/i.test(l));
  return (lines.pop() ?? "").slice(0, 200);
}
