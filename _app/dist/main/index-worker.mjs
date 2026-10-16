import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/main/index/worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/main/index/db.ts
import { DatabaseSync } from "node:sqlite";
var SCHEMA_VERSION = 5;
function openDb(file, { readOnly = false } = {}) {
  const db2 = new DatabaseSync(file, { readOnly });
  db2.exec("PRAGMA busy_timeout = 4000");
  if (!readOnly) {
    db2.exec("PRAGMA journal_mode = WAL");
    db2.exec("PRAGMA synchronous = NORMAL");
    migrate(db2);
  }
  db2.exec("PRAGMA foreign_keys = OFF");
  return db2;
}
function migrate(db2) {
  db2.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db2.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  const current = Number(row?.value || 0);
  if (current === SCHEMA_VERSION) return;
  const keepState = current > 0 ? safeAll(db2, "SELECT conversation_id, seen_at, seen_last_at FROM local_state") : [];
  const keepApp = current > 0 ? safeAll(db2, "SELECT conversation_id, cwd, created_at FROM app_sessions") : [];
  db2.exec(`
    DROP TABLE IF EXISTS sources;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS items;
    DROP TABLE IF EXISTS fts;
    DROP TABLE IF EXISTS fts_rows;
    DROP TABLE IF EXISTS fts_title;
    DROP TABLE IF EXISTS fts_vocab;
    DROP TABLE IF EXISTS edits;
    DROP TABLE IF EXISTS local_state;
    DROP TABLE IF EXISTS app_sessions;
    DROP TABLE IF EXISTS machines;
    DROP TABLE IF EXISTS machine_activity;
  `);
  db2.exec(`
    CREATE TABLE sources (
      path TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL
    );
    CREATE INDEX sources_conv ON sources(conversation_id);

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      sig TEXT NOT NULL,
      primary_path TEXT,
      local_path TEXT,
      repo_dir TEXT,
      folder_key TEXT,
      project_id TEXT NOT NULL,
      project_label TEXT NOT NULL,
      title TEXT NOT NULL,
      first_prompt TEXT,
      last_prompt TEXT,
      preview TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      last_at TEXT,
      prompts INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      last_pc TEXT,
      pcs TEXT NOT NULL DEFAULT '[]',
      cwd TEXT,
      git_branch TEXT,
      model TEXT,
      version TEXT,
      context_tokens INTEGER,
      peak_context_tokens INTEGER NOT NULL DEFAULT 0,
      local_mtime_ms INTEGER,
      item_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX conversations_last ON conversations(last_at DESC);
    CREATE INDEX conversations_project ON conversations(project_id);

    CREATE TABLE items (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    ) WITHOUT ROWID;

    CREATE VIRTUAL TABLE fts USING fts5(body, conversation_id UNINDEXED, seq UNINDEXED, role UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
    CREATE TABLE fts_rows (conversation_id TEXT NOT NULL, row INTEGER NOT NULL);
    CREATE INDEX fts_rows_conv ON fts_rows(conversation_id);
    CREATE VIRTUAL TABLE fts_title USING fts5(title, conversation_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '1 2 3');
    CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(fts, 'row');

    CREATE TABLE edits (
      conversation_id TEXT PRIMARY KEY,
      pinned INTEGER,
      title TEXT,
      archived INTEGER,
      deleted INTEGER,
      app INTEGER
    );

    CREATE TABLE local_state (
      conversation_id TEXT PRIMARY KEY,
      seen_at TEXT,
      seen_last_at TEXT
    );

    CREATE TABLE app_sessions (
      conversation_id TEXT PRIMARY KEY,
      cwd TEXT,
      created_at TEXT
    );

    CREATE TABLE machines (
      prefix TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE machine_activity (
      name TEXT PRIMARY KEY,
      last_push_at TEXT
    );
  `);
  const insState = db2.prepare("INSERT OR REPLACE INTO local_state (conversation_id, seen_at, seen_last_at) VALUES (?, ?, ?)");
  for (const r of keepState) insState.run(r.conversation_id, r.seen_at, r.seen_last_at);
  const insApp = db2.prepare("INSERT OR REPLACE INTO app_sessions (conversation_id, cwd, created_at) VALUES (?, ?, ?)");
  for (const r of keepApp) insApp.run(r.conversation_id, r.cwd, r.created_at);
  db2.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
}
function safeAll(db2, sql) {
  try {
    return db2.prepare(sql).all();
  } catch {
    return [];
  }
}
function getMeta(db2, key) {
  const r = db2.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return r?.value ?? null;
}
function setMeta(db2, key, value) {
  db2.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
function tx(db2, fn) {
  db2.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db2.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db2.exec("ROLLBACK");
    } catch {
    }
    throw e;
  }
}

// src/main/index/indexer.ts
import fs2 from "node:fs";
import path2 from "node:path";
import zlib from "node:zlib";

// src/shared/summary.ts
var plural = (n, one, many) => n === 1 ? one : many.replace("#", String(n));
var cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
var shortLabel = (c, max = 32) => c.label.length <= max ? c.label : null;
function summariseCalls(calls) {
  const parts = [];
  const done = calls.filter((c) => !c.denied && !c.interrupted && !c.pending);
  if (done.length) parts.push(summariseDone(done));
  const stopped = calls.filter((c) => c.denied || c.interrupted);
  if (stopped.length === 1) parts.push(stoppedPhrase(stopped[0]));
  else if (stopped.length) parts.push(stopped.every((c) => c.denied) ? `didn't do ${stopped.length} things you said no to` : `stopped ${stopped.length} things before they finished`);
  const asked = calls.filter((c) => c.pending && !c.denied && !c.interrupted);
  if (asked.length) parts.push(askedPhrase(asked));
  return cap(parts.join(", "));
}
function stoppedPhrase(c) {
  const label = shortLabel(c);
  if (c.interrupted) {
    switch (c.kind) {
      case "command":
        return label ? `stopped ${label}` : "stopped a command";
      case "edit":
        return `stopped editing ${c.label}`;
      case "write":
        return `stopped writing ${c.label}`;
      case "read":
        return `stopped reading ${c.label}`;
      case "mcp":
        return `stopped using ${c.server ?? c.label}`;
      default:
        return `stopped ${c.name}`;
    }
  }
  switch (c.kind) {
    case "command":
      return label ? `didn't run ${label}` : "didn't run a command";
    case "edit":
      return `didn't edit ${c.label}`;
    case "write":
      return `didn't write ${c.label}`;
    case "read":
      return `didn't read ${c.label}`;
    case "web":
      return "didn't open a web page";
    case "mcp":
      return `didn't use ${c.server ?? c.label}`;
    default:
      return `didn't use ${c.name}`;
  }
}
function askedPhrase(calls) {
  const kinds = new Set(calls.map((c) => c.kind));
  const n = calls.length;
  if (kinds.size === 1) {
    const c = calls[0];
    const label = shortLabel(c);
    switch (c.kind) {
      case "command":
        return n === 1 ? label ? `asked to run ${label}` : "asked to run a command" : `asked to run ${n} commands`;
      case "edit":
        return n === 1 ? `asked to edit ${c.label}` : `asked to edit ${n} files`;
      case "write":
        return n === 1 ? `asked to write ${c.label}` : `asked to write ${n} files`;
      case "read":
        return n === 1 ? `asked to read ${c.label}` : `asked to read ${n} files`;
      case "search":
        return "asked to search code";
      case "web":
        return plural(n, "asked to open a web page", "asked to open # web pages");
      case "mcp":
        return `asked to use ${c.server ?? c.label}`;
      case "agent":
        return plural(n, "asked an agent", "asked # agents");
      case "question":
        return "asked you a question";
      case "plan":
        return c.name === "ExitPlanMode" ? "proposed a plan" : "updated the to-do list";
      case "skill":
        return `asked to use the ${c.label} skill`;
      default:
        return `asked to use ${c.name}`;
    }
  }
  return `asked to use ${n} tools`;
}
function summariseDone(calls) {
  const byKind = /* @__PURE__ */ new Map();
  for (const c of calls) {
    const list = byKind.get(c.kind) ?? [];
    list.push(c);
    byKind.set(c.kind, list);
  }
  const parts = [];
  for (const [kind, list] of byKind) {
    const n = list.length;
    const files = new Set(list.map((c) => c.label));
    switch (kind) {
      case "read":
        parts.push(files.size === 1 ? `read ${[...files][0]}` : `read ${files.size} files`);
        break;
      case "search":
        parts.push("searched code");
        break;
      case "edit":
        parts.push(files.size === 1 ? `edited ${[...files][0]}` : `edited ${files.size} files`);
        break;
      case "write": {
        const verb = list.every((c) => c.diff?.created !== false) ? "created" : "wrote";
        parts.push(files.size === 1 ? `${verb} ${[...files][0]}` : `${verb} ${files.size} files`);
        break;
      }
      case "command": {
        const short = list.length === 1 && list[0].label.length <= 28 ? list[0].label : null;
        parts.push(short ? `ran ${short}` : plural(n, "ran a command", "ran # commands"));
        break;
      }
      case "web": {
        const searches = list.filter((c) => c.name === "WebSearch").length;
        const pages = n - searches;
        if (searches) parts.push(plural(searches, "searched the web", "searched the web # times"));
        if (pages) parts.push(plural(pages, "read a web page", "read # web pages"));
        break;
      }
      case "mcp": {
        const servers = [...new Set(list.map((c) => c.server ?? c.label))];
        parts.push(servers.length === 1 ? n === 1 ? `used ${servers[0]}` : `used ${servers[0]} ${n} times` : `used ${servers.slice(0, 2).join(" and ")}${servers.length > 2 ? ` and ${servers.length - 2} more` : ""}`);
        break;
      }
      case "agent":
        parts.push(plural(list.filter((c) => c.name === "Agent" || c.name === "Task").length || n, "asked an agent", "asked # agents"));
        break;
      case "plan":
        parts.push(list.some((c) => c.name === "ExitPlanMode") ? "proposed a plan" : "updated the to-do list");
        break;
      case "skill":
        parts.push(files.size === 1 ? `used the ${[...files][0]} skill` : `used ${files.size} skills`);
        break;
      case "question":
        parts.push("asked you a question");
        break;
      default:
        parts.push(plural(n, `used ${list[0].name}`, "used # tools"));
    }
  }
  if (parts.length <= 3) return parts.join(", ");
  const kinds = [...byKind.keys()];
  const ranked = parts.map((p, i) => ({ p, rank: SIGNIFICANCE.indexOf(kinds[i]) })).sort((a, b) => a.rank - b.rank);
  return `${ranked[0].p}, ${ranked[1].p}, and ${parts.length - 2} more`;
}
var SIGNIFICANCE = ["edit", "write", "command", "question", "mcp", "web", "agent", "plan", "skill", "read", "search", "other"];

// src/main/index/parse.ts
var MESSAGE_TYPES = /* @__PURE__ */ new Set(["user", "assistant", "system", "attachment"]);
function splitLines(buf, startOffset = 0) {
  const out = [];
  let start = 0;
  for (; ; ) {
    const nl = buf.indexOf(10, start);
    if (nl === -1) break;
    if (nl > start) {
      const text = buf.toString("utf8", start, nl).replace(/\r$/, "");
      if (text.trim()) out.push({ text, offset: startOffset + start });
    }
    start = nl + 1;
  }
  return out;
}
function parseEntries(buf) {
  const entries = [];
  let i = 0;
  for (const l of splitLines(buf)) {
    let j;
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
var META_PREFIXES = ["<command-", "<local-command-", "<system-reminder", "<bash-", "<task-notification", "<user-memory-input", "Base directory for this skill", "Caveat: The messages below", "[Request interrupted"];
var unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
function bashRecord(text) {
  const input = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(text);
  if (input) return { command: unescapeXml(input[1]).trim() };
  const output = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/.exec(text);
  if (output) return { stdout: unescapeXml(output[1]), stderr: unescapeXml(output[2] ?? "") };
  return null;
}
function slashRecord(text) {
  const t = text.trimStart();
  if (!t.startsWith("<command-")) return null;
  const name = /<command-name>\s*\/?([^<\s][^<]*?)\s*<\/command-name>/.exec(t)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1] ?? "";
  return { name, args: unescapeXml(args).trim() };
}
function localOutput(text) {
  const t = text.trim();
  if (!/^<local-command-(stdout|stderr)>/.test(t)) return null;
  const parts = [...t.matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g)].map((m) => m[1]);
  return parts.join("\n").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
}
function isMetaText(text) {
  const t = text.trimStart();
  if (!t) return true;
  return META_PREFIXES.some((p) => t.startsWith(p));
}
function blocksOf(content) {
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object");
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}
function textFromToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => b && typeof b === "object" && b.type === "text" ? String(b.text ?? "") : "").filter(Boolean).join("\n");
  }
  return "";
}
var clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
function plainText(md) {
  return md.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+\.\s+/gm, "").replace(/[*_~>|]/g, "").replace(/\s+/g, " ").trim();
}
function previewOf(md) {
  const plain = plainText(md);
  if (plain.length <= 200) return plain;
  const tail = plain.slice(-240);
  const cut = tail.search(/[.!?]\s+[A-Z]/);
  return clip(cut > 0 && cut < 160 ? tail.slice(cut + 2) : plain, 200);
}
var SERVER_LABELS = [
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
  [/claude_docs|claude-docs/i, "Claude Docs"]
];
function serverLabel(server) {
  for (const [re, label] of SERVER_LABELS) if (re.test(server)) return label;
  return server.replace(/^claude_ai_/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
var HIDDEN_TOOLS = /* @__PURE__ */ new Set(["ToolSearch"]);
function baseName(p) {
  const s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = s.split("/");
  return parts.length > 1 ? parts.slice(-2).join("/") : s;
}
function toolKind(name) {
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
function describeCall(name, input) {
  const str = (k) => typeof input[k] === "string" ? input[k] : "";
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
var MAX_DIFF_LINES = 40;
function diffFromPatch(pathName, patch) {
  if (!Array.isArray(patch)) return null;
  const lines = [];
  let additions = 0;
  let removals = 0;
  let truncated = false;
  patch.forEach((hunk, h) => {
    const hl = hunk.lines;
    if (!Array.isArray(hl)) return;
    if (h > 0 && lines.length) lines.push({ kind: "context", text: "\u2026" });
    for (const raw of hl) {
      const s = String(raw);
      const kind = s.startsWith("+") ? "add" : s.startsWith("-") ? "del" : "context";
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
function diffFromStrings(pathName, oldS, newS) {
  const a = oldS.split("\n");
  const b = newS.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lines = [];
  if (head > 0) lines.push({ kind: "context", text: a[head - 1] });
  for (const l of a.slice(head, a.length - tail)) lines.push({ kind: "del", text: l });
  for (const l of b.slice(head, b.length - tail)) lines.push({ kind: "add", text: l });
  if (tail > 0) lines.push({ kind: "context", text: a[a.length - tail] });
  const additions = b.length - head - tail;
  const removals = a.length - head - tail;
  const truncated = lines.length > MAX_DIFF_LINES;
  return { path: baseName(pathName), additions, removals, lines: lines.slice(0, MAX_DIFF_LINES), truncated };
}
function diffForCall(name, input, result) {
  const file = String(input.file_path ?? input.notebook_path ?? "");
  const r = result && typeof result === "object" ? result : {};
  if (name === "Edit" || name === "MultiEdit") {
    const fromPatch = diffFromPatch(file, r.structuredPatch);
    if (fromPatch) return fromPatch;
    if (typeof input.old_string === "string" && typeof input.new_string === "string") return diffFromStrings(file, input.old_string, input.new_string);
    if (Array.isArray(input.edits) && input.edits.length) {
      const e = input.edits[0];
      return diffFromStrings(file, String(e.old_string ?? ""), String(e.new_string ?? ""));
    }
    return null;
  }
  if (name === "Write") {
    const fromPatch = diffFromPatch(file, r.structuredPatch);
    if (fromPatch && r.type === "update") return { ...fromPatch, created: false };
    const content = typeof input.content === "string" ? input.content : "";
    const all = content.split("\n");
    const lines = all.slice(0, 12).map((t) => ({ kind: "add", text: t }));
    return { path: baseName(file), additions: all.length, removals: 0, lines, truncated: all.length > 12, created: true };
  }
  return null;
}
function localDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isTypedPrompt(e) {
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
function activePath(entries, machineForCwd) {
  const byUuid = /* @__PURE__ */ new Map();
  const children = /* @__PURE__ */ new Map();
  const msgs = [];
  for (const e of entries) {
    if (!MESSAGE_TYPES.has(e.type) || !e.uuid) continue;
    if (e.isSidechain) continue;
    msgs.push(e);
    byUuid.set(e.uuid, e);
  }
  const position = new Map(msgs.map((m, i) => [m, i]));
  const before = (e) => {
    const i = position.get(e);
    return i ? msgs[i - 1] : void 0;
  };
  const parentOf = (e) => {
    if (e.parentUuid) return byUuid.has(e.parentUuid) ? e.parentUuid : before(e)?.uuid ?? null;
    if (e.subtype !== "compact_boundary") return null;
    const logical = e.logicalParentUuid ? byUuid.get(e.logicalParentUuid) : void 0;
    if (logical && logical.line < e.line) return logical.uuid;
    return before(e)?.uuid ?? null;
  };
  for (const e of msgs) {
    const p = parentOf(e);
    if (!p) continue;
    const list = children.get(p) ?? [];
    list.push(e);
    children.set(p, list);
  }
  let leaf;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === "user" || msgs[i].type === "assistant") {
      leaf = msgs[i];
      break;
    }
  }
  if (!leaf) return { path: msgs, alt: null, forkIndex: -1 };
  let tip = leaf;
  for (; ; ) {
    const kids = (children.get(tip.uuid) ?? []).filter((k) => k.type === "system" || k.type === "attachment");
    if (!kids.length) break;
    tip = kids[kids.length - 1];
  }
  const path3 = [];
  const seen = /* @__PURE__ */ new Set();
  for (let e = tip; e && !seen.has(e.uuid); e = byUuid.get(parentOf(e) ?? "")) {
    seen.add(e.uuid);
    path3.push(e);
  }
  path3.reverse();
  const onPath = new Set(path3.map((e) => e.uuid));
  const pcOf = (list) => machineForCwd(list.find((x) => x.type === "user" || x.type === "assistant")?.cwd);
  for (let i = path3.length - 1; i >= 0; i--) {
    const kids = children.get(path3[i].uuid) ?? [];
    if (kids.length < 2) continue;
    const mainPc = pcOf(path3.slice(i + 1));
    for (const k of kids) {
      if (onPath.has(k.uuid)) continue;
      const branch = collectBranch(k, children);
      if (!branch.some(isTypedPrompt)) continue;
      const altPc = pcOf(branch);
      if (!altPc || !mainPc || altPc === mainPc) continue;
      return { path: path3, alt: branch, forkIndex: i };
    }
  }
  return { path: path3, alt: null, forkIndex: -1 };
}
function collectBranch(start, children) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (let e = start; e && !seen.has(e.uuid); ) {
    seen.add(e.uuid);
    out.push(e);
    const kids = children.get(e.uuid) ?? [];
    e = kids[kids.length - 1];
  }
  return out;
}
function parseTranscript(buf, ctx) {
  const entries = parseEntries(buf);
  const info = {
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
    lines: entries.length
  };
  let sawSdk = false;
  let sawInteractive = false;
  let summary = null;
  const pcs = /* @__PURE__ */ new Set();
  for (const e of entries) {
    if (e.timestamp) {
      info.startedAt ??= e.timestamp;
      if (!info.lastAt || e.timestamp > info.lastAt) info.lastAt = e.timestamp;
    }
    if (e.type === "ai-title" && e.aiTitle) info.aiTitle = e.aiTitle;
    else if (e.type === "custom-title" && (e.customTitle || e.title)) info.customTitle = String(e.customTitle || e.title);
    else if (e.type === "summary" && e.summary && !summary) summary = e.summary;
    if (typeof e.version === "string") info.version = e.version;
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
  const { path: path3, alt, forkIndex } = activePath(entries, ctx.machineForCwd);
  const items = [];
  const fts = [];
  let seq = 0;
  let lastDay = null;
  let lastReply = "";
  let turnModel = null;
  let turnTs = null;
  let turnPc = null;
  let turnDuration = null;
  let turnOpen = false;
  let group = null;
  const callsById = /* @__PURE__ */ new Map();
  const resultIds = /* @__PURE__ */ new Set();
  let openShell = null;
  let openCommand = null;
  const commandOutput = (out) => {
    if (openCommand && openCommand.output === null && out) {
      openCommand.output = clip(out, 2e4);
      fts.push({ seq: openCommand.seq, role: "tool", body: clip(out, 4e3) });
    }
    openCommand = null;
  };
  let firstCommand = null;
  const noteCommand = (typed) => {
    const one = typed.replace(/\s+/g, " ").trim().slice(0, 200);
    firstCommand ??= one;
    info.lastPrompt = one;
  };
  const flushGroup = () => {
    if (!group) return;
    const visible = group.calls;
    if (visible.length) {
      const icons = [];
      for (const c of visible) if (!icons.includes(c.kind)) icons.push(c.kind);
      const diffs = visible.map((c) => c.diff).filter((d) => !!d);
      items.push({ kind: "tools", seq: seq++, uuid: group.uuid, ts: group.ts, summary: "", icons: icons.slice(0, 2), calls: visible, diffs: diffs.slice(0, 3) });
      const toolText = visible.map((c) => [c.name, c.detail, c.resultPreview].filter(Boolean).join(" ")).join("\n");
      if (toolText.trim()) fts.push({ seq: seq - 1, role: "tool", body: clip(toolText, 4e3) });
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
  const addCommand = (slash, e) => {
    closeTurn();
    openShell = null;
    const day = localDate(e.timestamp);
    if (day && day !== lastDay) {
      if (lastDay !== null) items.push({ kind: "day", seq: seq++, date: day });
      lastDay = day;
    }
    openCommand = { kind: "command", seq: seq++, uuid: e.uuid ?? "", ts: e.timestamp ?? null, name: clip(slash.name, 200), args: clip(slash.args, 2e3), output: null, pc: ctx.machineForCwd(e.cwd) };
    items.push(openCommand);
    const typed = `/${slash.name}${slash.args ? ` ${slash.args}` : ""}`;
    fts.push({ seq: openCommand.seq, role: "prompt", body: typed });
    noteCommand(typed);
  };
  const emitEntries = (list) => {
    for (const e of list) {
      if (e.type === "user") {
        const c = e.message?.content;
        const blocks = blocksOf(c);
        const results = blocks.filter((b) => b.type === "tool_result");
        if (results.length) {
          for (const r of results) {
            const hit = callsById.get(String(r.tool_use_id ?? ""));
            if (!hit) continue;
            const text2 = textFromToolResult(r.content);
            hit.call.resultPreview = text2 ? clip(text2.trim(), 600) : null;
            hit.call.isError = r.is_error === true;
            resultIds.add(hit.call.id);
            hit.call.denied = hit.call.isError && /denied|rejected|declined|doesn't want to proceed|said no/i.test(text2);
            hit.call.interrupted = hit.call.isError && !hit.call.denied && /interrupted/i.test(text2);
            const d = diffForCall(hit.name, hit.input, e.toolUseResult);
            if (d && !hit.call.isError) hit.call.diff = d;
            if (hit.call.kind === "question") {
              const tur = e.toolUseResult ?? {};
              const answer = tur.answers ? Object.values(tur.answers).join("; ") : text2 || null;
              if (hit.call.question) hit.call.question.answer = answer ? clip(answer, 300) : null;
            }
          }
          continue;
        }
        const plain = typeof c === "string" ? c : blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
        const slash = !e.isMeta && !e.isSidechain && !e.isCompactSummary ? slashRecord(plain) : null;
        if (slash) {
          addCommand(slash, e);
          continue;
        }
        const printed = !e.isSidechain ? localOutput(plain) : null;
        if (printed !== null) {
          commandOutput(printed);
          continue;
        }
        const bash = !e.isSidechain && !e.isCompactSummary ? bashRecord(typeof c === "string" ? c : blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("")) : null;
        if (bash && "command" in bash) {
          closeTurn();
          const day2 = localDate(e.timestamp);
          if (day2 && day2 !== lastDay) {
            if (lastDay !== null) items.push({ kind: "day", seq: seq++, date: day2 });
            lastDay = day2;
          }
          openShell = { kind: "shell", seq: seq++, uuid: e.uuid ?? "", ts: e.timestamp ?? null, command: clip(bash.command, 4e3), stdout: null, stderr: null, pc: ctx.machineForCwd(e.cwd) };
          items.push(openShell);
          openCommand = null;
          fts.push({ seq: openShell.seq, role: "prompt", body: `! ${bash.command}` });
          noteCommand(`! ${bash.command}`);
          continue;
        }
        if (bash && "stdout" in bash) {
          if (openShell && openShell.stdout === null && openShell.stderr === null) {
            openShell.stdout = clip(bash.stdout, 2e4);
            openShell.stderr = clip(bash.stderr, 8e3);
            const out = [bash.stdout, bash.stderr].join("\n").trim();
            if (out) fts.push({ seq: openShell.seq, role: "tool", body: clip(out, 4e3) });
          }
          openShell = null;
          continue;
        }
        if (!isTypedPrompt(e)) continue;
        openShell = null;
        openCommand = null;
        closeTurn();
        const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).filter((t) => !isMetaText(t)).join("\n\n").trim();
        const images = [];
        blocks.forEach((b, bi) => {
          if (b.type !== "image") return;
          const src = b.source;
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
            const input = b.input && typeof b.input === "object" ? b.input : {};
            const d = describeCall(name, input);
            const call = {
              id: String(b.id ?? ""),
              name,
              kind: toolKind(name),
              label: clip(d.label || name, 80),
              detail: d.detail ? clip(d.detail, 2e3) : null,
              resultPreview: null,
              isError: false,
              server: d.server,
              diff: null,
              question: null
            };
            if (call.kind === "question") {
              const qs = Array.isArray(input.questions) ? input.questions : [];
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
          const err = e.error ?? {};
          const msg = err.error?.error?.message ?? null;
          items.push({ kind: "notice", seq: seq++, ts: e.timestamp ?? null, tone: "error", title: `Claude couldn't reach Anthropic${err.status ? ` (error ${err.status})` : ""}`, body: msg });
        } else if (e.subtype === "local_command") {
          const content = String(e.content ?? "");
          const printed = localOutput(content);
          if (printed !== null) commandOutput(printed);
          else {
            const cmd = slashRecord(content);
            if (cmd) addCommand(cmd, e);
          }
        }
      }
    }
  };
  if (alt && forkIndex >= 0) {
    emitEntries(path3.slice(0, forkIndex + 1));
    closeTurn();
    const mainRest = path3.slice(forkIndex + 1);
    const pcOf = (list) => ctx.machineForCwd(list.find((x) => x.type === "user" || x.type === "assistant")?.cwd) ?? "another PC";
    const firstTs = (list) => list.find((x) => x.timestamp)?.timestamp ?? null;
    const parts = [alt, mainRest].sort((a, b) => String(firstTs(a)).localeCompare(String(firstTs(b))));
    const pcsHere = [...new Set(parts.map(pcOf))];
    items.push({ kind: "parts", seq: seq++, ts: firstTs(parts[0]), label: `Continued on ${pcsHere.join(" and ")} at the same time \xB7 both parts kept` });
    parts.forEach((p, i) => {
      items.push({ kind: "part", seq: seq++, ts: firstTs(p), label: `Part ${i + 1} \xB7 ${pcOf(p)}` });
      emitEntries(p);
      closeTurn();
    });
  } else {
    emitEntries(path3);
  }
  closeTurn();
  for (const it of items) {
    if (it.kind !== "tools") continue;
    for (const c of it.calls) if (!resultIds.has(c.id)) c.pending = true;
    it.summary = summariseCalls(it.calls);
  }
  info.customTitle = info.customTitle ?? null;
  info.title = info.customTitle || info.aiTitle || summary || info.firstPrompt || firstCommand || "Untitled conversation";
  info.preview = lastReply ? previewOf(lastReply) : info.lastPrompt ?? "";
  for (let i = path3.length - 1; i >= 0; i--) {
    const m = path3[i].message?.model;
    if (path3[i].type === "assistant" && m && m !== "<synthetic>") {
      info.model = m;
      break;
    }
  }
  return { items, info, fts };
}

// src/main/sync/repo-read.ts
import fs from "node:fs";
import path from "node:path";
var NOT_PROJECTS = /* @__PURE__ */ new Set(["_sync", "_app", "_devices", "_state", "_tools"]);
var isProjectFolder = (name) => !name.startsWith(".") && !name.startsWith("C--") && !name.startsWith("-") && !NOT_PROJECTS.has(name);
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var isUuid = (id) => typeof id === "string" && UUID.test(id);
function normaliseRemote(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  let host = null;
  let rest = null;
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (scheme && scheme[1].toLowerCase() !== "file") {
    const m = scheme[2].match(/^(?:[^@/]*@)?([^/:?#]+)(?::\d+)?(\/[^?#]*)?/);
    if (m) {
      host = m[1];
      rest = m[2] || "";
    }
  } else if (!scheme) {
    const m = s.match(/^(?:[^@/\\\s]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9-]{2,}):(?!\\|\/\/)(.+)$/);
    if (m && !/^[A-Za-z]$/.test(m[1])) {
      host = m[1];
      rest = m[2];
    }
  }
  if (host === null) return s.toLowerCase();
  host = host.toLowerCase().replace(/^www\./, "");
  let parts = String(rest).split("/").filter(Boolean);
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, "");
  parts = parts.filter(Boolean);
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    host = "dev.azure.com";
    if (parts[0]?.toLowerCase() === "v3") parts = parts.slice(1);
  } else if (host.endsWith(".visualstudio.com")) {
    parts = [host.slice(0, -".visualstudio.com".length), ...parts.filter((p) => p.toLowerCase() !== "defaultcollection")];
    host = "dev.azure.com";
  }
  if (host === "dev.azure.com") parts = parts.filter((p) => p.toLowerCase() !== "_git");
  if (!parts.length) return host;
  return `${host}/${parts.join("/")}`.toLowerCase();
}
function projectLabel(projectId) {
  if (projectId === "folder:_home") return "Home folder";
  if (projectId.startsWith("folder:")) return projectId.slice("folder:".length);
  return projectId.split("/").pop() || projectId;
}
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
var placesOf = (meta) => Object.entries(meta.machines || {}).map(([pc, v]) => `${pc}|${String(v?.cwd ?? "").toLowerCase()}`);
function listRemoteSessions(repoDir) {
  const out = [];
  let keys = [];
  try {
    keys = fs.readdirSync(repoDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const placeRemote = /* @__PURE__ */ new Map();
  for (const d of keys) {
    if (!d.isDirectory() || !isProjectFolder(d.name)) continue;
    const kdir = path.join(repoDir, d.name);
    let ids = [];
    try {
      ids = fs.readdirSync(kdir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!isUuid(id)) continue;
      const meta = readJson(path.join(kdir, id, "meta.json"));
      if (!meta || meta.sessionId !== id) continue;
      const remote = normaliseRemote(meta.gitRemote);
      if (remote) {
        const at = String(meta.updatedAt ?? "");
        for (const p of placesOf(meta)) {
          const cur = placeRemote.get(p);
          if (!cur || at > cur.at || at === cur.at && remote < cur.remote) placeRemote.set(p, { remote, at });
        }
      }
      out.push({ ...meta, key: d.name, dir: path.join(kdir, id), projectId: "", projectLabel: "" });
    }
  }
  for (const s of out) {
    const inherited = placesOf(s).map((p) => placeRemote.get(p)?.remote).filter((r) => !!r).sort()[0];
    s.projectId = normaliseRemote(s.gitRemote) ?? inherited ?? `folder:${s.key}`;
    s.projectLabel = projectLabel(s.projectId);
  }
  return out;
}
var FIELDS = /* @__PURE__ */ new Set(["pinned", "title", "archived", "deleted", "app"]);
var validValue = (field, v) => v === null || (field === "title" ? typeof v === "string" && v.length <= 500 : typeof v === "boolean");
function readEdits(repoDir) {
  const best = /* @__PURE__ */ new Map();
  const dir = path.join(repoDir, "_state");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
  }
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isUuid(op?.session) || !op.field || !FIELDS.has(op.field) || typeof op.hlc !== "string" || !validValue(op.field, op.value ?? null)) continue;
      const cur = best.get(op.session) ?? {};
      if (!cur[op.field] || op.hlc > cur[op.field].hlc) cur[op.field] = { value: op.value, hlc: op.hlc };
      best.set(op.session, cur);
    }
  }
  const out = /* @__PURE__ */ new Map();
  for (const [id, fields] of best) {
    const e = {};
    for (const [k, v] of Object.entries(fields)) e[k] = v.value;
    out.set(id, e);
  }
  return out;
}
function gitDirOf(dir) {
  const dotgit = path.join(dir, ".git");
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    const m = fs.readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
    if (m) return path.resolve(dir, m[1].trim());
  } catch {
  }
  return null;
}
function gitInfo(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    const gd = gitDirOf(dir);
    if (gd) {
      let configDir = gd;
      try {
        const common = fs.readFileSync(path.join(gd, "commondir"), "utf8").trim();
        if (common) configDir = path.resolve(gd, common);
      } catch {
      }
      let remote = null;
      try {
        const cfg = fs.readFileSync(path.join(configDir, "config"), "utf8");
        const sec = cfg.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
        const url = sec?.[1].match(/^\s*url\s*=\s*(.+?)\s*$/m);
        remote = url ? url[1] : null;
      } catch {
      }
      return { top: dir, remote };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
function projectIdForCwd(cwd, home) {
  const g = gitInfo(cwd);
  const top = g?.top ?? path.resolve(cwd);
  const key = path.resolve(top).toLowerCase() === path.resolve(home).toLowerCase() ? "_home" : path.basename(top).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "_root";
  const remote = normaliseRemote(g?.remote);
  return { projectId: remote ?? `folder:${key}`, folderKey: key, top };
}

// src/main/index/indexer.ts
var PROFILE_RE = /^([a-z]:\\users\\[^\\]+)/i;
var profilePrefix = (cwd) => cwd ? (String(cwd).replace(/\//g, "\\").match(PROFILE_RE)?.[1] ?? null)?.toLowerCase() ?? null : null;
var Indexer = class {
  // repo folder key -> project id
  constructor(db2, opts2) {
    this.db = db2;
    this.opts = opts2;
  }
  db;
  opts;
  machines = /* @__PURE__ */ new Map();
  // Windows user folder -> PC name
  keyRemote = /* @__PURE__ */ new Map();
  longPrefix = /* @__PURE__ */ new Map();
  /** Which PC wrote an entry, from its working folder's Windows user folder. */
  machineForCwd = (cwd) => {
    const p = profilePrefix(cwd);
    if (!p) return null;
    const hit = this.machines.get(p);
    if (hit) return hit;
    if (!p.includes("~")) return null;
    if (!this.longPrefix.has(p)) {
      let long2 = null;
      try {
        long2 = fs2.realpathSync.native(p).toLowerCase();
      } catch {
      }
      this.longPrefix.set(p, long2);
    }
    const long = this.longPrefix.get(p);
    return long ? this.machines.get(long) ?? null : null;
  };
  learnMachines(remote) {
    const m = /* @__PURE__ */ new Map();
    for (const s of remote) {
      for (const [pc, v] of Object.entries(s.machines || {})) {
        const p = profilePrefix(v?.cwd);
        if (p && !m.has(p)) m.set(p, pc);
      }
    }
    const mine = profilePrefix(this.opts.home);
    if (mine) m.set(mine, this.opts.thisMachine);
    this.machines = m;
    const lastPush = /* @__PURE__ */ new Map();
    for (const s of remote) {
      for (const [pc, v] of Object.entries(s.machines || {})) {
        if (v?.lastPushAt && (!lastPush.has(pc) || v.lastPushAt > lastPush.get(pc))) lastPush.set(pc, v.lastPushAt);
      }
    }
    tx(this.db, () => {
      this.db.exec("DELETE FROM machines");
      const ins = this.db.prepare("INSERT INTO machines (prefix, name) VALUES (?, ?)");
      for (const [p, n] of m) ins.run(p, n);
      this.db.exec("DELETE FROM machine_activity");
      const act = this.db.prepare("INSERT INTO machine_activity (name, last_push_at) VALUES (?, ?)");
      for (const [n, at] of lastPush) act.run(n, at);
    });
    const votes = {};
    for (const s of remote) {
      const r = normaliseRemote(s.gitRemote);
      if (!r) continue;
      const v = votes[s.key] ??= {};
      v[r] = (v[r] || 0) + 1;
    }
    this.keyRemote = new Map(Object.entries(votes).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]));
  }
  localSources() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs2.readdirSync(this.opts.projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return out;
    }
    for (const d of dirs) {
      const dir = path2.join(this.opts.projectsDir, d);
      let files = [];
      try {
        files = fs2.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const p = path2.join(dir, f);
        try {
          const st = fs2.statSync(p);
          out.push({ path: p, id: f.slice(0, -6), kind: "local", size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        } catch {
        }
      }
    }
    return out;
  }
  repoSources(remote) {
    const out = [];
    for (const s of remote) {
      for (const name of ["transcript.jsonl", "transcript.jsonl.gz"]) {
        const p = path2.join(s.dir, name);
        try {
          const st = fs2.statSync(p);
          out.push({ path: p, id: s.sessionId, kind: "repo", size: st.size, mtimeMs: Math.floor(st.mtimeMs), meta: s });
          break;
        } catch {
        }
      }
    }
    return out;
  }
  /** Scans everything; re-reads only what changed. */
  scan({ only } = {}) {
    const t0 = Date.now();
    const remote = listRemoteSessions(this.opts.repoDir);
    this.learnMachines(remote);
    const sources = [...this.localSources(), ...this.repoSources(remote)];
    const byId = /* @__PURE__ */ new Map();
    for (const s of sources) {
      const list = byId.get(s.id) ?? [];
      list.push(s);
      byId.set(s.id, list);
    }
    const known = new Map(this.db.prepare("SELECT id, sig FROM conversations").all().map((r) => [r.id, r.sig]));
    const changed = [];
    for (const [id, list] of byId) {
      if (only && !only.has(id)) continue;
      const sig = list.map((s) => `${s.kind}:${s.path}:${s.size}:${s.mtimeMs}`).sort().join("|");
      if (known.get(id) === sig) continue;
      try {
        if (this.reindex(id, list, sig)) changed.push(id);
      } catch (e) {
        console.error(`[indexer] ${id}: ${e.message}`);
      }
    }
    const removed = [];
    if (!only) {
      for (const id of known.keys()) {
        if (byId.has(id)) continue;
        this.remove(id);
        removed.push(id);
      }
    }
    this.syncEdits();
    return { changed, removed, total: byId.size, ms: Date.now() - t0 };
  }
  lastTimestamp(file, gz) {
    try {
      if (gz) return "";
      const fd = fs2.openSync(file, "r");
      const size = fs2.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs2.readSync(fd, buf, 0, len, size - len);
      fs2.closeSync(fd);
      const all = [...buf.toString("utf8").matchAll(/"timestamp":"([^"]+)"/g)];
      return all.length ? all[all.length - 1][1] : "";
    } catch {
      return "";
    }
  }
  reindex(id, list, sig) {
    const local = list.filter((s) => s.kind === "local").sort((a, b) => b.size - a.size)[0];
    const repo = list.find((s) => s.kind === "repo");
    let primary = local ?? repo;
    if (local && repo) {
      const lt = this.lastTimestamp(local.path, false);
      const rt = this.lastTimestamp(repo.path, repo.path.endsWith(".gz"));
      if (rt > lt) primary = repo;
    }
    let buf = fs2.readFileSync(primary.path);
    if (primary.path.endsWith(".gz")) buf = zlib.gunzipSync(buf);
    const parsed = parseTranscript(buf, { machineForCwd: this.machineForCwd, sourcePath: primary.path });
    const appOwned = !!this.db.prepare("SELECT 1 FROM app_sessions WHERE conversation_id = ? UNION ALL SELECT 1 FROM edits WHERE conversation_id = ? AND app = 1").get(id, id);
    if (parsed.info.prompts === 0 && !appOwned || parsed.info.headless && !appOwned) {
      this.remove(id);
      this.db.prepare("INSERT OR REPLACE INTO conversations (id, sig, project_id, project_label, title, indexed_at, item_count) VALUES (?, ?, '', '', '', ?, -1)").run(id, sig, (/* @__PURE__ */ new Date()).toISOString());
      return false;
    }
    const meta = repo?.meta;
    let projectId;
    let folderKey = meta?.key ?? null;
    if (meta) projectId = meta.projectId;
    else {
      const cwd = parsed.info.cwd;
      if (cwd && fs2.existsSync(cwd)) {
        const p = projectIdForCwd(cwd, this.opts.home);
        projectId = p.projectId;
        folderKey = p.folderKey;
      } else {
        const key = cwd ? path2.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") : "unknown";
        folderKey = key;
        projectId = this.keyRemote.get(key) ?? `folder:${key}`;
      }
    }
    if (projectId.startsWith("folder:") && folderKey && this.keyRemote.has(folderKey)) projectId = this.keyRemote.get(folderKey);
    const lastPc = parsed.info.lastPc ?? meta?.lastPushedFrom ?? null;
    const pcs = new Set(parsed.info.pcs);
    for (const pc of Object.keys(meta?.machines ?? {})) pcs.add(pc);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    tx(this.db, () => {
      this.clearContent(id);
      const insItem = this.db.prepare("INSERT INTO items (conversation_id, seq, json) VALUES (?, ?, ?)");
      for (const it of parsed.items) insItem.run(id, it.seq, JSON.stringify(it));
      const insFts = this.db.prepare("INSERT INTO fts (body, conversation_id, seq, role) VALUES (?, ?, ?, ?)");
      const insRow = this.db.prepare("INSERT INTO fts_rows (conversation_id, row) VALUES (?, ?)");
      for (const f of parsed.fts) {
        const r = insFts.run(f.body, id, f.seq, f.role);
        insRow.run(id, Number(r.lastInsertRowid));
      }
      const t = this.db.prepare("INSERT INTO fts_title (title, conversation_id) VALUES (?, ?)").run(parsed.info.title, id);
      insRow.run(id, -Number(t.lastInsertRowid));
      this.db.prepare(
        `INSERT OR REPLACE INTO conversations
           (id, sig, primary_path, local_path, repo_dir, folder_key, project_id, project_label, title, first_prompt, last_prompt, preview,
            started_at, last_at, prompts, bytes, last_pc, pcs, cwd, git_branch, model, version, context_tokens, peak_context_tokens, local_mtime_ms, item_count, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        sig,
        primary.path,
        local?.path ?? null,
        repo?.meta?.dir ?? null,
        folderKey,
        projectId,
        projectLabel(projectId),
        parsed.info.title,
        parsed.info.firstPrompt,
        parsed.info.lastPrompt,
        parsed.info.preview,
        parsed.info.startedAt,
        parsed.info.lastAt,
        parsed.info.prompts,
        buf.length,
        lastPc,
        JSON.stringify([...pcs]),
        parsed.info.cwd,
        parsed.info.gitBranch,
        parsed.info.model,
        parsed.info.version,
        parsed.info.contextTokens,
        parsed.info.peakContextTokens,
        local?.mtimeMs ?? null,
        parsed.items.length,
        now
      );
      const delSrc = this.db.prepare("DELETE FROM sources WHERE conversation_id = ?");
      delSrc.run(id);
      const insSrc = this.db.prepare("INSERT OR REPLACE INTO sources (path, conversation_id, kind, size, mtime_ms) VALUES (?, ?, ?, ?, ?)");
      for (const s of list) insSrc.run(s.path, id, s.kind, s.size, s.mtimeMs);
    });
    return true;
  }
  clearContent(id) {
    const rows = this.db.prepare("SELECT row FROM fts_rows WHERE conversation_id = ?").all(id);
    const delFts = this.db.prepare("DELETE FROM fts WHERE rowid = ?");
    const delTitle = this.db.prepare("DELETE FROM fts_title WHERE rowid = ?");
    for (const r of rows) (r.row < 0 ? delTitle : delFts).run(Math.abs(r.row));
    this.db.prepare("DELETE FROM fts_rows WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM items WHERE conversation_id = ?").run(id);
  }
  remove(id) {
    tx(this.db, () => {
      this.clearContent(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM sources WHERE conversation_id = ?").run(id);
    });
  }
  /** Pins, renames, archive and delete from every PC's log. */
  syncEdits() {
    const edits = readEdits(this.opts.repoDir);
    tx(this.db, () => {
      this.db.exec("DELETE FROM edits");
      const ins = this.db.prepare("INSERT INTO edits (conversation_id, pinned, title, archived, deleted, app) VALUES (?, ?, ?, ?, ?, ?)");
      for (const [id, e] of edits) ins.run(id, e.pinned === void 0 ? null : e.pinned ? 1 : 0, e.title ?? null, e.archived === void 0 ? null : e.archived ? 1 : 0, e.deleted ? 1 : 0, e.app ? 1 : 0);
      this.db.exec("DELETE FROM conversations WHERE item_count = -1 AND id IN (SELECT conversation_id FROM edits WHERE app = 1)");
    });
  }
  /** First run: everything already here counts as read, so only later changes show as Updated. */
  markAllSeen() {
    tx(this.db, () => {
      this.db.exec(`INSERT OR IGNORE INTO local_state (conversation_id, seen_at, seen_last_at)
                    SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_at FROM conversations WHERE item_count >= 0`);
    });
  }
};

// src/main/index/worker.ts
var { dbPath, opts } = workerData;
var db = openDb(dbPath);
var indexer = new Indexer(db, opts);
parentPort.on("message", (m) => {
  try {
    if (m.type === "scan") {
      const r = indexer.scan({ only: m.only ? new Set(m.only) : void 0 });
      if (!getMeta(db, "initialized")) {
        indexer.markAllSeen();
        setMeta(db, "initialized", (/* @__PURE__ */ new Date()).toISOString());
        parentPort.postMessage({ type: "first-run", total: r.total });
      }
      parentPort.postMessage({ type: "scanned", ...r, reason: m.reason ?? null });
    } else if (m.type === "own") {
      db.prepare("INSERT OR REPLACE INTO app_sessions (conversation_id, cwd, created_at) VALUES (?, ?, ?)").run(m.id, m.cwd, (/* @__PURE__ */ new Date()).toISOString());
      db.prepare("UPDATE conversations SET sig = '' WHERE id = ?").run(m.id);
      const r = indexer.scan({ only: /* @__PURE__ */ new Set([m.id]) });
      parentPort.postMessage({ type: "scanned", ...r, reason: "own" });
    } else if (m.type === "seen-all") {
      indexer.markAllSeen();
    }
  } catch (e) {
    parentPort.postMessage({ type: "error", message: String(e.stack || e) });
  }
});
parentPort.postMessage({ type: "ready" });
//# sourceMappingURL=index-worker.mjs.map
