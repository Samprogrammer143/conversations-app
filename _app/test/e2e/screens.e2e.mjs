// Captures every screen of the app in the development sandbox, for comparing
// with the Figma frames.   node test/e2e/screens.e2e.mjs <out dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv, sandboxEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2]);
fs.mkdirSync(out, { recursive: true });
const settingsFile = path.join(sandboxEnv.CONVERSATIONS_DATA_DIR, "settings.json");
const saved = fs.readFileSync(settingsFile, "utf8");

async function session({ dark = false, width = 1440, height = 900 }, fn) {
  const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: dark ? "dark" : "light", timeout: 60_000 });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => console.log(`[page:error] ${e.message}`));
  await app.evaluate(({ BrowserWindow, nativeTheme }, { width, height, dark }) => {
    nativeTheme.themeSource = dark ? "dark" : "light";
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setContentSize(width, height);
    w.show();
  }, { width, height, dark });
  await win.waitForTimeout(2500);
  const shot = async (name, page = win, wait = 500) => {
    await page.waitForTimeout(wait);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(`saved ${name}`);
  };
  // The sandbox holds whatever chats it was given: pick rows by position, never by title.
  const open = (index = 0) => win.evaluate((i) => [...document.querySelectorAll(".row")][i]?.click(), index);
  try {
    await fn({ app, win, shot, open });
  } finally {
    await app.close();
  }
}

try {
  fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(saved), windowMaterial: "solid", welcomed: true }));

  await session({}, async ({ app, win, shot, open }) => {
    await open(0);
    await shot("S1-light", win, 1500);
    await win.evaluate(() => window.dispatchEvent(new Event("app:focus-search")));
    await win.keyboard.type("the", { delay: 25 });
    await shot("S3-search", win, 700);
    await win.keyboard.press("Escape");
    await win.keyboard.press("Escape");
    await win.click(".sync-status");
    await shot("S4-sync-popover", win, 600);
    await win.keyboard.press("Escape");
    await win.evaluate(() => {
      const r = [...document.querySelectorAll(".row")][1];
      r?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 520, clientY: 640 }));
    });
    await shot("context-menu", win, 500);
    await win.keyboard.press("Escape");
    await win.mouse.click(1100, 400);
    await win.keyboard.down("Control");
    await shot("S8-hold-ctrl", win, 1100);
    await win.keyboard.up("Control");
    await win.click('.segment:has-text("Updated")');
    await shot("empty-updated", win, 600);
    await win.click('.segment:has-text("All")');
    await win.click('.list-toolbar [aria-label^="New chat"]');
    await shot("new-chat-draft", win, 700);
    // Settings (S5) and the tray flyout (S7) are their own windows.
    await win.evaluate(() => window.conversations.app.showSettings("sync"));
    const settingsWin = await app.waitForEvent("window");
    await settingsWin.waitForLoadState("domcontentloaded");
    await shot("S5-settings-sync", settingsWin, 1500);
    await win.evaluate(() => window.conversations.app.toggleFlyout());
    const fly = await app.waitForEvent("window");
    await fly.waitForLoadState("domcontentloaded");
    await shot("S7-flyout", fly, 1500);
  });

  // S6: on first run the welcome window opens on its own; Get started opens the main window.
  {
    const setWelcomed = (v) => fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsFile, "utf8")), welcomed: v }));
    setWelcomed(false);
    const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
    try {
      const w = await app.firstWindow();
      await w.waitForTimeout(2500);
      const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((x) => x.getContentBounds()));
      console.log(`windows on first run: ${JSON.stringify(size)}`);
      await w.screenshot({ path: path.join(out, "S6-welcome.png") });
      console.log("saved S6-welcome");
      const next = app.waitForEvent("window", { timeout: 15_000 });
      await w.evaluate(() => document.querySelector(".welcome-window .btn-primary")?.click());
      const main = await next;
      await main.waitForTimeout(1500);
      console.log(`after Get started: ${await main.evaluate(() => document.body.dataset.window)} window, welcome sheet ${await main.evaluate(() => !!document.querySelector(".sheet"))}`);
    } finally {
      await app.close();
      setWelcomed(true);
    }
  }

  await session({ dark: true }, async ({ win, shot, open }) => {
    await open(0);
    await shot("S1-dark", win, 1500);
    await win.evaluate(() => window.dispatchEvent(new Event("app:focus-search")));
    await win.keyboard.type("the", { delay: 25 });
    await shot("S3-search-dark", win, 700);
    await win.keyboard.press("Escape");
    await win.keyboard.press("Escape");
    await win.click(".sync-status");
    await shot("S4-sync-popover-dark", win, 600);
    await win.keyboard.press("Escape");
  });

  await session({ width: 960, height: 900 }, async ({ win, shot, open }) => {
    await open(0);
    await shot("S9-960", win, 1500);
  });

  await session({ width: 820, height: 760 }, async ({ win, shot }) => {
    await shot("stacked-820-list", win, 800);
    await win.evaluate(() => [...document.querySelectorAll(".row")][1]?.click());
    await win.keyboard.press("Enter");
    await shot("stacked-820-detail", win, 1200);
  });
} finally {
  fs.writeFileSync(settingsFile, saved);
}
