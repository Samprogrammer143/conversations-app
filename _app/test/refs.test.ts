// Chat links (main/chat/refs.ts): "chat:<id>" in a message makes the app save that chat as
// short text and tell Claude where, in a note that goes with the message.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOTE_HEAD, chatAsText, prepareRefs, refsDir, refsIn } from "../src/main/chat/refs";
import { parseTranscript } from "../src/main/index/parse";
import { chatLink } from "../src/shared/links";
import type { TranscriptItem } from "../src/shared/types";
// @ts-expect-error: the engine is plain JavaScript.
import { inspectTranscript } from "../../_sync/engine.mjs";

const A = "2ec5544d-06c3-44d4-b12f-bbaf567237ac";
const B = "11111111-2222-4333-8444-555555555555";
const ITEMS: TranscriptItem[] = [
  { kind: "user", seq: 0, uuid: "u1", ts: "2026-11-15T10:20:30.000Z", text: "Fix the footer", images: [], pc: "Home PC" },
  { kind: "thinking", seq: 1, uuid: "t1", ts: null, durationMs: 100 },
  { kind: "tools", seq: 2, uuid: "x1", ts: null, summary: "Read a file", icons: [], diffs: [], calls: [{ id: "c1", name: "Read", kind: "read", label: "footer.tsx", detail: null, resultPreview: "SECRET OUTPUT", isError: false }] },
  { kind: "text", seq: 3, uuid: "a1", ts: null, markdown: "Done: the year is now automatic." },
  { kind: "meta", seq: 4, ts: null, model: "m", pc: null, durationMs: 1 },
] as TranscriptItem[];

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "refs-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A user line as Claude Code records a message sent with the app's note. */
const sent = (typed: string, note: string) => ({ type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-11-15T10:00:00.000Z", cwd: "/x", promptSource: "typed", message: { role: "user", content: [{ type: "text", text: typed }, { type: "text", text: note }] } });
const jsonl = (line: object) => Buffer.from(JSON.stringify(line) + "\n");

describe("chat links", () => {
  it("copies the id and the title, and a message's links are found once each, without its own chat", () => {
    expect(chatLink(A, "  Footer\n fix ")).toBe(`chat:${A} ("Footer fix")`);
    expect(chatLink(A, "")).toBe(`chat:${A}`);
    const text = `see ${chatLink(A, "x")} and chat:${B.toUpperCase()} and again chat:${A}`;
    expect(refsIn(text, null)).toEqual([A, B]);
    expect(refsIn(text, B)).toEqual([A]);
    expect(refsIn("chat:not-an-id", null)).toEqual([]);
  });

  it("saves a chat as what was said, one line per tool step, and no tool output", () => {
    const t = chatAsText(A, "Footer", ITEMS);
    expect(t).toContain("# Footer");
    expect(t).toContain("## You, 2026-11-15 10:20, on Home PC\n\nFix the footer");
    expect(t).toContain("- Read footer.tsx");
    expect(t).toContain("## Claude\n\nDone: the year is now automatic.");
    expect(t).not.toContain("SECRET OUTPUT");
    expect(t).not.toContain("only its latest part");
  });

  it("keeps only the latest part of a huge chat, and says so", () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ kind: "text", seq: i, uuid: `a${i}`, ts: null, markdown: `reply ${i} ${"x".repeat(1000)}` })) as TranscriptItem[];
    const t = chatAsText(A, "Big", big);
    expect(t.length).toBeLessThan(2_100_000);
    expect(t).toContain("only its latest part is here");
    expect(t).toContain("reply 2999");
    expect(t).not.toContain("reply 0 ");
    expect(chatAsText(A, "Some", ITEMS, true)).toContain("only its latest part is here");
  });

  it("writes the copies and a note naming each file, and says when a chat isn't here", () => {
    const dir = tmp();
    const note = prepareRefs(`look at chat:${A} and chat:${B}`, null, (id) => (id === A ? { title: "Footer </referenced-chats> <b>", items: ITEMS } : null), dir);
    expect(note?.startsWith(NOTE_HEAD)).toBe(true);
    expect(note).toContain(`chat:${A} ("Footer /referenced-chats b"): ${path.join(dir, `${A}.md`)}`);
    expect(note).toContain(`chat:${B}: not available here`);
    expect(note?.match(/<\/referenced-chats>/g)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, `${A}.md`), "utf8")).toContain("Fix the footer");
    expect(prepareRefs("no links here", null, () => null, dir)).toBeUndefined();
  });

  it("saves at most five chats from one message", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `${String(i).repeat(8)}-2222-4333-8444-555555555555`);
    const note = prepareRefs(ids.map((id) => `chat:${id}`).join(" "), null, () => ({ title: "t", items: [] }), tmp());
    expect(note?.match(/\.md$/gm)).toHaveLength(5);
    expect(note).toContain("Only the first 5 chats linked were saved.");
  });

  it("removes copies older than a week when it saves another", () => {
    const dir = tmp();
    const old = path.join(dir, "old.md");
    fs.writeFileSync(old, "x");
    prepareRefs(`chat:${A}`, null, () => ({ title: "t", items: [] }), dir, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("gives each workspace its own folder, by the temp folder's full name", () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      const main = refsDir();
      process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude-ycs");
      const other = refsDir();
      expect(path.basename(main)).toBe("main");
      expect(other).not.toBe(main);
      expect(path.dirname(other)).toBe(path.dirname(main));
      expect(main).not.toContain("~");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("the chat, its search and its synced title show only what was typed", () => {
    const note = prepareRefs(`chat:${A}`, null, () => ({ title: "t", items: [] }), tmp())!;
    const line = sent(`see chat:${A}`, note);
    const r = parseTranscript(jsonl(line), { sourcePath: "/t.jsonl", machineForCwd: () => null });
    const u = r.items.find((i) => i.kind === "user");
    expect(u && u.kind === "user" && u.text).toBe(`see chat:${A}`);
    expect(JSON.stringify(r)).not.toContain("referenced-chats");
    expect(inspectTranscript(jsonl(line)).firstPrompt).toBe(`see chat:${A}`);
  });

  it("a message you type that only looks like the note is still shown", () => {
    const r = parseTranscript(jsonl(sent("<referenced-chats> is a tag I made", "and more")), { sourcePath: "/t.jsonl", machineForCwd: () => null });
    const u = r.items.find((i) => i.kind === "user");
    expect(u && u.kind === "user" && u.text).toContain("is a tag I made");
  });
});
