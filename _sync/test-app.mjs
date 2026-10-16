// The app's own repository, end to end with real git, in a scratch folder (nothing of
// yours is touched; it installs Claude's Agent SDK from npm into the scratch folder):
// - a new PC: the app's repository, its run-time packages, a conversations repository;
// - updates: a fast-forward, and a changed copy left alone;
// - a PC on the old layout (the engine inside the conversations repository) moving over
//   by itself through the forwarders in _sync/legacy/.
//   node _sync/test-app.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${String(detail).trim().slice(0, 600).replace(/\n/g, "\n      ")}`}`);
};
const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-app-"));
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const gitq = (args, cwd) => {
  const r = git(args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const ident = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_") && !k.startsWith("CONVERSATIONS_")));

// The app's repository: this checkout's engine and run-time list.
const appBare = path.join(T, "app.git");
gitq(["init", "-q", "--bare", "-b", "main", appBare]);
const seed = path.join(T, "seed");
fs.mkdirSync(path.join(seed, "_app", "runtime"), { recursive: true });
fs.cpSync(path.join(ROOT, "_sync"), path.join(seed, "_sync"), { recursive: true, filter: (p) => !/node_modules|[\\/]fixtures([\\/]|$)/.test(p) });
for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(ROOT, "_app", "runtime", f), path.join(seed, "_app", "runtime", f));
fs.writeFileSync(path.join(seed, ".gitattributes"), "* -text\n");
gitq(["init", "-q", "-b", "main"], seed);
gitq(["add", "-A"], seed);
gitq([...ident, "commit", "-q", "-m", "app"], seed);
gitq(["push", "-q", appBare, "main"], seed);

const pc = (name) => {
  const home = path.join(T, name, "home");
  const local = path.join(home, "AppData", "Local");
  fs.mkdirSync(local, { recursive: true });
  const env = { ...clean, USERPROFILE: home, HOME: home, LOCALAPPDATA: local, CONVERSATIONS_APP_REPO_URL: appBare };
  return { home, local, env, app: path.join(local, "conversations-app"), sync: path.join(local, "claude-conversation-sync"), claude: path.join(home, ".claude") };
};
const node = (m, file, args = [], extra = {}) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env: { ...m.env, ...extra }, timeout: 10 * 60_000 });
const json = (r) => {
  try {
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return null;
  }
};
const hooks = (m) => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(m.claude, "settings.json"), "utf8"));
    return Object.fromEntries(Object.entries(s.hooks || {}).map(([k, v]) => [k, v.flatMap((g) => g.hooks.map((h) => h.command))]));
  } catch {
    return {};
  }
};

try {
  // ---------------------------------------------------------------- a new PC
  const A = pc("pcA");
  gitq(["clone", "-q", appBare, A.app]);
  const a1 = json(node(A, path.join(A.app, "_sync", "sync.mjs"), ["app", "--json"]));
  check("new PC: the app's repository and its run-time packages are set up", a1?.ok && a1.runtime?.ok && fs.existsSync(path.join(a1.runtime.dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs")), JSON.stringify(a1));
  check("new PC: the run-time packages are outside the app's repository", a1?.runtime?.dir && !a1.runtime.dir.startsWith(A.app + path.sep) && git(["status", "--porcelain"], A.app).stdout.trim() === "", a1?.runtime?.dir);
  const noRemote = node(A, path.join(A.app, "_sync", "install.mjs"), ["--machine", "PC A"]);
  check("new PC: the installer asks which repository holds the conversations", noRemote.status !== 0 && /--remote/.test(noRemote.stderr) && !fs.existsSync(path.join(A.sync, "repo")), noRemote.stderr);
  const chats = path.join(T, "chats.git");
  gitq(["init", "-q", "--bare", chats]);
  const inst = node(A, path.join(A.app, "_sync", "install.mjs"), ["--remote", chats, "--machine", "PC A"]);
  check("new PC: installing with the conversations repository works", inst.status === 0, inst.stderr + inst.stdout);
  check("new PC: the empty conversations repository was started", git(["--git-dir", chats, "log", "--oneline", "main"]).stdout.includes("Start the conversation sync"));
  check("new PC: the conversations repository holds no code", !fs.existsSync(path.join(A.sync, "repo", "_sync")) && !fs.existsSync(path.join(A.sync, "repo", "_app")));
  const hA = hooks(A);
  const stopA = hA.Stop ?? [];
  check("new PC: hooks run the app repository's engine, from $HOME, without a sync folder argument", stopA.length === 1 && stopA[0] === 'node "$HOME/AppData/Local/conversations-app/_sync/sync.mjs" hook stop', JSON.stringify(hA));
  const skill = fs.readFileSync(path.join(A.claude, "skills", "push", "SKILL.md"), "utf8");
  check("new PC: /push runs the same engine", skill.includes("$HOME/AppData/Local/conversations-app/_sync/sync.mjs"), skill.slice(0, 300));
  const again = node(A, path.join(A.app, "_sync", "install.mjs"));
  const hA2 = hooks(A);
  check("new PC: running the installer again keeps one hook per event", again.status === 0 && ["Stop", "SessionStart", "SessionEnd"].every((e) => (hA2[e] ?? []).length === 1), JSON.stringify(hA2) + again.stderr);
  const where = node(A, path.join(A.app, "_sync", "sync.mjs"), ["where"]);
  check("new PC: the engine uses the usual sync folder", where.stdout.trim() === A.sync, where.stdout + where.stderr);

  // ---------------------------------------------------------------- updates
  const work = path.join(T, "work");
  gitq(["clone", "-q", appBare, work]);
  fs.appendFileSync(path.join(work, "_sync", "README-update.txt"), "a newer version\n");
  gitq(["add", "-A"], work);
  gitq([...ident, "commit", "-q", "-m", "newer"], work);
  gitq(["push", "-q", "origin", "main"], work);
  const newer = gitq(["rev-parse", "HEAD"], work);
  const u1 = json(node(A, path.join(A.app, "_sync", "sync.mjs"), ["app", "--now", "--json"]));
  check("updates: a newer version arrives (fast-forward)", u1?.refresh?.updated && gitq(["rev-parse", "HEAD"], A.app) === newer, JSON.stringify(u1));
  const u2 = json(node(A, path.join(A.app, "_sync", "sync.mjs"), ["app", "--json"]));
  check("updates: not again within ten minutes", u2?.refresh?.skipped === "recent", JSON.stringify(u2));
  fs.appendFileSync(path.join(A.app, "_sync", "README-update.txt"), "edited here\n");
  fs.appendFileSync(path.join(work, "_sync", "README-update.txt"), "newer still\n");
  gitq([...ident, "commit", "-q", "-am", "newer still"], work);
  gitq(["push", "-q", "origin", "main"], work);
  const u3 = json(node(A, path.join(A.app, "_sync", "sync.mjs"), ["app", "--now", "--json"]));
  check("updates: a copy that was changed on this PC is left alone", u3?.refresh?.skipped === "changed" && fs.readFileSync(path.join(A.app, "_sync", "README-update.txt"), "utf8").includes("edited here"), JSON.stringify(u3));
  gitq(["checkout", "-q", "--", "."], A.app);

  // ---------------------------------------------------------------- the old layout
  // A conversations repository from before the move: the forwarders, the old engine, a conversation.
  const B = pc("pcB");
  const oldBare = path.join(T, "old-chats.git");
  gitq(["init", "-q", "--bare", "-b", "main", oldBare]);
  const oldSeed = path.join(T, "old-seed");
  fs.mkdirSync(path.join(oldSeed, "_sync"), { recursive: true });
  for (const f of ["sync.mjs", "install.mjs", "move.mjs"]) fs.copyFileSync(path.join(ROOT, "_sync", "legacy", f), path.join(oldSeed, "_sync", f));
  fs.copyFileSync(path.join(ROOT, "_sync", "sync.mjs"), path.join(oldSeed, "_sync", "sync-legacy.mjs"));
  fs.copyFileSync(path.join(ROOT, "_sync", "engine.mjs"), path.join(oldSeed, "_sync", "engine.mjs"));
  fs.cpSync(path.join(ROOT, "_sync", "skills"), path.join(oldSeed, "_sync", "skills"), { recursive: true });
  fs.mkdirSync(path.join(oldSeed, "website", "11111111-2222-4333-8444-555555555555"), { recursive: true });
  fs.writeFileSync(path.join(oldSeed, "website", "11111111-2222-4333-8444-555555555555", "meta.json"), "{}\n");
  fs.writeFileSync(path.join(oldSeed, "README.md"), "conversations\n");
  fs.writeFileSync(path.join(oldSeed, ".gitattributes"), "* -text\n");
  gitq(["init", "-q", "-b", "main"], oldSeed);
  gitq(["add", "-A"], oldSeed);
  gitq([...ident, "commit", "-q", "-m", "old layout"], oldSeed);
  gitq(["push", "-q", oldBare, "main"], oldSeed);
  gitq(["clone", "-q", oldBare, path.join(B.sync, "repo")]);
  fs.writeFileSync(path.join(B.sync, "config.json"), JSON.stringify({ remote: oldBare, machine: "PC B" }));
  const oldCmd = (e) => `node "$HOME/AppData/Local/claude-conversation-sync/repo/_sync/sync.mjs" hook ${e}`;
  fs.mkdirSync(B.claude, { recursive: true });
  fs.writeFileSync(path.join(B.claude, "settings.json"), JSON.stringify({ model: "keep-me", hooks: { Stop: [{ hooks: [{ type: "command", command: oldCmd("stop"), timeout: 15 }] }], SessionStart: [{ hooks: [{ type: "command", command: oldCmd("session-start"), timeout: 60 }] }], SessionEnd: [{ hooks: [{ type: "command", command: oldCmd("session-end"), timeout: 15 }] }] } }, null, 2));
  const fwd = path.join(B.sync, "repo", "_sync", "sync.mjs");
  const b1 = node(B, fwd, ["where"], { TMP: path.join(T, "pcB"), TEMP: path.join(T, "pcB") });
  check("old layout: the hooks' old path keeps working before the move (the engine that was there runs)", b1.status === 0 && b1.stdout.trim() === B.sync, b1.stdout + b1.stderr);
  // The move runs in the background: the app's repository, its run-time packages, the hooks.
  const t0 = Date.now();
  while (Date.now() - t0 < 5 * 60_000 && !(hooks(B).Stop ?? []).some((c) => c.includes("conversations-app"))) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
  const hB = hooks(B);
  const moveLog = fs.existsSync(path.join(B.sync, "move.log")) ? fs.readFileSync(path.join(B.sync, "move.log"), "utf8") : "";
  check("old layout: it moves by itself: a copy of the app's repository", fs.existsSync(path.join(B.app, ".git")), moveLog);
  check("old layout: ...its run-time packages", fs.readdirSync(`${B.app}-runtime`, { withFileTypes: true }).some((d) => d.isDirectory() && fs.existsSync(path.join(`${B.app}-runtime`, d.name, ".ready"))), moveLog);
  check("old layout: ...and the hooks run the engine there, one per event", ["Stop", "SessionStart", "SessionEnd"].every((e) => (hB[e] ?? []).length === 1 && hB[e][0].includes("$HOME/AppData/Local/conversations-app/_sync/sync.mjs")), JSON.stringify(hB) + moveLog);
  const settingsB = JSON.parse(fs.readFileSync(path.join(B.claude, "settings.json"), "utf8"));
  check("old layout: the rest of Claude Code's settings is kept", settingsB.model === "keep-me");
  const cfgB = JSON.parse(fs.readFileSync(path.join(B.sync, "config.json"), "utf8"));
  check("old layout: the conversations repository and its settings are unchanged", path.resolve(cfgB.remote) === path.resolve(oldBare) && cfgB.machine === "PC B" && fs.existsSync(path.join(B.sync, "repo", "website", "11111111-2222-4333-8444-555555555555", "meta.json")), JSON.stringify(cfgB));
  const b2 = node(B, fwd, ["where"]);
  check("old layout: after the move the old path forwards to the moved engine", b2.status === 0 && b2.stdout.trim() === B.sync, b2.stdout + b2.stderr);
  const b3 = node(B, path.join(B.sync, "repo", "_sync", "install.mjs"));
  check("old layout: the installer there forwards too", b3.status === 0 && ["Stop", "SessionStart", "SessionEnd"].every((e) => (hooks(B)[e] ?? []).length === 1), b3.stdout + b3.stderr);

  // ---------------------------------------------------------------- another workspace
  // Its Claude folder's hooks name its own sync folder. The installer, run for that Claude
  // folder without being told the sync folder (the move does that), keeps it.
  const wsSync = path.join(B.local, "claude-conversation-sync-work");
  const wsChats = path.join(T, "work-chats.git");
  gitq(["init", "-q", "--bare", wsChats]);
  const wsClaude = path.join(B.home, ".claude-work");
  fs.mkdirSync(wsClaude, { recursive: true });
  const wsInit = node(B, path.join(B.app, "_sync", "install.mjs"), ["--remote", wsChats], { CLAUDE_CONFIG_DIR: wsClaude, CLAUDE_SYNC_HOME: wsSync });
  const wsHooks = () => hooks({ claude: wsClaude });
  const want = `--sync-home "${wsSync.replace(/\\/g, "/")}"`;
  check("another workspace: set up, its hooks name its own sync folder", wsInit.status === 0 && (wsHooks().Stop ?? [])[0]?.endsWith(want), JSON.stringify(wsHooks()) + wsInit.stderr);
  // As 0.4.0 wrote them: the engine inside the first workspace's conversations repository.
  const s0 = JSON.parse(fs.readFileSync(path.join(wsClaude, "settings.json"), "utf8"));
  for (const groups of Object.values(s0.hooks)) for (const g of groups) for (const h of g.hooks) h.command = h.command.replace(/node "[^"]+"/, 'node "$HOME/AppData/Local/claude-conversation-sync/repo/_sync/sync.mjs"');
  fs.writeFileSync(path.join(wsClaude, "settings.json"), JSON.stringify(s0, null, 2));
  const wsRe = node(B, path.join(B.app, "_sync", "install.mjs"), [], { CLAUDE_CONFIG_DIR: wsClaude });
  const wsH = wsHooks();
  check("another workspace: the installer without its sync folder keeps it (never the first workspace's)", wsRe.status === 0 && ["Stop", "SessionStart", "SessionEnd"].every((e) => (wsH[e] ?? []).length === 1 && wsH[e][0].includes("conversations-app/_sync/sync.mjs") && wsH[e][0].endsWith(want)), JSON.stringify(wsH) + wsRe.stderr);
  const before = fs.readFileSync(path.join(wsClaude, "settings.json"), "utf8");
  const wrong = node(B, path.join(B.app, "_sync", "install.mjs"), [], { CLAUDE_CONFIG_DIR: wsClaude, CLAUDE_SYNC_HOME: B.sync });
  check("another workspace: a sync folder that isn't the one its hooks name is refused, nothing changes", wrong.status !== 0 && /CLAUDE_SYNC_HOME/.test(wrong.stderr) && fs.readFileSync(path.join(wsClaude, "settings.json"), "utf8") === before, wrong.stderr);
  check("another workspace: ...and the first workspace's settings are untouched", JSON.parse(fs.readFileSync(path.join(B.sync, "config.json"), "utf8")).remote === cfgB.remote && JSON.parse(fs.readFileSync(path.join(wsSync, "config.json"), "utf8")).remote === wsChats);

  // On a PC not moved yet, a hook of another workspace never starts the move (that is the first workspace's).
  const C = pc("pcC");
  gitq(["clone", "-q", oldBare, path.join(C.sync, "repo")]);
  fs.writeFileSync(path.join(C.sync, "config.json"), JSON.stringify({ remote: oldBare, machine: "PC C" }));
  const cTmp = path.join(T, "pcC-tmp");
  fs.mkdirSync(cTmp, { recursive: true });
  const c1 = node(C, path.join(C.sync, "repo", "_sync", "sync.mjs"), ["where", "--sync-home", C.sync], { TMP: cTmp, TEMP: cTmp });
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{},3000)"]);
  check("not moved yet: another workspace's hook runs the old engine and starts no move", c1.status === 0 && c1.stdout.trim() === C.sync && !fs.existsSync(path.join(cTmp, "conversations-app-move.started")) && !fs.existsSync(C.app), c1.stdout + c1.stderr);
} catch (e) {
  check("no error", false, e.stack || e);
} finally {
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
}
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`);
process.exit(results.every((x) => x.ok) ? 0 : 1);
