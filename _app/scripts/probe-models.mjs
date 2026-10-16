// Prints the models the installed Claude Code offers this account, as the app sees them.
//   node scripts/probe-models.mjs
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
async function* never() {
  await new Promise(() => {});
}
const q = query({ prompt: never(), options: { cwd: os.homedir(), pathToClaudeCodeExecutable: claude, settingSources: ["user"], env: { ...process.env, CLAUDE_SYNC_DISABLE: "1" } } });
const t0 = Date.now();
const models = await q.supportedModels();
console.log(JSON.stringify(models.map((m) => ({ value: m.value, resolved: m.resolvedModel, name: m.displayName, desc: m.description })), null, 1));
console.log(`${Date.now() - t0} ms`);
q.close();
process.exit(0);
