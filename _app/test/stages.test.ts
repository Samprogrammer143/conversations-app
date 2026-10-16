// Item 2: tidying staged copies never removes the one a live instance runs from.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanStages, readRunningMark, RUNNING_MARK, stagesToRemove, writeRunningMark } from "../src/shell/stages";

let root: string;
const stage = (name: string, ageMs: number) => {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "app.json"), "{}");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "stages-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("old app copies", () => {
  it("keeps the copy in use, the newest other one, and a live instance's copy", () => {
    const v1 = stage("0.1.0-aaaaaaaaaaaa", 4_000_000); // the tray agent runs from this one
    const v2 = stage("0.2.0-bbbbbbbbbbbb", 3_000_000);
    const v3 = stage("0.3.0-cccccccccccc", 2_000_000);
    const v4 = stage("0.4.0-dddddddddddd", 1_000_000); // what a second instance would run now
    stage("0.5.0-eeeeeeeeeeee.9.tmp", 0);
    writeRunningMark(root, v1, 4242);
    const alive = (pid: number) => pid === 4242;
    expect(readRunningMark(root, alive)?.stage).toBe(v1);
    expect(stagesToRemove(root, v4, alive).sort()).toEqual([v2].sort());
    // Without the mark (or once that process is gone), the old reasoning would have removed v1 and v2.
    expect(stagesToRemove(root, v4, () => false).sort()).toEqual([v1, v2].sort());
    const gone = cleanStages(root, v4, alive);
    expect(gone).toEqual([v2]);
    expect(fs.existsSync(v1)).toBe(true);
    expect(fs.existsSync(v3)).toBe(true);
    expect(fs.existsSync(v4)).toBe(true);
  });

  it("ignores a damaged or stale mark", () => {
    fs.writeFileSync(path.join(root, RUNNING_MARK), "not json");
    expect(readRunningMark(root)).toBeNull();
    writeRunningMark(root, path.join(root, "x"), 4_194_303); // a pid that can't exist
    expect(readRunningMark(root)).toBeNull();
    expect(stagesToRemove(path.join(root, "missing"), "x")).toEqual([]);
  });
});
