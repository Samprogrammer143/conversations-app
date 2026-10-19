// Which workspaces are open on this PC, each in its own copy of the app. Every copy
// records its workspace in <data>/open/<id>.json with its process id, and takes it away
// when you quit it or switch it to another workspace. A record whose process is gone
// was left by a copy still open when the PC shut down (or one that crashed): the next
// plain start opens that workspace again.

import fs from "node:fs";
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
export function openElsewhere(id: string, pid = process.pid, dir = openMarksDir(), alive: (pid: number) => boolean = processAlive): boolean {
  const m = readMark(id, dir);
  return !!m && m.pid !== pid && alive(m.pid);
}

/** The workspaces left open when the app last stopped without being quit (a shutdown, a crash). */
export function leftOpen(dir = openMarksDir(), alive: (pid: number) => boolean = processAlive): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((f) => f.slice(0, -5))
    .filter((id) => isWorkspaceId(id))
    .filter((id) => {
      const m = readMark(id, dir);
      return !!m && !alive(m.pid);
    });
}

/** Forgets a record (a workspace that is gone, or that no longer opens here). */
export function dropMark(id: string, dir = openMarksDir()) {
  try {
    fs.rmSync(markFile(id, dir), { force: true });
  } catch {}
}
