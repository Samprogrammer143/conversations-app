import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { modelLabel, parseTranscript, summariseCalls } from "../src/main/index/parse";
import type { ToolCall } from "../src/shared/types";

const HOME_CWD = "C:\\Users\\alex\\Projects\\website";
const UNI_CWD = "C:\\Users\\jordan\\Code\\website";
const ctx = {
  sourcePath: "C:/t.jsonl",
  machineForCwd: (cwd: string | null | undefined) => (!cwd ? null : cwd.includes("jordan") ? "Uni PC" : "Home PC"),
};

let n = 0;
const uuid = () => `u-${++n}`;
const ts = (min: number) => new Date(Date.UTC(2026, 9, 10, 12, min)).toISOString();

function user(parent: string | null, text: string, min: number, cwd = HOME_CWD, extra: object = {}) {
  const id = uuid();
  return { id, line: { type: "user", uuid: id, parentUuid: parent, isSidechain: false, message: { role: "user", content: text }, timestamp: ts(min), cwd, promptSource: "typed", ...extra } };
}
function assistant(parent: string, content: unknown[], min: number, cwd = HOME_CWD, model = "claude-opus-5-5") {
  const id = uuid();
  return { id, line: { type: "assistant", uuid: id, parentUuid: parent, isSidechain: false, message: { role: "assistant", model, content }, timestamp: ts(min), cwd } };
}
function toolResult(parent: string, toolUseId: string, text: string, min: number, toolUseResult?: unknown, cwd = HOME_CWD) {
  const id = uuid();
  return { id, line: { type: "user", uuid: id, parentUuid: parent, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] }, toolUseResult, timestamp: ts(min), cwd } };
}
const jsonl = (lines: object[]) => Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

describe("parseTranscript", () => {
  it("shows typed prompts, replies and one meta line per turn", () => {
    const u1 = user(null, "Can you check the footer year?", 0);
    const a1 = assistant(u1.id, [{ type: "thinking", thinking: "" }, { type: "text", text: "They still say **2026**." }], 1);
    const r = parseTranscript(jsonl([u1.line, a1.line, { type: "ai-title", aiTitle: "Footer year auto-update" }]), ctx);
    expect(r.items.map((i) => i.kind)).toEqual(["user", "text", "meta"]);
    expect(r.info.title).toBe("Footer year auto-update");
    expect(r.info.prompts).toBe(1);
    expect(r.info.preview).toBe("They still say 2026.");
    const meta = r.items[2];
    expect(meta.kind === "meta" && meta.model).toBe("claude-opus-5-5");
    expect(meta.kind === "meta" && meta.pc).toBe("Home PC");
  });

  it("skips commands, skill bodies, hook output and sidechains", () => {
    const u1 = user(null, "<command-name>/pull</command-name>", 0);
    const u2 = user(u1.id, "Base directory for this skill: x", 1, HOME_CWD, { isMeta: true });
    const u3 = user(u2.id, "Real question", 2);
    const side = user(u3.id, "subagent prompt", 3, HOME_CWD, { isSidechain: true });
    const att = { type: "attachment", uuid: uuid(), parentUuid: u3.id, attachment: { type: "hook_success", content: "Conversation sync is on" }, timestamp: ts(3), cwd: HOME_CWD };
    const r = parseTranscript(jsonl([u1.line, u2.line, u3.line, side.line, att]), ctx);
    expect(r.items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["Real question"]);
  });

  it("groups tool calls into one chip with a plain summary and a diff", () => {
    const u1 = user(null, "Fix it", 0);
    const a1 = assistant(u1.id, [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:\\repo\\lib\\seasons.ts" } },
      { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "season", path: "C:\\repo" } },
    ], 1);
    const r1 = toolResult(a1.id, "t1", "file contents", 1);
    const r2 = toolResult(r1.id, "t2", "3 matches", 1);
    const a2 = assistant(r2.id, [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: "C:\\repo\\lib\\seasons.ts", old_string: "const year = 2026;", new_string: "const now = new Date();\nconst year = now.getFullYear();" } }], 2);
    const patch = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" export function nextSeason() {", "-  const year = 2026;", "+  const now = new Date();", "+  const year = now.getFullYear();", " }"] }];
    const r3 = toolResult(a2.id, "t3", "ok", 2, { structuredPatch: patch });
    const a3 = assistant(r3.id, [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "npm test" } }], 3);
    const r4 = toolResult(a3.id, "t4", "24 passed", 3);
    const a4 = assistant(r4.id, [{ type: "text", text: "Done." }], 4);
    const r = parseTranscript(jsonl([u1.line, a1.line, r1.line, r2.line, a2.line, r3.line, a3.line, r4.line, a4.line]), ctx);
    const chips = r.items.filter((i) => i.kind === "tools");
    expect(chips).toHaveLength(1);
    const chip = chips[0] as Extract<(typeof r.items)[number], { kind: "tools" }>;
    expect(chip.summary).toBe("Edited lib/seasons.ts, ran npm test, and 2 more");
    expect(chip.icons).toEqual(["read", "search"]);
    expect(chip.diffs[0].lines.map((l) => l.kind)).toEqual(["context", "del", "add", "add", "context"]);
    expect(chip.diffs[0].additions).toBe(2);
    expect(chip.calls[3].resultPreview).toBe("24 passed");
  });

  it("follows a compacted conversation across the boundary", () => {
    const u1 = user(null, "First", 0);
    const a1 = assistant(u1.id, [{ type: "text", text: "One" }], 1);
    const cb = { type: "system", subtype: "compact_boundary", uuid: uuid(), parentUuid: null, logicalParentUuid: a1.id, timestamp: ts(2), cwd: HOME_CWD };
    const sum = { type: "user", uuid: uuid(), parentUuid: cb.uuid, isCompactSummary: true, message: { role: "user", content: "summary" }, timestamp: ts(2), cwd: HOME_CWD };
    const u2 = user(sum.uuid, "Second", 3);
    const a2 = assistant(u2.id, [{ type: "text", text: "Two" }], 4);
    const r = parseTranscript(jsonl([u1.line, a1.line, cb, sum, u2.line, a2.line]), ctx);
    expect(r.items.map((i) => i.kind)).toEqual(["user", "text", "meta", "compact", "user", "text", "meta"]);
  });

  it("follows a boundary whose logical parent points forward (seen in real transcripts)", () => {
    const u1 = user(null, "Before compaction", 0);
    const a1 = assistant(u1.id, [{ type: "text", text: "One" }], 1);
    const cbId = uuid();
    const sumId = uuid();
    const remId = uuid();
    const cb = { type: "system", subtype: "compact_boundary", uuid: cbId, parentUuid: null, logicalParentUuid: remId, timestamp: ts(2), cwd: HOME_CWD };
    const sum = { type: "user", uuid: sumId, parentUuid: cbId, isCompactSummary: true, message: { role: "user", content: "summary" }, timestamp: ts(2), cwd: HOME_CWD };
    const rem = { type: "attachment", uuid: remId, parentUuid: sumId, attachment: { type: "total_tokens_reminder" }, timestamp: ts(2), cwd: HOME_CWD };
    const u2 = user(remId, "After compaction", 3);
    const a2 = assistant(u2.id, [{ type: "text", text: "Two" }], 4);
    const r = parseTranscript(jsonl([u1.line, a1.line, cb, sum, rem, u2.line, a2.line]), ctx);
    expect(r.info.prompts).toBe(2);
    expect(r.items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["Before compaction", "After compaction"]);
  });

  it("bridges a parent that was never written to the file", () => {
    const u1 = user(null, "First prompt", 0);
    const a1 = assistant(u1.id, [{ type: "text", text: "One" }], 1);
    const orphan = { type: "attachment", uuid: uuid(), parentUuid: "never-written", attachment: { type: "total_tokens_reminder" }, timestamp: ts(2), cwd: HOME_CWD };
    const u2 = user(orphan.uuid, "Second prompt", 3);
    const a2 = assistant(u2.id, [{ type: "text", text: "Two" }], 4);
    const r = parseTranscript(jsonl([u1.line, a1.line, orphan, u2.line, a2.line]), ctx);
    expect(r.info.prompts).toBe(2);
  });

  it("keeps both parts when two PCs continued at the same time", () => {
    const u1 = user(null, "Start", 0);
    const a1 = assistant(u1.id, [{ type: "text", text: "Ready" }], 1);
    const uUni = user(a1.id, "Add the login tests", 2, UNI_CWD);
    const aUni = assistant(uUni.id, [{ type: "text", text: "Added 18 test cases." }], 3, UNI_CWD);
    const uHome = user(a1.id, "Remove the two old feature flags", 4);
    const aHome = assistant(uHome.id, [{ type: "text", text: "Removed two." }], 5);
    const r = parseTranscript(jsonl([u1.line, a1.line, uHome.line, aHome.line, uUni.line, aUni.line]), ctx);
    const kinds = r.items.map((i) => i.kind);
    expect(kinds).toContain("parts");
    const parts = r.items.filter((i) => i.kind === "part").map((i) => (i as { label: string }).label);
    expect(parts).toEqual(["Part 1 · Uni PC", "Part 2 · Home PC"]);
    const texts = r.items.filter((i) => i.kind === "text").map((i) => (i as { markdown: string }).markdown);
    expect(texts).toEqual(["Ready", "Added 18 test cases.", "Removed two."]);
  });

  it("hides a retried branch on the same PC, like Claude Code", () => {
    const u1 = user(null, "Start", 0);
    const a1 = assistant(u1.id, [{ type: "text", text: "Hi" }], 1);
    const old = user(a1.id, "first wording", 2);
    const oldA = assistant(old.id, [{ type: "text", text: "old answer" }], 3);
    const retry = user(a1.id, "second wording", 4);
    const retryA = assistant(retry.id, [{ type: "text", text: "new answer" }], 5);
    const r = parseTranscript(jsonl([u1.line, a1.line, old.line, oldA.line, retry.line, retryA.line]), ctx);
    // Same PC: the old branch has typed prompts too, but it is not a two-PC split.
    const texts = r.items.filter((i) => i.kind === "text").map((i) => (i as { markdown: string }).markdown);
    expect(texts).toContain("new answer");
  });

  it("records images as keys, never as data", () => {
    const id = uuid();
    const line = { type: "user", uuid: id, parentUuid: null, message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "see this" }] }, timestamp: ts(0), cwd: HOME_CWD };
    const r = parseTranscript(jsonl([line]), ctx);
    const u = r.items[0] as Extract<(typeof r.items)[number], { kind: "user" }>;
    expect(u.images).toHaveLength(1);
    expect(u.images[0].key).toContain("|0|0");
    expect(JSON.stringify(r.items)).not.toContain("AAAA");
  });

  it("ignores an unfinished last line", () => {
    const u1 = user(null, "Hello", 0);
    const buf = Buffer.concat([jsonl([u1.line]), Buffer.from('{"type":"assistant","uuid":"x"')]);
    const r = parseTranscript(buf, ctx);
    expect(r.items.map((i) => i.kind)).toEqual(["user"]);
  });
});

describe("calls, owners and context", () => {
  it("marks a call with no result as pending and words the chip that way", () => {
    const u1 = user(null, "Delete the test file", 0);
    const a1 = assistant(u1.id, [{ type: "tool_use", id: "rm1", name: "PowerShell", input: { command: "Remove-Item -Force hello.txt" } }], 1);
    const r = parseTranscript(jsonl([u1.line, a1.line]), ctx);
    const chip = r.items.find((i) => i.kind === "tools");
    expect(chip && chip.kind === "tools" && chip.calls[0].pending).toBe(true);
    expect(chip && chip.kind === "tools" && chip.summary).toBe("Asked to run Remove-Item -Force hello.txt");
  });

  it("words a refused call as not run once the refusal is in the file", () => {
    const u1 = user(null, "Delete the test file", 0);
    const a1 = assistant(u1.id, [{ type: "tool_use", id: "rm1", name: "PowerShell", input: { command: "Remove-Item -Force hello.txt" } }], 1);
    const r1 = toolResult(a1.id, "rm1", "The user denied this in the Conversations app.", 2);
    (r1.line.message.content as { is_error?: boolean }[])[0].is_error = true;
    const a2 = assistant(r1.id, [{ type: "text", text: "OK, I left it." }], 3);
    const r = parseTranscript(jsonl([u1.line, a1.line, r1.line, a2.line]), ctx);
    const chip = r.items.find((i) => i.kind === "tools");
    expect(chip && chip.kind === "tools" && chip.summary).toBe("Didn't run Remove-Item -Force hello.txt");
  });

  it("keeps a terminal conversation carried on in the app visible, and hides SDK-only runs", () => {
    const u1 = user(null, "Started in the terminal", 0, HOME_CWD, { entrypoint: "cli" });
    const a1 = assistant(u1.id, [{ type: "text", text: "Hi" }], 1);
    const u2 = user(a1.id, "Carried on in the app", 2, HOME_CWD, { entrypoint: "sdk-cli" });
    expect(parseTranscript(jsonl([u1.line, a1.line, u2.line]), ctx).info.headless).toBe(false);
    const s1 = user(null, "Scripted run", 0, HOME_CWD, { entrypoint: "sdk-cli" });
    expect(parseTranscript(jsonl([s1.line]), ctx).info.headless).toBe(true);
  });

  it("records the tokens in context at the last reply", () => {
    const u1 = user(null, "Hello", 0);
    const a1 = assistant(u1.id, [{ type: "text", text: "Hi" }], 1);
    (a1.line.message as { usage?: object }).usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 250_000 };
    const u2 = user(a1.id, "More", 2);
    const a2 = assistant(u2.id, [{ type: "text", text: "Sure" }], 3);
    (a2.line.message as { usage?: object }).usage = { input_tokens: 5, cache_creation_input_tokens: 500, cache_read_input_tokens: 90_000 };
    const info = parseTranscript(jsonl([u1.line, a1.line, u2.line, a2.line]), ctx).info;
    expect(info.contextTokens).toBe(90_505);
    expect(info.peakContextTokens).toBe(251_002);
  });
});

describe("summaries and labels", () => {
  const call = (name: string, kind: ToolCall["kind"], label: string, server?: string): ToolCall => ({ id: label, name, kind, label, detail: null, resultPreview: null, isError: false, server });
  it("reads like a sentence", () => {
    expect(summariseCalls([call("Read", "read", "a.ts"), call("Read", "read", "b.ts"), call("Read", "read", "c.ts"), call("Grep", "search", "x")])).toBe("Read 3 files, searched code");
    expect(summariseCalls([call("WebSearch", "web", "q"), call("WebSearch", "web", "q2")])).toBe("Searched the web 2 times");
    expect(summariseCalls([call("mcp__plugin_figma_figma__use_figma", "mcp", "Figma", "Figma")])).toBe("Used Figma");
  });
  it("says what you denied instead of claiming it ran", () => {
    const denied = { ...call("PowerShell", "command", "Remove-Item -Force hello.txt"), isError: true, denied: true };
    expect(summariseCalls([denied])).toBe("Didn't run Remove-Item -Force hello.txt");
    expect(summariseCalls([call("Read", "read", "a.ts"), denied])).toBe("Read a.ts, didn't run Remove-Item -Force hello.txt");
  });
  it("never says a call ran before its result arrives", () => {
    const waiting = { ...call("PowerShell", "command", "Remove-Item -Force hello.txt"), pending: true };
    expect(summariseCalls([waiting])).toBe("Asked to run Remove-Item -Force hello.txt");
    expect(summariseCalls([call("Read", "read", "a.ts"), waiting])).toBe("Read a.ts, asked to run Remove-Item -Force hello.txt");
    const write = { ...call("Write", "write", "hello.txt"), pending: true };
    expect(summariseCalls([write])).toBe("Asked to write hello.txt");
    const stopped = { ...call("Bash", "command", "npm test"), isError: true, interrupted: true };
    expect(summariseCalls([stopped])).toBe("Stopped npm test");
  });
  it("says wrote, not created, when a file was replaced", () => {
    const replaced = { ...call("Write", "write", "a.ts"), diff: { path: "a.ts", additions: 1, removals: 1, lines: [], truncated: false, created: false } };
    expect(summariseCalls([replaced])).toBe("Wrote a.ts");
  });
  it("names models the short way", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
});

// Every real transcript on this PC parses, quickly.
const root = path.join(os.homedir(), ".claude", "projects");
const real: string[] = [];
try {
  for (const d of fs.readdirSync(root)) {
    try {
      for (const f of fs.readdirSync(path.join(root, d))) if (f.endsWith(".jsonl")) real.push(path.join(root, d, f));
    } catch {}
  }
} catch {}

describe.skipIf(!real.length)("real transcripts", () => {
  it(`parses all ${real.length} local transcripts`, () => {
    let totalMs = 0;
    let worst = { file: "", ms: 0, mb: 0 };
    for (const p of real) {
      const buf = fs.readFileSync(p);
      const t0 = performance.now();
      const r = parseTranscript(buf, { ...ctx, sourcePath: p });
      const ms = performance.now() - t0;
      totalMs += ms;
      if (ms > worst.ms) worst = { file: path.basename(p), ms: Math.round(ms), mb: Math.round(buf.length / 1048576) };
      expect(r.info.title.length).toBeGreaterThan(0);
      for (const it of r.items) expect(typeof it.seq).toBe("number");
    }
    console.log(`parsed ${real.length} transcripts in ${Math.round(totalMs)} ms; slowest ${worst.file} (${worst.mb} MB) ${worst.ms} ms`);
  }, 120_000);
});
