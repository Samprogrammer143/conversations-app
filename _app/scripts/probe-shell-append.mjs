// Checks how Claude Code takes a "!" shell command from the app: the command and
// its output are appended as shouldQuery:false user messages (the way the CLI's
// bash mode records them), without starting a turn, and Claude sees them with the
// next message. Runs in a throwaway folder; two short Haiku turns.
//   node scripts/probe-shell-append.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claude = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shell-append-probe-"));
const env = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
delete env.CLAUDE_CODE_ENTRYPOINT;

class Queue {
  items = [];
  wake = null;
  closed = false;
  push(m) {
    this.items.push(m);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift();
      if (this.closed) return;
      await new Promise((r) => (this.wake = r));
      this.wake = null;
    }
  }
}
const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, timestamp: new Date().toISOString(), ...extra });

async function run(label, resume, steps) {
  const input = new Queue();
  const q = query({ prompt: input, options: { cwd, resume, pathToClaudeCodeExecutable: claude, model: "haiku", settingSources: [], env, permissionMode: "default" } });
  const seen = [];
  let id = resume ?? null;
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") id = m.session_id;
      if (m.type === "assistant") seen.push(`assistant: ${(m.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ").slice(0, 120)}`);
      else if (m.type === "result") seen.push(`result: ${m.subtype}`);
      else if (m.type === "user") seen.push(`user echo: ${JSON.stringify(m.message?.content).slice(0, 80)}${m.isReplay ? " (replay)" : ""}`);
      else seen.push(`${m.type}${m.subtype ? `/${m.subtype}` : ""}`);
    }
  })();
  await steps(input, seen);
  input.close();
  q.close();
  await pump.catch(() => {});
  console.log(`--- ${label} (session ${id?.slice(0, 8)})`);
  for (const s of seen) console.log(`  ${s}`);
  return id;
}

const waitFor = async (seen, pred, ms = 60_000) => {
  const t0 = Date.now();
  while (!seen.some(pred) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200));
};

// 1. A short conversation to continue.
const id = await run("1. new conversation", undefined, async (input, seen) => {
  input.push(user("Reply with just the word OK."));
  await waitFor(seen, (s) => s.startsWith("result"));
});

// 2. Resume and append a shell command and its output, with no turn.
await run("2. resume, append shell entries only", id, async (input, seen) => {
  input.push(user("<bash-input>echo MAGIC</bash-input>", { shouldQuery: false }));
  input.push(user("<bash-stdout>MAGIC-7731\n</bash-stdout><bash-stderr></bash-stderr>", { shouldQuery: false }));
  await new Promise((r) => setTimeout(r, 6000));
});

const file = fs.readdirSync(path.join(os.homedir(), ".claude", "projects")).map((d) => path.join(os.homedir(), ".claude", "projects", d, `${id}.jsonl`)).find((f) => fs.existsSync(f));
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bash = lines.filter((e) => typeof e.message?.content === "string" && e.message.content.startsWith("<bash-"));
console.log(`--- transcript after step 2: ${lines.length} lines, ${bash.length} bash entries, assistant entries ${lines.filter((e) => e.type === "assistant").length}`);
for (const e of bash) console.log(`  ${e.type} parent=${e.parentUuid?.slice(0, 8)} uuid=${e.uuid?.slice(0, 8)} ${JSON.stringify(e.message.content).slice(0, 80)} keys=${Object.keys(e).join(",")}`);

// 3. Resume with a real question: does Claude see the output?
await run("3. resume and ask", id, async (input, seen) => {
  input.push(user("What did my shell command print? Reply with just that token."));
  await waitFor(seen, (s) => s.startsWith("result"));
});

// 4. In one live session: append, then ask, without restarting.
await run("4. live session: append then ask", id, async (input, seen) => {
  input.push(user("<bash-input>echo SECOND</bash-input>", { shouldQuery: false }));
  input.push(user("<bash-stdout>SECOND-4410\n</bash-stdout><bash-stderr></bash-stderr>", { shouldQuery: false }));
  await new Promise((r) => setTimeout(r, 2500));
  input.push(user("And the latest shell command? Reply with just its token."));
  await waitFor(seen, (s) => s.startsWith("assistant"));
  await new Promise((r) => setTimeout(r, 1500));
});

console.log(`\ntranscript: ${file}`);
fs.rmSync(path.dirname(file), { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(0);
