// A real Claude Code chat through the app, in a scratch folder, on the smallest model: it
// starts real agents, the bar and panel follow them, one finishes and one is stopped.
//   node test/e2e/agents-real.e2e.mjs <scratch folder with "e2e" in its name> [folder for screenshots]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { collectE2eTranscripts, launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = path.resolve(process.argv[2]);
const shots = process.argv[3];
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, "fruit.txt"), "apple\npear\nplum\n");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

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
  const projectId = "folder:agents-e2e";
  await win.evaluate(({ projectId, scratch }) => window.conversations.settings.get().then((s) => window.conversations.settings.set({ folders: { ...s.folders, [projectId]: scratch } })), { projectId, scratch });
  const sent = await win.evaluate(
    (projectId) =>
      window.conversations.chat.send(
        null,
        "Do exactly this. Use the Agent tool twice, both with run_in_background true. First, description 'Count fruit': an agent that reads fruit.txt and replies with how many lines it has. Second, description 'Long job': an agent that runs the PowerShell command Get-Date forty times, as forty separate tool calls, one per message, and then replies done. Start them both, then reply with the single word: started. Do nothing else.",
        { projectId, model: "haiku", permissionMode: "default" },
      ),
    projectId,
  );
  check("a chat starts", sent.ok && sent.conversationId, JSON.stringify(sent));
  const id = sent.conversationId;
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("event:open-conversation", id), id);
  const status = () => win.evaluate((id) => window.conversations.chat.status(id), id);
  /** Waits for a condition on the chat's status, allowing whatever Claude asks for. */
  const until = async (test, ms = 150_000) => {
    const seen = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await status();
      if (s?.permission && !seen.has(s.permission.requestId)) {
        seen.add(s.permission.requestId);
        await win.evaluate(({ rid, d }) => window.conversations.chat.respond(rid, d), { rid: s.permission.requestId, d: s.permission.destructive ? "deny" : "allow" });
      }
      if (s && test(s)) return s;
      await win.waitForTimeout(300);
    }
    return status();
  };
  const of = (s, name) => s?.agents?.find((a) => a.description === name);

  let s = await until((x) => of(x, "Count fruit") && of(x, "Long job"));
  check("the app knows about both agents", of(s, "Count fruit") && of(s, "Long job"), JSON.stringify(s?.agents));
  await win.waitForSelector(".agent-bar", { timeout: 30_000 }).catch(() => {});
  const barName = await win.evaluate(() => document.querySelector(".agent-bar .name")?.textContent ?? null);
  check("the bar shows", !!barName, String(barName));
  await win.click(".agent-bar-open");
  await win.waitForSelector(".agent-panel", { timeout: 5000 });

  s = await until((x) => of(x, "Count fruit")?.status === "finished");
  check("the short one finishes", of(s, "Count fruit")?.status === "finished", JSON.stringify(of(s, "Count fruit")));
  await win.click('.agent-row:has-text("Count fruit")');
  await win.waitForFunction(() => document.querySelector(".agent-report")?.innerText.length > 0, null, { timeout: 15_000 }).catch(() => {});
  const reportText = await win.evaluate(() => document.querySelector(".agent-report")?.innerText ?? "");
  check("the panel shows its report", /3|three/i.test(reportText), reportText.slice(0, 160));
  const stats = await win.evaluate(() => document.querySelector(".agent-names .stats")?.textContent ?? "");
  check("...and how it went", /Finished/.test(stats) && /step/.test(stats), stats);
  await win.click('.agent-panel button:has-text("The brief Claude gave it")').catch(() => {});
  await win.waitForTimeout(150);
  check("...and its brief, from its real log", /fruit\.txt/.test(await win.evaluate(() => document.querySelector(".agent-brief")?.innerText ?? "")));
  if (shots) await win.screenshot({ path: path.join(shots, "agents-real-finished.png") });

  await win.click('.agent-row:has-text("Long job")');
  await win.waitForTimeout(600);
  s = await until((x) => (of(x, "Long job")?.steps ?? 0) > 0 && of(x, "Long job")?.line, 60_000);
  check("it's still running, with a step or two done", of(s, "Long job")?.status === "running", JSON.stringify(of(s, "Long job")));
  await win.waitForTimeout(800);
  const line = await win.evaluate(() => document.querySelector(".agent-line")?.textContent ?? "");
  check("the long one says what it's doing", !!line, line);
  if (shots) await win.screenshot({ path: path.join(shots, "agents-real-running.png") });
  await win.click('.agent-panel button:has-text("Stop")');
  s = await until((x) => of(x, "Long job")?.status !== "running", 40_000);
  check("Stop stops it", of(s, "Long job")?.status === "stopped", JSON.stringify(of(s, "Long job")));
  const chatAlive = await status();
  check("...and only it: the chat's session is still there", !!chatAlive && chatAlive.state !== "error", chatAlive?.state);
  if (shots) await win.screenshot({ path: path.join(shots, "agents-real-stopped.png") });
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
