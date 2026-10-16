// Claude Code's session registry, read from fixture files (never the real ~/.claude).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isOpenInTerminal, isTerminalEntry, openTerminalSessions, probeProcess, readRegistry, thisPidDomain, type ProcessProbe } from "../src/main/chat/terminals";

const DOMAIN = "win32:desktop-test01";
const A = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const B = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const C = "11111111-2222-4333-8444-555555555555";
const D = "99999999-2222-4333-8444-555555555555";
let dir: string;

const entry = (pid: number, sessionId: string, extra: object = {}) => ({ pid, sessionId, cwd: "C:\\p", startedAt: 1, kind: "interactive", entrypoint: "cli", pidDomain: DOMAIN, status: "idle", ...extra });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-"));
  const write = (name: string, v: unknown) => fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
  write("100.json", entry(100, A)); // a terminal here, running
  write("200.json", entry(200, B)); // a terminal here, but its process is gone
  write("300.json", entry(300, C, { pidDomain: "win32:laptop-x" })); // another PC's file, synced by OneDrive
  write("400.json", entry(400, D, { kind: "sdk", entrypoint: "sdk-cli" })); // an SDK run (this app's own chat)
  write("500.json", "{ not json"); // being written
  write("100.abcdef.key", '{"peerToken":"secret"}'); // never read
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const probe: ProcessProbe = async (pid) => (pid === 100 || pid === 300 || pid === 400 ? "claude.exe" : null);

describe("Claude Code's session registry", () => {
  it("reads only the .json entries", () => {
    const list = readRegistry(dir)!;
    expect(list.map((e) => e.pid).sort()).toEqual([100, 200, 300, 400]);
    expect(readRegistry(path.join(dir, "missing"))).toBeNull();
  });

  it("counts only this PC's interactive sessions", () => {
    const list = readRegistry(dir)!;
    const by = (pid: number) => list.find((e) => e.pid === pid)!;
    expect(isTerminalEntry(by(100), DOMAIN)).toBe(true);
    expect(isTerminalEntry(by(300), DOMAIN)).toBe(false);
    expect(isTerminalEntry(by(400), DOMAIN)).toBe(false);
    expect(isTerminalEntry({ ...by(100), kind: null, entrypoint: "cli" }, DOMAIN)).toBe(true);
    expect(isTerminalEntry({ ...by(100), pidDomain: null }, DOMAIN)).toBe(false);
  });

  it("only while the process is still a running claude.exe", async () => {
    expect([...(await openTerminalSessions({ dir, domain: DOMAIN, probe }))!]).toEqual([A]);
    expect(await isOpenInTerminal(A, { dir, domain: DOMAIN, probe })).toBe(true);
    expect(await isOpenInTerminal(B, { dir, domain: DOMAIN, probe })).toBe(false);
    expect(await isOpenInTerminal(C, { dir, domain: DOMAIN, probe })).toBe(false);
    expect(await isOpenInTerminal(D, { dir, domain: DOMAIN, probe })).toBe(false);
    // A pid reused by another program doesn't count; an unreadable name does (safe side).
    expect(await isOpenInTerminal(A, { dir, domain: DOMAIN, probe: async () => "notepad.exe" })).toBe(false);
    expect(await isOpenInTerminal(A, { dir, domain: DOMAIN, probe: async () => "?" })).toBe(true);
  });

  it("says when there is no registry, so the caller can use another check", async () => {
    expect(await isOpenInTerminal(A, { dir: path.join(dir, "missing"), domain: DOMAIN, probe })).toBeNull();
  });

  it("names this PC the way Claude Code does", () => {
    expect(thisPidDomain()).toBe(`${process.platform}:${os.hostname().toLowerCase()}`);
  });

  it.skipIf(process.platform !== "win32")("reads a real process's name, and knows a finished one", async () => {
    expect((await probeProcess(process.pid))?.toLowerCase()).toMatch(/^node(\.exe)?$/);
    // Pids are multiples of 4 on Windows: this one can't exist.
    expect(await probeProcess(4_194_303)).toBeNull();
  });
});
