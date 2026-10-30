// When the app asks where a chat should work, in the sandbox with scratch folders (the
// scratch Claude folder isn't signed in, so nothing reaches Claude):
// - a chat whose file is on this PC, last used in a folder only another PC has, doesn't ask:
//   the file itself names this PC's folder;
// - a chat with no folder on this PC does ask.
//   node test/e2e/folder-prompt.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const T = fs.mkdtempSync(path.join(os.tmpdir(), "conv-prompt-"));
const claudeDir = path.join(T, ".claude");
const dataDir = path.join(T, "data");
const syncHome = path.join(T, "sync");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true, syncAutomatically: false, startAtLogin: false }));
fs.mkdirSync(syncHome, { recursive: true });
fs.writeFileSync(path.join(syncHome, "config.json"), JSON.stringify({ remote: path.join(T, "none.git"), machine: "Test PC" }));

const HERE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const GONE_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const here = path.join(T, "work", "site");
const elsewhere = path.join(T, "other-pc", "site");
const gone = path.join(T, "other-pc", "gone");
fs.mkdirSync(here, { recursive: true });
const lineOf = (id, cwd, type, n) =>
  JSON.stringify({ type, uuid: `${id}-${n}`, parentUuid: n ? `${id}-${n - 1}` : null, sessionId: id, cwd, timestamp: new Date(Date.now() + n).toISOString(), entrypoint: "cli", message: type === "user" ? { role: "user", content: `message ${n}` } : { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }] } });
const write = (dirCwd, id, cwds) => {
  const dir = path.join(claudeDir, "projects", dirCwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), cwds.flatMap((c, i) => [lineOf(id, c, "user", i * 2), lineOf(id, c, "assistant", i * 2 + 1)]).join("\n") + "\n");
};
// Started here, carried on from a folder only another PC has.
write(here, HERE_ID, [here, elsewhere]);
// Only ever on another PC's folder.
write(gone, GONE_ID, [gone]);

const env = launchEnv({ CLAUDE_CONFIG_DIR: claudeDir, CONVERSATIONS_DATA_DIR: dataDir, CLAUDE_SYNC_HOME: syncHome, CONVERSATIONS_LAUNCHER_DIR: path.join(T, "bin") });
const app = await electron.launch({ args: [root], cwd: root, env, timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await win.waitForTimeout(3500);
  await app.evaluate(({ dialog }) => {
    globalThis.asked = [];
    dialog.showMessageBox = async (...a) => {
      globalThis.asked.push((a.at(-1)).detail);
      return { response: 2 };
    };
  });
  const send = (id) => win.evaluate((cid) => window.conversations.chat.send(cid, "hello", { permissionMode: "default" }), id);
  const asked = () => app.evaluate(() => globalThis.asked.length);
  const r1 = await send(HERE_ID);
  await win.waitForTimeout(3000);
  check("a chat whose file names this PC's folder doesn't ask", (await asked()) === 0 && r1.err !== "Chat needs a folder to work in on this PC", JSON.stringify(r1));
  const r2 = await send(GONE_ID);
  await win.waitForTimeout(1000);
  check("a chat with no folder on this PC asks, and Cancel leaves it", (await asked()) === 1 && r2.ok === false, JSON.stringify(r2));
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
