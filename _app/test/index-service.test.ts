// Item 3: the index worker's failures never hang or freeze the app.
// A stand-in worker file stands in for the real one; its behaviour is set by env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "index-service-"));
process.env.CONVERSATIONS_DATA_DIR = path.join(base, "data");
process.env.CLAUDE_SYNC_HOME = path.join(base, "sync");
process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude");
fs.mkdirSync(path.join(base, "data"), { recursive: true });
const { IndexService } = await import("../src/main/index/service");
const { openDb } = await import("../src/main/index/db");

const workerFile = path.join(base, "worker.mjs");
// The worker reads a "mode" file each time it starts: crash-first-boot | die-on-scan | fine.
fs.writeFileSync(
  workerFile,
  `import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
const mode = fs.readFileSync(workerData.dbPath + ".mode", "utf8").trim();
if (mode === "crash-first-boot") { fs.writeFileSync(workerData.dbPath + ".mode", "fine"); throw new Error("SQLITE_CORRUPT: database disk image is malformed"); }
parentPort.on("message", (m) => {
  if (m.type === "scan") { if (mode === "die-on-scan") process.exit(7); parentPort.postMessage({ type: "scanned", changed: [], removed: [], total: 0, ms: 1, reason: m.reason }); }
});
parentPort.postMessage({ type: "ready" });
`,
);
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300)); // workers let go of the index file
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the index worker", () => {
  it("rebuilds a damaged index once instead of waiting forever", async () => {
    const svc = new IndexService();
    // A real (empty but valid) index file plus a stale wal, as a crash leaves behind.
    openDb(svc.dbPath, { readOnly: false }).close();
    fs.writeFileSync(`${svc.dbPath}-wal`, "junk");
    fs.writeFileSync(`${svc.dbPath}.mode`, "crash-first-boot");
    const t0 = Date.now();
    await svc.start(workerFile);
    expect(svc.ready).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000); // it used to wait forever here
    // The first worker crashed (it flipped the mode to "fine" on its way out), the
    // damaged index was removed, and the second worker came up on a fresh one.
    expect(fs.readFileSync(`${svc.dbPath}.mode`, "utf8").trim()).toBe("fine");
    expect(fs.readFileSync(path.join(base, "data", "app.log"), "utf8")).toMatch(/starting it afresh/);
    svc.stop();
    await sleep(100);
  });

  it("starts the worker again when it dies, and never leaves the index stuck busy", async () => {
    const svc = new IndexService();
    fs.writeFileSync(`${svc.dbPath}.mode`, "die-on-scan");
    await svc.start(workerFile); // the startup scan is about to kill the worker
    // The worker that comes back reads the mode afresh: healthy from now on.
    fs.writeFileSync(`${svc.dbPath}.mode`, "fine");
    // The restarted worker answers scans: busy was reset, the flush goes through.
    const scanned = new Promise<void>((r) => svc.once("changed", () => r()));
    await Promise.race([scanned, sleep(5000).then(() => Promise.reject(new Error("index stuck busy")))]);
    expect(fs.readFileSync(path.join(base, "data", "app.log"), "utf8")).toMatch(/starting it again \(1 of/);
    svc.stop();
    await sleep(100);
  }, 10_000);

  it("gives up after a few restarts and says so, rather than looping", async () => {
    const svc = new IndexService();
    fs.writeFileSync(`${svc.dbPath}.mode`, "die-on-scan");
    await svc.start(workerFile);
    // Every restarted worker dies on its restart scan too; after MAX_RESTARTS it is left alone.
    const until = Date.now() + 10_000;
    while (Date.now() < until && !/the index is no longer updated/.test(fs.readFileSync(path.join(base, "data", "app.log"), "utf8"))) await sleep(200);
    expect(fs.readFileSync(path.join(base, "data", "app.log"), "utf8")).toMatch(/the index is no longer updated/);
    svc.stop();
    await sleep(100);
  }, 15_000);
});
