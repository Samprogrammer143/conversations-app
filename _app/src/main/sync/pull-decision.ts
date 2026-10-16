// When the app downloads from GitHub (pull-all). Claude Code's hooks fetch too, so
// "GitHub is ahead of origin/main" misses changes a hook fetched but never brought
// into ~/.claude. The app instead remembers the last GitHub head it fully
// processed, and downloads whenever GitHub's head is anything else. Conversations
// pull-all had to leave alone (written in the last two minutes, or open in the
// app) are tried again a little later, even if GitHub has not moved.

import fs from "node:fs";

/** How long to wait before retrying conversations pull-all skipped because they were live. */
export const RETRY_SKIPPED_MS = 150_000;

export function shouldPull(a: { remoteHead: string | null | undefined; lastProcessed: string | null; changed?: boolean; force?: boolean; retryAt?: number | null; now?: number }): boolean {
  if (a.force) return true;
  if (a.retryAt != null && (a.now ?? Date.now()) >= a.retryAt) return true;
  if (a.remoteHead) return a.remoteHead !== a.lastProcessed;
  // An engine that does not report GitHub's head: trust its own comparison.
  return !!a.changed;
}

/** The last GitHub head this app fully processed, kept in the app's data folder. */
export class HeadStore {
  constructor(private file: string) {}

  get(): string | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return typeof v?.head === "string" ? v.head : null;
    } catch {
      return null;
    }
  }

  set(head: string) {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ head, at: new Date().toISOString() }));
      fs.renameSync(tmp, this.file);
    } catch {}
  }
}
