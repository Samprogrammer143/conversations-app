// The composer per chat, in the real app against a scratch Claude folder (two copied
// conversations; nothing of yours is touched):
// - model and effort picked in one chat stay in that chat;
// - an unsent message stays with its chat when you move away, and after a restart;
// - "!" runs a shell command in the chat's folder and records it, with no turn.
//   node test/e2e/composer-state.e2e.mjs <transcript A> <transcript B> [shots dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [srcA, srcB] = process.argv.slice(2, 4);
const out = path.resolve(process.argv[4] ?? path.join(root, "test-results"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conv-composer-"));
const claudeDir = path.join(scratch, ".claude");
const dataDir = path.join(scratch, "data");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true }));
const sandboxModels = path.join(process.env.LOCALAPPDATA, "Conversations-dev", "data", "models.json");
if (fs.existsSync(sandboxModels)) fs.copyFileSync(sandboxModels, path.join(dataDir, "models.json"));
const copy = (src) => {
  const dir = path.join(claudeDir, "projects", path.basename(path.dirname(src)));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, path.basename(src));
  fs.copyFileSync(src, f);
  return { id: path.basename(src, ".jsonl"), file: f };
};
const A = copy(srcA);
const B = copy(srcB);

async function launch() {
  const app = await electron.launch({ args: [root], cwd: root, env: launchEnv({ CLAUDE_CONFIG_DIR: claudeDir, CONVERSATIONS_DATA_DIR: dataDir }), timeout: 60_000 });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1280, 860);
    w.show();
  });
  await win.waitForTimeout(3000);
  return { app, win };
}
const open = async (win, id) => {
  await win.evaluate((cid) => document.querySelector(`[data-id="${cid}"]`)?.click(), id);
  await win.waitForTimeout(900);
};
const chips = (win) =>
  win.evaluate(() => ({
    model: document.querySelector('button[aria-label="Model"]')?.textContent?.trim() ?? null,
    effort: document.querySelector('button[aria-label^="Effort"]')?.textContent?.trim() ?? null,
    text: document.querySelector('textarea[aria-label="Message"]')?.value ?? null,
  }));
const type = async (win, text) => {
  await win.click('textarea[aria-label="Message"]');
  await win.fill('textarea[aria-label="Message"]', text);
  await win.waitForTimeout(700);
};

let { app, win } = await launch();
try {
  await open(win, A.id);
  const before = await chips(win);
  // Pick a model other than the one shown, and an effort.
  await win.click('button[aria-label="Model"]');
  await win.waitForTimeout(400);
  const picked = await win.evaluate((shown) => {
    const items = [...document.querySelectorAll('.menu.choice [role="menuitemradio"]')];
    const other = items.find((b) => b.getAttribute("aria-checked") !== "true" && !b.textContent.includes(shown));
    const label = other?.querySelector(".text span")?.textContent ?? null;
    other?.click();
    return label;
  }, before.model);
  await win.waitForTimeout(300);
  await win.click('button[aria-label^="Effort"]');
  await win.waitForTimeout(300);
  await win.evaluate(() => [...document.querySelectorAll('.menu.choice [role="menuitemradio"]')].find((b) => b.textContent.startsWith("High"))?.click());
  await type(win, "draft for A, not sent");
  const a1 = await chips(win);
  check("chat A shows the model and effort picked for it", !!picked && a1.model === picked && a1.effort === "High", JSON.stringify({ picked, a1 }));

  await open(win, B.id);
  const b1 = await chips(win);
  check("chat B keeps its own model and effort", b1.model !== picked && b1.effort === "Effort", JSON.stringify(b1));
  check("chat B's message box is its own (empty)", b1.text === "", JSON.stringify(b1.text));
  await type(win, "draft for B");

  await open(win, A.id);
  const a2 = await chips(win);
  check("back in chat A: its unsent message is there", a2.text === "draft for A, not sent", JSON.stringify(a2.text));
  check("back in chat A: its model and effort are as picked", a2.model === picked && a2.effort === "High", JSON.stringify(a2));

  // "!" mode: the composer says what will happen, and the command runs and is recorded.
  await type(win, "! echo hello-from-shell && basename \"$PWD\"");
  const shellUi = await win.evaluate(() => ({ mode: document.querySelector(".composer")?.classList.contains("shell-mode"), hint: document.querySelector(".shell-hint")?.textContent ?? "", chips: !!document.querySelector('button[aria-label="Model"]') }));
  check("typing ! switches the composer to a shell command", shellUi.mode && shellUi.hint.includes("Shell command") && !shellUi.chips, JSON.stringify(shellUi));
  await win.screenshot({ path: path.join(out, "composer-shell-mode.png") });
  const linesBefore = fs.readFileSync(A.file, "utf8").split("\n").filter(Boolean).length;
  await win.press('textarea[aria-label="Message"]', "Enter");
  let shown = null;
  for (let i = 0; i < 40 && !shown?.out; i++) {
    await win.waitForTimeout(500);
    shown = await win.evaluate(() => {
      const runs = [...document.querySelectorAll(".shell-run")];
      const last = runs.at(-1);
      return last ? { cmd: last.querySelector(".shell-command")?.textContent ?? "", out: last.querySelector(".shell-output")?.textContent ?? "" } : null;
    });
  }
  check("the command and its output show in the conversation", !!shown && shown.cmd.includes("echo hello-from-shell") && shown.out.includes("hello-from-shell"), JSON.stringify(shown));
  const text = await win.evaluate(() => document.querySelector('textarea[aria-label="Message"]')?.value);
  check("the message box is empty after it ran", text === "", JSON.stringify(text));
  const entries = fs.readFileSync(A.file, "utf8").split("\n").filter(Boolean).slice(linesBefore).map((l) => JSON.parse(l));
  const bash = entries.filter((e) => typeof e.message?.content === "string" && e.message.content.startsWith("<bash-"));
  check("it is recorded the way the CLI records it", bash.length === 2 && bash[0].message.content.includes("echo hello-from-shell") && bash[1].message.content.startsWith("<bash-stdout>hello-from-shell"), JSON.stringify(bash.map((e) => e.message.content.slice(0, 60))));
  check("no turn ran (nothing was sent to Claude)", !entries.some((e) => e.type === "assistant"), `${entries.filter((e) => e.type === "assistant").length} replies`);
  await win.screenshot({ path: path.join(out, "composer-shell-result.png") });
  await win.evaluate(() => document.body.classList.add("solid"));
  const clip = await win.evaluate(() => {
    const r = document.querySelector(".shell-run:last-of-type")?.getBoundingClientRect() ?? document.querySelector(".detail").getBoundingClientRect();
    return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 20), width: r.width + 40, height: Math.min(r.height + 40, 600) };
  });
  await win.screenshot({ path: path.join(out, "shell-item.png"), clip });
  await win.evaluate(() => document.body.classList.remove("solid"));

  // A new chat whose first input is a long command: Stop works, and the chat is made with what it printed.
  await win.keyboard.press("Control+n");
  await win.waitForTimeout(800);
  const isDraft = await win.evaluate(() => document.querySelector(".detail")?.getAttribute("aria-label") === "New chat");
  check("Ctrl+N opens a new chat", isDraft);
  await type(win, "! echo first-line; sleep 25; echo never");
  await win.press('textarea[aria-label="Message"]', "Enter");
  let stopBtn = false;
  for (let i = 0; i < 20 && !stopBtn; i++) {
    await win.waitForTimeout(250);
    stopBtn = await win.evaluate(() => !!document.querySelector('.composer button.send.stop'));
  }
  const runningUi = await win.evaluate(() => ({ placeholder: document.querySelector('textarea[aria-label="Message"]')?.getAttribute("placeholder"), disabled: document.querySelector('textarea[aria-label="Message"]')?.disabled }));
  check("a running command in a new chat shows Stop", stopBtn && runningUi.disabled && runningUi.placeholder === "Running the command…", JSON.stringify(runningUi));
  await win.waitForTimeout(1500);
  const t0 = Date.now();
  await win.click(".composer button.send.stop");
  let made = null;
  for (let i = 0; i < 60 && !made?.out; i++) {
    await win.waitForTimeout(500);
    made = await win.evaluate(() => {
      const run = document.querySelector(".shell-run");
      return document.querySelector(".detail")?.getAttribute("aria-label") !== "New chat" && run ? { cmd: run.querySelector(".shell-command")?.textContent ?? "", out: run.querySelector(".shell-output")?.textContent ?? "" } : null;
    });
  }
  check("Stop ends it, and the new chat opens with what it printed", !!made && made.out.includes("first-line") && made.out.includes("Stopped in the Conversations app.") && !made.out.includes("never") && Date.now() - t0 < 25_000, JSON.stringify({ made, s: Math.round((Date.now() - t0) / 1000) }));
  await win.screenshot({ path: path.join(out, "new-chat-shell.png") });
} finally {
  await app.close();
}

// After a restart: the drafts and choices are still there.
({ app, win } = await launch());
try {
  await open(win, B.id);
  const b2 = await chips(win);
  check("after a restart, chat B's unsent message is there", b2.text === "draft for B", JSON.stringify(b2.text));
  await open(win, A.id);
  const a3 = await chips(win);
  check("after a restart, chat A's choices are still its own", a3.effort === "High", JSON.stringify(a3));
  // Dark mode picture of the shell item.
} finally {
  await app.close();
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
