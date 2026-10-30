// Alert mode through the app, against this PC's real Claude Code (short Haiku turns):
// with another program in front, a chat that finishes comes forward, opened, with the
// message box ready; in the window, on another chat, it only says so; off, nothing moves.
//   node test/e2e/alert.e2e.mjs <scratch folder> [shots dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, collectE2eTranscripts } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] ?? path.join(root, "test-results"));
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Another program, in front of the app.
const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-other-"));
fs.writeFileSync(path.join(otherDir, "main.cjs"), 'const { app, BrowserWindow, ipcMain } = require("electron"); app.whenReady().then(() => { globalThis.w = new BrowserWindow({ width: 500, height: 300, title: "Another program" }); w.loadURL("about:blank"); });');

const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
let other = null;
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1320, 900);
    w.show();
  });
  await win.waitForTimeout(2500);
  const projectId = "folder:alert-e2e";
  await win.evaluate(({ projectId, scratch }) => window.conversations.settings.get().then((s) => window.conversations.settings.set({ alertMode: false, folders: { ...s.folders, [projectId]: scratch } })), { projectId, scratch });
  const focused = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isFocused()));
  const until = async (fn, ms = 60_000) => {
    const t0 = Date.now();
    let v = null;
    while (Date.now() - t0 < ms) {
      v = await fn();
      if (v) return v;
      await sleep(300);
    }
    return v;
  };
  const idle = (id) => until(() => win.evaluate((cid) => window.conversations.chat.status(cid).then((s) => s?.state === "idle"), id), 120_000);
  const start = async (text) => {
    const r = await win.evaluate(({ projectId, text }) => window.conversations.chat.send(null, text, { projectId, model: "haiku", permissionMode: "default" }), { projectId, text });
    await until(() => win.evaluate((cid) => !!document.querySelector(`[data-id="${cid}"]`), r.conversationId), 30_000);
    return r.conversationId;
  };
  const open = async (id) => {
    await win.evaluate((cid) => document.querySelector(`[data-id="${cid}"]`)?.click(), id);
    await sleep(800);
  };
  const shownTitle = () => win.evaluate(() => document.querySelector(".detail-title .title-text")?.textContent ?? "");
  const box = 'textarea[aria-label="Message"]';

  const a = await start("Reply with just the word ONE.");
  const b = await start("Reply with just the word TWO.");
  await idle(a);
  await idle(b);
  await open(a);
  const titleA = await shownTitle();

  // The switch, on the message box.
  const sw = '.composer .alert-switch button[role="switch"]';
  check("the switch is on the message box, off to begin with", (await win.getAttribute(sw, "aria-checked")) === "false");
  await win.screenshot({ path: path.join(out, "alert-switch.png"), clip: { x: 500, y: 700, width: 820, height: 200 } });

  // Off: another chat finishing moves nothing.
  // A program just started gets the front; Windows can refuse one that is already running.
  const otherFront = async () => {
    await other?.close().catch(() => {});
    other = await electron.launch({ args: [path.join(otherDir, "main.cjs")], timeout: 60_000 });
    await sleep(1500);
    // Windows can refuse it too while this PC is in use: then the app is told it isn't in front.
    if (await focused()) {
      console.log("note  Windows kept the front here: the app is told it lost it");
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        const real = { isFocused: w.isFocused, focus: w.focus, get: BrowserWindow.getFocusedWindow };
        w.isFocused = () => false;
        BrowserWindow.getFocusedWindow = () => null;
        w.focus = () => {
          w.isFocused = real.isFocused;
          w.focus = real.focus;
          BrowserWindow.getFocusedWindow = real.get;
          globalThis.toldFocus = true;
          real.focus.call(w);
        };
      });
    }
    return !(await focused());
  };
  // (The window's own "focus" event: Windows sends none when it never lost the front.)
  const arrived = () => win.evaluate(() => window.dispatchEvent(new Event("focus")));
  // The app waits for a pause in your typing: in this test, whoever is at this PC counts as paused.
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 60;
  });
  await win.fill(box, "Reply with just the word THREE.");
  await win.press(box, "Enter");
  check("another program can be put in front", await otherFront());
  await idle(a);
  await sleep(3500);
  check("off: a finished chat doesn't come forward", !(await focused()));

  // On: it does, opened on that chat, the box ready.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await sleep(500);
  await win.click(sw);
  await until(() => win.evaluate(() => window.conversations.settings.get().then((s) => s.alertMode)), 5000);
  check("the switch turns it on", (await win.getAttribute(sw, "aria-checked")) === "true");
  await win.fill(box, "Count from 1 to 40, one number per line, nothing else.");
  await win.press(box, "Enter");
  await until(() => win.evaluate((cid) => window.conversations.chat.status(cid).then((s) => s?.state !== "idle"), a), 15_000);
  await open(b);
  check("another program is in front while it runs", await otherFront());
  await idle(a);
  const front = await until(focused, 25_000);
  check("on: the finished chat comes to the front of the screen", !!front);
  await arrived();
  await sleep(1000);
  check("...opened on that chat", (await shownTitle()) === titleA, await shownTitle());
  check("...with the message box ready to type in", await win.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Message"));
  await win.screenshot({ path: path.join(out, "alert-front.png") });

  // Keys in the first moments: what lands in the box is not sent. Then Enter works again.
  await win.fill(box, "half a sentence meant for another program");
  await win.press(box, "Enter");
  await sleep(300);
  check("Enter right after it came forward sends nothing", (await win.inputValue(box)).startsWith("half a sentence") && (await win.evaluate((cid) => window.conversations.chat.status(cid).then((s) => s?.state === "idle"), a)));
  await win.fill(box, "");
  await sleep(3200);

  // Minimized: it comes back.
  await win.fill(box, "Reply with just the word MINI.");
  await win.press(box, "Enter");
  await until(() => win.evaluate((cid) => window.conversations.chat.status(cid).then((s) => s?.state !== "idle"), a), 15_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await idle(a);
  const back = await until(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isMinimized()), 30_000);
  check("a minimized window comes back when the chat finishes", !!back);
  await until(focused, 25_000);
  await arrived();
  await sleep(3500);

  // Claude asks something: the card shows, and no key answers it.
  await win.fill(box, "Use the AskUserQuestion tool now to ask me which colour I prefer, options Red and Blue. If I don't answer, reply with only the word SKIPPED.");
  await win.press(box, "Enter");
  await otherFront();
  const asked = await until(() => win.evaluate(() => !!document.querySelector(".permission")), 60_000);
  check("a question brings the chat forward with its card", !!asked && !!(await until(focused, 25_000)), `card ${asked}`);
  await arrived();
  await sleep(1000);
  check("...the message box has the keyboard, not Allow", await win.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Message"));
  await win.keyboard.press("Enter");
  await sleep(500);
  check("...and Enter doesn't answer it", await win.evaluate(() => !!document.querySelector(".permission")));
  await win.evaluate(() => [...document.querySelectorAll(".permission button")].find((b) => b.textContent.trim() === "Skip")?.click());
  await idle(a);

  // In the window, on another chat: it stays where you are and says so.
  await open(b);
  await win.evaluate((cid) => window.conversations.chat.send(cid, "Reply with just the word FOUR.", { permissionMode: "default" }), a);
  await until(() => win.evaluate((cid) => window.conversations.chat.status(cid).then((s) => s?.state !== "idle"), a), 15_000);
  const titleB = await shownTitle();
  await idle(a);
  const toast = await until(() => win.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).find((t) => t.includes("finished")) ?? null), 8000);
  check("in the window, on another chat: it stays put and says so, with Open", !!toast && toast.includes("Open") && (await shownTitle()) === titleB, toast ?? "");
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await other?.close().catch(() => {});
  await app.close().catch(() => {});
  try {
    fs.rmSync(otherDir, { recursive: true, force: true });
    collectE2eTranscripts(scratch);
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
