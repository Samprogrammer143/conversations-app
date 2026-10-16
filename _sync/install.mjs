#!/usr/bin/env node
// Installs (or upgrades) Claude conversation sync on this PC.
//
// The sync engine (this folder) lives in the app's own repository, of which each PC
// keeps one copy; your conversations live in a repository of their own.
//
// New PC:
//   git clone https://github.com/Samprogrammer143/conversations-app <app folder>
//   node <app folder>/_sync/install.mjs --remote <your conversations repo> --machine "Home PC"
//
// Upgrade an existing install (safe to run again at any time):
//   node "<app folder>/_sync/install.mjs"
//
// Hooks and the /push and /pull skills run the engine next to this installer.
//
// The working copy lives outside ~/.claude so tools that sync ~/.claude (such as
// OneDrive) never copy a git repo around: %LOCALAPPDATA%\claude-conversation-sync
// on Windows, ~/Library/Application Support/claude-conversation-sync on macOS,
// ~/.local/share/claude-conversation-sync elsewhere (override: CLAUDE_SYNC_HOME).
// An older install inside ~/.claude/conversation-sync is moved there.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const LEGACY_DIR = path.join(CLAUDE_DIR, "conversation-sync");
const MARK = "conversation-sync";

// Another workspace's Claude Code names its own sync folder in its hooks (--sync-home).
// An installer run for that Claude folder without CLAUDE_SYNC_HOME (the automatic move,
// a run by hand) keeps it, so that workspace's conversations never go to another one's
// repository.
{
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch {}
  const homes = new Set();
  for (const g of Object.values(s?.hooks || {}).flat()) {
    for (const h of g?.hooks || []) {
      const m = /sync\.mjs"?\s+hook\s+\S+\s+--sync-home\s+"([^"]+)"/.exec(String(h?.command || ""));
      if (m) homes.add(path.resolve(m[1]).toLowerCase());
    }
  }
  const named = process.env.CLAUDE_SYNC_HOME ? path.resolve(process.env.CLAUDE_SYNC_HOME).toLowerCase() : null;
  if (homes.size > 1 || (named && homes.size === 1 && !homes.has(named))) {
    console.error(`${SETTINGS} syncs with ${[...homes].join(", ")}${named ? `, not ${process.env.CLAUDE_SYNC_HOME}` : ""}. Set CLAUDE_SYNC_HOME to the right one and run again.`);
    process.exit(1);
  }
  if (!named && homes.size === 1) {
    // The folder as the hooks spell it (the set above is only for comparing).
    for (const g of Object.values(s?.hooks || {}).flat())
      for (const h of g?.hooks || []) {
        const m = /sync\.mjs"?\s+hook\s+\S+\s+--sync-home\s+"([^"]+)"/.exec(String(h?.command || ""));
        if (m) process.env.CLAUDE_SYNC_HOME = path.resolve(m[1]);
      }
  }
}

function defaultSyncDir() {
  if (process.env.CLAUDE_SYNC_HOME) return process.env.CLAUDE_SYNC_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "claude-conversation-sync");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "claude-conversation-sync");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "claude-conversation-sync");
}
const SYNC_DIR = defaultSyncDir();
const REPO_DIR = path.join(SYNC_DIR, "repo");

const args = process.argv.slice(2);
const machineArg = args.includes("--machine") ? args[args.indexOf("--machine") + 1] : null;
// The conversations repository to set up (a new PC; another workspace of this one,
// with its own sync folder in CLAUDE_SYNC_HOME).
const remoteArg = args.includes("--remote") ? args[args.indexOf("--remote") + 1] : null;
const say = (m) => console.log(m);
function die(msg) {
  console.error(msg);
  process.exit(1);
}
function git(a, cwd) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const fwd = (p) => p.replace(/\\/g, "/");
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

if (Number(process.versions.node.split(".")[0]) < 18) die("Node 18 or newer is required.");
if (!git(["--version"]).ok) die("git is required.");

// 1. Move an older install out of the Claude folder.
if (!fs.existsSync(path.join(SYNC_DIR, "config.json")) && fs.existsSync(path.join(LEGACY_DIR, "config.json"))) {
  fs.mkdirSync(path.dirname(SYNC_DIR), { recursive: true });
  try {
    fs.renameSync(LEGACY_DIR, SYNC_DIR);
    say(`Moved the sync folder from ${LEGACY_DIR} to ${SYNC_DIR}`);
  } catch {
    fs.cpSync(LEGACY_DIR, SYNC_DIR, { recursive: true });
    try {
      fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
      say(`Moved the sync folder from ${LEGACY_DIR} to ${SYNC_DIR}`);
    } catch {
      say(`Copied the sync folder to ${SYNC_DIR}. The old copy at ${LEGACY_DIR} is no longer used and can be deleted.`);
    }
  }
  try { fs.unlinkSync(path.join(SYNC_DIR, "repo.lock")); } catch {}
  // Claude sessions that were already open still call the old path until they
  // restart; a tiny forwarder there keeps their hooks working.
  if (!fs.existsSync(path.join(LEGACY_DIR, "config.json"))) {
    const stub = path.join(LEGACY_DIR, "repo", "_sync", "sync.mjs");
    try {
      fs.mkdirSync(path.dirname(stub), { recursive: true });
      fs.writeFileSync(stub, `// Moved to ${SYNC_DIR}. This forwarder only serves Claude sessions opened before the move; this folder can be deleted.
import { pathToFileURL } from "node:url";
await import(pathToFileURL(${JSON.stringify(path.join(SYNC_DIR, "repo", "_sync", "sync.mjs"))}).href);
`);
    } catch {}
  }
}

// git runs in the working copy only under the sync's own lock, so the installer never
// changes it while a sync (a Claude Code hook, or the Conversations app) is at work there.
let withRepoLock = (fn) => fn();
let recover = null;
try {
  const engine = await import(pathToFileURL(path.join(HERE, "engine.mjs")).href);
  if (typeof engine.recoverFromConflict === "function") recover = engine.recoverFromConflict;
  withRepoLock = (fn) => {
    if (engine.lockHolder()) say("Waiting for the sync that is running now to finish ...");
    try {
      return engine.withLock(fn, 10 * 60_000);
    } catch (e) {
      if (e?.code === "busy") die("Another sync is still running. Try again in a few minutes.");
      throw e;
    }
  };
} catch (e) {
  say(`(The sync engine next to this installer could not be loaded, so it runs without the sync lock: ${e.message})`);
}

// 2. Make sure the working clone exists, and is up to date.
const remote = withRepoLock(updateWorkingCopy);
function updateWorkingCopy() {
  if (!fs.existsSync(path.join(REPO_DIR, ".git"))) {
    // Without --remote: the repository this installer is in, when that is a conversations
    // repository (the old layout). The app's own repository never is.
    const own = git(["config", "--get", "remote.origin.url"], path.resolve(HERE, "..")).out;
    const isAppRepo = fs.existsSync(path.resolve(HERE, "..", "_app", "runtime", "package.json"));
    const remote = remoteArg || (isAppRepo ? "" : own);
    if (!remote) die("Which repository holds your conversations? Run again with: --remote <its address>");
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    say(`Cloning ${remote} into ${REPO_DIR} ...`);
    const c = git(["-c", "core.longpaths=true", "clone", remote, REPO_DIR], SYNC_DIR);
    if (!c.ok) die(`Clone failed: ${c.err}`);
  }
  // A workspace's folder must hold its own repository, never another one's conversations
  // (checked before anything is committed or pushed there).
  if (remoteArg) {
    const key = (u) => String(u).trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i, "$1/").replace(/^[^@/]+@([^:/]+):/, "$1/").replace(/^https?:\/\/(?:[^@/]+@)?/i, "").toLowerCase();
    const origin = git(["config", "--get", "remote.origin.url"], REPO_DIR).out;
    if (key(origin) !== key(remoteArg)) die(`${REPO_DIR} already holds ${origin || "another repository"}, not ${remoteArg}.`);
  }
  // A clone can come out with nothing checked out (the server's default branch is not
  // the one the first PC started): take main when GitHub has it.
  if (!git(["rev-parse", "--verify", "--quiet", "HEAD"], REPO_DIR).ok && git(["rev-parse", "--verify", "--quiet", "origin/main"], REPO_DIR).ok) {
    git(["checkout", "-q", "-B", "main", "origin/main"], REPO_DIR);
  }
  // A new, empty repository gets a first commit, so every PC has a branch to sync on.
  if (!git(["rev-parse", "--verify", "--quiet", "HEAD"], REPO_DIR).ok) {
    git(["checkout", "-q", "-B", "main"], REPO_DIR);
    fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# Claude conversations\n\nSynced by the Conversations app. Each folder is a project; each conversation keeps its transcript here.\n");
    git(["add", "README.md"], REPO_DIR);
    const c = git(["-c", "user.name=Conversations", "-c", "user.email=conversations@localhost", "commit", "-q", "-m", "Start the conversation sync"], REPO_DIR);
    if (!c.ok) die(`Could not start the new repository: ${c.err}`);
    const p = git(["push", "-q", "-u", "origin", "main"], REPO_DIR);
    if (!p.ok) die(`Could not push to the new repository: ${p.err}`);
    say("Started the new repository.");
  }
  const remote = git(["config", "--get", "remote.origin.url"], REPO_DIR).out;
  if (!remote) die(`${REPO_DIR} is not a git clone with an origin remote.`);
  git(["config", "core.autocrlf", "false"], REPO_DIR);
  git(["config", "core.longpaths", "true"], REPO_DIR);
  // Pick up the latest version of the tool itself. A working copy stuck on a conflict
  // (an older engine could not get out of one) starts again from GitHub's version,
  // keeping the lines of this PC's own edit log that were not uploaded yet.
  if (!git(["pull", "--quiet", "--rebase"], REPO_DIR).ok) {
    git(["rebase", "--abort"], REPO_DIR);
    if (recover) {
      // The engine's own recovery: this PC's edit-log lines and deletes are re-applied, and
      // the conversations in the commits set aside are uploaded again by the next sync.
      if (git(["fetch", "--quiet", "origin"], REPO_DIR).ok) {
        const r = recover();
        if (r.ok) say(`The sync working copy was stuck on a conflict; it now matches GitHub again${r.dropped?.length ? `, and ${r.dropped.length} upload(s) will be made again by the next sync` : ""}.`);
        else say(`Could not recover the sync working copy: ${r.err}`);
      }
    } else if (git(["fetch", "--quiet", "origin"], REPO_DIR).ok) {
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], REPO_DIR).out || "main";
      const keep = {};
      const NL = "\n";
      for (const f of git(["ls-tree", "--name-only", "HEAD", "_state/"], REPO_DIR).out.split(NL).filter((x) => x.endsWith(".jsonl"))) {
        const theirs = new Set(git(["show", `origin/${branch}:${f}`], REPO_DIR).out.split(NL));
        const mine = git(["show", `HEAD:${f}`], REPO_DIR).out.split(NL).filter((l) => l.trim() && !theirs.has(l));
        if (mine.length) keep[f] = mine;
      }
      if (git(["reset", "--quiet", "--hard", `origin/${branch}`], REPO_DIR).ok) {
        say("The sync working copy was stuck on a conflict; it now matches GitHub again.");
        for (const [f, lines] of Object.entries(keep)) {
          const p = path.join(REPO_DIR, f);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          let cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
          if (cur && !cur.endsWith(NL)) cur += NL;
          fs.writeFileSync(p, cur + lines.join(NL) + NL);
          git(["add", "--", f], REPO_DIR);
        }
        if (Object.keys(keep).length) git(["commit", "--quiet", "-m", "Edit: re-applied after a conflict (install)"], REPO_DIR);
      }
    }
  }
  return remote;
}
// Hooks and skills run the engine next to this installer: the app repository's (a
// conversations repository holds no engine of its own any more).
const TOOL_DIR = HERE;
// How hooks and skills name the tool. Some PCs share ~/.claude through OneDrive, and the
// user folder can have another name on each PC, so when the tool is in its usual place
// under the user folder it is named from $HOME. Claude Code runs hook commands in Git
// Bash on Windows (PowerShell without Git Bash) and sh elsewhere; all of them expand
// "$HOME" inside double quotes, and Git Bash hands node a Windows path.
function toolPath() {
  const abs = path.join(TOOL_DIR, "sync.mjs");
  const rel = path.relative(HOME, abs);
  const usual = !process.env.CLAUDE_SYNC_HOME && same(SYNC_DIR, defaultSyncDir()) && rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  return usual ? `$HOME/${fwd(rel)}` : fwd(abs);
}
const SYNC = toolPath();

// 3. Machine config.
const configPath = path.join(SYNC_DIR, "config.json");
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
config.remote = remote;
config.machine = machineArg || config.machine || os.hostname();
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

// 4. Skills, with this PC's path to the tool filled in.
for (const name of ["push", "pull"]) {
  const dest = path.join(CLAUDE_DIR, "skills", name);
  const destFile = path.join(dest, "SKILL.md");
  if (fs.existsSync(destFile)) {
    const current = fs.readFileSync(destFile, "utf8");
    if (!current.includes(MARK) && !current.includes("sync.mjs")) {
      const bak = `${dest}.backup-${Date.now()}`;
      fs.renameSync(dest, bak);
      say(`Moved your existing /${name} skill to ${bak}`);
    }
  }
  fs.mkdirSync(dest, { recursive: true });
  const src = fs.readFileSync(path.join(TOOL_DIR, "skills", name, "SKILL.md"), "utf8");
  fs.writeFileSync(destFile, src.replaceAll("{{SYNC}}", SYNC));
}

// 5. Hooks in the Claude settings (existing settings are kept; a backup is written first).
let settings = {};
let raw = null;
if (fs.existsSync(SETTINGS)) {
  raw = fs.readFileSync(SETTINGS, "utf8");
  try { settings = JSON.parse(raw); } catch { die(`${SETTINGS} is not valid JSON; fix it and re-run.`); }
}
const before = JSON.stringify(settings);
settings.hooks ??= {};
const wanted = {
  SessionStart: ["session-start", 60], // downloads this folder's newest conversations before you /resume
  Stop: ["stop", 15],
  SessionEnd: ["session-end", 15],
};
for (const [event, [arg, timeout]] of Object.entries(wanted)) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  // This sync's hooks: the old layout's path names the sync folder, the new one the app's folder.
  const ours = (h) => /sync\.mjs/.test(String(h.command || "")) && (String(h.command || "").includes(MARK) || String(h.command || "").includes("conversations-app"));
  const hadHome = list.some((g) => (g.hooks || []).some((h) => ours(h) && String(h.command || "").includes("--sync-home")));
  const kept = list.filter((g) => !(g.hooks || []).some(ours));
  // A workspace's hooks name its sync folder (a terminal's Claude Code has no CLAUDE_SYNC_HOME
  // of its own), as an argument: it works in every shell a hook may run in.
  const home = process.env.CLAUDE_SYNC_HOME && (remoteArg || hadHome) ? ` --sync-home "${fwd(SYNC_DIR)}"` : "";
  kept.push({ hooks: [{ type: "command", command: `node "${SYNC}" hook ${arg}${home}`, timeout }] });
  settings.hooks[event] = kept;
}
// Written only when something changed. The first backup keeps the settings from before
// conversation sync and is never replaced; any later change gets a dated backup.
if (JSON.stringify(settings) !== before) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (raw !== null) {
    const first = `${SETTINGS}.backup-before-conversation-sync`;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    for (let i = 0; ; i++) {
      const bak = i === 0 && !fs.existsSync(first) ? first : `${SETTINGS}.backup-${stamp}${i > 1 ? `-${i}` : ""}`;
      try {
        fs.writeFileSync(bak, raw, { flag: "wx" }); // never over an existing file
        if (bak !== first) say(`Saved the previous settings to ${bak}`);
        break;
      } catch (e) {
        if (e.code !== "EEXIST" || i > 50) throw e;
      }
    }
  }
  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  try {
    fs.renameSync(tmp, SETTINGS);
  } catch {
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// 6. Shared rules: the global CLAUDE.md imports the repository's _shared/CLAUDE.md, so a
// rule written once applies in every chat on every PC. The import names the file from
// "~" when the tool is in its usual place, so the same line works under any user name.
{
  const rulesAbs = path.join(REPO_DIR, "_shared", "CLAUDE.md");
  const rel = path.relative(HOME, rulesAbs);
  const usual = !process.env.CLAUDE_SYNC_HOME && same(SYNC_DIR, defaultSyncDir()) && rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const importLine = `@${usual ? `~/${fwd(rel)}` : fwd(rulesAbs)}`;
  const globalRules = path.join(CLAUDE_DIR, "CLAUDE.md");
  let current = "";
  try { current = fs.readFileSync(globalRules, "utf8"); } catch {}
  if (!current.includes("_shared/CLAUDE.md")) {
    const block = `${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}# Rules shared with my other PCs (synced through the conversation repository; edit the imported file)\n${importLine}\n`;
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.appendFileSync(globalRules, block);
    say(`Added the shared rules import to ${globalRules}`);
  }
  if (!fs.existsSync(rulesAbs)) {
    fs.mkdirSync(path.dirname(rulesAbs), { recursive: true });
    fs.writeFileSync(rulesAbs, "# Rules shared across all my PCs\n\nEvery Claude Code chat on every PC reads this file. Edit it anywhere; the other PCs have it after their next sync.\n");
  }
}

say(`
Conversation sync is installed on "${config.machine}".
  Repo:    ${remote}
  Folder:  ${fwd(SYNC_DIR)}
  Skills:  /push and /pull
  Hooks:   SessionStart (downloads the latest), Stop (uploads after replies), SessionEnd (final upload)

Restart Claude Code for it to take effect.`);
