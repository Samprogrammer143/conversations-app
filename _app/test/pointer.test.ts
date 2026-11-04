// The pointer nudge before a dialog (main/pointer.ts): nothing off Windows, and it never holds
// a dialog up for long, whatever PowerShell does.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { showPointer } from "../src/main/pointer";

/** A stand-in for spawn: what it was asked to run, and a child that exits when told to. */
function fakeSpawn(behaviour: "exits" | "hangs" | "throws" | "fails") {
  const calls: { file: string; args: string[]; opts: unknown }[] = [];
  const run = ((file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    if (behaviour === "throws") throw new Error("spawn failed");
    const child = new EventEmitter();
    if (behaviour === "exits") setTimeout(() => child.emit("exit", 0), 10);
    if (behaviour === "fails") setTimeout(() => child.emit("error", new Error("ENOENT")), 10);
    return child;
  }) as never;
  return { run, calls };
}

describe("the pointer nudge", () => {
  it("does nothing on a Mac", async () => {
    const f = fakeSpawn("exits");
    await showPointer(800, "darwin", f.run);
    expect(f.calls.length).toBe(0);
  });

  it("runs Windows' own PowerShell, hidden, with no execution policy change", async () => {
    const f = fakeSpawn("exits");
    await showPointer(800, "win32", f.run);
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].file.toLowerCase()).toMatch(/system32\\windowspowershell\\v1\.0\\powershell\.exe$/);
    expect(f.calls[0].args).toContain("-EncodedCommand");
    expect(f.calls[0].args).not.toContain("Bypass");
    expect(f.calls[0].opts).toMatchObject({ windowsHide: true, stdio: "ignore" });
  });

  it("moves a pixel left when it can't go right, and always back", async () => {
    const f = fakeSpawn("exits");
    await showPointer(800, "win32", f.run);
    const args = f.calls[0].args;
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    expect(script).toContain("$p.X + 1");
    expect(script).toContain("$p.X - 1");
    expect(script.trim().split("\n").pop()).toBe("[System.Windows.Forms.Cursor]::Position = $p");
  });

  it("never waits past its limit, and gets over a PowerShell that fails or can't start", async () => {
    const t0 = Date.now();
    await showPointer(200, "win32", fakeSpawn("hangs").run);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(190);
    expect(waited).toBeLessThan(1000);
    await showPointer(5000, "win32", fakeSpawn("fails").run);
    await showPointer(5000, "win32", fakeSpawn("throws").run);
  });
});
