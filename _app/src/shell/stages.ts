// Which staged copies of the app can be deleted. The app is run from a private
// copy under <data>/app/<version>-<tree>, and old copies are tidied away. Only the
// running app (the primary instance, once it holds the single-instance lock) may
// tidy, and it never removes the copy it runs from, nor the copy another live
// instance recorded in the marker file.

import fs from "node:fs";
import path from "node:path";

export const RUNNING_MARK = "running.json";

export interface RunningMark {
  pid: number;
  stage: string;
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

/** The stage a live instance runs from, as the marker in `root` records it; null when there is none or its process is gone. */
export function readRunningMark(root: string, alive: (pid: number) => boolean = processAlive): RunningMark | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, RUNNING_MARK), "utf8"));
    if (typeof m?.pid !== "number" || typeof m?.stage !== "string") return null;
    return alive(m.pid) ? m : null;
  } catch {
    return null;
  }
}

/** Written by the primary instance once it holds the single-instance lock. */
export function writeRunningMark(root: string, stage: string, pid = process.pid) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `${RUNNING_MARK}.${pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ pid, stage, at: new Date().toISOString() } satisfies RunningMark));
  fs.renameSync(tmp, path.join(root, RUNNING_MARK));
}

/**
 * The stage folders that can go: everything except the one in use, the one
 * before it, the one a live instance recorded, and anything still being copied.
 */
export function stagesToRemove(root: string, inUse: string, alive: (pid: number) => boolean = processAlive, keepAlso: string[] = []): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((d) => {
      try {
        return fs.statSync(path.join(root, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const keep = new Set<string>([path.basename(inUse)]);
  const mark = readRunningMark(root, alive);
  if (mark) keep.add(path.basename(mark.stage));
  // The forwarder an older shell runs first (see forwarder.ts) stays as well: it starts every time.
  for (const k of keepAlso) keep.add(path.basename(k));
  const older = names
    .filter((d) => !keep.has(d) && !d.endsWith(".tmp"))
    .map((d) => ({ d, t: fs.statSync(path.join(root, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  // The newest one not in use stays too (a quick way back if the new copy misbehaves).
  return older.slice(1).map((o) => path.join(root, o.d));
}

/** Tidies old stages. Only the primary instance calls this, after it holds the lock. */
export function cleanStages(root: string, inUse: string, alive: (pid: number) => boolean = processAlive, keepAlso: string[] = []): string[] {
  const gone: string[] = [];
  for (const p of stagesToRemove(root, inUse, alive, keepAlso)) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      gone.push(p);
    } catch {}
  }
  return gone;
}
