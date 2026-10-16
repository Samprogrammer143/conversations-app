// The engine bridge on a stand-in engine script: version detection never caches
// "no engine", and a run that won't die still answers its caller.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bridge-"));
process.env.CONVERSATIONS_DATA_DIR = path.join(base, "data");
const script = path.join(base, "sync.mjs");
process.env.CONVERSATIONS_ENGINE = script;

const { detectEngineVersion, runEngine } = await import("../src/main/sync/engine-bridge");
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(script, { force: true }));

describe("detectEngineVersion", () => {
  it("answers 0 while there is no engine, and the real version once one appears", async () => {
    expect(await detectEngineVersion()).toBe(0);
    expect(await detectEngineVersion()).toBe(0);
    // The installer puts the engine there while the app runs: no force needed.
    fs.writeFileSync(script, 'if (process.argv[2] === "version") console.log(3);\n');
    expect(await detectEngineVersion()).toBe(3);
    // And now it is remembered.
    fs.rmSync(script);
    expect(await detectEngineVersion()).toBe(3);
    expect(await detectEngineVersion(true)).toBe(0);
  });

  it("reads the version from the output's last line, with noise on stderr", async () => {
    fs.writeFileSync(script, 'console.error("warning: something"); console.log("note"); console.log(3);\n');
    expect(await detectEngineVersion(true)).toBe(3);
  });
});

describe("runEngine", () => {
  it("gives up on a process that outlives its timeout", async () => {
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const t0 = Date.now();
    const r = await runEngine(["hang"], { timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 20_000);

  it("returns stdout and parses the last line as JSON", async () => {
    fs.writeFileSync(script, 'console.log("progress"); console.log(JSON.stringify({ ok: true, n: 1 }));\n');
    const r = await runEngine<{ n: number }>(["x"]);
    expect(r.ok).toBe(true);
    expect(r.json?.n).toBe(1);
    expect(r.stdout).toContain("progress");
  });
});
