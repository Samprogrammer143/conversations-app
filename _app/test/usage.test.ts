// The usage meters under the sidebar: Claude Code's /usage answer → the bars, and the reset wording.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
import { toPlanUsage } from "../src/main/chat/usage";
import { resetText } from "../src/renderer/lib/format";

// The shape Claude Code returned for this account on 12 Oct 2026 (trimmed).
const real = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 47, resets_at: "2026-10-12T21:39:59.959432+00:00", limit_dollars: null },
    seven_day: { utilization: 37, resets_at: "2026-10-17T18:59:59.959460+00:00" },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [{ display_name: "Fable", utilization: 52, resets_at: "2026-10-17T18:59:59.959649+00:00" }],
  },
};

describe("usage meters", () => {
  it("shows the session, the week across all models and the Fable week, in that order", () => {
    const u = toPlanUsage(real, 1000)!;
    expect(u.plan).toBe("max");
    expect(u.at).toBe(1000);
    expect(u.meters.map((m) => [m.key, m.label, m.percent])).toEqual([
      ["session", "Current session", 47],
      ["week", "Weekly · All models", 37],
      ["week:fable", "Weekly · Fable", 52],
    ]);
    expect(u.meters[0].resetsAt).toBe("2026-10-12T21:39:59.959432+00:00");
  });

  it("is empty when the account has no plan limits (an API key)", () => {
    expect(toPlanUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(toPlanUsage(null)).toBeNull();
    expect(toPlanUsage({ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: { utilization: null } } })).toBeNull();
  });

  it("keeps percentages between 0 and 100 and drops windows it cannot read", () => {
    const u = toPlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 103.6, resets_at: "not a date" }, seven_day: { utilization: -2 }, model_scoped: [{ display_name: "", utilization: 5 }, { utilization: 9 } as never] } })!;
    expect(u.meters.map((m) => [m.key, m.percent, m.resetsAt])).toEqual([
      ["session", 100, null],
      ["week", 0, null],
    ]);
  });

  it("reads the older per-model slots, without repeating a model the newer list already has", () => {
    const u = toPlanUsage({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 10 }, model_scoped: [{ display_name: "Opus", utilization: 20, resets_at: null }], seven_day_opus: { utilization: 99 }, seven_day_sonnet: { utilization: 30 } } })!;
    expect(u.meters.map((m) => [m.label, m.percent])).toEqual([
      ["Weekly · All models", 10],
      ["Weekly · Opus", 20],
      ["Weekly · Sonnet", 30],
    ]);
  });
});

describe("reset wording", () => {
  const now = Date.parse("2026-10-12T17:51:00Z");
  it("counts down within a day and names the day beyond it", () => {
    expect(resetText("2026-10-12T21:39:59Z", now)).toMatch(/^Resets in 3 hr 49 min \(\d\d:\d\d\)$/);
    expect(resetText("2026-10-12T18:30:00Z", now)).toMatch(/^Resets in 39 min \(/);
    expect(resetText("2026-10-17T18:59:59Z", now)).toMatch(/^Resets Sat 17 Oct, \d\d:\d\d$/);
    expect(resetText("2026-10-12T17:00:00Z", now)).toBe("Resets any moment");
    expect(resetText(null, now)).toBe("");
    expect(resetText("soon", now)).toBe("");
  });
});
