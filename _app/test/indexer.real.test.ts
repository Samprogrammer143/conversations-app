// Smoke test against this PC's real conversations. Reads transcripts only; the
// index it builds goes to a temporary file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/main/index/db";
import { Indexer } from "../src/main/index/indexer";
import { conversationDetail, itemsPage, listConversations, search, sidebarData, type QueryContext } from "../src/main/index/queries";
import { readDevices } from "../src/main/sync/repo-read";

const repoDir = path.join(process.env.LOCALAPPDATA || "", "claude-conversation-sync", "repo");
const projectsDir = path.join(os.homedir(), ".claude", "projects");

describe.skipIf(!fs.existsSync(repoDir))("index of real conversations", () => {
  const dbFile = path.join(os.tmpdir(), `conversations-index-test-${process.pid}.db`);
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  const db = openDb(dbFile);
  const ix = new Indexer(db, { projectsDir, repoDir, home: os.homedir(), thisMachine: "This PC" });
  const ctx: QueryContext = { thisMachine: "This PC", now: Date.now(), running: new Set(), pending: new Map() };

  it("indexes everything, then rescans in milliseconds", () => {
    const first = ix.scan();
    // What each conversation's files looked like after the first scan.
    const snapshot = (): Map<string, string> => {
      const m = new Map<string, string>();
      for (const r of db.prepare("SELECT conversation_id, path, size, mtime_ms FROM sources ORDER BY path").all() as { conversation_id: string; path: string; size: number; mtime_ms: number }[]) m.set(r.conversation_id, `${m.get(r.conversation_id) ?? ""}|${r.path}:${r.size}:${r.mtime_ms}`);
      return m;
    };
    const before = snapshot();
    const second = ix.scan();
    const after = snapshot();
    console.log(`first scan: ${first.changed.length} conversations in ${first.ms} ms; second scan: ${second.changed.length} changed in ${second.ms} ms`);
    expect(first.changed.length).toBeGreaterThan(5);
    // A rescan reads again only conversations whose files changed in between
    // (this PC's open Claude Code sessions and sync hooks keep writing).
    const unexplained = second.changed.filter((id) => before.get(id) === after.get(id));
    for (const id of unexplained) console.log(`re-read although its files did not change: ${id} ${after.get(id)}`);
    expect(unexplained).toEqual([]);
    expect(second.ms).toBeLessThan(1500);
  }, 180_000);

  it("groups projects by repository, like the design's sidebar", () => {
    const sb = sidebarData(db, ctx, readDevices(repoDir), {});
    console.log(JSON.stringify({ total: sb.total, projects: sb.projects.map((p) => `${p.label} ${p.count}`), other: sb.otherFolders, devices: sb.devices.map((d) => `${d.name} ${d.status} ${d.lastSeenAt}`) }, null, 1));
    expect(sb.projects.length).toBeGreaterThan(0);
    expect(sb.projects.every((p) => p.label.length > 0 && p.count > 0)).toBe(true);
    expect(sb.devices.length).toBeGreaterThan(0);
  });

  it("lists newest first, opens tail-first and searches in under 100 ms", () => {
    const t0 = performance.now();
    const list = listConversations(db, { scope: { kind: "all" }, filter: "all" }, ctx);
    const t1 = performance.now();
    expect(list.rows.length).toBeGreaterThan(5);
    const first = list.rows[0];
    const detail = conversationDetail(db, first.id, ctx, {});
    const page = itemsPage(db, first.id, null, 120);
    const t2 = performance.now();
    console.log(`list ${Math.round(t1 - t0)} ms; open "${first.title}" (${detail?.subtitle}) ${Math.round(t2 - t1)} ms, ${page.items.length}/${page.total} items`);
    console.log(list.rows.slice(0, 8).map((r) => `${r.title} | ${r.lastPc} | ${r.projectLabel}${r.folderLabel ? ` (${r.folderLabel})` : ""} | ${r.preview.slice(0, 60)}`).join("\n"));
    expect(t1 - t0).toBeLessThan(100);
    expect(t2 - t1).toBeLessThan(100);
    const s = search(db, "test", ctx);
    console.log(`search "test":${s.hits.length} hits in ${s.tookMs} ms; first: ${s.hits.slice(0, 3).map((h) => `${h.title} [${h.field}] ${h.snippet ?? ""}`).join(" / ")}`);
    expect(s.tookMs).toBeLessThan(100);
    const miss = search(db, "tset", ctx);
    console.log(`search "tset":${miss.hits.length} hits; suggestion ${JSON.stringify(miss.suggestion)}`);
  });
});
