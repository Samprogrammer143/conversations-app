// Which workspaces are open on this PC, each in its own copy of the app. Every copy
// records its workspace in <data>/open/<id>.json with its process id, writes it again
// every minute, and takes it away when you quit it or switch it to another workspace.
// A record whose process is gone, or that wasn't written for a few minutes (Windows
// reuses process numbers), was left by a copy still open when the PC shut down (or one
// that crashed): the next plain start opens that workspace again.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWorkspaceId, openMarksDir } from "./workspace";

export interface OpenMark {
  pid: number;
  at: string;
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * When this PC last started: a record from before then belongs to a process from before
 * the restart, whatever runs under its number now (Windows reuses process numbers).
 */
export const bootTime = () => Date.now() - os.uptime() * 1000;

/** How often a running copy writes its record again, and how old a record can be and still count. */
export const MARK_EVERY_MS = 60_000;
const MARK_STALE_MS = 3 * MARK_EVERY_MS;

/** A record's copy of the app is still running: its process is, it was written lately, and since the PC started. */
const live = (m: OpenMark | null, alive: (pid: number) => boolean, since: number): m is OpenMark => {
  if (!m || !alive(m.pid)) return false;
  const at = Date.parse(m.at);
  return at >= since - 60_000 && Date.now() - at < MARK_STALE_MS;
};

const markFile = (id: string, dir = openMarksDir()) => path.join(dir, `${id}.json`);

function readMark(id: string, dir = openMarksDir()): OpenMark | null {
  try {
    const m = JSON.parse(fs.readFileSync(markFile(id, dir), "utf8"));
    return typeof m?.pid === "number" ? m : null;
  } catch {
    return null;
  }
}

/** Records that this copy of the app has the workspace open. */
export function markOpen(id: string, pid = process.pid, dir = openMarksDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${markFile(id, dir)}.${pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pid, at: new Date().toISOString() } satisfies OpenMark));
    fs.renameSync(tmp, markFile(id, dir));
  } catch {}
}

/** This copy no longer has it open (you quit it, or switched it to another workspace). Another copy's record stays. */
export function unmarkOpen(id: string, pid = process.pid, dir = openMarksDir()) {
  if (readMark(id, dir)?.pid !== pid) return;
  try {
    fs.rmSync(markFile(id, dir), { force: true });
  } catch {}
}

/** The workspace is open in another copy of the app, still running. */
export function openElsewhere(id: string, pid = process.pid, dir = openMarksDir(), alive: (pid: number) => boolean = processAlive, since = bootTime()): boolean {
  const m = readMark(id, dir);
  return live(m, alive, since) && m.pid !== pid;
}

const recorded = (dir: string) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => isWorkspaceId(id));
  } catch {
    return [];
  }
};

/** The workspaces left open when the app last stopped without being quit (a shutdown, a crash). */
export function leftOpen(dir = openMarksDir(), alive: (pid: number) => boolean = processAlive, since = bootTime()): string[] {
  return recorded(dir).filter((id) => {
    const m = readMark(id, dir);
    return !!m && !live(m, alive, since);
  });
}

/** The workspaces open in other copies of the app, running now. */
export function openNow(pid = process.pid, dir = openMarksDir(), alive: (pid: number) => boolean = processAlive, since = bootTime()): string[] {
  return recorded(dir).filter((id) => {
    const m = readMark(id, dir);
    return live(m, alive, since) && m.pid !== pid;
  });
}

/**
 * What a copy of the app for `workspace` starts with: this one's arguments (in development,
 * the app's folder), less what only applied to this start, then the workspace and `extra`.
 */
export function startArgs(argv: string[], workspace: string, extra: string[] = []): string[] {
  const once = (a: string) => a === "--hidden" || a === "--restart-for-update" || a === "--restart-others" || a.startsWith("--workspace=") || a.startsWith("conversations://");
  return [...argv.slice(1).filter((a) => !once(a)), `--workspace=${workspace}`, ...extra];
}

/** Forgets a record (a workspace that is gone, or that no longer opens here). */
export function dropMark(id: string, dir = openMarksDir()) {
  try {
    fs.rmSync(markFile(id, dir), { force: true });
  } catch {}
}
