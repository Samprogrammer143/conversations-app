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
  /** How the next look at GitHub fails. */
  checkFails: null as null | Record<string, unknown>,
  signInFails: false,
  /** Holds a look at GitHub, with its answer already decided, until it resolves. */
  checkGate: null as null | Promise<void>,
  pushFails: null as null | Record<string, unknown>,
  online: true,
}));

vi.mock("electron", () => ({ net: { isOnline: () => engine.online } }));
vi.mock("../src/main/sync/engine-bridge", () => {
  const run = async (args: string[]) => {
    engine.calls.push(args);
    const json =
      args[0] === "check"
        ? (engine.checkFails ?? { ok: true, remoteHead: engine.remoteHead, changed: false })
        : args[0] === "status"
          ? { ok: true, setUp: true, machine: "Home PC", unpushedCommits: 0, sessions: {}, ...engine.status }
          : args[0] === "pull-all"
            ? (engine.duringPull?.(), engine.pullOk ? { ok: true, downloaded: [], updated: [] } : { ok: false, err: "offline" })
            : args[0] === "signin" && engine.signInFails
              ? { ok: false, err: "That GitHub account can't upload to this workspace's chats" }
              : args[0] === "push-pending" && engine.pushFails
                ? engine.pushFails
                : { ok: true };
    if (args[0] === "check" && engine.checkGate) await engine.checkGate;
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
  engine.checkFails = null;
  engine.signInFails = false;
  engine.checkGate = null;
  engine.online = true;
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

describe("when GitHub can't be used", () => {
  it("a refused login is a sign-in problem, at once, and doesn't say offline", async () => {
    engine.checkFails = { ok: false, code: "auth", err: "could not read Password" };
    await scheduler.syncNow();
    scheduler.stop();
    const s = scheduler.status();
    expect(s).toMatchObject({ phase: "signin", noNetwork: false, headline: "Sign in to GitHub" });
    expect(`${s.headline} ${s.detail}`).not.toMatch(/offline/i);
  });
  it("GitHub not answering isn't called being offline while the PC has a network", async () => {
    engine.checkFails = { ok: false, offline: true, err: "Could not resolve host" };
    await scheduler.syncNow();
    scheduler.stop();
    expect(scheduler.status()).toMatchObject({ phase: "offline", noNetwork: false, headline: "Can't reach GitHub" });
  });
  it("no network at all is offline", async () => {
    engine.online = false;
    await scheduler.syncNow();
    scheduler.stop();
    expect(scheduler.status()).toMatchObject({ phase: "offline", noNetwork: true, headline: "Offline" });
  });
  it("it comes back by itself once GitHub lets it in", async () => {
    engine.checkFails = { ok: false, code: "auth" };
    await scheduler.syncNow();
    engine.checkFails = null;
    await scheduler.syncNow();
    scheduler.stop();
    expect(scheduler.status().phase).toBe("idle");
  });
  it("a problem stays on screen while it is looked at again", async () => {
    for (const fails of [{ ok: false, code: "auth" }, { ok: false, offline: true }]) {
      engine.checkFails = fails;
      await scheduler.syncNow();
      const seen: string[] = [];
      const see = (s: { phase: string }) => seen.push(s.phase);
      scheduler.on("status", see);
      await scheduler.syncNow();
      scheduler.off("status", see);
      expect(seen).not.toContain("checking");
    }
    engine.checkFails = null;
    await scheduler.syncNow();
    scheduler.stop();
  });
  it("an upload GitHub refuses is a sign-in problem, not 'up to date'", async () => {
    engine.status = { unpushedCommits: 1 };
    engine.pushFails = { ok: false, code: "auth", err: "403" };
    await scheduler.syncNow();
    scheduler.stop();
    engine.status = {};
    engine.pushFails = null;
    expect(scheduler.status().phase).toBe("signin");
  });
  it("a sign-in that doesn't finish says so and changes nothing", async () => {
    engine.checkFails = { ok: false, code: "auth" };
    engine.signInFails = true;
    await scheduler.syncNow();
    const r = await scheduler.signIn();
    scheduler.stop();
    expect(r).toEqual({ ok: false, err: "That GitHub account can't upload to this workspace's chats" });
    expect(scheduler.status().phase).toBe("signin");
  });
  it("signing in from the app asks the engine, then looks again", async () => {
    engine.checkFails = { ok: false, code: "auth" };
    await scheduler.syncNow();
    engine.checkFails = null;
    expect(await scheduler.signIn()).toEqual({ ok: true });
    const signin = engine.calls.findIndex((c) => c[0] === "signin");
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    expect(signin).toBeGreaterThanOrEqual(0);
    expect(engine.calls.slice(signin).some((c) => c[0] === "check")).toBe(true);
    expect(scheduler.status().phase).toBe("idle");
  });
  it("signing in during a look: that look's out-of-date answer doesn't stay", async () => {
    engine.checkFails = { ok: false, code: "auth" };
    let open = () => {};
    engine.checkGate = new Promise((r) => (open = r));
    const look = scheduler.syncNow();
    await new Promise((r) => setTimeout(r, 5));
    expect(await scheduler.signIn()).toEqual({ ok: true });
    engine.checkGate = null;
    engine.checkFails = null;
    open();
    await look;
    await new Promise((r) => setTimeout(r, 350));
    scheduler.stop();
    expect(scheduler.status().phase).toBe("idle");
  });
  it("GitHub letting it in again clears the banner at once, whatever comes next", async () => {
    engine.checkFails = { ok: false, code: "auth" };
    await scheduler.syncNow();
    engine.checkFails = null;
    let during = "";
    engine.duringPull = () => (during = scheduler.status().phase);
    await scheduler.syncNow();
    scheduler.stop();
    expect(during).toBe("downloading");
    expect(scheduler.status().phase).toBe("idle");
  });
  it("uploads refused while reading works: the banner stays through each try", async () => {
    engine.status = { unpushedCommits: 1 };
    engine.pushFails = { ok: false, code: "auth" };
    await scheduler.syncNow();
    const seen: string[] = [];
    const see = (s: { phase: string }) => seen.push(s.phase);
    scheduler.on("status", see);
    await scheduler.syncNow();
    scheduler.off("status", see);
    scheduler.stop();
    engine.status = {};
    engine.pushFails = null;
    expect(seen).not.toContain("uploading");
    expect(seen).not.toContain("checking");
    expect(scheduler.status().phase).toBe("signin");
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
