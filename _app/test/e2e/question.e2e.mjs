// Claude's questions (AskUserQuestion) through the app, against this PC's real Claude Code
// in a scratch folder (short Haiku turns; the test chats are moved into the sandbox after):
// - the question shows as a card with its options, not Allow/Deny;
// - picking an option and sending hands the answer to Claude, which uses it;
// - a written answer works too, and Skip lets Claude carry on.
//   node test/e2e/question.e2e.mjs <scratch folder> [shots dir]
import fs from "node:fs";
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

const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1320, 900);
    w.show();
  });
  await win.waitForTimeout(2500);
  const projectId = "folder:question-e2e";
  await win.evaluate(({ projectId, scratch }) => window.conversations.settings.get().then((s) => window.conversations.settings.set({ folders: { ...s.folders, [projectId]: scratch } })), { projectId, scratch });
  const waitFor = async (fn, arg, ms = 20_000) => {
    const t0 = Date.now();
    let v = null;
    while (Date.now() - t0 < ms) {
      v = await win.evaluate(fn, arg);
      if (v) return v;
      await win.waitForTimeout(400);
    }
    return v;
  };
  // Claude's last reply on screen once it shows what it was asked for (the window catches up a moment after the turn ends).
  const replyMatching = async (re) => {
    await waitFor((cid) => window.conversations.chat.status(cid).then((s) => (s?.state === "idle" ? true : null)), id, 90_000);
    const texts = () => win.evaluate(() => [...document.querySelectorAll(".claude")].map((e) => e.textContent ?? ""));
    for (let i = 0; i < 40; i++) {
      const hit = (await texts()).reverse().find((t) => re.test(t));
      if (hit) return hit;
      await win.waitForTimeout(500);
    }
    return (await texts()).at(-1) ?? "";
  };
  const ask = "Use the AskUserQuestion tool now to ask me one question: which colour do I prefer, with exactly the options Red and Blue (header: Colour). After I answer, reply with only the colour I chose, in capitals, and nothing else.";
  const sent = await win.evaluate(({ projectId, ask }) => window.conversations.chat.send(null, ask, { projectId, model: "haiku", permissionMode: "default" }), { projectId, ask });
  check("a chat starts", sent.ok && !!sent.conversationId, JSON.stringify(sent));
  const id = sent.conversationId;
  for (let i = 0; i < 30; i++) {
    if (await win.evaluate((cid) => !!document.querySelector(`[data-id="${cid}"]`), id)) break;
    await win.waitForTimeout(1000);
  }
  await win.evaluate((cid) => document.querySelector(`[data-id="${cid}"]`)?.click(), id);

  // The question card.
  const card = await waitFor(() => {
    const c = document.querySelector(".permission.question");
    return c ? { title: c.querySelector(".title")?.textContent, options: [...c.querySelectorAll(".q-label")].map((x) => x.textContent), allow: [...c.querySelectorAll("button")].some((b) => /Allow/.test(b.textContent)) } : null;
  }, null, 90_000);
  check("Claude's question shows as a card with its options, not Allow/Deny", !!card && card.options.includes("Red") && card.options.includes("Blue") && !card.allow, JSON.stringify(card));
  await win.screenshot({ path: path.join(out, "question-card.png") });
  const status = await win.evaluate((cid) => window.conversations.chat.status(cid), id);
  check("the chat says it is waiting for your answer", status?.state === "waiting-approval" && !!status.permission?.questions, status?.state);
  const sendDisabled = await win.evaluate(() => [...document.querySelectorAll(".permission.question button")].find((b) => /Send answer/.test(b.textContent))?.disabled);
  check("Send waits until it is answered", sendDisabled === true);

  // Pick Blue and send.
  await win.evaluate(() => [...document.querySelectorAll(".permission.question .q-option")].find((b) => b.querySelector(".q-label")?.textContent === "Blue")?.click());
  await win.waitForTimeout(200);
  await win.screenshot({ path: path.join(out, "question-picked.png") });
  await win.evaluate(() => [...document.querySelectorAll(".permission.question button")].find((b) => /Send answer/.test(b.textContent))?.click());
  const gone = await waitFor(() => !document.querySelector(".permission.question"), null, 10_000);
  check("sending closes the card", !!gone);
  const reply = await replyMatching(/blue/i);
  check("Claude gets the answer and uses it", /blue/i.test(reply) && !/red/i.test(reply), reply.slice(0, 120));

  // A written answer.
  await win.click('textarea[aria-label="Message"]');
  await win.fill('textarea[aria-label="Message"]', "Ask me the same question again with the AskUserQuestion tool, same options. Then reply with only my answer in capitals.");
  await win.press('textarea[aria-label="Message"]', "Enter");
  const card2 = await waitFor(() => !!document.querySelector(".permission.question .q-other"), null, 90_000);
  check("a second question shows", !!card2);
  await win.fill(".permission.question .q-other", "Green");
  await win.press(".permission.question .q-other", "Enter");
  const reply2 = await replyMatching(/green/i);
  check("a written answer reaches Claude too", /green/i.test(reply2), reply2.slice(0, 120));

  // Skip.
  await win.fill('textarea[aria-label="Message"]', "Ask me one more question with the AskUserQuestion tool (any two options). If I don't answer, reply with only the word SKIPPED.");
  await win.press('textarea[aria-label="Message"]', "Enter");
  const card3 = await waitFor(() => !!document.querySelector(".permission.question"), null, 90_000);
  check("a third question shows", !!card3);
  await win.evaluate(() => [...document.querySelectorAll(".permission.question button")].find((b) => b.textContent.trim() === "Skip")?.click());
  const reply3 = await replyMatching(/skipped/i);
  check("Skip lets Claude carry on", /skipped/i.test(reply3), reply3.slice(0, 120));
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
  try {
    const moved = collectE2eTranscripts(scratch);
    console.log(`moved ${moved.length} test conversation folder(s) into the sandbox`);
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
