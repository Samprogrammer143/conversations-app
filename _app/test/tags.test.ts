// Tags: a chat's "tags" edit is a list of tag ids; a tag's own record (name, colour,
// deleted) is kept under its id. Both come from every PC's _state log, as pins do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/main/index/db";
import { Indexer } from "../src/main/index/indexer";
import { fallbackColor, listConversations, sidebarData, type QueryContext } from "../src/main/index/queries";
import { readEdits } from "../src/main/sync/repo-read";
import { checkEdit } from "../src/main/validate";
import { EditsOverlay } from "../src/main/edits-overlay";
import { storedEdits } from "../src/main/index/queries";
import { chipsFor, nextColor } from "../src/renderer/lib/tags";
import type { TagInfo } from "../src/shared/types";

const CHAT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CHAT_B = "aaaaaaaa-0000-4000-8000-000000000002";
const TAG_SL = "bbbbbbbb-0000-4000-8000-000000000001";
const TAG_BUG = "bbbbbbbb-0000-4000-8000-000000000002";
const TAG_GONE = "bbbbbbbb-0000-4000-8000-000000000003";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tags-test-"));

const transcript = (id: string, text: string) =>
  [
    { type: "user", uuid: `${id}-u`, parentUuid: null, isSidechain: false, sessionId: id, message: { role: "user", content: text }, timestamp: "2026-11-20T10:00:00.000Z", cwd: "/x", promptSource: "typed" },
    { type: "assistant", uuid: `${id}-a`, parentUuid: `${id}-u`, isSidechain: false, sessionId: id, message: { role: "assistant", model: "m", content: [{ type: "text", text: "Done." }] }, timestamp: "2026-11-20T10:01:00.000Z", cwd: "/x" },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";

const op = (hlc: string, session: string, field: string, value: unknown) => JSON.stringify({ hlc, pc: "Home PC", at: "2026-11-20T10:00:00.000Z", session, field, value });

describe("tags", () => {
  const projectsDir = path.join(root, "projects");
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(path.join(projectsDir, "-x"), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "-x", `${CHAT_A}.jsonl`), transcript(CHAT_A, "Fix the footer"));
  fs.writeFileSync(path.join(projectsDir, "-x", `${CHAT_B}.jsonl`), transcript(CHAT_B, "Plan the ads"));
  fs.mkdirSync(path.join(repoDir, "_state"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "_state", "home-pc.jsonl"),
    [
      op("000000000000001-0000-home", TAG_SL, "tagName", "S&L"),
      op("000000000000001-0001-home", TAG_SL, "tagColor", "orange"),
      op("000000000000001-0002-home", TAG_BUG, "tagName", "Bugs"),
      op("000000000000001-0003-home", TAG_GONE, "tagName", "Old"),
      op("000000000000001-0004-home", TAG_GONE, "tagDeleted", true),
      op("000000000000001-0005-home", CHAT_A, "tags", [TAG_SL, TAG_BUG]),
      op("000000000000001-0006-home", CHAT_B, "tags", [TAG_SL, TAG_GONE]),
      // Not valid: dropped, as every PC's engine drops them.
      op("000000000000001-0007-home", CHAT_B, "tags", ["not-an-id"]),
      op("000000000000001-0008-home", TAG_BUG, "tagColor", "pink"),
    ].join("\n") + "\n",
  );
  const db = openDb(path.join(root, "index.db"));
  const ix = new Indexer(db, { projectsDir, repoDir, home: os.homedir(), thisMachine: "Home PC" });
  ix.scan();
  afterAll(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ctx = (pending: QueryContext["pending"] = new Map()): QueryContext => ({ thisMachine: "Home PC", now: Date.now(), running: new Set(), pending });

  it("reads a chat's tags and each tag's name and colour from the logs, and drops invalid values", () => {
    const edits = readEdits(repoDir);
    expect(edits.get(CHAT_A)?.tags).toEqual([TAG_SL, TAG_BUG]);
    expect(edits.get(CHAT_B)?.tags).toEqual([TAG_SL, TAG_GONE]);
    expect(edits.get(TAG_SL)).toMatchObject({ tagName: "S&L", tagColor: "orange" });
    expect(edits.get(TAG_BUG)?.tagColor).toBeUndefined();
  });

  it("lists every tag that isn't deleted, by name, with counts and a colour each", () => {
    const sb = sidebarData(db, ctx(), [], {});
    expect(sb.tags).toEqual([
      { id: TAG_BUG, name: "Bugs", color: fallbackColor(TAG_BUG), count: 1 },
      { id: TAG_SL, name: "S&L", color: "orange", count: 2 },
    ]);
  });

  it("filters the list by a tag, and rows carry their tags", () => {
    const list = listConversations(db, { scope: { kind: "tag", id: TAG_BUG }, filter: "all" }, ctx());
    expect(list.rows.map((r) => r.id)).toEqual([CHAT_A]);
    expect(list.rows[0].tags).toEqual([TAG_SL, TAG_BUG]);
  });

  it("shows edits not yet read back from GitHub: a new tag, a rename, a chat's new tags", () => {
    const NEW = "bbbbbbbb-0000-4000-8000-000000000009";
    const pending: QueryContext["pending"] = new Map([
      [NEW, { tagName: "Ideas", tagColor: "purple" }],
      [TAG_BUG, { tagName: "Bug fixes" }],
      [CHAT_B, { tags: [NEW] }],
    ]);
    const sb = sidebarData(db, ctx(pending), [], {});
    expect(sb.tags.map((t) => [t.name, t.count])).toEqual([
      ["Bug fixes", 1],
      ["Ideas", 1],
      ["S&L", 1],
    ]);
    const list = listConversations(db, { scope: { kind: "tag", id: NEW }, filter: "all" }, ctx(pending));
    expect(list.rows.map((r) => r.id)).toEqual([CHAT_B]);
  });

  it("checks tag edits from the window", () => {
    expect(checkEdit("tags", [TAG_SL.toUpperCase(), TAG_SL])).toEqual({ field: "tags", value: [TAG_SL] });
    expect(checkEdit("tags", ["x"])).toBeNull();
    expect(checkEdit("tags", Array.from({ length: 31 }, () => TAG_SL))).toBeNull();
    expect(checkEdit("tagName", "  Client   work ")).toEqual({ field: "tagName", value: "Client work" });
    expect(checkEdit("tagName", "   ")).toBeNull();
    expect(checkEdit("tagName", "x".repeat(41))).toBeNull();
    expect(checkEdit("tagColor", "teal")).toEqual({ field: "tagColor", value: "teal" });
    expect(checkEdit("tagColor", "pink")).toBeNull();
    expect(checkEdit("tagDeleted", true)).toEqual({ field: "tagDeleted", value: true });
  });

  it("gives a new tag the least-used colour, and fits a row's tags with +N for the rest", () => {
    const t = (id: string, name: string, color: TagInfo["color"]): TagInfo => ({ id, name, color, count: 0 });
    expect(nextColor([])).toBe("blue");
    expect(nextColor([t("1", "a", "blue"), t("2", "b", "orange")])).toBe("green");
    const tags = [t("1", "Conversations app", "green"), t("2", "Bugs", "red"), t("3", "S&L", "orange"), t("4", "Ideas", "purple")];
    expect(chipsFor(["1", "2"], tags)).toMatchObject({ shown: [{ name: "Conversations app" }], more: 1 });
    expect(chipsFor(["3", "4"], tags)).toMatchObject({ shown: [{ name: "S&L" }, { name: "Ideas" }], more: 0 });
    expect(chipsFor(["gone", "3"], tags)).toMatchObject({ shown: [{ name: "S&L" }], more: 0 });
  });
  it("adds tags to an index made before them, without rebuilding it", () => {
    const file = path.join(root, "old.db");
    const old = openDb(file);
    old.exec("ALTER TABLE edits DROP COLUMN tags");
    old.exec("DROP TABLE tag_defs");
    old.exec("INSERT INTO edits (conversation_id, pinned) VALUES ('kept', 1)");
    old.close();
    const again = openDb(file);
    const cols = (again.prepare("PRAGMA table_info(edits)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("tags");
    expect(again.prepare("SELECT COUNT(*) AS n FROM tag_defs").get()).toEqual({ n: 0 });
    expect(again.prepare("SELECT pinned FROM edits WHERE conversation_id = 'kept'").get()).toEqual({ pinned: 1 });
    again.close();
  });

  it("an overlaid edit stops masking the index once the index holds the same value", () => {
    const o = new EditsOverlay();
    o.apply(TAG_SL, "tagName", "S&L");
    o.apply(TAG_BUG, "tagName", "Defects");
    o.apply(CHAT_A, "tags", [TAG_SL, TAG_BUG]);
    o.apply(CHAT_B, "pinned", false);
    o.settleMatching((id) => storedEdits(db, id) as never);
    expect([...o.pending.keys()]).toEqual([TAG_BUG]);
    expect(o.pending.get(TAG_BUG)).toEqual({ tagName: "Defects" });
    // While a save for it is still running, the index may hold the value from before: it stays.
    o.apply(CHAT_B, "tags", []);
    o.begin(CHAT_B);
    o.settleMatching((id) => storedEdits(db, id) as never);
    expect(o.pending.get(CHAT_B)).toEqual({ tags: [] });
    o.end(CHAT_B);
    o.settleMatching((id) => storedEdits(db, id) as never);
    expect(o.pending.has(CHAT_B)).toBe(true); // the index still has [S&L, Old] for it
  });

  it("a chat id that somehow carries a tag's fields keeps its own edits", () => {
    fs.appendFileSync(path.join(repoDir, "_state", "home-pc.jsonl"), op("000000000000002-0000-home", CHAT_A, "tagName", "oops") + "\n");
    ix.syncEdits();
    const list = listConversations(db, { scope: { kind: "all" }, filter: "all" }, ctx());
    expect(list.rows.find((r) => r.id === CHAT_A)?.tags).toEqual([TAG_SL, TAG_BUG]);
  });
});
