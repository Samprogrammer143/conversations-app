import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertWatcher, SETTLE_MS, type AlertWhy } from "../src/main/alert";
import type { ChatState, PermissionRequest } from "../src/shared/types";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const fired: [string, AlertWhy][] = [];
  const w = new AlertWatcher((id, why) => fired.push([id, why]));
  const to = (state: ChatState, requestId?: string, id = "a") => w.note({ conversationId: id, state, permission: requestId ? ({ requestId } as PermissionRequest) : null });
  return { fired, to };
}

describe("alert mode", () => {
  it("reports a finished reply after a moment", () => {
    const { fired, to } = setup();
    to("thinking");
    to("writing");
    to("idle");
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(fired).toEqual([["a", "finished"]]);
  });

  it("stays quiet when a queued follow-up starts right away", () => {
    const { fired, to } = setup();
    to("writing");
    to("idle");
    to("thinking");
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(fired).toEqual([]);
  });

  it("reports a question or approval at once, each one once", () => {
    const { fired, to } = setup();
    to("thinking");
    to("waiting-approval", "r1");
    to("waiting-approval", "r1");
    expect(fired).toEqual([["a", "needs-you"]]);
    to("running-tool");
    to("waiting-approval", "r2");
    expect(fired).toHaveLength(2);
  });

  it("says when a reply stopped with an error", () => {
    const { fired, to } = setup();
    to("running-tool");
    to("error");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(fired).toEqual([["a", "stopped"]]);
  });

  it("says when a chat fails to start", () => {
    const { fired, to } = setup();
    to("starting");
    to("error");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(fired).toEqual([["a", "stopped"]]);
  });

  it("ignores a Claude Code that only started (nothing ran), a first report, and an unnamed chat", () => {
    const { fired, to } = setup();
    to("starting");
    to("idle");
    to("idle", undefined, "b");
    to("thinking", undefined, "");
    to("idle", undefined, "");
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(fired).toEqual([]);
  });
});
