// Which Claude account each workspace's Claude Code is signed in with, as Claude Code
// itself reports it (`claude auth status`): a login file that exists isn't necessarily
// a login that works. Signing in runs `claude auth login` for that workspace's Claude
// folder in a terminal, and the app watches until it took.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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

/** The time Claude Code last wrote this workspace's login (0: none yet). */
export function credentialsTime(w: Workspace): number {
  const dir = w.id === "main" ? baseEnv().CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") : w.claudeDir;
  try {
    return fs.statSync(path.join(dir, ".credentials.json")).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Whether a sign-in took. Signed in before: only another login counts (Claude Code
 * rewrites its login file whenever it refreshes the token, so a new write proves
 * nothing). Signed out, or unknown: signed in now, with a login written since.
 */
export function signInTook(before: { state: AuthState | null; credsAt: number }, now: AuthState | null, credsAt: number): boolean {
  if (!now?.loggedIn) return false;
  if (before.state?.loggedIn) return before.state.key !== now.key;
  return credsAt !== before.credsAt || before.state?.loggedIn === false;
}

const watching = new Map<string, symbol>();

/**
 * After a sign-in starts: asks every few seconds, for up to ten minutes, until the
 * sign-in took. One watcher per workspace; a new sign-in replaces the old watcher.
 */
export function watchSignIn(w: Workspace, claudePath: string | null, before: { state: AuthState | null; credsAt: number }, onDone: (state: AuthState) => void) {
  const me = Symbol(w.id);
  watching.set(w.id, me);
  const until = Date.now() + 10 * 60_000;
  const tick = async () => {
    if (watching.get(w.id) !== me) return;
    if (Date.now() > until) {
      watching.delete(w.id);
      return;
    }
    const credsAt = credentialsTime(w);
    const s = await authStatus(w, claudePath, true);
    if (watching.get(w.id) !== me) return;
    if (s && signInTook(before, s, credsAt)) {
      watching.delete(w.id);
      log("app", `workspace ${w.id} signed in${s.email ? ` as ${s.email}` : ""}`);
      onDone(s);
      return;
    }
    setTimeout(() => void tick(), 3000).unref?.();
  };
  setTimeout(() => void tick(), 3000).unref?.();
}
