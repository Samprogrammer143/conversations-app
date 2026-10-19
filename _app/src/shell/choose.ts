// Which app code to run: the newest copy that is committed, unmodified, in a git
// repository on this PC (the app's own repository), copied out of the working copy
// first so git can update it while the app runs; otherwise the copy the installer
// brought. Shared by the installer's shell and by the forwarder that older shells
// find in the conversations repository.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VERIFIED_MARK, verifyAgainstTree } from "./verify";

export interface Manifest {
  version: string;
  minShell?: string;
  builtAt?: string;
  /** The forwarder older shells find in a conversations repository: never run as the app. */
  forwarder?: boolean;
}

export const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

export function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8"));
    return typeof m?.version === "string" ? m : null;
  } catch {
    return null;
  }
}

/**
 * The git tree id of _app/dist when the working copy holds exactly what is
 * committed (nothing changed, nothing added); otherwise null.
 */
export function committedTree(repo: string): string | null {
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (git(["ls-files", "--error-unmatch", "_app/dist/app.json"]).status !== 0) return null;
  if (git(["diff", "--quiet", "HEAD", "--", "_app/dist"]).status !== 0) return null;
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "_app/dist"]);
  if (untracked.status !== 0 || untracked.stdout.trim() !== "") return null;
  const tree = git(["rev-parse", "HEAD:_app/dist"]);
  return tree.status === 0 ? tree.stdout.trim() : null;
}

export interface ChooseOptions {
  /** Repositories to take the app from, best first. */
  repos: string[];
  /** The copy the installer brought. */
  bundled: string;
  shellVersion: string;
  /** Where staged copies go. */
  stageRoot: string;
  log: (msg: string) => void;
}

/** The folder whose main/main.mjs to run. */
export function chooseApp(o: ChooseOptions): string {
  const bundledM = readManifest(o.bundled);
  for (const repo of o.repos) {
    const repoDist = path.join(repo, "_app", "dist");
    const repoM = readManifest(repoDist);
    if (!repoM || repoM.forwarder) continue;
    if (bundledM && cmp(repoM.version, bundledM.version) <= 0) return o.bundled;
    if (repoM.minShell && cmp(o.shellVersion, repoM.minShell) < 0) {
      o.log(`repository app ${repoM.version} needs shell ${repoM.minShell}; this is ${o.shellVersion}. Reinstall to update.`);
      return o.bundled;
    }
    const tree = committedTree(repo);
    if (!tree) {
      o.log(`repository app ${repoM.version} in ${repo} is not exactly what is committed; using the installed copy`);
      return o.bundled;
    }
    // Run from a private copy named after the exact committed files: a sync that
    // rewrites the working copy can't touch the running app, and no stale copy is reused.
    // The copy is checked file by file against the commit before it is ever run.
    const name = `${repoM.version}-${tree.slice(0, 12)}`;
    const stage = path.join(o.stageRoot, name);
    if (!fs.existsSync(path.join(stage, VERIFIED_MARK))) {
      const tmp = `${stage}.${process.pid}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(repoDist, tmp, { recursive: true });
      const problem = verifyAgainstTree(repo, tree, tmp);
      if (problem) {
        fs.rmSync(tmp, { recursive: true, force: true });
        o.log(`repository app ${repoM.version} changed while it was being copied (${problem}); using the installed copy this time`);
        return o.bundled;
      }
      fs.writeFileSync(path.join(tmp, VERIFIED_MARK), `${tree}\n`);
      // Another start (another workspace's window) may have set it up meanwhile, and may
      // be running from it: then that copy is used, never replaced.
      if (fs.existsSync(path.join(stage, VERIFIED_MARK))) fs.rmSync(tmp, { recursive: true, force: true });
      else {
        fs.rmSync(stage, { recursive: true, force: true });
        try {
          fs.renameSync(tmp, stage);
        } catch (e) {
          if (!fs.existsSync(path.join(stage, VERIFIED_MARK))) throw e;
          fs.rmSync(tmp, { recursive: true, force: true });
        }
        o.log(`staged app ${repoM.version} (${tree.slice(0, 12)}) from ${repo}`);
      }
    }
    // Old copies are tidied by the running app once it holds the single-instance
    // lock (see main.ts), never here: a second instance must not delete the stage
    // the live tray agent runs from.
    return stage;
  }
  return o.bundled;
}
