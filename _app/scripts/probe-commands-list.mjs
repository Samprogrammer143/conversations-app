// Lists Claude Code's built-in slash commands as the SDK reports them (name, aliases, args, description).
//   node scripts/probe-commands-list.mjs [cwd]
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
async function* never() { await new Promise(() => {}); }
const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
const q = query({ prompt: never(), options: { cwd: process.argv[2] ?? os.homedir(), pathToClaudeCodeExecutable: claude, settingSources: ["user", "project", "local"], env } });
const list = await q.supportedCommands();
for (const c of list.filter((c) => c.builtin).sort((a, b) => a.name.localeCompare(b.name))) console.log(`${c.name}${c.aliases?.length ? ` (${c.aliases.join(",")})` : ""}${c.argumentHint ? ` ${c.argumentHint}` : ""} :: ${c.description}`);
console.log(`-- ${list.filter((c) => c.builtin).length} built-in, ${list.filter((c) => !c.builtin).length} other`);
q.close();
process.exit(0);
