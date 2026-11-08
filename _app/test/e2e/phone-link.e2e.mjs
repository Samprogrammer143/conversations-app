// The phone link end to end, in the sandbox: the sandbox app (the PC) joins a relay running
// here (cd relay && npm run dev), the phone app (dist-phone, in Chrome at a phone's size)
// asks to be allowed, the PC's "Allow this phone?" says yes, and the phone then lists the
// chats and opens one, through the relay.
//   node test/e2e/phone-link.e2e.mjs <shots dir> [ws://127.0.0.1:8787]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { _electron as electron, chromium } from "playwright";
import { launchEnv, sandboxEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "test-results"));
const relay = process.argv[3] ?? "ws://127.0.0.1:8787";
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000, step = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(step);
  }
  return null;
}

const devices = path.join(sandboxEnv.CLAUDE_SYNC_HOME, "repo", "_devices");
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const startedAt = Date.now();

// The phone app, served the way the Android app loads it (static files).
const dist = path.join(root, "dist-phone");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".map": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/$/, "/index.html"));
  if (!p.startsWith(dist) || !fs.existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" }).end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(5298, "127.0.0.1", r));

const app = await electron.launch({ args: [root], cwd: root, env: launchEnv({ CONVERSATIONS_RELAY_URL: relay, CONVERSATIONS_PHONE_LINK_DELAY_MS: "1500" }), colorScheme: "light", timeout: 60_000 });
let browser;
try {
  const win = await app.firstWindow();
  // "Allow this phone?" is the system's dialog: answered here, and what it said is kept.
  await app.evaluate(({ dialog }) => {
    globalThis.__asked = [];
    const real = dialog.showMessageBox;
    dialog.showMessageBox = async (...a) => {
      const opts = a.find((x) => x && typeof x === "object" && "buttons" in x);
      if (opts?.title === "Allow this phone?") {
        globalThis.__asked.push(opts.detail);
        return { response: globalThis.__answer ?? 0, checkboxChecked: false };
      }
      return real.apply(dialog, a);
    };
  });

  const relayCfg = await until(() => readJson(path.join(devices, "relay.json")), 40_000);
  check("the PC set up the workspace's room", !!relayCfg?.room && relayCfg.url === relay, JSON.stringify(relayCfg));
  const keys = await until(() => {
    try {
      return fs.readdirSync(path.join(devices, "keys")).map((f) => ({ slug: f.replace(/\.json$/, ""), ...readJson(path.join(devices, "keys", f)) })).filter((k) => k.key);
    } catch {
      return null;
    }
  }, 20_000);
  check("the PC published its key", keys?.length >= 1, keys?.map((k) => k.name).join(", "));

  const link = { name: "Sandbox", repo: "sandbox/standin", url: relayCfg.url, room: relayCfg.room, pcs: keys.map((k) => ({ slug: k.slug, name: k.name, key: k.key, device: k.device })) };
  browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 15; A065 Build/AP3A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36", colorScheme: "light" });
  const phone = await ctx.newPage();
  const logs = [];
  phone.on("console", (m) => logs.push(m.text()));
  phone.on("pageerror", (e) => logs.push(`ERROR ${e.message}`));
  await phone.goto(`http://127.0.0.1:5298/#link=${encodeURIComponent(Buffer.from(JSON.stringify(link)).toString("base64"))}`);

  const code = await until(() => phone.evaluate(() => document.querySelector(".phone-setup .code")?.getAttribute("aria-label")), 15_000);
  await phone.screenshot({ path: path.join(out, "phone-allow.png") });
  check("the phone shows its code while it waits", /^Code \d{4}$/.test(code ?? ""), code ?? "");

  // Before its request is on GitHub, the PC doesn't ask (a relay could have made it up).
  await wait(6000);
  const early = await app.evaluate(() => globalThis.__asked.length);
  check("without a request on GitHub the PC doesn't ask", early === 0, `${early} asked`);

  // The phone's request, as the phone writes it through GitHub (here, straight into the stand-in).
  const stored = await phone.evaluate(() => JSON.parse(localStorage.getItem("conversations.phone.key")));
  const raw = Buffer.from(stored.publicKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const id = Buffer.from(await crypto.subtle.digest("SHA-256", raw)).toString("base64url").slice(0, 22);
  const writeReq = (key) => {
    const changes = Buffer.from(JSON.stringify([{ path: `requests/${id}.json`, value: { id, key, name: "A065", at: new Date().toISOString() } }])).toString("base64");
    const r = spawnSync(process.execPath, [sandboxEnv.CONVERSATIONS_ENGINE, "devices-write", "--json", "--changes", changes], { env: launchEnv(), encoding: "utf8" });
    return r.stdout.trim().split("\n").pop();
  };
  // A request with a different key (someone else's) still gets no dialog.
  writeReq("BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await wait(9000);
  check("a request with another key gets no dialog either", (await app.evaluate(() => globalThis.__asked.length)) === 0);
  check("the phone's own request is written", /"ok":true/.test(writeReq(stored.publicKey)));

  const asked = await until(() => app.evaluate(() => globalThis.__asked.length && globalThis.__asked), 30_000);
  check("the PC asked whether to allow the phone", !!asked);
  check("…showing the same code", !!asked && asked[0].includes(code.slice(5).split("").join(" ")), asked?.[0]?.split("\n").find((l) => l.startsWith("Code")));

  const phoneFile = await until(() => {
    try {
      return fs.readdirSync(path.join(devices, "phones")).map((f) => readJson(path.join(devices, "phones", f))).find((r) => Date.parse(r?.allowedAt) >= startedAt - 1000);
    } catch {
      return null;
    }
  }, 20_000);
  check("allowing it recorded the phone for the other PCs", !!phoneFile?.key && phoneFile.allowedBy === "Home PC", phoneFile ? `${phoneFile.name}, by ${phoneFile.allowedBy}` : "");

  const rows = await until(() => phone.evaluate(() => document.querySelectorAll(".row").length), 30_000);
  await phone.screenshot({ path: path.join(out, "phone-list.png") });
  check("the phone lists the PC's chats", rows > 0, `${rows} rows`);

  if (rows) {
    await phone.locator(".row").nth(3).click();
    await wait(2500);
    const items = await until(() => phone.evaluate(() => document.querySelectorAll(".transcript .msg, .transcript [data-seq], .transcript > *").length), 20_000);
    await phone.screenshot({ path: path.join(out, "phone-chat.png") });
    check("a chat opens with its messages", items > 0, `${items} items`);
  }

  // The list's own buttons (M3): search, settings (M12), the workspace switcher (M11).
  await phone.locator(".detail-toolbar button[aria-label^='Back']").click().catch(() => {});
  await phone.waitForTimeout(500);
  await phone.click("button[aria-label=Search]");
  await phone.fill(".phone-search input", "colour");
  const hits = await until(() => phone.evaluate(() => document.querySelectorAll(".search-hit").length), 15_000);
  await phone.screenshot({ path: path.join(out, "phone-search.png") });
  check("search finds chats on the PC", hits > 0, `${hits} hits`);
  await phone.click(".phone-search button[aria-label=Back]");

  await phone.click("button[aria-label=Settings]");
  const awakeRow = await until(() => phone.evaluate(() => document.querySelector(".phone-settings button[role=switch][aria-label^='Keep']:not([disabled])") ? true : null), 15_000);
  await phone.screenshot({ path: path.join(out, "phone-settings.png") });
  check("settings show the PC's keep-awake switch", !!awakeRow);
  await phone.click(".phone-settings button[role=switch][aria-label^='Keep']");
  const awake = await until(async () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(sandboxEnv.CONVERSATIONS_DATA_DIR, "phone-link-settings.json"), "utf8")).keepAwake === true;
    } catch {
      return false;
    }
  }, 10_000);
  check("…and switching it on keeps the PC awake", awake);
  await phone.click(".phone-settings button[role=switch][aria-label^='Keep']");
  await phone.waitForTimeout(1500);
  await phone.click(".phone-settings button[aria-label=Back]");

  await phone.click("button[aria-label=Workspaces]");
  const wsRows = await until(() => phone.evaluate(() => document.querySelectorAll(".phone-sheet .sheet-row").length), 10_000);
  await phone.screenshot({ path: path.join(out, "phone-workspaces.png") });
  check("the workspace switcher lists the workspace and Sign in with another account", wsRows >= 2, `${wsRows} rows`);
  // Adding another GitHub account (M11a): its own sheet with the code (GitHub's replies stubbed here).
  let codeRequests = 0;
  let polls = 0;
  await phone.route("https://api.github.com/user", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ login: "ycs-test" }) }));
  await phone.route("https://api.github.com/user/repos**", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }));
  await phone.route("https://api.github.com/user/orgs", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify([{ login: "yacht-cloud" }]) }));
  await phone.route("https://github.com/login/device/code", (r) => (codeRequests++, r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ device_code: "d", user_code: "8DB1-A121", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) })));
  // Pending at first, then approved (as GitHub does once the code is entered).
  await phone.route("https://github.com/login/oauth/access_token", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(++polls < 2 ? { error: "authorization_pending" } : { access_token: "gho_test" }) }));
  await phone.locator(".phone-sheet .sheet-row", { hasText: "Add another GitHub account" }).click();
  const codeShown = await until(() => phone.evaluate(() => /[0-9]/.test(document.querySelector(".add-code .device-code")?.textContent ?? "") ? document.querySelector(".add-code .device-code").textContent : null), 10_000);
  await phone.screenshot({ path: path.join(out, "phone-add-account.png") });
  check("adding an account shows the code in its own sheet", codeShown === "8DB1-A121", String(codeShown));
  // Coming back from GitHub: a reconnect redraws what's behind; the sign-in carries on with the same code.
  await phone.evaluate(() => window.dispatchEvent(new Event("online")));
  const outcome = await until(() => phone.evaluate(() => document.querySelector(".add-card .title")?.textContent || null), 30_000);
  await phone.screenshot({ path: path.join(out, "phone-add-account-org.png") });
  check("after GitHub says yes it carries on (one code), and names the organisation", codeRequests === 1 && /yacht-cloud hasn't allowed/.test(outcome ?? ""), `${codeRequests} code(s); ${outcome}`);
  // Closed: the add-account sheet back to the switcher, then the switcher.
  for (let i = 0; i < 3 && (await phone.locator(".phone-sheet-scrim").count()); i++) {
    await phone.mouse.click(200, 60);
    await phone.waitForTimeout(400);
  }

  // New chat: the message box for it, in place of the list.
  await phone.click(".phone-fab");
  const draft = await until(() => phone.evaluate(() => !!document.querySelector(".detail textarea[aria-label=Message]") || null), 10_000);
  await phone.screenshot({ path: path.join(out, "phone-new-chat.png") });
  check("New chat opens a message box", !!draft);
  await phone.click(".detail-toolbar button[title^='Choose the project']");
  const projects = await until(() => phone.evaluate(() => document.querySelectorAll(".phone-sheet .sheet-row").length || null), 10_000);
  await phone.screenshot({ path: path.join(out, "phone-new-chat-project.png") });
  check("a new chat's Project lists the PC's projects", !!projects, `${projects} projects`);
  await phone.locator(".phone-sheet .sheet-row").first().click();
  await phone.click(".detail-toolbar.with-back button");
  const backToList = await until(() => phone.evaluate(() => document.querySelectorAll(".row").length || null), 10_000);
  check("…and back goes to the list", !!backToList);

  // Ask the PC something it mustn't do for a phone.
  const refused = await phone.evaluate(() => window.conversations.workspace.switch("main").then(() => "done", (e) => e.message));
  check("what only makes sense at the PC is refused", /can't be used from a phone/.test(refused), refused);
  const shell = await phone.evaluate(() => window.conversations.chat.send(null, "whoami", { shell: true }).then((r) => JSON.stringify(r), (e) => e.message));
  check("a phone can't run shell commands", /only run from the PC/.test(shell), shell);
  const folder = await phone.evaluate(() => window.conversations.chat.send(null, "hi", { folder: "C:\\Windows" }).then((r) => JSON.stringify(r), (e) => e.message));
  check("…nor start a chat in any folder", /starts on the PC/.test(folder), folder);
  const req = path.join(devices, "requests", `${id}.json`);
  check("allowing it took the request away", !fs.existsSync(req));

  // The message box in a chat: one line of controls, nothing under the bottom edge.
  await phone.locator(".row").first().click();
  await phone.waitForTimeout(2500);
  const box = await phone.evaluate(() => {
    const c = document.querySelector(".composer-controls");
    const r = c?.getBoundingClientRect();
    return r ? { h: Math.round(r.height), bottom: Math.round(r.bottom), vh: window.innerHeight } : null;
  });
  await phone.screenshot({ path: path.join(out, "phone-composer.png") });
  check("the message box's controls fit on one line, on screen", !!box && box.h <= 56 && box.bottom <= box.vh, JSON.stringify(box));
  // The + button: the phone's own picker; a photo becomes an attachment.
  const png = path.join(out, "attach-test.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const [chooser] = await Promise.all([phone.waitForEvent("filechooser", { timeout: 10_000 }), phone.click("button[aria-label^='Attach']")]);
  await chooser.setFiles(png);
  const attached = await until(() => phone.evaluate(() => document.querySelectorAll(".attach-chip").length || null), 10_000);
  check("the + button attaches a photo from the phone", !!attached, `${attached} attached`);
  await phone.locator(".attach-chip .remove").first().click().catch(() => {});

  await phone.click("button[aria-label=More]").catch(() => {});
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: path.join(out, "phone-menu.png") });
  await phone.keyboard.press("Escape");

  // Closing the app and opening it again: back in, by itself.
  await phone.reload();
  const again = await until(() => phone.evaluate(() => document.querySelectorAll(".row").length || null), 45_000);
  check("reopened, the app reconnects and lists the chats again", !!again, `${again} rows`);

  // A phone that writes itself into the allowed list (a removed one, or anyone with the GitHub
  // sign-in) isn't let in silently: this PC asks, saying where it was allowed.
  const before = await app.evaluate(() => globalThis.__asked.length);
  const ctx2 = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  await p2.goto(`http://127.0.0.1:5298/#link=${encodeURIComponent(Buffer.from(JSON.stringify(link)).toString("base64"))}`);
  await until(() => p2.evaluate(() => !!localStorage.getItem("conversations.phone.key")), 15_000);
  const k2 = await p2.evaluate(() => JSON.parse(localStorage.getItem("conversations.phone.key")).publicKey);
  const id2 = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(k2.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toString("base64url").slice(0, 22);
  const forged = Buffer.from(JSON.stringify([{ path: `phones/${id2}.json`, value: { id: id2, key: k2, name: "Other phone", allowedBy: "Uni PC", allowedAt: new Date().toISOString() } }])).toString("base64");
  spawnSync(process.execPath, [sandboxEnv.CONVERSATIONS_ENGINE, "devices-write", "--json", "--changes", forged], { env: launchEnv(), encoding: "utf8" });
  // Answered "Don't allow" this time.
  await app.evaluate(() => {
    globalThis.__answer = 1;
  });
  const asked2 = await until(() => app.evaluate((_electron, n) => globalThis.__asked.length > n && globalThis.__asked[globalThis.__asked.length - 1], before), 40_000);
  check("a phone only written into the list on GitHub is asked about here", !!asked2 && /You allowed ".+" on Uni PC/.test(asked2), asked2?.split("\n")[0]);
  const listed2 = await p2.evaluate(() => document.querySelectorAll(".row").length);
  check("…and saying no keeps it out", listed2 === 0, `${listed2} rows`);
  await ctx2.close();

  const errors = logs.filter((l) => l.startsWith("ERROR"));
  check("no errors on the phone", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser?.close();
  await app.close().catch(() => {});
  server.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
