// Left and Right switch workspace when nothing is being typed, in the sandbox with scratch
// folders and a second workspace (nothing of yours is touched). Switching restarts the app
// (here: the test starts it again), so the keys are checked for what they do, not after.
//   node test/e2e/workspace-keys.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-wskeys-"));
const dataDir = path.join(T, "data");
const syncHome = path.join(T, "sync");
const bare = path.join(T, "work.git");
spawnSync("git", ["init", "-q", "--bare", bare]);
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true, syncAutomatically: false, startAtLogin: false }));
fs.mkdirSync(syncHome, { recursive: true });
fs.writeFileSync(path.join(syncHome, "config.json"), JSON.stringify({ remote: path.join(T, "main.git"), machine: "Test PC" }));
const env = launchEnv({ CLAUDE_CONFIG_DIR: path.join(T, ".claude"), CONVERSATIONS_DATA_DIR: dataDir, CLAUDE_SYNC_HOME: syncHome, CONVERSATIONS_LAUNCHER_DIR: path.join(T, "bin"), CONVERSATIONS_TEST_NO_RELAUNCH: "1" });
const closed = (app) => new Promise((resolve) => app.process().once("exit", () => resolve(true)));
const launch = async () => {
  const app = await electron.launch({ args: [root], cwd: root, env, timeout: 60_000 });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await win.waitForTimeout(3000);
  return { app, win };
};
let wsId = null;
let { app, win } = await launch();
try {
  const box = 'textarea[aria-label="Message"]';
  await win.keyboard.press("Control+N");
  await win.waitForTimeout(600);
  // One workspace: the keys do nothing.
  await win.evaluate(() => document.activeElement?.blur());
  await win.keyboard.press("ArrowRight");
  await win.waitForTimeout(1500);
  check("with one workspace, Right does nothing", app.process().exitCode === null);

  const added = await win.evaluate((remote) => window.conversations.workspace.add({ name: "Test WS", remote }), bare);
  wsId = added?.id;
  check("a second workspace is set up", !!added?.ok, JSON.stringify(added));
  await win.evaluate(() => window.conversations.workspace.list());
  await win.waitForTimeout(500);

  // Typing: the keys move the cursor.
  await win.click(box);
  await win.fill(box, "abc");
  await win.keyboard.press("ArrowLeft");
  await win.waitForTimeout(800);
  const caret = await win.evaluate((s) => document.querySelector(s).selectionStart, box);
  check("while typing, Left moves the cursor, not the workspace", app.process().exitCode === null && caret === 2, `caret ${caret}`);

  // Not typing: Right goes to the next workspace (the app restarts into it).
  await win.fill(box, "");
  await win.evaluate(() => document.activeElement?.blur());
  const gone = closed(app);
  await win.keyboard.press("ArrowRight").catch(() => {});
  check("not typing, Right switches to the next workspace (restart)", await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))]));
} catch (e) {
  check("no error in the first part", false, e.stack ?? e.message);
  await app.close().catch(() => {});
}
({ app, win } = await launch());
try {
  const name = await win.evaluate(() => document.querySelector(".ws-name")?.textContent);
  check("it comes back in the next workspace", name === "Test WS", name ?? "");
  await win.keyboard.press("Control+N");
  await win.waitForTimeout(600);
  await win.evaluate(() => document.activeElement?.blur());
  const gone = closed(app);
  await win.keyboard.press("ArrowLeft").catch(() => {});
  check("Left goes back round (restart)", await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))]));
} catch (e) {
  check("no error in the second part", false, e.stack ?? e.message);
  await app.close().catch(() => {});
}
({ app, win } = await launch());
try {
  const name = await win.evaluate(() => document.querySelector(".ws-name")?.textContent);
  check("back in the first workspace", name === "Main", name ?? "");
} finally {
  await app.close().catch(() => {});
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    if (wsId) for (const d of [`${path.join(T, ".claude")}-${wsId}`, `${syncHome}-${wsId}`]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
