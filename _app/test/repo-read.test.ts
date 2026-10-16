// The app reads the sync repository directly (repo-read.ts) with the same rules
// as the engine. This checks both give the same answers on the same repository:
// a synthetic one that covers every rule, and the development sandbox's copy of
// the real one when it is there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { listRemoteSessions, normaliseRemote, readDevices, readEdits } from "../src/main/sync/repo-read";

const engineDir = path.resolve(__dirname, "..", "..", "_sync");
const engine = path.join(engineDir, "sync.mjs");

/** The engine's own `list --json` for a sync folder whose repo/ is repoDir. */
function engineList(syncHome: string, claudeDir: string) {
  const r = spawnSync(process.execPath, [engine, "list", "--json"], { encoding: "utf8", env: { ...process.env, CLAUDE_SYNC_HOME: syncHome, CLAUDE_CONFIG_DIR: claudeDir } });
  return JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
}

function expectSameAsEngine(repo: string, out: { sessions: { sessionId: string; projectId: string; projectLabel: string; key: string }[]; state: Record<string, Record<string, unknown>> }) {
  const mine = new Map(listRemoteSessions(repo).map((s) => [s.sessionId, s]));
  expect(out.sessions.length).toBe(mine.size);
  for (const s of out.sessions) {
    const m = mine.get(s.sessionId);
    expect(m, s.sessionId).toBeTruthy();
    expect(m!.projectId, s.sessionId).toBe(s.projectId);
    expect(m!.projectLabel).toBe(s.projectLabel);
    expect(m!.key).toBe(s.key);
  }
  const edits = readEdits(repo);
  expect(new Set(edits.keys())).toEqual(new Set(Object.keys(out.state)));
  for (const [id, e] of Object.entries(out.state)) {
    const m = (edits.get(id) ?? {}) as Record<string, unknown>;
    for (const f of ["pinned", "title", "archived", "deleted", "app"]) if (f in e) expect(m[f], `${id}.${f}`).toEqual(e[f]);
  }
}

// ---------------------------------------------------------------- synthetic repository

const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-read-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const syncHome = path.join(root, "sync");
const repo = path.join(syncHome, "repo");
const claudeDir = path.join(root, ".claude");
fs.mkdirSync(claudeDir, { recursive: true });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function meta(key: string, n: number, m: Record<string, unknown>) {
  const dir = path.join(repo, key, id(n));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ sessionId: id(n), project: key, title: `chat ${n}`, ...m }));
}
// Same PC and folder as a chat with a remote: joins that repository.
meta("site", 1, { gitRemote: "git@github.com:Sam/Site.git", updatedAt: "2026-10-01T00:00:00Z", machines: { "Home PC": { cwd: "C:\\work\\site" } } });
meta("site", 2, { gitRemote: null, updatedAt: "2026-10-02T00:00:00Z", machines: { "Home PC": { cwd: "c:\\work\\site" } } });
// Same folder name, another PC and folder: stays a folder project.
meta("site", 3, { gitRemote: null, updatedAt: "2026-10-03T00:00:00Z", machines: { "Uni PC": { cwd: "C:\\Users\\jordan\\site" } } });
// The newest remote at a place wins when a folder's remote changed.
meta("app", 4, { gitRemote: "https://github.com/sam/old-app", updatedAt: "2026-09-01T00:00:00Z", machines: { Laptop: { cwd: "D:\\app" } } });
meta("app", 5, { gitRemote: "https://github.com/sam/new-app", updatedAt: "2026-10-05T00:00:00Z", machines: { Laptop: { cwd: "D:\\app" } } });
meta("app", 6, { gitRemote: null, updatedAt: "2026-10-06T00:00:00Z", machines: { Laptop: { cwd: "D:\\app" } } });
// Remote spellings that must meet: ssh with a port, GitLab subgroups, Azure DevOps.
meta("gl", 7, { gitRemote: "ssh://git@gitlab.com:2222/group/sub/repo.git", machines: {} });
meta("gl", 8, { gitRemote: "https://gitlab.com/group/sub/repo", machines: {} });
meta("az", 9, { gitRemote: "https://org.visualstudio.com/DefaultCollection/proj/_git/repo", machines: {} });
meta("az", 10, { gitRemote: "git@ssh.dev.azure.com:v3/org/proj/repo", machines: {} });
meta("_home", 11, { gitRemote: null, machines: {} });
// Not conversations: a folder that is not a UUID, and a meta.json naming another id.
fs.mkdirSync(path.join(repo, "site", "not-a-uuid"), { recursive: true });
fs.writeFileSync(path.join(repo, "site", "not-a-uuid", "meta.json"), JSON.stringify({ sessionId: "not-a-uuid" }));
fs.mkdirSync(path.join(repo, "site", id(12)), { recursive: true });
fs.writeFileSync(path.join(repo, "site", id(12), "meta.json"), JSON.stringify({ sessionId: id(13) }));
// Edit logs from two PCs, with lines that must be ignored.
fs.mkdirSync(path.join(repo, "_state"), { recursive: true });
const op = (hlc: string, session: string, field: string, value: unknown) => JSON.stringify({ hlc, pc: "x", at: "2026-10-10T00:00:00Z", session, field, value });
fs.writeFileSync(
  path.join(repo, "_state", "home-pc.jsonl"),
  [
    op("000001791600000000-0000-home-pc", id(1), "pinned", true),
    op("000001791600000005-0000-home-pc", id(1), "title", "Renamed at home"),
    op("000001791600000006-0000-home-pc", id(2), "app", true),
    op("000001791600000007-0000-home-pc", "..\\..\\history", "deleted", true),
    op("000001791600000008-0000-home-pc", id(3), "pinned", "yes"),
    op("000001791600000009-0000-home-pc", id(3), "colour", "red"),
    "not json",
  ].join("\n") + "\n",
);
fs.writeFileSync(
  path.join(repo, "_state", "laptop.jsonl"),
  [op("000001791600000007-0000-laptop", id(1), "title", "Renamed on the laptop"), op("000001791600000001-0000-laptop", id(1), "pinned", false), op("000001791600000002-0000-laptop", id(4), "deleted", true)].join("\n") + "\n",
);
fs.mkdirSync(path.join(repo, "_devices"), { recursive: true });
fs.writeFileSync(path.join(repo, "_devices", "home-pc.json"), JSON.stringify({ name: "Home PC", pcId: "abc", engine: 3 }));

describe("repo-read matches the engine on a repository that covers every rule", () => {
  const out = engineList(syncHome, claudeDir);

  it("finds the same conversations with the same project ids", () => {
    expectSameAsEngine(repo, out);
    const p = new Map(listRemoteSessions(repo).map((s) => [s.sessionId, s.projectId]));
    expect(p.get(id(2))).toBe("github.com/sam/site");
    expect(p.get(id(3))).toBe("folder:site");
    expect(p.get(id(6))).toBe("github.com/sam/new-app");
    expect(p.get(id(7))).toBe(p.get(id(8)));
    expect(p.get(id(9))).toBe("dev.azure.com/org/proj/repo");
    expect(p.get(id(10))).toBe("dev.azure.com/org/proj/repo");
    expect(p.has("not-a-uuid")).toBe(false);
    expect(p.has(id(12))).toBe(false);
  });

  it("merges edits the same way, including the app field, and ignores invalid lines", () => {
    const e = readEdits(repo);
    // Per field, the later clock wins: the laptop's unpin and rename are both later.
    expect(e.get(id(1))).toEqual({ pinned: false, title: "Renamed on the laptop" });
    expect(e.get(id(2))).toEqual({ app: true });
    expect(e.has(id(3))).toBe(false);
    expect([...e.keys()].every((k) => /^[0-9a-f-]{36}$/.test(k))).toBe(true);
  });

  it("spells remotes like the engine", () => {
    const urls = [
      "https://github.com/Acme/Website",
      "git@github.com:Acme/Website.git",
      "ssh://git@github.com:2222/Owner/Repo.git",
      "https://user:tok@github.com/Owner/Repo/",
      "https://gitlab.com/group/subgroup/repo.git",
      "https://org@dev.azure.com/org/project/_git/repo",
      "C:\\Users\\x\\remote.git",
    ];
    const code = `const e = await import(${JSON.stringify(pathToFileURL(path.join(engineDir, "engine.mjs")).href)}); console.log(JSON.stringify(${JSON.stringify(urls)}.map((u) => e.normaliseRemote(u))));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, CLAUDE_SYNC_HOME: syncHome, CLAUDE_CONFIG_DIR: claudeDir } });
    expect(urls.map((u) => normaliseRemote(u))).toEqual(JSON.parse(r.stdout.trim()));
  });

  it("reads device files", () => {
    expect(readDevices(repo).map((d) => d.name)).toEqual(["Home PC"]);
  });
});

// ---------------------------------------------------------------- the sandbox's copy of the real repository

const sandbox = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Conversations-dev", "sync");
const sandboxRepo = path.join(sandbox, "repo");

describe.skipIf(!fs.existsSync(path.join(sandboxRepo, ".git")))("repo-read matches the engine on the sandbox copy of the real repository", () => {
  it("gives the same conversations, project ids and edits", () => {
    expectSameAsEngine(sandboxRepo, engineList(sandbox, claudeDir));
  });

  it("reads device files", () => {
    for (const d of readDevices(sandboxRepo)) expect(typeof d.name).toBe("string");
  });
});
