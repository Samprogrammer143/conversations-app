// Does a session started the way the app starts it have the Claude in Chrome tools?
//   node scripts/probe-chrome.mjs
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
// The init message only arrives once a message is sent; /context runs locally at no cost.
async function* one() {
  yield { type: "user", message: { role: "user", content: "/context" }, parent_tool_use_id: null };
}
for (const extraArgs of [undefined, { chrome: null }]) {
  const q = query({ prompt: one(), options: { cwd: os.homedir(), pathToClaudeCodeExecutable: claude, settingSources: ["user"], extraArgs, persistSession: false, env: { ...process.env, CLAUDE_SYNC_DISABLE: "1" } } });
  const t = setTimeout(() => q.close(), 40_000);
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") {
      const tools = m.tools ?? [];
      const chrome = tools.filter((x) => /chrome/i.test(x));
      const servers = (m.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`);
      console.log(`${extraArgs ? "with --chrome" : "without     "}: ${chrome.length} chrome tools of ${tools.length}; mcp servers: ${servers.join(", ") || "none"}`);
      if (chrome.length) console.log("  e.g.", chrome.slice(0, 4).join(", "));
      break;
    }
  }
  clearTimeout(t);
  q.close();
}
process.exit(0);
