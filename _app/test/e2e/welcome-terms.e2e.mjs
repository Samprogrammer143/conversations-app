// First run: the welcome window asks for the licence and the Claude plan's terms. Get started
// waits for the box; closing the window without accepting quits the app and accepts nothing;
// accepting opens the main window and keeps when; a later start doesn't ask again.
//   node test/e2e/welcome-terms.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conv-welcome-"));
const claudeDir = path.join(scratch, ".claude");
const dataDir = path.join(scratch, "data");
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const settingsFile = path.join(dataDir, "settings.json");
fs.writeFileSync(settingsFile, JSON.stringify({ welcomed: false, syncAutomatically: false, startAtLogin: false }));
const env = launchEnv({ CLAUDE_CONFIG_DIR: claudeDir, CONVERSATIONS_DATA_DIR: dataDir });
const saved = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const launch = () => electron.launch({ args: [root], cwd: root, env, timeout: 60_000 });
// Get started, or Continue without chat when this PC has no Claude Code. (Not Check again,
// beside it then: that only looks for Claude Code again, and never goes on.)
const goOn = ".welcome-window .btn-primary:not(.row-actions > *), .welcome-window .row-actions .btn-plain";

try {
  // 1. Closed without accepting.
  {
    const app = await launch();
    const w = await app.firstWindow();
    await w.waitForSelector(".welcome-window .terms input", { timeout: 20_000 });
    const states = await w.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => b.disabled), goOn);
    check("going on waits for the box", states.length > 0 && states.every(Boolean), JSON.stringify(states));
    const exited = new Promise((r) => app.process().once("exit", () => r(true)));
    // A Mac hides the page's close button (the window's own is used there): close the window itself.
    // (The app may quit before the call returns: that isn't an error.)
    if (process.platform === "darwin") await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
    else await w.locator(".welcome-window .close").click();
    const quit = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 15_000))]);
    check("closing the welcome without accepting quits the app", quit === true);
    const s = saved();
    check("...and accepts nothing", !s.termsAcceptedAt && !s.welcomed, JSON.stringify(s));
    if (!quit) await app.close().catch(() => {});
  }

  // 1b. A start out of sight (as at login) before accepting: the welcome still shows, and
  // Settings can't open around it.
  {
    const app = await electron.launch({ args: [root, "--hidden"], cwd: root, env, timeout: 60_000 });
    try {
      const w = await app.firstWindow();
      await w.waitForSelector(".welcome-window .terms input", { timeout: 20_000 });
      check("a hidden start before accepting still shows the welcome", true);
      await w.evaluate(() => window.conversations.app.showSettings());
      await w.waitForTimeout(1000);
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((x) => x.webContents.getURL().split("?")[0].split("/").pop()));
      check("...and Settings can't open around it", windows.length === 1, JSON.stringify(windows));
    } finally {
      await app.close().catch(() => {});
    }
  }

  // 2. Accepted.
  {
    const app = await launch();
    try {
      const w = await app.firstWindow();
      await w.waitForSelector(".welcome-window .terms input", { timeout: 20_000 });
      check("the welcome asks again after it was closed", true);
      await w.locator(".welcome-window .terms input").check();
      const go = w.locator(goOn).last();
      check("ticking the box lets you go on", await go.isEnabled());
      const next = app.waitForEvent("window", { timeout: 15_000 });
      await go.click();
      const main = await next;
      await main.waitForTimeout(1500);
      const s = saved();
      check("accepting opens the main window", (await main.evaluate(() => document.body.dataset.window)) === "main");
      check("...and keeps when it was accepted", !!s.termsAcceptedAt && !Number.isNaN(Date.parse(s.termsAcceptedAt)) && s.welcomed === true, JSON.stringify(s));
    } finally {
      await app.close().catch(() => {});
    }
  }

  // 3. A later start.
  {
    const app = await launch();
    try {
      const w = await app.firstWindow();
      await w.waitForTimeout(2500);
      check("a later start goes straight to the app", (await w.evaluate(() => document.body.dataset.window)) === "main" && !(await w.evaluate(() => !!document.querySelector(".welcome-window, .terms"))));
    } finally {
      await app.close().catch(() => {});
    }
  }
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
