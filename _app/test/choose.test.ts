// Which app code the shell (and the forwarder older shells find) runs, against real
// git repositories in a temporary folder.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { chooseApp } from "../src/shell/choose";
import { VERIFIED_MARK } from "../src/shell/verify";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "choose-"));
afterAll(() => fs.rmSync(T, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
let n = 0;
function repo(manifest: Record<string, unknown> | null) {
  const dir = path.join(T, `repo-${n++}`);
  fs.mkdirSync(path.join(dir, "_app", "dist", "main"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitattributes"), "* -text\n");
  if (manifest) fs.writeFileSync(path.join(dir, "_app", "dist", "app.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "_app", "dist", "main", "main.mjs"), `export const v = ${JSON.stringify(manifest?.version ?? null)};\n`);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "app");
  return dir;
}
const bundled = path.join(T, "bundled");
fs.mkdirSync(bundled, { recursive: true });
fs.writeFileSync(path.join(bundled, "app.json"), JSON.stringify({ version: "0.5.0" }));
const logs: string[] = [];
const choose = (repos: string[], shellVersion = "2.0.0") => chooseApp({ repos, bundled, shellVersion, stageRoot: path.join(T, "stages"), log: (m) => logs.push(m) });

describe("the app code a start runs", () => {
  it("a newer, committed version in the app's repository, from a checked staged copy", () => {
    const r = repo({ version: "0.6.0", minShell: "1.0.0" });
    const d = choose([r]);
    expect(d.startsWith(path.join(T, "stages"))).toBe(true);
    expect(path.basename(d)).toMatch(/^0\.6\.0-[0-9a-f]{12}$/);
    expect(fs.existsSync(path.join(d, VERIFIED_MARK))).toBe(true);
    expect(fs.readFileSync(path.join(d, "main", "main.mjs"), "utf8")).toContain("0.6.0");
  });
  it("the installed copy when the repository's version isn't newer", () => {
    expect(choose([repo({ version: "0.5.0" })])).toBe(bundled);
    expect(choose([repo({ version: "0.4.9" })])).toBe(bundled);
  });
  it("never the forwarder: the next repository instead", () => {
    const fwd = repo({ version: "0.9.0", forwarder: true });
    const old = repo({ version: "0.7.0" });
    expect(path.basename(choose([fwd, old]))).toMatch(/^0\.7\.0-/);
    expect(choose([fwd])).toBe(bundled);
  });
  it("the old place only when the app's repository has no app yet", () => {
    const empty = path.join(T, "no-app-yet");
    fs.mkdirSync(empty);
    expect(path.basename(choose([empty, repo({ version: "0.6.1" })]))).toMatch(/^0\.6\.1-/);
    // The app's repository wins when it has one, even an older one than the old place's.
    expect(choose([repo({ version: "0.5.0" }), repo({ version: "0.8.0" })])).toBe(bundled);
  });
  it("the installed copy when the working copy was changed", () => {
    const r = repo({ version: "0.6.2" });
    fs.appendFileSync(path.join(r, "_app", "dist", "main", "main.mjs"), "// edited\n");
    expect(choose([r])).toBe(bundled);
    expect(logs.some((l) => l.includes("not exactly what is committed"))).toBe(true);
  });
  it("the installed copy when the app needs a newer shell", () => {
    expect(choose([repo({ version: "0.6.3", minShell: "3.0.0" })])).toBe(bundled);
    expect(logs.some((l) => l.includes("needs shell 3.0.0"))).toBe(true);
  });
  it("an old shell (the forwarder runs under it) still runs an app that allows shell 1", () => {
    expect(path.basename(choose([repo({ version: "0.6.4", minShell: "1.0.0" })], "1.0.0"))).toMatch(/^0\.6\.4-/);
  });
});

describe("where Claude's Agent SDK is found", () => {
  it("in order: an override, this version's install, other installs, the installer's copy, a checkout's", async () => {
    const appHome = path.join(T, "app-home");
    fs.mkdirSync(path.join(appHome, "_app", "runtime"), { recursive: true });
    const lock = '{"lockfileVersion":3}\n';
    fs.writeFileSync(path.join(appHome, "_app", "runtime", "package-lock.json"), lock);
    const hash = crypto.createHash("sha256").update(lock).digest("hex").slice(0, 12);
    const rt = `${appHome}-runtime`;
    for (const [name, age] of [["older", 2000], [hash, 1000], ["newest-other", 0]] as const) {
      fs.mkdirSync(path.join(rt, name), { recursive: true });
      fs.writeFileSync(path.join(rt, name, ".ready"), "");
      const t = new Date(Date.now() - age * 1000);
      fs.utimesSync(path.join(rt, name), t, t);
    }
    fs.mkdirSync(path.join(rt, "unfinished"), { recursive: true });
    process.env.CONVERSATIONS_APP_HOME = appHome;
    process.env.CONVERSATIONS_SDK_DIR = path.join(T, "override");
    const { sdkCandidates } = await import("../src/main/chat/sdk");
    const pkg = path.join("node_modules", "@anthropic-ai", "claude-agent-sdk");
    expect(sdkCandidates(path.join(T, "install"), path.join(T, "resources"))).toEqual([
      path.join(T, "override"),
      path.join(rt, hash, pkg),
      path.join(rt, "newest-other", pkg),
      path.join(rt, "older", pkg),
      path.join(T, "resources", "sdk", pkg),
      path.join(T, "install", pkg),
    ]);
    // Developing (no installed resources): the checkout's SDK right after an override.
    expect(sdkCandidates(path.join(T, "install"), null).slice(0, 3)).toEqual([path.join(T, "override"), path.join(T, "install", pkg), path.join(rt, hash, pkg)]);
    delete process.env.CONVERSATIONS_SDK_DIR;
    delete process.env.CONVERSATIONS_APP_HOME;
  });
  it("query() runs the SDK that was found, and says so when there is none", async () => {
    const sdk = await import("../src/main/chat/sdk");
    expect(() => sdk.query({ prompt: "x" } as never)).toThrow(/isn't installed/);
    const fake = path.join(T, "fake-sdk");
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, "package.json"), "{}");
    fs.writeFileSync(path.join(fake, "sdk.mjs"), "export function query(a) { return { got: a.prompt }; }\n");
    process.env.CONVERSATIONS_SDK_DIR = fake;
    const r = await sdk.loadSdk(null, null);
    delete process.env.CONVERSATIONS_SDK_DIR;
    expect(r).toEqual({ ok: true, from: fake });
    expect(sdk.query({ prompt: "hello" } as never)).toEqual({ got: "hello" });
  });
});
