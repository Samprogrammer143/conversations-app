import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// workspace.ts reads its registry when it loads: a scratch data folder, never the real one.
vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "auth-unit-"));
  process.env.CONVERSATIONS_DATA_DIR = dir;
  process.env.CLAUDE_SYNC_HOME = require("node:path").join(dir, "sync");
  delete process.env.CLAUDE_CONFIG_DIR;
});
vi.mock("../src/main/log", () => ({ log: () => {} }));

const { parseAuthStatus, authEnv, authStatus, startLogin, submitLoginCode, cancelLogin, isClaudeSignInUrl, loginEnded } = await import("../src/main/auth");
const ws = await import("../src/main/workspace");

describe("a workspace's Claude account", () => {
  it("reads what claude auth status says", () => {
    expect(parseAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "email": "me@example.com"\n}\n')).toMatchObject({ loggedIn: true, email: "me@example.com" });
    expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none", "configDirectory": "C:\\\\x"}')).toMatchObject({ loggedIn: false, email: null });
    // A warning printed before the JSON doesn't matter; output that isn't the status means "can't tell".
    expect(parseAuthStatus('Warning: something\n{"loggedIn": true}')).toMatchObject({ loggedIn: true, email: null });
    // Another organisation under the same email is another login.
    expect(parseAuthStatus('{"loggedIn": true, "email": "a@b.c", "orgId": "1"}')!.key).not.toBe(parseAuthStatus('{"loggedIn": true, "email": "a@b.c", "orgId": "2"}')!.key);
    expect(parseAuthStatus("Not logged in · Please run /login")).toBeNull();
    expect(parseAuthStatus('{"other": 1}')).toBeNull();
  });
  it("asks Claude Code with each workspace's own Claude folder", () => {
    ws.addWorkspace({ id: "work", name: "Work", remote: "https://github.com/me/work" });
    const [main, work] = ws.listWorkspaces().workspaces;
    expect(authEnv(main).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(authEnv(work).CLAUDE_CONFIG_DIR).toBe(work.claudeDir);
    expect(authEnv(work).CLAUDE_SYNC_HOME).toBe(work.syncHome);
    expect(authEnv(work).ELECTRON_RUN_AS_NODE).toBeUndefined();
    ws.removeWorkspace("work");
  });
  it("can't tell without Claude Code (the window then keeps what the files say)", async () => {
    const [main] = ws.listWorkspaces().workspaces;
    expect(await authStatus(main, null, true)).toBeNull();
    expect(await authStatus(main, path.join(process.env.CONVERSATIONS_DATA_DIR!, "no-such-claude.exe"), true)).toBeNull();
    expect(fs.existsSync(process.env.CONVERSATIONS_DATA_DIR!)).toBe(true);
  });
});

describe("signing in from the app", () => {
  // A stand-in for `claude auth login`: prints the sign-in address, then takes a code.
  const fake = path.join(process.env.CONVERSATIONS_DATA_DIR!, "fake-login.mjs");
  fs.writeFileSync(
    fake,
    [
      'process.stdout.write("Opening browser to sign in\\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > ");',
      'process.stdin.once("data", (d) => { if (String(d).trim() === "good#code") process.exit(0); console.log("Login failed: Request failed with status code 400"); process.exit(1); });',
    ].join("\n"),
  );
  const main = () => ws.listWorkspaces().workspaces[0];
  it("hands back the sign-in page's address, then signs in with the code", async () => {
    const r = await startLogin(main(), process.execPath, [fake]);
    expect(r).toEqual({ ok: true, url: "https://claude.com/cai/oauth/authorize?code=true&state=abc" });
    expect(await submitLoginCode("main", "  good#code  ")).toEqual({ ok: true });
  });
  it("says why a wrong code didn't work", async () => {
    await startLogin(main(), process.execPath, [fake]);
    expect(await submitLoginCode("main", "bad")).toEqual({ ok: false, err: "Login failed: Request failed with status code 400" });
    // The sign-in has ended: a second try needs a new one.
    expect((await submitLoginCode("main", "good#code")).err).toMatch(/start it again/);
  });
  it("refuses something that isn't a code, and can be cancelled", async () => {
    await startLogin(main(), process.execPath, [fake]);
    expect((await submitLoginCode("main", "two\nlines")).ok).toBe(false);
    cancelLogin("main");
    expect((await submitLoginCode("main", "good#code")).err).toMatch(/start it again/);
  });
  it("waits for the whole address, without terminal colours", async () => {
    const split = path.join(process.env.CONVERSATIONS_DATA_DIR!, "split-login.mjs");
    fs.writeFileSync(
      split,
      [
        'process.stdout.write("\\x1b[1mvisit: https://claude.com/cai/oauth/authorize?code=true&sta");',
        'setTimeout(() => process.stdout.write("te=abc\\x1b[0m\\nPaste code here if prompted > "), 300);',
        'process.stdin.once("data", () => process.exit(0));',
      ].join("\n"),
    );
    const r = await startLogin(main(), process.execPath, [split]);
    expect(r).toEqual({ ok: true, url: "https://claude.com/cai/oauth/authorize?code=true&state=abc" });
    cancelLogin("main");
  });
  it("opens only Claude's own sign-in pages", async () => {
    expect(isClaudeSignInUrl("https://claude.com/cai/oauth/authorize?x=1")).toBe(true);
    expect(isClaudeSignInUrl("https://console.anthropic.com/oauth/x")).toBe(true);
    expect(isClaudeSignInUrl("http://claude.com/oauth")).toBe(false);
    expect(isClaudeSignInUrl("https://evil.example/oauth?claude.com")).toBe(false);
    expect(isClaudeSignInUrl("https://claude.com.evil.example/oauth")).toBe(false);
    const evil = path.join(process.env.CONVERSATIONS_DATA_DIR!, "evil-login.mjs");
    fs.writeFileSync(evil, 'process.stdout.write("visit: https://evil.example/oauth/authorize?x=1\\n"); setTimeout(() => {}, 5000);');
    const r = await startLogin(main(), process.execPath, [evil]);
    expect(r.ok).toBe(false);
  });
  it("takes one code at a time", async () => {
    const slow = path.join(process.env.CONVERSATIONS_DATA_DIR!, "slow-login.mjs");
    fs.writeFileSync(slow, 'process.stdout.write("visit: https://claude.com/cai/oauth/authorize?s=1\\n"); process.stdin.once("data", () => setTimeout(() => process.exit(0), 400));');
    await startLogin(main(), process.execPath, [slow]);
    const first = submitLoginCode("main", "abc");
    expect((await submitLoginCode("main", "abc")).err).toMatch(/Already/);
    expect(await first).toEqual({ ok: true });
  });
  it("notices a sign-in the browser finished by itself (no code)", async () => {
    const auto = path.join(process.env.CONVERSATIONS_DATA_DIR!, "auto-login.mjs");
    fs.writeFileSync(auto, 'process.stdout.write("visit: https://claude.com/cai/oauth/authorize?a=1\\nPaste code here if prompted > "); setTimeout(() => { console.log("Login successful."); process.exit(0); }, 300);');
    await startLogin(main(), process.execPath, [auto]);
    expect(await loginEnded("main")).toMatchObject({ code: 0, byCode: false, cancelled: false });
  });
  it("says nothing about a sign-in the app ended itself (Try again, Cancel)", async () => {
    await startLogin(main(), process.execPath, [fake]);
    const ended = loginEnded("main")!;
    cancelLogin("main");
    expect(await ended).toMatchObject({ cancelled: true });
  });
  it("reports a Claude Code that can't start the sign-in", async () => {
    const r = await startLogin(main(), path.join(process.env.CONVERSATIONS_DATA_DIR!, "no-such-claude.exe"));
    expect(r.ok).toBe(false);
  });
});
