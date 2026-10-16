// When the app downloads from GitHub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HeadStore, shouldPull } from "../src/main/sync/pull-decision";

describe("downloading", () => {
  it("follows GitHub's head against the last one the app processed, not origin/main", () => {
    // A hook already fetched (origin/main == GitHub), but the app never brought it in.
    expect(shouldPull({ remoteHead: "b", lastProcessed: "a", changed: false })).toBe(true);
    expect(shouldPull({ remoteHead: "b", lastProcessed: "b", changed: true })).toBe(false);
    expect(shouldPull({ remoteHead: "b", lastProcessed: null })).toBe(true);
  });

  it("retries what it had to skip, and always runs when asked", () => {
    expect(shouldPull({ remoteHead: "b", lastProcessed: "b", retryAt: 1000, now: 999 })).toBe(false);
    expect(shouldPull({ remoteHead: "b", lastProcessed: "b", retryAt: 1000, now: 1000 })).toBe(true);
    expect(shouldPull({ remoteHead: "b", lastProcessed: "b", force: true })).toBe(true);
  });

  it("trusts an older engine's own comparison when it reports no head", () => {
    expect(shouldPull({ remoteHead: null, lastProcessed: "a", changed: true })).toBe(true);
    expect(shouldPull({ remoteHead: undefined, lastProcessed: "a", changed: false })).toBe(false);
  });

  it("remembers the processed head across restarts", () => {
    const file = path.join(os.tmpdir(), `sync-head-${process.pid}-${Date.now()}.json`);
    try {
      const a = new HeadStore(file);
      expect(a.get()).toBeNull();
      a.set("abc123");
      expect(new HeadStore(file).get()).toBe("abc123");
      fs.writeFileSync(file, "not json");
      expect(new HeadStore(file).get()).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
