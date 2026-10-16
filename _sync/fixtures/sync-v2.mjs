#!/usr/bin/env node
// Claude conversation sync, version 2.
//
// Keeps Claude Code conversation transcripts in a private GitHub repo so a
// conversation started on one PC carries on seamlessly on another.
//
//   node sync.mjs setup --remote <git url> [--machine <name>]
//   node sync.mjs hook session-start|stop|session-end   (reads hook JSON on stdin)
//   node sync.mjs push   [--session <id>] [--cwd <dir>] [--dry-run]
//   node sync.mjs pull   [list | <n> | <session id>] [--cwd <dir>] [--current <id>]
//   node sync.mjs status [--cwd <dir>]
//
// How it behaves:
//   - After each Claude reply the conversation is uploaded in the background
//     (at most every two minutes, and always once more when the session ends).
//   - Every time Claude starts in a folder, the newest versions of that folder's
//     conversations are downloaded first, so /resume always shows the latest.
//   - Transcripts are append-only logs, so syncing is a merge of lines: whatever
//     one side has that the other lacks is appended. Nothing is ever overwritten
//     or refused, and a conversation continued on two PCs keeps both parts.
//   - Anything that looks like a credential is replaced with [REDACTED ...] in
//     the uploaded copy. Image and document data are never touched.
//
// Repo layout:  <project>/<session-id>/transcript.jsonl   the conversation
//                                    /files/...          subagent + tool-output files
//                                    /meta.json          title, machines, sizes
// <project> is the name of the git repo folder Claude runs in (or the folder
// name when it is not a git repo), so one project maps to one folder on every PC.
//
// The working copy lives outside ~/.claude (which some setups sync with OneDrive
// or similar): %LOCALAPPDATA%\claude-conversation-sync on Windows,
// ~/Library/Application Support/claude-conversation-sync on macOS,
// ~/.local/share/claude-conversation-sync elsewhere. Override with CLAUDE_SYNC_HOME.
//
// Needs Node 18+ and git. CLAUDE_SYNC_DISABLE=1 turns the hooks off.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const LEGACY_SYNC_DIR = path.join(CLAUDE_DIR, "conversation-sync");

function defaultSyncDir() {
  if (process.env.CLAUDE_SYNC_HOME) return process.env.CLAUDE_SYNC_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "claude-conversation-sync");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "claude-conversation-sync");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "claude-conversation-sync");
}

// Use the new location; fall back to an older install inside ~/.claude until
// install.mjs has moved it.
const SYNC_DIR = (() => {
  const fresh = defaultSyncDir();
  if (fs.existsSync(path.join(fresh, "config.json"))) return fresh;
  if (fs.existsSync(path.join(LEGACY_SYNC_DIR, "config.json"))) return LEGACY_SYNC_DIR;
  return fresh;
})();
const REPO_DIR = path.join(SYNC_DIR, "repo");
const CONFIG_PATH = path.join(SYNC_DIR, "config.json");
const STATE_PATH = path.join(SYNC_DIR, "state.json");
const LOG_PATH = path.join(SYNC_DIR, "sync.log");
const LOCK_PATH = path.join(SYNC_DIR, "repo.lock");
const BACKUP_DIR = path.join(SYNC_DIR, "backups");

const GZIP_OVER_BYTES = Number(process.env.CLAUDE_SYNC_GZIP_OVER_BYTES) || 90 * 1024 * 1024; // GitHub rejects files over 100 MB
const SKIP_FILE_OVER_BYTES = 95 * 1024 * 1024;
const PUSH_DEBOUNCE_MS = Number(process.env.CLAUDE_SYNC_DEBOUNCE_MS) || 2 * 60 * 1000;
// Session start never downloads in the hook itself: a detached worker does,
// and the hook waits this long for it before letting Claude start. A slow or
// large download then finishes in the background instead of being cut off.
const STARTUP_WAIT_MS = Number(process.env.CLAUDE_SYNC_STARTUP_WAIT_MS) || 12 * 1000;
const RESUME_WAIT_MS = Number(process.env.CLAUDE_SYNC_RESUME_WAIT_MS) || 40 * 1000; // the hook's own limit is 60 s
const WORKER_LOCK_WAIT_MS = 10 * 60 * 1000;
const RESULT_DIR = path.join(SYNC_DIR, "results");
const GC_EVERY_PUSHES = 15;
const TEXT_FILE = /\.(txt|json|jsonl|md|log|csv|html?|xml|ya?ml|m?js|ts|tsx|py|sh|env|ini|toml|sql)$/i;

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0", // never hang a background push on a password prompt
  GCM_INTERACTIVE: "never",
};

let lockHeld = false;
process.on("exit", () => {
  if (lockHeld) {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  }
});

// ---------------------------------------------------------------- utilities

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = out[key] === undefined ? next : [].concat(out[key], next);
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const argText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function log(msg) {
  try {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > 1024 * 1024) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
    } catch {}
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

const loadConfig = () => readJson(CONFIG_PATH, null);

function loadState() {
  const s = readJson(STATE_PATH, {});
  s.sessions ??= {};
  return s;
}

function updateState(fn) {
  const s = loadState();
  fn(s);
  writeJson(STATE_PATH, s);
  return s;
}

function patchSession(id, patch) {
  return updateState((s) => {
    const cur = { ...(s.sessions[id] || {}), ...patch };
    for (const [k, v] of Object.entries(cur)) if (v === undefined) delete cur[k];
    s.sessions[id] = cur;
  });
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd: opts.cwd ?? REPO_DIR,
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 120_000,
    windowsHide: true,
  });
  const res = { ok: r.status === 0, code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
  if (!res.ok && !opts.quiet) log(`git ${args.join(" ")} failed (${r.status}): ${res.err}`);
  return res;
}

const toGitPath = (p) => p.split(path.sep).join("/");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function webUrl(remote) {
  const m = String(remote).match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function sessionUrl(config, key, id) {
  const base = webUrl(config.remote);
  return base ? `${base}/tree/main/${encodeURIComponent(key)}/${id}` : `${key}/${id}`;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ago(iso) {
  if (!iso) return "?";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ------------------------------------------------------------ lock (repo)

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by someone else
  }
}

function withLock(fn, waitMs = 60_000) {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      lockHeld = true;
      break;
    } catch {
      const held = readJson(LOCK_PATH, null);
      if (!held || Date.now() - held.at > 10 * 60_000 || !processAlive(held.pid)) {
        try { fs.unlinkSync(LOCK_PATH); } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error("Another sync is still running. Try again in a minute.");
      sleep(300);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    lockHeld = false;
  }
}

// ------------------------------------------------------- project identity

function gitTopLevel(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], { cwd, quiet: true, timeout: 10_000 });
  return r.ok && r.out ? path.resolve(r.out) : null;
}

function gitRemoteOf(dir) {
  const r = git(["config", "--get", "remote.origin.url"], { cwd: dir, quiet: true, timeout: 10_000 });
  return r.ok && r.out ? r.out : null;
}

function normaliseRemote(url) {
  if (!url) return null;
  const m = String(url).match(/([^/:@]+)[:/]([^/]+)\/([^/]+?)(\.git)?\/?$/);
  return (m ? `${m[1]}/${m[2]}/${m[3]}` : String(url)).toLowerCase();
}

function projectInfo(cwd) {
  const abs = path.resolve(cwd);
  const top = gitTopLevel(abs) ?? abs;
  let key;
  if (samePath(top, HOME)) key = "_home";
  else key = path.basename(top).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "_root";
  return { key, root: top, remote: gitRemoteOf(top) };
}

// Claude Code keeps a folder's sessions in ~/.claude/projects/<encoded path>: every
// character that is not a letter or digit becomes "-", and names over 200
// characters are cut to 200 plus a hash.
function projectDirFor(cwd) {
  const enc = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
  const direct = path.join(PROJECTS_DIR, enc);
  if (fs.existsSync(direct)) return direct;
  try {
    const names = fs.readdirSync(PROJECTS_DIR);
    const hit =
      names.find((d) => d.toLowerCase() === enc.toLowerCase()) ||
      (enc.length > 200 ? names.find((d) => d.toLowerCase().startsWith(enc.slice(0, 200).toLowerCase())) : null);
    if (hit) return path.join(PROJECTS_DIR, hit);
  } catch {}
  return direct;
}

function findLocalTranscripts(id) {
  const out = [];
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
      if (fs.existsSync(p)) out.push(p);
    }
  } catch {}
  return out;
}

function resolveSession({ session, transcript, cwd }) {
  if (argText(transcript) && fs.existsSync(transcript)) {
    return { id: path.basename(transcript, ".jsonl"), transcript, guessed: false };
  }
  const id = argText(session) || process.env.CLAUDE_SYNC_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (id) {
    const inDir = path.join(projectDirFor(cwd), `${id}.jsonl`);
    const p = fs.existsSync(inDir) ? inDir : findLocalTranscripts(id)[0];
    if (!p) fail(`No local transcript found for session ${id}.`);
    return { id, transcript: p, guessed: false };
  }
  // Last resort: the transcript in this folder written to most recently is the
  // conversation that is running right now.
  const dir = projectDirFor(cwd);
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const st = fs.statSync(path.join(dir, f));
      if (!best || st.mtimeMs > best.mtimeMs) best = { f, mtimeMs: st.mtimeMs };
    }
  } catch {}
  if (!best) fail(`No conversations found for ${cwd}.`);
  return { id: best.f.replace(/\.jsonl$/, ""), transcript: path.join(dir, best.f), guessed: true };
}

// ------------------------------------------------------ transcript reading

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (content.some((c) => c?.type === "tool_result")) return null;
    return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  }
  return null;
}

function inspectTranscript(buf) {
  const info = { title: null, firstPrompt: null, prompts: 0, firstAt: null, lastAt: null, lines: 0, headless: false };
  let customTitle = null;
  for (const line of completeLines(buf)) {
    if (!line.trim()) continue;
    info.lines++;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.timestamp) {
      info.firstAt ??= j.timestamp;
      info.lastAt = j.timestamp;
    }
    if (typeof j.entrypoint === "string" && j.entrypoint.startsWith("sdk")) info.headless = true;
    if (j.type === "custom-title" && (j.customTitle || j.title)) customTitle = j.customTitle || j.title;
    else if (j.type === "ai-title" && j.aiTitle) info.title = j.aiTitle;
    else if (j.type === "summary" && j.summary && !info.title) info.title = j.summary;
    if (j.type === "user" && !j.isMeta && !j.isCompactSummary && !j.isSidechain) {
      const body = textOf(j.message?.content)?.trimStart() ?? "";
      if (body && !body.startsWith("<") && !body.startsWith("Base directory for this skill")) {
        info.prompts++;
        info.firstPrompt ??= body.trim().replace(/\s+/g, " ").slice(0, 160);
      }
    }
  }
  info.title = customTitle || info.title || info.firstPrompt || "(untitled)";
  return info;
}

// ------------------------------------------------------------ line merging
//
// A transcript is an append-only log of JSON lines. Syncing two copies means
// appending to each side the lines it lacks. A final line without a newline is
// still being written by Claude and is left for the next sync.

function completeLines(buf) {
  const text = buf.toString("utf8");
  const parts = text.split("\n");
  parts.pop(); // "" after a trailing newline, or an unfinished last line
  return parts.filter((l) => l.trim());
}

function missingLines(from, into) {
  const have = new Set(into ? completeLines(into) : []);
  const out = [];
  const seen = new Set();
  for (const l of completeLines(from)) {
    if (have.has(l) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function withLinesAppended(buf, lines) {
  let base = buf ? buf.toString("utf8") : "";
  if (base && !base.endsWith("\n")) base = base.slice(0, base.lastIndexOf("\n") + 1); // drop an unfinished line
  return Buffer.from(base + (lines.length ? lines.join("\n") + "\n" : ""), "utf8");
}

// ---------------------------------------------------------------- redaction

const SECRET_PATTERNS = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{30,}/g],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["Google refresh token", /\b1\/\/0[0-9A-Za-z_-]{40,}/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/g],
  ["Stripe live key", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g],
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ["PostHog personal key", /\bphx_[A-Za-z0-9]{30,}/g],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}/g],
  ["Private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]{0,8000}?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/g],
];
const ANY_SECRET = new RegExp(SECRET_PATTERNS.map(([, re]) => `(?:${re.source})`).join("|"));

function redactString(str, ctx) {
  let out = str;
  for (const [kind, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      const fp = sha(m).slice(0, 12);
      if (ctx.allow.has(fp)) return m;
      ctx.found.set(fp, kind);
      ctx.hits++;
      return `[REDACTED ${kind} ${fp}]`;
    });
  }
  return out;
}

// Walks a parsed JSONL entry and redacts string values, skipping base64 payloads
// (images, PDFs) so their data can never be corrupted.
function redactValue(v, ctx, key, parent) {
  if (typeof v === "string") {
    if (key === "data" && parent?.type === "base64") return v;
    return ANY_SECRET.test(v) ? redactString(v, ctx) : v;
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, ctx, null, v));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactValue(x, ctx, k, v);
    return o;
  }
  return v;
}

function redactJsonl(buf, ctx) {
  const text = buf.toString("utf8");
  if (!ANY_SECRET.test(text)) return buf;
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !ANY_SECRET.test(line)) continue;
    const before = ctx.hits;
    let replaced;
    try {
      replaced = JSON.stringify(redactValue(JSON.parse(line), ctx, null, null));
    } catch {
      replaced = redactString(line, ctx);
    }
    if (ctx.hits !== before) {
      lines[i] = replaced;
      changed = true;
    }
  }
  return changed ? Buffer.from(lines.join("\n"), "utf8") : buf;
}

function redactFile(file, buf, ctx) {
  if (file.endsWith(".jsonl")) return redactJsonl(buf, ctx);
  if (!TEXT_FILE.test(file)) return buf;
  const text = buf.toString("utf8");
  if (!ANY_SECRET.test(text)) return buf;
  const out = redactString(text, ctx);
  return out === text ? buf : Buffer.from(out, "utf8");
}

const newRedactionCtx = (allow) => ({ allow, found: new Map(), hits: 0 });

function redactionSummary(ctx) {
  if (!ctx.found.size) return null;
  const byKind = {};
  for (const kind of ctx.found.values()) byKind[kind] = (byKind[kind] || 0) + 1;
  return Object.entries(byKind).map(([k, n]) => `${n} × ${k}`).join(", ");
}

// ------------------------------------------------------------ repo access

function ensureRepo() {
  const config = loadConfig();
  if (!config?.remote) fail(`Conversation sync is not set up on this PC. Run: node "${SELF}" setup --remote <repo url>`);
  if (!fs.existsSync(path.join(REPO_DIR, ".git"))) {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    const r = git(["-c", "core.longpaths=true", "clone", config.remote, REPO_DIR], { cwd: SYNC_DIR, timeout: 30 * 60_000 });
    if (!r.ok) fail(`Could not clone ${config.remote}: ${r.err}`);
  }
  git(["config", "core.autocrlf", "false"], { quiet: true });
  git(["config", "core.safecrlf", "false"], { quiet: true });
  git(["config", "core.longpaths", "true"], { quiet: true }); // Windows: allow paths over 260 characters
  if (!git(["config", "user.email"], { quiet: true }).out) {
    const machine = config.machine || os.hostname();
    git(["config", "user.email", `${machine.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@conversation-sync.local`], { quiet: true });
    git(["config", "user.name", `Conversation sync (${machine})`], { quiet: true });
  }
  return config;
}

// The clone belongs to this tool, so anything uncommitted in it is left over from
// an interrupted run and can be discarded; unpushed commits are kept and replayed.
function refreshRepo() {
  sleep(Number(process.env.CLAUDE_SYNC_TEST_FETCH_DELAY_MS) || 0); // tests only: a slow download
  git(["rebase", "--abort"], { quiet: true });
  git(["reset", "--quiet", "--hard", "HEAD"], { quiet: true });
  git(["clean", "-fdq"], { quiet: true });
  const f = git(["fetch", "--quiet", "origin"], { timeout: 10 * 60_000 });
  if (!f.ok) return { ok: false, err: f.err };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).out || "main";
  if (!git(["rev-parse", "--verify", "--quiet", `origin/${branch}`], { quiet: true }).ok) return { ok: true, branch };
  const r = git(["rebase", "--quiet", `origin/${branch}`], { timeout: 10 * 60_000 });
  if (!r.ok) {
    git(["rebase", "--abort"], { quiet: true });
    return { ok: false, err: r.err };
  }
  return { ok: true, branch };
}

function readRemoteTranscript(dir) {
  const plain = path.join(dir, "transcript.jsonl");
  const gz = path.join(dir, "transcript.jsonl.gz");
  if (fs.existsSync(plain)) return fs.readFileSync(plain);
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz));
  return null;
}

function writeRemoteTranscript(dir, buf) {
  fs.mkdirSync(dir, { recursive: true });
  const plain = path.join(dir, "transcript.jsonl");
  const gz = path.join(dir, "transcript.jsonl.gz");
  if (buf.length > GZIP_OVER_BYTES) {
    fs.writeFileSync(gz, zlib.gzipSync(buf, { level: 9 }));
    if (fs.existsSync(plain)) fs.unlinkSync(plain);
  } else {
    fs.writeFileSync(plain, buf);
    if (fs.existsSync(gz)) fs.unlinkSync(gz);
  }
}

function listFiles(root) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

// Local session folder -> repo, redacting on the way. Returns changed files.
function pushFiles(from, to, ctx, dryRun) {
  const changed = [];
  for (const src of listFiles(from)) {
    if (fs.statSync(src).size > SKIP_FILE_OVER_BYTES) continue;
    const rel = path.relative(from, src);
    const buf = redactFile(src, fs.readFileSync(src), ctx);
    const dst = path.join(to, rel);
    if (fs.existsSync(dst) && fs.statSync(dst).size === buf.length && fs.readFileSync(dst).equals(buf)) continue;
    changed.push(rel);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
  }
  return changed;
}

// Repo -> local session folder. Adds and updates; never deletes local files.
function pullFiles(from, to) {
  for (const src of listFiles(from)) {
    const dst = path.join(to, path.relative(from, src));
    const buf = fs.readFileSync(src);
    if (fs.existsSync(dst) && fs.statSync(dst).size === buf.length && fs.readFileSync(dst).equals(buf)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
  }
}

function commitAndPush(message, paths) {
  git(["add", "-A", "--", ...paths.map(toGitPath)]);
  if (git(["diff", "--cached", "--quiet"], { quiet: true }).ok) return { ok: true, nothing: true };
  const c = git(["commit", "--quiet", "-m", message]);
  if (!c.ok) return { ok: false, err: c.err };
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = git(["push", "--quiet", "origin", "HEAD"], { timeout: 20 * 60_000 });
    if (p.ok) return { ok: true };
    lastErr = p.err;
    const rf = refreshRepo(); // someone else pushed first; replay our commit on top
    if (!rf.ok) return { ok: false, err: rf.err || p.err };
  }
  return { ok: false, err: `push kept being rejected: ${lastErr}` };
}

function findSessionKey(id) {
  try {
    for (const d of fs.readdirSync(REPO_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name === "_sync") continue;
      if (fs.existsSync(path.join(REPO_DIR, d.name, id, "meta.json"))) return d.name;
    }
  } catch {}
  return null;
}

// ------------------------------------------------------------------- push

function doPush(args) {
  const cwd = path.resolve(argText(args.cwd) ?? process.cwd());
  const auto = !!args.auto;
  const dryRun = !!args["dry-run"];
  const config = ensureRepo();
  const { id, transcript, guessed } = resolveSession({ session: args.session, transcript: args.transcript, cwd });

  sleep(Number(args.after) || 0); // trailing debounce: upload whatever the conversation looks like by then

  const project = projectInfo(cwd);
  const allow = new Set(config.allow || []);
  const known = loadState().sessions[id];
  const raw = fs.readFileSync(transcript);

  if (auto) {
    if (known?.skip) return;
    if (!known?.pushedAt && !known?.pulledAt) {
      if ((config.exclude || []).includes(project.key)) {
        patchSession(id, { skip: "excluded" });
        return log(`skip ${id}: project ${project.key} is excluded`);
      }
      const first = inspectTranscript(raw);
      if (first.headless && process.env.CLAUDE_SYNC_INCLUDE_HEADLESS !== "1") {
        patchSession(id, { skip: "headless" });
        return log(`skip ${id}: headless run`);
      }
      if (first.prompts === 0) return log(`skip ${id}: no typed prompts yet`);
    }
  }

  const ctx = newRedactionCtx(allow);
  const local = redactJsonl(raw, ctx);
  const localSha = sha(local);
  if (auto && known?.pushedAt && known.sha256 === localSha) return; // nothing new since the last upload

  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return report({ ok: false, auto, id, msg: `Could not reach GitHub: ${rf.err}` });

    // Keep a conversation in one project folder even if it is later opened from
    // a folder with another name.
    const key = findSessionKey(id) ?? project.key;
    const dir = path.join(REPO_DIR, key, id);
    const metaPath = path.join(dir, "meta.json");
    const meta = readJson(metaPath, {});
    const remote = readRemoteTranscript(dir);
    const toAdd = remote ? missingLines(local, remote) : null;
    const remoteOnly = remote ? missingLines(remote, local).length : 0;

    const siblingDir = transcript.replace(/\.jsonl$/, "");
    const changedFiles = fs.existsSync(siblingDir) ? pushFiles(siblingDir, path.join(dir, "files"), ctx, dryRun) : [];
    const redacted = redactionSummary(ctx);
    const transcriptChanged = remote === null || toAdd.length > 0;
    const merged = remote === null ? withLinesAppended(null, completeLines(local)) : withLinesAppended(remote, toAdd);
    const info = inspectTranscript(merged);

    if (dryRun) {
      const what = remote === null ? "not on GitHub yet" : toAdd.length ? `${toAdd.length} new entries to upload` : "transcript already on GitHub";
      return report({ ok: true, auto, id, key, msg: `Dry run, nothing uploaded. "${info.title}" (${humanBytes(merged.length)}, ${info.prompts} prompts): ${what}, ${changedFiles.length} session files to update.${redacted ? `\nWould redact: ${redacted}` : ""}\nTarget: ${sessionUrl(config, key, id)}` });
    }

    if (transcriptChanged) writeRemoteTranscript(dir, merged);
    const machine = config.machine || os.hostname();
    const now = new Date().toISOString();
    const changed = transcriptChanged || changedFiles.length > 0;
    if (changed || !meta.machines?.[machine]) {
      writeJson(metaPath, {
        sessionId: id,
        project: key,
        title: info.title,
        firstPrompt: info.firstPrompt,
        prompts: info.prompts,
        startedAt: info.firstAt,
        lastMessageAt: info.lastAt,
        bytes: merged.length,
        sha256: sha(merged),
        gitRemote: project.remote ?? meta.gitRemote ?? null,
        createdAt: meta.createdAt ?? now,
        updatedAt: changed ? now : meta.updatedAt ?? now,
        lastPushedFrom: changed ? machine : meta.lastPushedFrom ?? machine,
        machines: { ...(meta.machines || {}), [machine]: { cwd, lastPushAt: now } },
      });
    }

    const res = commitAndPush(`${remote ? "Update" : "Add"} ${key}: ${info.title.slice(0, 60)} (${machine})`, [path.join(key, id)]);
    if (!res.ok) return report({ ok: false, auto, id, key, msg: `Upload failed: ${res.err}` });

    const st = updateState((s) => {
      // Only mark GitHub's copy as already on this PC when nothing came from elsewhere;
      // otherwise the next start must still download the other PC's entries.
      s.sessions[id] = { ...(s.sessions[id] || {}), key, sha256: localSha, remoteSha: remoteOnly ? undefined : sha(merged), pushedAt: now };
      if (remoteOnly) delete s.sessions[id].remoteSha;
      delete s.sessions[id].pending;
      s.pushCount = (s.pushCount || 0) + 1;
    });
    if (auto && st.pushCount % GC_EVERY_PUSHES === 0) git(["gc", "--quiet"], { quiet: true, timeout: 30 * 60_000 });

    const what = res.nothing ? "Already up to date" : remote ? "Updated" : "Uploaded";
    const lines = [`${what}: "${info.title}" (${humanBytes(merged.length)}, ${info.prompts} prompts)${guessed ? " [detected as the most recently active conversation in this folder]" : ""}`];
    if (redacted) lines.push(`Redacted in the uploaded copy: ${redacted}`);
    if (remoteOnly) lines.push(`GitHub also has ${remoteOnly} newer entries from ${meta.lastPushedFrom ?? "another PC"} that this window does not show. Both are kept. To see them here: exit, reopen Claude in this folder, and /resume this conversation.`);
    lines.push(sessionUrl(config, key, id));
    return report({ ok: true, auto, id, key, msg: lines.join("\n") });
  });
}

function report(r) {
  if (r.auto) {
    log(`${r.ok ? "ok" : "not uploaded"} ${r.id}: ${r.msg.split("\n")[0]}`);
    return r;
  }
  if (r.ok) console.log(r.msg);
  else {
    console.error(r.msg);
    process.exitCode = 2;
  }
  return r;
}

// ------------------------------------------------------------------- pull

function remoteSessions(project) {
  const out = [];
  const addFrom = (key) => {
    const kdir = path.join(REPO_DIR, key);
    let ids = [];
    try { ids = fs.readdirSync(kdir); } catch { return; }
    for (const id of ids) {
      const meta = readJson(path.join(kdir, id, "meta.json"), null);
      if (meta?.sessionId) out.push({ ...meta, key, dir: path.join(kdir, id) });
    }
  };
  addFrom(project.key);
  if (!out.length && project.remote) {
    // Same git repo, but the folder has another name on this PC.
    const want = normaliseRemote(project.remote);
    for (const d of fs.readdirSync(REPO_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name === "_sync" || d.name === project.key) continue;
      const kdir = path.join(REPO_DIR, d.name);
      const sample = fs.readdirSync(kdir).map((id) => readJson(path.join(kdir, id, "meta.json"), null)).find((m) => m?.sessionId);
      if (sample && normaliseRemote(sample.gitRemote) === want) addFrom(d.name);
    }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// Brings one conversation on this PC up to date with GitHub by appending the
// entries it lacks (or creating it). Other stale copies of the same conversation
// in other project folders are moved to the backup folder, so exactly one copy
// remains and `claude --resume <id>` can always find it.
function pullOne(s, targetDir, allow) {
  const remote = readRemoteTranscript(s.dir);
  if (!remote) return { status: "missing" };
  const copies = findLocalTranscripts(s.sessionId);
  const dest = copies.find((p) => samePath(path.dirname(p), targetDir)) ?? copies[0] ?? path.join(targetDir, `${s.sessionId}.jsonl`);
  let status = "same";
  let added = 0;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, withLinesAppended(null, completeLines(remote)));
    fs.renameSync(tmp, dest);
    status = "downloaded";
  } else {
    const localRaw = fs.readFileSync(dest);
    const missing = missingLines(remote, redactJsonl(localRaw, newRedactionCtx(allow)));
    if (missing.length) {
      const text = localRaw.toString("utf8");
      const prefix = text && !text.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(dest, prefix + missing.join("\n") + "\n"); // append-only, like Claude itself
      added = missing.length;
      status = "updated";
    }
  }
  const files = path.join(s.dir, "files");
  if (fs.existsSync(files)) pullFiles(files, dest.replace(/\.jsonl$/, ""));

  for (const other of copies) {
    if (samePath(other, dest)) continue;
    const to = path.join(BACKUP_DIR, "duplicates", path.basename(path.dirname(other)), path.basename(other));
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(other, to);
      log(`moved duplicate copy ${other} -> ${to}`);
    } catch (e) {
      log(`could not move duplicate ${other}: ${e.message}`);
    }
  }
  const st = fs.statSync(dest);
  const nowIso = new Date().toISOString();
  // grewAt: when a download last changed this PC's copy, so a window opened just before it can be told it is behind.
  patchSession(s.sessionId, { key: s.key, remoteSha: s.sha256, pulledAt: nowIso, localSize: st.size, ...(added || status === "downloaded" || status === "updated" ? { grewAt: nowIso } : {}) });
  return { status, added, dest };
}

function doPull(args) {
  const cwd = path.resolve(argText(args.cwd) ?? process.cwd());
  const config = ensureRepo();
  const project = projectInfo(cwd);
  const current = argText(args.current) || process.env.CLAUDE_SYNC_SESSION_ID || null;
  const allow = new Set(config.allow || []);
  const pos = args._[0];
  const listOnly = pos === "list" || !!args.list;
  const pick = argText(args.pick) ?? (pos && pos !== "list" ? String(pos) : null);

  return withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) console.error(`Warning: could not reach GitHub, using the last downloaded copy (${rf.err}).`);
    const sessions = remoteSessions(project).filter((s) => s.sessionId !== current);
    const targetDir = projectDirFor(cwd);

    if (!sessions.length) {
      let keys = [];
      try {
        keys = fs.readdirSync(REPO_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "_sync" && !d.name.startsWith("C--") && !d.name.startsWith("-"))
          .map((d) => d.name);
      } catch {}
      console.log(`No synced conversations for "${project.key}" yet.${keys.length ? ` Projects on GitHub: ${keys.join(", ")}.` : ""}`);
      return;
    }

    if (listOnly || !pick) {
      console.log(`Conversations for "${project.key}" on GitHub, newest first:`);
      sessions.forEach((s, i) => {
        const here = findLocalTranscripts(s.sessionId).length ? "on this PC" : "not on this PC yet";
        console.log(`  ${i + 1}. ${s.title}  |  updated ${ago(s.updatedAt)} from ${s.lastPushedFrom}  |  ${humanBytes(s.bytes)}  |  ${here}  |  ${s.sessionId}`);
      });
      if (listOnly) return;
      console.log("");
    }

    const choice = pick ?? "1";
    const s = /^\d+$/.test(choice) ? sessions[Number(choice) - 1] : sessions.find((x) => x.sessionId.startsWith(choice));
    if (!s) fail(`No conversation matches "${choice}".`);
    const r = pullOne(s, targetDir, allow);
    if (r.status === "missing") fail(`The GitHub copy of "${s.title}" has no transcript file.`);
    const verb = { downloaded: "Downloaded", updated: `Updated (${r.added} new entries)`, same: "Already up to date:" }[r.status];
    console.log(`${verb} "${s.title}", last updated ${ago(s.updatedAt)} from ${s.lastPushedFrom}.`);
    const elsewhere = !samePath(path.dirname(r.dest), targetDir);
    console.log(
      elsewhere
        ? `\nTo open it, exit and run:\n  claude --resume ${s.sessionId}`
        : `\nTo open it: type /resume and choose "${s.title}", or exit and run:\n  claude --resume ${s.sessionId}`,
    );
  });
}

// Every conversation for this folder, brought up to date. Used when Claude starts.
function autoPull(cwd, currentId) {
  const config = loadConfig();
  if (!config?.remote || !fs.existsSync(path.join(REPO_DIR, ".git"))) return [];
  const results = [];
  withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return log(`auto-pull: could not reach GitHub: ${rf.err}`);
    const project = projectInfo(cwd);
    const targetDir = projectDirFor(cwd);
    const allow = new Set(config.allow || []);
    const st = loadState();
    for (const s of remoteSessions(project)) {
      if (s.sessionId === currentId) continue;
      const known = st.sessions[s.sessionId];
      const copies = findLocalTranscripts(s.sessionId);
      // Nothing new on GitHub since this PC last synced it, and one copy in the right place.
      if (known?.remoteSha === s.sha256 && copies.length === 1 && samePath(path.dirname(copies[0]), targetDir)) continue;
      const r = pullOne(s, targetDir, allow);
      if (r.status === "downloaded" || r.status === "updated") results.push({ ...r, title: s.title, from: s.lastPushedFrom, updatedAt: s.updatedAt });
    }
  }, WORKER_LOCK_WAIT_MS);
  return results;
}

// The conversation being resumed right now, checked against GitHub.
function refreshCurrent(cwd, id) {
  const config = loadConfig();
  if (!config?.remote || !fs.existsSync(path.join(REPO_DIR, ".git"))) return null;
  let result = null;
  withLock(() => {
    const rf = refreshRepo();
    if (!rf.ok) return log(`resume check: could not reach GitHub: ${rf.err}`);
    const key = findSessionKey(id);
    if (!key) return;
    const dir = path.join(REPO_DIR, key, id);
    const meta = readJson(path.join(dir, "meta.json"), null);
    if (!meta) return;
    const known = loadState().sessions[id];
    if (known?.remoteSha === meta.sha256) return;
    const r = pullOne({ ...meta, key, dir }, projectDirFor(cwd), new Set(config.allow || []));
    if (r.added) result = { added: r.added, from: meta.lastPushedFrom, updatedAt: meta.updatedAt };
  }, WORKER_LOCK_WAIT_MS);
  return result;
}

// ----------------------------------------------------------------- status

function doStatus(args) {
  const cwd = path.resolve(argText(args.cwd) ?? process.cwd());
  const config = loadConfig();
  const project = projectInfo(cwd);
  console.log(`Project:  ${project.key}  (${project.root})`);
  console.log(`Remote:   ${project.remote ?? "none"}`);
  console.log(`Sync to:  ${config?.remote ?? "NOT SET UP"}`);
  console.log(`Folder:   ${SYNC_DIR}${samePath(SYNC_DIR, LEGACY_SYNC_DIR) ? "  (old location inside the Claude folder: re-run install.mjs to move it)" : ""}`);
  console.log(`Machine:  ${config?.machine ?? os.hostname()}`);
  for (const [id, v] of Object.entries(loadState().sessions).filter(([, v]) => v.key === project.key)) {
    console.log(`  ${id}  ${v.pushedAt ? `pushed ${ago(v.pushedAt)}` : ""}${v.pulledAt ? `  pulled ${ago(v.pulledAt)}` : ""}${v.skip ? `  skipped: ${v.skip}` : ""}`);
  }
}

// ------------------------------------------------------------------ setup

function doSetup(args) {
  const remote = argText(args.remote);
  if (!remote) fail("Usage: setup --remote <git url of your private conversations repo> [--machine <name>]");
  const existing = loadConfig() || {};
  const config = { ...existing, remote, machine: argText(args.machine) || existing.machine || os.hostname() };
  writeJson(CONFIG_PATH, config);
  ensureRepo();
  console.log(`Sync repo ready at ${REPO_DIR} (machine "${config.machine}").`);
}

// ------------------------------------------------------------------ hooks

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function spawnBackground(argv) {
  const child = spawn(process.execPath, [SELF, ...argv], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: GIT_ENV,
  });
  child.unref();
}

// The download itself, run detached so no hook is ever cut off mid-download or
// left holding the lock. Writes what it did where the waiting hook looks.
function doWorker(args) {
  const out = { ok: true, kind: args.kind };
  try {
    if (args.kind === "resume") out.current = refreshCurrent(args.cwd, args.session);
    else out.pulled = autoPull(args.cwd, args.session);
  } catch (e) {
    out.ok = false;
    out.error = String(e.message || e);
    log(`${args.kind} download error: ${out.error}`);
  }
  if (typeof args.result === "string") {
    try {
      fs.mkdirSync(path.dirname(args.result), { recursive: true });
      fs.writeFileSync(args.result + ".tmp", JSON.stringify(out));
      fs.renameSync(args.result + ".tmp", args.result);
    } catch (e) {
      log(`could not write the download result: ${e.message}`);
    }
  }
}

/** Start the download in the background and wait up to waitMs for it. null = still running. */
function downloadInBackground(kind, cwd, id, waitMs) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  for (const f of fs.readdirSync(RESULT_DIR)) {
    const p = path.join(RESULT_DIR, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60_000) fs.unlinkSync(p); } catch {}
  }
  const result = path.join(RESULT_DIR, `${kind}-${id}-${process.pid}.json`);
  spawnBackground(["worker", "--kind", kind, "--cwd", cwd, "--session", id, "--result", result]);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(result)) {
      const out = readJson(result, null);
      try { fs.unlinkSync(result); } catch {}
      return out ?? { ok: false };
    }
    sleep(150);
  }
  log(`${kind} download still running after ${Math.round(waitMs / 1000)} s; it continues in the background`);
  return null;
}

function doHook(event) {
  if (process.env.CLAUDE_SYNC_DISABLE === "1") return;
  const input = readStdin();
  const id = input.session_id;
  const transcript = input.transcript_path;
  const cwd = input.cwd || process.cwd();
  const config = loadConfig();
  if (!config?.remote || !id) return;
  const known = loadState().sessions[id];

  if (event === "session-start") {
    if (process.env.CLAUDE_ENV_FILE) {
      try { fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export CLAUDE_SYNC_SESSION_ID=${id}\n`); } catch {}
    }
    const lines = [];
    try {
      if (input.source === "resume") {
        const hookStart = Date.now();
        const done = downloadInBackground("resume", cwd, id, RESUME_WAIT_MS);
        let r = done?.current;
        // The startup download may have added the newer entries itself, after Claude had already
        // read the old file for this window. The window is behind all the same.
        const grew = Date.parse(loadState().sessions[id]?.grewAt ?? 0);
        if (done && !r && grew >= hookStart - 3000) {
          const meta = readJson(path.join(REPO_DIR, findSessionKey(id) ?? "", id, "meta.json"), {});
          r = { added: "some", from: meta.lastPushedFrom, updatedAt: meta.updatedAt };
        }
        if (!done) lines.push("Conversation sync is still fetching this conversation's newer entries from GitHub in the background (a large download). At the start of your next reply, tell the user that this window may be behind another PC, and that typing /resume again in a minute and picking this conversation loads the rest.");
        if (r) lines.push(`Conversation sync: this conversation has ${r.added} newer entries from ${r.from ?? "another PC"} (${ago(r.updatedAt)}). They were added to its file but are not in this window yet. At the start of your next reply, tell the user to type /resume and pick this conversation again to load them.`);
      } else if (input.source !== "compact") {
        const done = downloadInBackground("startup", cwd, id, STARTUP_WAIT_MS);
        const pulled = done?.pulled ?? [];
        if (!done) lines.push("Conversation sync is still downloading newer conversations from GitHub in the background. If the user wants to carry on a conversation from another PC, tell them to give it a minute before choosing it in /resume.");
        if (pulled.length) lines.push(`Conversation sync downloaded the latest from GitHub: ${pulled.map((p) => `"${p.title}" (${p.status === "downloaded" ? "new on this PC" : "updated"}, from ${p.from ?? "another PC"} ${ago(p.updatedAt)})`).join("; ")}. They are ready in /resume.`);
      }
    } catch (e) {
      log(`session-start sync error: ${e.message}`);
    }
    if (!known?.skip) {
      const key = known?.key || projectInfo(cwd).key;
      lines.push(`Conversation sync is on. This conversation (${id}) syncs to ${sessionUrl(config, key, id)}: it uploads a couple of minutes after each reply and when the session ends. /push uploads now; /pull fetches a conversation from GitHub by hand.`);
    }
    console.log(lines.join("\n"));
    return;
  }

  if (!transcript || !fs.existsSync(transcript) || known?.skip) return;
  const background = ["push", "--auto", "--session", id, "--transcript", transcript, "--cwd", cwd];

  if (event === "stop") {
    // Trailing debounce: at most one upload every PUSH_DEBOUNCE_MS, and the last
    // reply always gets uploaded once the quiet period ends.
    const now = Date.now();
    if (known?.scheduledUntil && known.scheduledUntil > now) return;
    const last = known?.pushedAt ? Date.parse(known.pushedAt) : 0;
    const delay = Math.max(0, last + PUSH_DEBOUNCE_MS - now);
    patchSession(id, { scheduledUntil: now + delay });
    spawnBackground([...background, "--after", String(delay)]);
    return;
  }

  if (event === "session-end") spawnBackground(background);
}

// ------------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
try {
  if (cmd === "hook") doHook(args._[0]);
  else if (cmd === "push") doPush(args);
  else if (cmd === "pull") doPull(args);
  else if (cmd === "worker") doWorker(args);
  else if (cmd === "status") doStatus(args);
  else if (cmd === "setup") doSetup(args);
  else if (cmd === "where") console.log(SYNC_DIR);
  else fail("Usage: sync.mjs setup|push|pull|status|where|hook <event>");
} catch (e) {
  log(`error in ${cmd}: ${e.stack || e}`);
  if (cmd === "hook" || cmd === "worker" || args.auto) process.exit(0); // never break Claude over a sync problem
  fail(`Sync error: ${e.message || e}`);
}
