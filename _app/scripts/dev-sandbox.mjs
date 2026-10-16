// Development sandbox: a private copy of the sync repository (a local bare mirror
// stands in for GitHub) and a separate app data folder, so running the app while
// developing never touches the real working copy or pushes anywhere.
//
// Chats the app starts in the sandbox still run on this PC's real Claude Code (it
// needs its login, and credentials are never copied), so their transcripts land
// in ~/.claude/projects. Two things keep them out of the real sync:
// - CLAUDE_SYNC_DISABLE=1 turns Claude Code's sync hooks off for those chats;
// - collectE2eTranscripts() moves their folders into the sandbox after a test run.
//
//   node scripts/dev-sandbox.mjs                       create it (once)
//   node scripts/dev-sandbox.mjs --env                 print the environment for running the app
//   node scripts/dev-sandbox.mjs --collect-e2e <dir>   move the test chats that ran in <dir> into the sandbox
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const base = path.join(local, "Conversations-dev");
const live = path.join(local, "claude-conversation-sync", "repo");
const mirror = path.join(base, "github-standin.git");
const syncHome = path.join(base, "sync");
const data = path.join(base, "data");

export const sandboxEnv = {
  CLAUDE_SYNC_HOME: syncHome,
  CONVERSATIONS_DATA_DIR: data,
  CONVERSATIONS_ENGINE: path.join(root, "..", "_sync", "sync.mjs"),
  // Claude Code's own sync hooks skip chats started from the sandbox.
  CLAUDE_SYNC_DISABLE: "1",
};

/**
 * The environment to launch the sandbox app with. A Claude Code session that runs
 * inside the installed Conversations app carries that app's own CONVERSATIONS_*,
 * CLAUDE_SYNC_* and CLAUDE_CODE_ENTRYPOINT variables; inheriting them would point
 * the sandbox at the installed app's code and engine.
 */
export function launchEnv(extra = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CONVERSATIONS_") && !k.startsWith("CLAUDE_SYNC_") && k !== "CLAUDE_CODE_ENTRYPOINT"));
  return { ...clean, ...sandboxEnv, ...extra };
}

function readHead(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Did any conversation in this project folder run in `cwd`? (Read from the transcripts themselves.) */
function ranIn(dir, cwd) {
  const want = path.resolve(cwd).toLowerCase();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      for (const m of readHead(path.join(dir, f)).matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
        if (path.resolve(JSON.parse(`"${m[1]}"`)).toLowerCase() === want) return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Moves the Claude Code project folders of conversations that ran in `cwd` (the
 * chat test's scratch folder) out of ~/.claude/projects into the sandbox.
 * Returns where each folder went. Only a test folder is accepted.
 */
export function collectE2eTranscripts(cwd, { claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), into = path.join(base, "e2e-transcripts") } = {}) {
  const abs = path.resolve(cwd);
  if (!/e2e/i.test(path.basename(abs))) throw new Error(`refusing to collect conversations from ${abs}: the test folder's name must contain "e2e"`);
  const projects = path.join(claudeHome, "projects");
  const hint = path.basename(abs).replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
  const moved = [];
  let names = [];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return moved;
  }
  for (const name of names) {
    const dir = path.join(projects, name);
    if (!name.toLowerCase().includes(hint)) continue;
    try {
      if (!fs.statSync(dir).isDirectory() || !ranIn(dir, abs)) continue;
    } catch {
      continue;
    }
    fs.mkdirSync(into, { recursive: true });
    const dest = path.join(into, `${name}-${Date.now()}`);
    try {
      fs.renameSync(dir, dest);
    } catch {
      // Another drive: copy, then remove.
      fs.cpSync(dir, dest, { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    moved.push(dest);
  }
  return moved;
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes("--env")) {
  for (const [k, v] of Object.entries(sandboxEnv)) console.log(`${k}=${v}`);
  process.exit(0);
}
if (isMain && process.argv.includes("--collect-e2e")) {
  const dir = process.argv[process.argv.indexOf("--collect-e2e") + 1];
  if (!dir) {
    console.error("Usage: node scripts/dev-sandbox.mjs --collect-e2e <the chat test's scratch folder>");
    process.exit(2);
  }
  const moved = collectE2eTranscripts(dir);
  console.log(moved.length ? `moved ${moved.length} test conversation folder(s):\n${moved.join("\n")}` : "no test conversations to move");
  process.exit(0);
}

if (isMain) setup();

function setup() {
  if (!fs.existsSync(mirror)) {
    fs.mkdirSync(base, { recursive: true });
    console.log(`mirroring ${live} -> ${mirror}`);
    git(["-c", "core.longpaths=true", "clone", "--quiet", "--mirror", live, mirror], base);
  }
  if (!fs.existsSync(path.join(syncHome, "repo", ".git"))) {
    fs.mkdirSync(syncHome, { recursive: true });
    git(["-c", "core.longpaths=true", "clone", "--quiet", mirror, path.join(syncHome, "repo")], syncHome);
    git(["config", "core.autocrlf", "false"], path.join(syncHome, "repo"));
    git(["config", "core.longpaths", "true"], path.join(syncHome, "repo"));
    git(["config", "user.name", "Conversation sync (Home PC, sandbox)"], path.join(syncHome, "repo"));
    git(["config", "user.email", "home-pc@conversation-sync.local"], path.join(syncHome, "repo"));
  }
  fs.writeFileSync(path.join(syncHome, "config.json"), JSON.stringify({ remote: mirror, machine: "Home PC" }, null, 2));
  fs.mkdirSync(data, { recursive: true });
  const settingsFile = path.join(data, "settings.json");
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ keepResumeUpToDate: false, startAtLogin: false }, null, 2));
  console.log(`sandbox ready at ${base}`);
}
