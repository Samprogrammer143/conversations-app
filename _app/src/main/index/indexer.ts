// Keeps the local index in step with the transcripts on disk: this PC's own
// (~/.claude/projects) and every PC's copies in the sync repository. Runs in a
// worker thread; a full scan only re-reads conversations whose files changed.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { parseTranscript } from "./parse";
import { tx } from "./db";
import { listRemoteSessions, normaliseRemote, projectIdForCwd, projectLabel, readEdits, type RemoteSession } from "../sync/repo-read";

export interface IndexerOptions {
  projectsDir: string;
  repoDir: string;
  home: string;
  thisMachine: string;
}

interface Source {
  path: string;
  id: string;
  kind: "local" | "repo";
  size: number;
  mtimeMs: number;
  meta?: RemoteSession;
}

export interface ScanResult {
  changed: string[];
  removed: string[];
  total: number;
  ms: number;
}

const PROFILE_RE = /^([a-z]:\\users\\[^\\]+)/i;
export const profilePrefix = (cwd: string | null | undefined) => (cwd ? (String(cwd).replace(/\//g, "\\").match(PROFILE_RE)?.[1] ?? null)?.toLowerCase() ?? null : null);

export class Indexer {
  private machines = new Map<string, string>(); // Windows user folder -> PC name
  private keyRemote = new Map<string, string>(); // repo folder key -> project id

  constructor(private db: DatabaseSync, private opts: IndexerOptions) {}

  private longPrefix = new Map<string, string | null>();

  /** Which PC wrote an entry, from its working folder's Windows user folder. */
  machineForCwd = (cwd: string | null | undefined): string | null => {
    const p = profilePrefix(cwd);
    if (!p) return null;
    const hit = this.machines.get(p);
    if (hit) return hit;
    // An 8.3 short name ("C:\Users\ALEXAN~1") exists only on the PC that made it:
    // resolve it here to the long name the other entries use.
    if (!p.includes("~")) return null;
    if (!this.longPrefix.has(p)) {
      let long: string | null = null;
      try {
        long = fs.realpathSync.native(p).toLowerCase();
      } catch {}
      this.longPrefix.set(p, long);
    }
    const long = this.longPrefix.get(p);
    return long ? this.machines.get(long) ?? null : null;
  };

  private learnMachines(remote: RemoteSession[]) {
    const m = new Map<string, string>();
    for (const s of remote) {
      for (const [pc, v] of Object.entries(s.machines || {})) {
        const p = profilePrefix(v?.cwd);
        if (p && !m.has(p)) m.set(p, pc);
      }
    }
    const mine = profilePrefix(this.opts.home);
    if (mine) m.set(mine, this.opts.thisMachine);
    this.machines = m;
    // Each PC's latest upload, as its conversations' meta files record it.
    const lastPush = new Map<string, string>();
    for (const s of remote) {
      for (const [pc, v] of Object.entries(s.machines || {})) {
        if (v?.lastPushAt && (!lastPush.has(pc) || v.lastPushAt > lastPush.get(pc)!)) lastPush.set(pc, v.lastPushAt);
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
    const votes: Record<string, Record<string, number>> = {};
    for (const s of remote) {
      const r = normaliseRemote(s.gitRemote);
      if (!r) continue;
      const v = (votes[s.key] ??= {});
      v[r] = (v[r] || 0) + 1;
    }
    this.keyRemote = new Map(Object.entries(votes).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]));
  }

  private localSources(): Source[] {
    const out: Source[] = [];
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.opts.projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return out;
    }
    for (const d of dirs) {
      const dir = path.join(this.opts.projectsDir, d);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          out.push({ path: p, id: f.slice(0, -6), kind: "local", size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        } catch {}
      }
    }
    return out;
  }

  private repoSources(remote: RemoteSession[]): Source[] {
    const out: Source[] = [];
    for (const s of remote) {
      for (const name of ["transcript.jsonl", "transcript.jsonl.gz"]) {
        const p = path.join(s.dir, name);
        try {
          const st = fs.statSync(p);
          out.push({ path: p, id: s.sessionId, kind: "repo", size: st.size, mtimeMs: Math.floor(st.mtimeMs), meta: s });
          break;
        } catch {}
      }
    }
    return out;
  }

  /** Scans everything; re-reads only what changed. */
  scan({ only }: { only?: Set<string> } = {}): ScanResult {
    const t0 = Date.now();
    const remote = listRemoteSessions(this.opts.repoDir);
    this.learnMachines(remote);
    const sources = [...this.localSources(), ...this.repoSources(remote)];
    const byId = new Map<string, Source[]>();
    for (const s of sources) {
      const list = byId.get(s.id) ?? [];
      list.push(s);
      byId.set(s.id, list);
    }
    const known = new Map((this.db.prepare("SELECT id, sig FROM conversations").all() as { id: string; sig: string }[]).map((r) => [r.id, r.sig]));
    const changed: string[] = [];
    for (const [id, list] of byId) {
      if (only && !only.has(id)) continue;
      const sig = list.map((s) => `${s.kind}:${s.path}:${s.size}:${s.mtimeMs}`).sort().join("|");
      if (known.get(id) === sig) continue;
      try {
        if (this.reindex(id, list, sig)) changed.push(id);
      } catch (e) {
        console.error(`[indexer] ${id}: ${(e as Error).message}`);
      }
    }
    const removed: string[] = [];
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

  private lastTimestamp(file: string, gz: boolean): string {
    try {
      if (gz) return ""; // compressed copies are only ever the older kind; prefer the plain copy
      const fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const all = [...buf.toString("utf8").matchAll(/"timestamp":"([^"]+)"/g)];
      return all.length ? all[all.length - 1][1] : "";
    } catch {
      return "";
    }
  }

  private reindex(id: string, list: Source[], sig: string): boolean {
    const local = list.filter((s) => s.kind === "local").sort((a, b) => b.size - a.size)[0];
    const repo = list.find((s) => s.kind === "repo");
    // The copy with the newest entry is shown; on a tie, this PC's own copy.
    let primary = local ?? repo!;
    if (local && repo) {
      const lt = this.lastTimestamp(local.path, false);
      const rt = this.lastTimestamp(repo.path, repo.path.endsWith(".gz"));
      if (rt > lt) primary = repo;
    }
    let buf = fs.readFileSync(primary.path);
    if (primary.path.endsWith(".gz")) buf = zlib.gunzipSync(buf);
    const parsed = parseTranscript(buf, { machineForCwd: this.machineForCwd, sourcePath: primary.path });
    // Chats started or carried on in the app are shown although they ran through
    // the SDK; the app marks them on this PC and, through _state, on every PC.
    const appOwned = !!this.db.prepare("SELECT 1 FROM app_sessions WHERE conversation_id = ? UNION ALL SELECT 1 FROM edits WHERE conversation_id = ? AND app = 1").get(id, id);
    // A chat the app started stays even before it has a typed prompt (one begun with "!" or a command).
    if ((parsed.info.prompts === 0 && !appOwned) || (parsed.info.headless && !appOwned)) {
      // Command-only sessions and scripted runs stay out of the list, as they stay out of sync.
      this.remove(id);
      this.db.prepare("INSERT OR REPLACE INTO conversations (id, sig, project_id, project_label, title, indexed_at, item_count) VALUES (?, ?, '', '', '', ?, -1)").run(id, sig, new Date().toISOString());
      return false;
    }

    const meta = repo?.meta;
    let projectId: string;
    let folderKey: string | null = meta?.key ?? null;
    if (meta) projectId = meta.projectId;
    else {
      const cwd = parsed.info.cwd;
      if (cwd && fs.existsSync(cwd)) {
        const p = projectIdForCwd(cwd, this.opts.home);
        projectId = p.projectId;
        folderKey = p.folderKey;
      } else {
        const key = cwd ? path.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") : "unknown";
        folderKey = key;
        projectId = this.keyRemote.get(key) ?? `folder:${key}`;
      }
    }
    if (projectId.startsWith("folder:") && folderKey && this.keyRemote.has(folderKey)) projectId = this.keyRemote.get(folderKey)!;

    const lastPc = parsed.info.lastPc ?? meta?.lastPushedFrom ?? null;
    const pcs = new Set(parsed.info.pcs);
    for (const pc of Object.keys(meta?.machines ?? {})) pcs.add(pc);
    const now = new Date().toISOString();

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
      insRow.run(id, -Number(t.lastInsertRowid)); // negative: a title row
      this.db
        .prepare(
          `INSERT OR REPLACE INTO conversations
           (id, sig, primary_path, local_path, repo_dir, folder_key, project_id, project_label, title, first_prompt, last_prompt, preview,
            started_at, last_at, prompts, bytes, last_pc, pcs, cwd, git_branch, model, version, context_tokens, peak_context_tokens, local_mtime_ms, item_count, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
          now,
        );
      const delSrc = this.db.prepare("DELETE FROM sources WHERE conversation_id = ?");
      delSrc.run(id);
      const insSrc = this.db.prepare("INSERT OR REPLACE INTO sources (path, conversation_id, kind, size, mtime_ms) VALUES (?, ?, ?, ?, ?)");
      for (const s of list) insSrc.run(s.path, id, s.kind, s.size, s.mtimeMs);
    });
    return true;
  }

  private clearContent(id: string) {
    const rows = this.db.prepare("SELECT row FROM fts_rows WHERE conversation_id = ?").all(id) as { row: number }[];
    const delFts = this.db.prepare("DELETE FROM fts WHERE rowid = ?");
    const delTitle = this.db.prepare("DELETE FROM fts_title WHERE rowid = ?");
    for (const r of rows) (r.row < 0 ? delTitle : delFts).run(Math.abs(r.row));
    this.db.prepare("DELETE FROM fts_rows WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM items WHERE conversation_id = ?").run(id);
  }

  private remove(id: string) {
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
      for (const [id, e] of edits) ins.run(id, e.pinned === undefined ? null : e.pinned ? 1 : 0, e.title ?? null, e.archived === undefined ? null : e.archived ? 1 : 0, e.deleted ? 1 : 0, (e as { app?: boolean }).app ? 1 : 0);
      // A chat another PC's app marked as its own after this PC left it out:
      // forget the "left out" record so the next scan reads it again.
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
}
