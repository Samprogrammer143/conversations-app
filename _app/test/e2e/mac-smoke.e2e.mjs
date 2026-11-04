// The app starts on a Mac and looks like a Mac app: the window buttons at the top left
// with the toolbar keeping clear of them, an app menu with Edit (copy and paste), its
// Electron profile inside its data folder, the login shell's PATH, and Settings opening.
// Screenshots of the main window and Settings, light and dark, go to <out> for a look.
// Runs on any system (the Mac checks only on a Mac); CI runs it on GitHub's Macs.
//   node test/e2e/mac-smoke.e2e.mjs [out]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "test-results", "mac-smoke"));
fs.mkdirSync(out, { recursive: true });
const mac = process.platform === "darwin";
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conv-mac-"));
const dataDir = path.join(scratch, "data");
fs.mkdirSync(path.join(scratch, ".claude"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true, termsAcceptedAt: new Date().toISOString(), syncAutomatically: false, startAtLogin: false }));
const env = launchEnv({ CLAUDE_CONFIG_DIR: path.join(scratch, ".claude"), CLAUDE_SYNC_HOME: path.join(scratch, "sync"), CONVERSATIONS_DATA_DIR: dataDir, CONVERSATIONS_TEST_NO_RELAUNCH: "1" });
// As the Finder starts an app: only the system's folders on PATH (the app reads the rest from the login shell).
if (mac) env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
delete env.CONVERSATIONS_LOGIN_PATH;

const app = await electron.launch({ args: [root], cwd: root, env, timeout: 90_000 });
try {
  const w = await app.firstWindow();
  await w.waitForSelector(".app", { timeout: 30_000 });
  await w.waitForTimeout(1500);

  const platform = await w.evaluate(() => document.body.dataset.platform);
  check("the window knows the system before it draws", platform === process.platform, platform);

  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  check("the Electron profile is inside the app's data folder", userData === path.join(dataDir, "electron"), userData);

  if (mac) {
    const mainPath = await app.evaluate(() => process.env.PATH);
    check("PATH has the usual Mac tool folders, not just the system's", /(^|:)\/opt\/homebrew\/bin(:|$)/.test(mainPath) && /(^|:)\/usr\/local\/bin(:|$)/.test(mainPath), mainPath);

    const menu = await app.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items ?? []).map((i) => ({ label: i.label, role: i.role, items: (i.submenu?.items ?? []).map((s) => s.role || s.label) })));
    const edit = menu.find((m) => m.role === "editmenu" || m.label === "Edit");
    check("the app menu has Edit, so Cmd+C and Cmd+V work", !!edit && ["copy", "paste", "selectall"].every((r) => edit.items.map((x) => String(x).toLowerCase()).includes(r)), JSON.stringify(menu.map((m) => m.label)));
    const first = menu[0]?.items ?? [];
    check("...its first menu has Settings and the app's own Quit", first.includes("Settings…") && first.some((x) => /^Quit /.test(String(x))), JSON.stringify(first));

    const buttons = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition?.() ?? null);
    check("the window buttons sit in the toolbar's middle", buttons?.x === 18 && buttons?.y === 19, JSON.stringify(buttons));
  }

  // Whichever toolbar is leftmost keeps clear of the Mac's buttons (and only on a Mac).
  const pad = await w.evaluate(() => {
    const bar = document.querySelector(".app:not(.collapsed) .sb-titlebar") ?? document.querySelector(".app.collapsed .list-toolbar");
    return bar ? parseFloat(getComputedStyle(bar).paddingLeft) : null;
  });
  check(mac ? "the leftmost toolbar keeps clear of the window buttons" : "the leftmost toolbar is as before", pad !== null && (mac ? pad >= 80 : pad < 40), String(pad));
  const right = await w.evaluate(() => getComputedStyle(document.body).getPropertyValue("--caption-buttons").trim());
  check(mac ? "nothing keeps clear of Windows' buttons on the right" : "the right keeps clear of Windows' buttons", mac ? right === "0px" : right === "138px", right);

  for (const theme of ["light", "dark"]) {
    await app.evaluate(({ nativeTheme }, t) => (nativeTheme.themeSource = t), theme);
    await w.waitForTimeout(600);
    await w.screenshot({ path: path.join(out, `main-${theme}.png`) });
  }
  // A narrow window: no sidebar, the list leftmost.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 700));
  await w.waitForTimeout(800);
  await w.screenshot({ path: path.join(out, "main-narrow-dark.png") });

  await w.evaluate(() => window.conversations.app.showSettings());
  const s = await app.waitForEvent("window", { timeout: 15_000 });
  await s.waitForSelector(".s-nav-title", { timeout: 15_000 });
  await s.waitForTimeout(800);
  check("Settings opens", true);
  await s.screenshot({ path: path.join(out, "settings-dark.png") });

  // The whole screen, so the window's own buttons show too (may need permission; not a check).
  if (mac) spawnSync("screencapture", ["-x", path.join(out, "screen.png")], { timeout: 15_000 });
} catch (e) {
  check("the run finished", false, (e && e.stack) || String(e));
} finally {
  await app.close().catch(() => {});
}
fs.rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
