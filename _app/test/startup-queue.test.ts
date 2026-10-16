// Item 5: a second instance during start-up never makes a window of its own; its
// request waits until the main window exists, then runs once.
import { describe, expect, it } from "vitest";
import { StartupQueue } from "../src/main/startup-queue";

describe("second-instance requests during start-up", () => {
  it("are kept and replayed in order once start-up is done, then handled at once", () => {
    const handled: string[][] = [];
    const q = new StartupQueue<string[]>((argv) => handled.push(argv));
    q.push(["app.exe"]);
    q.push(["app.exe", "conversations://review/toolu_1"]);
    expect(handled).toEqual([]);
    expect(q.pending).toBe(2);
    q.finish();
    expect(handled).toEqual([["app.exe"], ["app.exe", "conversations://review/toolu_1"]]);
    q.push(["app.exe", "--hidden"]);
    expect(handled.length).toBe(3);
    expect(q.pending).toBe(0);
  });
});
