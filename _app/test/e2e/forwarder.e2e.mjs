// An install from before the move (shell 1) finds the forwarder where the app used to
// be, in the conversations repository, and the forwarder runs the app from the app's
// repository: a scratch conversations repository holding only the forwarder, scratch
// Claude and app data folders, and this PC's copy of the app's repository (only read).
//   node test/e2e/forwarder.e2e.mjs <Conversations.exe of the old install> [shots dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const exe = path.resolve(process.argv[2] ?? path.join(process.env.LOCALAPPDATA, "Programs", "Conversations", "Conversations.exe"));
const out = path.resolve(process.argv[3] ?? path.join(root, "test-results"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-fwd-"));
const git = (args, cwd) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

// The conversations repository, as the move left it: only the forwarder in _app/dist.
const repo = path.join(T, "sync", "repo");
fs.mkdirSync(path.join(repo, "_app", "dist", "main"), { recursive: true });
fs.copyFileSync(path.join(root, "dist-forwarder", "app.json"), path.join(repo, "_app", "dist", "app.json"));
fs.copyFileSync(path.join(root, "dist-forwarder", "main", "main.mjs"), path.join(repo, "_app", "dist", "main", "main.mjs"));
fs.writeFileSync(path.join(repo, ".gitattributes"), "* -text\n");
git(["init", "-q"], repo);
git(["add", "-A"], repo);
git(["commit", "-q", "-m", "forwarder"], repo);
fs.writeFileSync(path.join(T, "sync", "config.json"), JSON.stringify({ remote: "local", machine: "Test PC" }));
const claude = path.join(T, ".claude");
const cwd = path.join(T, "work", "project");
fs.mkdirSync(cwd, { recursive: true });
const proj = path.join(claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
fs.mkdirSync(proj, { recursive: true });
const id = "aaaaaaaa-1111-4111-8111-111111111111";
const ts = new Date().toISOString();
fs.writeFileSync(path.join(proj, `${id}.jsonl`), [{ type: "user", uuid: "u", parentUuid: null, sessionId: id, cwd, timestamp: ts, message: { role: "user", content: "A test conversation" } }, { type: "assistant", uuid: "a", parentUuid: "u", sessionId: id, cwd, timestamp: ts, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }] } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
const data = path.join(T, "data");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ welcomed: true, syncAutomatically: false }));
const appHome = path.join(process.env.LOCALAPPDATA, "conversations-app");

const env = launchEnv({ CLAUDE_CONFIG_DIR: claude, CLAUDE_SYNC_HOME: path.join(T, "sync"), CONVERSATIONS_DATA_DIR: data, CONVERSATIONS_APP_HOME: appHome });
delete env.CONVERSATIONS_SDK_DIR;
let app;
try {
  app = await electron.launch({ executablePath: exe, args: [], env, timeout: 60_000 });
  const win = await app.firstWindow();
  await win.waitForTimeout(5000);
  const p = await app.evaluate(({ app }) => ({ shell: process.env.CONVERSATIONS_SHELL_VERSION, dist: process.env.CONVERSATIONS_APP_DIST, packaged: app.isPackaged }));
  const info = await win.evaluate(() => window.conversations.app.info());
  check("the old install's shell started it", p.packaged && p.shell === "1.0.0", JSON.stringify(p));
  check("it runs the app from the app's repository (staged), not the forwarder or the installed copy", !!p.dist && p.dist.startsWith(path.join(data, "app")) && /^0\.5\.\d+-[0-9a-f]{12}$/.test(path.basename(p.dist)), p.dist ?? "");
  check("the app is 0.5", /^0\.5\./.test(info.version), info.version);
  const listed = await win.evaluate((cid) => !!document.querySelector(`[data-id="${cid}"]`), id);
  check("it lists the conversation", listed);
  await win.screenshot({ path: path.join(out, "forwarder.png") });
  const log = fs.readFileSync(path.join(data, "app.log"), "utf8");
  check("it found Claude's Agent SDK on this PC", /Agent SDK from .*conversations-app-runtime/.test(log), (log.match(/Agent SDK[^\n]*/) ?? [""])[0]);
} catch (e) {
  check("no error", false, e.message);
} finally {
  await app?.close().catch(() => {});
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
