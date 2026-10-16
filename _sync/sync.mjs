#!/usr/bin/env node
// Claude conversation sync, version 3: command line and Claude Code hooks.
//
// Keeps Claude Code conversation transcripts in a private GitHub repo so a
// conversation started on one PC carries on seamlessly on another. The work is
// done by engine.mjs, which the Conversations app also uses.
//
//   node sync.mjs setup --remote <git url> [--machine <name>]
//   node sync.mjs hook session-start|stop|session-end   (reads hook JSON on stdin)
//   node sync.mjs push   [--session <id>] [--cwd <dir>] [--dry-run] [--json]
//   node sync.mjs pull   [list | <n> | <session id>] [--cwd <dir>] [--current <id>]
//   node sync.mjs status [--cwd <dir>] [--json]
//
// For the Conversations app (all print one JSON object):
//   node sync.mjs list --json                 every conversation on GitHub, with project ids and edits
//   node sync.mjs pull-all --json [--no-local] [--skip <id,id>]  bring every conversation on this PC up to date
//   node sync.mjs check --json                has GitHub changed? (one ls-remote)
//   node sync.mjs edit --json --ops '<json>'  pin, rename, archive, delete or mark as an app chat: [{session, field, value}]
//   node sync.mjs folders --json [--refresh]  which folder each project lives in on this PC
//   node sync.mjs push-pending --json         upload commits made while offline
//   node sync.mjs announce --json [--app-version x]  record this PC's versions on GitHub
//   node sync.mjs config --json [--set uploadQuietSeconds=60|120|300]  read or change a sync setting
//   node sync.mjs rules [--push] [--json]      the shared rules file (_shared/CLAUDE.md): where it is; upload it now
//
// How it behaves:
//   - After each Claude reply the conversation is uploaded in the background
//     (at most every two minutes, and always once more when the session ends).
//   - Every time Claude starts in a folder, the newest versions of that folder's
//     conversations are downloaded first, so /resume always shows the latest.
//     Since version 3 that includes every folder with the same git remote, so
//     worktrees and renamed checkouts of one repository share their chats.
//   - Transcripts are append-only logs, so syncing is a merge of lines: whatever
//     one side has that the other lacks is appended. Nothing is ever overwritten
//     or refused, and a conversation continued on two PCs keeps both parts.
//   - Anything that looks like a credential is replaced with [REDACTED ...] in
//     the uploaded copy. Image and document data are never touched.
//
// The working copy lives outside ~/.claude (which some setups sync with OneDrive
// or similar): %LOCALAPPDATA%\claude-conversation-sync on Windows,
// ~/Library/Application Support/claude-conversation-sync on macOS,
// ~/.local/share/claude-conversation-sync elsewhere. Override with CLAUDE_SYNC_HOME.
//
// Needs Node 18+ and git. CLAUDE_SYNC_DISABLE=1 turns the hooks off.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ENGINE_VERSION,
  pushRules,
  rulesStatus,
  SYNC_DIR,
  REPO_DIR,
  LEGACY_SYNC_DIR,
  RESULT_DIR,
  uploadQuietMs,
  setConfigValues,
  STARTUP_WAIT_MS,
  RESUME_WAIT_MS,
  GIT_ENV,
  SyncError,
  argText,
  sleep,
  log,
  readJson,
  loadConfig,
  saveConfig,
  loadState,
  patchSession,
  samePath,
  sessionUrl,
  humanBytes,
  ago,
  withLock,
  refreshRepo,
  ensureRepo,
  projectInfo,
  projectDirFor,
  findLocalTranscripts,
  findSessionKey,
  remoteSessions,
  listRemoteSessions,
  pushSession,
  pullOne,
  autoPull,
  refreshCurrent,
  pullAll,
  checkRemote,
  status,
  setup,
  mergedState,
  appendStateOps,
  pushPending,
  announceDevice,
  localProjectFolders,
  knownOwnedNames,
  isProjectFolder,
  isDeleted,
  drainPendingUploads,
  shareWorkspace,
  APP_DIR,
  CLAUDE_DIR,
  ensureAppClone,
  ensureRuntime,
  refreshApp,
} from "./engine.mjs";

const SELF = fileURLToPath(import.meta.url);
// Only the engine in this PC's copy of the app's repository keeps that copy current:
// a development checkout or a test run never touches it.
const IN_APP_CLONE = samePath(path.resolve(path.dirname(SELF), ".."), APP_DIR);
function refreshAppQuietly() {
  if (!IN_APP_CLONE) return;
  try {
    refreshApp();
  } catch (e) {
    log(`could not refresh the app's repository: ${e.message || e}`);
  }
  rehomeHooks();
}

// Hooks that still name the engine's old place (inside a conversations repository, from
// before the move) are moved to this one: the installer runs again in the background,
// for this Claude folder and sync folder, at most every six hours until it worked.
function rehomeHooks() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, "settings.json"), "utf8"));
    const commands = Object.values(settings?.hooks || {}).flat().flatMap((g) => (g?.hooks || []).map((h) => String(h?.command || "").replace(/\\/g, "/")));
    if (!commands.some((c) => /claude-conversation-sync[^"]*\/repo\/_sync\/sync\.mjs/.test(c))) return;
    const mark = path.join(SYNC_DIR, "rehome.started");
    try {
      if (Date.now() - fs.statSync(mark).mtimeMs < 6 * 3600_000) return;
    } catch {}
    fs.writeFileSync(mark, new Date().toISOString());
    const child = spawn(process.execPath, [path.join(path.dirname(SELF), "install.mjs")], { detached: true, stdio: "ignore", windowsHide: true, env: GIT_ENV });
    child.on("error", () => {});
    child.unref();
    log("moving this Claude folder's hooks to the app repository's engine");
  } catch {}
}

// Flags that never take a value, so "pull --json <id>" still pulls <id>.
const BOOLEAN_FLAGS = new Set(["json", "no-local", "dry-run", "auto", "refresh", "list", "no-push"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = out[key] === undefined ? next : [].concat(out[key], next);
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const printJson = (value) => process.stdout.write(JSON.stringify(value) + "\n");

// ------------------------------------------------------------------- push

function report(r) {
  if (!r) return r;
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

function doPush(args) {
  if (args.json) {
    const r = pushSession(args);
    printJson(r ?? { ok: true, nothing: true });
    return;
  }
  return report(pushSession(args));
}

// ------------------------------------------------------------------- pull

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
    const state = mergedState();
    let sessions = remoteSessions(project).filter((s) => s.sessionId !== current && state[s.sessionId]?.deleted !== true);
    // A session id given in full can come from any project (the app's Open in CLI).
    if (pick && !/^\d+$/.test(pick) && !sessions.some((s) => s.sessionId.startsWith(pick))) {
      sessions = sessions.concat(listRemoteSessions().filter((s) => s.sessionId === pick && state[s.sessionId]?.deleted !== true));
    }
    const targetDir = projectDirFor(cwd);

    if (!sessions.length) {
      let keys = [];
      try {
        keys = fs.readdirSync(REPO_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory() && isProjectFolder(d.name))
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
    const r = pullOne(s, targetDir, allow, { known: knownOwnedNames([cwd]) });
    if (r.status === "missing") fail(`The GitHub copy of "${s.title}" has no transcript file.`);
    if (r.status === "live") {
      if (args.json) return printJson({ ok: false, code: "live", id: s.sessionId, err: "open in Claude Code on this PC" });
      fail(`"${s.title}" is open in Claude Code on this PC (or was written to in the last two minutes), so it is left as it is. Close it there, then pull again.`, 2);
    }
    if (r.status === "no-folder") fail(`This folder (${cwd}) is not on this PC's own list of project folders, so nothing is written into it.`, 2);
    if (args.json) {
      printJson({ ok: true, id: s.sessionId, status: r.status, added: r.added, dest: r.dest });
      return;
    }
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

// ----------------------------------------------------------------- status

function doStatus(args) {
  if (args.json) return printJson(status());
  const cwd = path.resolve(argText(args.cwd) ?? process.cwd());
  const config = loadConfig();
  const project = projectInfo(cwd);
  console.log(`Project:  ${project.key}  (${project.root})`);
  console.log(`Remote:   ${project.remote ?? "none"}`);
  console.log(`Sync to:  ${config?.remote ?? "NOT SET UP"}`);
  console.log(`Folder:   ${SYNC_DIR}${samePath(SYNC_DIR, LEGACY_SYNC_DIR) ? "  (old location inside the Claude folder: re-run install.mjs to move it)" : ""}`);
  console.log(`Machine:  ${config?.machine ?? "?"}`);
  console.log(`Engine:   version ${ENGINE_VERSION}`);
  for (const [id, v] of Object.entries(loadState().sessions).filter(([, v]) => v.key === project.key)) {
    console.log(`  ${id}  ${v.pushedAt ? `pushed ${ago(v.pushedAt)}` : ""}${v.pulledAt ? `  pulled ${ago(v.pulledAt)}` : ""}${v.skip ? `  skipped: ${v.skip}` : ""}`);
  }
}

// ------------------------------------------------------------------ setup

function doSetup(args) {
  const config = setup({ remote: args.remote, machine: args.machine });
  console.log(`Sync repo ready at ${REPO_DIR} (machine "${config.machine}").`);
}

// ------------------------------------------------- app commands (JSON only)

function doList() {
  const state = mergedState();
  const sessions = listRemoteSessions().map(({ dir, ...s }) => ({ ...s, dir, edits: state[s.sessionId] ?? null }));
  printJson({ ok: true, engine: ENGINE_VERSION, sessions, state });
}

function doEdit(args) {
  let ops;
  try {
    ops = JSON.parse(String(args.ops || "[]"));
  } catch {
    throw new SyncError("--ops must be a JSON array of {session, field, value}.", "usage");
  }
  printJson(appendStateOps(Array.isArray(ops) ? ops : [ops], { push: !args["no-push"] }));
}

function doConfig(args) {
  const values = {};
  for (const pair of [].concat(args.set ?? []).filter((x) => typeof x === "string")) {
    const i = pair.indexOf("=");
    if (i < 1) throw new SyncError("--set takes key=value.", "usage");
    values[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  const config = Object.keys(values).length ? setConfigValues(values) : { uploadQuietSeconds: uploadQuietMs() / 1000 };
  printJson({ ok: true, config });
}

function doRules(args) {
  const r = args.push ? pushRules() : rulesStatus();
  if (args.json) return printJson(r);
  if (!r.ok) throw new SyncError(r.err || "could not upload the shared rules", r.code || "git");
  console.log(`Shared rules: ${r.path}${r.exists ? "" : " (not created yet)"}`);
  if (args.push) console.log(r.nothing ? "Nothing new to upload." : "Uploaded. Other PCs have it after their next sync.");
  else if (r.modified || r.unpushed) console.log("This PC has changes to it that are not on GitHub yet; they go up with the next upload, or now with: rules --push");
  else console.log("Up to date with GitHub.");
}

function doAnnounce(args) {
  if (argText(args["app-version"])) saveConfig({ appVersion: argText(args["app-version"]) });
  printJson(announceDevice());
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
  // Then, with the waiting hook already answered: uploads that did not finish earlier.
  try {
    const d = drainPendingUploads();
    if (d?.uploaded?.length) log(`uploaded ${d.uploaded.length} conversation(s) that were waiting`);
  } catch (e) {
    log(`retrying waiting uploads failed: ${e.message || e}`);
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
  const id = typeof input.session_id === "string" && /^[A-Za-z0-9-]{1,80}$/.test(input.session_id) ? input.session_id : null;
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

  // A conversation skipped as deleted uploads again once it has been restored, and a
  // scripted run once it is carried on in Claude Code itself (the upload checks that).
  const skipped = known?.skip && known.skip !== "headless" && !(known.skip === "deleted" && !isDeleted(mergedState(), id));
  if (!transcript || !fs.existsSync(transcript) || skipped) return;
  const background = ["push", "--auto", "--session", id, "--transcript", transcript, "--cwd", cwd];

  if (event === "stop") {
    // Trailing debounce: at most one upload per quiet period (uploadQuietSeconds), and the last
    // reply always gets uploaded once the quiet period ends.
    const now = Date.now();
    if (known?.scheduledUntil && known.scheduledUntil > now) return;
    const last = known?.pushedAt ? Date.parse(known.pushedAt) : 0;
    const delay = Math.max(0, last + uploadQuietMs(config) - now);
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
  else if (cmd === "worker") {
    doWorker(args);
    refreshAppQuietly();
  }
  else if (cmd === "status") doStatus(args);
  else if (cmd === "setup") doSetup(args);
  else if (cmd === "where") console.log(SYNC_DIR);
  else if (cmd === "list") doList();
  else if (cmd === "pull-all") printJson(pullAll({ intoLocal: !args["no-local"], skip: [].concat(args.skip ?? []).filter((x) => typeof x === "string").flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean) }));
  else if (cmd === "check") printJson(checkRemote());
  else if (cmd === "edit") doEdit(args);
  else if (cmd === "folders") printJson({ ok: true, folders: localProjectFolders({ refresh: !!args.refresh }) });
  else if (cmd === "push-pending") printJson(pushPending());
  else if (cmd === "announce") doAnnounce(args);
  else if (cmd === "config") doConfig(args);
  else if (cmd === "rules") doRules(args);
  else if (cmd === "app") {
    // Sets up this PC's copy of the app's repository and its run-time packages, or updates them.
    const clone = ensureAppClone();
    const refresh = clone.ok ? refreshApp({ force: !!args.now }) : null;
    printJson({ ok: clone.ok && (refresh?.ok ?? true), dir: APP_DIR, clone, refresh, runtime: clone.ok ? ensureRuntime() : null });
  } else if (cmd === "share-workspace") printJson(shareWorkspace({ id: argText(args.id), name: argText(args.name), remote: argText(args.remote) }));
  else if (cmd === "version") console.log(ENGINE_VERSION);
  else fail("Usage: sync.mjs setup|push|pull|status|where|hook <event>|list|pull-all|check|edit|folders|push-pending|announce|config|app|version");
} catch (e) {
  log(`error in ${cmd}: ${e.stack || e}`);
  if (cmd === "hook" || cmd === "worker" || args.auto) process.exit(0); // never break Claude over a sync problem
  if (args.json) {
    printJson({ ok: false, code: e.code ?? "error", err: String(e.message || e) });
    process.exit(e.code === "not-set-up" ? 3 : 1);
  }
  if (e instanceof SyncError && e.code === "not-set-up") fail(`Conversation sync is not set up on this PC. Run: node "${SELF}" setup --remote <repo url>`);
  fail(`Sync error: ${e.message || e}`);
}
