// When GitHub refuses this PC's login. Real git against a local server behind a login, with
// this PC's usual way of signing in (the global git config) stood in for by one that gives
// nothing, as `gh` does when it is on another account. Touches nothing outside a temp folder.
// Run: node test-login.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "sync.mjs");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "sync-login-"));
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
const fwd = (p) => p.replace(/\\/g, "/");

const srv = path.join(T, "srv");
const bare = path.join(srv, "chats.git");
fs.mkdirSync(srv, { recursive: true });
spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
const seed = path.join(T, "seed");
spawnSync("git", ["init", "-q", "-b", "main", seed]);
fs.writeFileSync(path.join(seed, "README.md"), "chats\n");
spawnSync("git", ["-C", seed, "add", "-A"]);
spawnSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "start"]);
spawnSync("git", ["-C", seed, "push", "-q", bare, "main"]);

const readOnly = path.join(T, "read-only");
const server = spawn(process.execPath, [path.join(HERE, "fixtures", "git-http-server.mjs"), srv, "me", "right-password", readOnly], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((resolve) => server.stdout.once("data", (d) => resolve(String(d).trim())));
const base = `http://127.0.0.1:${port}`;
const remote = `${base}/chats.git`;

// This PC's usual way of signing in: it gives nothing. The login "saved in Windows": gives
// the right one only while its file says so, and notes how it was asked.
const global = path.join(T, "gitconfig");
const globalText = `[credential "${base}"]\n\tusername = me\n\thelper =\n\thelper = \"!f() { exit 0; }; f\"\n[user]\n\tname = t\n\temail = t@example.com\n`;
fs.writeFileSync(global, globalText);
const allow = path.join(T, "allow");
const asked = path.join(T, "asked");
const expired = path.join(T, "expired");
const login = path.join(T, "login.cjs");
fs.writeFileSync(
  login,
  `const fs = require("fs");
if (process.argv[2] === "get") {
  fs.appendFileSync(${JSON.stringify(asked)}, (process.env.GCM_INTERACTIVE || "-") + "\\n");
  if (fs.existsSync(${JSON.stringify(expired)})) process.stdout.write("username=me\\npassword=old-password\\n");
  else if (fs.existsSync(${JSON.stringify(allow)})) process.stdout.write("username=me\\npassword=right-password\\n");
}
if (process.argv[2] === "erase") fs.rmSync(${JSON.stringify(expired)}, { force: true });
`,
);
const helper = `!node "${fwd(login)}"`;

const sync = path.join(T, "sync");
const repo = path.join(sync, "repo");
fs.mkdirSync(sync, { recursive: true });
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: global,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "not-from-the-engine",
  CLAUDE_SYNC_HOME: sync,
  CLAUDE_CONFIG_DIR: path.join(T, ".claude"),
  CLAUDE_SYNC_TEST_LOGIN_HELPER: helper,
};
delete env.CLAUDE_SYNC_DISABLE;
fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
const key = `credential.${base}.helper`;
const cloned = spawnSync("git", ["-c", `${key}=`, "-c", `${key}=!f() { echo username=me; echo password=right-password; }; f`, "clone", "-q", remote, repo], { env, encoding: "utf8" });
check("the local server stands in for GitHub", cloned.status === 0, cloned.stderr);
fs.writeFileSync(path.join(sync, "config.json"), JSON.stringify({ remote, machine: "Test PC" }));

const runWith = (extra, ...args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { ...env, ...extra }, encoding: "utf8", windowsHide: true });
  try {
    return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
  } catch {
    return { ok: false, unreadable: r.stdout + r.stderr };
  }
};
const run = (...args) => runWith({}, ...args);
const pin = () => spawnSync("git", ["-C", repo, "config", "--local", "--get-all", key], { env, encoding: "utf8" }).stdout.split(/\r?\n/).filter((l, i, a) => i < a.length - 1);
const plainGit = (...a) => spawnSync("git", ["-C", repo, ...a], { env, encoding: "utf8" });
const log = () => (fs.existsSync(path.join(sync, "sync.log")) ? fs.readFileSync(path.join(sync, "sync.log"), "utf8") : "");
const askedLines = () => (fs.existsSync(asked) ? fs.readFileSync(asked, "utf8").trim().split("\n") : []);
const askedCount = () => askedLines().length;
const goodGlobal = `[credential "${base}"]\n\tusername = me\n\thelper =\n\thelper = \"!f() { echo username=me; echo password=right-password; }; f\"\n[user]\n\tname = t\n\temail = t@example.com\n`;
const seedGit = (...a) => spawnSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
/** Another PC uploads, straight to the server. */
const elsewhere = (file, text) => {
  seedGit("fetch", "-q", bare, "main");
  seedGit("reset", "-q", "--hard", "FETCH_HEAD");
  fs.writeFileSync(path.join(seed, file), text);
  seedGit("add", "-A");
  seedGit("commit", "-q", "-m", "from another PC");
  seedGit("push", "-q", bare, "HEAD:main");
};
const unpin = () => spawnSync("git", ["-C", repo, "config", "--local", "--unset-all", key], { env });

try {
  // The failure as it happens.
  const refused = plainGit("ls-remote", "origin");
  check("the failure is the real one", refused.status !== 0 && /could not read Password/.test(refused.stderr), refused.stderr);

  // No login anywhere: it says so, and changes nothing.
  let r = run("check", "--json");
  check("no login to fall back on: reported as a sign-in problem, not as offline", r.ok === false && r.code === "auth" && !r.offline, JSON.stringify(r));
  check("...and nothing is pinned", pin().length === 0, JSON.stringify(pin()));

  // A login saved in Windows: the sync moves to it by itself.
  fs.writeFileSync(allow, "");
  r = run("check", "--json");
  check("a saved login: the sync repairs itself and carries on", r.ok === true, JSON.stringify(r));
  check("...for this repository only", JSON.stringify(pin()) === JSON.stringify(["", helper]), JSON.stringify(pin()));
  check("...and the PC's own git settings are left alone", fs.readFileSync(global, "utf8") === globalText);
  check("...and says what it did", /usual GitHub login/.test(log()));
  check("...and only ever looked in the background, with no window", askedCount() > 0 && askedLines().every((l) => l === "never"), askedLines().join(","));

  // It stays repaired, for anything using this repository.
  check("plain git in the repository now works", plainGit("ls-remote", "origin").status === 0);
  plainGit("commit", "-q", "--allow-empty", "-m", "a change");
  const pushed = plainGit("push", "-q", "origin", "main");
  check("uploads work too", pushed.status === 0, pushed.stderr);
  const lines = log().split("\n").length;
  r = run("check", "--json");
  check("a later run needs no repair", r.ok === true && log().split("\n").length === lines, JSON.stringify(r));

  // The saved login stops working: asked once per run, no loop, a sign-in problem again.
  fs.rmSync(allow);
  const before = askedCount();
  r = run("check", "--json");
  check("a login that stops working: a sign-in problem again", r.ok === false && r.code === "auth", JSON.stringify(r));
  check("...asked once, not over and over", askedCount() - before === 1, `${askedCount() - before} asks`);
  check("...and it stays where it was", JSON.stringify(pin()) === JSON.stringify(["", helper]), JSON.stringify(pin()));

  // Refused there, while the PC's own login works again: back to that.
  fs.writeFileSync(global, goodGlobal);
  r = run("check", "--json");
  check("a saved login refused while the PC's own works: back to that", r.ok === true && pin().length === 0, JSON.stringify([r, pin()]));
  check("...and says so", /back on this PC's usual GitHub login/.test(log()));
  fs.writeFileSync(global, globalText);

  // A login that can read but not upload isn't one to move to.
  fs.writeFileSync(allow, "");
  fs.writeFileSync(readOnly, "");
  r = run("check", "--json");
  check("a saved login that can only read: not moved to", r.ok === false && r.code === "auth" && pin().length === 0, JSON.stringify([r, pin()]));
  fs.rmSync(allow);

  // Set by hand: left alone in the background.
  spawnSync("git", ["-C", repo, "config", "--local", "--add", key, "!f() { exit 0; }; f"], { env });
  fs.rmSync(readOnly);
  fs.writeFileSync(allow, "");
  const set = pin();
  r = run("check", "--json");
  check("a login set by hand for this repository is left alone", r.ok === false && JSON.stringify(pin()) === JSON.stringify(set), JSON.stringify([r, pin()]));
  unpin();
  fs.rmSync(allow);

  // Signing in from the app.
  fs.rmSync(asked, { force: true });
  r = run("signin", "--json");
  check("a sign-in that doesn't finish says so and pins nothing", r.ok === false && /didn't finish/.test(r.err) && pin().length === 0, JSON.stringify(r));
  check("...and closing the window doesn't open it again", askedCount() === 1, `${askedCount()} asks`);
  fs.writeFileSync(allow, "");
  fs.writeFileSync(readOnly, "");
  fs.rmSync(asked, { force: true });
  r = run("signin", "--json");
  check("signing in with an account that can only read says that", r.ok === false && /can't upload/.test(r.err) && pin().length === 0, JSON.stringify(r));
  fs.rmSync(readOnly);
  r = runWith({ CLAUDE_SYNC_TEST_LOGIN_HELPER: "no-such-helper" }, "signin", "--json");
  check("no Git Credential Manager on the PC says that", r.ok === false && /no Git Credential Manager/.test(r.err) && pin().length === 0, JSON.stringify(r));
  fs.rmSync(asked, { force: true });
  r = run("signin", "--json");
  check("a sign-in that finishes pins the login", r.ok === true && JSON.stringify(pin()) === JSON.stringify(["", helper]), JSON.stringify(r));
  check("...and is the one kind of request allowed to open a window", askedLines()[0] === "true", askedLines().join(","));
  check("...and the check passes afterwards", run("check", "--json").ok === true);
  unpin();
  fs.writeFileSync(expired, "");
  r = run("signin", "--json");
  check("a saved login that has expired: dropped, and the second try signs in", r.ok === true && !fs.existsSync(expired), JSON.stringify(r));
  unpin();
  elsewhere("from-elsewhere.txt", "1");
  r = run("signin", "--json");
  check("being behind GitHub doesn't count against the login", r.ok === true, JSON.stringify(r));
  unpin();
  fs.rmSync(allow);

  // A chat's title reading like a login problem, on a PC with nothing wrong. Its commit's subject is in git's error.
  fs.writeFileSync(global, goodGlobal);
  plainGit("fetch", "-q", "origin");
  plainGit("reset", "-q", "--hard", "origin/main");
  elsewhere("clash.txt", "theirs");
  fs.writeFileSync(path.join(repo, "clash.txt"), "ours");
  plainGit("add", "-A");
  plainGit("commit", "-q", "-m", "Update x: Fix authentication failed on push (Test PC)");
  plainGit("fetch", "-q", "origin");
  const rebase = plainGit("rebase", "origin/main");
  check("git's error does quote the title", /authentication failed/i.test(rebase.stderr), rebase.stderr);
  plainGit("rebase", "--abort");
  const logBefore = log();
  fs.writeFileSync(allow, "");
  fs.rmSync(asked, { force: true });
  r = run("push-pending", "--json");
  check("such a title doesn't look like a login problem", r.code !== "auth" && pin().length === 0 && askedCount() === 0, JSON.stringify([r, pin()]));
  check("...and starts no repair", log().slice(logBefore.length).search(/usual GitHub login/) < 0);
  fs.writeFileSync(global, globalText);

  // Allowed to read but not to upload.
  plainGit("fetch", "-q", "origin");
  plainGit("commit", "-q", "--allow-empty", "-m", "waiting to upload");
  fs.writeFileSync(readOnly, "");
  r = run("push-pending", "--json");
  check("an upload that is refused: a sign-in problem too", r.ok === false && r.code === "auth" && !r.offline, JSON.stringify(r));
  fs.rmSync(readOnly);
  check("...and it goes once that is put right", run("push-pending", "--json").ok === true);

  // GitHub not answering is a different thing.
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", "http://127.0.0.1:9/chats.git"], { env });
  r = run("check", "--json");
  check("no answer from GitHub: not a sign-in problem", r.ok === false && r.offline === true && !r.code, JSON.stringify(r));

  // A login in the remote's address stays out of what is kept.
  fs.rmSync(allow);
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", `http://t0ken-secret@127.0.0.1:${port}/chats.git`], { env });
  const stated = plainGit("ls-remote", "origin").stderr;
  check("git's own error does quote a login in the address", stated.includes("t0ken-secret"), stated);
  run("push-pending", "--json");
  check("a login in the address isn't logged", /could not read Password/.test(log()) && !log().includes("t0ken-secret"));
  const kept = fs.readFileSync(path.join(sync, "state.json"), "utf8");
  check("...or kept in the sync's state", /could not read Password/.test(kept) && !kept.includes("t0ken-secret"), kept.slice(0, 300));
  spawnSync("git", ["-C", repo, "remote", "set-url", "origin", remote], { env });

  // A half-written pin (git config doesn't wait for its lock) isn't a choice someone made.
  fs.writeFileSync(allow, "");
  unpin();
  spawnSync("git", ["-C", repo, "config", "--local", "--add", key, ""], { env });
  r = run("check", "--json");
  check("a half-written pin puts itself right", r.ok === true && JSON.stringify(pin()) === JSON.stringify(["", helper]), JSON.stringify([r, pin()]));

  // The words git uses.
  process.env.CLAUDE_SYNC_HOME = sync;
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  const { isAuthError } = await import("./engine.mjs");
  for (const e of [
    "fatal: could not read Password for 'https://x@github.com': terminal prompts disabled",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b/'",
    "remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found",
    "remote: Permission to a/b.git denied to c.\nfatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 403",
  ])
    check(`a login problem: ${e.split("\n").pop().slice(0, 50)}`, isAuthError(e));
  for (const e of [
    "fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/a/b/': Failed to connect to github.com port 443",
    "fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 500",
    "error: open(\"x\"): Permission denied",
    "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
    "fatal: Unable to create '.git/index.lock': File exists.",
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "",
  ])
    check(`not a login problem: ${e.split("\n")[0].slice(0, 60) || "(nothing)"}`, !isAuthError(e));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
}
for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : `\n      ${String(x.detail).trim().slice(0, 400)}`}`);
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`);
process.exit(results.every((x) => x.ok) ? 0 : 1);
