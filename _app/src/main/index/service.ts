// The index as the rest of the app sees it: a read connection for queries, a
// worker that keeps it current, and file watchers that tell the worker what
// changed. Emits "changed" with the conversation ids that moved.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db";
import { appDataDir, projectsDir, repoDir, thisMachine } from "../paths";
import { log } from "../log";

export class IndexService extends EventEmitter {
  db!: DatabaseSync;
  private worker!: Worker;
  private watchers: fs.FSWatcher[] = [];
  private dirty = new Set<string>();
  private dirtyAll = false;
  private timer: NodeJS.Timeout | null = null;
  private periodic: NodeJS.Timeout | null = null;
  private hotTimer: NodeJS.Timeout | null = null;
  /** Size and time of each live conversation's transcript at the last look. */
  private hotSeen = new Map<string, string>();
  /** Where each live conversation's transcript is, found once. */
  private hotPaths = new Map<string, { path: string | null; at: number }>();
  private busy = false;
  private queued = false;
  ready = false;
  firstRun = false;
  readonly dbPath = path.join(appDataDir(), "index.db");
  private workerFile = "";
  private restarts = 0;
  private stopped = false;

  /** How many times a worker that died is started again before the index is left as it is. */
  static readonly MAX_RESTARTS = 3;

  /**
   * Starts the worker and waits until the index is ready. If the worker dies
   * before that (a damaged index.db, a full disk), the index files are removed
   * and it is tried once more; after that the error is thrown, so the app can
   * carry on without an index instead of waiting forever.
   */
  async start(workerFile: string): Promise<void> {
    this.workerFile = workerFile;
    try {
      await this.spawnWorker();
    } catch (e) {
      log("index", `the index could not be opened (${(e as Error).message}); starting it afresh`);
      this.removeDbFiles();
      await this.spawnWorker();
    }
    this.db = openDb(this.dbPath, { readOnly: false });
    this.ready = true;
    this.scan("startup");
    this.watch();
    this.periodic = setInterval(() => this.scan("periodic"), 60_000);
  }

  private removeDbFiles() {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        fs.rmSync(`${this.dbPath}${suffix}`, { force: true });
      } catch {}
    }
  }

  /** The worker, and the promise of its "ready" message; rejected if it dies first. */
  private spawnWorker(): Promise<void> {
    const worker = new Worker(this.workerFile, {
      workerData: { dbPath: this.dbPath, opts: { projectsDir: projectsDir(), repoDir: repoDir(), home: os.homedir(), thisMachine: thisMachine() } },
    });
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let ready = false;
      worker.on("message", (m: { type: string; [k: string]: unknown }) => {
        if (m.type === "ready") {
          ready = true;
          resolve();
        } else this.onMessage(m);
      });
      worker.on("error", (e: Error) => {
        log("index", `worker crashed: ${e.stack || e}`);
        if (!ready) reject(e);
      });
      worker.on("exit", (code) => {
        if (this.worker !== worker) return;
        if (!ready) {
          reject(new Error(`index worker exited with code ${code} before it was ready`));
          return;
        }
        // A scan in flight is lost: the next flush will start over.
        this.busy = false;
        if (this.stopped) return;
        if (this.restarts >= IndexService.MAX_RESTARTS) {
          log("index", `worker exited (code ${code}) ${this.restarts} times; the index is no longer updated until the app restarts`);
          return;
        }
        this.restarts++;
        log("index", `worker exited (code ${code}); starting it again (${this.restarts} of ${IndexService.MAX_RESTARTS})`);
        this.spawnWorker().then(
          () => this.scan("restart"),
          (e) => log("index", `worker could not be started again: ${(e as Error).message}`),
        );
      });
    });
  }

  private onMessage(m: { type: string; [k: string]: unknown }) {
    if (m.type === "scanned") {
      this.busy = false;
      const changed = [...((m.changed as string[]) ?? []), ...((m.removed as string[]) ?? [])];
      // After a restart the window re-reads everything, in case the lost scan had changes.
      if (changed.length || m.reason === "startup" || m.reason === "restart") this.emit("changed", changed, m);
      if (m.reason === "startup") log("index", `startup scan: ${(m.changed as string[]).length} indexed of ${m.total} in ${m.ms} ms`);
      if (this.queued) {
        this.queued = false;
        this.flush();
      }
    } else if (m.type === "first-run") {
      this.firstRun = true;
      this.emit("first-run", m.total);
    } else if (m.type === "error") {
      this.busy = false;
      log("index", `worker error: ${String(m.message).slice(0, 500)}`);
    }
  }

  /** Full rescan (cheap: only changed files are read). */
  scan(reason = "manual") {
    this.dirtyAll = true;
    this.flushSoon(reason === "startup" ? 0 : 50, reason);
  }

  /** A conversation the app itself started: keep it even though it was made by the SDK. */
  own(id: string, cwd: string) {
    this.worker.postMessage({ type: "own", id, cwd });
  }

  private watch() {
    const add = (dir: string, toId: (rel: string) => string | null) => {
      if (!fs.existsSync(dir)) return;
      try {
        const w = fs.watch(dir, { recursive: true }, (_ev, file) => {
          if (!file) return this.scan("watch");
          const rel = String(file);
          if (rel.startsWith(".git") || rel.includes(`${path.sep}.git${path.sep}`)) return;
          const id = toId(rel);
          if (id) {
            this.dirty.add(id);
            this.flushSoon(400);
          } else if (rel.startsWith("_state") || rel.startsWith("_devices")) {
            this.scan("edits");
          }
        });
        w.on("error", (e) => log("index", `watch error on ${dir}: ${e.message}`));
        this.watchers.push(w);
      } catch (e) {
        log("index", `cannot watch ${dir}: ${(e as Error).message}`);
      }
    };
    // ~/.claude/projects/<folder>/<id>.jsonl
    add(projectsDir(), (rel) => {
      const parts = rel.split(path.sep);
      if (parts.length === 2 && parts[1].endsWith(".jsonl")) return parts[1].slice(0, -6);
      return null;
    });
    // repo/<key>/<id>/transcript.jsonl(.gz) or meta.json
    add(repoDir(), (rel) => {
      const parts = rel.split(path.sep);
      if (parts.length === 3 && /^(transcript\.jsonl(\.gz)?|meta\.json)$/.test(parts[2])) return parts[1];
      return null;
    });
  }

  /**
   * Conversations that are being written right now (open in a terminal or in the
   * app, or on screen) are looked at every 1.5 s. Claude Code keeps a transcript
   * open while it runs, and Windows reports no change to a file another program
   * holds open, so the watcher alone would leave them stale until it closes.
   */
  watchLive(liveIds: () => Iterable<string>, everyMs = 1500) {
    if (this.hotTimer) clearInterval(this.hotTimer);
    this.hotTimer = setInterval(() => {
      try {
        this.pollLive(liveIds());
      } catch (e) {
        log("index", `live check failed: ${(e as Error).message}`);
      }
    }, everyMs);
    this.hotTimer.unref?.();
  }

  /** One look at the live conversations' transcripts; a size or time change marks them for the worker. */
  pollLive(ids: Iterable<string>) {
    if (!this.ready) return;
    const now = new Set<string>();
    let any = false;
    for (const id of ids) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || now.has(id)) continue;
      now.add(id);
      const file = this.livePath(id);
      if (!file) continue;
      let sig: string;
      try {
        const st = fs.statSync(file);
        sig = `${st.size}:${st.mtimeMs}`;
      } catch {
        this.hotPaths.delete(id);
        continue;
      }
      const before = this.hotSeen.get(id);
      this.hotSeen.set(id, sig);
      // The first look only records it: the worker already compares it with what it indexed.
      if (before !== undefined && before !== sig) {
        this.dirty.add(id);
        any = true;
      }
    }
    for (const id of [...this.hotSeen.keys()]) if (!now.has(id)) this.hotSeen.delete(id);
    for (const id of [...this.hotPaths.keys()]) if (!now.has(id)) this.hotPaths.delete(id);
    if (any) this.flushSoon(100);
  }

  /** This PC's transcript for a conversation: from the index, or found in the projects folder. */
  private livePath(id: string): string | null {
    const hit = this.hotPaths.get(id);
    if (hit && (hit.path || Date.now() - hit.at < 10_000)) return hit.path;
    let found: string | null = null;
    try {
      const row = this.db.prepare("SELECT local_path FROM conversations WHERE id = ?").get(id) as { local_path?: string | null } | undefined;
      if (row?.local_path && fs.existsSync(row.local_path)) found = row.local_path;
    } catch {}
    if (!found) {
      try {
        for (const d of fs.readdirSync(projectsDir(), { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const f = path.join(projectsDir(), d.name, `${id}.jsonl`);
          if (fs.existsSync(f)) {
            found = f;
            break;
          }
        }
      } catch {}
    }
    this.hotPaths.set(id, { path: found, at: Date.now() });
    return found;
  }

  private flushSoon(ms: number, reason = "watch") {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(reason), ms);
  }

  private flush(reason = "watch") {
    if (!this.ready) return;
    if (this.busy) {
      this.queued = true;
      return;
    }
    const only = this.dirtyAll ? undefined : [...this.dirty];
    if (!this.dirtyAll && !only?.length) return;
    this.busy = true;
    this.dirty.clear();
    this.dirtyAll = false;
    this.worker.postMessage({ type: "scan", only, reason });
  }

  /** An image from a transcript, as a data URL. Only files under the two transcript folders can be read. */
  /** The last compressed transcript an image came from, already unpacked. */
  private gzCache: { file: string; sig: string; buf: Buffer } | null = null;

  private async unpacked(file: string): Promise<Buffer> {
    const st = fs.statSync(file);
    const sig = `${st.size}:${st.mtimeMs}`;
    if (this.gzCache?.file === file && this.gzCache.sig === sig) return this.gzCache.buf;
    // Off the main thread: a 90 MB transcript takes a moment to unpack.
    const buf = await new Promise<Buffer>((resolve, reject) => zlib.gunzip(fs.readFileSync(file), (err, out) => (err ? reject(err) : resolve(out))));
    this.gzCache = { file, sig, buf };
    return buf;
  }

  async image(key: string): Promise<string | null> {
    const [enc, offStr, blockStr] = key.split("|");
    const file = decodeURIComponent(enc ?? "");
    const offset = Number(offStr);
    const block = Number(blockStr);
    const allowed = [projectsDir(), repoDir()].some((root) => path.resolve(file).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
    if (!allowed || !Number.isFinite(offset) || !Number.isFinite(block)) return null;
    try {
      let line: string;
      if (file.endsWith(".gz")) {
        const buf = await this.unpacked(file);
        const end = buf.indexOf(10, offset);
        line = buf.toString("utf8", offset, end === -1 ? undefined : end);
      } else {
        const fd = fs.openSync(file, "r");
        const chunks: Buffer[] = [];
        let pos = offset;
        for (;;) {
          const b = Buffer.alloc(1024 * 1024);
          const n = fs.readSync(fd, b, 0, b.length, pos);
          if (n <= 0) break;
          const nl = b.subarray(0, n).indexOf(10);
          if (nl >= 0) {
            chunks.push(b.subarray(0, nl));
            break;
          }
          chunks.push(b.subarray(0, n));
          pos += n;
        }
        fs.closeSync(fd);
        line = Buffer.concat(chunks).toString("utf8");
      }
      const entry = JSON.parse(line);
      const b = entry?.message?.content?.[block];
      if (b?.type !== "image" || b.source?.type !== "base64") return null;
      return `data:${b.source.media_type || "image/png"};base64,${b.source.data}`;
    } catch {
      return null;
    }
  }

  stop() {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    if (this.periodic) clearInterval(this.periodic);
    if (this.hotTimer) clearInterval(this.hotTimer);
    void this.worker?.terminate();
  }
}
