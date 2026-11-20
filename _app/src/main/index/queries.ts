// Everything the window asks of the index. Reads only; all of it runs in well
// under the 100 ms budget because it touches nothing but SQLite.

import type { DatabaseSync } from "node:sqlite";
import { TAG_COLORS, type ConversationDetail, type ConversationRow, type DeviceSummary, type ItemsPage, type ListQuery, type ListResult, type ProjectSummary, type SearchHit, type SearchResult, type SidebarData, type TagColor, type TagInfo, type TranscriptItem } from "../../shared/types";
import type { DeviceRecord } from "../sync/repo-read";
import { PC } from "../words";

export const LIVE_MS = 2 * 60 * 1000;

interface Row {
  id: string;
  primary_path: string | null;
  local_path: string | null;
  repo_dir: string | null;
  folder_key: string | null;
  project_id: string;
  project_label: string;
  title: string;
  preview: string;
  first_prompt: string | null;
  last_prompt: string | null;
  started_at: string | null;
  last_at: string | null;
  prompts: number;
  bytes: number;
  last_pc: string | null;
  pcs: string;
  cwd: string | null;
  model: string | null;
  context_tokens: number | null;
  local_mtime_ms: number | null;
  item_count: number;
  e_pinned: number | null;
  e_title: string | null;
  e_archived: number | null;
  e_deleted: number | null;
  e_tags: string | null;
  seen_last_at: string | null;
}

/** Edits made in this window that GitHub has not confirmed yet. They win until it does. */
export type PendingEdits = Map<string, { pinned?: boolean; title?: string | null; archived?: boolean; deleted?: boolean; tags?: string[] | null; tagName?: string | null; tagColor?: string | null; tagDeleted?: boolean }>;

export interface QueryContext {
  thisMachine: string;
  now: number;
  running: Set<string>;
  pending: PendingEdits;
}

const BASE = `
  SELECT c.*, e.pinned AS e_pinned, e.title AS e_title, e.archived AS e_archived, e.deleted AS e_deleted, e.tags AS e_tags, s.seen_last_at
  FROM conversations c
  LEFT JOIN edits e ON e.conversation_id = c.id
  LEFT JOIN local_state s ON s.conversation_id = c.id
  WHERE c.item_count >= 0`;

function toRow(r: Row, ctx: QueryContext): ConversationRow {
  const p = ctx.pending.get(r.id) ?? {};
  const pinned = p.pinned ?? r.e_pinned === 1;
  const archived = p.archived ?? r.e_archived === 1;
  const title = (p.title !== undefined ? p.title : r.e_title) || r.title;
  let tags: string[] = [];
  if (p.tags !== undefined) tags = p.tags ?? [];
  else if (r.e_tags) {
    try {
      const v = JSON.parse(r.e_tags);
      if (Array.isArray(v)) tags = v.filter((x): x is string => typeof x === "string");
    } catch {}
  }
  const live = !!r.local_mtime_ms && ctx.now - r.local_mtime_ms < LIVE_MS;
  const updated = !!r.last_pc && r.last_pc !== ctx.thisMachine && !!r.last_at && (!r.seen_last_at || r.last_at > r.seen_last_at);
  let pcs: string[] = [];
  try {
    pcs = JSON.parse(r.pcs);
  } catch {}
  return {
    id: r.id,
    title,
    preview: r.preview || r.last_prompt || r.first_prompt || "",
    projectId: r.project_id,
    projectLabel: r.project_label,
    folderLabel: r.folder_key && r.folder_key !== r.project_label && !r.folder_key.startsWith("_") ? r.folder_key : null,
    lastAt: r.last_at,
    startedAt: r.started_at,
    lastPc: r.last_pc,
    pcs,
    prompts: r.prompts,
    bytes: r.bytes,
    pinned,
    archived,
    tags,
    updated,
    live,
    runningHere: ctx.running.has(r.id),
    onThisPc: !!r.local_path,
    cwd: r.cwd,
    model: r.model,
  };
}

function allRows(db: DatabaseSync, ctx: QueryContext): ConversationRow[] {
  const rows = db.prepare(`${BASE} ORDER BY c.last_at DESC`).all() as unknown as Row[];
  return rows.filter((r) => !(ctx.pending.get(r.id)?.deleted ?? r.e_deleted === 1)).map((r) => toRow(r, ctx));
}

export function listConversations(db: DatabaseSync, q: ListQuery, ctx: QueryContext): ListResult {
  let rows = allRows(db, ctx);
  const scope = q.scope;
  if (scope.kind === "archived") rows = rows.filter((r) => r.archived);
  else {
    rows = rows.filter((r) => !r.archived);
    if (scope.kind === "pinned") rows = rows.filter((r) => r.pinned);
    else if (scope.kind === "project") {
      if (scope.id === "folder:*") rows = rows.filter((r) => r.projectId.startsWith("folder:") && r.projectId !== "folder:_home");
      else rows = rows.filter((r) => r.projectId === scope.id);
    } else if (scope.kind === "device") rows = rows.filter((r) => r.lastPc === scope.name || (!r.lastPc && scope.name === ctx.thisMachine));
    else if (scope.kind === "tag") rows = rows.filter((r) => r.tags.includes(scope.id));
  }
  const counts = { all: rows.length, updated: rows.filter((r) => r.updated).length, live: rows.filter((r) => r.live || r.runningHere).length };
  if (q.filter === "updated") rows = rows.filter((r) => r.updated);
  else if (q.filter === "live") rows = rows.filter((r) => r.live || r.runningHere);
  return { rows, counts };
}

export function sidebarData(db: DatabaseSync, ctx: QueryContext, devices: DeviceRecord[], folders: Record<string, string>): SidebarData {
  const rows = allRows(db, ctx);
  const visible = rows.filter((r) => !r.archived);
  const byProject = new Map<string, { label: string; count: number }>();
  for (const r of visible) {
    const p = byProject.get(r.projectId) ?? { label: r.projectLabel, count: 0 };
    p.count++;
    byProject.set(r.projectId, p);
  }
  const local = new Set((db.prepare("SELECT DISTINCT project_id FROM conversations WHERE local_path IS NOT NULL AND item_count >= 0").all() as { project_id: string }[]).map((r) => r.project_id));
  const projects: ProjectSummary[] = [];
  const otherIds: string[] = [];
  let otherCount = 0;
  for (const [id, p] of byProject) {
    if (id === "folder:_home") continue;
    if (id.startsWith("folder:")) {
      otherIds.push(id);
      otherCount += p.count;
      continue;
    }
    projects.push({ id, label: p.label, kind: "repo", count: p.count, folder: folders[id] ?? null, onThisPc: local.has(id) });
  }
  projects.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const home = byProject.get("folder:_home");
  if (home) projects.push({ id: "folder:_home", label: "Home folder", kind: "home", count: home.count, folder: folders["folder:_home"] ?? null });
  return {
    total: visible.length,
    pinned: visible.filter((r) => r.pinned).length,
    archived: rows.filter((r) => r.archived).length,
    projects,
    otherFolders: { count: otherCount, ids: otherIds },
    devices: deviceSummaries(db, ctx, devices, rows),
    tags: tagList(db, ctx, visible),
    pcCount: 0,
  };
}

/** A tag with no colour of its own gets one from its id, so every PC shows the same. */
export function fallbackColor(id: string): TagColor {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

/** Every tag that isn't deleted, by name, with how many of `rows` have it. Edits not yet read back from GitHub count. */
export function tagList(db: DatabaseSync, ctx: QueryContext, rows: ConversationRow[]): TagInfo[] {
  const defs = new Map<string, { name: string | null; color: string | null; deleted: boolean }>();
  for (const d of db.prepare("SELECT id, name, color, deleted FROM tag_defs").all() as { id: string; name: string | null; color: string | null; deleted: number }[]) {
    defs.set(d.id, { name: d.name, color: d.color, deleted: d.deleted === 1 });
  }
  for (const [id, p] of ctx.pending) {
    if (p.tagName === undefined && p.tagColor === undefined && p.tagDeleted === undefined) continue;
    const d = defs.get(id) ?? { name: null, color: null, deleted: false };
    if (p.tagName !== undefined) d.name = p.tagName;
    if (p.tagColor !== undefined) d.color = p.tagColor;
    if (p.tagDeleted !== undefined) d.deleted = p.tagDeleted;
    defs.set(id, d);
  }
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const out: TagInfo[] = [];
  for (const [id, d] of defs) {
    if (d.deleted || !d.name) continue;
    const color = (TAG_COLORS as readonly string[]).includes(d.color ?? "") ? (d.color as TagColor) : fallbackColor(id);
    out.push({ id, name: d.name, color, count: counts.get(id) ?? 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function deviceSummaries(db: DatabaseSync, ctx: QueryContext, devices: DeviceRecord[], rows?: ConversationRow[]): DeviceSummary[] {
  const names = new Set<string>([ctx.thisMachine]);
  for (const m of db.prepare("SELECT name FROM machines").all() as { name: string }[]) names.add(m.name);
  const pushed = new Map((db.prepare("SELECT name, last_push_at FROM machine_activity").all() as { name: string; last_push_at: string }[]).map((r) => [r.name, r.last_push_at]));
  for (const n of pushed.keys()) names.add(n);
  for (const d of devices) names.add(d.name);
  const list = rows ?? allRows(db, ctx);
  const lastSeen = new Map<string, string>();
  for (const r of list) {
    if (!r.lastPc || !r.lastAt) continue;
    if (!lastSeen.has(r.lastPc) || r.lastAt > lastSeen.get(r.lastPc)!) lastSeen.set(r.lastPc, r.lastAt);
  }
  const seenOf = (name: string) => {
    const d = devices.find((x) => x.name === name);
    return [d?.lastSeenAt, d?.lastPushAt, pushed.get(name), lastSeen.get(name)].filter(Boolean).sort().pop() ?? null;
  };
  // This PC first, then the PC seen most recently.
  return [...names]
    .sort((a, b) => (a === ctx.thisMachine ? -1 : b === ctx.thisMachine ? 1 : String(seenOf(b) ?? "").localeCompare(String(seenOf(a) ?? "")) || a.localeCompare(b)))
    .map((name) => {
      const d = devices.find((x) => x.name === name);
      const seen = seenOf(name);
      const status: DeviceSummary["status"] = name === ctx.thisMachine ? "current" : d && (d.engine ?? 0) >= 3 ? "current" : "old-sync";
      return {
        name,
        isThisPc: name === ctx.thisMachine,
        lastSeenAt: seen,
        engine: d?.engine ?? null,
        app: d?.app ?? null,
        claudeCode: d?.claudeCode ?? null,
        status,
        color: "graphite" as const,
        glyph: /laptop|book|surface/i.test(name) ? ("laptop" as const) : ("monitor" as const),
      };
    });
}

export function conversationDetail(db: DatabaseSync, id: string, ctx: QueryContext, folders: Record<string, string>): ConversationDetail | null {
  const r = db.prepare(`${BASE} AND c.id = ?`).get(id) as unknown as Row | undefined;
  if (!r) return null;
  const row = toRow(r, ctx);
  const where = row.folderLabel ?? row.projectLabel;
  const who = row.runningHere || (row.live && row.lastPc === ctx.thisMachine) ? `Live on this ${PC}` : `Last on ${row.lastPc === ctx.thisMachine ? `this ${PC}` : row.lastPc ?? "another PC"}`;
  const subtitle = [who, where, `${row.prompts} prompt${row.prompts === 1 ? "" : "s"}`].join("  ·  ");
  const folder = folders[row.projectId] ?? (r.cwd && r.local_path ? r.cwd : null);
  const recentElsewhere = row.lastPc && row.lastPc !== ctx.thisMachine && row.lastAt && ctx.now - Date.parse(row.lastAt) < LIVE_MS ? { pc: row.lastPc, at: row.lastAt } : null;
  return {
    row,
    subtitle,
    totalItems: r.item_count,
    partial: false,
    bytes: r.bytes,
    folder,
    canContinue: !!folder,
    alsoOpenOn: recentElsewhere,
    contextPercent: contextPercent(db, r),
  };
}

/**
 * "38% of context used" for a conversation that isn't running: the tokens in
 * context at its last reply, over the model's window. The window is only ever
 * inferred from evidence: a model seen above 200,000 tokens has the 1M window;
 * Haiku has 200,000. Otherwise nothing is shown rather than a guess.
 */
function contextPercent(db: DatabaseSync, r: Row): number | null {
  if (!r.context_tokens || !r.model) return null;
  const peak = (db.prepare("SELECT MAX(peak_context_tokens) AS p FROM conversations WHERE model = ?").get(r.model) as { p: number | null }).p ?? 0;
  const window = peak > 200_000 && peak <= 1_000_000 ? 1_000_000 : /haiku/i.test(r.model) ? 200_000 : null;
  if (!window) return null;
  return Math.max(1, Math.min(100, Math.round((r.context_tokens / window) * 100)));
}

export function itemsPage(db: DatabaseSync, id: string, beforeSeq: number | null, limit: number): ItemsPage {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE conversation_id = ?").get(id) as { n: number }).n;
  const rows = (beforeSeq == null
    ? db.prepare("SELECT json FROM items WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?").all(id, limit)
    : db.prepare("SELECT json FROM items WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(id, beforeSeq, limit)) as { json: string }[];
  const items = rows.map((r) => JSON.parse(r.json) as TranscriptItem).reverse();
  return { items, firstSeq: items.length ? items[0].seq : 0, total };
}

export function markSeen(db: DatabaseSync, id: string) {
  const r = db.prepare("SELECT last_at FROM conversations WHERE id = ?").get(id) as { last_at?: string } | undefined;
  db.prepare("INSERT OR REPLACE INTO local_state (conversation_id, seen_at, seen_last_at) VALUES (?, ?, ?)").run(id, new Date().toISOString(), r?.last_at ?? null);
}

// ------------------------------------------------------------------ search

/** User text to an FTS5 query: every word must appear, each as a prefix. */
export function ftsQuery(text: string): string | null {
  const words = text
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function search(db: DatabaseSync, text: string, ctx: QueryContext, { includeTools = false, limit = 20 } = {}): SearchResult {
  const t0 = performance.now();
  const q = ftsQuery(text);
  const rows = allRows(db, ctx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  if (q) {
    try {
      const titleHits = db.prepare("SELECT conversation_id AS id, bm25(fts_title) AS score FROM fts_title WHERE fts_title MATCH ? ORDER BY score LIMIT 50").all(q) as { id: string }[];
      for (const h of titleHits) {
        const r = byId.get(h.id);
        if (!r || seen.has(h.id)) continue;
        seen.add(h.id);
        hits.push({ id: r.id, title: r.title, projectLabel: r.projectLabel, lastPc: r.lastPc, lastAt: r.lastAt, snippet: null, field: "title" });
      }
    } catch {}
    try {
      const roles = includeTools ? "('prompt','reply','tool')" : "('prompt','reply')";
      const bodyHits = db
        .prepare(`SELECT conversation_id AS id, role, snippet(fts, 0, char(1), char(2), '…', 10) AS snip, bm25(fts) AS score FROM fts WHERE fts MATCH ? AND role IN ${roles} ORDER BY score LIMIT 400`)
        .all(q) as { id: string; role: string; snip: string }[];
      for (const h of bodyHits) {
        const r = byId.get(h.id);
        if (!r) continue;
        if (seen.has(h.id)) {
          const existing = hits.find((x) => x.id === h.id);
          if (existing && !existing.snippet && existing.field === "title") continue;
          continue;
        }
        seen.add(h.id);
        hits.push({ id: r.id, title: r.title, projectLabel: r.projectLabel, lastPc: r.lastPc, lastAt: r.lastAt, snippet: h.snip.replace(/\s+/g, " "), field: h.role === "prompt" ? "prompt" : h.role === "tool" ? "tool" : "reply" });
      }
    } catch {}
  }
  // Titles first; then the rest by how recent they are.
  const titleFirst = hits.filter((h) => h.field === "title");
  const rest = hits.filter((h) => h.field !== "title").sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  const out = [...titleFirst, ...rest].slice(0, limit);

  let suggestion: SearchResult["suggestion"] = null;
  if (!out.length && q) {
    const word = text.trim().toLowerCase().split(/\s+/).pop() ?? "";
    if (word.length >= 3) {
      const candidates = db.prepare("SELECT term, doc FROM fts_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?").all(word[0], String.fromCharCode(word.charCodeAt(0) + 1), word.length - 2, word.length + 2) as { term: string; doc: number }[];
      let best: { term: string; doc: number; d: number } | null = null;
      for (const c of candidates) {
        const d = levenshtein(word, c.term);
        if (d === 0 || d > 2) continue;
        if (!best || d < best.d || (d === best.d && c.doc > best.doc)) best = { term: c.term, doc: c.doc, d };
      }
      if (best) {
        const again = search(db, best.term, ctx, { includeTools, limit: 200 });
        if (again.hits.length) suggestion = { text: best.term, count: again.hits.length };
      }
    }
  }
  const pcs = new Set(rows.flatMap((r) => (r.lastPc ? [r.lastPc] : [])));
  return { query: text, hits: out, suggestion, searchedConversations: rows.length, pcCount: pcs.size, tookMs: Math.round(performance.now() - t0) };
}

/**
 * A chat link's chat: its title and its latest items, in order; null when it isn't here or
 * was deleted. At most `limit` items, so a huge chat can't hold up a send.
 */
export function chatForRef(db: DatabaseSync, id: string, ctx: QueryContext, limit = 4000): { title: string; items: TranscriptItem[]; cut: boolean } | null {
  const r = db.prepare(`${BASE} AND c.id = ?`).get(id) as unknown as Row | undefined;
  if (!r || (ctx.pending.get(id)?.deleted ?? r.e_deleted === 1)) return null;
  const rows = db.prepare("SELECT json FROM items WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?").all(id, limit + 1) as { json: string }[];
  const cut = rows.length > limit;
  const items = rows.slice(0, limit).reverse().map((x) => JSON.parse(x.json) as TranscriptItem);
  return { title: toRow(r, ctx).title, items, cut };
}

/** What the index holds for an id's edits (a conversation's, or a tag's), as the overlay keeps them. */
const stmts = new WeakMap<DatabaseSync, { edit: ReturnType<DatabaseSync["prepare"]>; tag: ReturnType<DatabaseSync["prepare"]> }>();

export function storedEdits(db: DatabaseSync, id: string): Record<string, string | boolean | string[] | null | undefined> {
  let q = stmts.get(db);
  if (!q) {
    q = { edit: db.prepare("SELECT pinned, title, archived, deleted, tags FROM edits WHERE conversation_id = ?"), tag: db.prepare("SELECT name, color, deleted FROM tag_defs WHERE id = ?") };
    stmts.set(db, q);
  }
  const e = q.edit.get(id) as { pinned: number | null; title: string | null; archived: number | null; deleted: number | null; tags: string | null } | undefined;
  const t = q.tag.get(id) as { name: string | null; color: string | null; deleted: number } | undefined;
  let tags: string[] | null = null;
  try {
    tags = e?.tags ? JSON.parse(e.tags) : null;
  } catch {}
  return {
    pinned: e?.pinned === 1,
    title: e?.title ?? null,
    archived: e?.archived === 1,
    deleted: e?.deleted === 1,
    tags,
    tagName: t?.name ?? null,
    tagColor: t?.color ?? null,
    tagDeleted: t?.deleted === 1,
  };
}
