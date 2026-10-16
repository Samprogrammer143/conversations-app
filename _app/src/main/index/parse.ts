// Turns a Claude Code transcript (JSON lines) into what the window shows: user
// bubbles, Claude's text, tool activity chips with their diffs, day separators,
// and one meta line per turn. Also extracts the list row details and the text
// that full-text search indexes.
//
// A transcript is a tree: every entry points at its parent. Claude Code shows the
// branch that ends in the newest entry, and so does this. When the same
// conversation was continued on two PCs before they synced, both branches have
// user prompts after the fork; then both are shown, as Part 1 and Part 2.

import type { DiffBlock, DiffLine, ImageRef, ToolCall, ToolKind, TranscriptItem } from "../../shared/types";
import { summariseCalls } from "../../shared/summary";

export { summariseCalls };

export interface ParseContext {
  /** Which PC wrote an entry, from its working folder. */
  machineForCwd: (cwd: string | null | undefined) => string | null;
  /** Used to build image keys the main process can resolve later. */
  sourcePath: string;
}

export interface ParsedInfo {
  title: string;
  aiTitle: string | null;
  customTitle: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  preview: string;
  prompts: number;
  startedAt: string | null;
  lastAt: string | null;
  model: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  lastPc: string | null;
  pcs: string[];
  /** Only ever run through the SDK or `claude -p`, never in an interactive Claude Code. */
  headless: boolean;
  /** Tokens in the context at the last reply (what "% of context used" measures). */
  contextTokens: number | null;
  /** The most tokens any reply in this conversation had in context. */
  peakContextTokens: number;
  lines: number;
}

export interface FtsRow {
  seq: number;
  role: "prompt" | "reply" | "tool";
  body: string;
}

export interface ParseResult {
  items: TranscriptItem[];
  info: ParsedInfo;
  fts: FtsRow[];
}

interface Entry {
  line: number;
  offset: number;
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  subtype?: string;
  promptSource?: string;
  message?: { role?: string; model?: string; content?: unknown; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  toolUseResult?: unknown;
  durationMs?: number;
  content?: unknown;
  error?: unknown;
  level?: string;
  // title entries
  aiTitle?: string;
  customTitle?: string;
  title?: string;
  summary?: string;
  leafUuid?: string;
  lastPrompt?: string;
  [k: string]: unknown;
}

const MESSAGE_TYPES = new Set(["user", "assistant", "system", "attachment"]);

/** Splits a buffer into complete JSON lines with their byte offsets. */
export function splitLines(buf: Buffer, startOffset = 0): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(10, start);
    if (nl === -1) break; // an unfinished last line is still being written
    if (nl > start) {
      const text = buf.toString("utf8", start, nl).replace(/\r$/, "");
      if (text.trim()) out.push({ text, offset: startOffset + start });
    }
    start = nl + 1;
  }
  return out;
}

export function parseEntries(buf: Buffer): Entry[] {
  const entries: Entry[] = [];
  let i = 0;
  for (const l of splitLines(buf)) {
    let j: Entry;
    try {
      j = JSON.parse(l.text);
    } catch {
      continue;
    }
    if (!j || typeof j !== "object") continue;
    j.line = i++;
    j.offset = l.offset;
    entries.push(j);
  }
  return entries;
}

// ------------------------------------------------------------------ text helpers

const META_PREFIXES = ["<command-", "<local-command-", "<system-reminder", "<bash-", "<task-notification", "<user-memory-input", "Base directory for this skill", "Caveat: The messages below", "[Request interrupted"];

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** A "!" command as Claude Code's bash mode records it: the command, then what it printed. */
export function bashRecord(text: string): { command: string } | { stdout: string; stderr: string } | null {
  const input = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(text);
  if (input) return { command: unescapeXml(input[1]).trim() };
  const output = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/.exec(text);
  if (output) return { stdout: unescapeXml(output[1]), stderr: unescapeXml(output[2] ?? "") };
  return null;
}

/**
 * A slash command as Claude Code records what you typed: "<command-name>/mcp</command-name>
 * <command-message>mcp</command-message><command-args>reconnect x</command-args>" (a skill
 * puts the message first). Null for anything else.
 */
export function slashRecord(text: string): { name: string; args: string } | null {
  const t = text.trimStart();
  if (!t.startsWith("<command-")) return null;
  const name = /<command-name>\s*\/?([^<\s][^<]*?)\s*<\/command-name>/.exec(t)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1] ?? "";
  return { name, args: unescapeXml(args).trim() };
}

/** What a local command printed (<local-command-stdout>, <local-command-stderr>), without terminal colour codes. Null when the text is not that. */
export function localOutput(text: string): string | null {
  const t = text.trim();
  if (!/^<local-command-(stdout|stderr)>/.test(t)) return null;
  const parts = [...t.matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g)].map((m) => m[1]);
  // eslint-disable-next-line no-control-regex
  return parts.join("\n").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
}

export function isMetaText(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  return META_PREFIXES.some((p) => t.startsWith(p));
}

function blocksOf(content: unknown): { type: string; [k: string]: unknown }[] {
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object") as { type: string }[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function textFromToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain text of markdown, for list previews and snippets. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The last sentence-ish part of a reply, for the conversation list. */
function previewOf(md: string): string {
  const plain = plainText(md);
  if (plain.length <= 200) return plain;
  // Prefer the final sentence(s): replies tend to end with the outcome.
  const tail = plain.slice(-240);
  const cut = tail.search(/[.!?]\s+[A-Z]/);
  return clip(cut > 0 && cut < 160 ? tail.slice(cut + 2) : plain, 200);
}

// ------------------------------------------------------------------ tools

const SERVER_LABELS: [RegExp, string][] = [
  [/figma/i, "Figma"],
  [/posthog/i, "PostHog"],
  [/google-ads|googleads/i, "Google Ads"],
  [/analytics/i, "Google Analytics"],
  [/supabase/i, "Supabase"],
  [/claude-in-chrome|chrome-devtools|chrome/i, "Chrome"],
  [/linear/i, "Linear"],
  [/gmail/i, "Gmail"],
  [/slack/i, "Slack"],
  [/todoist/i, "Todoist"],
  [/brevo/i, "Brevo"],
  [/calendar/i, "Google Calendar"],
  [/drive/i, "Google Drive"],
  [/claude_docs|claude-docs/i, "Claude Docs"],
];

function serverLabel(server: string): string {
  for (const [re, label] of SERVER_LABELS) if (re.test(server)) return label;
  return server.replace(/^claude_ai_/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const HIDDEN_TOOLS = new Set(["ToolSearch"]);

function baseName(p: string): string {
  const s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = s.split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : s;
}

function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Grep":
    case "Glob":
    case "LS":
      return "search";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Write":
      return "write";
    case "Bash":
    case "PowerShell":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
    case "Monitor":
      return "command";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Agent":
    case "Task":
    case "SendMessage":
    case "TaskStop":
    case "TaskOutput":
      return "agent";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "ExitPlanMode":
    case "EnterPlanMode":
      return "plan";
    case "Skill":
      return "skill";
    case "AskUserQuestion":
      return "question";
    default:
      return "other";
  }
}

function describeCall(name: string, input: Record<string, unknown>): { label: string; detail: string | null; server?: string } {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (name.startsWith("mcp__")) {
    const [, server = "", tool = ""] = name.split("__");
    const label = serverLabel(server);
    return { label, detail: tool.replace(/_/g, " "), server: label };
  }
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "NotebookRead":
      return { label: baseName(str("file_path") || str("notebook_path")), detail: str("file_path") || str("notebook_path") || null };
    case "Grep":
      return { label: str("pattern"), detail: [str("pattern"), str("path") && `in ${baseName(str("path"))}`].filter(Boolean).join(" ") || null };
    case "Glob":
      return { label: str("pattern"), detail: str("pattern") || null };
    case "Bash":
    case "PowerShell":
      return { label: str("command").split("\n")[0], detail: str("command") || null };
    case "WebFetch":
      return { label: str("url").replace(/^https?:\/\//, "").split("/")[0], detail: str("url") || null };
    case "WebSearch":
      return { label: str("query"), detail: str("query") || null };
    case "Agent":
    case "Task":
      return { label: str("description") || "an agent", detail: str("description") || str("prompt").slice(0, 200) || null };
    case "Skill":
      return { label: str("skill"), detail: str("skill") || null };
    default:
      return { label: name, detail: null };
  }
}

const MAX_DIFF_LINES = 40;

function diffFromPatch(pathName: string, patch: unknown): DiffBlock | null {
  if (!Array.isArray(patch)) return null;
  const lines: DiffLine[] = [];
  let additions = 0;
  let removals = 0;
  let truncated = false;
  patch.forEach((hunk, h) => {
    const hl = (hunk as { lines?: unknown }).lines;
    if (!Array.isArray(hl)) return;
    if (h > 0 && lines.length) lines.push({ kind: "context", text: "…" });
    for (const raw of hl) {
      const s = String(raw);
      const kind: DiffLine["kind"] = s.startsWith("+") ? "add" : s.startsWith("-") ? "del" : "context";
      if (kind === "add") additions++;
      if (kind === "del") removals++;
      if (lines.length >= MAX_DIFF_LINES) {
        truncated = true;
        continue;
      }
      lines.push({ kind, text: s.slice(1) });
    }
  });
  if (!lines.length) return null;
  return { path: baseName(pathName), additions, removals, lines, truncated };
}

function diffFromStrings(pathName: string, oldS: string, newS: string): DiffBlock {
  const a = oldS.split("\n");
  const b = newS.split("\n");
  // Trim the common head and tail so the block shows only what changed.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lines: DiffLine[] = [];
  if (head > 0) lines.push({ kind: "context", text: a[head - 1] });
  for (const l of a.slice(head, a.length - tail)) lines.push({ kind: "del", text: l });
  for (const l of b.slice(head, b.length - tail)) lines.push({ kind: "add", text: l });
  if (tail > 0) lines.push({ kind: "context", text: a[a.length - tail] });
  const additions = b.length - head - tail;
  const removals = a.length - head - tail;
  const truncated = lines.length > MAX_DIFF_LINES;
  return { path: baseName(pathName), additions, removals, lines: lines.slice(0, MAX_DIFF_LINES), truncated };
}

function diffForCall(name: string, input: Record<string, unknown>, result: unknown): DiffBlock | null {
  const file = String(input.file_path ?? input.notebook_path ?? "");
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  if (name === "Edit" || name === "MultiEdit") {
    const fromPatch = diffFromPatch(file, r.structuredPatch);
    if (fromPatch) return fromPatch;
    if (typeof input.old_string === "string" && typeof input.new_string === "string") return diffFromStrings(file, input.old_string, input.new_string);
    if (Array.isArray(input.edits) && input.edits.length) {
      const e = input.edits[0] as { old_string?: string; new_string?: string };
      return diffFromStrings(file, String(e.old_string ?? ""), String(e.new_string ?? ""));
    }
    return null;
  }
  if (name === "Write") {
    const fromPatch = diffFromPatch(file, r.structuredPatch);
    if (fromPatch && r.type === "update") return { ...fromPatch, created: false };
    const content = typeof input.content === "string" ? input.content : "";
    const all = content.split("\n");
    const lines = all.slice(0, 12).map((t) => ({ kind: "add" as const, text: t }));
    return { path: baseName(file), additions: all.length, removals: 0, lines, truncated: all.length > 12, created: true };
  }
  return null;
}

// ------------------------------------------------------------------ the tree

function localDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isTypedPrompt(e: Entry): boolean {
  if (e.type !== "user" || e.isMeta || e.isCompactSummary || e.isSidechain) return false;
  const c = e.message?.content;
  if (typeof c === "string") return !isMetaText(c);
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return false;
    const text = c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n");
    const hasImage = c.some((b) => b?.type === "image");
    return hasImage || !isMetaText(text);
  }
  return false;
}

/** The entries Claude Code would show: the branch ending in the newest entry. */
function activePath(entries: Entry[], machineForCwd: ParseContext["machineForCwd"]): { path: Entry[]; alt: Entry[] | null; forkIndex: number } {
  const byUuid = new Map<string, Entry>();
  const children = new Map<string, Entry[]>();
  const msgs: Entry[] = [];
  for (const e of entries) {
    if (!MESSAGE_TYPES.has(e.type) || !e.uuid) continue;
    if (e.isSidechain) continue;
    msgs.push(e);
    byUuid.set(e.uuid, e);
  }
  // A compaction boundary starts a new chain; its logicalParentUuid says where the
  // old one ended. Some Claude Code versions point it at an entry written after
  // the boundary, so then the last entry written before it is used instead.
  const position = new Map<Entry, number>(msgs.map((m, i) => [m, i]));
  const before = (e: Entry): Entry | undefined => {
    const i = position.get(e);
    return i ? msgs[i - 1] : undefined;
  };
  // Transcripts also reference parents that were never written (entries Claude
  // Code keeps only in memory); the chain then continues from the entry written
  // just before, which is how the conversation actually ran.
  const parentOf = (e: Entry): string | null => {
    if (e.parentUuid) return byUuid.has(e.parentUuid) ? e.parentUuid : before(e)?.uuid ?? null;
    if (e.subtype !== "compact_boundary") return null;
    const logical = e.logicalParentUuid ? byUuid.get(e.logicalParentUuid) : undefined;
    if (logical && logical.line < e.line) return logical.uuid!;
    return before(e)?.uuid ?? null;
  };
  for (const e of msgs) {
    const p = parentOf(e);
    if (!p) continue;
    const list = children.get(p) ?? [];
    list.push(e);
    children.set(p, list);
  }
  // Newest user or assistant entry: that is where the conversation is now.
  let leaf: Entry | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === "user" || msgs[i].type === "assistant") {
      leaf = msgs[i];
      break;
    }
  }
  if (!leaf) return { path: msgs, alt: null, forkIndex: -1 };
  // Entries written after the leaf on the same branch (turn duration, notices) belong to it too.
  let tip = leaf;
  for (;;) {
    const kids = (children.get(tip.uuid!) ?? []).filter((k) => k.type === "system" || k.type === "attachment");
    if (!kids.length) break;
    tip = kids[kids.length - 1];
  }
  const path: Entry[] = [];
  const seen = new Set<string>();
  for (let e: Entry | undefined = tip; e && !seen.has(e.uuid!); e = byUuid.get(parentOf(e) ?? "")) {
    seen.add(e.uuid!);
    path.push(e);
  }
  path.reverse();

  // A fork where another branch also has typed prompts, written on another PC:
  // the conversation was continued in two places at once. Keep both. A fork on
  // the same PC is a retry or a rewind, and Claude Code shows only the newest.
  const onPath = new Set(path.map((e) => e.uuid));
  const pcOf = (list: Entry[]) => machineForCwd(list.find((x) => x.type === "user" || x.type === "assistant")?.cwd);
  for (let i = path.length - 1; i >= 0; i--) {
    const kids = children.get(path[i].uuid!) ?? [];
    if (kids.length < 2) continue;
    const mainPc = pcOf(path.slice(i + 1));
    for (const k of kids) {
      if (onPath.has(k.uuid)) continue;
      const branch = collectBranch(k, children);
      if (!branch.some(isTypedPrompt)) continue;
      const altPc = pcOf(branch);
      if (!altPc || !mainPc || altPc === mainPc) continue;
      return { path, alt: branch, forkIndex: i };
    }
  }
  return { path, alt: null, forkIndex: -1 };
}

/** For diagnostics and tests: the uuids on the shown branch. */
export function activePathUuids(buf: Buffer): string[] {
  return activePath(parseEntries(buf), () => null).path.map((e) => e.uuid ?? "");
}

/** One branch from a starting entry: always follow the newest child. */
function collectBranch(start: Entry, children: Map<string, Entry[]>): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (let e: Entry | undefined = start; e && !seen.has(e.uuid!); ) {
    seen.add(e.uuid!);
    out.push(e);
    const kids: Entry[] = children.get(e.uuid!) ?? [];
    e = kids[kids.length - 1];
  }
  return out;
}

// ------------------------------------------------------------------ main entry

export function parseTranscript(buf: Buffer, ctx: ParseContext): ParseResult {
  const entries = parseEntries(buf);
  const info: ParsedInfo = {
    title: "",
    aiTitle: null,
    customTitle: null,
    firstPrompt: null,
    lastPrompt: null,
    preview: "",
    prompts: 0,
    startedAt: null,
    lastAt: null,
    model: null,
    cwd: null,
    gitBranch: null,
    version: null,
    lastPc: null,
    pcs: [],
    headless: false,
    contextTokens: null,
    peakContextTokens: 0,
    lines: entries.length,
  };
  let sawSdk = false;
  let sawInteractive = false;
  let summary: string | null = null;
  const pcs = new Set<string>();
  for (const e of entries) {
    if (e.timestamp) {
      info.startedAt ??= e.timestamp;
      if (!info.lastAt || e.timestamp > info.lastAt) info.lastAt = e.timestamp;
    }
    if (e.type === "ai-title" && e.aiTitle) info.aiTitle = e.aiTitle;
    else if (e.type === "custom-title" && (e.customTitle || e.title)) info.customTitle = String(e.customTitle || e.title);
    else if (e.type === "summary" && e.summary && !summary) summary = e.summary;
    if (typeof e.version === "string") info.version = e.version;
    // A conversation is headless only if it never ran in an interactive Claude Code.
    // One you started in the terminal and carried on in the app stays visible.
    if (typeof e.entrypoint === "string") {
      if (e.entrypoint.startsWith("sdk")) sawSdk = true;
      else sawInteractive = true;
    }
    if (e.type === "assistant" && !e.isSidechain && e.message?.usage && e.message.model !== "<synthetic>") {
      const u = e.message.usage;
      const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (tokens > 0) {
        info.contextTokens = tokens;
        if (tokens > info.peakContextTokens) info.peakContextTokens = tokens;
      }
    }
    if (MESSAGE_TYPES.has(e.type) && !e.isSidechain) {
      if (typeof e.cwd === "string") info.cwd = e.cwd;
      if (typeof e.gitBranch === "string") info.gitBranch = e.gitBranch;
      const pc = ctx.machineForCwd(e.cwd);
      if (pc) {
        pcs.add(pc);
        if (e.type === "user" || e.type === "assistant") info.lastPc = pc;
      }
    }
  }
  info.pcs = [...pcs];
  info.headless = sawSdk && !sawInteractive;

  const { path, alt, forkIndex } = activePath(entries, ctx.machineForCwd);
  const items: TranscriptItem[] = [];
  const fts: FtsRow[] = [];
  let seq = 0;
  let lastDay: string | null = null;
  let lastReply = "";

  // The running state of one Claude turn.
  let turnModel: string | null = null;
  let turnTs: string | null = null;
  let turnPc: string | null = null;
  let turnDuration: number | null = null;
  let turnOpen = false;
  let group: { calls: ToolCall[]; uuid: string; ts: string | null } | null = null;
  const callsById = new Map<string, { call: ToolCall; input: Record<string, unknown>; name: string }>();
  const resultIds = new Set<string>();
  /** The "!" command whose output comes next. */
  let openShell: Extract<TranscriptItem, { kind: "shell" }> | null = null;
  /** The slash command whose output (if it prints any) comes next. */
  let openCommand: Extract<TranscriptItem, { kind: "command" }> | null = null;
  const commandOutput = (out: string) => {
    if (openCommand && openCommand.output === null && out) {
      openCommand.output = clip(out, 20_000);
      fts.push({ seq: openCommand.seq, role: "tool", body: clip(out, 4000) });
    }
    openCommand = null;
  };
  /**
   * Commands and "!" lines are shown and searchable, and the newest is the list's
   * last line, but they are not prompts: a session of only /usage or /model stays
   * out of the list (as it stays out of sync), and a chat that began with /model
   * is still titled by what you first asked. The first one names a chat that has
   * nothing else (one the app started that way).
   */
  let firstCommand: string | null = null;
  const noteCommand = (typed: string) => {
    const one = typed.replace(/\s+/g, " ").trim().slice(0, 200);
    firstCommand ??= one;
    info.lastPrompt = one;
  };

  const flushGroup = () => {
    if (!group) return;
    const visible = group.calls;
    if (visible.length) {
      const icons: ToolKind[] = [];
      for (const c of visible) if (!icons.includes(c.kind)) icons.push(c.kind);
      const diffs = visible.map((c) => c.diff).filter((d): d is DiffBlock => !!d);
      // Worded at the end, once every result in the file has been seen.
      items.push({ kind: "tools", seq: seq++, uuid: group.uuid, ts: group.ts, summary: "", icons: icons.slice(0, 2), calls: visible, diffs: diffs.slice(0, 3) });
      const toolText = visible.map((c) => [c.name, c.detail, c.resultPreview].filter(Boolean).join(" ")).join("\n");
      if (toolText.trim()) fts.push({ seq: seq - 1, role: "tool", body: clip(toolText, 4000) });
    }
    group = null;
  };
  const closeTurn = () => {
    flushGroup();
    if (turnOpen) items.push({ kind: "meta", seq: seq++, ts: turnTs, model: turnModel, pc: turnPc, durationMs: turnDuration });
    turnOpen = false;
    turnModel = null;
    turnTs = null;
    turnPc = null;
    turnDuration = null;
  };

  const addCommand = (slash: { name: string; args: string }, e: Entry) => {
    closeTurn();
    openShell = null;
    const day = localDate(e.timestamp);
    if (day && day !== lastDay) {
      if (lastDay !== null) items.push({ kind: "day", seq: seq++, date: day });
      lastDay = day;
    }
    openCommand = { kind: "command", seq: seq++, uuid: e.uuid ?? "", ts: e.timestamp ?? null, name: clip(slash.name, 200), args: clip(slash.args, 2000), output: null, pc: ctx.machineForCwd(e.cwd) };
    items.push(openCommand);
    const typed = `/${slash.name}${slash.args ? ` ${slash.args}` : ""}`;
    fts.push({ seq: openCommand.seq, role: "prompt", body: typed });
    noteCommand(typed);
  };

  const emitEntries = (list: Entry[]) => {
    for (const e of list) {
      if (e.type === "user") {
        const c = e.message?.content;
        const blocks = blocksOf(c);
        const results = blocks.filter((b) => b.type === "tool_result");
        if (results.length) {
          for (const r of results) {
            const hit = callsById.get(String(r.tool_use_id ?? ""));
            if (!hit) continue;
            const text = textFromToolResult(r.content);
            hit.call.resultPreview = text ? clip(text.trim(), 600) : null;
            hit.call.isError = r.is_error === true;
            resultIds.add(hit.call.id);
            hit.call.denied = hit.call.isError && /denied|rejected|declined|doesn't want to proceed|said no/i.test(text);
            hit.call.interrupted = hit.call.isError && !hit.call.denied && /interrupted/i.test(text);
            const d = diffForCall(hit.name, hit.input, e.toolUseResult);
            if (d && !hit.call.isError) hit.call.diff = d;
            if (hit.call.kind === "question") {
              const tur = (e.toolUseResult ?? {}) as { answers?: Record<string, string> };
              const answer = tur.answers ? Object.values(tur.answers).join("; ") : text || null;
              if (hit.call.question) hit.call.question.answer = answer ? clip(answer, 300) : null;
            }
          }
          continue;
        }
        const plain = typeof c === "string" ? c : blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
        const slash = !e.isMeta && !e.isSidechain && !e.isCompactSummary ? slashRecord(plain) : null;
        if (slash) {
          // A slash command or skill you ran: shown as what you typed.
          addCommand(slash, e);
          continue;
        }
        // /compact records what it printed as a user entry.
        const printed = !e.isSidechain ? localOutput(plain) : null;
        if (printed !== null) {
          commandOutput(printed);
          continue;
        }
        const bash = !e.isSidechain && !e.isCompactSummary ? bashRecord(typeof c === "string" ? c : blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("")) : null;
        if (bash && "command" in bash) {
          // Something you typed after "!", in the app or a terminal: it counts as a prompt.
          closeTurn();
          const day = localDate(e.timestamp);
          if (day && day !== lastDay) {
            if (lastDay !== null) items.push({ kind: "day", seq: seq++, date: day });
            lastDay = day;
          }
          openShell = { kind: "shell", seq: seq++, uuid: e.uuid ?? "", ts: e.timestamp ?? null, command: clip(bash.command, 4000), stdout: null, stderr: null, pc: ctx.machineForCwd(e.cwd) };
          items.push(openShell);
          openCommand = null;
          fts.push({ seq: openShell.seq, role: "prompt", body: `! ${bash.command}` });
          noteCommand(`! ${bash.command}`);
          continue;
        }
        if (bash && "stdout" in bash) {
          if (openShell && openShell.stdout === null && openShell.stderr === null) {
            openShell.stdout = clip(bash.stdout, 20_000);
            openShell.stderr = clip(bash.stderr, 8_000);
            const out = [bash.stdout, bash.stderr].join("\n").trim();
            if (out) fts.push({ seq: openShell.seq, role: "tool", body: clip(out, 4000) });
          }
          openShell = null;
          continue;
        }
        if (!isTypedPrompt(e)) continue;
        openShell = null;
        openCommand = null;
        closeTurn();
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .filter((t) => !isMetaText(t))
          .join("\n\n")
          .trim();
        const images: ImageRef[] = [];
        blocks.forEach((b, bi) => {
          if (b.type !== "image") return;
          const src = b.source as { type?: string; media_type?: string } | undefined;
          if (src?.type !== "base64") return;
          images.push({ key: `${encodeURIComponent(ctx.sourcePath)}|${e.offset}|${bi}`, mediaType: String(src.media_type ?? "image/png") });
        });
        const day = localDate(e.timestamp);
        if (day && day !== lastDay) {
          if (lastDay !== null) items.push({ kind: "day", seq: seq++, date: day });
          lastDay = day;
        }
        const pc = ctx.machineForCwd(e.cwd);
        items.push({ kind: "user", seq: seq++, uuid: e.uuid ?? "", ts: e.timestamp ?? null, text, images, pc });
        if (text) fts.push({ seq: seq - 1, role: "prompt", body: text });
        info.prompts++;
        const one = text.replace(/\s+/g, " ").slice(0, 200);
        if (one) {
          info.firstPrompt ??= one;
          info.lastPrompt = one;
        }
        lastDay = day ?? lastDay;
        continue;
      }
      if (e.type === "assistant") {
        // A command's output comes straight after it; once Claude speaks, nothing more attaches to it.
        openCommand = null;
        turnOpen = true;
        turnModel = e.message?.model && e.message.model !== "<synthetic>" ? e.message.model : turnModel;
        turnTs = e.timestamp ?? turnTs;
        turnPc = ctx.machineForCwd(e.cwd) ?? turnPc;
        for (const b of blocksOf(e.message?.content)) {
          if (b.type === "text") {
            const t = String(b.text ?? "").trim();
            if (!t || t === "(no content)") continue;
            flushGroup();
            items.push({ kind: "text", seq: seq++, uuid: e.uuid ?? "", ts: e.timestamp ?? null, markdown: t });
            fts.push({ seq: seq - 1, role: "reply", body: t });
            lastReply = t;
          } else if (b.type === "tool_use") {
            const name = String(b.name ?? "tool");
            if (HIDDEN_TOOLS.has(name)) continue;
            const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
            const d = describeCall(name, input);
            const call: ToolCall = {
              id: String(b.id ?? ""),
              name,
              kind: toolKind(name),
              label: clip(d.label || name, 80),
              detail: d.detail ? clip(d.detail, 2000) : null,
              resultPreview: null,
              isError: false,
              server: d.server,
              diff: null,
              question: null,
            };
            if (call.kind === "question") {
              const qs = Array.isArray(input.questions) ? (input.questions as { question?: string }[]) : [];
              call.question = { question: String(qs[0]?.question ?? "A question"), answer: null };
            }
            callsById.set(call.id, { call, input, name });
            group ??= { calls: [], uuid: e.uuid ?? "", ts: e.timestamp ?? null };
            group.calls.push(call);
          }
        }
        continue;
      }
      if (e.type === "system") {
        if (e.subtype === "turn_duration" && typeof e.durationMs === "number") turnDuration = e.durationMs;
        else if (e.subtype === "compact_boundary") {
          openCommand = null;
          closeTurn();
          items.push({ kind: "compact", seq: seq++, ts: e.timestamp ?? null });
        } else if (e.subtype === "api_error") {
          flushGroup();
          const err = (e.error ?? {}) as { status?: number; error?: { error?: { message?: string; type?: string } } };
          const msg = err.error?.error?.message ?? null;
          items.push({ kind: "notice", seq: seq++, ts: e.timestamp ?? null, tone: "error", title: `Claude couldn't reach Anthropic${err.status ? ` (error ${err.status})` : ""}`, body: msg });
        } else if (e.subtype === "local_command") {
          const content = String(e.content ?? "");
          const printed = localOutput(content);
          if (printed !== null) commandOutput(printed);
          else {
            // Claude Code also records the command itself here (terminal sessions of some
            // versions), with its output in the next local_command entry.
            const cmd = slashRecord(content);
            if (cmd) addCommand(cmd, e);
          }
        }
      }
    }
  };

  if (alt && forkIndex >= 0) {
    // Shared history, then both parts, each labelled with where it was written.
    emitEntries(path.slice(0, forkIndex + 1));
    closeTurn();
    const mainRest = path.slice(forkIndex + 1);
    const pcOf = (list: Entry[]) => ctx.machineForCwd(list.find((x) => x.type === "user" || x.type === "assistant")?.cwd) ?? "another PC";
    const firstTs = (list: Entry[]) => list.find((x) => x.timestamp)?.timestamp ?? null;
    const parts = [alt, mainRest].sort((a, b) => String(firstTs(a)).localeCompare(String(firstTs(b))));
    const pcsHere = [...new Set(parts.map(pcOf))];
    items.push({ kind: "parts", seq: seq++, ts: firstTs(parts[0]), label: `Continued on ${pcsHere.join(" and ")} at the same time · both parts kept` });
    parts.forEach((p, i) => {
      items.push({ kind: "part", seq: seq++, ts: firstTs(p), label: `Part ${i + 1} · ${pcOf(p)}` });
      emitEntries(p);
      closeTurn();
    });
  } else {
    emitEntries(path);
  }
  closeTurn();

  // A call with no result hasn't happened: Claude asked for it, and it is waiting
  // for approval, running, or was cut off. It is never worded as done.
  for (const it of items) {
    if (it.kind !== "tools") continue;
    for (const c of it.calls) if (!resultIds.has(c.id)) c.pending = true;
    it.summary = summariseCalls(it.calls);
  }

  info.customTitle = info.customTitle ?? null;
  info.title = info.customTitle || info.aiTitle || summary || info.firstPrompt || firstCommand || "Untitled conversation";
  info.preview = lastReply ? previewOf(lastReply) : info.lastPrompt ?? "";
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i].message?.model;
    if (path[i].type === "assistant" && m && m !== "<synthetic>") {
      info.model = m;
      break;
    }
  }
  return { items, info, fts };
}

/** "claude-opus-5-5" -> "Opus 5.5"; "claude-fable-5-1" -> "Fable 5.1". */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!m) return model;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const ver = m[3] && m[3].length <= 2 ? `${m[2]}.${m[3]}` : m[2];
  return `${name} ${ver}`;
}
