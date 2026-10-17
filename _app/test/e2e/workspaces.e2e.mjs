// Workspaces end to end, in the sandbox with a scratch Claude folder and an empty
// scratch repository (nothing of yours is touched):
// - add a workspace from the switcher: its repository is started, its sync folder,
//   Claude Code folder, hooks and `claude-<id>` command are set up;
// - switch to it: the app comes back in it, with only its conversations, its own
//   folders, and the first workspace's engine;
// - Ctrl+Shift+1 switches back.
//   node test/e2e/workspaces.e2e.mjs [shots dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "test-results"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-ws-"));
const claudeDir = path.join(T, ".claude");
const dataDir = path.join(T, "data");
const syncHome = path.join(T, "sync");
const bin = path.join(T, "bin");
const bare = path.join(T, "work.git");
spawnSync("git", ["init", "-q", "--bare", bare]);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true, syncAutomatically: false }));

// The first workspace's sync folder: a clone of the sandbox's copy, so its engine is the one in this checkout.
const sandboxRepo = launchEnv().CLAUDE_SYNC_HOME ? path.join(launchEnv().CLAUDE_SYNC_HOME, "repo") : null;
fs.mkdirSync(syncHome, { recursive: true });
// The first workspace's repository, written another way (case, a trailing backslash): a new workspace must refuse it.
const mainRepo = path.join(T, "main.git");
fs.mkdirSync(mainRepo, { recursive: true });
fs.writeFileSync(path.join(syncHome, "config.json"), JSON.stringify({ remote: mainRepo.toUpperCase() + "\\", machine: "Test PC" }));
if (sandboxRepo && fs.existsSync(sandboxRepo)) spawnSync("git", ["clone", "-q", "--no-checkout", sandboxRepo, path.join(syncHome, "repo")]);

const conversation = (dir, id, cwd, text) => {
  const folder = path.join(dir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { type: "user", uuid: `${id}-u`, parentUuid: null, sessionId: id, cwd, timestamp: ts, entrypoint: "cli", message: { role: "user", content: text } },
    { type: "assistant", uuid: `${id}-a`, parentUuid: `${id}-u`, sessionId: id, cwd, timestamp: ts, entrypoint: "cli", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }] } },
  ];
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const MAIN_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const WS_ID = "bbbbbbbb-2222-4222-8222-222222222222";
conversation(claudeDir, MAIN_ID, path.join(T, "work", "main-project"), "A conversation in the first workspace");

// A stand-in for `claude auth login`: the sign-in page's address, then a code ("good#code" works).
const fakeLogin = path.join(T, "fake-login.mjs");
fs.writeFileSync(
  fakeLogin,
  [
    'process.stdout.write("Opening browser to sign in\\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=e2e\\nPaste code here if prompted > ");',
    'process.stdin.once("data", (d) => { if (String(d).trim() === "good#code") process.exit(0); console.log("Login failed: Request failed with status code 400"); process.exit(1); });',
    `if ((await import("node:fs")).existsSync(${JSON.stringify(path.join(T, "auto-login"))})) setTimeout(() => process.exit(0), 1500);`,
  ].join("\n"),
);
const env = launchEnv({ CONVERSATIONS_TEST_LOGIN: `${process.execPath}|${fakeLogin}`,  CLAUDE_CONFIG_DIR: claudeDir, CONVERSATIONS_DATA_DIR: dataDir, CLAUDE_SYNC_HOME: syncHome, CONVERSATIONS_LAUNCHER_DIR: bin, CONVERSATIONS_TEST_NO_RELAUNCH: "1" });
async function launch() {
  const app = await electron.launch({ args: [root], cwd: root, env, timeout: 60_000 });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1280, 820);
    w.show();
  });
  await win.waitForTimeout(3000);
  return { app, win };
}
const waitFor = async (win, fn, arg, ms = 20_000) => {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    v = await win.evaluate(fn, arg);
    if (v) return v;
    await win.waitForTimeout(400);
  }
  return v;
};
const closed = (app) => new Promise((resolve) => app.process().once("exit", () => resolve(true)));

let { app, win } = await launch();
let wsDir = null;
try {
  const name = await win.evaluate(() => document.querySelector(".ws-name")?.textContent);
  check("the switcher shows the first workspace", name === "Main", name ?? "");
  check("its conversation is listed", await win.evaluate((id) => !!document.querySelector(`[data-id="${id}"]`), MAIN_ID));

  // Add a workspace from the switcher.
  await win.click(".ws-button");
  await win.click('.ws-menu .menu-item:has-text("Add workspace")');
  await win.fill('.ws-form input[placeholder="Work"]', "Test WS");

  // The first workspace's own repository is refused: the accounts' conversations would mix.
  await win.fill('.ws-form input[placeholder^="https://"]', mainRepo);
  await win.click('.ws-sheet button:has-text("Set up")');
  const sameErr = await waitFor(win, () => document.querySelector(".ws-error")?.textContent ?? null, null, 10_000);
  check("the first workspace's repository is refused", !!sameErr?.includes("first workspace"), sameErr ?? "");

  // A setup that fails leaves no workspace behind.
  const notRepo = path.join(T, "not-a-repo");
  fs.mkdirSync(notRepo, { recursive: true });
  await win.fill('.ws-form input[placeholder^="https://"]', notRepo);
  await win.click('.ws-sheet button:has-text("Set up")');
  const failErr = await waitFor(win, (prev) => { const t = document.querySelector(".ws-error")?.textContent; return t && t !== prev && !document.querySelector(".ws-sheet button[disabled]") ? t : null; }, sameErr, 60_000);
  const afterFail = await win.evaluate(() => window.conversations.workspace.list());
  check("a setup that fails shows why, and leaves no workspace behind", !!failErr && afterFail.workspaces.length === 1, `${failErr} | ${JSON.stringify(afterFail.workspaces.map((w) => w.id))}`);

  await win.fill('.ws-form input[placeholder^="https://"]', bare);
  await win.screenshot({ path: path.join(out, "ws-add-sheet.png") });
  await win.click('.ws-sheet button:has-text("Set up")');
  const signInStep = await waitFor(win, () => document.querySelector("#ws-title")?.textContent?.startsWith("Sign in to") ? document.querySelector("#ws-title").textContent : null, null, 90_000);
  check("setting it up reaches the sign-in step", !!signInStep, signInStep ?? (await win.evaluate(() => document.querySelector(".ws-error")?.textContent ?? "")));
  await win.screenshot({ path: path.join(out, "ws-sign-in-step.png") });

  const list = await win.evaluate(() => window.conversations.workspace.list());
  const ws = list.workspaces.find((w) => w.name === "Test WS");
  check("the workspace is listed, set up here, not signed in yet", !!ws && ws.setUp && !ws.signedIn, JSON.stringify(ws));
  wsDir = { claude: `${claudeDir}-${ws?.id}`, sync: `${syncHome}-${ws?.id}` };
  const log = spawnSync("git", ["--git-dir", bare, "log", "--oneline", "main"], { encoding: "utf8" }).stdout.trim();
  check("its empty repository was started", log.includes("Start the conversation sync"), log);
  const hooks = JSON.parse(fs.readFileSync(path.join(wsDir.claude, "settings.json"), "utf8")).hooks;
  const stop = hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
  check("its Claude Code hooks sync to its own folder, with the first workspace's engine", stop.startsWith("node ") && stop.endsWith(`hook stop --sync-home "${wsDir.sync.replace(/\\/g, "/")}"`) && stop.includes("_sync/sync.mjs"), stop);
  const launcher = path.join(bin, `claude-${ws?.id}.cmd`);
  const launcherText = fs.existsSync(launcher) ? fs.readFileSync(launcher, "utf8") : "";
  check("its claude-<id> command sets its folders", launcherText.includes(`CLAUDE_CONFIG_DIR=${wsDir.claude}`) && launcherText.includes(`CLAUDE_SYNC_HOME=${wsDir.sync}`), launcherText.split("\r\n").slice(1, 3).join(" | "));
  const shared = path.join(syncHome, "repo", "_shared", "workspaces", `${ws?.id}.json`);
  const sharedEntry = fs.existsSync(shared) ? JSON.parse(fs.readFileSync(shared, "utf8")) : null;
  check("it is in the list the other PCs see", sharedEntry?.name === "Test WS" && sharedEntry?.remote === bare, JSON.stringify(sharedEntry));
  const mainSettings = path.join(claudeDir, "settings.json");
  check("the first workspace's Claude settings are untouched", !fs.existsSync(mainSettings));
  await win.click('.ws-sheet button:has-text("Later")');

  // A conversation in the new workspace's Claude folder.
  conversation(wsDir.claude, WS_ID, path.join(T, "work", "work-project"), "A conversation in the second workspace");

  // Switch from the switcher: the app restarts (here: the test starts it again).
  const gone = closed(app);
  await win.click(".ws-button");
  await win.click('.ws-menu .menu-item:has-text("Test WS")');
  check("switching restarts the app", await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))]));
} catch (e) {
  check("no error in the first part", false, e.message);
  await app.close().catch(() => {});
}

({ app, win } = await launch());
try {
  const name = await win.evaluate(() => document.querySelector(".ws-name")?.textContent);
  check("it comes back in the new workspace", name === "Test WS", name ?? "");
  const listed = await waitFor(win, (id) => !!document.querySelector(`[data-id="${id}"]`), WS_ID, 15_000);
  check("its conversation is listed", !!listed);
  check("the first workspace's conversation is not", !(await win.evaluate((id) => !!document.querySelector(`[data-id="${id}"]`), MAIN_ID)));
  const procEnv = await app.evaluate(() => ({ claude: process.env.CLAUDE_CONFIG_DIR, sync: process.env.CLAUDE_SYNC_HOME, data: process.env.CONVERSATIONS_DATA_DIR, engine: process.env.CONVERSATIONS_ENGINE, launcher: process.env.CONVERSATIONS_CLAUDE_LAUNCHER }));
  check("everything it starts uses the workspace's folders", procEnv.claude === wsDir?.claude && procEnv.sync === wsDir?.sync && !!procEnv.data?.includes("workspaces"), JSON.stringify(procEnv));
  check("its sync engine is the first workspace's", !!procEnv.engine && procEnv.engine.endsWith(path.join("_sync", "sync.mjs")) && !procEnv.engine.startsWith(wsDir?.sync ?? "?"), procEnv.engine ?? "");
  check("Open in CLI uses its claude-<id> command", !!procEnv.launcher && procEnv.launcher.endsWith(".cmd"), procEnv.launcher ?? "");
  // Not signed in (a scratch Claude folder): the window says so where you'd type, with a way in.
  await win.evaluate((id) => document.querySelector(`[data-id="${id}"]`)?.click(), WS_ID);
  const banner = await waitFor(win, () => [...document.querySelectorAll(".banner")].map((b) => b.textContent).find((t) => t.includes("isn't signed in")) ?? null, null, 15_000);
  check("a workspace that isn't signed in says so above the message box, with Sign in", !!banner && banner.includes("Test WS") && banner.includes("Sign in"), banner ?? "");
  await win.screenshot({ path: path.join(out, "ws-signed-out-banner.png") });
  await win.click(".ws-button");
  await win.waitForTimeout(300);
  const signItem = await win.evaluate(() => [...document.querySelectorAll(".ws-menu .menu-item")].map((b) => b.textContent.trim()).find((t) => t.startsWith("Sign in to")) ?? null);
  const sub = await win.evaluate(() => document.querySelector('.ws-menu .menu-item[aria-checked="true"] .ws-sub')?.textContent ?? null);
  check("the menu offers Sign in for the workspace, and says it isn't signed in", signItem === "Sign in to Test WS…" && sub === "Not signed in", `${signItem} | ${sub}`);
  await win.keyboard.press("Escape");
  // A new chat (where a new workspace starts) says so too.
  await win.keyboard.press("Control+N");
  const draftBanner = await waitFor(win, () => (document.querySelector('section[aria-label="New chat"]') ? [...document.querySelectorAll(".banner")].map((b) => b.textContent).find((t) => t.includes("isn't signed in")) ?? null : null), null, 10_000);
  check("a new chat says the workspace isn't signed in, with Sign in", !!draftBanner && draftBanner.includes("Sign in"), draftBanner ?? "");
  // Sign in from the banner: a sheet, no terminal. A wrong code says why; the right one signs in.
  await win.click('.banner button:has-text("Sign in")');
  const codeStep = await waitFor(win, () => (document.querySelector("#ws-signin-title") && document.querySelector('.ws-form input') ? document.querySelector("#ws-signin-title").textContent : null), null, 15_000);
  check("Sign in opens a sheet that asks for the code from the browser", codeStep === "Sign in to Test WS's Claude account", codeStep ?? "");
  check("...with a way to open the sign-in page again", await win.evaluate(() => !!document.querySelector('.ws-hint .link')));
  await win.screenshot({ path: path.join(out, "ws-signin-sheet.png") });
  await win.fill(".ws-form input", "wrong");
  await win.click('.ws-sheet button:has-text("Sign in")');
  const wrong = await waitFor(win, () => document.querySelector(".ws-error")?.textContent ?? null, null, 15_000);
  check("a wrong code says why, and offers to try again", !!wrong?.includes("400") && (await win.evaluate(() => [...document.querySelectorAll('.ws-sheet button')].some((b) => b.textContent.includes("Try again")))), wrong ?? "");
  await win.click('.ws-sheet button:has-text("Try again")');
  await waitFor(win, () => (document.querySelector(".ws-form input") ? true : null), null, 15_000);
  await win.fill(".ws-form input", "good#code");
  await win.click('.ws-sheet button:has-text("Sign in")');
  const done = await waitFor(win, () => (document.querySelector("#ws-signin-title")?.textContent?.endsWith("is signed in") ? document.querySelector(".ws-sheet .lede")?.textContent ?? "" : null), null, 20_000);
  check("the right code signs in, and the sheet says so", done !== null && done.includes("Chats in Test WS use this account now"), done ?? "");
  await win.screenshot({ path: path.join(out, "ws-signin-done.png") });
  await win.click('.ws-sheet button:has-text("Done")');
  // Mostly the browser finishes the sign-in by itself: the sheet notices, no code needed.
  fs.writeFileSync(path.join(T, "auto-login"), "");
  await win.click('.banner button:has-text("Sign in")');
  const auto = await waitFor(win, () => document.querySelector("#ws-signin-title")?.textContent?.endsWith("is signed in") || null, null, 20_000);
  check("a sign-in the browser finishes by itself shows as done, with no code", !!auto);
  await win.click('.ws-sheet button:has-text("Done")').catch(() => {});
  fs.rmSync(path.join(T, "auto-login"), { force: true });
  check("no toast is shown for the sign-in (the sheet says it all)", !(await win.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => /sign/i.test(t.textContent)))));
  await win.keyboard.press("Escape");
  await win.evaluate(() => document.body.classList.add("solid"));
  await win.click(".ws-button");
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(out, "ws-switcher-menu.png") });
  await win.keyboard.press("Escape");

  // Ctrl+Shift+1: back to the first workspace.
  const gone = closed(app);
  await win.click(".list-toolbar, .sb-content");
  // The app closes while the key is still going down: the runner may call that an error.
  await win.keyboard.press("Control+Shift+Digit1").catch(() => {});
  check("Ctrl+Shift+1 switches back", await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))]));
} catch (e) {
  check("no error in the second part", false, e.message);
  await app.close().catch(() => {});
}

({ app, win } = await launch());
try {
  const name = await win.evaluate(() => document.querySelector(".ws-name")?.textContent);
  check("back in the first workspace", name === "Main", name ?? "");
  check("with its own conversation again", !!(await waitFor(win, (id) => !!document.querySelector(`[data-id="${id}"]`), MAIN_ID, 15_000)));
  check("and not the other workspace's", !(await win.evaluate((id) => !!document.querySelector(`[data-id="${id}"]`), WS_ID)));
  // Rename the first workspace.
  await win.click(".ws-button");
  await win.click('.ws-menu .menu-item:has-text("Rename")');
  await win.fill(".ws-rename input", "Acme & Co");
  await win.press(".ws-rename input", "Enter");
  const renamed = await waitFor(win, () => (document.querySelector(".ws-name")?.textContent === "Acme & Co" ? true : null), null, 5000);
  check("the first workspace can be renamed", !!renamed);

  // Disconnect it: Conversations leaves it out on this PC and goes to the other one.
  await win.click(".ws-button");
  await win.click('.ws-menu .menu-item:has-text("Disconnect")');
  const sheet = await waitFor(win, () => document.querySelector("#ws-off-title")?.textContent ?? null, null, 5000);
  check("Disconnect asks first, in a sheet", sheet === "Disconnect Acme & Co?", sheet ?? "");
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(out, "ws-disconnect-sheet.png") });
  const gone = closed(app);
  await win.click('.ws-sheet button:has-text("Disconnect")');
  check("disconnecting the workspace the app is in switches to the other one (restart)", await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))]));
} catch (e) {
  check("no error in the third part", false, e.message);
  await app.close().catch(() => {});
}

({ app, win } = await launch());
try {
  const name = await win.evaluate(() => document.querySelector(".ws-name")?.textContent);
  check("after disconnecting, the app is in the other workspace", name === "Test WS", name ?? "");
  check("the disconnected workspace's conversations are not shown", !(await win.evaluate((id) => !!document.querySelector(`[data-id="${id}"]`), MAIN_ID)));
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, "workspaces.json"), "utf8"));
  check("it is recorded as disconnected on this PC", JSON.stringify(reg.disconnected) === '["main"]', JSON.stringify(reg));
  check("its Claude Code chats are untouched", fs.readdirSync(path.join(claudeDir, "projects")).some((d) => fs.readdirSync(path.join(claudeDir, "projects", d)).includes(`${MAIN_ID}.jsonl`)));
  await win.evaluate(() => document.body.classList.add("solid"));
  await win.click(".ws-button");
  await win.waitForTimeout(300);
  const menu = await win.evaluate(() => ({
    items: [...document.querySelectorAll(".ws-menu .menu-item")].map((b) => b.textContent.trim()),
    label: document.querySelector(".ws-menu .menu-label")?.textContent ?? null,
  }));
  await win.screenshot({ path: path.join(out, "ws-disconnected-menu.png") });
  check("the menu lists it apart, to reconnect", menu.label === "Not in Conversations on this PC" && menu.items.some((t) => t.includes("Acme & Co") && t.includes("Disconnected · reconnect")), JSON.stringify(menu));
  check("the last connected workspace can't be disconnected (nothing else to show)", !menu.items.some((t) => t.startsWith("Disconnect")), JSON.stringify(menu.items));
  const keys = await win.evaluate(() => [...document.querySelectorAll(".ws-menu .shortcut")].map((s) => s.textContent));
  check("Ctrl+Shift numbers count only connected workspaces", keys.length === 0, JSON.stringify(keys));
  // Reconnect: it comes back, and the app goes to it.
  const gone = closed(app);
  await win.click('.ws-menu .menu-item:has-text("reconnect")');
  check("reconnecting goes back to it (restart)", await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))]));
} catch (e) {
  check("no error in the fourth part", false, e.message);
  await app.close().catch(() => {});
}

({ app, win } = await launch());
try {
  const name = await win.evaluate(() => document.querySelector(".ws-name")?.textContent);
  check("reconnected: back in it, with its conversation", name === "Acme & Co" && !!(await waitFor(win, (id) => !!document.querySelector(`[data-id="${id}"]`), MAIN_ID, 15_000)), name ?? "");
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, "workspaces.json"), "utf8"));
  check("nothing is recorded as disconnected any more", !reg.disconnected, JSON.stringify(reg));
} finally {
  await app.close().catch(() => {});
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    if (wsDir) for (const d of [wsDir.claude, wsDir.sync]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
