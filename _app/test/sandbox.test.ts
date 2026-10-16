// The development sandbox keeps the chat test's conversations out of the real sync.
// Runs against a stand-in Claude folder, never the real ~/.claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectE2eTranscripts, sandboxEnv } from "../scripts/dev-sandbox.mjs";

let base: string;
let claudeHome: string;
let into: string;
const scratch = path.join(os.tmpdir(), "scratchpad", "chat-e2e");
const encode = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));
  claudeHome = path.join(base, ".claude");
  into = path.join(base, "e2e-transcripts");
  const testFolder = path.join(claudeHome, "projects", encode(scratch));
  fs.mkdirSync(path.join(testFolder, "memory"), { recursive: true });
  fs.writeFileSync(path.join(testFolder, "a.jsonl"), `${JSON.stringify({ type: "user", cwd: scratch, message: { content: "hi" } })}\n`);
  fs.writeFileSync(path.join(testFolder, "memory", "MEMORY.md"), "test\n");
  // A real project whose folder name happens to contain the same words.
  const other = path.join(claudeHome, "projects", "C--Users-me-chat-e2e-notes");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "b.jsonl"), `${JSON.stringify({ type: "user", cwd: "C:\\Users\\me\\chat-e2e-notes", message: { content: "real" } })}\n`);
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("the development sandbox", () => {
  it("turns Claude Code's sync hooks off for chats it starts", () => {
    expect(sandboxEnv.CLAUDE_SYNC_DISABLE).toBe("1");
  });

  it("moves only the test's conversations into the sandbox", () => {
    const moved = collectE2eTranscripts(scratch, { claudeHome, into });
    expect(moved.length).toBe(1);
    expect(fs.existsSync(path.join(moved[0], "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(moved[0], "memory", "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(claudeHome, "projects", encode(scratch)))).toBe(false);
    expect(fs.existsSync(path.join(claudeHome, "projects", "C--Users-me-chat-e2e-notes", "b.jsonl"))).toBe(true);
    expect(collectE2eTranscripts(scratch, { claudeHome, into })).toEqual([]);
  });

  it("refuses a folder that isn't a test folder", () => {
    expect(() => collectE2eTranscripts(os.homedir(), { claudeHome, into })).toThrow(/refusing/);
  });
});
