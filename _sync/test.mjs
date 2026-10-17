// End-to-end test of sync.mjs, engine.mjs and install.mjs, simulating several PCs against a
// local bare repo standing in for GitHub. Touches nothing outside a temp folder.
// Run: node test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "sync.mjs");
const INSTALL = path.join(HERE, "install.mjs");
const T = process.env.CST_ROOT || path.join(os.tmpdir(), "conversation-sync-test");
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

const results = [];
const check = (name, cond, detail = "") => results.push({ name, ok: !!cond, detail });
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}
const gitq = (args, cwd) => sh("git", args, { cwd });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Stand-in for GitHub, seeded like the real repo: line-ending rule, an old snapshot folder, the tool.
const REMOTE = path.join(T, "remote.git");
gitq(["init", "-q", "--bare", "-b", "main", REMOTE], T);
gitq(["config", "core.longpaths", "true"], REMOTE);
const seed = path.join(T, "seed");
gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, seed], T);
fs.writeFileSync(path.join(seed, ".gitattributes"), "* -text\n");
fs.mkdirSync(path.join(seed, "C--Users-Old-Path-website"), { recursive: true });
fs.writeFileSync(path.join(seed, "C--Users-Old-Path-website", "old.jsonl"), "{}\n");
fs.cpSync(HERE, path.join(seed, "_sync"), { recursive: true, filter: (p) => !p.includes("node_modules") });
gitq(["add", "."], seed);
gitq(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], seed);
gitq(["push", "-q", "origin", "main"], seed);

function project(rel, remoteUrl = "https://github.com/Acme/Website") {
  const d = path.join(T, rel);
  fs.mkdirSync(d, { recursive: true });
  gitq(["init", "-q"], d);
  gitq(["remote", "add", "origin", remoteUrl], d);
  return d;
}
const PA = project("pcA-work/Documents/Coding Projects/website");
const PB = project("pcB-work/Web Development/website");
const PB2 = project("pcB-work/Elsewhere/website-home");
const pc = (name) => ({ claude: path.join(T, name, ".claude"), sync: path.join(T, name, "sync") });
const A = pc("pcA");
const B = pc("pcB");
const enc = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, "-");
const tpath = (m, proj, id) => {
  const d = path.join(m.claude, "projects", enc(proj));
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${id}.jsonl`);
};
// Transcripts here are written moments before they sync, so the "written in the last two
// minutes" rule for live conversations is off unless a test sets the window itself.
// A clean environment: a Claude Code run inside the Conversations app carries
// CLAUDE_SYNC_INCLUDE_HEADLESS and other CLAUDE_SYNC_* settings, and inheriting
// them would change what the tests measure.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_SYNC_") && !k.startsWith("CONVERSATIONS_")));
const envFor = (m, extra = {}) => ({ ...baseEnv, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_SYNC_HOME: m.sync, CLAUDE_SYNC_DEBOUNCE_MS: "4000", CLAUDE_SYNC_LIVE_WINDOW_MS: "1", ...extra });
const run = (m, args, extra = {}, input) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", input, env: envFor(m, extra) });
const hook = (m, event, payload) => run(m, ["hook", event], {}, JSON.stringify(payload));
const remoteFile = (key, id, name = "transcript.jsonl") => {
  const c = path.join(T, "inspect");
  fs.rmSync(c, { recursive: true, force: true });
  gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, c], T);
  const p = path.join(c, key, id, name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};
const commitsFor = (id) => {
  const c = path.join(T, "inspect");
  remoteFile("x", "x");
  return Number(sh("git", ["rev-list", "--count", "HEAD", "--", `website/${id}`], { cwd: c }).stdout.trim());
};
const waitFor = (fn, secs = 60) => {
  for (let i = 0; i < secs; i++) {
    const v = fn();
    if (v) return v;
    sleep(1000);
  }
  return null;
};

const ID = "11111111-2222-3333-4444-555555555555";
const FAKE_TOKEN = "ghp_" + "a".repeat(36);
const IMG = "iVBORw0KGgo/AIza" + "B".repeat(35) + "/moreimagedata==";
const line = (text, cwd, id = ID, extra = {}) =>
  JSON.stringify({ type: "user", promptSource: "typed", message: { role: "user", content: text }, timestamp: new Date().toISOString(), sessionId: id, cwd, ...extra }) + "\n";
const imageLine = (cwd) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: IMG } }, { type: "text", text: "see image" }] }, sessionId: ID, cwd }) + "\n";
const has = (file, text) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(text);

// ---- 1. first push: redaction, images, session files, working folder outside ~/.claude
const TA = tpath(A, PA, ID);
fs.writeFileSync(TA, JSON.stringify({ type: "ai-title", aiTitle: "Test chat about the login page", sessionId: ID }) + "\n" + line("hello from A, my token is " + FAKE_TOKEN, PA) + imageLine(PA));
fs.mkdirSync(path.join(A.claude, "projects", enc(PA), ID, "tool-results"), { recursive: true });
fs.writeFileSync(path.join(A.claude, "projects", enc(PA), ID, "tool-results", "out.txt"), "tool output with " + FAKE_TOKEN + "\n");
let r = run(A, ["setup", "--remote", REMOTE, "--machine", "PC-A"]);
check("setup puts the working folder outside the Claude folder", r.status === 0 && fs.existsSync(path.join(A.sync, "config.json")) && !fs.existsSync(path.join(A.claude, "conversation-sync")), r.stderr);
r = run(A, ["push", "--session", ID, "--cwd", PA, "--dry-run"]);
check("dry run uploads nothing", r.status === 0 && /Dry run/.test(r.stdout) && !remoteFile("website", ID), r.stdout + r.stderr);
r = run(A, ["push", "--session", ID, "--cwd", PA]);
check("first push uploads", r.status === 0 && /Uploaded/.test(r.stdout), r.stdout + r.stderr);
check("first push reports the redaction", /Redacted in the uploaded copy: 1 × GitHub token/.test(r.stdout), r.stdout);
let rem = remoteFile("website", ID);
check("token removed from the uploaded transcript", rem && !rem.includes(FAKE_TOKEN) && rem.includes("[REDACTED GitHub token"));
check("image data untouched", rem && rem.includes(IMG));
const remTool = remoteFile("website", ID, path.join("files", "tool-results", "out.txt"));
check("session files uploaded and redacted", remTool && !remTool.includes(FAKE_TOKEN) && remTool.includes("[REDACTED"));
check("local file untouched", has(TA, FAKE_TOKEN));
check("old snapshot folder untouched", !!remoteFile("C--Users-Old-Path-website", "", "old.jsonl"));

// ---- 2. a second PC at a different path gets it automatically when Claude starts
run(B, ["setup", "--remote", REMOTE, "--machine", "PC-B"]);
const TB = path.join(B.claude, "projects", enc(PB), `${ID}.jsonl`);
r = hook(B, "session-start", { session_id: "startup-b-1", cwd: PB, source: "startup" });
check("startup downloads the folder's conversations", r.status === 0 && fs.existsSync(TB) && fs.readFileSync(TB).equals(rem), r.stdout + r.stderr);
check("startup tells Claude what it downloaded", /downloaded the latest from GitHub: "Test chat about the login page" \(new on this PC/.test(r.stdout), r.stdout);
check("session files downloaded too", fs.existsSync(path.join(B.claude, "projects", enc(PB), ID, "tool-results", "out.txt")));

// ---- 3. continuing on B uploads after the reply; A picks it up at its next start
fs.appendFileSync(TB, line("more from B", PB));
const h0 = Date.now();
r = hook(B, "stop", { session_id: ID, transcript_path: TB, cwd: PB });
check("stop hook returns at once", r.status === 0 && Date.now() - h0 < 3000, `${Date.now() - h0} ms`);
check("reply uploaded in the background", !!waitFor(() => remoteFile("website", ID)?.includes("more from B")));
r = hook(A, "session-start", { session_id: "startup-a-1", cwd: PA, source: "startup" });
check("A's next start adds B's messages", has(TA, "more from B") && /updated, from PC-B/.test(r.stdout), r.stdout + r.stderr);
check("A keeps its own unredacted original text", has(TA, FAKE_TOKEN));

// ---- 4. nothing new means no commit
const before4 = commitsFor(ID);
r = run(A, ["push", "--session", ID, "--cwd", PA]);
check("push with nothing new makes no commit", r.status === 0 && /Already up to date/.test(r.stdout) && commitsFor(ID) === before4, r.stdout + r.stderr);

// ---- 5. both PCs continue the same conversation: merged, nothing refused, both converge
fs.appendFileSync(TA, line("A only", PA));
fs.appendFileSync(TB, line("B only", PB));
r = run(B, ["push", "--session", ID, "--cwd", PB]);
check("first PC's push goes through", r.status === 0, r.stdout + r.stderr);
r = run(A, ["push", "--session", ID, "--cwd", PA]);
check("second PC's push merges instead of refusing", r.status === 0 && /Updated/.test(r.stdout) && /newer entries from PC-B/.test(r.stdout), r.stdout + r.stderr);
rem = remoteFile("website", ID);
check("GitHub keeps both PCs' messages", rem.includes("A only") && rem.includes("B only"));
hook(A, "session-start", { session_id: "startup-a-2", cwd: PA, source: "startup" });
hook(B, "session-start", { session_id: "startup-b-2", cwd: PB, source: "startup" });
check("both PCs end up with everything", has(TA, "B only") && has(TB, "A only"));
const pa = run(A, ["push", "--session", ID, "--cwd", PA]);
const pb = run(B, ["push", "--session", ID, "--cwd", PB]);
check("after merging, both sides are stable", /Already up to date/.test(pa.stdout) && /Already up to date/.test(pb.stdout), pa.stdout + pb.stdout);

// ---- 6. resuming a stale copy fetches the newer part and says how to load it
fs.appendFileSync(TB, line("B new while A was away", PB));
run(B, ["push", "--session", ID, "--cwd", PB]);
r = hook(A, "session-start", { session_id: ID, transcript_path: TA, cwd: PA, source: "resume" });
check("resume adds the newer entries to the file", has(TA, "B new while A was away"), r.stdout + r.stderr);
check("resume tells Claude to have the user /resume again", /newer entries from PC-B/.test(r.stdout) && /\/resume/.test(r.stdout), r.stdout);
// In the Conversations app (which brought the newest copy first) there is no /resume to ask for.
fs.appendFileSync(TB, line("B newer again", PB));
run(B, ["push", "--session", ID, "--cwd", PB]);
r = run(A, ["hook", "session-start"], { CLAUDE_SYNC_IN_APP: "1" }, JSON.stringify({ session_id: ID, transcript_path: TA, cwd: PA, source: "resume" }));
check("in the app, resume still brings the newer entries, without telling anyone to /resume", has(TA, "B newer again") && !/\/resume/.test(r.stdout), r.stdout + r.stderr);

// ---- 6b. a slow download is finished in the background, never cut off (5 Oct 2026)
fs.appendFileSync(TB, line("B slow one", PB));
run(B, ["push", "--session", ID, "--cwd", PB]);
const IDN = "99999999-aaaa-bbbb-cccc-dddddddddddd";
const slow = { CLAUDE_SYNC_TEST_FETCH_DELAY_MS: "5000", CLAUDE_SYNC_STARTUP_WAIT_MS: "1000", CLAUDE_SYNC_RESUME_WAIT_MS: "30000" };
let s0 = Date.now();
r = spawnSync(process.execPath, [TOOL, "hook", "session-start"], { encoding: "utf8", input: JSON.stringify({ session_id: IDN, transcript_path: tpath(A, PA, IDN), cwd: PA, source: "startup" }), env: envFor(A, slow) });
check("startup returns quickly while a slow download carries on", r.status === 0 && Date.now() - s0 < 4000 && /still downloading/.test(r.stdout), `${Date.now() - s0} ms\n${r.stdout}${r.stderr}`);
// Picking the conversation in /resume while that download still holds the lock: the resume check waits for it.
s0 = Date.now();
r = spawnSync(process.execPath, [TOOL, "hook", "session-start"], { encoding: "utf8", input: JSON.stringify({ session_id: ID, transcript_path: TA, cwd: PA, source: "resume" }), env: envFor(A, { ...slow, CLAUDE_SYNC_TEST_FETCH_DELAY_MS: "0" }) });
check("resume during a running download still gets the newer entries", r.status === 0 && has(TA, "B slow one"), `${Date.now() - s0} ms\n${r.stdout}${r.stderr}`);
check("and the window is told it is behind", /newer entries/.test(r.stdout) && /\/resume/.test(r.stdout), r.stdout);
check("no sync error was logged for it", !/Another sync is still running|time budget/.test(fs.readFileSync(path.join(A.sync, "sync.log"), "utf8").split("\n").slice(-6).join("\n")));
// A lock left behind by a process that no longer exists does not block the next sync.
fs.writeFileSync(path.join(A.sync, "repo.lock"), JSON.stringify({ pid: 2147483646, at: Date.now() }));
s0 = Date.now();
r = run(A, ["pull", "list", "--cwd", PA]);
check("a dead process's lock is ignored", r.status === 0 && Date.now() - s0 < 20000, `${Date.now() - s0} ms\n${r.stdout}${r.stderr}`);

// ---- 7. uploads are debounced, and the last reply still gets uploaded
const ID2 = "22222222-3333-4444-5555-666666666666";
const TA2 = tpath(A, PA, ID2);
fs.writeFileSync(TA2, line("a brand new conversation", PA, ID2));
hook(A, "stop", { session_id: ID2, transcript_path: TA2, cwd: PA });
check("new conversation uploads after its first reply", !!waitFor(() => remoteFile("website", ID2)));
sleep(1500);
fs.appendFileSync(TA2, line("turn two", PA, ID2));
hook(A, "stop", { session_id: ID2, transcript_path: TA2, cwd: PA });
fs.appendFileSync(TA2, line("turn three", PA, ID2));
hook(A, "stop", { session_id: ID2, transcript_path: TA2, cwd: PA });
check("the last reply arrives after the quiet period", !!waitFor(() => remoteFile("website", ID2)?.includes("turn three"), 40));
check("quick replies were batched into one upload", commitsFor(ID2) === 2, `commits: ${commitsFor(ID2)}`);

// ---- 8/9. command-only and scripted sessions are not uploaded
const ID3 = "33333333-4444-5555-6666-777777777777";
const TA3 = tpath(A, PA, ID3);
fs.writeFileSync(TA3, JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/pull</command-name>" }, sessionId: ID3 }) + "\n" + JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "Base directory for this skill: ..." }, sessionId: ID3 }) + "\n");
hook(A, "stop", { session_id: ID3, transcript_path: TA3, cwd: PA });
const ID4 = "44444444-5555-6666-7777-888888888888";
const TA4 = tpath(A, PA, ID4);
fs.writeFileSync(TA4, line("scripted", PA, ID4, { entrypoint: "sdk-cli" }));
hook(A, "stop", { session_id: ID4, transcript_path: TA4, cwd: PA });
sleep(8000);
check("command-only session skipped", !remoteFile("website", ID3));
check("scripted (claude -p) session skipped", !remoteFile("website", ID4));

// ---- 10. session end uploads straight away
fs.appendFileSync(TA2, line("last words", PA, ID2));
const e0 = Date.now();
r = hook(A, "session-end", { session_id: ID2, transcript_path: TA2, cwd: PA });
check("session-end hook returns within its 1.5 s budget", r.status === 0 && Date.now() - e0 < 1500, `${Date.now() - e0} ms`);
check("final state uploaded after the session ended", !!waitFor(() => remoteFile("website", ID2)?.includes("last words")));

// ---- 11. very large transcripts are compressed and come back intact
const ID5 = "55555555-6666-7777-8888-999999999999";
const TA5 = tpath(A, PA, ID5);
fs.writeFileSync(TA5, line("big one " + "x".repeat(5000), PA, ID5));
r = run(A, ["push", "--session", ID5, "--cwd", PA], { CLAUDE_SYNC_GZIP_OVER_BYTES: "1000" });
check("large transcript stored compressed", r.status === 0 && !!remoteFile("website", ID5, "transcript.jsonl.gz"), r.stdout + r.stderr);
r = run(B, ["pull", ID5, "--cwd", PB]);
check("compressed transcript pulls back intact", r.status === 0 && fs.readFileSync(path.join(B.claude, "projects", enc(PB), `${ID5}.jsonl`)).equals(fs.readFileSync(TA5)), r.stdout + r.stderr);

// ---- 12-16. listing, renamed folders, link line, current session, unconfigured PC
r = run(B, ["pull", "list", "--cwd", PB]);
check("list shows every conversation", r.status === 0 && (r.stdout.match(/^\s+\d+\. /gm) || []).length === 3, r.stdout);
tpath(B, PB2, "placeholder");
r = run(B, ["pull", "list", "--cwd", PB2]);
check("a folder with another name is matched by its git remote", r.status === 0 && /Test chat about the login page/.test(r.stdout), r.stdout + r.stderr);
r = hook(A, "session-start", { session_id: ID, transcript_path: TA, cwd: PA, source: "compact" });
check("session start prints the conversation's link", r.status === 0 && /Conversation sync is on/.test(r.stdout) && r.stdout.includes(`website/${ID}`), r.stdout);
r = run(B, ["pull", "list", "--cwd", PB, "--current", ID]);
check("the open conversation is not offered", r.status === 0 && !r.stdout.includes(ID), r.stdout);
r = run(pc("pcC"), ["hook", "stop"], {}, JSON.stringify({ session_id: ID, transcript_path: TA, cwd: PA }));
check("hooks are silent when sync is not set up", r.status === 0 && !r.stdout && !r.stderr);

// ---- 17. stale copies under another of this PC's folder names are merged in, then cleared away (H6)
const PBOLD = path.join(T, "pcB-work", "Old Path", "website");
fs.mkdirSync(PBOLD, { recursive: true });
const staleDir = path.join(B.claude, "projects", enc(PBOLD));
fs.mkdirSync(staleDir, { recursive: true });
fs.writeFileSync(path.join(staleDir, `${ID}.jsonl`), line("only in the copy under the old folder name", PBOLD) + fs.readFileSync(TB).subarray(0, 200).toString("utf8"));
fs.appendFileSync(TA, line("A again", PA));
run(A, ["push", "--session", ID, "--cwd", PA]);
hook(B, "session-start", { session_id: "startup-b-3", cwd: PB, source: "startup" });
const dupBackups = path.join(B.sync, "backups", "duplicates", enc(PBOLD));
check("stale duplicate moved out, one copy left", !fs.existsSync(path.join(staleDir, `${ID}.jsonl`)) && has(TB, "A again") && fs.existsSync(dupBackups) && fs.readdirSync(dupBackups).some((f) => f.startsWith(ID)));
check("H6: what only the stale copy had is kept in the copy that stays", has(TB, "only in the copy under the old folder name"));

// ---- 18. an old install inside ~/.claude keeps working, and install.mjs moves it out
const D = pc("pcD");
const legacy = path.join(D.claude, "conversation-sync");
fs.mkdirSync(legacy, { recursive: true });
fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ remote: REMOTE, machine: "PC-D" }));
gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, path.join(legacy, "repo")], T);
r = run(D, ["where"]);
check("an old install is still found where it is", r.stdout.trim().toLowerCase() === legacy.toLowerCase(), r.stdout);
fs.writeFileSync(path.join(D.claude, "settings.json"), JSON.stringify({ model: "keep-me", hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${legacy.replace(/\\/g, "/")}/repo/_sync/sync.mjs" hook stop` }] }] } }));
r = spawnSync(process.execPath, [INSTALL], { encoding: "utf8", env: envFor(D) });
const settingsD = JSON.parse(fs.readFileSync(path.join(D.claude, "settings.json"), "utf8"));
const cmds = Object.values(settingsD.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
check("install moves the old folder out of the Claude folder", r.status === 0 && fs.existsSync(path.join(D.sync, "repo", ".git")) && !fs.existsSync(path.join(legacy, "config.json")), r.stdout + r.stderr);
const fwd = spawnSync(process.execPath, [path.join(legacy, "repo", "_sync", "sync.mjs"), "where"], { encoding: "utf8", env: envFor(D) });
check("hooks of sessions opened before the move still work", fwd.status === 0 && fwd.stdout.trim().toLowerCase() === D.sync.toLowerCase(), fwd.stdout + fwd.stderr);
// Hooks run the engine next to the installer that ran (the app repository's copy), not one inside the sync folder.
check("install points all three hooks at the installer's engine, once each", cmds.length === 3 && cmds.every((c) => c.includes(`${path.dirname(INSTALL).replace(/\\/g, "/")}/sync.mjs`)), cmds.join("\n"));
check("install keeps the other settings", settingsD.model === "keep-me");
check("install fills in the skills", !fs.readFileSync(path.join(D.claude, "skills", "push", "SKILL.md"), "utf8").includes("{{SYNC}}"));

// ======================================================================
// Version 3: projects by git remote, device registry, per-PC edit logs,
// the app's commands, and PCs still on version 2 working alongside.
// ======================================================================
const jsonOf = (r) => { try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return null; } };
const samePathT = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ---- 19. a worktree's chats reach the main folder even when it has chats of its own
const IDW = "66666666-7777-8888-9999-000000000000";
const TBW = tpath(B, PB2, IDW);
fs.writeFileSync(TBW, line("chat from a worktree folder", PB2, IDW));
r = run(B, ["push", "--session", IDW, "--cwd", PB2]);
check("v3: a worktree folder's chat uploads under its own folder name", r.status === 0 && !!remoteFile("website-home", IDW), r.stdout + r.stderr);
r = hook(A, "session-start", { session_id: "startup-a-v3", cwd: PA, source: "startup" });
check("v3: the main folder gets the worktree's chat at startup", has(path.join(A.claude, "projects", enc(PA), `${IDW}.jsonl`), "chat from a worktree folder"), r.stdout + r.stderr);

// ---- 20. device registry rides along with uploads
const devA = remoteFile("_devices", "pc-a.json", "");
const devAJ = devA ? JSON.parse(devA.toString("utf8")) : null;
check("v3: each PC's device file is on GitHub with its engine version", devAJ?.name === "PC-A" && devAJ?.engine === 3 && !!devAJ?.lastPushAt, devA?.toString());
const beforeNoop = commitsFor(ID);
r = run(A, ["push", "--session", ID, "--cwd", PA]);
check("v3: the device file never makes a commit on its own", commitsFor(ID) === beforeNoop && /Already up to date/.test(r.stdout), r.stdout + r.stderr);

// ---- 21. one project per repository
r = run(B, ["list", "--json"]);
let lj = jsonOf(r);
const keys21 = new Set((lj?.sessions || []).filter((s) => s.projectId === "github.com/acme/website").map((s) => s.key));
check("v3: list puts both folder names under one project id", keys21.has("website") && keys21.has("website-home") && lj.sessions.every((s) => s.projectLabel), r.stdout.slice(0, 400) + r.stderr);

// ---- 22. pins and renames from two PCs: the latest edit wins everywhere
r = run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: ID, field: "pinned", value: true }, { session: ID, field: "title", value: "Renamed on A" }])]);
check("v3: an edit is appended to this PC's log and uploaded", r.status === 0 && jsonOf(r)?.pushed === true && remoteFile("_state", "pc-a.jsonl", "")?.toString().includes("Renamed on A"), r.stdout + r.stderr);
sleep(5);
r = run(B, ["edit", "--json", "--ops", JSON.stringify([{ session: ID, field: "title", value: "Renamed on B" }])]);
check("v3: the other PC writes its own log file, no conflict", r.status === 0 && jsonOf(r)?.pushed === true && !!remoteFile("_state", "pc-b.jsonl", ""), r.stdout + r.stderr);
run(A, ["pull-all", "--json", "--no-local"]);
lj = jsonOf(run(A, ["list", "--json"]));
check("v3: the later rename wins on both PCs and the pin survives", lj?.state?.[ID]?.title === "Renamed on B" && lj?.state?.[ID]?.pinned === true, JSON.stringify(lj?.state?.[ID]));
r = run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: ID, field: "title", value: "Renamed on A again" }])]);
run(B, ["pull-all", "--json", "--no-local"]);
const lb = jsonOf(run(B, ["list", "--json"]));
const stA = JSON.parse(fs.readFileSync(path.join(A.sync, "state.json"), "utf8"));
check("v3: a later edit from the first PC wins again (hybrid clock)", lb?.state?.[ID]?.title === "Renamed on A again" && String(stA.hlc).endsWith("pc-a"), JSON.stringify(lb?.state?.[ID]));

// ---- 23. check: a cheap test for news on GitHub
let ck = jsonOf(run(B, ["check", "--json"]));
check("v3: check says nothing changed right after a sync", ck?.ok === true && ck.changed === false, JSON.stringify(ck));
fs.appendFileSync(TA, line("A posts while B is idle", PA));
run(A, ["push", "--session", ID, "--cwd", PA]);
ck = jsonOf(run(B, ["check", "--json"]));
check("v3: check notices another PC's upload without downloading it", ck?.ok === true && ck.changed === true, JSON.stringify(ck));

// ---- 24. pull-all: everything on this PC, in the right folders, live files left alone
const ID6 = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const TA6 = tpath(A, PA, ID6);
fs.writeFileSync(TA6, line("a brand new chat for pull-all", PA, ID6));
run(A, ["push", "--session", ID6, "--cwd", PA]);
fs.utimesSync(TB, new Date(), new Date()); // B's copy of ID looks live
let pa24 = jsonOf(run(B, ["pull-all", "--json"], { CLAUDE_SYNC_LIVE_WINDOW_MS: String(60 * 60_000) }));
check("v3: pull-all downloads a new chat into its project's folder", pa24?.ok && pa24.downloaded.some((d) => d.id === ID6) && fs.existsSync(path.join(B.claude, "projects", enc(PB), `${ID6}.jsonl`)), JSON.stringify(pa24));
check("v3: pull-all leaves a transcript that is being written alone", pa24?.skippedLive?.includes(ID) && !has(TB, "A posts while B is idle"), JSON.stringify(pa24));
const past = new Date(Date.now() - 10 * 60_000);
fs.utimesSync(TB, past, past);
pa24 = jsonOf(run(B, ["pull-all", "--json"], { CLAUDE_SYNC_LIVE_WINDOW_MS: "60000" }));
check("v3: once quiet, pull-all brings it up to date", pa24?.updated?.some((u) => u.id === ID) && has(TB, "A posts while B is idle"), JSON.stringify(pa24));

// ---- 25. delete: a tombstone, gone from GitHub and from other PCs, never uploaded again
const TB6 = path.join(B.claude, "projects", enc(PB), `${ID6}.jsonl`);
if (fs.existsSync(TB6)) fs.utimesSync(TB6, past, past);
r = run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: ID6, field: "deleted", value: true }])]);
check("v3: delete removes the chat from GitHub", jsonOf(r)?.pushed === true && !remoteFile("website", ID6), r.stdout + r.stderr);
pa24 = jsonOf(run(B, ["pull-all", "--json"], { CLAUDE_SYNC_LIVE_WINDOW_MS: "60000" }));
check("v3: other PCs move their copy to the backup folder", !fs.existsSync(TB6) && fs.existsSync(path.join(B.sync, "backups", "deleted", enc(PB), `${ID6}.jsonl`)), JSON.stringify(pa24));
fs.writeFileSync(TB6, line("resurrected copy", PB, ID6));
r = run(B, ["push", "--session", ID6, "--cwd", PB]);
check("v3: a deleted chat is not uploaded again from a stray copy", r.status === 0 && /deleted on another PC/.test(r.stdout) && !remoteFile("website", ID6), r.stdout + r.stderr);

// ---- 26. chats started in the app (Agent SDK) still sync
const ID7 = "88888888-9999-aaaa-bbbb-cccccccccccc";
const TA7 = tpath(A, PA, ID7);
fs.writeFileSync(TA7, line("typed in the Conversations app", PA, ID7, { entrypoint: "sdk-ts" }));
r = run(A, ["push", "--auto", "--session", ID7, "--transcript", TA7, "--cwd", PA], { CLAUDE_SYNC_INCLUDE_HEADLESS: "1" });
check("v3: an app chat uploads when the app marks it", !!waitFor(() => remoteFile("website", ID7), 20), r.stdout + r.stderr);

// ---- 27. status and folders for the app
const st27 = jsonOf(run(A, ["status", "--json"]));
check("v3: status reports engine, devices and nothing waiting to upload", st27?.engine === 3 && st27.devices.some((d) => d.name === "PC-B") && st27.unpushedCommits === 0 && !!st27.lastFetchAt, JSON.stringify(st27).slice(0, 400));
const fo27 = jsonOf(run(B, ["folders", "--json", "--refresh"]));
const pbFolder = fo27?.folders?.["github.com/acme/website"];
check("v3: folders finds where each project lives on this PC", !!pbFolder && (samePathT(pbFolder, PB) || samePathT(pbFolder, PB2)), JSON.stringify(fo27));

// ---- 28. offline: edits are kept and upload later
const remoteAway = REMOTE + ".away";
fs.renameSync(REMOTE, remoteAway);
r = run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: ID, field: "archived", value: true }])]);
const queued = jsonOf(r);
fs.renameSync(remoteAway, REMOTE);
check("v3: an edit made offline is kept on this PC", queued?.ok === true && queued.queued === true, r.stdout + r.stderr);
const pp = jsonOf(run(A, ["push-pending", "--json"]));
check("v3: and uploads with the next sync", pp?.ok === true && remoteFile("_state", "pc-a.jsonl", "")?.toString().includes('"archived"'), JSON.stringify(pp));

// ---- 29. a PC still on version 2 keeps working next to version 3
const OLD = pc("pcOld");
const oldTool = path.join(T, "v2", "sync.mjs");
fs.mkdirSync(path.dirname(oldTool), { recursive: true });
fs.copyFileSync(path.join(HERE, "fixtures", "sync-v2.mjs"), oldTool); // the version 2 engine as shipped on 29 Sep 2026
const runOld = (args, extra = {}, input) => spawnSync(process.execPath, [oldTool, ...args], { encoding: "utf8", input, env: envFor(OLD, extra) });
runOld(["setup", "--remote", REMOTE, "--machine", "PC-Old"]);
const POLD = project("pcOld-work/website");
r = runOld(["hook", "session-start"], {}, JSON.stringify({ session_id: "startup-old", cwd: POLD, source: "startup" }));
check("v2 PC: still downloads with _devices and _state in the repo", r.status === 0 && fs.existsSync(path.join(OLD.claude, "projects", enc(POLD), `${ID}.jsonl`)), r.stdout + r.stderr);
const IDO = "99999999-0000-1111-2222-333333333333";
const TO = tpath(OLD, POLD, IDO);
fs.writeFileSync(TO, line("written on the old PC", POLD, IDO));
r = runOld(["push", "--session", IDO, "--cwd", POLD]);
check("v2 PC: still uploads", r.status === 0 && /Uploaded/.test(r.stdout), r.stdout + r.stderr);
run(A, ["pull-all", "--json", "--no-local"]);
lj = jsonOf(run(A, ["list", "--json"]));
check("v3 PC: sees the old PC's upload in its project", !!lj?.sessions?.some((s) => s.sessionId === IDO && s.projectId === "github.com/acme/website"), JSON.stringify(lj?.sessions?.map((s) => s.sessionId)));

// ---- 30. a chat uploaded without a git remote joins a repository only through the same PC and folder (M2)
const PNOGIT = path.join(T, "pcOld-nogit", "website");
fs.mkdirSync(PNOGIT, { recursive: true }); // same folder name, not a git checkout
const IDN2 = "aaaaaaaa-0000-1111-2222-333333333333";
fs.writeFileSync(tpath(OLD, PNOGIT, IDN2), line("no git remote here", PNOGIT, IDN2));
r = runOld(["push", "--session", IDN2, "--cwd", PNOGIT]);
const PLATER = path.join(T, "pcOld-later", "website");
fs.mkdirSync(PLATER, { recursive: true }); // not a repository yet
const IDN3 = "aaaaaaaa-0000-1111-2222-444444444444";
fs.writeFileSync(tpath(OLD, PLATER, IDN3), line("before this folder was a repository", PLATER, IDN3));
const r30b = runOld(["push", "--session", IDN3, "--cwd", PLATER]);
gitq(["init", "-q"], PLATER);
gitq(["remote", "add", "origin", "https://github.com/Acme/Website"], PLATER);
const IDN4 = "aaaaaaaa-0000-1111-2222-555555555555";
fs.writeFileSync(tpath(OLD, PLATER, IDN4), line("after git init", PLATER, IDN4));
runOld(["push", "--session", IDN4, "--cwd", PLATER]);
run(A, ["pull-all", "--json", "--no-local"]);
lj = jsonOf(run(A, ["list", "--json"]));
const n30 = lj?.sessions?.find((s) => s.sessionId === IDN2);
const n30b = lj?.sessions?.find((s) => s.sessionId === IDN3);
check("M2: a chat without a remote is not given a repository for its folder name alone", r.status === 0 && n30?.gitRemote == null && n30?.projectId === "folder:website", JSON.stringify(n30));
check("M2: it joins the repository another chat from the same PC and folder names", r30b.status === 0 && n30b?.gitRemote == null && n30b?.projectId === "github.com/acme/website", JSON.stringify(n30b));

// ======================================================================
// Review fixes (11 Oct 2026): each check is named after the finding it covers.
// ======================================================================
let uN = 0;
const uline = (text, cwd, id, extra = {}) =>
  JSON.stringify({ type: "user", promptSource: "typed", uuid: `${id.slice(0, 8)}-u${++uN}`, message: { role: "user", content: text }, timestamp: new Date().toISOString(), sessionId: id, cwd, ...extra }) + "\n";
const hostDomain = `${process.platform}:${os.hostname().toLowerCase()}`;
// A failed expectation is reported as a failed check, never as a crash of the whole run.
const readJsonT = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const sameBytes = (p, buf) => fs.existsSync(p) && fs.readFileSync(p).equals(buf);
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
// A Claude Code session running right now on this PC, recorded the way Claude Code records it.
const openIn = (m, id, extra = {}) => {
  const d = path.join(m.claude, "sessions");
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, `${process.pid}.json`);
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, sessionId: id, cwd: PB, kind: "interactive", entrypoint: "cli", pidDomain: hostDomain, ...extra }));
  return () => fs.rmSync(p, { force: true });
};
const remoteGit = (args) => {
  remoteFile("x", "x");
  return sh("git", args, { cwd: path.join(T, "inspect") }).stdout;
};
const runAsync = (m, args, extra = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [TOOL, ...args], { env: envFor(m, extra) });
    let o = "";
    let e = "";
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (e += d));
    c.on("close", (code) => resolve({ status: code, stdout: o, stderr: e }));
  });

// ---- 31. C1: other PCs' project folders (a cloud-synced ~/.claude) are never written to
const FOREIGN = path.join(B.claude, "projects", "C--Users-cst-other-pc-Documents-Coding-Projects-website");
fs.mkdirSync(FOREIGN, { recursive: true });
// Another PC's folder: a user that exists on no PC that runs this test.
const OTHER_CWD = "C:\\Users\\cst-other-pc\\Documents\\Coding Projects\\website";
const foreignCopy = path.join(FOREIGN, `${ID}.jsonl`);
fs.writeFileSync(foreignCopy, line("written on the Uni PC", OTHER_CWD));
const IDF1 = "f1f1f1f1-0000-4000-8000-000000000001";
fs.writeFileSync(tpath(A, PA, IDF1), line("only in another PC's folder here", PA, IDF1));
run(A, ["push", "--session", IDF1, "--cwd", PA]);
const foreignOnly = path.join(FOREIGN, `${IDF1}.jsonl`);
fs.writeFileSync(foreignOnly, line("Uni PC's copy", OTHER_CWD, IDF1));
const before31 = { a: fs.readFileSync(foreignCopy), b: fs.readFileSync(foreignOnly) };
fs.appendFileSync(TA, line("A writes after the Uni PC copy", PA));
run(A, ["push", "--session", ID, "--cwd", PA]);
let pa31 = jsonOf(run(B, ["pull-all", "--json"]));
hook(B, "session-start", { session_id: "startup-b-31", cwd: PB, source: "startup" });
check("C1: another PC's folder is never written to, moved or merged", sameBytes(foreignCopy, before31.a) && sameBytes(foreignOnly, before31.b), JSON.stringify(pa31));
check("C1: this PC's own copy is updated as usual", has(TB, "A writes after the Uni PC copy"), JSON.stringify(pa31));
check("C1: a conversation only in another PC's folder gets its own copy in this PC's folder", has(path.join(B.claude, "projects", enc(PB), `${IDF1}.jsonl`), "only in another PC's folder here"), JSON.stringify(pa31));
run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: IDF1, field: "deleted", value: true }])]);
pa31 = jsonOf(run(B, ["pull-all", "--json"]));
check("C1: a delete moves only this PC's own copy to the backup folder", sameBytes(foreignOnly, before31.b) && !fs.existsSync(path.join(B.claude, "projects", enc(PB), `${IDF1}.jsonl`)) && pa31?.retired?.includes(IDF1), JSON.stringify(pa31));

// ---- 32. C1: status says when the Claude folder lives inside a cloud folder
const CLOUD = { claude: path.join(T, "cloud", "OneDrive", ".claude"), sync: path.join(T, "pcCloud", "sync") };
fs.mkdirSync(CLOUD.claude, { recursive: true });
const stCloud = jsonOf(run(CLOUD, ["status", "--json"]));
const stA32 = jsonOf(run(A, ["status", "--json"]));
check("C1: status --json reports a Claude folder inside OneDrive", typeof stCloud?.cloudSyncedClaudeDir === "string" && /OneDrive$/i.test(stCloud.cloudSyncedClaudeDir) && stA32?.cloudSyncedClaudeDir === null, JSON.stringify({ c: stCloud?.cloudSyncedClaudeDir, a: stA32?.cloudSyncedClaudeDir }));

// ---- 33. C2: a deleted conversation's backup is never overwritten
const D33 = "d3d3d3d3-0000-4000-8000-000000000001";
const TA33 = tpath(A, PA, D33);
fs.writeFileSync(TA33, line("the original, long conversation", PA, D33) + line("turn 2", PA, D33) + line("turn 3", PA, D33));
run(A, ["push", "--session", D33, "--cwd", PA]);
run(B, ["pull", D33, "--cwd", PB]);
const TB33 = path.join(B.claude, "projects", enc(PB), `${D33}.jsonl`);
fs.appendFileSync(TB33, line("B-only turn never uploaded", PB, D33));
run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: D33, field: "deleted", value: true }])]);
run(B, ["pull-all", "--json"]);
const bk33 = path.join(B.sync, "backups", "deleted", enc(PB), `${D33}.jsonl`);
const first33 = has(bk33, "B-only turn never uploaded") && has(bk33, "turn 3");
// The conversation was still open in a terminal on B, which writes once more and so recreates the file.
fs.writeFileSync(TB33, line("next line from the terminal that still had it open", PB, D33));
fs.mkdirSync(path.join(path.dirname(TB33), D33, "tool-results"), { recursive: true });
fs.writeFileSync(path.join(path.dirname(TB33), D33, "tool-results", "late.txt"), "late output\n");
run(B, ["pull-all", "--json"]);
const show33 = () => (fs.existsSync(bk33) ? fs.readFileSync(bk33, "utf8") : "no backup");
check("C2: the first backup has everything, B's unuploaded turn included", first33, show33());
check("C2: a second retire adds to the backup instead of replacing it", has(bk33, "B-only turn never uploaded") && has(bk33, "the original, long conversation") && has(bk33, "next line from the terminal"), show33());
check("C2: the session folder is set aside too, under a name of its own", !fs.existsSync(path.join(path.dirname(TB33), D33)) && listDir(path.dirname(bk33)).some((f) => f.startsWith(D33) && !f.endsWith(".jsonl")));

// ---- 34. Live: a conversation open in Claude Code on this PC is never written to, moved or deleted
const L34 = "1c1c1c1c-0000-4000-8000-000000000001";
fs.writeFileSync(tpath(A, PA, L34), line("open on B", PA, L34));
run(A, ["push", "--session", L34, "--cwd", PA]);
run(B, ["pull", L34, "--cwd", PB]);
const TB34 = path.join(B.claude, "projects", enc(PB), `${L34}.jsonl`);
fs.appendFileSync(tpath(A, PA, L34), line("A adds while B has it open", PA, L34));
run(A, ["push", "--session", L34, "--cwd", PA]);
const close34 = openIn(B, L34);
const b34 = fs.readFileSync(TB34);
const pa34 = jsonOf(run(B, ["pull-all", "--json"]));
hook(B, "session-start", { session_id: "startup-b-34", cwd: PB, source: "startup" });
const pull34 = run(B, ["pull", L34, "--cwd", PB]);
check("live: pull-all, session start and /pull leave a conversation open in Claude Code alone", sameBytes(TB34, b34) && pa34?.skippedLive?.includes(L34) && pull34.status === 2 && /open in Claude Code/.test(pull34.stderr), JSON.stringify(pa34) + pull34.stdout + pull34.stderr);
const del34 = jsonOf(run(B, ["edit", "--json", "--ops", JSON.stringify([{ session: L34, field: "deleted", value: true }])]));
check("live: it cannot be deleted on the PC where it is open", del34?.ok === false && del34.code === "live", JSON.stringify(del34));
run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: L34, field: "deleted", value: true }])]);
run(B, ["pull-all", "--json"]);
check("live: a delete from another PC waits until it is closed there", fs.existsSync(TB34));
close34();
const close34b = openIn(B, L34, { pidDomain: "win32:another-pc" }); // the same record from another PC (a shared Claude folder)
run(B, ["pull-all", "--json"]);
close34b();
check("live: once closed (another PC's sessions never count) it moves to the backup folder", !fs.existsSync(TB34) && fs.existsSync(path.join(B.sync, "backups", "deleted", enc(PB), `${L34}.jsonl`)));

// ---- 35. C3: two PCs uploading one conversation at the same moment both get through
const S35 = "c3c3c3c3-0000-4000-8000-000000000001";
const TA35 = tpath(A, PA, S35);
fs.writeFileSync(TA35, line("hello from A", PA, S35));
run(A, ["push", "--session", S35, "--cwd", PA]);
run(B, ["pull", S35, "--cwd", PB]);
const TB35 = path.join(B.claude, "projects", enc(PB), `${S35}.jsonl`);
fs.appendFileSync(TA35, line("A continues", PA, S35));
fs.appendFileSync(TB35, line("B continues", PB, S35));
const prePush = path.join(A.sync, "repo", ".git", "hooks", "pre-push");
fs.writeFileSync(prePush, "#!/bin/sh\nsleep 6\nexit 0\n"); // A's upload is slow; B's lands inside it
const pA35 = runAsync(A, ["push", "--session", S35, "--cwd", PA]);
sleep(2500);
const rB35 = run(B, ["push", "--session", S35, "--cwd", PB]);
const rA35 = await pA35;
fs.rmSync(prePush, { force: true });
const rem35 = remoteFile("website", S35)?.toString() ?? "";
check("C3: both uploads of one conversation at the same moment go through", rB35.status === 0 && rA35.status === 0 && rem35.includes("A continues") && rem35.includes("B continues"), rA35.stdout + rA35.stderr + rB35.stdout);
const stuck35 = sh("git", ["log", "--oneline", "origin/main..HEAD"], { cwd: path.join(A.sync, "repo") }).stdout.trim();
const S35b = "c3c3c3c3-0000-4000-8000-000000000002";
fs.writeFileSync(tpath(A, PA, S35b), line("an unrelated chat afterwards", PA, S35b));
const r35b = run(A, ["push", "--session", S35b, "--cwd", PA]);
check("C3: and syncing carries on afterwards, with nothing stuck", stuck35 === "" && r35b.status === 0 && /Uploaded/.test(r35b.stdout), stuck35 + r35b.stdout + r35b.stderr);

// ---- 36. C3: a delete made offline meets another PC's update of the same conversation
const S36 = "c3c3c3c3-0000-4000-8000-000000000036";
fs.writeFileSync(tpath(A, PA, S36), line("conversation to delete", PA, S36));
run(A, ["push", "--session", S36, "--cwd", PA]);
run(B, ["pull", S36, "--cwd", PB]);
fs.renameSync(REMOTE, remoteAway);
const off36 = jsonOf(run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: S36, field: "deleted", value: true }])]));
fs.renameSync(remoteAway, REMOTE);
fs.appendFileSync(path.join(B.claude, "projects", enc(PB), `${S36}.jsonl`), line("B keeps going", PB, S36));
const up36 = run(B, ["push", "--session", S36, "--cwd", PB]);
const pp36 = jsonOf(run(A, ["push-pending", "--json"]));
const S36b = "c3c3c3c3-0000-4000-8000-000000000037";
fs.writeFileSync(tpath(A, PA, S36b), line("unrelated new chat on A", PA, S36b));
const r36 = run(A, ["push", "--session", S36b, "--cwd", PA]);
check("C3: the offline delete is uploaded although the conversation changed meanwhile", off36?.queued === true && /Updated/.test(up36.stdout) && pp36?.ok === true && !remoteFile("website", S36) && !!remoteFile("_state", "pc-a.jsonl", "")?.toString().includes(S36), JSON.stringify({ off36, pp36 }) + up36.stdout + up36.stderr);
check("C3: and nothing on that PC is stuck afterwards", r36.status === 0 && /Uploaded/.test(r36.stdout), r36.stdout + r36.stderr);

// ---- 37. H1: a session's own files are merged, never replaced
const F37 = "f7f7f7f7-0000-4000-8000-000000000001";
const TA37 = tpath(A, PA, F37);
fs.writeFileSync(TA37, line("files test", PA, F37));
const subA37 = path.join(path.dirname(TA37), F37, "subagents");
fs.mkdirSync(subA37, { recursive: true });
const TOKEN37 = "ghp_" + "b".repeat(36);
fs.writeFileSync(path.join(subA37, "agent-1.jsonl"), line("sub 1 uses " + TOKEN37, PA, F37) + line("sub 2", PA, F37));
fs.mkdirSync(path.join(path.dirname(TA37), F37, "tool-results"), { recursive: true });
fs.writeFileSync(path.join(path.dirname(TA37), F37, "tool-results", "x.txt"), "A's output\n");
run(A, ["push", "--session", F37, "--cwd", PA]);
fs.appendFileSync(path.join(subA37, "agent-1.jsonl"), line("sub 3, not uploaded yet", PA, F37));
run(B, ["pull", F37, "--cwd", PB]);
const TB37 = path.join(B.claude, "projects", enc(PB), `${F37}.jsonl`);
const xB37 = path.join(path.dirname(TB37), F37, "tool-results", "x.txt");
fs.mkdirSync(path.dirname(xB37), { recursive: true });
fs.writeFileSync(xB37, "B's own edited copy\n");
fs.appendFileSync(TB37, line("B continues the main thread", PB, F37));
run(B, ["push", "--session", F37, "--cwd", PB]);
hook(A, "session-start", { session_id: "startup-a-37", cwd: PA, source: "startup" });
const agentA37 = fs.existsSync(path.join(subA37, "agent-1.jsonl")) ? fs.readFileSync(path.join(subA37, "agent-1.jsonl"), "utf8") : "";
check("H1: a download keeps a subagent's lines that were not uploaded yet, and this PC's own text", agentA37.includes("sub 3, not uploaded yet") && agentA37.includes(TOKEN37) && has(TA37, "B continues the main thread"), agentA37);
run(A, ["push", "--session", F37, "--cwd", PA]);
const agentRemote37 = remoteFile("website", F37, path.join("files", "subagents", "agent-1.jsonl"))?.toString() ?? "";
const xRemote37 = remoteFile("website", F37, path.join("files", "tool-results", "x.txt"))?.toString() ?? "";
check("H1: an upload adds the new subagent lines to GitHub's copy, still redacted", agentRemote37.includes("sub 3, not uploaded yet") && agentRemote37.includes("sub 2") && !agentRemote37.includes(TOKEN37), agentRemote37);
hook(B, "session-start", { session_id: "startup-b-37", cwd: PB, source: "startup" });
check("H1: other saved files are never replaced on either side", (fs.existsSync(xB37) ? fs.readFileSync(xB37, "utf8") : "") === "B's own edited copy\n" && xRemote37 === "A's output\n", xRemote37);

// ---- 38. H2: a git lock left behind by a killed git never passes for a finished upload
const S38 = "e2e2e2e2-0000-4000-8000-000000000001";
const TA38 = tpath(A, PA, S38);
fs.writeFileSync(TA38, line("first", PA, S38));
run(A, ["push", "--session", S38, "--cwd", PA]);
const idxLock = path.join(A.sync, "repo", ".git", "index.lock");
fs.writeFileSync(idxLock, "");
fs.appendFileSync(TA38, line("second turn", PA, S38));
const r38 = run(A, ["push", "--session", S38, "--cwd", PA]);
const e38 = jsonOf(run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: S38, field: "pinned", value: true }])]));
check("H2: with a fresh git lock an upload or edit reports failure, never success", r38.status !== 0 && !/Already up to date/.test(r38.stdout) && !remoteFile("website", S38)?.toString().includes("second turn") && e38?.ok === false, r38.stdout + r38.stderr + JSON.stringify(e38));
const old38 = new Date(Date.now() - 5 * 60_000);
fs.utimesSync(idxLock, old38, old38);
const r38b = run(A, ["push", "--session", S38, "--cwd", PA]);
check("H2: a git lock over a minute old is cleared and the upload goes through", r38b.status === 0 && !!remoteFile("website", S38)?.toString().includes("second turn") && !fs.existsSync(idxLock), r38b.stdout + r38b.stderr);

// ---- 39. M1: the sync lock is only taken over from a process that has gone
const lockA = path.join(A.sync, "repo.lock");
fs.writeFileSync(lockA, JSON.stringify({ pid: process.pid, at: Date.now() - 20 * 60_000 }));
const pinOps = JSON.stringify([{ session: ID, field: "pinned", value: false }]);
let e39 = jsonOf(run(A, ["edit", "--json", "--ops", pinOps], { CLAUDE_SYNC_LOCK_WAIT_MS: "1500" }));
check("M1: a lock held by a running process is respected, however long it has been held", e39?.ok === false && e39.code === "busy", JSON.stringify(e39));
fs.writeFileSync(lockA, "");
e39 = jsonOf(run(A, ["edit", "--json", "--ops", pinOps], { CLAUDE_SYNC_LOCK_WAIT_MS: "1500" }));
const blankBusy = e39?.ok === false && e39.code === "busy";
const minuteAgo = new Date(Date.now() - 60_000);
if (fs.existsSync(lockA)) fs.utimesSync(lockA, minuteAgo, minuteAgo);
e39 = jsonOf(run(A, ["edit", "--json", "--ops", pinOps], { CLAUDE_SYNC_LOCK_WAIT_MS: "5000" }));
check("M1: a lock file still being written is waited for, and taken over once clearly abandoned", blankBusy && e39?.ok === true && !fs.existsSync(lockA), JSON.stringify(e39));

// ---- 40. M2: a folder with the same name in another repository gets none of its chats
const PA40 = project("pcA-work/web/website", "https://github.com/sam/site-alpha");
const PB40 = project("pcB-work/other/website", "https://github.com/sam/site-beta");
const W40 = "b40b40b4-0000-4000-8000-000000000001";
fs.writeFileSync(tpath(B, PB40, W40), line("beta-only conversation", PB40, W40));
run(B, ["push", "--session", W40, "--cwd", PB40]);
tpath(A, PA40, "placeholder");
r = hook(A, "session-start", { session_id: "start-a-40", cwd: PA40, source: "startup" });
const pa40 = jsonOf(run(A, ["pull-all", "--json"]));
check("M2: a chat from another repository with the same folder name is not downloaded into it", !fs.existsSync(path.join(A.claude, "projects", enc(PA40), `${W40}.jsonl`)) && !r.stdout.includes("beta-only"), r.stdout + JSON.stringify(pa40));

// ---- 41. M3: a deleted conversation that a version 2 PC uploads again is taken out again
const R41 = "a41a41a4-0000-4000-8000-000000000001";
fs.writeFileSync(tpath(B, PB, R41), line("conversation B will delete", PB, R41));
run(B, ["push", "--session", R41, "--cwd", PB]);
runOld(["pull", R41, "--cwd", POLD]);
run(B, ["edit", "--json", "--ops", JSON.stringify([{ session: R41, field: "deleted", value: true }])]);
fs.appendFileSync(tpath(OLD, POLD, R41), line("old PC carries on", POLD, R41));
const old41 = runOld(["push", "--session", R41, "--cwd", POLD]);
const back41 = !!remoteFile("website", R41);
run(A, ["pull-all", "--json"]);
check("M3: a deleted chat a version 2 PC uploads again is removed by the next version 3 sync", /Uploaded|Updated/.test(old41.stdout) && back41 && !remoteFile("website", R41), old41.stdout + old41.stderr);

// ---- 42. M4: credentials never reach GitHub
const PCRED = project("pcA-work/credrepo", "https://sam:" + "s3cretPassw0rd" + "@github.com/sam/credrepo.git");
const C42 = "c42c42c4-0000-4000-8000-000000000001";
const secrets42 = ["sbp_" + "0123456789abcdef".repeat(3), "xkeysib-" + "a1".repeat(32) + "-AbCdEfGh12345678", "figd_" + "Z".repeat(40), "lin_api_" + "k".repeat(40), "npm_" + "N".repeat(36), "postgres://admin:hunter2pass@db.example.com:5432/app"];
fs.writeFileSync(tpath(A, PCRED, C42), line("keys: " + secrets42.join(" | "), PCRED, C42));
r = run(A, ["push", "--session", C42, "--cwd", PCRED]);
const meta42 = JSON.parse(remoteFile("credrepo", C42, "meta.json")?.toString() || "{}");
const rem42 = remoteFile("credrepo", C42)?.toString() ?? "";
check("M4: a remote URL's password is not stored in meta.json", meta42.gitRemote === "https://github.com/sam/credrepo.git" && !JSON.stringify(meta42).includes("s3cretPassw0rd") && meta42.projectId === "github.com/sam/credrepo", JSON.stringify(meta42));
check("M4: Supabase, Brevo, Figma, Linear and npm tokens and passwords in URLs are redacted", r.status === 0 && secrets42.every((s) => !rem42.includes(s)) && (rem42.match(/\[REDACTED /g) || []).length === secrets42.length && rem42.includes("db.example.com"), rem42);
// The same entry, redacted under older rules on GitHub, is not uploaded a second time.
const C42b = "c42c42c4-0000-4000-8000-000000000002";
const figd = "figd_" + "Q".repeat(40);
fs.writeFileSync(tpath(OLD, POLD, C42b), uline("old PC line with " + figd, POLD, C42b));
runOld(["push", "--session", C42b, "--cwd", POLD]); // version 2 has no Figma pattern
run(A, ["pull", C42b, "--cwd", PA]);
fs.appendFileSync(path.join(A.claude, "projects", enc(PA), `${C42b}.jsonl`), uline("A's reply", PA, C42b));
run(A, ["push", "--session", C42b, "--cwd", PA]);
const rem42b = remoteFile("website", C42b)?.toString() ?? "";
check("M4: an entry already on GitHub under other redaction rules is not added twice (same uuid)", rem42b.split("\n").filter((l) => l.includes("old PC line with")).length === 1 && rem42b.includes("A's reply"), rem42b);

// ---- 43. M11: a transcript too big for GitHub even compressed is never committed
const BIG = "b1b1b1b1-0000-4000-8000-000000000001";
const noise = Buffer.from(Array.from({ length: 6000 }, () => Math.floor(Math.random() * 256))).toString("base64");
fs.writeFileSync(tpath(A, PA, BIG), line("big " + noise, PA, BIG));
const commits43 = remoteGit(["rev-list", "--count", "HEAD"]).trim();
const r43 = run(A, ["push", "--session", BIG, "--cwd", PA], { CLAUDE_SYNC_GZIP_OVER_BYTES: "1000", CLAUDE_SYNC_MAX_FILE_BYTES: "3000" });
const commits43b = remoteGit(["rev-list", "--count", "HEAD"]).trim();
fs.appendFileSync(TA, line("A after the big one", PA));
const r43b = run(A, ["push", "--session", ID, "--cwd", PA]);
check("M11: a transcript too big even compressed is refused with a clear message and no commit", r43.status !== 0 && /too large to upload/.test(r43.stdout + r43.stderr) && commits43b === commits43 && !remoteFile("website", BIG, "transcript.jsonl.gz"), r43.stdout + r43.stderr);
check("M11: other conversations keep uploading", r43b.status === 0 && !!remoteFile("website", ID)?.toString().includes("A after the big one"), r43b.stdout + r43b.stderr);

// ---- 44. Lows
const dev0 = Number(remoteGit(["rev-list", "--count", "HEAD"]).trim());
const an1 = jsonOf(run(A, ["announce", "--json"]));
const an2 = jsonOf(run(A, ["announce", "--json", "--app-version", "9.9.9"]));
const an3 = jsonOf(run(A, ["announce", "--json", "--app-version", "9.9.9"]));
const dev1 = Number(remoteGit(["rev-list", "--count", "HEAD"]).trim());
const devFile = JSON.parse(remoteFile("_devices", "pc-a.json", "")?.toString() || "{}");
check("device file: committed on its own only when a version changes", an1?.nothing === true && an2?.ok === true && !an2.nothing && an3?.nothing === true && dev1 === dev0 + 1 && devFile.app === "9.9.9", JSON.stringify({ an1, an2, an3, dev0, dev1 }));

const L1 = pc("pcL1");
const L2 = pc("pcL2");
run(L1, ["setup", "--remote", REMOTE, "--machine", "Laptop"]);
run(L2, ["setup", "--remote", REMOTE, "--machine", "laptop"]);
const X44 = "4a4a4a4a-0000-4000-8000-000000000001";
const s1 = jsonOf(run(L1, ["edit", "--json", "--ops", JSON.stringify([{ session: X44, field: "pinned", value: true }])]));
const s2 = jsonOf(run(L2, ["edit", "--json", "--ops", JSON.stringify([{ session: X44, field: "archived", value: true }])]));
const logs44 = listDir(path.join(L2.sync, "repo", "_state"));
const l2slug = readJsonT(path.join(L2.sync, "config.json"))?.slug;
const lj44 = jsonOf(run(L2, ["list", "--json"]));
check("slugs: PCs called Laptop and laptop keep separate edit logs", s1?.pushed && s2?.pushed && String(l2slug).startsWith("laptop-") && logs44.includes("laptop.jsonl") && logs44.includes(`${l2slug}.jsonl`) && lj44?.state?.[X44]?.pinned === true && lj44?.state?.[X44]?.archived === true, JSON.stringify({ s1, s2, l2slug, logs44 }));

const evilClone = path.join(T, "evil");
gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, evilClone], T);
fs.mkdirSync(path.join(evilClone, "_state"), { recursive: true });
fs.writeFileSync(path.join(evilClone, "_state", "evil.jsonl"), JSON.stringify({ hlc: "999999999999999-0000-evil", pc: "evil", at: new Date().toISOString(), session: "..\\..\\history", field: "deleted", value: true }) + "\n");
gitq(["add", "."], evilClone);
gitq(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "crafted"], evilClone);
gitq(["push", "-q", "origin", "HEAD"], evilClone);
fs.writeFileSync(path.join(B.claude, "history.jsonl"), "{}\n");
const pa44 = jsonOf(run(B, ["pull-all", "--json"]));
check("ids: an edit for something that is not a conversation id is ignored", pa44?.ok === true && fs.existsSync(path.join(B.claude, "history.jsonl")) && !fs.existsSync(path.join(B.sync, "backups", "deleted", "history.jsonl")), JSON.stringify(pa44));

const N44 = pc("pcNew");
fs.mkdirSync(N44.sync, { recursive: true });
fs.writeFileSync(path.join(N44.sync, "config.json"), JSON.stringify({ remote: REMOTE, machine: "PC-New" }));
const [n1, n2] = await Promise.all([runAsync(N44, ["pull-all", "--json", "--no-local"]), runAsync(N44, ["pull-all", "--json", "--no-local"])]);
check("clone: two first syncs at once on a new PC both work, with one clean clone", jsonOf(n1)?.ok === true && jsonOf(n2)?.ok === true && !fs.readdirSync(N44.sync).some((f) => f.includes("incomplete")), n1.stdout + n1.stderr + n2.stdout + n2.stderr);

const X44r = "4e4e4e4e-0000-4000-8000-000000000001";
fs.writeFileSync(tpath(A, PA, X44r), line("to delete and restore", PA, X44r));
run(A, ["push", "--session", X44r, "--cwd", PA]);
run(B, ["pull", X44r, "--cwd", PB]);
const TB44 = path.join(B.claude, "projects", enc(PB), `${X44r}.jsonl`);
run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: X44r, field: "deleted", value: true }])]);
fs.appendFileSync(TB44, line("B writes after the delete", PB, X44r));
const skip44 = run(B, ["push", "--session", X44r, "--cwd", PB]);
run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: X44r, field: "deleted", value: false }])]);
run(B, ["pull-all", "--json", "--no-local"]);
hook(B, "stop", { session_id: X44r, transcript_path: TB44, cwd: PB });
check("restore: a conversation restored after a delete uploads again", /deleted on another PC/.test(skip44.stdout) && !!waitFor(() => remoteFile("website", X44r)?.toString().includes("B writes after the delete"), 30), skip44.stdout + skip44.stderr);

const NR = [
  ["https://github.com/Acme/Website", "github.com/acme/website"],
  ["git@github.com:Acme/Website.git", "github.com/acme/website"],
  ["ssh://git@github.com:2222/Owner/Repo.git", "github.com/owner/repo"],
  ["https://user:tok@github.com/Owner/Repo/", "github.com/owner/repo"],
  ["https://gitlab.com/group/subgroup/repo.git", "gitlab.com/group/subgroup/repo"],
  ["git@gitlab.com:group/subgroup/repo.git", "gitlab.com/group/subgroup/repo"],
  ["https://org@dev.azure.com/org/project/_git/repo", "dev.azure.com/org/project/repo"],
  ["git@ssh.dev.azure.com:v3/org/project/repo", "dev.azure.com/org/project/repo"],
  ["https://org.visualstudio.com/DefaultCollection/project/_git/repo", "dev.azure.com/org/project/repo"],
];
const nrCode = `const e = await import(${JSON.stringify(pathToFileURL(path.join(HERE, "engine.mjs")).href)}); console.log(JSON.stringify(${JSON.stringify(NR.map((x) => x[0]))}.map((u) => e.normaliseRemote(u))));`;
const nr = spawnSync(process.execPath, ["--input-type=module", "-e", nrCode], { encoding: "utf8", env: envFor(A) });
let nrOut = [];
try { nrOut = JSON.parse(nr.stdout.trim()); } catch {}
check("remotes: ssh ports, GitLab subgroups and Azure DevOps each get one spelling", NR.every(([, want], i) => nrOut[i] === want), JSON.stringify(nrOut) + nr.stderr);

const P44 = "5a5a5a5a-0000-4000-8000-000000000001";
fs.writeFileSync(tpath(A, PA, P44), line("complete first line", PA, P44));
run(A, ["push", "--session", P44, "--cwd", PA]);
run(B, ["pull", P44, "--cwd", PB]);
const TB44p = path.join(B.claude, "projects", enc(PB), `${P44}.jsonl`);
fs.appendFileSync(TB44p, '{"type":"user","message":{"cont'); // a crash cut this line off
fs.appendFileSync(tpath(A, PA, P44), line("second line from A", PA, P44));
run(A, ["push", "--session", P44, "--cwd", PA]);
run(B, ["pull-all", "--json"]);
const lines44 = (fs.existsSync(TB44p) ? fs.readFileSync(TB44p, "utf8") : "").split("\n").filter(Boolean);
let last44 = null;
try { last44 = JSON.parse(lines44[2]).message.content; } catch {}
check("lines: entries added after a cut-off line stay whole", lines44.length === 3 && last44 === "second line from A", lines44.join("\n"));

// ---- 45. The app's contract: pull-all --skip, and the "app" edit field
const K45 = "6b6b6b6b-0000-4000-8000-000000000001";
fs.writeFileSync(tpath(A, PA, K45), line("app chat", PA, K45));
run(A, ["push", "--session", K45, "--cwd", PA]);
run(B, ["pull", K45, "--cwd", PB]);
fs.appendFileSync(tpath(A, PA, K45), line("newer from A", PA, K45));
run(A, ["push", "--session", K45, "--cwd", PA]);
const TB45 = path.join(B.claude, "projects", enc(PB), `${K45}.jsonl`);
const sk45 = jsonOf(run(B, ["pull-all", "--json", "--skip", `${K45},not-a-uuid`]));
const skipped45 = !has(TB45, "newer from A");
const nsk45 = jsonOf(run(B, ["pull-all", "--json"]));
check("app: pull-all --skip leaves the listed conversations alone", sk45?.ok === true && skipped45 && has(TB45, "newer from A"), JSON.stringify({ sk45, nsk45 }));
const app45 = jsonOf(run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: K45, field: "app", value: true }])]));
run(B, ["pull-all", "--json", "--no-local"]);
const lj45 = jsonOf(run(B, ["list", "--json"]));
check("app: the app field is an edit like the others, merged on every PC", app45?.pushed === true && lj45?.state?.[K45]?.app === true && lj45.sessions.find((s) => s.sessionId === K45)?.edits?.app === true, JSON.stringify(lj45?.state?.[K45]));

// ---- 46. Hooks name the tool from $HOME, so a Claude folder shared between PCs works on each
const HH = path.join(T, "pcH-home");
const HL = path.join(HH, "AppData", "Local");
const HS = path.join(HL, "claude-conversation-sync");
fs.mkdirSync(HS, { recursive: true });
gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, path.join(HS, "repo")], T);
fs.writeFileSync(path.join(HS, "config.json"), JSON.stringify({ remote: REMOTE, machine: "PC-H" }));
const envH = { ...baseEnv, USERPROFILE: HH, HOME: HH, LOCALAPPDATA: HL, CLAUDE_CONFIG_DIR: path.join(HH, ".claude") };
delete envH.CLAUDE_SYNC_HOME;
r = spawnSync(process.execPath, [path.join(HS, "repo", "_sync", "install.mjs")], { encoding: "utf8", env: envH });
const sH = readJsonT(path.join(HH, ".claude", "settings.json")) ?? { hooks: {} };
const cmdsH = Object.values(sH.hooks ?? {}).flat().flatMap((g) => g.hooks.map((h) => h.command));
const skillH = fs.existsSync(path.join(HH, ".claude", "skills", "push", "SKILL.md")) ? fs.readFileSync(path.join(HH, ".claude", "skills", "push", "SKILL.md"), "utf8") : "";
const TOOL_H = '"$HOME/AppData/Local/claude-conversation-sync/repo/_sync/sync.mjs"';
check("hooks: install names the tool from $HOME when it is in its usual place", r.status === 0 && cmdsH.length === 3 && cmdsH.every((c) => c.startsWith(`node ${TOOL_H} hook `)) && skillH.includes(TOOL_H), r.stdout + r.stderr + cmdsH.join("\n"));
const gitBash = (() => {
  if (process.platform !== "win32") return "sh";
  const ex = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const b = path.resolve(ex, "..", "..", "..", "bin", "bash.exe");
  return fs.existsSync(b) ? b : null;
})();
if (gitBash) {
  const whereCmd = String(cmdsH[0] ?? "").replace(/ hook session-start$/, " where");
  const msysHome = process.platform === "win32" ? `/${HH[0].toLowerCase()}${HH.slice(2).replace(/\\/g, "/")}` : HH;
  const outs = [HH, msysHome].map((home) => spawnSync(gitBash, ["-c", whereCmd], { encoding: "utf8", env: { ...envH, HOME: home } }));
  check("hooks: Git Bash (the shell Claude Code runs hooks in) finds this PC's own tool from $HOME", outs.every((o) => o.status === 0 && samePathT(o.stdout.trim(), HS)), outs.map((o) => `${o.status} ${o.stdout}${o.stderr}`).join("\n"));
}

// ---- 47. "Upload after a reply" can be 1, 2 or 5 minutes (Settings > Sync)
const q1 = jsonOf(run(A, ["config", "--json", "--set", "uploadQuietSeconds=60"]));
const q2 = jsonOf(run(A, ["config", "--json", "--set", "uploadQuietSeconds=45"]));
const q3 = jsonOf(run(A, ["config", "--json", "--set", "remote=https://example.com/other.git"]));
const q4 = jsonOf(run(A, ["status", "--json"]));
const cfgA = JSON.parse(fs.readFileSync(path.join(A.sync, "config.json"), "utf8"));
check("quiet period: only 60, 120 or 300 seconds can be set, and status reports it", q1?.ok === true && q1.config?.uploadQuietSeconds === 60 && q2?.ok === false && q3?.ok === false && cfgA.uploadQuietSeconds === 60 && cfgA.remote === REMOTE && q4?.uploadQuietSeconds === 60, JSON.stringify({ q1, q2, q3, q4: q4?.uploadQuietSeconds }));
const Q47 = "7c7c7c7c-0000-4000-8000-000000000001";
const TA47 = tpath(A, PA, Q47);
fs.writeFileSync(TA47, line("quiet period test", PA, Q47));
run(A, ["push", "--session", Q47, "--cwd", PA]);
// Last upload 55 s ago: with a 60 s quiet period the next one waits about 5 s. With the
// test default of 4 s it would go at once, and with 120 s it would wait 65 s.
const stPath = path.join(A.sync, "state.json");
const st47 = readJsonT(stPath) ?? { sessions: {} };
st47.sessions[Q47] = { ...(st47.sessions[Q47] || {}), pushedAt: new Date(Date.now() - 55_000).toISOString() };
fs.writeFileSync(stPath, JSON.stringify(st47, null, 2));
fs.appendFileSync(TA47, line("after the reply", PA, Q47));
const t47 = Date.now();
hook(A, "stop", { session_id: Q47, transcript_path: TA47, cwd: PA });
const wait47 = (readJsonT(stPath)?.sessions?.[Q47]?.scheduledUntil ?? 0) - t47;
check("quiet period: the Stop hook waits the chosen period after the last upload", wait47 > 2000 && wait47 < 7000 && !!waitFor(() => remoteFile("website", Q47)?.toString().includes("after the reply"), 30), `waits ${wait47} ms`);
run(A, ["config", "--json", "--set", "uploadQuietSeconds=120"]);

// ======================================================================
// Second review (11 Oct 2026): each check is named after the finding it covers.
// ======================================================================
const stateOf = (m) => readJsonT(path.join(m.sync, "state.json")) ?? { sessions: {} };
const aheadOf = (m) => sh("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: path.join(m.sync, "repo") }).stdout.trim();
const PROC_START = Math.round(Date.now() - process.uptime() * 1000);
// A lock held by a process that is running right now (this test), written as the engine writes it.
const liveLock = (m, extra = {}) =>
  fs.writeFileSync(path.join(m.sync, "repo.lock"), JSON.stringify({ pid: process.pid, at: Date.now(), start: PROC_START, exe: path.basename(process.execPath).toLowerCase(), up: Math.round(os.uptime()), ...extra }));
const copiesOn = (m, id) => listDir(path.join(m.claude, "projects")).filter((d) => fs.existsSync(path.join(m.claude, "projects", d, `${id}.jsonl`)));

// ---- 48. N4: a commit a conflict sets aside is uploaded again by the same sync
const V48 = "a4a4a4a4-0000-4000-8000-000000000001";
const TA48 = tpath(A, PA, V48);
fs.writeFileSync(TA48, line("V from A", PA, V48));
run(A, ["push", "--session", V48, "--cwd", PA]);
run(B, ["pull", V48, "--cwd", PB]);
fs.writeFileSync(prePush, "#!/bin/sh\nexit 1\n"); // GitHub refuses A's push for now
fs.appendFileSync(TA48, line("A committed but not pushed", PA, V48));
const r48 = run(A, ["push", "--session", V48, "--cwd", PA]);
fs.rmSync(prePush, { force: true });
const queued48 = aheadOf(A);
fs.appendFileSync(path.join(B.claude, "projects", enc(PB), `${V48}.jsonl`), line("B line on V", PB, V48));
run(B, ["push", "--session", V48, "--cwd", PB]);
const pp48 = jsonOf(run(A, ["push-pending", "--json"]));
const rem48 = remoteFile("website", V48)?.toString() ?? "";
check("N4: an upload committed but refused, then set aside by a conflict, goes up with push-pending", r48.status !== 0 && queued48 !== "0" && pp48?.ok === true && aheadOf(A) === "0" && rem48.includes("A committed but not pushed") && rem48.includes("B line on V") && !stateOf(A).sessions[V48]?.pending, JSON.stringify({ queued48, pp48 }) + rem48);
const U48 = "a4a4a4a4-0000-4000-8000-000000000002";
const TA48u = tpath(A, PA, U48);
fs.writeFileSync(TA48u, line("U from A", PA, U48));
run(A, ["push", "--session", U48, "--cwd", PA]);
run(B, ["pull", U48, "--cwd", PB]);
fs.renameSync(REMOTE, remoteAway);
fs.appendFileSync(TA48u, line("A offline line", PA, U48));
const off48 = run(A, ["push", "--session", U48, "--cwd", PA]);
fs.renameSync(remoteAway, REMOTE);
const waiting48 = stateOf(A).sessions[U48]?.pending;
fs.appendFileSync(path.join(B.claude, "projects", enc(PB), `${U48}.jsonl`), line("B line on U", PB, U48));
run(B, ["push", "--session", U48, "--cwd", PB]);
const pa48 = jsonOf(run(A, ["pull-all", "--json"]));
const rem48u = remoteFile("website", U48)?.toString() ?? "";
check("N4: an upload made offline goes up with the next pull-all, with no new reply needed", off48.status !== 0 && waiting48?.reason === "offline" && pa48?.ok === true && (pa48.reuploaded || []).includes(U48) && rem48u.includes("A offline line") && rem48u.includes("B line on U") && has(TA48u, "B line on U") && !stateOf(A).sessions[U48]?.pending, JSON.stringify({ waiting48, pa48 }) + rem48u);

// ---- 49. N7: a chat that ran in Claude Code itself, or that the app claims, is never skipped as scripted
const X49 = "a7a7a7a7-0000-4000-8000-000000000001";
const T49 = tpath(A, PA, X49);
fs.writeFileSync(T49, line("started through the SDK", PA, X49, { entrypoint: "sdk-ts" }));
run(A, ["push", "--auto", "--session", X49, "--transcript", T49, "--cwd", PA]); // a hook without the app's environment
const skip49 = stateOf(A).sessions[X49]?.skip;
fs.appendFileSync(T49, line("continued in the terminal", PA, X49, { entrypoint: "cli" }));
hook(A, "stop", { session_id: X49, transcript_path: T49, cwd: PA });
const up49 = !!waitFor(() => remoteFile("website", X49)?.toString().includes("continued in the terminal"), 30);
check("N7: a scripted run is skipped until it is carried on in Claude Code itself, then uploads", skip49 === "headless" && up49 && !stateOf(A).sessions[X49]?.skip, JSON.stringify(stateOf(A).sessions[X49]));
const Z49 = "a7a7a7a7-0000-4000-8000-000000000002";
const T49z = tpath(A, PA, Z49);
fs.writeFileSync(T49z, line("an app chat whose first upload did not happen", PA, Z49, { entrypoint: "sdk-ts" }));
run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: Z49, field: "app", value: true }])]);
const z49 = run(A, ["push", "--auto", "--session", Z49, "--transcript", T49z, "--cwd", PA]);
check("N7: a chat the app marked as its own is uploaded by any hook", !!remoteFile("website", Z49) && !stateOf(A).sessions[Z49]?.skip, z49.stdout + z49.stderr + JSON.stringify(stateOf(A).sessions[Z49]));

// ---- 50. N9: an upload that cannot get the lock is queued and retried, never lost
const S50 = "a9a9a9a9-0000-4000-8000-000000000001";
const T50 = tpath(A, PA, S50);
fs.writeFileSync(T50, line("first", PA, S50));
run(A, ["push", "--session", S50, "--cwd", PA]);
const before50 = jsonOf(run(A, ["status", "--json"]));
fs.appendFileSync(T50, line("written while a long download held the lock", PA, S50));
liveLock(A);
const b50 = run(A, ["push", "--auto", "--session", S50, "--transcript", T50, "--cwd", PA], { CLAUDE_SYNC_LOCK_WAIT_MS: "1500" });
const st50 = jsonOf(run(A, ["status", "--json"]));
fs.rmSync(path.join(A.sync, "repo.lock"), { force: true });
check("N9: a hook upload that cannot get the lock is queued, and status counts it as waiting", b50.status === 0 && stateOf(A).sessions[S50]?.pending?.reason === "busy" && st50?.pendingUploads === (before50?.pendingUploads ?? 0) + 1 && st50.unpushedCommits >= 1, JSON.stringify({ before: before50?.pendingUploads, p: st50?.pendingUploads, u: st50?.unpushedCommits }) + b50.stderr);
const pp50 = jsonOf(run(A, ["push-pending", "--json"]));
check("N9: push-pending uploads it once the lock is free", pp50?.ok === true && (pp50.reuploaded || []).includes(S50) && !!remoteFile("website", S50)?.toString().includes("written while a long download held the lock") && !stateOf(A).sessions[S50]?.pending, JSON.stringify(pp50));

// ---- 51. N11: flags without a value never take the next word
const j51 = jsonOf(run(B, ["pull", "--json", ID, "--cwd", PB]));
check("N11: pull --json <id> pulls that conversation, not the folder's newest", j51?.ok === true && j51.id === ID, JSON.stringify(j51));

// ---- 52. N12: install never replaces the first settings backup, and never runs git under a sync
const SH = path.join(HH, ".claude", "settings.json");
const bakFirst = `${SH}.backup-before-conversation-sync`;
const installH = (extra = {}) => spawnSync(process.execPath, [path.join(HS, "repo", "_sync", "install.mjs")], { encoding: "utf8", env: { ...envH, ...extra } });
const backupsH = () => listDir(path.join(HH, ".claude")).filter((f) => f.startsWith("settings.json.backup-"));
const v2Settings = (tag) => JSON.stringify({ model: `keep-${tag}`, hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${HS.replace(/\\/g, "/")}/repo/_sync/sync.mjs" hook stop`, timeout: 15 }] }] } }, null, 2);
fs.rmSync(bakFirst, { force: true });
fs.writeFileSync(SH, v2Settings("one"));
const i52a = installH();
const bak52 = fs.existsSync(bakFirst) ? fs.readFileSync(bakFirst, "utf8") : "";
const i52b = installH();
const after52b = backupsH();
fs.writeFileSync(SH, v2Settings("two"));
const i52c = installH();
const after52c = backupsH();
const dated52 = after52c.filter((f) => f !== path.basename(bakFirst));
check("N12: running install again never replaces the first settings backup", i52a.status === 0 && i52b.status === 0 && bak52.includes("keep-one") && fs.readFileSync(bakFirst, "utf8") === bak52 && after52b.length === 1, after52b.join(", ") + i52b.stdout + i52b.stderr);
check("N12: a later change to the settings gets a dated backup of its own", i52c.status === 0 && dated52.length === 1 && fs.readFileSync(path.join(HH, ".claude", dated52[0]), "utf8").includes("keep-two") && readJsonT(SH)?.model === "keep-two", after52c.join(", "));
const other52 = path.join(T, "other52");
gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, other52], T);
fs.writeFileSync(path.join(other52, "n12.txt"), "a newer version on GitHub\n");
gitq(["add", "."], other52);
gitq(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "n12"], other52);
gitq(["push", "-q", "origin", "HEAD"], other52);
const headH = () => sh("git", ["rev-parse", "HEAD"], { cwd: path.join(HS, "repo") }).stdout.trim();
const head52 = headH();
liveLock({ sync: HS });
const i52d = installH({ CLAUDE_SYNC_LOCK_WAIT_MS: "1500" });
const heldHead52 = headH();
fs.rmSync(path.join(HS, "repo.lock"), { force: true });
const i52e = installH();
check("N12: install waits for a sync that is running and never pulls under it", i52d.status !== 0 && /still running/i.test(i52d.stdout + i52d.stderr) && heldHead52 === head52 && i52e.status === 0 && headH() !== head52 && fs.existsSync(path.join(HS, "repo", "n12.txt")), i52d.stdout + i52d.stderr + i52e.stdout + i52e.stderr);

// ---- 53. N14: a lock is respected only while the process that took it still holds it
const tryEdit53 = () => jsonOf(run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: ID, field: "pinned", value: true }])], { CLAUDE_SYNC_LOCK_WAIT_MS: "1500" }));
liveLock(A, { up: Math.round(os.uptime()) + 100_000 }); // taken before the PC last started
const e53a = tryEdit53();
liveLock(A, { at: Date.now() - 20 * 60_000, start: PROC_START - 3_600_000 }); // the id now belongs to a process that started later
const e53b = tryEdit53();
liveLock(A, { at: Date.now() - 20 * 60_000, exe: "notepad.exe" }); // ... or to another program
const e53c = tryEdit53();
liveLock(A, { at: Date.now() - 20 * 60_000 }); // still its own process, after a long time
const e53d = tryEdit53();
fs.rmSync(path.join(A.sync, "repo.lock"), { force: true });
check("N14: a lock taken before the PC restarted is taken over", e53a?.ok === true, JSON.stringify(e53a));
check("N14: a lock whose process id now belongs to another process is taken over", e53b?.ok === true && e53c?.ok === true, JSON.stringify({ e53b, e53c }));
check("N14: a lock its own process still holds is respected, however long", e53d?.ok === false && e53d.code === "busy", JSON.stringify(e53d));

// ---- 54. N5: a project folder that only holds downloaded conversations is still this PC's
const N5DIR = path.join(T, "pcB-work", "n5 project"); // a folder on this PC; no conversation was ever written from it
fs.mkdirSync(N5DIR, { recursive: true });
const N5ID = "a5a5a5a5-0000-4000-8000-000000000005";
const TA54 = tpath(A, PA, N5ID);
fs.writeFileSync(TA54, line("written on A", PA, N5ID));
run(A, ["push", "--session", N5ID, "--cwd", PA]);
const n5Folder = path.join(B.claude, "projects", enc(N5DIR));
fs.mkdirSync(n5Folder, { recursive: true });
const n5Copy = path.join(n5Folder, `${N5ID}.jsonl`);
fs.copyFileSync(TA54, n5Copy); // downloaded here earlier: every line in it was written on A
fs.appendFileSync(TA54, line("newer on A", PA, N5ID));
run(A, ["push", "--session", N5ID, "--cwd", PA]);
const pa54 = jsonOf(run(B, ["pull-all", "--json"]));
check("N5: a folder holding only downloaded conversations is updated in place, with no second copy", has(n5Copy, "newer on A") && copiesOn(B, N5ID).length === 1, JSON.stringify({ pa54, copies: copiesOn(B, N5ID) }));
// New downloads also go into such a folder when it is the only one this PC has for the project.
const PC54 = project("pcC-work/n5-only/site54", "https://github.com/sam/site54");
const C54 = pc("pcC54");
run(C54, ["setup", "--remote", REMOTE, "--machine", "PC-C54"]);
const D54a = "a5a5a5a5-0000-4000-8000-000000000054";
const D54b = "a5a5a5a5-0000-4000-8000-000000000055";
const PA54 = project("pcA-work/site54", "https://github.com/sam/site54");
fs.writeFileSync(tpath(A, PA54, D54a), line("first site54 chat", PA54, D54a));
run(A, ["push", "--session", D54a, "--cwd", PA54]);
const c54Folder = path.join(C54.claude, "projects", enc(PC54));
fs.mkdirSync(c54Folder, { recursive: true });
fs.copyFileSync(tpath(A, PA54, D54a), path.join(c54Folder, `${D54a}.jsonl`)); // only lines written on A
fs.writeFileSync(tpath(A, PA54, D54b), line("second site54 chat", PA54, D54b));
run(A, ["push", "--session", D54b, "--cwd", PA54]);
const pc54 = jsonOf(run(C54, ["pull-all", "--json"]));
check("N5: new conversations download into a project folder that only holds downloaded ones", has(path.join(c54Folder, `${D54b}.jsonl`), "second site54 chat"), JSON.stringify(pc54));

// ======================================================================
// Third review (11 Oct 2026): state writes, stranded uploads and commits.
// ======================================================================
const ENGINE_URL = pathToFileURL(path.join(HERE, "engine.mjs")).href;

// ---- 55. state.json: three processes writing 300 updates each lose nothing and never crash
const S55 = pc("pcS55");
fs.mkdirSync(S55.sync, { recursive: true });
fs.writeFileSync(path.join(S55.sync, "config.json"), JSON.stringify({ remote: REMOTE, machine: "PC-S55" }));
fs.writeFileSync(path.join(S55.sync, "state.json"), JSON.stringify({ sessions: { keep: { pushedAt: "x" } } }));
const N55 = 300;
const P55 = "55555555-0000-4000-8000-000000000055";
const child55 = `const e = await import(${JSON.stringify(ENGINE_URL)}); const key = process.argv[1]; let errs = 0;
for (let i = 0; i < ${N55}; i++) { try { if (key === "pending") e.markPending(${JSON.stringify(P55)}, { transcript: "t", cwd: "c", reason: "r" + i }); else e.patchSession(key, { n: i }); } catch (err) { errs++; } }
console.log(errs);`;
const kids55 = await Promise.all(
  ["sess-A", "sess-B", "pending"].map(
    (k) =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", child55, k], { env: envFor(S55) });
        let o = "";
        let e = "";
        c.stdout.on("data", (d) => (o += d));
        c.stderr.on("data", (d) => (e += d));
        c.on("close", () => resolve({ k, errs: Number(o.trim()), stderr: e }));
      }),
  ),
);
const st55 = readJsonT(path.join(S55.sync, "state.json")) ?? { sessions: {} };
check("state: three processes writing at once lose no update", st55.sessions["sess-A"]?.n === N55 - 1 && st55.sessions["sess-B"]?.n === N55 - 1 && st55.sessions[P55]?.pending?.reason === `r${N55 - 1}` && st55.sessions.keep?.pushedAt === "x", JSON.stringify(st55.sessions));
check("state: no writer ever fails on a rename over an open file", kids55.every((k) => k.errs === 0 && !k.stderr), JSON.stringify(kids55));

// ---- 56. install: a conflict found during the upgrade keeps the stranded upload for the next sync
const I56 = pc("pcI56");
const HI = path.join(T, "pcI56-home");
const HIL = path.join(HI, "AppData", "Local");
const HIS = path.join(HIL, "claude-conversation-sync");
fs.mkdirSync(HIS, { recursive: true });
gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, path.join(HIS, "repo")], T);
gitq(["config", "user.name", "i"], path.join(HIS, "repo"));
gitq(["config", "user.email", "i@i"], path.join(HIS, "repo"));
fs.writeFileSync(path.join(HIS, "config.json"), JSON.stringify({ remote: REMOTE, machine: "PC-I56" }));
const PI56 = path.join(HI, "work", "website");
fs.mkdirSync(PI56, { recursive: true });
gitq(["init", "-q"], PI56);
gitq(["remote", "add", "origin", "https://github.com/Acme/Website"], PI56);
const envI = { ...baseEnv, USERPROFILE: HI, HOME: HI, LOCALAPPDATA: HIL, CLAUDE_CONFIG_DIR: path.join(HI, ".claude"), CLAUDE_SYNC_LIVE_WINDOW_MS: "1" };
delete envI.CLAUDE_SYNC_HOME;
const runI = (args, input) => spawnSync(process.execPath, [path.join(HIS, "repo", "_sync", "sync.mjs"), ...args], { encoding: "utf8", input, env: envI });
const X56 = "56565656-0000-4000-8000-000000000056";
const TI56 = path.join(HI, ".claude", "projects", enc(PI56), `${X56}.jsonl`);
fs.mkdirSync(path.dirname(TI56), { recursive: true });
fs.writeFileSync(TI56, line("X first on I", PI56, X56));
runI(["push", "--session", X56, "--cwd", PI56]);
run(B, ["pull", X56, "--cwd", PB]);
// GitHub refuses the push: the upload is committed on I but stranded. Then B changes the chat.
const deny56 = path.join(REMOTE, "hooks", "pre-receive");
fs.writeFileSync(deny56, "#!/bin/sh\nexit 1\n");
fs.appendFileSync(TI56, line("stranded line on I", PI56, X56));
runI(["push", "--session", X56, "--cwd", PI56]);
fs.unlinkSync(deny56);
fs.appendFileSync(path.join(B.claude, "projects", enc(PB), `${X56}.jsonl`), line("B meanwhile", PB, X56));
run(B, ["push", "--session", X56, "--cwd", PB]);
// A wedged rebase, as an older engine left it, with no pending marker in state.json.
const reb56 = sh("git", ["pull", "--rebase", "-q"], { cwd: path.join(HIS, "repo"), allowFail: true });
const stI = readJsonT(path.join(HIS, "state.json")) ?? { sessions: {} };
delete stI.sessions[X56]?.pending;
fs.writeFileSync(path.join(HIS, "state.json"), JSON.stringify(stI));
const i56 = spawnSync(process.execPath, [path.join(HIS, "repo", "_sync", "install.mjs")], { encoding: "utf8", env: envI });
const pend56 = readJsonT(path.join(HIS, "state.json"))?.sessions?.[X56]?.pending;
const pp56 = jsonOf(runI(["push-pending", "--json"]));
const rem56 = remoteFile("website", X56)?.toString() ?? "";
check("install: a conflict found during the upgrade marks the stranded upload as waiting", reb56.status !== 0 && i56.status === 0 && pend56?.reason === "conflict", i56.stdout + i56.stderr + JSON.stringify(pend56));
check("install: ...and the next sync uploads it", pp56?.ok === true && rem56.includes("stranded line on I") && rem56.includes("B meanwhile"), JSON.stringify(pp56) + rem56);

// ---- 57. an upload that throws is remembered as waiting
const X57 = "57575757-0000-4000-8000-000000000057";
const TA57 = tpath(A, PA, X57);
fs.writeFileSync(TA57, line("X first", PA, X57));
run(A, ["push", "--session", X57, "--cwd", PA]);
fs.appendFileSync(TA57, line("X second", PA, X57));
// On GitHub, a folder sits where the conversation's meta.json should be (committed, so a
// clean-up of the working copy keeps it): writing the file throws in the middle of the upload.
const evil57 = path.join(T, "evil57");
fs.rmSync(evil57, { recursive: true, force: true });
gitq(["-c", "core.longpaths=true", "clone", "-q", REMOTE, evil57], T);
const metaDir57 = path.join(evil57, "website", X57, "meta.json");
fs.rmSync(metaDir57, { force: true });
fs.mkdirSync(metaDir57);
fs.writeFileSync(path.join(metaDir57, "x"), "x");
gitq(["add", "-A"], evil57);
gitq(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "meta.json is a folder"], evil57);
gitq(["push", "-q", "origin", "HEAD"], evil57);
const r57 = run(A, ["push", "--auto", "--session", X57, "--transcript", TA57, "--cwd", PA]);
const pend57 = stateOf(A).sessions[X57]?.pending;
fs.rmSync(metaDir57, { recursive: true, force: true });
gitq(["add", "-A"], evil57);
gitq(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "meta.json removed"], evil57);
gitq(["push", "-q", "origin", "HEAD"], evil57);
const pp57 = jsonOf(run(A, ["push-pending", "--json"]));
check("upload: an upload that throws is remembered and uploaded by the next sync", r57.status === 0 && pend57?.reason === "failed" && pp57?.ok === true && !!remoteFile("website", X57)?.toString().includes("X second"), r57.stderr + JSON.stringify({ pend57, pp57 }));

// ---- 58. a commit left between "git commit" and "git push" is pushed by any sync
const X58 = "58585858-0000-4000-8000-000000000058";
const TA58 = tpath(A, PA, X58);
fs.writeFileSync(TA58, line("X first", PA, X58));
run(A, ["push", "--session", X58, "--cwd", PA]);
fs.appendFileSync(TA58, line("X second, crash after commit", PA, X58));
const stBefore58 = fs.readFileSync(stPath, "utf8");
fs.writeFileSync(deny56, "#!/bin/sh\nexit 1\n");
run(A, ["push", "--session", X58, "--cwd", PA]);
fs.unlinkSync(deny56);
fs.writeFileSync(stPath, stBefore58); // what a crash right after "git commit" leaves: no marker at all
const setup58 = aheadOf(A) === "1";
run(A, ["pull-all", "--json"]);
const afterPullAll58 = aheadOf(A);
fs.appendFileSync(TA58, line("X third, crash again", PA, X58));
fs.writeFileSync(deny56, "#!/bin/sh\nexit 1\n");
run(A, ["push", "--session", X58, "--cwd", PA]);
fs.unlinkSync(deny56);
fs.writeFileSync(stPath, stBefore58);
hook(A, "session-start", { session_id: "58585858-0000-4000-8000-000000000059", cwd: PA, source: "startup" });
const afterStart58 = waitFor(() => (aheadOf(A) === "0" ? "0" : null), 20);
check("stranded commit: pull-all pushes it", setup58 && afterPullAll58 === "0" && !!remoteFile("website", X58)?.toString().includes("crash after commit"), `${setup58} ${afterPullAll58}`);
check("stranded commit: a session start's background worker pushes it", afterStart58 === "0" && !!remoteFile("website", X58)?.toString().includes("crash again"), aheadOf(A));

// ---- 59. a transcript dated in the future (the clock was set back) is not live for ever
const X59 = "59595959-0000-4000-8000-000000000059";
fs.writeFileSync(tpath(A, PA, X59), line("X from A", PA, X59));
run(A, ["push", "--session", X59, "--cwd", PA]);
run(B, ["pull", X59, "--cwd", PB]);
const TB59 = path.join(B.claude, "projects", enc(PB), `${X59}.jsonl`);
const future = new Date(Date.now() + 2 * 3600_000);
fs.utimesSync(TB59, future, future);
fs.appendFileSync(tpath(A, PA, X59), line("newer on A", PA, X59));
run(A, ["push", "--session", X59, "--cwd", PA]);
const pa59 = jsonOf(run(B, ["pull-all", "--json"], { CLAUDE_SYNC_LIVE_WINDOW_MS: "120000" }));
check("live: a transcript dated hours in the future is not treated as live", has(TB59, "newer on A") && !pa59?.skippedLive?.includes(X59), JSON.stringify(pa59));

// ---- shared rules: one file every chat on every PC reads
{
  const rulesA = path.join(A.sync, "repo", "_shared", "CLAUDE.md");
  fs.mkdirSync(path.dirname(rulesA), { recursive: true });
  fs.writeFileSync(rulesA, "# Rules\n\nAlways start Chrome yourself.\n");
  const st1 = jsonOf(run(A, ["rules", "--json"]));
  check("rules: status sees an edit that is not on GitHub yet", st1?.ok && st1.modified && st1.path.endsWith(path.join("_shared", "CLAUDE.md")), JSON.stringify(st1));
  const up = jsonOf(run(A, ["rules", "--push", "--json"]));
  const st2 = jsonOf(run(A, ["rules", "--json"]));
  check("rules: --push uploads it, and status is then clean", up?.ok && !up.nothing && st2?.ok && !st2.modified && !st2.unpushed, JSON.stringify({ up, st2 }));
  // Any sync on the other PC brings it: here a pull-all (a session start does the same in the background).
  const r60 = jsonOf(run(B, ["pull-all", "--json"]));
  const rulesB = path.join(B.sync, "repo", "_shared", "CLAUDE.md");
  check("rules: the other PC has the file after its next sync", r60?.ok && fs.existsSync(rulesB) && fs.readFileSync(rulesB, "utf8").includes("start Chrome"), JSON.stringify({ r60, up, exists: fs.existsSync(rulesB) }));
  // An edit goes up with an ordinary upload too, with no separate step.
  fs.mkdirSync(path.dirname(rulesB), { recursive: true });
  fs.appendFileSync(rulesB, "\nNever use em dashes.\n");
  const X60 = "66666666-7777-8888-9999-bbbbbbbbbbbb";
  fs.writeFileSync(tpath(B, PB, X60), line("rules ride along", PB, X60));
  run(B, ["push", "--session", X60, "--cwd", PB]);
  run(A, ["pull-all", "--json"]);
  check("rules: an edit rides along with the next conversation upload", fs.readFileSync(rulesA, "utf8").includes("em dashes"), fs.readFileSync(rulesA, "utf8"));
  check("rules: the _shared folder is never read as a project", !jsonOf(run(A, ["list", "--json"]))?.sessions?.some((s) => s.key === "_shared"));
  // The installer adds the import line to the global CLAUDE.md once.
  const globalH = path.join(HH, ".claude", "CLAUDE.md");
  const i60a = installH();
  const i60b = installH();
  const text60 = fs.existsSync(globalH) ? fs.readFileSync(globalH, "utf8") : "";
  const importLines = text60.split("\n").filter((l) => l.startsWith("@") && l.includes("_shared/CLAUDE.md"));
  check("rules: install adds one import line to the global CLAUDE.md, and only once", i60a.status === 0 && i60b.status === 0 && importLines.length === 1 && text60.includes("# Rules shared with my other PCs"), text60 + i60a.stderr + i60b.stderr);
  check("rules: the import names the file from ~ so it works under any user name", importLines[0]?.startsWith("@~/") || importLines[0]?.startsWith("@/") || /^@[A-Za-z]:\//.test(importLines[0] ?? ""), importLines[0] ?? "");
}

// ---- 60b. deleting a conversation the Conversations app just wrote to (and closed)
{
  const D62 = "62626262-0000-4000-8000-000000000062";
  fs.writeFileSync(tpath(A, PA, D62), line("written by the app just now", PA, D62));
  run(A, ["push", "--session", D62, "--cwd", PA]);
  const del = (extra = [], env = {}) => jsonOf(run(A, ["edit", "--json", "--ops", JSON.stringify([{ session: D62, field: "deleted", value: true }]), ...extra], env));
  // The two-minute "written just now" check is off in these tests unless asked for.
  const plainDel = del([], { CLAUDE_SYNC_LIVE_WINDOW_MS: "120000" });
  check("delete: refused right after a write (something may still have it open)", plainDel && !plainDel.ok && plainDel.code === "live", JSON.stringify(plainDel));
  // A Claude Code process that still has it open (its session file, a live pid) always stops it.
  const sessions = path.join(A.claude, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const held = path.join(sessions, `${process.pid}.json`);
  fs.writeFileSync(held, JSON.stringify({ pid: process.pid, sessionId: D62 }));
  const heldDel = del(["--written-by", String(Date.now())]);
  check("delete: --written-by still refuses while a Claude Code process has it open", heldDel && !heldDel.ok && heldDel.code === "live", JSON.stringify(heldDel));
  fs.rmSync(held, { force: true });
  // Written after the app closed it (a terminal): still refused.
  const closedAt = Date.now() - 10_000;
  const laterDel = del(["--written-by", String(closedAt)], { CLAUDE_SYNC_LIVE_WINDOW_MS: "120000" });
  check("delete: a write after the app closed it still stops it", laterDel && !laterDel.ok && laterDel.code === "live", JSON.stringify(laterDel));
  // Only the app's own writes (before it closed it): deleted, the two-minute check on.
  const okDel = del(["--written-by", String(Date.now())], { CLAUDE_SYNC_LIVE_WINDOW_MS: "120000" });
  check("delete: when only the app wrote to it (before closing it), it deletes", okDel?.ok === true, JSON.stringify(okDel));
}

// ---- 61. workspaces: --sync-home, and the shared list of workspaces
{
  // A hook names its folder with an argument: it wins over the environment, in any shell.
  const other = path.join(T, "ws-sync-home");
  const w61 = run(A, ["where", "--sync-home", other]);
  check("workspaces: --sync-home chooses the sync folder", w61.stdout.trim() === other, w61.stdout + w61.stderr);
  // Two PCs add different workspaces at once: both are kept, one file each.
  const s1 = jsonOf(run(A, ["share-workspace", "--id", "work", "--name", "Work", "--remote", "https://github.com/you/work-conversations", "--json"]));
  const s2 = jsonOf(run(B, ["share-workspace", "--id", "other", "--name", "Other", "--remote", "https://github.com/you/other-conversations", "--json"]));
  run(A, ["pull-all", "--json"]);
  run(B, ["pull-all", "--json"]);
  const dirOf = (m) => path.join(m.sync, "repo", "_shared", "workspaces");
  const names = (m) => (fs.existsSync(dirOf(m)) ? fs.readdirSync(dirOf(m)).sort().join(",") : "");
  check("workspaces: two PCs sharing different workspaces keep both", s1?.ok && s2?.ok && names(A) === "other.json,work.json" && names(B) === "other.json,work.json", JSON.stringify({ s1, s2, a: names(A), b: names(B) }));
  const y = JSON.parse(fs.readFileSync(path.join(dirOf(B), "work.json"), "utf8"));
  check("workspaces: an entry holds its id, name and repository", y.id === "work" && y.name === "Work" && y.remote === "https://github.com/you/work-conversations", JSON.stringify(y));
  const bad = jsonOf(run(A, ["share-workspace", "--id", "../x", "--name", "X", "--remote", "https://github.com/you/x", "--json"]));
  check("workspaces: an id that isn't a plain name is refused", bad && !bad.ok && !fs.existsSync(path.join(T, "pcA", "sync", "repo", "_shared", "x.json")), JSON.stringify(bad));
  check("workspaces: the _shared folder is still never read as a project", !jsonOf(run(A, ["list", "--json"]))?.sessions?.some((s) => s.key === "_shared"));
}

for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : `\n      ${String(x.detail).trim().slice(0, 500).replace(/\n/g, "\n      ")}`}`);
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`);
