// The chat manager's one-writer rules, with stand-in sessions (no Claude Code runs).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStatus } from "../src/shared/types";
import { ChatManager, NEW_CHAT_STARTING, OPEN_IN_TERMINAL, STILL_STARTING, STOPPED_BEFORE_START, type ManagerDeps, type SessionLike } from "../src/main/chat/manager";
import type { SessionOptions } from "../src/main/chat/session";

process.env.CONVERSATIONS_DATA_DIR = path.join(os.tmpdir(), `conversations-test-${process.pid}`);

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NEW_ID = "11111111-2222-4333-8444-555555555555";

class FakeSession extends EventEmitter implements SessionLike {
  id: string | null;
  cwd: string;
  status: ChatStatus;
  alive = true;
  busy = false;
  lastActivity = Date.now();
  lastWriteAt = 0;
  started: string[] = [];
  sent: string[] = [];
  agentsRunning = false;
  pastIds: string[] = [];
  stoppedAgents: string[] = [];
  handedBack: { text: string; overrides: boolean } | null = { text: "What it said when it ended", overrides: false };
  agentResult() {
    return this.handedBack;
  }
  async stopAgent(id: string) {
    this.stoppedAgents.push(id);
    return true;
  }
  constructor(o: SessionOptions) {
    super();
    this.id = o.resume ?? null;
    this.cwd = o.cwd;
    this.status = { conversationId: this.id ?? "", state: "starting", activity: null, model: null, permissionMode: o.permissionMode, contextPercent: null, queued: [], error: null, permission: null, streamingText: "", turnTokens: null };
  }
  start(first: string) {
    this.started.push(first);
    this.busy = true;
    if (!this.id)
      setTimeout(() => {
        this.id = NEW_ID;
        this.emit("created", NEW_ID);
      }, 5);
  }
  send(t: string) {
    this.sent.push(t);
  }
  pendingRequests() {
    return [];
  }
  respond() {
    return false;
  }
  async interrupt() {
    this.busy = false;
  }
  async setModel() {}
  async setPermissionMode() {}
  async models() {
    return [];
  }
  close() {
    this.alive = false;
    this.emit("ended");
  }
}

let managers: ChatManager[] = [];
afterEach(() => {
  for (const m of managers) m.closeAll();
  managers = [];
});

function setup(over: Partial<ManagerDeps> = {}) {
  const created: FakeSession[] = [];
  // One download that finishes when the test says so (it may be asked for later).
  let releasePull: () => void = () => {};
  const pull = new Promise<void>((r) => (releasePull = r));
  const deps: ManagerDeps = {
    claudePath: () => "claude.exe",
    machine: () => "Home PC",
    localTranscript: () => null,
    syncBeforeResume: () => pull,
    terminalHas: async () => false,
    createSession: (o) => {
      const s = new FakeSession(o);
      created.push(s);
      return s;
    },
    ...over,
  };
  const m = new ChatManager(deps);
  managers.push(m);
  const statuses: ChatStatus[] = [];
  const owned: string[] = [];
  m.on("status", (st: ChatStatus) => statuses.push(st));
  m.on("owned", (id: string) => owned.push(id));
  return { m, created, statuses, owned, release: () => releasePull() };
}

describe("one Claude Code per conversation", () => {
  it("refuses a second send while the first is still starting", async () => {
    const { m, created, statuses, release } = setup();
    const first = m.send({ id: ID, text: "one", cwd: "C:/p" });
    // The start is registered (and shown) before anything is awaited.
    expect(statuses.at(-1)?.state).toBe("starting");
    expect(m.status(ID)?.state).toBe("starting");
    expect(m.isRunning(ID)).toBe(true);
    expect(await m.send({ id: ID, text: "two", cwd: "C:/p" })).toEqual({ ok: false, err: STILL_STARTING });
    release();
    expect(await first).toEqual({ ok: true, conversationId: ID });
    expect(created.length).toBe(1);
    expect(created[0].started).toEqual(["one"]);
    // Once it runs, a follow-up goes to the same session.
    expect(await m.send({ id: ID, text: "three", cwd: "C:/p" })).toEqual({ ok: true, conversationId: ID });
    expect(created.length).toBe(1);
    expect(created[0].sent).toEqual(["three"]);
  });

  it("looks for a terminal again after the download, before Claude Code starts", async () => {
    let open = false;
    const { m, created, statuses, release } = setup({ terminalHas: async () => open });
    const first = m.send({ id: ID, text: "one", cwd: "C:/p" });
    open = true;
    release();
    expect(await first).toEqual({ ok: false, err: OPEN_IN_TERMINAL });
    expect(created.length).toBe(0);
    // The window gets its composer back.
    expect(statuses.at(-1)?.state).toBe("idle");
    expect(m.status(ID)).toBeNull();
    expect(m.isRunning(ID)).toBe(false);
  });

  it("checks for a terminal before every send to a running session", async () => {
    let open = false;
    const { m, created, release } = setup({ terminalHas: async () => open });
    const first = m.send({ id: ID, text: "one", cwd: "C:/p" });
    release();
    await first;
    open = true;
    expect(await m.send({ id: ID, text: "two", cwd: "C:/p" })).toEqual({ ok: false, err: OPEN_IN_TERMINAL });
    expect(created[0].sent).toEqual([]);
  });

  it("falls back to the transcript's age when Claude Code keeps no registry", async () => {
    const file = path.join(os.tmpdir(), `conversations-test-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    try {
      const { m } = setup({ terminalHas: async () => null, localTranscript: () => file });
      expect(await m.openInTerminal(ID)).toBe(true);
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(file, old, old);
      expect(await m.openInTerminal(ID)).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("marks every conversation it chats in as the app's, new or continued", async () => {
    const { m, owned, release } = setup();
    const resumed = m.send({ id: ID, text: "one", cwd: "C:/p" });
    release();
    await resumed;
    expect(await m.send({ id: null, text: "hello", cwd: "C:/p" })).toEqual({ ok: true, conversationId: NEW_ID });
    expect(owned).toEqual([ID, NEW_ID]);
    expect([...m.openIds()].sort()).toEqual([ID, NEW_ID].sort());
  });
});

describe("calling a start off", () => {
  it("N8: Stop while Claude Code is starting cancels it, and the message never runs", async () => {
    const { m, created, statuses, release } = setup();
    const send = m.send({ id: ID, text: "one", cwd: "C:/p" });
    const stopping = m.stop(ID);
    // Stop waits for the start to give up; the download finishes only now.
    release();
    await stopping;
    expect(await send).toEqual({ ok: false, err: STOPPED_BEFORE_START });
    expect(created.length).toBe(0);
    expect(m.isRunning(ID)).toBe(false);
    expect(statuses.at(-1)?.state).toBe("idle");
  });

  it("N2: release while starting returns only when no session exists or will", async () => {
    let finish: () => void = () => {};
    let downloading = false;
    const download = new Promise<void>((r) => (finish = r));
    const { m, created } = setup({
      syncBeforeResume: async () => {
        downloading = true;
        await download;
      },
    });
    const send = m.send({ id: ID, text: "one", cwd: "C:/p" });
    // The start is in the middle of its download when the conversation is handed over.
    while (!downloading) await new Promise((r) => setTimeout(r, 1));
    let released = false;
    const releasing = m.release(ID).then(() => (released = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(false);
    finish();
    await releasing;
    expect(m.isOpenInApp(ID)).toBe(false);
    expect(await send).toEqual({ ok: false, err: STOPPED_BEFORE_START });
    expect(created.length).toBe(0);
  });

  it("a Stop after Claude Code started interrupts it as before", async () => {
    const { m, created, release } = setup();
    const send = m.send({ id: ID, text: "one", cwd: "C:/p" });
    release();
    await send;
    await m.stop(ID);
    expect(created[0].busy).toBe(false);
    expect(created[0].alive).toBe(true);
  });
});

describe("N3: where a resumed chat runs", () => {
  it("starts Claude Code in the folder the preparation found, and owns it there", async () => {
    const { m, created, owned } = setup({ syncBeforeResume: async () => ({ cwd: "C:/clone" }) });
    expect(await m.send({ id: ID, text: "one", cwd: "C:/project" })).toEqual({ ok: true, conversationId: ID });
    expect(created[0].cwd).toBe("C:/clone");
    expect(owned).toEqual([ID]);
  });

  it("doesn't start when the preparation says it can't", async () => {
    const { m, created } = setup({ syncBeforeResume: async () => ({ refuse: "It's open in Claude Code on this PC — switch to that window." }) });
    expect(await m.send({ id: ID, text: "one", cwd: "C:/project" })).toEqual({ ok: false, err: "It's open in Claude Code on this PC — switch to that window." });
    expect(created.length).toBe(0);
  });
});

describe("N16: closing a chat lets sync catch it up", () => {
  it("says so when a session is released, ends, or a start is called off", async () => {
    const { m, release } = setup();
    const closed: string[] = [];
    m.on("closed", (id: string) => closed.push(id));
    const send = m.send({ id: ID, text: "one", cwd: "C:/p" });
    release();
    await send;
    await m.release(ID);
    expect(closed).toEqual([ID]);
    // A start called off counts too: sync skipped it while it was starting.
    const again = m.send({ id: ID, text: "two", cwd: "C:/p" });
    await m.stop(ID);
    await again;
    expect(closed).toEqual([ID, ID]);
    expect(m.lastAppWriteAt(ID)).toBeGreaterThan(0);
  });
});

describe("item 7: a new chat is tracked from the first moment", () => {
  it("is seen by the skip list, approvals, stop and quit before Claude Code has named it, and a second send in the folder waits", async () => {
    const { m, created } = setup();
    const first = m.send({ id: null, text: "hello", cwd: "C:/p" });
    // Before "created" arrives, the draft is known everywhere that matters.
    expect(m.openIds().size).toBe(1);
    const [draftId] = [...m.openIds()];
    expect(draftId.startsWith("draft:")).toBe(true);
    expect(m.isRunning(draftId)).toBe(true);
    expect(m.draftsIn("C:/p")).toEqual([draftId]);
    expect(await m.send({ id: null, text: "again", cwd: "C:/p" })).toEqual({ ok: false, err: NEW_CHAT_STARTING });
    expect(created.length).toBe(1);
    // Another folder is fine.
    expect(m.draftsIn("C:/other")).toEqual([]);
    expect(await first).toEqual({ ok: true, conversationId: NEW_ID });
    expect(m.openIds().has(NEW_ID)).toBe(true);
    expect(m.openIds().has(draftId)).toBe(false);
  });

  it("is closed by Stop and by quit while it still has no id", async () => {
    const { m, created } = setup();
    const p1 = m.send({ id: null, text: "hello", cwd: "C:/a" });
    const [d1] = [...m.openIds()];
    await m.stop(d1);
    expect(created[0].alive).toBe(false);
    expect((await p1).ok).toBe(false);
    const p2 = m.send({ id: null, text: "hello", cwd: "C:/b" });
    expect(m.openIds().size).toBe(1);
    m.closeAll();
    expect(created[1].alive).toBe(false);
    expect((await p2).ok).toBe(false);
  });
});

describe("a chat whose agents are still at work", () => {
  async function running(over: Partial<ManagerDeps> = {}) {
    const t = setup(over);
    const sent = t.m.send({ id: ID, text: "go", cwd: "C:/p" });
    t.release();
    await sent;
    const s = t.created[0];
    s.busy = false;
    s.agentsRunning = true;
    return { ...t, s };
  }
  it("isn't closed as idle, however long they take; once they're done it is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const { s } = await running();
      vi.advanceTimersByTime(60 * 60_000);
      expect(s.alive).toBe(true);
      s.agentsRunning = false;
      vi.advanceTimersByTime(20 * 60_000);
      expect(s.alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("isn't closed by a sign-in restarting idle chats", async () => {
    const { m, s } = await running();
    await m.releaseIdle();
    expect(s.alive).toBe(true);
    s.agentsRunning = false;
    await m.releaseIdle();
    expect(s.alive).toBe(false);
  });
  it("Stop on one agent goes to that chat's session", async () => {
    const { m, s } = await running();
    expect(await m.stopAgent(ID, "a1")).toBe(true);
    expect(s.stoppedAgents).toEqual(["a1"]);
    expect(await m.stopAgent("bbbbbbbb-1111-4111-8111-aaaaaaaaaaaa", "a1")).toBe(false);
  });
  it("an agent's details: from its log, beside where the index says the chat is", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-agents-"));
    try {
      const transcript = path.join(dir, `${ID}.jsonl`);
      fs.mkdirSync(path.join(dir, ID, "subagents"), { recursive: true });
      fs.writeFileSync(path.join(dir, ID, "subagents", "agent-a1.jsonl"), `${JSON.stringify({ type: "user", message: { content: "The brief" } })}\n`);
      const { m } = await running({ localTranscript: () => transcript });
      // No report in its log: what it said when it ended stands in.
      expect(await m.agentDetail(ID, "a1")).toEqual({ brief: "The brief", steps: [], total: 0, report: "What it said when it ended" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a report Claude Code warned about or held back: its word, not the log's", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-agents-"));
    try {
      fs.mkdirSync(path.join(dir, ID, "subagents"), { recursive: true });
      fs.writeFileSync(path.join(dir, ID, "subagents", "agent-a1.jsonl"), [{ type: "user", message: { content: "Go" } }, { type: "assistant", message: { content: [{ type: "tool_use", id: "h", name: "SubagentHandback", input: { message: "Unchecked report" } }] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      const { m, s } = await running({ localTranscript: (x) => path.join(dir, `${x}.jsonl`) });
      s.handedBack = null;
      expect((await m.agentDetail(ID, "a1"))?.report).toBe("Unchecked report");
      s.handedBack = { text: "SECURITY WARNING\n\nChecked report", overrides: true };
      expect((await m.agentDetail(ID, "a1"))?.report).toBe("SECURITY WARNING\n\nChecked report");
      s.handedBack = { text: "Summary", overrides: false };
      expect((await m.agentDetail(ID, "a1"))?.report).toBe("Unchecked report");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("after the session has closed, what Claude Code said of a report still counts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-agents-"));
    try {
      fs.mkdirSync(path.join(dir, ID, "subagents"), { recursive: true });
      fs.writeFileSync(path.join(dir, ID, "subagents", "agent-a1.jsonl"), [{ type: "user", message: { content: "Go" } }, { type: "assistant", message: { content: [{ type: "tool_use", id: "h", name: "SubagentHandback", input: { message: "Unchecked report" } }] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      const { m, s } = await running({ localTranscript: (x) => path.join(dir, `${x}.jsonl`) });
      s.handedBack = { text: "Held back", overrides: true };
      s.close();
      expect((await m.agentDetail(ID, "a1"))?.report).toBe("Held back");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("after /clear, a running agent's log in two parts: read as one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-agents-"));
    const OLD = "dddddddd-1111-4111-8111-aaaaaaaaaaaa";
    try {
      for (const [x, e] of [[OLD, { type: "user", message: { content: "The brief" } }], [ID, { type: "assistant", message: { content: [{ type: "tool_use", id: "2", name: "Read", input: { file_path: "b.txt" } }] } }]] as const) {
        fs.mkdirSync(path.join(dir, x, "subagents"), { recursive: true });
        fs.writeFileSync(path.join(dir, x, "subagents", "agent-a1.jsonl"), `${JSON.stringify(e)}\n`);
      }
      const { m, s } = await running({ localTranscript: (x) => path.join(dir, `${x}.jsonl`) });
      s.pastIds.push(OLD);
      expect(await m.agentDetail(ID, "a1")).toMatchObject({ brief: "The brief", total: 1, steps: [{ id: "2" }] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("after /clear: an agent's log is found under the conversation it started in", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-agents-"));
    const OLD = "cccccccc-1111-4111-8111-aaaaaaaaaaaa";
    try {
      fs.mkdirSync(path.join(dir, OLD, "subagents"), { recursive: true });
      fs.writeFileSync(path.join(dir, OLD, "subagents", "agent-a1.jsonl"), `${JSON.stringify({ type: "user", message: { content: "Started before /clear" } })}\n`);
      const { m, s } = await running({ localTranscript: (x) => path.join(dir, `${x}.jsonl`) });
      s.pastIds.push(OLD);
      expect((await m.agentDetail(ID, "a1"))?.brief).toBe("Started before /clear");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("agents that have said nothing for two hours are taken to be stuck: the session closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const { s } = await running();
      vi.advanceTimersByTime(110 * 60_000);
      expect(s.alive).toBe(true);
      vi.advanceTimersByTime(15 * 60_000);
      expect(s.alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a chat with agents at work counts as working, for switching, updating, deleting and Open in CLI", async () => {
    const { m, s } = await running();
    expect(m.isRunning(ID)).toBe(false);
    expect(m.agentsRunning(ID)).toBe(true);
    expect([...m.workingIds()]).toEqual([ID]);
    s.agentsRunning = false;
    expect([...m.workingIds()]).toEqual([]);
  });
  it("no log yet: what it said, if anything; a chat with no session and no log: nothing", async () => {
    const { m } = await running();
    expect(await m.agentDetail(ID, "nope")).toEqual({ brief: null, steps: [], total: 0, report: "What it said when it ended" });
    expect(await m.agentDetail("bbbbbbbb-1111-4111-8111-aaaaaaaaaaaa", "a1")).toBe(null);
  });
});
