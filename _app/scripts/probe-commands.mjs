// Lists the slash commands and skills Claude Code offers in a folder, and checks
// that a typed "/command" sent through the SDK runs as a command.
//   node scripts/probe-commands.mjs [folder]
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const cwd = process.argv[2] ?? os.homedir();
const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
async function* never() {
  await new Promise(() => {});
}
const q = query({ prompt: never(), options: { cwd, pathToClaudeCodeExecutable: claude, settingSources: ["user", "project", "local"], env } });
const t0 = Date.now();
const cmds = await q.supportedCommands();
console.log(`${cmds.length} commands in ${Date.now() - t0} ms`);
console.log(cmds.map((c) => `${c.builtin ? "  " : "* "}/${c.name}${c.argumentHint ? " " + c.argumentHint : ""} — ${c.description.slice(0, 60)}`).join("\n"));
const models = await q.supportedModels();
console.log("efforts:", models.map((m) => `${m.value}:${m.supportsEffort ? (m.supportedEffortLevels ?? []).join("/") : "-"}`).join("  "));
q.close();

// A local command typed into a streamed session: does it run as a command?
async function* one() {
  yield { type: "user", message: { role: "user", content: "/context" }, parent_tool_use_id: null };
}
const q2 = query({ prompt: one(), options: { cwd, pathToClaudeCodeExecutable: claude, settingSources: ["user"], env, persistSession: false } });
for await (const m of q2) {
  console.log("msg", m.type, m.subtype ?? "", m.type === "user" || m.type === "assistant" ? JSON.stringify(m.message?.content).slice(0, 160) : "");
  if (m.type === "result") {
    console.log(`/context -> result ${m.subtype}, cost $${m.total_cost_usd}, turns ${m.num_turns}: ${String(m.result ?? "").slice(0, 120).replace(/\n/g, " ")}`);
    break;
  }
}
process.exit(0);
