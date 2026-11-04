// When GitHub can't be used, in the sandbox, with real git against a local server behind a
// login (nothing reaches GitHub or Claude). The window says what is really wrong, a problem
// with GitHub never stops a message, and Sign in puts it right.
//   node test/e2e/github-login.e2e.mjs [folder for screenshots]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shots = process.argv[2];
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-github-"));
const fwd = (p) => p.replace(/\\/g, "/");

// GitHub, on this PC.
const srv = path.join(T, "srv");
fs.mkdirSync(srv, { recursive: true });
spawnSync("git", ["init", "-q", "--bare", "-b", "main", path.join(srv, "chats.git")]);
const seed = path.join(T, "seed");
spawnSync("git", ["init", "-q", "-b", "main", seed]);
fs.writeFileSync(path.join(seed, "README.md"), "chats\n");
spawnSync("git", ["-C", seed, "add", "-A"]);
spawnSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "start"]);
spawnSync("git", ["-C", seed, "push", "-q", path.join(srv, "chats.git"), "main"]);
const server = spawn(process.execPath, [path.join(root, "..", "_sync", "fixtures", "git-http-server.mjs"), srv, "me", "right-password"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((resolve) => server.stdout.once("data", (d) => resolve(String(d).trim())));
const base = `http://127.0.0.1:${port}`;

// This PC's usual login gives nothing. The one Sign in reaches is empty until its window is
// finished, which only a sign-in can open, and from then on is saved, as a real one is.
const globalConfig = path.join(T, "gitconfig");
fs.writeFileSync(globalConfig, `[credential "${base}"]\n\tusername = me\n\thelper =\n\thelper = \"!f() { exit 0; }; f\"\n[user]\n\tname = t\n\temail = t@example.com\n`);
const finished = path.join(T, "finished");
const saved = path.join(T, "saved");
const login = path.join(T, "login.cjs");
const asks = path.join(T, "asks");
fs.writeFileSync(login, `const fs = require("fs");\nif (process.argv[2] === "get") fs.appendFileSync(${JSON.stringify(asks)}, "x");\nif (process.argv[2] === "get") {\n  if (process.env.GCM_INTERACTIVE !== "never" && fs.existsSync(${JSON.stringify(finished)})) fs.writeFileSync(${JSON.stringify(saved)}, "");\n  if (fs.existsSync(${JSON.stringify(saved)})) process.stdout.write("username=me\\npassword=right-password\\n");\n}\n`);
const askCount = () => (fs.existsSync(asks) ? fs.readFileSync(asks, "utf8").length : 0);
const helper = `!node "${fwd(login)}"`;

const claudeDir = path.join(T, ".claude");
const dataDir = path.join(T, "data");
const syncHome = path.join(T, "sync");
const repo = path.join(syncHome, "repo");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(syncHome, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true, syncAutomatically: true, startAtLogin: false }));
fs.writeFileSync(path.join(syncHome, "config.json"), JSON.stringify({ remote: `${base}/chats.git`, machine: "Test PC" }));
const key = `credential.${base}.helper`;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
spawnSync("git", ["-c", `${key}=`, "-c", `${key}=!f() { echo username=me; echo password=right-password; }; f`, "clone", "-q", `${base}/chats.git`, repo], { env: gitEnv });

// A chat to send from.
const ID = "aaaaaaaa-1111-4111-8111-111111111111";
const cwd = path.join(T, "work");
fs.mkdirSync(cwd, { recursive: true });
const dir = path.join(claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
fs.mkdirSync(dir, { recursive: true });
const line = (type, n) => JSON.stringify({ type, uuid: `${ID}-${n}`, parentUuid: n ? `${ID}-${n - 1}` : null, sessionId: ID, cwd, timestamp: new Date(Date.now() + n).toISOString(), entrypoint: "cli", message: type === "user" ? { role: "user", content: "A chat" } : { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }] } });
fs.writeFileSync(path.join(dir, `${ID}.jsonl`), `${line("user", 0)}\n${line("assistant", 1)}\n`);

const env = launchEnv({
  CLAUDE_CONFIG_DIR: claudeDir,
  CONVERSATIONS_DATA_DIR: dataDir,
  CLAUDE_SYNC_HOME: syncHome,
  CONVERSATIONS_LAUNCHER_DIR: path.join(T, "bin"),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  CLAUDE_SYNC_TEST_LOGIN_HELPER: helper,
});
const app = await electron.launch({ args: [root], cwd: root, env, timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await win.setViewportSize({ width: 1100, height: 720 }).catch(() => {});
  const shot = async (name) => {
    if (shots) await win.screenshot({ path: path.join(shots, `${name}.png`) });
  };
  const banner = () => win.evaluate(() => document.querySelector(".list-banner .banner .title")?.textContent ?? null);
  const until = async (want, ms = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if ((await banner()) === want) return true;
      await win.waitForTimeout(150);
    }
    return false;
  };
  const box = 'textarea[aria-label="Message"]';
  const sendFits = (width) =>
    win.setViewportSize({ width, height: 720 }).then(() => win.waitForTimeout(150)).then(() =>
      win.evaluate(() => {
        const send = document.querySelector('button[aria-label="Send (Enter)"]').getBoundingClientRect();
        const composer = document.querySelector(".composer-controls").getBoundingClientRect();
        return send.width > 0 && send.left >= composer.left && send.right <= composer.right;
      }),
    );
  const sendOff = async () => {
    await win.fill(box, "a message");
    const off = await win.evaluate(() => document.querySelector('button[aria-label="Send (Enter)"]').disabled);
    await win.fill(box, "");
    return off;
  };

  await win.waitForSelector(".row, [data-id]", { timeout: 20000 }).catch(() => {});
  await win.waitForTimeout(1000);
  await win.getByText("A chat").first().click();
  await win.waitForSelector(box, { timeout: 15000 });

  // GitHub refuses the login.
  check("a refused login says sign in", await until("GitHub needs you to sign in"), await banner());
  const text = await win.evaluate(() => document.body.innerText);
  check("...and nowhere says offline", !/offline/i.test(text));
  check("...and doesn't stop a message", !(await sendOff()));
  await shot("signin-banner");

  // It doesn't blink while the app looks again.
  await win.evaluate(() => {
    globalThis.bannerGone = 0;
    globalThis.bannerWatch = setInterval(() => {
      if (!document.querySelector(".list-banner .banner")) globalThis.bannerGone++;
    }, 15);
  });
  const looks = askCount();
  const lookStart = Date.now();
  while (askCount() === looks && Date.now() - lookStart < 15000) {
    await win.evaluate(() => window.conversations.sync.now());
    await win.waitForTimeout(300);
  }
  const gone = await win.evaluate(() => {
    clearInterval(globalThis.bannerWatch);
    return globalThis.bannerGone;
  });
  check("the banner stays put while the app looks again", gone === 0 && askCount() > looks, `gone ${gone} times, ${askCount() - looks} looks`);

  // The sync menu says the same.
  await win.click("button.sync-status");
  await win.waitForTimeout(500);
  const popover = await win.evaluate(() => document.querySelector(".sync-popover")?.innerText ?? "");
  if (popover) {
    check("the sync menu says so too, with Sign in", /Sign in to GitHub/.test(popover) && /refused this (PC|Mac)'s login/.test(popover) && /Sign in/.test(popover), popover.slice(0, 120));
    await shot("signin-popover");
    await win.keyboard.press("Escape");
    await win.waitForTimeout(200);
  } else check("the sync menu opens", false);

  // A sign-in that isn't finished.
  await win.click('.list-banner button:has-text("Sign in")');
  await win.waitForFunction(() => document.body.innerText.includes("didn't finish"), null, { timeout: 30000 }).catch(() => {});
  check("a sign-in that isn't finished says so", await win.evaluate(() => document.body.innerText.includes("didn't finish")));
  check("...and the banner stays", (await banner()) === "GitHub needs you to sign in", await banner());

  // One that is.
  fs.writeFileSync(finished, "");
  await win.click('.list-banner button:has-text("Sign in")');
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && (await banner())) await win.waitForTimeout(150);
  check("a finished sign-in clears it", (await banner()) === null, await banner());
  const pinned = spawnSync("git", ["-C", repo, "config", "--local", "--get-all", key], { env: gitEnv, encoding: "utf8" }).stdout;
  check("...for this repository", pinned.includes(helper), pinned.trim());
  await win.waitForFunction(() => document.body.innerText.includes("Up to date"), null, { timeout: 20000 }).catch(() => {});
  check("...and the app is up to date again", await win.evaluate(() => document.body.innerText.includes("Up to date")));
  const after = askCount();
  const afterStart = Date.now();
  while (askCount() === after && Date.now() - afterStart < 15000) {
    await win.evaluate(() => window.conversations.sync.now());
    await win.waitForTimeout(300);
  }
  await win.waitForTimeout(1500);
  check("...and stays that way at the next look, with no window", (await banner()) === null && askCount() > after, await banner());

  // GitHub stops answering, with the PC's network fine.
  server.kill();
  await win.waitForTimeout(500);
  await win.evaluate(() => window.conversations.sync.now());
  check("GitHub not answering says just that", await until("Can't reach GitHub right now"), await banner());
  check("...and doesn't stop a message", !(await sendOff()));
  await shot("github-down");

  // No network at all.
  await app.evaluate(({ net }) => {
    globalThis.realIsOnline = net.isOnline;
    net.isOnline = () => false;
  });
  await win.evaluate(() => window.conversations.sync.now());
  check("no network says offline", await until("You're offline"), await banner());
  check("...and stops a message, because Claude can't be reached either", await sendOff());
  check("...and the message box says so", (await win.evaluate(() => document.querySelector(".composer-controls .context")?.textContent)) === "Offline");
  // (Narrower than this the chat has the whole window to itself.)
  for (const width of [1500, 1250, 1180, 1100, 1000, 900]) check(`...with Send still in the box ${width} wide`, await sendFits(width));
  // The longest labels there are, and longer.
  const labels = await win.evaluate(() => [...document.querySelectorAll(".composer-controls .chip-label")].map((l) => {
    const was = l.textContent;
    l.textContent = "A very long label indeed";
    return was;
  }));
  for (const width of [1500, 1250, 1180, 1100, 1000, 900]) check(`...and with long labels ${width} wide`, await sendFits(width));
  await win.evaluate((was) => document.querySelectorAll(".composer-controls .chip-label").forEach((l, i) => (l.textContent = was[i])), labels);
  await sendFits(1100);
  await win.fill(box, "a message");
  await win.press(box, "Enter");
  await win.waitForTimeout(300);
  check("...and Enter doesn't send it either", (await win.inputValue(box)) === "a message", await win.inputValue(box));
  check("...and says why", await win.evaluate(() => document.body.innerText.includes("Send is off until you reconnect")));
  await win.fill(box, "! echo hi");
  check("...though a ! command, which needs no network, still can", await win.evaluate(() => !document.querySelector('button[aria-label="Send (Enter)"]').disabled));
  await win.fill(box, "");
  await shot("offline");
  await app.evaluate(({ net }) => {
    net.isOnline = globalThis.realIsOnline;
  });
  await win.evaluate(() => window.dispatchEvent(new Event("online")));
  check("the network coming back lifts that, without waiting for the sync", await until("Can't reach GitHub right now", 3000), await banner());
  check("...and Send with it", !(await sendOff()));
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
  server.kill();
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
