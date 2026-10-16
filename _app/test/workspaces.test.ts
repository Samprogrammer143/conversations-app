import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// workspace.ts reads its registry when it loads: a scratch data folder, never the real one.
vi.hoisted(() => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "ws-unit-"));
  process.env.CONVERSATIONS_DATA_DIR = dir;
  process.env.CLAUDE_SYNC_HOME = require("node:path").join(dir, "sync");
});
vi.mock("../src/main/log", () => ({ log: () => {} }));

const { repoKey } = await import("../src/main/workspace-actions");
const ws = await import("../src/main/workspace");

describe("repoKey", () => {
  it("treats the https and SSH forms of one repository as the same", () => {
    const k = repoKey("https://github.com/Me/work-conversations");
    expect(repoKey("git@github.com:me/work-conversations.git")).toBe(k);
    expect(repoKey("ssh://git@github.com/me/work-conversations.git")).toBe(k);
    expect(repoKey("ssh://git@github.com:22/me/work-conversations")).toBe(k);
    expect(repoKey("https://user@github.com/me/work-conversations.git/")).toBe(k);
    expect(repoKey("  HTTPS://GITHUB.COM/me/work-conversations/  ")).toBe(k);
  });
  it("keeps different repositories apart", () => {
    expect(repoKey("https://github.com/me/a")).not.toBe(repoKey("https://github.com/me/b"));
    expect(repoKey("https://github.com/me/a")).not.toBe(repoKey("https://gitlab.com/me/a"));
  });
  it("matches local folders however they are written", () => {
    expect(repoKey("C:\\Repos\\Main.git\\")).toBe(repoKey("c:/repos/main.git"));
  });
});

describe("workspace registry", () => {
  it("sets an unreadable registry aside instead of overwriting it", () => {
    const dir = process.env.CONVERSATIONS_DATA_DIR!;
    fs.writeFileSync(path.join(dir, "workspaces.json"), "{ not json");
    expect(ws.listWorkspaces().workspaces.map((w) => w.id)).toEqual(["main"]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("workspaces.json.unreadable-"))).toBe(true);
  });
  it("adds, renames and removes a workspace", () => {
    ws.addWorkspace({ id: "work", name: "Work", remote: "https://github.com/me/work" });
    ws.renameWorkspace("work", "Work Projects");
    ws.renameWorkspace("main", "Acme & Co");
    const l = ws.listWorkspaces();
    expect(l.workspaces.map((w) => [w.id, w.name])).toEqual([
      ["main", "Acme & Co"],
      ["work", "Work Projects"],
    ]);
    expect(l.workspaces[1].dataDir).toBe(path.join(process.env.CONVERSATIONS_DATA_DIR!, "workspaces", "work"));
    ws.removeWorkspace("work");
    expect(ws.listWorkspaces().workspaces).toHaveLength(1);
  });
  it("refuses ids that are not plain names", () => {
    for (const bad of ["../x", "Main", "", "a b", "x".repeat(41)]) expect(ws.isWorkspaceId(bad)).toBe(false);
    expect(ws.isWorkspaceId("work-2")).toBe(true);
  });
  it("gives a new workspace a free id", () => {
    expect(ws.newWorkspaceId("Main")).toBe("main-2");
    ws.addWorkspace({ id: "work", name: "Work", remote: "https://github.com/me/work" });
    expect(ws.newWorkspaceId("Work")).toBe("work-2");
  });
});
