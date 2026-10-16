// Item 1: the scheduler never dies. Started before sync is set up, it keeps looking;
// nudge() revives it; an engine that appears later is picked up without a restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ calls: [] as string[][], version: 3 }));

vi.mock("electron", () => ({ net: { isOnline: () => true } }));
vi.mock("../src/main/sync/engine-bridge", () => {
  const run = async (args: string[]) => {
    engine.calls.push(args);
    const json = args[0] === "check" ? { ok: true, remoteHead: "h1", changed: false } : args[0] === "status" ? { ok: true, setUp: true, machine: "X", unpushedCommits: 0, sessions: {} } : { ok: true };
    return { ok: true, code: 0, json, stderr: "", stdout: "", ms: 1 };
  };
  return { detectEngineVersion: async () => engine.version, runEngine: run, runEngineSerial: run };
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sched-live-"));
process.env.CONVERSATIONS_DATA_DIR = path.join(base, "data");
process.env.CLAUDE_SYNC_HOME = path.join(base, "sync");
fs.mkdirSync(process.env.CLAUDE_SYNC_HOME, { recursive: true });
// No config.json yet: the app started before the installer ran.

const { SyncScheduler } = await import("../src/main/sync/scheduler");
const { settings } = await import("../src/main/settings");
settings.load(); // as the app does before anything else (setPaused writes the settings file)
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const checks = () => engine.calls.filter((c) => c[0] === "check").length;

describe("the sync loop stays alive", () => {
  it("keeps a tick armed when sync isn't set up, when paused, and after an early return", async () => {
    engine.version = 0;
    const s = new SyncScheduler({ isWindowVisible: () => true, devices: () => [], pendingUploads: () => 0, onDownloaded: () => {}, appVersion: "0" });
    await s.start();
    s.stop();
    await s.tick();
    expect(s.status().phase).toBe("not-set-up");
    expect(s.armed).toBe(true); // the reviewer's repro: this used to be false forever
    s.stop();
    expect(s.armed).toBe(false);
    // nudge() re-arms even when no timer is pending.
    s.nudge();
    expect(s.armed).toBe(true);
    s.stop();
    // The installer sets sync up while the app runs; the next tick picks it up, engine and all.
    fs.writeFileSync(path.join(process.env.CLAUDE_SYNC_HOME!, "config.json"), JSON.stringify({ remote: "https://github.com/a/b", machine: "X" }));
    engine.version = 3;
    await s.tick();
    expect(checks()).toBe(1);
    expect(s.armed).toBe(true);
    s.stop();
    // Paused: no check, but still armed so resuming works through the normal loop too.
    s.setPaused(true);
    s.stop();
    await s.tick();
    expect(s.status().phase).toBe("paused");
    expect(s.armed).toBe(true);
    s.stop();
    s.setPaused(false);
    s.stop();
  });
});
