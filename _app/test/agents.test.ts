// A chat's agents: following them from what Claude Code reports (these events are shaped as a
// real run sent them), reading their logs, and what the bar says about them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentTracker, WITHHELD, agentLogFile, isAgentId, mergeAgentLogs, parseAgentLog, readAgentLog } from "../src/main/chat/agents";
import { agentBarText, agentCounts, agentTime, agentToOpen, orderAgents } from "../src/renderer/lib/agents";
import type { AgentRun } from "../src/shared/types";

const started = (id: string, description = "Count fruit", extra: Record<string, unknown> = {}) => ({ subtype: "task_started", task_id: id, tool_use_id: `toolu_${id}`, description, subagent_type: "general-purpose", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent", prompt: "Read fruit.txt", ...extra });
const progress = (id: string, description: string, tool_uses: number, extra: Record<string, unknown> = {}) => ({ subtype: "task_progress", task_id: id, description, subagent_type: "general-purpose", usage: { total_tokens: 100, tool_uses, duration_ms: 1000 }, last_tool_name: "Read", ...extra });
const updated = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ subtype: "task_updated", task_id: id, patch: { status, end_time: 1793669860698, ...extra } });
const notified = (id: string, status: string, summary = "3 lines", tool_uses = 2) => ({ subtype: "task_notification", task_id: id, status, output_file: "x.output", summary, usage: { total_tokens: 100, tool_uses, duration_ms: 5000 } });

describe("following a chat's agents", () => {
  it("an agent from start to end, as a real run reports it", () => {
    const t = new AgentTracker();
    expect(t.handle(started("a1"))).toBe(true);
    expect(t.running).toBe(1);
    expect(t.list()[0]).toMatchObject({ id: "a1", description: "Count fruit", status: "running", line: null, steps: 0, type: "general-purpose" });
    expect(t.handle(progress("a1", "Reading fruit.txt", 1))).toBe(true);
    // A progress event's description is what it's doing now: the task's name stays.
    expect(t.list()[0]).toMatchObject({ description: "Count fruit", line: "Reading fruit.txt", steps: 1 });
    expect(t.handle(updated("a1", "completed"))).toBe(true);
    expect(t.running).toBe(0);
    expect(t.handle(notified("a1", "completed", "It has 3 lines", 2))).toBe(true);
    expect(t.list()[0]).toMatchObject({ status: "finished", line: null, steps: 2, endedAt: 1793669860698 });
    expect(t.result("a1")).toEqual({ text: "It has 3 lines", overrides: false });
  });
  it("prefers the model's one-line summary to the last action", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    t.handle(progress("a1", "Reading fruit.txt", 1, { summary: "Counting the fruit\nand more" }));
    expect(t.list()[0].line).toBe("Counting the fruit");
  });
  it("only agents count: not background commands, housekeeping or Claude itself", () => {
    const t = new AgentTracker();
    expect(t.handle(started("b1", "npm test", { task_type: "local_bash", subagent_type: undefined }))).toBe(false);
    expect(t.handle(started("m1", "Main", { subagent_type: "main-session" }))).toBe(false);
    expect(t.handle(started("h1", "Housekeeping", { ambient: true }))).toBe(false);
    expect(t.handle(started("h2", "Housekeeping", { skip_transcript: true }))).toBe(false);
    expect(t.handle(progress("b1", "x", 1))).toBe(false);
    expect(t.handle(notified("b1", "completed"))).toBe(false);
    expect(t.list()).toEqual([]);
  });
  it("other messages from Claude Code aren't its business", () => {
    const t = new AgentTracker();
    expect(t.handle({ subtype: "init", session_id: "x" })).toBe(false);
    expect(t.handle({ subtype: "status" })).toBe(false);
  });
  it("picks up an agent it missed the start of, from the list of live tasks", () => {
    const t = new AgentTracker();
    const tasks = [{ task_id: "a9", task_type: "local_agent", subagent_type: "general-purpose", description: "Late one" }, { task_id: "b9", task_type: "local_bash", description: "A command" }, { task_id: "w9", task_type: "local_agent", ambient: true, description: "Watcher" }];
    expect(t.handle({ subtype: "background_tasks_changed", tasks })).toBe(true);
    expect(t.list().map((a) => a.id)).toEqual(["a9"]);
    expect(t.handle({ subtype: "background_tasks_changed", tasks })).toBe(false);
  });
  it("a background agent gone from the live-task list has ended, even if word of how never came", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    expect(t.handle({ subtype: "background_tasks_changed", tasks: [] })).toBe(true);
    expect(t.list()[0]).toMatchObject({ status: "finished", line: null });
    // A later word on how it went still counts.
    expect(t.handle(notified("a1", "failed", "It ran out of room"))).toBe(true);
    expect(t.list()[0]).toMatchObject({ status: "failed", line: "It ran out of room" });
  });
  it("one Claude waits for isn't in that list: the list doesn't end it, the turn ending does", () => {
    const t = new AgentTracker();
    t.handle(started("f1", "List files", { is_backgrounded: false }));
    t.handle({ subtype: "background_tasks_changed", tasks: [] });
    expect(t.running).toBe(1);
    expect(t.turnEnded()).toBe(true);
    expect(t.list()[0].status).toBe("finished");
    expect(t.turnEnded()).toBe(false);
  });
  it("one an agent started and waits on doesn't end with Claude's turn: it waits on its agent, not on Claude", () => {
    const t = new AgentTracker();
    t.handle(started("p1", "Research"));
    t.handle(started("c1", "Helper", { is_backgrounded: false, parent_task_id: "p1", spawn_depth: 2 }));
    t.handle(started("c2", "Helper 2", { is_backgrounded: false, owned_by_subagent: true }));
    expect(t.turnEnded()).toBe(false);
    expect(t.running).toBe(3);
  });
  it("one first seen in the live-task list ends when it leaves it", () => {
    const t = new AgentTracker();
    t.handle({ subtype: "background_tasks_changed", tasks: [{ task_id: "x1", task_type: "local_agent", subagent_type: "general-purpose", description: "Late" }] });
    expect(t.handle({ subtype: "background_tasks_changed", tasks: [] })).toBe(true);
    expect(t.list()[0].status).toBe("finished");
  });
  it("one moved to the background later doesn't end with the turn", () => {
    const t = new AgentTracker();
    t.handle(started("f1", "List files", { is_backgrounded: false }));
    t.handle({ subtype: "task_updated", task_id: "f1", patch: { is_backgrounded: true } });
    expect(t.turnEnded()).toBe(false);
    expect(t.running).toBe(1);
  });
  it("from an older Claude Code that doesn't say which kind: neither ends it", () => {
    const t = new AgentTracker();
    t.handle(started("o1", "Old", { is_backgrounded: undefined }));
    t.handle({ subtype: "background_tasks_changed", tasks: [] });
    expect(t.turnEnded()).toBe(false);
    expect(t.running).toBe(1);
  });
  it("one Claude Code no longer knows is stopped by hand", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    expect(t.forceStop("a1")).toBe(true);
    expect(t.list()[0].status).toBe("stopped");
    expect(t.forceStop("a1")).toBe(false);
    expect(t.forceStop("nope")).toBe(false);
  });
  it("after /clear, the ones that ended stay with the old conversation", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    t.handle(started("a2"));
    t.handle(notified("a2", "completed"));
    expect(t.dropEnded()).toBe(true);
    expect(t.list().map((a) => a.id)).toEqual(["a1"]);
    expect(t.result("a2")).toBe(null);
    expect(t.dropEnded()).toBe(false);
  });
  it("what an agent handed back is its report; Claude Code's notes about a stopped one aren't", () => {
    const t = new AgentTracker();
    t.handle(started("h1"));
    t.handle({ ...notified("h1", "completed", "Harness notes for the model"), handback_report: { text: "The real report", warning: "It ran long." } });
    expect(t.result("h1")).toEqual({ text: "It ran long.\n\nThe real report", overrides: true });
    t.handle(started("w1"));
    t.handle({ ...notified("w1", "completed", "Notes"), handback: "withheld" });
    expect(t.result("w1")).toEqual({ text: WITHHELD, overrides: true });
    t.handle(started("s1", "Long job"));
    t.handle(notified("s1", "stopped", "Long job"));
    expect(t.result("s1")).toBe(null);
    t.handle(started("c1"));
    t.handle(notified("c1", "completed", "Plain summary"));
    expect(t.result("c1")).toEqual({ text: "Plain summary", overrides: false });
    // Flagged, with no warning text of its own: still outranks the log.
    t.handle(started("f1"));
    t.handle({ ...notified("f1", "completed"), handback: "flagged", handback_report: { text: "Report" } });
    expect(t.result("f1")).toEqual({ text: "Report", overrides: true });
  });
  it("a failure's own reason isn't replaced by the notification's", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    t.handle(updated("a1", "failed", { error: "It hit the usage limit" }));
    t.handle(notified("a1", "failed", "Agent failed: see the log"));
    expect(t.list()[0].line).toBe("It hit the usage limit");
  });
  it("a late progress event doesn't bring an ended agent back", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    t.handle(notified("a1", "completed"));
    expect(t.handle(progress("a1", "Reading", 5))).toBe(false);
    expect(t.list()[0].status).toBe("finished");
  });
  it("failed says why; stopped needs no reason", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    t.handle(updated("a1", "failed", { error: "It hit the usage limit\nmore" }));
    expect(t.list()[0]).toMatchObject({ status: "failed", line: "It hit the usage limit" });
    t.handle(notified("a1", "failed", "It hit the usage limit"));
    expect(t.list()[0]).toMatchObject({ status: "failed", line: "It hit the usage limit" });
    t.handle(started("a2"));
    t.handle(progress("a2", "Reading", 1));
    t.handle(updated("a2", "killed"));
    t.handle(notified("a2", "stopped", "Task stopped"));
    expect(t.list().find((a) => a.id === "a2")).toMatchObject({ status: "stopped", line: null });
  });
  it("when Claude Code goes, what it was running goes with it", () => {
    const t = new AgentTracker();
    t.handle(started("a1"));
    t.handle(started("a2"));
    t.handle(notified("a2", "completed"));
    expect(t.stopAll()).toBe(true);
    expect(t.list().map((a) => a.status)).toEqual(["stopped", "finished"]);
    expect(t.stopAll()).toBe(false);
  });
  it("a long chat keeps the running ones and its latest ended ones", () => {
    const t = new AgentTracker();
    t.handle(started("keep"));
    for (let i = 0; i < 40; i++) {
      t.handle(started(`e${i}`));
      t.handle(notified(`e${i}`, "completed"));
    }
    expect(t.list().find((a) => a.id === "keep")?.status).toBe("running");
    expect(t.list().length).toBeLessThanOrEqual(22);
    expect(t.list().some((a) => a.id === "e39")).toBe(true);
    expect(t.result("e0")).toBe(null);
  });
  it("a very long task name is cut", () => {
    const t = new AgentTracker();
    t.handle(started("a1", "x".repeat(500)));
    expect(t.list()[0].description.length).toBe(120);
  });
});

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (content: unknown, timestamp = "2026-11-03T10:00:00.000Z") => line({ type: "user", isSidechain: true, timestamp, message: { role: "user", content } });
const assistant = (content: unknown, timestamp = "2026-11-03T10:00:01.000Z") => line({ type: "assistant", isSidechain: true, timestamp, message: { role: "assistant", content } });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const result = (id: string, extra: Record<string, unknown> = {}) => ({ type: "tool_result", tool_use_id: id, content: "ok", ...extra });
const log = (...lines: string[]) => Buffer.from(`${lines.join("\n")}\n`);

describe("an agent's log", () => {
  it("its brief, steps and report", () => {
    const d = parseAgentLog(
      log(
        user("Find out about Göcek."),
        line({ type: "attachment", attachment: { type: "x" } }),
        assistant([{ type: "text", text: "Looking." }, use("1", "WebSearch", { query: "Göcek sea temperature" })]),
        user([result("1")], "2026-11-03T10:00:04.000Z"),
        assistant([use("2", "WebFetch", { url: "https://mgm.gov.tr/deniz?x=1" })], "2026-11-03T10:00:05.000Z"),
        user([result("2")], "2026-11-03T10:00:07.000Z"),
        assistant([use("3", "Bash", { command: "pdftotext kaunos.pdf\nsecond line" })], "2026-11-03T10:00:08.000Z"),
        user([result("3", { is_error: true })], "2026-11-03T10:00:08.000Z"),
        assistant([use("4", "Read", { file_path: "C:\\work\\kaunos.txt" }), use("5", "mcp__claude_ai_Linear__list_issues", {})], "2026-11-03T10:00:09.000Z"),
        user([result("4"), result("5")], "2026-11-03T10:00:10.000Z"),
        assistant([{ type: "text", text: "## What I found\n\nAll of it." }], "2026-11-03T10:00:11.000Z"),
      ),
    );
    expect(d.brief).toBe("Find out about Göcek.");
    expect(d.total).toBe(5);
    expect(d.report).toBe("## What I found\n\nAll of it.");
    expect(d.steps.map((s) => [s.verb, s.what])).toEqual([
      ["Search", "Göcek sea temperature"],
      ["Read", "mgm.gov.tr/deniz?x=1"],
      ["Ran", "pdftotext kaunos.pdf"],
      ["Read", "work/kaunos.txt"],
      ["Linear", "list issues"],
    ]);
    expect(d.steps[0]).toMatchObject({ kind: "web", pending: false, error: false, seconds: 3 });
    expect(d.steps[2]).toMatchObject({ kind: "command", error: true, seconds: 0 });
  });
  it("still being written: its last step is in progress and what it said on the way isn't a report", () => {
    const d = parseAgentLog(log(user("Go."), assistant([{ type: "text", text: "Starting with the weather." }, use("1", "WebFetch", { url: "http://a.com" })])));
    expect(d.steps[0]).toMatchObject({ pending: true, verb: "Read", verbNow: "Reading", seconds: null });
    expect(d.report).toBe(null);
    const half = Buffer.concat([log(user("Go."), assistant([use("1", "Read", { file_path: "a.txt" })])), Buffer.from('{"type":"assistant","mess')]);
    expect(parseAgentLog(half).total).toBe(1);
  });
  it("an agent that hands its report back (as most of yours do): the handback is the report, not a step", () => {
    const d = parseAgentLog(
      log(
        user("Review this."),
        assistant([use("1", "Read", { file_path: "a.ts" })]),
        user([result("1")]),
        assistant([{ type: "thinking", thinking: "" }]),
        assistant([use("2", "SubagentHandback", { message: "## Score: 8/10\n\nFine." })]),
        user([result("2")]),
        assistant([{ type: "text", text: "Handed back." }]),
      ),
    );
    expect(d.report).toBe("## Score: 8/10\n\nFine.");
    expect(d.steps.map((s) => s.verb)).toEqual(["Read"]);
    expect(d.total).toBe(1);
  });
  it("Claude Code's own tool lookups aren't steps", () => {
    expect(parseAgentLog(log(user("Go."), assistant([use("1", "ToolSearch", { query: "select:x" })]))).total).toBe(0);
  });
  it("only its first message is its brief", () => {
    expect(parseAgentLog(log(user([result("0")]), user("Later message"))).brief).toBe(null);
  });
  it("text before a later step isn't the report, but text after the last one is", () => {
    const d = parseAgentLog(log(user("Go."), assistant([{ type: "text", text: "Hm." }]), assistant([use("1", "Read", { file_path: "a.txt" })]), user([result("1")]), assistant([{ type: "text", text: "Done." }])));
    expect(d.report).toBe("Done.");
  });
  it("a tool result isn't taken for its brief, and a brief can come in blocks", () => {
    expect(parseAgentLog(log(user([result("1")]))).brief).toBe(null);
    expect(parseAgentLog(log(user([{ type: "text", text: "In blocks." }]))).brief).toBe("In blocks.");
  });
  it("keeps the newest 500 steps and says how many there were", () => {
    const lines = [user("Go.")];
    for (let i = 0; i < 620; i++) lines.push(assistant([use(String(i), "Read", { file_path: `f${i}.txt` })]));
    const d = parseAgentLog(log(...lines));
    expect(d.total).toBe(620);
    expect(d.steps.length).toBe(500);
    expect(d.steps.at(-1)?.what).toBe("f619.txt");
  });
  it("only a task id gets to name a file", () => {
    for (const ok of ["a539188e955d396ae", "task_1-2"]) expect(isAgentId(ok)).toBe(true);
    for (const bad of ["../../secret", "a/b", "a\\b", "a.b", "", null, 5, "x".repeat(81)]) expect(isAgentId(bad)).toBe(false);
  });
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
  afterAll(() => fs.rmSync(T, { recursive: true, force: true }));
  it("found beside the conversation's own file", async () => {
    const transcript = path.join(T, "proj", "abc.jsonl");
    const file = agentLogFile(transcript, "a1");
    expect(file).toBe(path.join(T, "proj", "abc", "subagents", "agent-a1.jsonl"));
    expect(await readAgentLog(file)).toBe(null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, log(user("Go.")));
    expect((await readAgentLog(file))?.brief).toBe("Go.");
  });
  it("read again: only what's new is read, and the result is the same as reading it whole", async () => {
    const file = path.join(T, "growing.jsonl");
    fs.writeFileSync(file, log(user("Go."), assistant([use("1", "Read", { file_path: "a.txt" })])));
    expect((await readAgentLog(file))?.steps[0].pending).toBe(true);
    // Half a line arrives: it waits for the rest.
    fs.appendFileSync(file, `${user([result("1")])}\n${assistant([use("2", "Read", { file_path: "b.txt" })]).slice(0, 30)}`);
    let d = await readAgentLog(file);
    expect(d?.total).toBe(1);
    expect(d?.steps[0].pending).toBe(false);
    fs.appendFileSync(file, `${assistant([use("2", "Read", { file_path: "b.txt" })]).slice(30)}\n${assistant([{ type: "text", text: "Done." }])}\n`);
    d = await readAgentLog(file);
    expect(d).toEqual(parseAgentLog(fs.readFileSync(file)));
    expect(d?.report).toBe("Done.");
    // Written again from scratch (shorter): read from the start.
    fs.writeFileSync(file, log(user("Other.")));
    expect((await readAgentLog(file))?.brief).toBe("Other.");
  });
  it("two reads of one log at once don't count what's new twice", async () => {
    const file = path.join(T, "twice.jsonl");
    fs.writeFileSync(file, log(user("Go.")));
    await readAgentLog(file);
    fs.appendFileSync(file, log(assistant([use("1", "Read", { file_path: "a.txt" })]), assistant([use("2", "Read", { file_path: "b.txt" })])));
    const [a, b] = await Promise.all([readAgentLog(file), readAgentLog(file)]);
    expect(a?.total).toBe(2);
    expect(b?.total).toBe(2);
    expect((await readAgentLog(file))?.steps.map((s) => s.id)).toEqual(["1", "2"]);
  });
  it("a log in parts (it moved with /clear): one brief, all the steps in order, the latest report", () => {
    const old = parseAgentLog(log(user("The brief."), assistant([use("1", "Read", { file_path: "a.txt" })]), user([result("1")])));
    const now = parseAgentLog(log(assistant([use("2", "Read", { file_path: "b.txt" })]), user([result("2")]), assistant([{ type: "text", text: "Done." }])));
    expect(mergeAgentLogs([old, now])).toMatchObject({ brief: "The brief.", total: 2, report: "Done." });
    expect(mergeAgentLogs([old, now])?.steps.map((s) => s.id)).toEqual(["1", "2"]);
    expect(mergeAgentLogs([])).toBe(null);
    const waiting = parseAgentLog(log(user("Go."), assistant([use("w", "Read", { file_path: "w.txt" })])));
    expect(mergeAgentLogs([waiting, now])?.steps[0].pending).toBe(false);
  });
  it("a huge log: its start and its end, with the part cut through skipped", async () => {
    const file = path.join(T, "huge.jsonl");
    const fd = fs.openSync(file, "w");
    fs.writeSync(fd, log(user("The brief."), assistant([use("head", "Read", { file_path: "h.txt" })])));
    const filler = `${line({ type: "attachment", attachment: { type: "x", pad: "y".repeat(1000) } })}\n`;
    const block = Buffer.from(filler.repeat(Math.ceil((1024 * 1024) / filler.length)));
    for (let i = 0; i < 34; i++) fs.writeSync(fd, block);
    fs.writeSync(fd, log(assistant([use("last", "Read", { file_path: "last.txt" })])));
    fs.closeSync(fd);
    const d = await readAgentLog(file);
    expect(d?.brief).toBe("The brief.");
    expect(d?.steps.at(-1)?.what).toBe("last.txt");
    expect(d?.steps.find((s) => s.id === "head")?.pending).toBe(false);
    expect(d?.steps.at(-1)?.pending).toBe(true);
  }, 30_000);
});

const run = (over: Partial<AgentRun>): AgentRun => ({ id: "a1", description: "Göcek research", type: "general-purpose", status: "running", line: null, steps: 0, startedAt: 0, endedAt: null, ...over });
const MIN = 60_000;

describe("what the bar says", () => {
  it("nothing to say: no bar", () => {
    expect(agentBarText([], {}, 0)).toBe(null);
    expect(agentBarText([run({ status: "finished", endedAt: 1 })], { "a1@0": true }, 0)).toBe(null);
    // The same agent run again later shows again.
    expect(agentBarText([run({ status: "finished", startedAt: 5, endedAt: 9 })], { "a1@0": true }, 10)?.line).toBe("Finished");
  });
  it("one running: its task, what it's doing, how long", () => {
    expect(agentBarText([run({ line: "Reading a web page" })], {}, 27 * MIN)).toEqual({ kind: "running", title: "Göcek research", line: "Reading a web page", time: "27 min" });
    expect(agentBarText([run({})], {}, 0)?.line).toBe("Starting");
  });
  it("several running: how many, which, and the longest time", () => {
    const list = [run({ id: "a", description: "Göcek research" }), run({ id: "b", description: "Bodrum research", startedAt: 20 * MIN })];
    expect(agentBarText(list, {}, 27 * MIN)).toEqual({ kind: "running", title: "2 agents running", line: "Göcek research and Bodrum research", time: "27 min" });
    expect(agentBarText([...list, run({ id: "c", description: "Third" })], {}, 27 * MIN)?.line).toBe("Göcek research, Bodrum research and 1 more");
  });
  it("running ones speak for the bar, even with an ended one not looked at", () => {
    expect(agentBarText([run({ id: "a", status: "finished", endedAt: 1 }), run({ id: "b", description: "Other" })], {}, MIN)?.title).toBe("Other");
  });
  it("one ended: how it went", () => {
    expect(agentBarText([run({ status: "finished", endedAt: 31 * MIN })], {}, 40 * MIN)).toEqual({ kind: "finished", title: "Göcek research", line: "Finished", time: "31 min" });
    expect(agentBarText([run({ status: "failed", line: "It hit the usage limit", endedAt: 12 * MIN })], {}, 40 * MIN)).toEqual({ kind: "stopped", title: "Göcek research", line: "Failed: It hit the usage limit", time: "12 min" });
    expect(agentBarText([run({ status: "stopped", endedAt: MIN })], {}, 40 * MIN)?.line).toBe("Stopped");
  });
  it("several ended", () => {
    const list = [run({ id: "a", status: "finished", endedAt: 1 }), run({ id: "b", description: "Other", status: "finished", endedAt: 1 })];
    expect(agentBarText(list, {}, MIN)).toEqual({ kind: "finished", title: "2 agents finished", line: "Göcek research and Other", time: "" });
    expect(agentBarText([list[0], { ...list[1], status: "failed" }], {}, MIN)).toMatchObject({ kind: "stopped", title: "2 agents ended, 1 didn't finish" });
    expect(agentBarText(list, { "a@0": true }, MIN)?.title).toBe("Other");
  });
  it("times", () => {
    expect(agentTime(0)).toBe("<1 min");
    expect(agentTime(59_999)).toBe("<1 min");
    expect(agentTime(MIN)).toBe("1 min");
    expect(agentTime(59 * MIN)).toBe("59 min");
    expect(agentTime(60 * MIN)).toBe("1 h");
    expect(agentTime(65 * MIN)).toBe("1 h 5 min");
  });
  it("the panel: running first, then the latest to end", () => {
    const list = [run({ id: "old", status: "finished", endedAt: 1 }), run({ id: "r1" }), run({ id: "new", status: "stopped", endedAt: 9 }), run({ id: "r2" })];
    expect(orderAgents(list).map((a) => a.id)).toEqual(["r1", "r2", "new", "old"]);
    expect(agentCounts(list)).toBe("2 running, 1 finished, 1 stopped");
    expect(agentCounts([run({})])).toBe("1 running");
  });
  it("the panel opens on what the bar is about", () => {
    const ended = run({ id: "e", status: "finished", endedAt: 5 });
    expect(agentToOpen([ended, run({ id: "r" })], {})).toBe("r");
    expect(agentToOpen([run({ id: "older", status: "finished", endedAt: 9 }), ended], { "older@0": true })).toBe("e");
    expect(agentToOpen([], {})).toBe(null);
  });
});
