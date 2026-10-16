// End-to-end: a real Claude Code chat through the app, in a scratch folder, on
// the smallest model. Approves a file write, denies a destructive delete, and
// checks what reached the disk and the screen. Any other approvals Claude asks
// for along the way (your CLAUDE.md may ask it to read files first) are allowed,
// as long as they are not destructive.
//
//   node test/e2e/chat.e2e.mjs <scratch folder> <screenshot folder>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { collectE2eTranscripts, launchEnv, sandboxEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = path.resolve(process.argv[2]);
const shots = path.resolve(process.argv[3]);
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.rmSync(path.join(scratch, "hello.txt"), { force: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};

const app = await electron.launch({ args: [root], cwd: root, env: launchEnv(), colorScheme: "light", timeout: 60_000 });
const win = await app.firstWindow();
win.on("pageerror", (e) => console.log(`[page:error] ${e.message}`));
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setContentSize(1440, 900);
  w.show();
});
await win.waitForTimeout(2500);

const projectId = "folder:chat-e2e";
await win.evaluate(({ projectId, scratch }) => window.conversations.settings.get().then((s) => window.conversations.settings.set({ folders: { ...s.folders, [projectId]: scratch } })), { projectId, scratch });

const status = (id) => win.evaluate((id) => window.conversations.chat.status(id), id);

/** Runs one turn to the end, answering each permission with decide(perm). */
async function runTurn(id, decide, onPermission) {
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    const s = await status(id);
    if (s?.permission && !seen.some((p) => p.requestId === s.permission.requestId)) {
      seen.push(s.permission);
      if (onPermission) await onPermission(s.permission);
      await win.evaluate(({ rid, d }) => window.conversations.chat.respond(rid, d), { rid: s.permission.requestId, d: decide(s.permission) });
    } else if (s && (s.state === "idle" || s.state === "error")) return { status: s, perms: seen };
    await win.waitForTimeout(400);
  }
  return { status: await status(id), perms: seen, timedOut: true };
}

// 1. A new chat started from the app; the write is approved.
const sent = await win.evaluate(
  ({ projectId }) => window.conversations.chat.send(null, "Create a file named hello.txt in the current folder containing exactly the word hi. Use the Write tool. Then reply with the single word: done", { projectId, model: "haiku", permissionMode: "default" }),
  { projectId },
);
check("a new chat starts and gets an id", sent.ok && sent.conversationId, JSON.stringify(sent));
const id = sent.conversationId;
await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("event:open-conversation", id), id);
let shotWrite = false;
const t1 = await runTurn(
  id,
  (p) => (p.destructive ? "deny" : "allow"),
  async (p) => {
    if (p.toolName === "Write" && !shotWrite) {
      shotWrite = true;
      await win.waitForTimeout(700);
      await win.screenshot({ path: path.join(shots, "chat-permission.png") });
    }
  },
);
const write = t1.perms.find((p) => p.toolName === "Write");
check("writing a file asks for permission, in plain words", write && /^Allow Claude to write .*hello\.txt\?$/.test(write.title), JSON.stringify(t1.perms.map((p) => p.title)));
check("a file write is not treated as destructive", write && !write.destructive);
check("the turn finishes", t1.status?.state === "idle", JSON.stringify(t1.status));
check("the approved write reached the disk", fs.existsSync(path.join(scratch, "hello.txt")) && fs.readFileSync(path.join(scratch, "hello.txt"), "utf8").trim() === "hi");
// The context meter is read just after the turn ends.
let pct = t1.status?.contextPercent;
for (let i = 0; i < 20 && typeof pct !== "number"; i++) {
  await win.waitForTimeout(250);
  pct = (await status(id))?.contextPercent;
}
check("context use is reported", typeof pct === "number", JSON.stringify(pct));
await win.waitForTimeout(1500);
await win.screenshot({ path: path.join(shots, "chat-done.png") });

// 2. A destructive command opens on Deny, never offers Always allow; it is denied.
await win.evaluate((id) => window.conversations.chat.send(id, "Now delete hello.txt by running exactly this PowerShell command: Remove-Item -Force hello.txt", {}), id);
let focusOnDeny = null;
const t2 = await runTurn(
  id,
  (p) => (p.destructive ? "deny" : "allow"),
  async (p) => {
    if (p.destructive && focusOnDeny === null) {
      await win.waitForTimeout(800);
      focusOnDeny = await win.evaluate(() => document.activeElement?.textContent?.trim());
      await win.screenshot({ path: path.join(shots, "chat-destructive.png") });
    }
  },
);
const del = t2.perms.find((p) => /Remove-Item/i.test(p.body ?? ""));
check("the delete asks for permission", !!del, JSON.stringify(t2.perms.map((p) => p.title)));
check("the delete is marked destructive", del?.destructive === true, JSON.stringify(del));
check("a destructive request never offers Always allow", del && !del.allowAlways);
check("keyboard focus starts on Deny", focusOnDeny === "Deny", String(focusOnDeny));
check("the denied delete did not happen", fs.existsSync(path.join(scratch, "hello.txt")));
check("the turn ends after the denial", t2.status && !t2.timedOut, JSON.stringify(t2.status));

// 3. The conversation is in the list, and its transcript shows the exchange.
await win.waitForTimeout(1500);
const rows = await win.evaluate(() => window.conversations.list.conversations({ scope: { kind: "all" }, filter: "all" }));
check("the app's chat appears in the list", rows.rows.some((r) => r.id === id), rows.rows.map((r) => r.title).slice(0, 5).join(" | "));
const page = await win.evaluate((id) => window.conversations.list.items(id, null, 50), id);
check("the transcript has both prompts", page.items.filter((i) => i.kind === "user").length >= 2, JSON.stringify(page.items.map((i) => i.kind)));
const chips = page.items.filter((i) => i.kind === "tools").map((i) => i.summary);
check("the denied delete reads as not run", chips.some((t) => /^Didn't run Remove-Item/.test(t)), JSON.stringify(chips));
await win.screenshot({ path: path.join(shots, "chat-final.png") });

await app.close();
// The chat ran on this PC's real Claude Code: move its transcripts into the sandbox,
// so they never reach the real sync or Claude Code's /resume list.
try {
  const moved = collectE2eTranscripts(scratch);
  console.log(moved.length ? `moved ${moved.length} test conversation folder(s) into the sandbox` : "no test conversation folders to move");
} catch (e) {
  console.log(`test conversations left in ~/.claude/projects: ${e.message}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
