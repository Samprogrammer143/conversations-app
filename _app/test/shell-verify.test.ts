// The installer shell runs repository app code only after checking the staged copy
// against the commit, file by file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERIFIED_MARK, verifyAgainstTree } from "../src/shell/verify";

let repo: string;
let tree: string;
let n = 0;

const git = (args: string[], cwd = repo) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A fresh copy of the committed dist/ folder, as the shell would stage it. */
function stage(): string {
  const dir = path.join(repo, "..", `stage-${++n}`);
  fs.cpSync(path.join(repo, "dist"), dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "shell-verify-"));
  repo = path.join(base, "repo");
  fs.mkdirSync(path.join(repo, "dist", "main"), { recursive: true });
  git(["init", "--quiet"]);
  git(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, ".gitattributes"), "* -text\n");
  fs.writeFileSync(path.join(repo, "dist", "app.json"), '{ "version": "0.2.0" }\n');
  fs.writeFileSync(path.join(repo, "dist", "main", "main.mjs"), "console.log('app');\r\nexport {};\n");
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "dist"]);
  tree = git(["rev-parse", "HEAD:dist"]);
});
afterAll(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));

describe("a staged copy of the repository's app", () => {
  it("passes when it is exactly the commit (the shell's own mark aside)", () => {
    const dir = stage();
    expect(verifyAgainstTree(repo, tree, dir)).toBeNull();
    fs.writeFileSync(path.join(dir, VERIFIED_MARK), tree);
    expect(verifyAgainstTree(repo, tree, dir)).toBeNull();
  });

  it("fails when a file changed while it was copied", () => {
    const dir = stage();
    fs.writeFileSync(path.join(dir, "main", "main.mjs"), "console.log('half of a newer version');\n");
    expect(verifyAgainstTree(repo, tree, dir)).toMatch(/main\/main\.mjs differs/);
  });

  it("fails when a file is missing or extra", () => {
    const missing = stage();
    fs.rmSync(path.join(missing, "app.json"));
    expect(verifyAgainstTree(repo, tree, missing)).toMatch(/1 files copied, 2 committed/);
    const extra = stage();
    fs.writeFileSync(path.join(extra, "main", "stray.mjs"), "x");
    expect(verifyAgainstTree(repo, tree, extra)).toMatch(/3 files copied, 2 committed/);
    const swapped = stage();
    fs.renameSync(path.join(swapped, "app.json"), path.join(swapped, "other.json"));
    expect(verifyAgainstTree(repo, tree, swapped)).toMatch(/other\.json is not in the commit/);
  });

  it("fails on a tree git doesn't have", () => {
    expect(verifyAgainstTree(repo, "0".repeat(40), stage())).toMatch(/ls-tree failed/);
  });
});
