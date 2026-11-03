// The agents bar and panel in the real app, in a scratch Claude folder with real agent logs;
// what Claude Code reports is stood in for, so nothing reaches Claude.
//   node test/e2e/agents.e2e.mjs [folder for screenshots]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-agents-"));
const claudeDir = path.join(T, ".claude");
const dataDir = path.join(T, "data");
const syncHome = path.join(T, "sync");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true, syncAutomatically: false, startAtLogin: false }));
fs.mkdirSync(syncHome, { recursive: true });
fs.writeFileSync(path.join(syncHome, "config.json"), JSON.stringify({ remote: path.join(T, "none.git"), machine: "Test PC" }));

const ID = "aaaaaaaa-1111-4111-8111-111111111111";
const cwd = path.join(T, "work");
fs.mkdirSync(cwd, { recursive: true });
const dir = path.join(claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
fs.mkdirSync(dir, { recursive: true });
const line = (type, n, content) => JSON.stringify({ type, uuid: `${ID}-${n}`, parentUuid: n ? `${ID}-${n - 1}` : null, sessionId: ID, cwd, timestamp: new Date(Date.now() + n).toISOString(), entrypoint: "cli", message: type === "user" ? { role: "user", content } : { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: content }] } });
fs.writeFileSync(path.join(dir, `${ID}.jsonl`), `${line("user", 0, "Can you redo the Göcek research here?")}\n${line("assistant", 1, "The Göcek research is running now. It should take about 20 minutes.")}\n`);

// The agents' own logs, where Claude Code keeps them.
const subs = path.join(dir, ID, "subagents");
fs.mkdirSync(subs, { recursive: true });
const t = (s) => new Date(Date.parse("2026-11-03T10:00:00Z") + s * 1000).toISOString();
const au = (i, name, input) => JSON.stringify({ type: "assistant", isSidechain: true, timestamp: t(i * 2), message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name, input }] } });
const res = (i) => JSON.stringify({ type: "user", isSidechain: true, timestamp: t(i * 2 + 1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] } });
const brief = (s) => JSON.stringify({ type: "user", isSidechain: true, timestamp: t(0), message: { role: "user", content: s } });
const said = (s) => JSON.stringify({ type: "assistant", isSidechain: true, timestamp: t(999), message: { role: "assistant", content: [{ type: "text", text: s }] } });
const steps = [["WebSearch", { query: "sea temperature Göcek by month" }], ["WebFetch", { url: "https://mgm.gov.tr/veridegerlendirme/deniz-suyu" }], ["Bash", { command: "pdftotext kaunos.pdf" }], ["Read", { file_path: "C:\\work\\kaunos.txt" }]];
const goc = path.join(subs, "agent-a1.jsonl");
fs.writeFileSync(goc, `${[brief("Research Göcek for the port page."), ...steps.flatMap(([n, inp], i) => [au(i + 1, n, inp), res(i + 1)]), au(9, "WebFetch", { url: "https://mgm.gov.tr/deniz-suyu-sicakliklari" })].join("\n")}\n`);
const many = [brief("Research Bodrum.")];
for (let i = 1; i <= 40; i++) many.push(au(i, "Read", { file_path: `file${i}.txt` }), res(i));
fs.writeFileSync(path.join(subs, "agent-a2.jsonl"), `${many.join("\n")}\n`);
fs.writeFileSync(path.join(subs, "agent-a3.jsonl"), `${[brief("Check the sitemap."), au(1, "Read", { file_path: "sitemap.xml" }), res(1), au(2, "SubagentHandback", { message: "## Sitemap\n\nThree pages were **removed**.\n\n```\nsitemap.xml\n```" }), res(2)].join("\n")}\n`);

const now = Date.now();
const MIN = 60_000;
const running = { id: "a1", description: "Göcek research", type: "general-purpose", status: "running", line: "Checking sea temperatures against the Turkish weather service", steps: 5, startedAt: now - 27 * MIN, endedAt: null };
const bodrum = { id: "a2", description: "Bodrum research", type: "general-purpose", status: "running", line: "Searching the web", steps: 40, startedAt: now - 9 * MIN, endedAt: null };
const sitemap = { id: "a3", description: "Sitemap check", type: "general-purpose", status: "finished", line: null, steps: 1, startedAt: now - 3 * MIN, endedAt: now - MIN };
const failed1 = { id: "a4", description: "Dalyan research", type: "general-purpose", status: "failed", line: "It hit the usage limit", steps: 0, startedAt: now - 12 * MIN, endedAt: now - 2 * MIN };

const env = launchEnv({ CLAUDE_CONFIG_DIR: claudeDir, CONVERSATIONS_DATA_DIR: dataDir, CLAUDE_SYNC_HOME: syncHome, CONVERSATIONS_LAUNCHER_DIR: path.join(T, "bin") });
const app = await electron.launch({ args: [root], cwd: root, env, colorScheme: "dark", timeout: 60_000 });
try {
  const win = await app.firstWindow();
  win.on("pageerror", (e) => check("no error in the window", false, e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForTimeout(3000);
  await win.getByText("Can you redo").first().click();
  await win.waitForSelector('textarea[aria-label="Message"]', { timeout: 15000 });
  await win.waitForTimeout(500);
  const shot = async (name) => {
    if (shots) await win.screenshot({ path: path.join(shots, `${name}.png`) });
  };
  const report = (agents, extra = {}) => app.evaluate(({ BrowserWindow }, st) => BrowserWindow.getAllWindows()[0].webContents.send("event:chat-status", st), { conversationId: ID, state: "idle", activity: null, model: "claude-opus-5-5", permissionMode: "default", contextPercent: 70, queued: [], error: null, permission: null, streamingText: "", turnTokens: null, agents, ...extra }).then(() => win.waitForTimeout(150));
  const bar = () => win.evaluate(() => {
    const b = document.querySelector(".agent-bar");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const c = document.querySelector(".composer").getBoundingClientRect();
    return { name: b.querySelector(".name")?.textContent, line: b.querySelector(".line")?.textContent, when: b.querySelector(".when")?.textContent ?? "", close: !!b.querySelector(".agent-bar-close"), height: r.height, gap: c.top - r.bottom, inset: r.left - c.left, right: c.right - r.right };
  });
  const panel = () => win.evaluate(() => {
    const p = document.querySelector(".agent-panel");
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const d = document.querySelector(".detail").getBoundingClientRect();
    const c = document.querySelector(".composer").getBoundingClientRect();
    return { width: r.width, right: d.right - r.right, chatRight: c.right, panelLeft: r.left, rows: [...p.querySelectorAll(".agent-row .name")].map((n) => n.textContent), steps: [...p.querySelectorAll(".agent-step")].map((s) => s.querySelector(".verb").textContent + " " + s.querySelector(".what").textContent), title: p.querySelector(".agent-names .name")?.textContent, stats: p.querySelector(".agent-names .stats")?.textContent, text: p.innerText };
  });

  // Nothing running.
  check("no agents: no bar", (await bar()) === null);
  await report([]);
  check("an empty list: no bar", (await bar()) === null);

  // One running.
  await report([running]);
  const one = await bar();
  check("one running: its task, what it's doing, how long", one?.name === "Göcek research" && one.line.startsWith("Checking sea") && one.when === "27 min" && !one.close, JSON.stringify(one));
  check("it's thin, and docked to the message box", one?.height === 28 && one.gap === 0 && one.inset === 16 && one.right === 16, JSON.stringify(one));
  await shot("agents-1-bar");

  // Click it.
  await win.click(".agent-bar-open");
  await win.waitForTimeout(400);
  let p = await panel();
  check("clicking it opens the panel beside the chat", p?.width === 420 && p.right === 0 && p.chatRight <= p.panelLeft, JSON.stringify(p && { w: p.width, r: p.right, c: p.chatRight, l: p.panelLeft }));
  check("one agent: straight to it, with no list", p?.title === "Göcek research" && p.rows.length === 0);
  check("its steps, from its own log", p?.steps.join("|") === "Search sea temperature Göcek by month|Read mgm.gov.tr/veridegerlendirme/deniz-suyu|Ran pdftotext kaunos.pdf|Read work/kaunos.txt|Reading mgm.gov.tr/deniz-suyu-sicakliklari", p?.steps.join("|"));
  check("what it's doing now, and a way to stop it", /Checking sea temperatures/.test(p?.text ?? "") && (await win.locator('.agent-panel button:has-text("Stop")').count()) === 1);
  check("the stats", /5 steps/.test(p?.stats ?? "") && /27 min/.test(p?.stats ?? ""), p?.stats);
  const box = await win.evaluate(() => { const c = document.querySelector(".composer"); const s = document.querySelector('button[aria-label="Send (Enter)"]').getBoundingClientRect(); const r = c.getBoundingClientRect(); return { w: r.width, sendIn: s.right <= r.right }; });
  check("you can still type: the message box is there beside it, with Send in it", box.w > 300 && box.sendIn, JSON.stringify(box));
  await win.fill('textarea[aria-label="Message"]', "still typing");
  check("...and takes text", (await win.inputValue('textarea[aria-label="Message"]')) === "still typing");
  await win.fill('textarea[aria-label="Message"]', "");
  await shot("agents-2-panel-one");

  // Its brief.
  await win.click('.agent-panel button:has-text("The brief Claude gave it")');
  await win.waitForTimeout(150);
  check("the brief opens", (await win.locator(".agent-brief").innerText()) === "Research Göcek for the port page.");
  await win.click('.agent-panel button:has-text("The brief Claude gave it")');

  // New steps arrive while it's open.
  fs.appendFileSync(goc, `${res(9)}\n${au(10, "WebSearch", { query: "Kaunos rock tombs" })}\n`);
  await win.waitForFunction(() => [...document.querySelectorAll(".agent-step .what")].some((s) => s.textContent === "Kaunos rock tombs"), null, { timeout: 5000 }).catch(() => {});
  p = await panel();
  check("new steps appear by themselves", p?.steps.at(-1) === "Searching Kaunos rock tombs", p?.steps.at(-1));

  // Esc from inside it.
  await win.locator(".agent-panel").focus();
  await win.keyboard.press("Escape");
  await win.waitForTimeout(150);
  check("Esc closes it", (await panel()) === null);
  check("...and the bar is still there, while it runs", (await bar())?.name === "Göcek research");

  // Several.
  await report([running, bodrum]);
  const two = await bar();
  check("several: how many, which, the longest time", two?.name === "2 agents running" && two.line === "Göcek research and Bodrum research" && two.when === "27 min", JSON.stringify(two));
  await report([running, bodrum, sitemap]);
  await win.click(".agent-bar-open");
  await win.waitForTimeout(400);
  p = await panel();
  check("several: a list, running first", p?.rows.join("|") === "Göcek research|Bodrum research|Sitemap check", p?.rows.join("|"));
  check("...how they stand", /2 running, 1 finished/.test(p?.text ?? ""));
  await shot("agents-3-panel-several");
  await win.click('.agent-row:has-text("Bodrum research")');
  await win.waitForTimeout(400);
  p = await panel();
  check("picking one shows it", p?.title === "Bodrum research" && p.steps.length === 15, `${p?.title} ${p?.steps.length}`);
  check("...its latest steps, with the earlier ones a click away", /25 earlier steps/.test(p?.text ?? ""));
  await win.click(".agent-earlier");
  await win.waitForTimeout(200);
  check("...and that click shows them", (await panel())?.steps.length === 40);
  await win.click('.agent-row:has-text("Sitemap check")');
  await win.waitForTimeout(400);
  p = await panel();
  check("a finished one shows its report", p?.title === "Sitemap check" && (await win.locator(".agent-report h2").innerText()) === "Sitemap" && /Three pages were/.test(p.text), p?.text.slice(0, 200));
  check("...handed back as most agents do, and not shown as a step", !/SubagentHandback/.test(p?.text ?? ""));
  await win.click(".agent-report [data-copy]");
  await win.waitForTimeout(200);
  check("...its code blocks' Copy works", await win.evaluate(() => document.body.innerText.includes("Copied")));
  check("...with its steps folded away", p?.steps.length === 0 && /1 step/.test(p?.text ?? ""));
  check("...and no Stop", (await win.locator('.agent-panel button:has-text("Stop")').count()) === 0);
  await win.click('.agent-panel button:has-text("1 step")');
  await win.waitForTimeout(100);
  check("...until you ask", (await panel())?.steps.length === 1);
  await win.click('.agent-panel [aria-label^="Close"]');
  await win.waitForTimeout(150);

  // Keys in the panel are the panel's.
  await report([running]);
  await win.click(".agent-bar-open");
  await win.waitForTimeout(300);
  const chip = () => win.evaluate(() => document.querySelector('button[aria-label="Model"]')?.textContent?.trim());
  const modelBefore = await chip();
  await win.locator(".agent-panel").focus();
  for (const k of ["ArrowDown", "ArrowUp", "ArrowDown", "Delete"]) await win.keyboard.press(k);
  await win.waitForTimeout(400);
  check("arrows and Delete in the panel don't switch the model or delete the chat", (await chip()) === modelBefore && !(await win.evaluate(() => document.body.innerText.includes("Undo"))) && (await panel()) !== null, `${modelBefore} -> ${await chip()}`);
  // No agents to show: it closes, and doesn't open again by itself.
  await report([]);
  check("nothing to show: the panel closes", (await panel()) === null);
  await report([running]);
  check("...and doesn't open again by itself", (await panel()) === null);

  // Ended.
  await report([{ ...running, status: "finished", line: null, endedAt: now - MIN }]);
  const done = await bar();
  check("just finished: says so, with a way to close it", done?.line === "Finished" && done.close && done.when === "26 min", JSON.stringify(done));
  await shot("agents-4-finished");
  await win.click(".agent-bar-close");
  await win.waitForTimeout(100);
  check("X closes it", (await bar()) === null);
  await report([{ ...running, status: "finished", line: null, endedAt: now - MIN }]);
  check("...and it stays closed", (await bar()) === null);

  await report([failed1]);
  const bad = await bar();
  check("failed: says why", bad?.line === "Failed: It hit the usage limit", JSON.stringify(bad));
  await win.click(".agent-bar-open");
  await win.waitForTimeout(300);
  p = await panel();
  check("...and the panel opens on it", p?.title === "Dalyan research" && /It hit the usage limit/.test(p.text) && /ended before writing a report/.test(p.text), p?.text.slice(0, 160));
  check("...the bar stays while you look", (await bar())?.name === "Dalyan research");
  await shot("agents-5-failed");
  await win.click('.agent-panel [aria-label^="Close"]');
  await win.waitForTimeout(150);
  check("closing the panel is looking at it: the bar has gone", (await bar()) === null);

  // Sending is moving on.
  const later = { ...sitemap, id: "a5", description: "Later one" };
  await report([later]);
  check("another ended one shows", (await bar())?.name === "Later one");
  await win.fill('textarea[aria-label="Message"]', "! echo hi");
  await win.press('textarea[aria-label="Message"]', "Enter");
  await win.waitForTimeout(400);
  await report([later]);
  check("your next message closes it", (await bar()) === null);

  // A narrow window.
  await report([running]);
  await win.click(".agent-bar-open");
  await win.waitForTimeout(300);
  await win.setViewportSize({ width: 1000, height: 800 });
  await win.waitForTimeout(400);
  p = await panel();
  const paneW = await win.evaluate(() => document.querySelector(".detail").clientWidth);
  check("no room beside the chat: it covers the chat instead", p?.width === paneW && p.right === 0, `${p?.width} of ${paneW}`);
  check("...and what it covers takes no focus or keys meanwhile", await win.evaluate(() => document.querySelector(".transcript").hasAttribute("inert") && document.querySelector(".composer-wrap").hasAttribute("inert")));
  await shot("agents-6-over");
  await report([running], { state: "waiting-approval", permission: { requestId: "r1", conversationId: ID, toolName: "PowerShell", title: "Allow a command that can't be undone?", context: "PowerShell  ·  in work  ·  Test PC", body: "Remove-Item -Recurse build", consequence: null, destructive: true, allowAlways: false, createdAt: new Date().toISOString() } });
  await win.waitForTimeout(400);
  check("a request Claude is waiting on: the panel gives way to it", (await panel()) === null && (await win.evaluate(() => !!document.querySelector(".permission"))));
  check("...and no key can answer it unseen", await win.evaluate(() => !document.activeElement?.closest(".permission") && !document.querySelector(".transcript").hasAttribute("inert")));
  await report([running]);
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForTimeout(300);

  // Another chat, and back.
  await win.evaluate(() => window.dispatchEvent(new Event("app:noop")));
  check("the bar's text never pushes it out of shape", await win.evaluate(() => {
    const b = document.querySelector(".agent-bar-open");
    return !!b && b.scrollWidth <= b.clientWidth + 1;
  }));
} catch (e) {
  check("no error", false, e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
  try {
    fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
