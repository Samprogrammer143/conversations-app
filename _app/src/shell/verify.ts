// Checks that a staged copy of the app holds exactly the files git has in a
// committed tree: the same paths, and every file hashing to its blob. A sync that
// rewrites the working copy while the shell copies it would otherwise leave a mix
// of two versions, kept under the newer tree's name.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Written into a staged copy once it has been checked (holds the tree id). */
export const VERIFIED_MARK = ".verified";

function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

/** null when the copy in `dir` matches `tree` exactly; otherwise what is wrong. */
export function verifyAgainstTree(repo: string, tree: string, dir: string): string | null {
  const git = (args: string[], input?: string) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 60_000, input, maxBuffer: 64 * 1024 * 1024 });
  const ls = git(["ls-tree", "-r", "-z", tree]);
  if (ls.status !== 0) return `git ls-tree failed: ${(ls.stderr || "").trim()}`;
  const want = new Map<string, string>();
  for (const rec of ls.stdout.split("\0").filter(Boolean)) {
    const m = rec.match(/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!m) return "git ls-tree printed something unexpected";
    if (m[2] === "blob") want.set(m[4], m[3]);
  }
  let have: string[];
  try {
    have = listFiles(dir).filter((f) => f !== VERIFIED_MARK);
  } catch (e) {
    return `can't read the copy: ${(e as Error).message}`;
  }
  if (have.length !== want.size) return `${have.length} files copied, ${want.size} committed`;
  for (const f of have) if (!want.has(f)) return `${f} is not in the commit`;
  const order = [...want.keys()];
  const hashed = git(["hash-object", "--no-filters", "--stdin-paths"], order.map((f) => path.join(dir, ...f.split("/"))).join("\n") + "\n");
  if (hashed.status !== 0) return `git hash-object failed: ${(hashed.stderr || "").trim()}`;
  const shas = hashed.stdout.trim().split(/\r?\n/);
  for (let i = 0; i < order.length; i++) if (shas[i] !== want.get(order[i])) return `${order[i]} differs from the committed file`;
  return null;
}
