// The plan usage meters under the sidebar: the same numbers as Claude Code's /usage
// (this session's 5-hour window, the week across all models, and each per-model weekly
// window such as Fable). Claude Code fetches them itself in a short session that sends
// nothing to the model, so asking costs no usage and the app never handles the login.
// The last reading is kept on disk so the meters show at once when the app starts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "./sdk";
import { appDataDir } from "../paths";
import { log } from "../log";
import type { PlanUsage, UsageMeter } from "../../shared/types";

type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type RawLimits = {
  five_hour?: Window;
  seven_day?: Window;
  seven_day_opus?: Window;
  seven_day_sonnet?: Window;
  model_scoped?: { display_name?: string; utilization?: number | null; resets_at?: string | null }[];
} | null;
type RawUsage = { subscription_type?: string | null; rate_limits_available?: boolean; rate_limits?: RawLimits };

const file = () => path.join(appDataDir(), "usage.json");
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function meter(key: string, label: string, w: Window): UsageMeter | null {
  if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return null;
  const resetsAt = typeof w.resets_at === "string" && Number.isFinite(Date.parse(w.resets_at)) ? w.resets_at : null;
  return { key, label, percent: clamp(w.utilization), resetsAt };
}

/** Claude Code's /usage answer → the meters, in the order the sidebar shows them. Null when the plan has none. */
export function toPlanUsage(raw: RawUsage | null | undefined, at = Date.now()): PlanUsage | null {
  if (!raw?.rate_limits_available || !raw.rate_limits) return null;
  const r = raw.rate_limits;
  const meters: UsageMeter[] = [];
  const add = (m: UsageMeter | null) => {
    if (m && !meters.some((x) => x.label.toLowerCase() === m.label.toLowerCase())) meters.push(m);
  };
  add(meter("session", "Current session", r.five_hour));
  add(meter("week", "Weekly · All models", r.seven_day));
  for (const m of Array.isArray(r.model_scoped) ? r.model_scoped : []) {
    const name = typeof m?.display_name === "string" ? m.display_name.trim() : "";
    if (name) add(meter(`week:${name.toLowerCase()}`, `Weekly · ${name}`, m));
  }
  // Older plans report per-model weeks in these fixed slots instead.
  add(meter("week:opus", "Weekly · Opus", r.seven_day_opus));
  add(meter("week:sonnet", "Weekly · Sonnet", r.seven_day_sonnet));
  return meters.length ? { at, plan: raw.subscription_type ?? null, meters } : null;
}

let last: PlanUsage | null | undefined; // undefined: not read from disk yet
let inflight: Promise<PlanUsage | null> | null = null;
let lastAskAt = 0;

/** The last reading, from memory or disk; null when there is none. */
export function lastUsage(): PlanUsage | null {
  if (last === undefined) {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as PlanUsage;
      last = saved && Array.isArray(saved.meters) && typeof saved.at === "number" ? saved : null;
    } catch {
      last = null;
    }
  }
  return last;
}

async function* nothing(): AsyncGenerator<never> {
  await new Promise(() => {});
}

/**
 * Asks Claude Code for fresh numbers, at most once per `minGapMs`. Resolves with the
 * newest reading (the previous one when asking fails or is too soon).
 */
export function refreshUsage(claudePath: string | null, minGapMs = 60_000): Promise<PlanUsage | null> {
  if (inflight) return inflight;
  if (!claudePath || Date.now() - lastAskAt < minGapMs) return Promise.resolve(lastUsage());
  lastAskAt = Date.now();
  inflight = (async () => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    // No settings: no hooks, plugins or MCP servers start for a question this small.
    const q = query({ prompt: nothing(), options: { cwd: os.homedir(), pathToClaudeCodeExecutable: claudePath, settingSources: [], env } });
    const timer = setTimeout(() => q.close(), 30_000);
    try {
      // The SDK marks this call experimental; look for it rather than assume it.
      const qq = q as unknown as Record<string, unknown>;
      const ask = (qq.usage ?? qq.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) as ((o: { skipBehaviors: boolean }) => Promise<RawUsage>) | undefined;
      if (typeof ask !== "function") {
        log("chat", "usage: this Claude Code has no usage call");
        return lastUsage();
      }
      const next = toPlanUsage(await ask.call(q, { skipBehaviors: true }));
      // Logged only when the numbers move, not every five minutes.
      const words = (u: PlanUsage | null | undefined) => (u ? u.meters.map((m) => `${m.key} ${m.percent}%`).join(", ") : "no plan limits");
      if (words(next) !== words(lastUsage())) log("chat", `usage: ${words(next)}`);
      last = next;
      try {
        if (next) fs.writeFileSync(file(), JSON.stringify(next));
        else fs.rmSync(file(), { force: true });
      } catch {}
      return next;
    } catch (e) {
      log("chat", `usage: ${(e as Error).message}`);
      return lastUsage();
    } finally {
      clearTimeout(timer);
      q.close();
      inflight = null;
    }
  })();
  return inflight;
}
