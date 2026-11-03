// A real Claude Code chat through the app, in a scratch folder, on the smallest model:
// a message typed while Claude works is read at its next step and shows in the chat; one
// typed and then stopped goes back to the message box. Never a bubble stuck at the bottom.
//   node test/e2e/followups-real.e2e.mjs <scratch folder with "e2e" in its name> [folder for screenshots]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { collectE2eTranscripts, launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = path.resolve(process.argv[2]);
const shots = process.argv[3];
fs.mkdirSync(scratch, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const SLOW = "Run the PowerShell command Get-Date eight times, as eight separate tool calls, one per message. Then reply with the single word: finished.";

const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "dark", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  win.on("pageerror", (e) => check("no error in the window", false, e.message));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1440, 900);
    w.show();
  });
  await win.waitForTimeout(2500);
  const projectId = "folder:followups-e2e";
  await win.evaluate(({ projectId, scratch }) => window.conversations.settings.get().then((s) => window.conversations.settings.set({ folders: { ...s.folders, [projectId]: scratch } })), { projectId, scratch });
  const sent = await win.evaluate(({ projectId, SLOW }) => window.conversations.chat.send(null, SLOW, { projectId, model: "haiku", permissionMode: "auto" }), { projectId, SLOW });
  check("a chat starts", sent.ok && sent.conversationId, JSON.stringify(sent));
  const id = sent.conversationId;
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("event:open-conversation", id), id);
  await win.waitForSelector('textarea[aria-label="Message"]', { timeout: 20_000 });
  const status = () => win.evaluate((id) => window.conversations.chat.status(id), id);
  const until = async (test, ms = 120_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await status();
      if (s?.permission) await win.evaluate((rid) => window.conversations.chat.respond(rid, "allow"), s.permission.requestId);
      if (s && test(s)) return s;
      await win.waitForTimeout(250);
    }
    return status();
  };
  const stuck = () => win.evaluate(() => [...document.querySelectorAll(".transcript .you.sent")].map((b) => b.textContent?.trim()));
  const inChat = (t) => win.evaluate((t) => [...document.querySelectorAll(".transcript .you:not(.sent) .bubble")].some((b) => b.textContent?.includes(t)), t);
  const box = 'textarea[aria-label="Message"]';

  // 1. Typed while Claude works: read at its next step.
  await until((s) => s.state === "running-tool");
  await win.waitForTimeout(1500);
  check("Claude is mid-task", ["running-tool", "thinking", "writing"].includes((await status())?.state), (await status())?.state);
  await win.fill(box, "Also add the word banana to your final reply.");
  await win.press(box, "Enter");
  await win.waitForTimeout(300);
  check("it shows as sent", (await stuck()).some((t) => t.includes("banana")), JSON.stringify(await stuck()));
  let s = await until((x) => !x.queued.length, 30_000);
  check("Claude reads it before finishing its task", !s.queued.length && ["running-tool", "thinking", "writing"].includes(s.state), `${s.state}, ${s.queued.length} unread`);
  await win.waitForFunction(() => ![...document.querySelectorAll(".transcript .you.sent")].length, null, { timeout: 30_000 }).catch(() => {});
  check("...and it moves into the chat where Claude read it", (await stuck()).length === 0 && (await inChat("banana")), JSON.stringify(await stuck()));
  if (shots) await win.screenshot({ path: path.join(shots, "followup-read.png") });
  s = await until((x) => x.state === "idle", 120_000);
  await win.waitForTimeout(1500);
  const reply = await win.evaluate(() => [...document.querySelectorAll(".transcript .claude")].map((c) => c.textContent).join(" "));
  check("Claude did what it said", /banana/i.test(reply), reply.slice(-160));
  check("nothing stuck at the bottom", (await stuck()).length === 0, JSON.stringify(await stuck()));

  // A slash command sent while Claude is idle is seen through too: nothing left waiting, nothing handed back.
  await win.fill(box, "/cost");
  await win.press(box, "Enter");
  s = await until((x) => x.state === "idle" && !x.queued.length, 30_000);
  await win.waitForTimeout(1500);
  check("a slash command leaves nothing waiting", s.state === "idle" && !s.queued.length && !(await win.evaluate(() => document.body.innerText.includes("back in the message box"))), `${s.state}, ${s.queued.length} waiting`);

  // 2. Typed, then stopped at once: back in the message box (or read, if Claude got there first).
  await win.fill(box, SLOW);
  await win.press(box, "Enter");
  await until((x) => x.state === "running-tool");
  await win.waitForTimeout(1200);
  await win.fill(box, "Say kiwi as well.");
  await win.press(box, "Enter");
  await win.press(box, "Escape");
  await until((x) => x.state === "idle" || x.state === "error", 30_000);
  await win.waitForTimeout(7000);
  const left = await win.inputValue(box);
  const read = await inChat("kiwi");
  check("stopped: the message is back in the box or in the chat, never lost", left.includes("Say kiwi as well.") || read, `box: ${JSON.stringify(left)}, in chat: ${read}`);
  console.log(`   (${left.includes("kiwi") ? "it was handed back" : "Claude read it before the Stop landed"})`);
  check("...and nothing stuck at the bottom", (await stuck()).length === 0, JSON.stringify(await stuck()));
  check("...and the Stop you asked for isn't shown as an error", await win.evaluate(() => !document.querySelector(".notice.error")), await win.evaluate(() => document.querySelector(".notice.error")?.textContent ?? ""));
  if (left.includes("kiwi")) check("...with a word on why", await win.evaluate(() => document.body.innerText.includes("back in the message box")));
  if (shots) await win.screenshot({ path: path.join(shots, "followup-stopped.png") });
  await win.fill(box, "");
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
  try {
    console.log("moved out of your real chats:", JSON.stringify(collectE2eTranscripts(scratch)));
  } catch (e) {
    console.log("could not move the test chat:", e.message);
  }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
