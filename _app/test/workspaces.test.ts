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
  it("leaves a workspace out of Conversations, and never starts in one that is", () => {
    const file = path.join(process.env.CONVERSATIONS_DATA_DIR!, "workspaces.json");
    ws.addWorkspace({ id: "work", name: "Work", remote: "https://github.com/me/work" });
    ws.prepareSwitch("main");
    ws.setDisconnected("main", true);
    // The current one is disconnected: a start goes to a connected one instead.
    expect(ws.listWorkspaces().current).toBe("work");
    expect(ws.listWorkspaces().workspaces.map((w) => [w.id, w.disconnected])).toEqual([
      ["main", true],
      ["work", false],
    ]);
    // Written as setup.ps1 writes it, read back the same.
    fs.writeFileSync(file, JSON.stringify({ current: "work", extra: [{ id: "work", name: "Work", remote: "https://github.com/me/work" }], disconnected: ["main", "gone"] }));
    expect(ws.listWorkspaces().workspaces.filter((w) => w.disconnected).map((w) => w.id)).toEqual(["main"]);
    ws.setDisconnected("main", false);
    expect(ws.listWorkspaces().workspaces.every((w) => !w.disconnected)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).disconnected).toBeUndefined();
    // With every workspace disconnected there is nothing better to start in: the recorded one stays.
    ws.setDisconnected("main", true);
    ws.setDisconnected("work", true);
    expect(ws.listWorkspaces().current).toBe("work");
    ws.setDisconnected("work", false);
    ws.setDisconnected("main", false);
    ws.removeWorkspace("work");
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

describe("a workspace in a window of its own", () => {
  it("is asked for by --workspace, or by the workspace a notification's link names", () => {
    expect(ws.askedFor(["electron.exe", ".", "--workspace=work"])).toBe("work");
    expect(ws.askedFor(["Conversations.exe", "--hidden", "--workspace=ycs-2"])).toBe("ycs-2");
    expect(ws.askedFor(["Conversations.exe", "conversations://review/abc%3A1?ws=work"])).toBe("work");
    expect(ws.askedFor(["Conversations.exe", "conversations://deny/abc?x=1&ws=main"])).toBe("main");
    // Nothing asked: the default (the one last switched to).
    expect(ws.askedFor(["Conversations.exe", "--hidden"])).toBeNull();
    expect(ws.askedFor(["Conversations.exe", "conversations://review/abc"])).toBeNull();
    // Only plain workspace names.
    expect(ws.askedFor(["x", "--workspace=../etc"])).toBeNull();
    expect(ws.askedFor(["x", "--workspace=Work"])).toBeNull();
  });

  it("each copy keeps to the workspace it started in, whatever the default becomes", () => {
    ws.addWorkspace({ id: "work", name: "Work", remote: "https://github.com/me/work" });
    const mine = ws.currentWorkspace().id;
    ws.prepareSwitch("work");
    // Another window switched: the default changes, this copy's workspace doesn't.
    expect(ws.defaultWorkspaceId()).toBe("work");
    expect(ws.currentWorkspace().id).toBe(mine);
    ws.prepareSwitch("main");
  });

  it("records which workspaces are open, and which were left open when the app stopped", async () => {
    const ow = await import("../src/main/open-windows");
    const dir = fs.mkdtempSync(path.join(process.env.CONVERSATIONS_DATA_DIR!, "open-"));
    const alive = (pid: number) => pid === 111 || pid === 222;
    ow.markOpen("main", 111, dir);
    ow.markOpen("work", 222, dir);
    ow.markOpen("ycs", 333, dir); // its copy is gone: still open when the PC shut down
    expect(ow.openElsewhere("work", 111, dir, alive)).toBe(true);
    expect(ow.openElsewhere("main", 111, dir, alive)).toBe(false); // that one is this copy
    expect(ow.openElsewhere("ycs", 111, dir, alive)).toBe(false);
    expect(ow.leftOpen(dir, alive)).toEqual(["ycs"]);
    // Quitting from the tray takes the record away; another copy's record stays.
    ow.unmarkOpen("work", 111, dir);
    expect(ow.openElsewhere("work", 111, dir, alive)).toBe(true);
    ow.unmarkOpen("work", 222, dir);
    expect(ow.openElsewhere("work", 111, dir, alive)).toBe(false);
    expect(ow.leftOpen(dir, alive)).toEqual(["ycs"]);
    ow.dropMark("ycs", dir);
    expect(ow.leftOpen(dir, alive)).toEqual([]);
    // Damaged records are ignored.
    fs.writeFileSync(path.join(dir, "bad.json"), "{");
    fs.writeFileSync(path.join(dir, "Not An Id.json"), JSON.stringify({ pid: 1, at: "" }));
    expect(ow.leftOpen(dir, alive)).toEqual([]);
  });
});

describe("open windows, kept honest", () => {
  it("a record not written lately, or from before the PC started, is not a running window (Windows reuses process numbers)", async () => {
    const ow = await import("../src/main/open-windows");
    const dir = fs.mkdtempSync(path.join(process.env.CONVERSATIONS_DATA_DIR!, "open-"));
    const alive = () => true; // some process has each number now
    fs.writeFileSync(path.join(dir, "work.json"), JSON.stringify({ pid: 222, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
    expect(ow.openElsewhere("work", 111, dir, alive)).toBe(false);
    expect(ow.leftOpen(dir, alive)).toEqual(["work"]);
    // Written just now, but the PC started after it (passed in here): from before a restart.
    ow.markOpen("ycs", 333, dir);
    expect(ow.openElsewhere("ycs", 111, dir, alive, Date.now() + 5 * 60_000)).toBe(false);
    expect(ow.openElsewhere("ycs", 111, dir, alive)).toBe(true);
    expect(ow.openNow(111, dir, alive)).toEqual(["ycs"]);
  });

  it("a new window starts with this one's arguments, less what only applied to this start", async () => {
    const { startArgs } = await import("../src/main/open-windows");
    // Development: the app's folder stays; the installed app has none.
    expect(startArgs(["electron.exe", "C:\\app", "--hidden", "--workspace=main"], "work")).toEqual(["C:\\app", "--workspace=work"]);
    expect(startArgs(["Conversations.exe"], "work", ["--hidden"])).toEqual(["--workspace=work", "--hidden"]);
    expect(startArgs(["Conversations.exe", "conversations://review/x?ws=main", "--restart-for-update", "--restart-others"], "main", ["--restart-others"])).toEqual(["--workspace=main", "--restart-others"]);
  });
});
