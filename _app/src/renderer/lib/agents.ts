// What the agents bar and panel say about a chat's agents.

import type { AgentRun } from "../../shared/types";

/** "27 min", "1 h 5 min"; under a minute, "Under a minute" would be too long for the bar. */
export function agentTime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const rest = min % 60;
  return rest ? `${Math.floor(min / 60)} h ${rest} min` : `${Math.floor(min / 60)} h`;
}

const took = (a: AgentRun, now: number) => (a.endedAt ?? now) - a.startedAt;

/** One run of an agent: one resumed later is a new run, and shows on the bar again. */
export const agentKey = (a: AgentRun) => `${a.id}@${a.startedAt}`;

const names = (list: AgentRun[]) => {
  const d = list.map((a) => a.description);
  if (d.length <= 2) return d.join(" and ");
  return `${d[0]}, ${d[1]} and ${d.length - 2} more`;
};

export interface AgentBarText {
  kind: "running" | "finished" | "stopped";
  title: string;
  line: string;
  time: string;
}

/** How one ended agent ended, in words. */
export const endedWord = (a: AgentRun) => (a.status === "failed" ? `Failed${a.line ? `: ${a.line}` : ""}` : a.status === "stopped" ? "Stopped" : "Finished");

/** The bar: agents running, or ended and not yet looked at. Null when there's nothing to say. */
export function agentBarText(agents: AgentRun[], seen: Record<string, true>, now: number): AgentBarText | null {
  const running = agents.filter((a) => a.status === "running");
  if (running.length === 1) return { kind: "running", title: running[0].description, line: running[0].line ?? "Starting", time: agentTime(took(running[0], now)) };
  if (running.length > 1) return { kind: "running", title: `${running.length} agents running`, line: names(running), time: agentTime(Math.max(...running.map((a) => took(a, now)))) };
  const ended = agents.filter((a) => !seen[agentKey(a)]);
  if (!ended.length) return null;
  const bad = ended.filter((a) => a.status !== "finished");
  if (ended.length === 1) return { kind: bad.length ? "stopped" : "finished", title: ended[0].description, line: endedWord(ended[0]), time: agentTime(took(ended[0], now)) };
  return { kind: bad.length ? "stopped" : "finished", title: bad.length ? `${ended.length} agents ended, ${bad.length} didn't finish` : `${ended.length} agents finished`, line: names(ended), time: "" };
}

/** Running first, oldest first; then the ended, latest first. */
export function orderAgents(agents: AgentRun[]): AgentRun[] {
  const running = agents.filter((a) => a.status === "running");
  const ended = agents.filter((a) => a.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...running, ...ended];
}

/** "2 running, 1 finished" */
export function agentCounts(agents: AgentRun[]): string {
  const of = (s: AgentRun["status"]) => agents.filter((a) => a.status === s).length;
  const parts = [`${of("running")} running`, `${of("finished")} finished`, `${of("failed")} failed`, `${of("stopped")} stopped`];
  return parts.filter((p) => !p.startsWith("0 ")).join(", ");
}

/** Which agent the panel opens on: the one the bar is about. */
export function agentToOpen(agents: AgentRun[], seen: Record<string, true>): string | null {
  const list = orderAgents(agents);
  return (list.find((a) => a.status === "running") ?? list.find((a) => !seen[agentKey(a)]) ?? list[0])?.id ?? null;
}
