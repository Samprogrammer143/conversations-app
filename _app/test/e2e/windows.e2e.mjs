// Two workspaces at once, each in its own window, in the sandbox with scratch folders
// and an empty scratch repository (nothing of yours is touched):
// - the switcher opens another workspace in a new window (a second copy of the app,
//   in that workspace's folders); this window stays as it is;
// - the menu then says it is open in another window, and choosing it brings that
//   window forward instead of switching this one;
// - it can't be disconnected from here while its window is open;
// - a plain start opens again the windows that were open when the app last stopped.
//   node test/e2e/windows.e2e.mjs [shots dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import electronPath from "electron";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "test-results"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-win-"));
const claudeDir = path.join(T, ".claude");
const dataDir = path.join(T, "data");
const syncHome = path.join(T, "sync");
const bare = path.join(T, "work.git");
spawnSync("git", ["init", "-q", "--bare", bare]);
fs.mkdirSync(dataDir, { recursive: true });
// (startAtLogin as installed: the installed app writes Windows' start-at-login entry from it.)
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true, syncAutomatically: false, startAtLogin: true }));
const sandboxRepo = launchEnv().CLAUDE_SYNC_HOME ? path.join(launchEnv().CLAUDE_SYNC_HOME, "repo") : null;
fs.mkdirSync(syncHome, { recursive: true });
fs.writeFileSync(path.join(syncHome, "config.json"), JSON.stringify({ remote: path.join(T, "main.git"), machine: "Test PC" }));
if (sandboxRepo && fs.existsSync(sandboxRepo)) spawnSync("git", ["clone", "-q", "--no-checkout", sandboxRepo, path.join(syncHome, "repo")]);

// CONVERSATIONS_E2E_EXE: run the installed app instead (its shell runs the code committed in this checkout).
const exe = process.env.CONVERSATIONS_E2E_EXE || null;
const env = launchEnv({ CLAUDE_CONFIG_DIR: claudeDir, CONVERSATIONS_DATA_DIR: dataDir, CLAUDE_SYNC_HOME: syncHome, CONVERSATIONS_LAUNCHER_DIR: path.join(T, "bin"), CONVERSATIONS_TEST_NO_RELAUNCH: "1", ...(exe ? { CONVERSATIONS_APP_HOME: path.resolve(root, "..") } : {}) });
const appArgs = exe ? [] : [root];
const openDir = path.join(dataDir, "open");
const mark = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(openDir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
};
const until = async (fn, ms = 30_000) => {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    v = await fn();
    if (v) return v;
    await sleep(400);
  }
  return v;
};
async function launch() {
  const app = await electron.launch({ ...(exe ? { executablePath: exe } : {}), args: appArgs, cwd: root, env, timeout: 60_000 });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1280, 820);
    w.show();
  });
  await win.waitForTimeout(3000);
  return { app, win };
}
const others = new Set();

let { app, win } = await launch();
let wsId = null;
try {
  // A second workspace, set up on this PC.
  const added = await win.evaluate((remote) => window.conversations.workspace.add({ name: "Test WS", remote }), bare);
  check("a second workspace is set up", !!added?.ok, JSON.stringify(added));
  wsId = added?.id;
  await win.evaluate(() => window.conversations.workspace.list());
  const mainPid = await app.evaluate(() => process.pid);
  check("this window's copy records its workspace as open", mark("main")?.pid === mainPid, JSON.stringify(mark("main")));
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Conversations"))?.getTitle());
  // (The title is set when the window is made: with one workspace then, it says only "Conversations".)
  check("the window is called Conversations", !!title?.includes("Conversations"), title ?? "");

  // The switcher: another workspace has a button to open it in a new window.
  await win.click(".ws-button");
  await win.waitForTimeout(600);
  const row = await win.evaluate(() => [...document.querySelectorAll(".ws-row")].map((r) => ({ name: r.querySelector(".ws-item-text .ellipsis")?.textContent, button: r.querySelector(".ws-window")?.getAttribute("aria-label") ?? null })));
  check("another workspace offers Open in a new window; this one doesn't", row.some((r) => r.name === "Test WS" && r.button === "Open Test WS in a new window") && row.some((r) => r.name === "Main" && !r.button), JSON.stringify(row));
  await win.evaluate(() => document.body.classList.add("solid"));
  await win.hover('.ws-row:has-text("Test WS")');
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(out, "windows-menu.png") });
  await win.click('.ws-row:has-text("Test WS") .ws-window');

  // A second copy of the app starts in that workspace; this one carries on.
  const opened = await until(() => {
    const m = mark(wsId);
    return m && m.pid !== mainPid && alive(m.pid) ? m : null;
  }, 60_000);
  if (opened) others.add(opened.pid);
  check("a new window opens in that workspace (its own copy of the app)", !!opened, JSON.stringify(mark(wsId)));
  const wsLog = path.join(dataDir, "workspaces", wsId ?? "?", "app.log");
  const started = await until(() => (fs.existsSync(wsLog) && fs.readFileSync(wsLog, "utf8").includes("starting ") ? fs.readFileSync(wsLog, "utf8") : null), 30_000);
  check("...with that workspace's own data and log", !!started, wsLog);
  check("this window is still here, in its own workspace", (await win.evaluate(() => document.querySelector(".ws-name")?.textContent)) === "Main");
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, "workspaces.json"), "utf8"));
  check("the default workspace (for a plain start) is unchanged", reg.current === "main", JSON.stringify(reg.current));

  // The menu now says it's open elsewhere; choosing it brings that window forward.
  await win.click(".ws-button");
  const sub = await until(() => win.evaluate(() => [...document.querySelectorAll(".ws-row")].find((r) => r.textContent.includes("Test WS"))?.querySelector(".ws-sub")?.textContent ?? null).then((t) => (t === "Open in another window" ? t : null)), 10_000);
  check("the menu says it is open in another window", !!sub, sub ?? "");
  await win.screenshot({ path: path.join(out, "windows-menu-open.png") });
  const before = fs.existsSync(wsLog) ? fs.readFileSync(wsLog, "utf8").length : 0;
  await win.click('.ws-row:has-text("Test WS") .ws-item');
  const forward = await until(() => (fs.readFileSync(wsLog, "utf8").slice(before).includes("another window brought this one forward") ? true : null), 30_000);
  check("choosing it brings its window forward", !!forward);
  await sleep(1500);
  check("...and this window doesn't switch or restart", app.process().exitCode === null && !(await win.evaluate(() => !!document.querySelector(".switching"))) && (await win.evaluate(() => document.querySelector(".ws-name")?.textContent)) === "Main");
  check("...nor does its copy end", alive(opened?.pid ?? 0));

  // Disconnecting it from here would leave its window in a workspace that's gone.
  const off = await win.evaluate((id) => window.conversations.workspace.disconnect(id), wsId);
  check("it can't be disconnected while its window is open", !off.ok && /open in another window/.test(off.err ?? ""), JSON.stringify(off));

  // An update restart in one window asks the others to restart too: a copy with nothing
  // newer to load stays as it is, and the asking start ends at once (no third window).
  const ask = () => {
    const c = spawn(exe ?? electronPath, [...appArgs, `--workspace=${wsId}`, "--restart-for-update"], { env, stdio: "ignore" });
    return new Promise((r) => {
      const t = setTimeout(() => r(null), 30_000);
      c.on("exit", (code) => {
        clearTimeout(t);
        r({ code });
      });
    });
  };
  const asked = await ask();
  await sleep(2000);
  check("asking another window to restart for an update ends at once", !!asked, JSON.stringify(asked));
  check("...and that window, with nothing newer, carries on", alive(opened?.pid ?? 0) && mark(wsId)?.pid === opened?.pid);

  // The PC shuts down with both open (here: both copies end without Quit).
  if (opened) process.kill(opened.pid);
  await until(() => (!alive(opened?.pid ?? 0) ? true : null), 15_000);
  // Asked while that workspace isn't open: nothing opens.
  const none = await ask();
  check("asking a workspace that isn't open to restart opens nothing", !!none && !alive(mark(wsId)?.pid ?? 0), JSON.stringify(none));
} catch (e) {
  check("no error in the first part", false, e.stack ?? e.message);
} finally {
  for (const pid of others) {
    try {
      process.kill(pid);
    } catch {}
  }
  await Promise.race([app.close().catch(() => {}), sleep(20_000)]);
}

// A plain start opens Main, and opens the other workspace's window again.
({ app, win } = await launch());
try {
  const mainPid = await app.evaluate(() => process.pid);
  const again = await until(() => {
    const m = mark(wsId);
    return m && m.pid !== mainPid && !others.has(m.pid) && alive(m.pid) ? m : null;
  }, 60_000);
  if (again) others.add(again.pid);
  check("a plain start opens again the window left open", !!again, JSON.stringify(mark(wsId)));
  check("...and this window is the default workspace", (await win.evaluate(() => document.querySelector(".ws-name")?.textContent)) === "Main");
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).find((t) => t.includes("Conversations")));
  check("with two workspaces, the window's title names its workspace", title === "Main · Conversations", title ?? "");
} catch (e) {
  check("no error in the second part", false, e.stack ?? e.message);
} finally {
  // The other window first: a copy the app started holds the test runner's pipes open.
  for (const pid of others) {
    try {
      process.kill(pid);
    } catch {}
  }
  await sleep(1500);
  await Promise.race([app.close().catch(() => {}), sleep(20_000)]);
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    if (wsId) for (const d of [`${claudeDir}-${wsId}`, `${syncHome}-${wsId}`]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
