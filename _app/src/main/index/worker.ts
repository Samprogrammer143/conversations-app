// Worker thread: owns the index's write connection and does all transcript reading,
// so the main process (and the window) never wait for disk or parsing.
import { parentPort, workerData } from "node:worker_threads";
import { getMeta, openDb, setMeta } from "./db";
import { Indexer, type IndexerOptions } from "./indexer";

const { dbPath, opts } = workerData as { dbPath: string; opts: IndexerOptions };
const db = openDb(dbPath);
const indexer = new Indexer(db, opts);

type Msg = { type: "scan"; only?: string[]; reason?: string } | { type: "own"; id: string; cwd: string } | { type: "seen-all" };

parentPort!.on("message", (m: Msg) => {
  try {
    if (m.type === "scan") {
      const r = indexer.scan({ only: m.only ? new Set(m.only) : undefined });
      if (!getMeta(db, "initialized")) {
        // First run on this PC: what is here now counts as read.
        indexer.markAllSeen();
        setMeta(db, "initialized", new Date().toISOString());
        parentPort!.postMessage({ type: "first-run", total: r.total });
      }
      parentPort!.postMessage({ type: "scanned", ...r, reason: m.reason ?? null });
    } else if (m.type === "own") {
      db.prepare("INSERT OR REPLACE INTO app_sessions (conversation_id, cwd, created_at) VALUES (?, ?, ?)").run(m.id, m.cwd, new Date().toISOString());
      // Re-read it: app chats are kept even though Claude Code marks them as scripted.
      db.prepare("UPDATE conversations SET sig = '' WHERE id = ?").run(m.id);
      const r = indexer.scan({ only: new Set([m.id]) });
      parentPort!.postMessage({ type: "scanned", ...r, reason: "own" });
    } else if (m.type === "seen-all") {
      indexer.markAllSeen();
    }
  } catch (e) {
    parentPort!.postMessage({ type: "error", message: String((e as Error).stack || e) });
  }
});

parentPort!.postMessage({ type: "ready" });
