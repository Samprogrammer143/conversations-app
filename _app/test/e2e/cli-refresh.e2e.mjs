// A conversation continued in a terminal must update in the open window: the app
// runs against a scratch Claude folder holding one copied conversation, and lines
// are appended to it the way a terminal's Claude Code appends them.
//   node test/e2e/cli-refresh.e2e.mjs <source transcript.jsonl> [shots dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { launchEnv } from "../../scripts/dev-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = process.argv[2];
const out = path.resolve(process.argv[3] ?? path.join(root, "test-results"));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "conv-cli-refresh-"));
const claudeDir = path.join(scratch, ".claude");
const id = path.basename(src, ".jsonl");
const folder = path.join(claudeDir, "projects", path.basename(path.dirname(src)));
fs.mkdirSync(folder, { recursive: true });
const file = path.join(folder, `${id}.jsonl`);
fs.copyFileSync(src, file);
const dataDir = path.join(scratch, "data");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ welcomed: true }));

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lastChain = [...lines].reverse().find((e) => e.uuid && (e.type === "assistant" || e.type === "user"));
const base = { ...lastChain };
let parent = lastChain.uuid;
const entry = (type, content, extra = {}) => {
  const uuid = crypto.randomUUID();
  const e = { ...base, ...extra, type, uuid, parentUuid: parent, timestamp: new Date().toISOString(), entrypoint: "cli", message: type === "user" ? { role: "user", content } : { id: `msg_${uuid.slice(0, 8)}`, type: "message", role: "assistant", model: base.message?.model ?? "claude-opus-5-5", content: [{ type: "text", text: content }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } };
  delete e.toolUseResult;
  delete e.isMeta;
  parent = uuid;
  return JSON.stringify(e) + "\n";
};

const app = await electron.launch({ args: [root], cwd: root, env: launchEnv({ CLAUDE_CONFIG_DIR: claudeDir, CONVERSATIONS_DATA_DIR: dataDir }), timeout: 60_000 });
try {
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1280, 820);
    w.show();
  });
  await win.waitForTimeout(3000);
  await win.evaluate((cid) => document.querySelector(`[data-id="${cid}"]`)?.click(), id);
  await win.waitForTimeout(2000);
  const textOf = () => win.evaluate(() => document.querySelector(".detail .transcript")?.innerText ?? "");
  check("the conversation is open", (await textOf()).length > 50, (await win.evaluate(() => document.querySelector(".detail-title")?.textContent)) ?? "");

  // Unfocus the window, as when you switch to the terminal.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
  // The terminal writes a prompt and, a few seconds later, the reply.
  fs.appendFileSync(file, entry("user", "REPRO prompt typed in the terminal"));
  await win.waitForTimeout(1500);
  fs.appendFileSync(file, entry("assistant", "REPRO reply written in the terminal"));
  let seen = "";
  for (let i = 0; i < 15 && !seen.includes("REPRO reply"); i++) {
    await win.waitForTimeout(1000);
    seen = await textOf();
  }
  check("the terminal's prompt shows without reopening", seen.includes("REPRO prompt"));
  check("the terminal's reply shows without reopening", seen.includes("REPRO reply"));
  // A slower trickle, written in pieces, the way a long reply streams to disk.
  const piece = entry("assistant", "REPRO second reply in pieces");
  const fd = fs.openSync(file, "a");
  fs.writeSync(fd, piece.slice(0, 40));
  await win.waitForTimeout(700);
  fs.writeSync(fd, piece.slice(40));
  fs.closeSync(fd);
  seen = "";
  for (let i = 0; i < 15 && !seen.includes("REPRO second"); i++) {
    await win.waitForTimeout(1000);
    seen = await textOf();
  }
  check("a line written in two pieces shows once complete", seen.includes("REPRO second"));
  // Claude Code keeps the transcript open while it runs: lines written through a
  // handle that stays open must show too, before the terminal closes.
  const held = fs.openSync(file, "a");
  fs.writeSync(held, entry("user", "REPRO held prompt"));
  await win.waitForTimeout(800);
  fs.writeSync(held, entry("assistant", "REPRO held reply"));
  seen = "";
  const t0 = Date.now();
  for (let i = 0; i < 20 && !seen.includes("REPRO held reply"); i++) {
    await win.waitForTimeout(1000);
    seen = await textOf();
  }
  check("lines written while the file stays open show within 10 s", seen.includes("REPRO held reply") && Date.now() - t0 < 11_000, `${Math.round((Date.now() - t0) / 1000)} s`);
  fs.closeSync(held);
  await win.screenshot({ path: path.join(out, "cli-refresh.png") });
} finally {
  await app.close();
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
