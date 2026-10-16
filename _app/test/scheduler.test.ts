// The sync scheduler with the engine and Electron's network check stood in for.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  calls: [] as string[][],
  remoteHead: "h1",
  pullOk: true,
  status: {} as Record<string, unknown>,
  /** Called while a pull-all runs (to close a chat in the middle of one). */
  duringPull: null as null | (() => void),
}));

vi.mock("electron", () => ({ net: { isOnline: () => true } }));
vi.mock("../src/main/sync/engine-bridge", () => {
  const run = async (args: string[]) => {
    engine.calls.push(args);
    const json =
      args[0] === "check"
        ? { ok: true, remoteHead: engine.remoteHead, changed: false }
        : args[0] === "status"
          ? { ok: true, setUp: true, machine: "Home PC", unpushedCommits: 0, sessions: {}, ...engine.status }
          : args[0] === "pull-all"
            ? (engine.duringPull?.(), engine.pullOk ? { ok: true, downloaded: [], updated: [] } : { ok: false, err: "offline" })
            : { ok: true };
    return { ok: json.ok !== false, code: 0, json, stderr: "", ms: 1 };
  };
  return { detectEngineVersion: async () => 3, runEngine: run, runEngineSerial: run };
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
process.env.CONVERSATIONS_DATA_DIR = path.join(base, "data");
process.env.CLAUDE_SYNC_HOME = path.join(base, "sync");
fs.mkdirSync(process.env.CLAUDE_SYNC_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CLAUDE_SYNC_HOME, "config.json"), JSON.stringify({ remote: "https://github.com/a/b", machine: "Home PC" }));

const { SyncScheduler, repoSizeBytes } = await import("../src/main/sync/scheduler");

let open: string[] = [];
let scheduler: InstanceType<typeof SyncScheduler>;
const pulls = () => engine.calls.filter((c) => c[0] === "pull-all");

beforeAll(async () => {
  scheduler = new SyncScheduler({ isWindowVisible: () => true, devices: () => [], pendingUploads: () => 0, onDownloaded: () => {}, appVersion: "0.1.0", skipIds: () => open });
  await scheduler.start();
  scheduler.stop();
});
afterAll(() => {
  scheduler.stop();
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  engine.calls = [];
  engine.duringPull = null;
  engine.pullOk = true;
});

describe("N16: a chat the app closes is brought up to date", () => {
  it("leaves open chats out of pull-all, and pulls again once one closes, though GitHub hasn't moved", async () => {
    open = ["aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"];
    await scheduler.tick();
    expect(pulls()).toEqual([["pull-all", "--json", "--skip", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"]]);
    await scheduler.tick();
    expect(pulls().length).toBe(1); // nothing new on GitHub
    open = [];
    scheduler.retrySoon();
    await scheduler.tick();
    expect(pulls()).toEqual([["pull-all", "--json", "--skip", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"], ["pull-all", "--json"]]);
    await scheduler.tick();
    expect(pulls().length).toBe(2);
    scheduler.stop();
  });

  it("a chat closed while a pull-all runs still gets its own", async () => {
    engine.duringPull = () => {
      engine.duringPull = null;
      scheduler.retrySoon();
    };
    scheduler.retrySoon();
    await scheduler.tick();
    await scheduler.tick();
    expect(pulls().length).toBe(2);
    await scheduler.tick();
    expect(pulls().length).toBe(2);
    scheduler.stop();
  });

  it("a failed pull-all is tried again later, not in a tight loop", async () => {
    engine.pullOk = false;
    scheduler.retrySoon();
    await scheduler.tick();
    await scheduler.tick();
    expect(pulls().length).toBe(1);
    scheduler.stop();
  });
});

describe("what the window is told", () => {
  it("N15: names the cloud folder ~/.claude is synced by; M4: never a login", async () => {
    engine.status = {
      cloudSyncedClaudeDir: "C:\\Users\\me\\OneDrive",
      webUrl: "https://Sam:ghp_SECRET@github.com/a/b",
      lastError: { at: "2026-10-11T00:00:00Z", message: "fatal: unable to access 'https://Sam:ghp_SECRET@github.com/a/b.git/'" },
    };
    await scheduler.tick();
    scheduler.stop();
    const st = scheduler.status();
    expect(st.cloudSyncedClaudeDir).toBe("C:\\Users\\me\\OneDrive");
    expect(st.repoWebUrl).toBe("https://github.com/a/b");
    expect(st.lastError).toBe("fatal: unable to access 'https://github.com/a/b.git/'");
    expect(JSON.stringify(st)).not.toContain("SECRET");
    engine.status = { cloudSyncedClaudeDir: null };
    await scheduler.tick();
    scheduler.stop();
    expect(scheduler.status().cloudSyncedClaudeDir).toBeNull();
  });
});

describe("M8: the repository's size", () => {
  it("is read without blocking", async () => {
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "--quiet"], { cwd: repo });
    const pending = repoSizeBytes(repo);
    expect(pending).toBeInstanceOf(Promise);
    expect(typeof (await pending)).toBe("number");
    expect(await repoSizeBytes(path.join(base, "not-a-repo"))).toBeNull();
  });
});
