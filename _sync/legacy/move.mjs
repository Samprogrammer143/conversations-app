// Moves this PC's conversation sync onto the app's own repository: clones it (it is
// public, no sign-in), installs its run-time packages, and runs its installer, which
// points Claude Code's hooks and the /push and /pull skills at the engine there.
// Started in the background by the forwarder (sync.mjs) next to this file; safe to
// run again. Writes what it did to move.log beside the sync folder's sync.log.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_REPO_URL = process.env.CONVERSATIONS_APP_REPO_URL || "https://github.com/Samprogrammer143/conversations-app.git";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const local = () => process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
function appDir() {
  if (process.env.CONVERSATIONS_APP_HOME) return process.env.CONVERSATIONS_APP_HOME;
  if (process.platform === "win32") return path.join(local(), "conversations-app");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "conversations-app");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "conversations-app");
}
// This file is in <sync folder>/repo/_sync/.
const syncDir = path.resolve(HERE, "..", "..");
const logFile = path.join(syncDir, "move.log");
const say = (m) => {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  } catch {}
};
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ELECTRON_RUN_AS_NODE: "1" } });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}${r.error?.message || ""}`.trim() };
};

const APP = appDir();
const node = process.execPath;
if (!fs.existsSync(path.join(APP, ".git"))) {
  fs.mkdirSync(path.dirname(APP), { recursive: true });
  const tmp = `${APP}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const c = run("git", ["-c", "core.longpaths=true", "clone", "--quiet", APP_REPO_URL, tmp], path.dirname(APP));
  if (!c.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    say(`could not clone the app's repository (tries again later): ${c.out}`);
    process.exit(1);
  }
  run("git", ["config", "core.autocrlf", "false"], tmp);
  try {
    fs.renameSync(tmp, APP);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(path.join(APP, ".git"))) {
      say(`could not finish the clone: ${e.message}`);
      process.exit(1);
    }
  }
  say(`cloned the app's repository into ${APP}`);
}
// The run-time packages the app loads (Claude's Agent SDK), from npm.
const rt = run(node, [path.join(APP, "_sync", "sync.mjs"), "app", "--json"], APP);
say(`app set up: ${rt.out.split(/\r?\n/).pop()}`);
// The hooks and skills move to the engine there (this PC's first workspace).
const inst = run(node, [path.join(APP, "_sync", "install.mjs")], APP);
say(inst.ok ? "hooks and skills now use the app repository's engine" : `the installer stopped (tries again later): ${inst.out.slice(-400)}`);
process.exit(inst.ok ? 0 : 1);
