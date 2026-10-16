// How each built-in slash command behaves when sent through the Agent SDK (as the
// app sends it): what comes back live, whether a turn runs, and what the transcript
// records. Runs in a throwaway folder on Haiku; deletes its transcript afterwards.
//   node scripts/probe-command-behaviour.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-probe-"));
const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
delete env.CLAUDE_CODE_ENTRYPOINT;

const items = [];
let wake = null;
const input = {
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (items.length) yield items.shift();
      await new Promise((r) => (wake = r));
    }
  },
};
const say = (text) => {
  items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, timestamp: new Date().toISOString() });
  wake?.();
};
const q = query({ prompt: input, options: { cwd, model: "haiku", pathToClaudeCodeExecutable: claude, settingSources: ["user"], env, permissionMode: "default" } });
let id = null;
let log = [];
let results = 0;
(async () => {
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") {
      if (id && m.session_id !== id) log.push(`  ! session id changed ${id.slice(0, 8)} -> ${m.session_id.slice(0, 8)}`);
      id = m.session_id;
      continue;
    }
    if (m.type === "system" && m.subtype === "local_command_output") log.push(`  local_command_output: ${JSON.stringify(m.content).slice(0, 220)}`);
    else if (m.type === "assistant") log.push(`  assistant: ${JSON.stringify((m.message.content ?? []).map((b) => b.text ?? b.type)).slice(0, 220)}`);
    else if (m.type === "result") {
      results++;
      log.push(`  result ${m.subtype} turns=${m.num_turns} cost=${m.total_cost_usd} text=${JSON.stringify(String(m.result ?? "")).slice(0, 160)}`);
    } else if (m.type === "user") log.push(`  user echo: ${JSON.stringify(m.message?.content).slice(0, 160)}${m.isReplay ? " (replay)" : ""}`);
    else if (m.type !== "stream_event" && m.type !== "rate_limit_event") log.push(`  ${m.type}${m.subtype ? `/${m.subtype}` : ""}`);
  }
})().catch((e) => log.push(`  ERROR ${e.message}`));

async function run(text, waitMs = 15_000) {
  log = [];
  const before = results;
  say(text);
  const t0 = Date.now();
  while (results === before && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400));
  console.log(`== ${text}  (${Date.now() - t0} ms)`);
  for (const l of log) console.log(l);
}

await run("Reply with just OK.", 60_000);
for (const c of ["/context", "/usage", "/mcp", "/mcp reconnect does-not-exist", "/model haiku", "/effort low", "/color blue", "/rename Probe chat", "/output-style", "/autocompact", "/advisor", "/fast", "/focus", "/reload-skills", "/config", "/debug", "/no-such-command"]) await run(c);
await run("/compact", 90_000);
await run("/clear", 20_000);
await run("Reply with just OK again.", 60_000);

const dirs = fs.readdirSync(path.join(os.homedir(), ".claude", "projects")).filter((d) => d.includes("cmd-probe-"));
for (const d of dirs) {
  const full = path.join(os.homedir(), ".claude", "projects", d);
  for (const f of fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"))) {
    const lines = fs.readFileSync(path.join(full, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    console.log(`\n--- transcript ${f.slice(0, 8)} (${lines.length} lines)`);
    for (const e of lines) {
      if (!["user", "system", "assistant"].includes(e.type)) continue;
      const c = e.message?.content ?? e.content;
      const s = typeof c === "string" ? c : JSON.stringify(c);
      console.log(`${e.type}${e.subtype ? `/${e.subtype}` : ""}${e.isMeta ? " meta" : ""}${e.isCompactSummary ? " compact" : ""}: ${String(s).replace(/\s+/g, " ").slice(0, 170)}`);
    }
  }
  fs.rmSync(full, { recursive: true, force: true });
}
q.close();
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(0);
