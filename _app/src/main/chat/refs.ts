// Chat links: "chat:<id>" pasted into a message. When it is sent, the app saves each chat
// it names as a short text copy (your messages, the replies, one line per tool step) and
// tells Claude where, in a note that goes with the message but isn't shown in the chat.
// Claude then reads only what it needs of the other chat.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTE_HEAD } from "../../shared/links";
import type { TranscriptItem } from "../../shared/types";

export { NOTE_HEAD };

/**
 * Where this workspace's copies go: each workspace (one Claude account) has its own folder,
 * and its chats' Claude Code may read there without asking. The temp folder by its full
 * name: Windows may give a short one (C:\Users\CODING~1\...), and Claude Code then asks
 * before reading there.
 */
export function refsDir(): string {
  const account = process.env.CLAUDE_CONFIG_DIR;
  const key = account ? createHash("sha1").update(account).digest("hex").slice(0, 12) : "main";
  return path.join(longPath(os.tmpdir()), "conversations-chats", key);
}

function longPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** At most this many chats in one message. */
export const MAX_REFS = 5;

/** A copy keeps at most this many characters, the latest. */
const MAX_CHARS = 2_000_000;

/** A copy older than this is removed the next time one is saved. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const REF_RE = /\bchat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/** The chats a message names, each once, in order, without the chat it is sent in. */
export function refsIn(text: string, self: string | null): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const id = m[1].toLowerCase();
    if (id !== self && !out.includes(id)) out.push(id);
  }
  return out;
}

/** A title on one line, with nothing that could pass for the note's own tags. */
const cleanTitle = (t: string) => t.replace(/[<>]/g, "").replace(/\s+/g, " ").trim() || "Untitled chat";

const time = (ts: string | null) => (ts ? ts.slice(0, 16).replace("T", " ") : null);

/**
 * A chat as short text: what was said, and one line for each tool step instead of its
 * output. `cut`: the items are only the latest ones. Past MAX_CHARS, the start is left out.
 */
export function chatAsText(id: string, title: string, items: TranscriptItem[], cut = false): string {
  const head = [`# ${cleanTitle(title)}`, "", `Chat ${id}, saved as text by the Conversations app. Tool output is left out; each tool step is one line.`];
  const out: string[] = [];
  for (const it of items) {
    switch (it.kind) {
      case "user": {
        const who = ["## You", time(it.ts), it.pc ? `on ${it.pc}` : null].filter(Boolean).join(", ");
        const pics = it.images.length ? `\n[${it.images.length} image${it.images.length === 1 ? "" : "s"} attached]` : "";
        out.push(who, "", `${it.text}${pics}`.trim(), "");
        break;
      }
      case "text":
        out.push("## Claude", "", it.markdown.trim(), "");
        break;
      case "tools":
        for (const c of it.calls) {
          const what = [c.label, c.detail && c.detail !== c.label ? c.detail : null].filter(Boolean).join(": ").replace(/\s+/g, " ").slice(0, 200);
          out.push(`- ${c.name}${what ? ` ${what}` : ""}${c.denied ? " (refused)" : c.isError ? " (failed)" : ""}`);
        }
        out.push("");
        break;
      case "command":
        out.push(`- /${it.name}${it.args ? ` ${it.args}` : ""}`.slice(0, 300), "");
        break;
      case "shell":
        out.push(`- ! ${it.command}`.slice(0, 300), "");
        break;
      case "compact":
        out.push("[The chat was compacted here: earlier context was summarised.]", "");
        break;
      case "notice":
        if (it.tone === "error") out.push(`[${it.title}]`, "");
        break;
      default:
        break;
    }
  }
  let body = out.join("\n").replace(/\n{3,}/g, "\n\n");
  if (body.length > MAX_CHARS) {
    body = body.slice(body.length - MAX_CHARS);
    body = body.slice(body.indexOf("\n") + 1);
    cut = true;
  }
  if (cut) head.push("The chat is long: only its latest part is here.");
  return `${head.join("\n")}\n\n${body}`;
}

export interface RefChat {
  title: string;
  items: TranscriptItem[];
  /** Only the latest items. */
  cut?: boolean;
}

/**
 * Saves a copy of each chat the message names and returns the note for Claude; undefined
 * when it names none. A chat that isn't here is said to be missing, not guessed at.
 */
export function prepareRefs(text: string, self: string | null, lookup: (id: string) => RefChat | null, dir = refsDir(), now = Date.now()): string | undefined {
  const ids = refsIn(text, self);
  if (!ids.length) return undefined;
  fs.mkdirSync(dir, { recursive: true });
  prune(dir, now);
  const lines: string[] = [];
  for (const id of ids.slice(0, MAX_REFS)) {
    const chat = lookup(id);
    if (!chat) {
      lines.push(`chat:${id}: not available here (deleted, in another workspace, or not on this computer yet).`);
      continue;
    }
    const file = path.join(dir, `${id}.md`);
    fs.writeFileSync(file, chatAsText(id, chat.title, chat.items, chat.cut));
    lines.push(`chat:${id} ("${cleanTitle(chat.title)}"): ${file}`);
  }
  if (ids.length > MAX_REFS) lines.push(`(Only the first ${MAX_REFS} chats linked were saved.)`);
  return [
    NOTE_HEAD,
    "The Conversations app saved each as text, as of this message, at the path below. Read the file when it helps answer; for a long one, search it or read the end first.",
    ...lines,
    "</referenced-chats>",
  ].join("\n");
}

function prune(dir: string, now: number) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { force: true });
      } catch {
        // In use or gone: left for next time.
      }
    }
  } catch {
    // Nothing to prune.
  }
}
