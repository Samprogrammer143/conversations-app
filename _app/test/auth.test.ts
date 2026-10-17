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

const { parseAuthStatus, authEnv, authStatus, signInTook } = await import("../src/main/auth");
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
  it("knows when a sign-in took", () => {
    const out = parseAuthStatus('{"loggedIn": false}');
    const a = parseAuthStatus('{"loggedIn": true, "email": "a@b.c", "orgId": "1"}');
    const b = parseAuthStatus('{"loggedIn": true, "email": "a@b.c", "orgId": "2"}');
    // Signed out before, signed in now.
    expect(signInTook({ state: out, credsAt: 0 }, a, 0)).toBe(true);
    // Already signed in: only another login counts (a token refresh rewrites the file too).
    expect(signInTook({ state: a, credsAt: 5 }, a, 5)).toBe(false);
    expect(signInTook({ state: a, credsAt: 5 }, b, 5)).toBe(true);
    expect(signInTook({ state: a, credsAt: 5 }, a, 9)).toBe(false);
    // No reading from before (Claude Code didn't answer): only a written login counts.
    expect(signInTook({ state: null, credsAt: 5 }, a, 5)).toBe(false);
    expect(signInTook({ state: null, credsAt: 5 }, a, 6)).toBe(true);
    // Not signed in now: never.
    expect(signInTook({ state: out, credsAt: 0 }, out, 7)).toBe(false);
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
