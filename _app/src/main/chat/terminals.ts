// Which conversations a Claude Code terminal on this PC has open right now.
//
// Claude Code keeps one file per running process, ~/.claude/sessions/<pid>.json:
// { pid, sessionId, cwd, kind, entrypoint, pidDomain, status, … }. That folder can
// be synced between PCs (OneDrive), so an entry only counts when it names this PC
// (pidDomain), is an interactive session (not an SDK run such as this app's own),
// and its process is still a running claude.exe. Only the *.json files are read;
// the folder's *.key files hold secrets and are never opened.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { claudeDir } from "../paths";

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | null;
  kind: string | null;
  entrypoint: string | null;
  pidDomain: string | null;
  status: string | null;
}

/** "win32:desktop-test01", the way Claude Code names this PC in the registry. */
export function thisPidDomain(): string {
  return `${process.platform}:${os.hostname().toLowerCase()}`;
}

export function registryDir(): string {
  return path.join(claudeDir(), "sessions");
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The registry's entries, or null when this PC's Claude Code keeps no registry. */
export function readRegistry(dir = registryDir()): RegistryEntry[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const out: RegistryEntry[] = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (typeof v?.pid !== "number" || typeof v?.sessionId !== "string") continue;
      out.push({ pid: v.pid, sessionId: v.sessionId, cwd: str(v.cwd), kind: str(v.kind), entrypoint: str(v.entrypoint), pidDomain: str(v.pidDomain), status: str(v.status) });
    } catch {
      // Being written right now, or not ours to read: skip it.
    }
  }
  return out;
}

/** An interactive Claude Code session on this PC: not another PC's file, not an SDK run (this app's chats are SDK runs). */
export function isTerminalEntry(e: RegistryEntry, domain = thisPidDomain()): boolean {
  if (!e.pidDomain || e.pidDomain.toLowerCase() !== domain.toLowerCase()) return false;
  if (e.entrypoint?.startsWith("sdk")) return false;
  return e.kind ? e.kind === "interactive" : e.entrypoint === "cli";
}

/**
 * The image name of a running process ("claude.exe"); "?" when it runs but its
 * name can't be read (counted as Claude, to stay on the safe side); null when it
 * isn't running.
 */
export type ProcessProbe = (pid: number) => Promise<string | null>;

export const probeProcess: ProcessProbe = async (pid) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  if (process.platform !== "win32") return "?";
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done("?");
    }, 5000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => done("?"));
    child.on("close", () => {
      const m = out.match(/^"([^"]+)","(\d+)"/m);
      done(m && Number(m[2]) === pid ? m[1] : null);
    });
  });
};

const isClaude = (image: string | null) => image === "?" || (!!image && /^claude(\.exe)?$/i.test(image));

/** Conversations open in a Claude Code terminal on this PC; null when there is no registry to read. */
export async function openTerminalSessions(opts: { dir?: string; domain?: string; probe?: ProcessProbe; only?: string } = {}): Promise<Set<string> | null> {
  const entries = readRegistry(opts.dir);
  if (!entries) return null;
  const domain = opts.domain ?? thisPidDomain();
  const probe = opts.probe ?? probeProcess;
  const open = new Set<string>();
  for (const e of entries) {
    if (opts.only && e.sessionId !== opts.only) continue;
    if (open.has(e.sessionId) || !isTerminalEntry(e, domain)) continue;
    if (isClaude(await probe(e.pid))) open.add(e.sessionId);
  }
  return open;
}

/** True or false from Claude Code's registry; null when there is none (the caller falls back to another check). */
export async function isOpenInTerminal(id: string, opts: { dir?: string; domain?: string; probe?: ProcessProbe } = {}): Promise<boolean | null> {
  const open = await openTerminalSessions({ ...opts, only: id });
  return open === null ? null : open.has(id);
}

/**
 * The running Claude Code processes on this PC that have a conversation open:
 * terminals only, or (anyKind) also SDK runs such as this app's own or another
 * tool's. null when there is no registry to read.
 */
export async function sessionProcesses(id: string, opts: { dir?: string; domain?: string; probe?: ProcessProbe; anyKind?: boolean } = {}): Promise<RegistryEntry[] | null> {
  const entries = readRegistry(opts.dir);
  if (!entries) return null;
  const domain = opts.domain ?? thisPidDomain();
  const probe = opts.probe ?? probeProcess;
  const out: RegistryEntry[] = [];
  for (const e of entries) {
    if (e.sessionId.toLowerCase() !== id.toLowerCase()) continue;
    // Any kind: an entry that names no PC counts too (older Claude Code), to stay on the safe side.
    const here = !e.pidDomain || e.pidDomain.toLowerCase() === domain.toLowerCase();
    if (!(opts.anyKind ? here : isTerminalEntry(e, domain))) continue;
    if (isClaude(await probe(e.pid))) out.push(e);
  }
  return out;
}
