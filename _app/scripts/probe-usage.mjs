// Prints this account's plan usage windows as Claude Code reports them (the data behind /usage).
// Nothing is sent to the model, so it costs nothing.
//   node scripts/probe-usage.mjs
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
async function* never() {
  await new Promise(() => {});
}
const q = query({ prompt: never(), options: { cwd: os.homedir(), pathToClaudeCodeExecutable: claude, settingSources: [], env: { ...process.env, CLAUDE_SYNC_DISABLE: "1" } } });
const t0 = Date.now();
const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
console.log(JSON.stringify({ subscription_type: u.subscription_type, rate_limits_available: u.rate_limits_available, rate_limits: u.rate_limits }, null, 1));
console.log(`${Date.now() - t0} ms`);
q.close();
process.exit(0);
