// Two facts the app relies on for "!" commands, with no model turn:
// 1. the result Claude Code reports for a shouldQuery:false message (to tell it from a real turn's);
// 2. a new chat whose first input is a shell command: does it get an id and a transcript?
//   node scripts/probe-shell-new.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shell-new-probe-"));
const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
delete env.CLAUDE_CODE_ENTRYPOINT;
const user = (content) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, timestamp: new Date().toISOString(), shouldQuery: false });

const items = [user("<bash-input>echo FIRST</bash-input>"), user("<bash-stdout>FIRST-1\n</bash-stdout><bash-stderr></bash-stderr>")];
let wake = null;
let closed = false;
const input = {
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (items.length) yield items.shift();
      if (closed) return;
      await new Promise((r) => (wake = r));
    }
  },
};
const q = query({ prompt: input, options: { cwd, pathToClaudeCodeExecutable: claude, settingSources: [], env } });
let id = null;
const t0 = Date.now();
const timer = setTimeout(() => {
  closed = true;
  wake?.();
  q.close();
}, 12_000);
for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") {
    console.log(`${Date.now() - t0} ms  init session=${m.session_id}`);
    id = m.session_id;
  } else if (m.type === "result") {
    const { type, subtype, is_error, num_turns, duration_ms, duration_api_ms, total_cost_usd, usage, result } = m;
    console.log(`${Date.now() - t0} ms  result ${JSON.stringify({ type, subtype, is_error, num_turns, duration_ms, duration_api_ms, total_cost_usd, out: usage?.output_tokens, result: String(result ?? "").slice(0, 40) })}`);
  } else console.log(`${Date.now() - t0} ms  ${m.type}${m.subtype ? `/${m.subtype}` : ""}`);
}
clearTimeout(timer);
const file = id && fs.readdirSync(path.join(os.homedir(), ".claude", "projects")).map((d) => path.join(os.homedir(), ".claude", "projects", d, `${id}.jsonl`)).find((f) => fs.existsSync(f));
if (file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`transcript: ${lines.length} lines; bash entries: ${lines.filter((e) => typeof e.message?.content === "string" && e.message.content.startsWith("<bash-")).length}; entrypoint ${lines.find((e) => e.entrypoint)?.entrypoint}`);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
} else console.log("no transcript");
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(0);
