// A big conversation kept in parts: the app reads exactly what the engine wrote, list and
// chat view alike, and an image in it opens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { isPackedTranscript, readRepoTranscript } from "../src/main/sync/repo-read";
import { parseTranscript } from "../src/main/index/parse";

const engine = path.resolve(__dirname, "..", "..", "_sync", "engine.mjs").replace(/\\/g, "/");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "repo-parts-"));
afterAll(() => fs.rmSync(T, { recursive: true, force: true }));

/** Writes a transcript into dir the engine's way, with small parts. */
function engineWrite(dir: string, file: string) {
  const code = `import fs from "node:fs"; const e = await import("file:///${engine}"); e.writeRemoteTranscript(${JSON.stringify(dir)}, fs.readFileSync(${JSON.stringify(file)}));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, CLAUDE_SYNC_HOME: path.join(T, "sync"), CLAUDE_SYNC_GZIP_OVER_BYTES: "1000", CLAUDE_SYNC_PART_BYTES: "1500" } });
  if (r.status !== 0) throw new Error(r.stderr);
}

const IMG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const entry = (i: number) => JSON.stringify({ type: "user", uuid: `u${i}`, parentUuid: i ? `u${i - 1}` : null, timestamp: new Date(Date.UTC(2026, 10, 6, 10, i)).toISOString(), cwd: "C:\\work", message: { role: "user", content: i === 9 ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: IMG } }, { type: "text", text: "see this" }] : `message ${i} ${"x".repeat(400)}` } });

describe("a conversation kept in parts", () => {
  const dir = path.join(T, "repo", "website", "aaaaaaaa-1111-4111-8111-111111111111");
  const src = path.join(T, "src.jsonl");
  const lines = Array.from({ length: 12 }, (_, i) => entry(i));
  fs.writeFileSync(src, lines.join("\n") + "\n");
  engineWrite(dir, src);
  const manifest = path.join(dir, "transcript.parts.json");

  it("is in several parts, and the app reads them back byte for byte", () => {
    const parts = JSON.parse(fs.readFileSync(manifest, "utf8")).parts;
    expect(parts.length).toBeGreaterThan(2);
    expect(isPackedTranscript(manifest)).toBe(true);
    expect(readRepoTranscript(manifest).equals(fs.readFileSync(src))).toBe(true);
  });
  it("shows every message, and its image's key points into the joined parts", async () => {
    const r = parseTranscript(readRepoTranscript(manifest), { sourcePath: manifest, machineForCwd: () => "Uni PC" });
    const users = r.items.filter((i) => i.kind === "user") as { text: string; images: { key: string }[] }[];
    expect(users).toHaveLength(12);
    const key = users[9].images[0].key;
    const [enc, off, block] = key.split("|");
    expect(decodeURIComponent(enc)).toBe(manifest);
    const joined = readRepoTranscript(manifest);
    const end = joined.indexOf(10, Number(off));
    const e = JSON.parse(joined.toString("utf8", Number(off), end));
    expect(e.message.content[Number(block)].source.data).toBe(IMG);
  });
  it("refuses a parts list naming a file outside its folder", () => {
    const bad = path.join(T, "bad", "transcript.parts.json");
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, JSON.stringify({ parts: [{ file: "../../secret.gz" }] }));
    expect(() => readRepoTranscript(bad)).toThrow(/can't have/);
  });
});
