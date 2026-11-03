// The agents a chat has running: followed from what Claude Code reports about them, and
// what each one has done so far, read from the log it keeps of its work
// (<conversation>/subagents/agent-<task id>.jsonl).

import fs from "node:fs";
import path from "node:path";
import type { AgentDetail, AgentRun, AgentStep, ToolKind } from "../../shared/types";
import { HIDDEN_TOOLS, blocksOf, describeCall, parseEntries, textFromToolResult, toolKind } from "../index/parse";

/** How many ended agents a chat remembers: a long chat can run dozens. */
const KEEP_ENDED = 20;
/** A huge log is read from its start (for its brief) and its last part. */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_STEPS = 500;
/** Logs kept parsed, so a panel left open reads only what is new. */
const CACHED_LOGS = 8;
/** How an agent hands its report back to Claude: a tool call whose message is the report. */
const HANDBACK = "SubagentHandback";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.trim().split("\n")[0].trim();
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A task id as Claude Code makes them: it names a file, so nothing else gets through. */
export const isAgentId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);

type TaskMessage = { subtype?: string; [k: string]: unknown };

/** An agent someone would want to see: not a background command, a housekeeping task or Claude itself. */
const isAgent = (m: TaskMessage) => !m.ambient && !m.skip_transcript && m.subagent_type !== "main-session" && (m.task_type === "local_agent" || (!m.task_type && !!m.subagent_type));

const usageOf = (m: TaskMessage) => (m.usage && typeof m.usage === "object" ? (m.usage as { tool_uses?: unknown }) : {});

/** What an agent handed back, and whether that outranks its log (a warning, or a report held back). */
export interface AgentResult {
  text: string;
  overrides: boolean;
}

export const WITHHELD = "Claude Code's safety check held this agent's report back, so it isn't shown.";

/** What an agent handed back. Claude Code's own notes to Claude (a stopped agent's "summary") are not a report. */
function reportOf(m: TaskMessage, status: AgentRun["status"]): AgentResult | null {
  if (m.handback === "withheld") return { text: WITHHELD, overrides: true };
  const h = m.handback_report && typeof m.handback_report === "object" ? (m.handback_report as { text?: unknown; warning?: unknown }) : null;
  if (str(h?.text)) return { text: [str(h?.warning), str(h?.text)].filter(Boolean).join("\n\n"), overrides: !!str(h?.warning) || m.handback === "flagged" };
  return status === "finished" && str(m.summary) ? { text: str(m.summary), overrides: false } : null;
}

export class AgentTracker {
  private runs = new Map<string, AgentRun>();
  /** What each agent handed back, for when its log can't be read (or must not be shown as it is). */
  private results = new Map<string, AgentResult>();
  /** Agents started by an agent: they wait on that one, not on Claude's turn. */
  private nested = new Set<string>();
  /** true: in the background; false: Claude waits for it (it ends with the turn); unknown: older Claude Code. */
  private background = new Map<string, boolean>();

  /** One message from Claude Code; true when the agents changed. */
  handle(m: TaskMessage): boolean {
    const id = str(m.task_id);
    switch (m.subtype) {
      case "task_started":
        if (!id || !isAgent(m)) return false;
        this.add(id, m);
        if (typeof m.is_backgrounded === "boolean") this.background.set(id, m.is_backgrounded);
        if (str(m.parent_task_id) || (typeof m.spawn_depth === "number" && m.spawn_depth > 1) || m.owned_by_subagent === true) this.nested.add(id);
        return true;
      case "task_progress": {
        const r = this.runs.get(id);
        if (!r || r.status !== "running") return false;
        // A progress event's description is what the agent is doing now, not its task.
        const steps = usageOf(m).tool_uses;
        this.runs.set(id, { ...r, line: firstLine(str(m.summary) || str(m.description)) || r.line, steps: typeof steps === "number" ? steps : r.steps });
        return true;
      }
      case "task_updated": {
        const patch = (m.patch && typeof m.patch === "object" ? m.patch : {}) as { status?: unknown; end_time?: unknown; error?: unknown; is_backgrounded?: unknown };
        if (patch.is_backgrounded === true && this.runs.has(id)) this.background.set(id, true);
        const status = patch.status === "completed" ? "finished" : patch.status === "failed" ? "failed" : patch.status === "killed" ? "stopped" : null;
        if (!status) return false;
        return this.end(id, status, firstLine(str(patch.error)) || null, typeof patch.end_time === "number" ? patch.end_time : Date.now());
      }
      case "task_notification": {
        const r = this.runs.get(id);
        if (!r) return false;
        const status = m.status === "completed" ? "finished" : m.status === "failed" ? "failed" : "stopped";
        const report = reportOf(m, status);
        if (report) this.results.set(id, report);
        const steps = usageOf(m).tool_uses;
        const ended = this.end(id, status, status === "failed" ? firstLine(str(m.summary)) || null : null, Date.now());
        if (typeof steps === "number" && steps !== this.runs.get(id)!.steps) {
          this.runs.set(id, { ...this.runs.get(id)!, steps });
          return true;
        }
        return ended;
      }
      case "background_tasks_changed": {
        // The live background tasks, all of them: one that has gone from the list has ended,
        // even if its own word on how never came.
        const tasks = Array.isArray(m.tasks) ? (m.tasks as TaskMessage[]) : [];
        const live = new Set(tasks.map((t) => str(t.task_id)));
        let changed = false;
        for (const t of tasks) {
          const tid = str(t.task_id);
          if (!tid || !isAgent(t)) continue;
          if (!this.runs.has(tid)) {
            this.add(tid, t);
            changed = true;
          }
          this.background.set(tid, true);
        }
        for (const r of [...this.runs.values()]) if (r.status === "running" && this.background.get(r.id) === true && !live.has(r.id)) changed = this.end(r.id, "finished", null, Date.now()) || changed;
        return changed;
      }
      default:
        return false;
    }
  }

  /** A turn has ended: an agent Claude was waiting for has ended with it. */
  turnEnded(): boolean {
    let changed = false;
    for (const r of [...this.runs.values()]) if (r.status === "running" && this.background.get(r.id) === false && !this.nested.has(r.id)) changed = this.end(r.id, "finished", null, Date.now()) || changed;
    return changed;
  }

  /** Claude Code has gone, and what it was running with it. */
  stopAll(): boolean {
    let changed = false;
    for (const r of [...this.runs.values()]) if (r.status === "running") changed = this.end(r.id, "stopped", null, Date.now()) || changed;
    return changed;
  }

  /** Claude Code doesn't know the agent any more: it isn't running, whatever was last heard. */
  forceStop(id: string): boolean {
    const r = this.runs.get(id);
    if (!r || r.status !== "running") return false;
    return this.end(id, "stopped", null, Date.now());
  }

  /** The chat moved to a new conversation (/clear): what had ended belongs to the old one. */
  dropEnded(): boolean {
    let changed = false;
    for (const r of [...this.runs.values()])
      if (r.status !== "running") {
        this.forget(r.id);
        changed = true;
      }
    return changed;
  }

  private forget(id: string) {
    this.runs.delete(id);
    this.results.delete(id);
    this.background.delete(id);
    this.nested.delete(id);
  }

  private add(id: string, m: TaskMessage) {
    this.forget(id); // a resumed agent starts again, at the end of the list
    this.runs.set(id, { id, description: clip(firstLine(str(m.description)) || "An agent", 120), type: str(m.subagent_type) || null, status: "running", line: null, steps: 0, startedAt: Date.now(), endedAt: null });
    const ended = [...this.runs.values()].filter((r) => r.status !== "running");
    for (const r of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) this.forget(r.id);
  }

  private end(id: string, status: AgentRun["status"], line: string | null, at: number): boolean {
    const r = this.runs.get(id);
    if (!r) return false;
    if (r.status !== "running") {
      // Ended already: a later word on how it went (the notification after task_updated, or
      // after the list said it had gone) can change how, but a reason given stays.
      const next = { ...r, status, line: r.line ?? line };
      if (next.status === r.status && next.line === r.line) return false;
      this.runs.set(id, next);
      return true;
    }
    this.runs.set(id, { ...r, status, line: status === "finished" ? null : line, endedAt: at });
    return true;
  }

  list(): AgentRun[] {
    return [...this.runs.values()];
  }

  get running() {
    return [...this.runs.values()].filter((r) => r.status === "running").length;
  }

  result(id: string): AgentResult | null {
    return this.results.get(id) ?? null;
  }
}

/** How a step reads in the panel: done, and while it runs. */
function verbsFor(name: string, kind: ToolKind, server?: string): [string, string] {
  if (name === "WebFetch") return ["Read", "Reading"];
  if (name === "WebSearch") return ["Search", "Searching"];
  switch (kind) {
    case "read":
      return ["Read", "Reading"];
    case "search":
      return ["Search", "Searching"];
    case "edit":
      return ["Edit", "Editing"];
    case "write":
      return ["Write", "Writing"];
    case "command":
      return ["Ran", "Running"];
    case "agent":
      return ["Agent", "Agent"];
    case "plan":
      return ["Plan", "Planning"];
    case "mcp":
      return [server ?? name, server ?? name];
    default:
      return [name, name];
  }
}

/** A log read so far: kept between reads, so only what is new is parsed. */
interface LogState {
  brief: string | null;
  started: boolean;
  report: string | null;
  handedBack: boolean;
  steps: AgentStep[];
  total: number;
  /** Steps still waiting for their result, and when each began. */
  open: Map<string, { step: AgentStep; at: number | null }>;
}

const newLog = (): LogState => ({ brief: null, started: false, report: null, handedBack: false, steps: [], total: 0, open: new Map() });

function apply(st: LogState, buf: Buffer) {
  for (const e of parseEntries(buf)) {
    const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (e.type === "user") {
      const blocks = blocksOf(e.message?.content);
      // Its first message is the brief; anything said to it later isn't.
      if (!st.started) {
        st.started = true;
        if (!blocks.some((b) => b.type === "tool_result")) st.brief = clip(blocks.map((b) => str(b.text)).join("\n").trim(), 20_000) || null;
      }
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const o = st.open.get(str(b.tool_use_id));
        if (!o) continue;
        st.open.delete(str(b.tool_use_id));
        o.step.pending = false;
        o.step.error = b.is_error === true;
        if (o.at !== null && !Number.isNaN(at)) o.step.seconds = Math.max(0, Math.round((at - o.at) / 1000));
        if (o.step.error && !o.step.what) o.step.what = clip(firstLine(textFromToolResult(b.content)), 240);
      }
    } else if (e.type === "assistant") {
      st.started = true;
      for (const b of blocksOf(e.message?.content)) {
        if (b.type === "text" && str(b.text).trim()) {
          if (!st.handedBack) st.report = clip(str(b.text), 200_000);
          continue;
        }
        if (b.type !== "tool_use") continue;
        const name = str(b.name);
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        if (name === HANDBACK) {
          // Its report, handed back to Claude: not a step.
          st.report = clip(str(input.message), 200_000) || st.report;
          st.handedBack = true;
          continue;
        }
        if (HIDDEN_TOOLS.has(name)) continue;
        if (!st.handedBack) st.report = null; // only what it says after its last step is a report
        const kind = toolKind(name);
        const call = describeCall(name, input);
        const [verb, verbNow] = verbsFor(name, kind, call.server);
        const what = name === "WebFetch" ? str(input.url).replace(/^https?:\/\//, "") : kind === "mcp" ? (call.detail ?? "") : name === call.label ? "" : call.label;
        const step: AgentStep = { id: str(b.id) || `s${st.total}`, kind, verb, verbNow, what: clip(firstLine(what), 240), pending: true, error: false, seconds: null };
        st.steps.push(step);
        st.total++;
        st.open.set(step.id, { step, at: Number.isNaN(at) ? null : at });
        if (st.steps.length > MAX_STEPS) st.open.delete(st.steps.shift()!.id);
      }
    }
  }
}

const snapshot = (st: LogState): AgentDetail => ({ brief: st.brief, report: st.report, total: st.total, steps: st.steps.map((s) => ({ ...s })) });

/** An agent's brief, steps and report, from its log. Reads what it can of a log still being written. */
export function parseAgentLog(buf: Buffer): AgentDetail {
  const st = newLog();
  apply(st, buf);
  return snapshot(st);
}

/** One agent's log in parts (it moved to a new conversation with /clear): read as one, oldest first. */
export function mergeAgentLogs(parts: AgentDetail[]): AgentDetail | null {
  if (!parts.length) return null;
  // A step left waiting in an older part has its result in a newer one: it isn't still running.
  const steps = parts.flatMap((p, i) => (i < parts.length - 1 ? p.steps.map((s) => ({ ...s, pending: false })) : p.steps));
  return { brief: parts.find((p) => p.brief)?.brief ?? null, report: [...parts].reverse().find((p) => p.report)?.report ?? null, total: parts.reduce((n, p) => n + p.total, 0), steps: steps.slice(-MAX_STEPS) };
}

/** Where a conversation's agent keeps its log. */
export const agentLogFile = (transcript: string, agentId: string) => path.join(path.dirname(transcript), path.basename(transcript, ".jsonl"), "subagents", `agent-${agentId}.jsonl`);

const logs = new Map<string, { size: number; mtimeMs: number; offset: number; state: LogState }>();

/** The complete lines in a chunk of a log, applied; how many bytes they took. */
function applyLines(st: LogState, buf: Buffer): number {
  const end = buf.lastIndexOf(10);
  if (end < 0) return 0;
  apply(st, buf.subarray(0, end + 1));
  return end + 1;
}

const reading = new Map<string, Promise<unknown>>();

/**
 * Reads an agent's log; null when there is none. Kept between reads: unchanged, nothing is
 * read; grown, only the new part. A huge one: its start and its last part. One read of a log
 * at a time: two at once would both apply what is new.
 */
export function readAgentLog(file: string): Promise<AgentDetail | null> {
  const next = (reading.get(file) ?? Promise.resolve()).then(() => readOnce(file));
  const settled = next.catch(() => null);
  reading.set(file, settled);
  void settled.then(() => {
    if (reading.get(file) === settled) reading.delete(file);
  });
  return next;
}

async function readOnce(file: string): Promise<AgentDetail | null> {
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = await fs.promises.stat(file));
  } catch {
    logs.delete(file);
    return null;
  }
  let c = logs.get(file);
  if (c && c.size === size && c.mtimeMs === mtimeMs) return snapshot(c.state);
  try {
    const h = await fs.promises.open(file, "r");
    try {
      if (!c || size < c.offset) {
        c = { size: 0, mtimeMs: 0, offset: 0, state: newLog() };
        if (size > HEAD_BYTES + TAIL_BYTES) {
          const head = Buffer.alloc(HEAD_BYTES);
          const { bytesRead } = await h.read(head, 0, HEAD_BYTES, 0);
          applyLines(c.state, head.subarray(0, bytesRead));
          // Their results are in the part skipped: they aren't still running.
          for (const o of c.state.open.values()) o.step.pending = false;
          c.state.open.clear();
          // (The line this lands in is cut, so it isn't JSON and is skipped.)
          c.offset = size - TAIL_BYTES;
        }
      }
      const fresh = Buffer.alloc(size - c.offset);
      const { bytesRead } = await h.read(fresh, 0, fresh.length, c.offset);
      c.offset += applyLines(c.state, fresh.subarray(0, bytesRead));
      c.size = size;
      c.mtimeMs = mtimeMs;
    } finally {
      await h.close();
    }
  } catch {
    return c ? snapshot(c.state) : null;
  }
  logs.delete(file);
  logs.set(file, c);
  for (const k of logs.keys()) if (logs.size > CACHED_LOGS) logs.delete(k);
  return snapshot(c.state);
}
