// "!" commands in the composer: running them, recording them the way the CLI's bash
// mode does, showing them in the transcript, and the session and manager rules.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStatus } from "../src/shared/types";

process.env.CONVERSATIONS_DATA_DIR = path.join(os.tmpdir(), `conversations-test-${process.pid}`);

import { bashRecord, parseTranscript } from "../src/main/index/parse";
import { MAX_OUTPUT, OutputKeeper, clipOutput, findShell, runShell, shellMessages, type RunningShell, type ShellResult } from "../src/main/chat/shell";
import { ChatSession, type SessionOptions } from "../src/main/chat/session";
import { ChatManager, NEW_CHAT_STARTING, OPEN_IN_TERMINAL, SHELL_BUSY, SHELL_RUNNING, SHELL_WHILE_WORKING, type ManagerDeps, type SessionLike } from "../src/main/chat/manager";

const CWD = "C:\\Users\\alex\\Projects\\website";
const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const NEW_ID = "11111111-2222-4333-8444-555555555555";

// ------------------------------------------------------------------ records

describe("the record a command leaves", () => {
  it("is the CLI's: the command, then what it printed, with & < > escaped", () => {
    const [input, output] = shellMessages(`echo "a<b" && ls`, { stdout: "x & y\n", stderr: "warn > here\n", code: 0, stopped: null });
    expect(input).toBe("<bash-input>echo \"a&lt;b\" &amp;&amp; ls</bash-input>");
    expect(output).toBe("<bash-stdout>x &amp; y\n</bash-stdout><bash-stderr>warn &gt; here\n</bash-stderr>");
    expect(bashRecord(input)).toEqual({ command: `echo "a<b" && ls` });
    expect(bashRecord(output)).toEqual({ stdout: "x & y\n", stderr: "warn > here\n" });
  });

  it("says when it was stopped, and keeps the start and end of very long output", () => {
    const [, out] = shellMessages("sleep 99", { stdout: "", stderr: "", code: null, stopped: "you" });
    expect(out).toContain("Stopped in the Conversations app.");
    const long = `${"a".repeat(MAX_OUTPUT)}MIDDLE${"z".repeat(MAX_OUTPUT)}`;
    const kept = clipOutput(long);
    expect(kept.length).toBeLessThan(MAX_OUTPUT + 100);
    expect(kept.startsWith("aaa")).toBe(true);
    expect(kept.endsWith("zzz")).toBe(true);
    expect(kept).not.toContain("MIDDLE");
    expect(kept).toContain("characters not kept");
  });

  it("reads the CLI's own records, but not text that merely mentions a tag", () => {
    expect(bashRecord("<bash-input> gcloud auth login</bash-input>")).toEqual({ command: "gcloud auth login" });
    expect(bashRecord("<bash-stdout></bash-stdout><bash-stderr>/usr/bin/bash: line 2: gcloud: command not found\n</bash-stderr>")).toEqual({ stdout: "", stderr: "/usr/bin/bash: line 2: gcloud: command not found\n" });
    expect(bashRecord("What does <bash-input> mean?")).toBeNull();
  });
});

// ------------------------------------------------------------------ transcript

const ctx = { sourcePath: "C:/t.jsonl", machineForCwd: (cwd: string | null | undefined) => (cwd?.includes("alex") ? "Uni PC" : cwd ? "Home PC" : null) };
let n = 0;
const ts = (min: number) => new Date(Date.UTC(2026, 9, 13, 10, min)).toISOString();
const line = (parent: string | null, type: string, content: unknown, min: number, extra: object = {}) => {
  const uuid = `s-${++n}`;
  return { uuid, line: { type, uuid, parentUuid: parent, isSidechain: false, message: type === "assistant" ? { role: "assistant", model: "claude-opus-5-5", content } : { role: "user", content }, timestamp: ts(min), cwd: CWD, ...extra } };
};
const jsonl = (lines: object[]) => Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

describe("in the transcript", () => {
  it("shows a command and its output as one item, counted as something you typed", () => {
    const u = line(null, "user", "Check the ads login", 0);
    const a = line(u.uuid, "assistant", [{ type: "text", text: "Run the login first." }], 1);
    const [cmd, out] = shellMessages("gcloud auth application-default login", { stdout: "Your browser has been opened to visit:\r\n\r\n    https://accounts.google.com/o/oauth2/auth?a=1&b=2\r\n", stderr: "", code: 0, stopped: null });
    const b1 = line(a.uuid, "user", cmd, 2, { entrypoint: "cli" });
    const b2 = line(b1.uuid, "user", out, 2, { entrypoint: "cli" });
    const a2 = line(b2.uuid, "assistant", [{ type: "text", text: "The Ads login worked." }], 3, { entrypoint: "cli" });
    const r = parseTranscript(jsonl([u.line, a.line, b1.line, b2.line, a2.line]), ctx);
    const shells = r.items.filter((i) => i.kind === "shell");
    expect(shells).toHaveLength(1);
    expect(shells[0]).toMatchObject({ command: "gcloud auth application-default login", stderr: "", pc: "Uni PC" });
    expect((shells[0] as { stdout: string }).stdout).toContain("?a=1&b=2");
    // Your prompt, Claude's reply, the command, Claude's next reply: in that order.
    expect(r.items.filter((i) => i.kind !== "meta" && i.kind !== "day").map((i) => i.kind)).toEqual(["user", "text", "shell", "text"]);
    // A "!" line is shown and is the list's last line, but it is not a prompt.
    expect(r.info.prompts).toBe(1);
    expect(r.info.lastPrompt).toBe("! gcloud auth application-default login");
    expect(r.info.title).toBe("Check the ads login");
  });

  it("a chat of only commands has no prompts (the index keeps it only when the app started it), titled by its first command", () => {
    const [cmd, out] = shellMessages("ls", { stdout: "a.txt\n", stderr: "", code: 0, stopped: null });
    const b1 = line(null, "user", cmd, 0);
    const b2 = line(b1.uuid, "user", out, 0);
    const r = parseTranscript(jsonl([b1.line, b2.line]), ctx);
    expect(r.info.prompts).toBe(0);
    expect(r.info.title).toBe("! ls");
    expect(r.items.find((i) => i.kind === "shell")).toMatchObject({ command: "ls", stdout: "a.txt\n" });
  });

  it("leaves a command without its output yet as running (no output block)", () => {
    const [cmd] = shellMessages("sleep 5", { stdout: "", stderr: "", code: 0, stopped: null });
    const r = parseTranscript(jsonl([line(null, "user", cmd, 0).line]), ctx);
    expect(r.items.find((i) => i.kind === "shell")).toMatchObject({ command: "sleep 5", stdout: null, stderr: null });
  });
});

// ------------------------------------------------------------------ running

describe("running a command", () => {
  const shell = findShell();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-test-"));

  it("finds Git Bash on Windows, as Claude Code does", () => {
    if (process.platform !== "win32") return;
    expect(shell?.name).toBe("bash");
    expect(shell?.file.toLowerCase()).toMatch(/git[\\/]+bin[\\/]+bash\.exe$/);
    const fake = findShell({ PATH: "", ProgramFiles: "Z:\\none", SystemRoot: process.env.SystemRoot }, "win32");
    expect(fake?.name).toBe("powershell");
  });

  it("runs in the chat's folder and collects both streams and the exit code", async () => {
    const r = await runShell(`echo "out $(basename "$PWD")"; echo oops >&2; exit 3`, dir).done;
    expect(r.stdout.trim()).toBe(`out ${path.basename(dir)}`);
    expect(r.stderr.trim()).toBe("oops");
    expect(r.code).toBe(3);
    expect(r.stopped).toBeNull();
  });

  it("passes quotes through untouched", async () => {
    const r = await runShell(`printf '%s|' "two words" 'single "inner"' --flag="C:/a b/c.json"`, dir).done;
    expect(r.stdout).toBe(`two words|single "inner"|--flag=C:/a b/c.json|`);
  });

  it("stops at once when you press Stop, keeping what it printed", async () => {
    const run = runShell("echo started; sleep 30; echo never", dir);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    run.stop();
    const r = await run.done;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.stopped).toBe("you");
    expect(r.stdout).toContain("started");
    expect(r.stdout).not.toContain("never");
  }, 20_000);

  it("stops at the time limit", async () => {
    const r = await runShell("sleep 30", dir, { timeoutMs: 1200 }).done;
    expect(r.stopped).toBe("timeout");
  }, 20_000);
});

// ------------------------------------------------------------------ session

function session() {
  const s = new ChatSession({ cwd: CWD, claudePath: "claude.exe", machine: "Uni PC", permissionMode: "default" });
  const x = s as unknown as { q: unknown; input: { items: { message: { content: unknown }; shouldQuery?: boolean }[] }; set(p: Partial<ChatStatus>): void; handle(m: unknown): void };
  x.q = { interrupt: vi.fn(async () => {}), getContextUsage: vi.fn(async () => undefined) };
  x.set({ state: "idle" });
  return { s, x };
}
const record: [string, string] = ["<bash-input>ls</bash-input>", "<bash-stdout>a\n</bash-stdout><bash-stderr></bash-stderr>"];

describe("a session taking a command's record", () => {
  it("writes it without starting a turn", () => {
    const { s, x } = session();
    s.appendShell(record, "! ls");
    expect(x.input.items.map((i) => [i.message.content, i.shouldQuery])).toEqual([
      [record[0], false],
      [record[1], false],
    ]);
    expect(s.status.state).toBe("idle");
    // Each record reports a result of its own: no turn ran, so nothing ends and nothing moves on.
    x.handle({ type: "result", subtype: "success", num_turns: 0 });
    x.handle({ type: "result", subtype: "success", num_turns: 0 });
    expect(s.status.state).toBe("idle");
  });

  it("waits behind a turn in progress, in the order you typed, and then the next message goes", () => {
    const { s, x } = session();
    s.send("first");
    s.appendShell(record, "! ls");
    s.send("after the command");
    expect(s.status.queued).toEqual(["! ls", "after the command"]);
    expect(x.input.items).toHaveLength(1);
    x.handle({ type: "result", subtype: "success", num_turns: 2 });
    // The record and the next message go in together; the turn that starts is the message's.
    expect(x.input.items.map((i) => i.message.content)).toEqual(["first", record[0], record[1], "after the command"]);
    expect(s.status.state).toBe("thinking");
    // The records' own results do not end the message's turn.
    x.handle({ type: "result", subtype: "success", num_turns: 0 });
    x.handle({ type: "result", subtype: "success", num_turns: 0 });
    expect(s.status.state).toBe("thinking");
    x.handle({ type: "result", subtype: "success", num_turns: 1 });
    expect(s.status.state).toBe("idle");
  });
});

// ------------------------------------------------------------------ manager

class FakeSession extends EventEmitter implements SessionLike {
  id: string | null;
  cwd: string;
  status: ChatStatus;
  alive = true;
  busy = false;
  lastActivity = Date.now();
  lastWriteAt = 0;
  started: string[] = [];
  shells: [string, string][] = [];
  sent: string[] = [];
  constructor(o: SessionOptions) {
    super();
    this.id = o.resume ?? null;
    this.cwd = o.cwd;
    this.status = { conversationId: this.id ?? "", state: "idle", activity: null, model: null, permissionMode: o.permissionMode, contextPercent: null, queued: [], error: null, permission: null, streamingText: "", turnTokens: null };
  }
  start(first: string) {
    this.started.push(first);
  }
  startShell(r: [string, string]) {
    this.shells.push(r);
    if (!this.id)
      setTimeout(() => {
        this.id = NEW_ID;
        this.emit("created", NEW_ID);
      }, 5);
  }
  appendShell(r: [string, string]) {
    this.shells.push(r);
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
  async interrupt() {}
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

/** A command that finishes when the test says so. */
function fakeRun(result: Partial<ShellResult> = {}) {
  let finish: (r: ShellResult) => void = () => {};
  const done = new Promise<ShellResult>((r) => (finish = r));
  const stop = vi.fn(() => finish({ stdout: "partial", stderr: "", code: null, stopped: "you" }));
  const run: RunningShell = { done, stop };
  return { run, stop, finish: () => finish({ stdout: "ok\n", stderr: "", code: 0, stopped: null, ...result }) };
}

let managers: ChatManager[] = [];
afterEach(() => {
  for (const m of managers) m.closeAll();
  managers = [];
});

function setup(over: Partial<ManagerDeps> = {}) {
  const created: FakeSession[] = [];
  const runs: { command: string; cwd: string; finish: () => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const deps: ManagerDeps = {
    claudePath: () => "claude.exe",
    machine: () => "Uni PC",
    localTranscript: () => null,
    syncBeforeResume: async () => {},
    terminalHas: async () => false,
    createSession: (o) => {
      const s = new FakeSession(o);
      created.push(s);
      return s;
    },
    runShell: (command, cwd) => {
      const f = fakeRun();
      runs.push({ command, cwd, finish: f.finish, stop: f.stop });
      return f.run;
    },
    ...over,
  };
  const m = new ChatManager(deps);
  managers.push(m);
  const statuses: ChatStatus[] = [];
  m.on("status", (st: ChatStatus) => statuses.push(st));
  return { m, created, runs, statuses };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("the manager running a command", () => {
  it("shows it running, then starts Claude Code with the record and no turn", async () => {
    const { m, created, runs, statuses } = setup();
    const p = m.shell({ id: ID, text: "", command: "gcloud auth login", cwd: CWD });
    await tick();
    expect(runs.map((r) => [r.command, r.cwd])).toEqual([["gcloud auth login", CWD]]);
    expect(m.status(ID)).toMatchObject({ state: "running-tool", activity: "Running ! gcloud auth login" });
    expect(m.isRunning(ID)).toBe(true);
    runs[0].finish();
    expect(await p).toEqual({ ok: true, conversationId: ID });
    expect(created).toHaveLength(1);
    expect(created[0].started).toEqual([]);
    expect(created[0].shells).toEqual([["<bash-input>gcloud auth login</bash-input>", "<bash-stdout>ok\n</bash-stdout><bash-stderr></bash-stderr>"]]);
    expect(statuses.some((s) => s.state === "running-tool")).toBe(true);
  });

  it("adds it to a session that is already open, in that session's folder", async () => {
    const { m, created, runs } = setup();
    await m.send({ id: ID, text: "hello", cwd: CWD });
    const p = m.shell({ id: ID, text: "", command: "ls", cwd: "C:/elsewhere" });
    await tick();
    expect(runs[0].cwd).toBe(CWD);
    runs[0].finish();
    expect(await p).toEqual({ ok: true, conversationId: ID });
    expect(created).toHaveLength(1);
    expect(created[0].shells).toHaveLength(1);
  });

  it("runs one command at a time per chat, and Stop ends it with what it printed", async () => {
    const { m, created, runs } = setup();
    const p = m.shell({ id: ID, text: "", command: "sleep 30", cwd: CWD });
    await tick();
    expect(await m.shell({ id: ID, text: "", command: "ls", cwd: CWD })).toEqual({ ok: false, err: SHELL_BUSY });
    await m.stop(ID);
    expect(runs[0].stop).toHaveBeenCalled();
    expect(await p).toMatchObject({ ok: true });
    expect(created[0].shells[0][1]).toContain("partial");
    expect(created[0].shells[0][1]).toContain("Stopped in the Conversations app.");
  });

  it("never writes a chat a terminal on this PC has open", async () => {
    const { m, runs } = setup({ terminalHas: async () => true });
    expect(await m.shell({ id: ID, text: "", command: "ls", cwd: CWD })).toEqual({ ok: false, err: OPEN_IN_TERMINAL });
    expect(runs).toHaveLength(0);
  });

  it("starts a new chat with the record when there is no conversation yet", async () => {
    const { m, created, runs } = setup();
    const p = m.shell({ id: null, text: "", command: "pwd", cwd: CWD, draftKey: CWD });
    await tick();
    runs[0].finish();
    expect(await p).toEqual({ ok: true, conversationId: NEW_ID });
    expect(created[0].shells).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ review findings

describe("a command's record is never lost or offered again", () => {
  it("refuses a message sent while a command runs in that chat (it stays in your box)", async () => {
    const { m, runs } = setup();
    const p = m.shell({ id: ID, text: "", command: "npm test", cwd: CWD });
    await tick();
    expect(await m.send({ id: ID, text: "hello", cwd: CWD })).toEqual({ ok: false, err: SHELL_RUNNING });
    runs[0].finish();
    expect(await p).toMatchObject({ ok: true });
  });

  it("refuses a command while Claude is working in that chat, so Stop always means one thing", async () => {
    const { m, created, runs } = setup();
    await m.send({ id: ID, text: "hello", cwd: CWD });
    created[0].busy = true;
    expect(await m.shell({ id: ID, text: "", command: "ls", cwd: CWD })).toEqual({ ok: false, err: SHELL_WHILE_WORKING });
    expect(runs).toHaveLength(0);
  });

  it("says the command ran when its record can't be written afterwards", async () => {
    let terminal = false;
    const { m, runs } = setup({ terminalHas: async () => terminal });
    const p = m.shell({ id: ID, text: "", command: "git commit -m x", cwd: CWD });
    await tick();
    terminal = true; // a terminal took the conversation while it ran
    runs[0].finish();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.ran).toBe(true);
    expect(r.err).toMatch(/^The command ran, but/);
  });

  it("Open in CLI during a run stops the command and writes nothing", async () => {
    const { m, created, runs } = setup();
    const p = m.shell({ id: ID, text: "", command: "sleep 30", cwd: CWD });
    await tick();
    await m.release(ID);
    expect(runs[0].stop).toHaveBeenCalled();
    const r = await p;
    expect(r).toMatchObject({ ok: false, ran: true });
    expect(r.err).toContain("opened in a terminal");
    expect(created).toHaveLength(0);
  });

  it("counts as running until its record is written, so a message can't slip in ahead of it", async () => {
    let calls = 0;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => (openGate = r));
    const { m, created, runs } = setup({
      terminalHas: async () => {
        // The second look (just before the record is written) takes a while.
        if (++calls === 2) await gate;
        return false;
      },
    });
    const p = m.shell({ id: ID, text: "", command: "npm test", cwd: CWD });
    await tick();
    runs[0].finish();
    await tick();
    expect(m.status(ID)).toMatchObject({ state: "running-tool", activity: "Adding the output to the conversation" });
    expect(await m.send({ id: ID, text: "what failed?", cwd: CWD })).toEqual({ ok: false, err: SHELL_RUNNING });
    openGate();
    expect(await p).toEqual({ ok: true, conversationId: ID });
    expect(created).toHaveLength(1);
    expect(created[0].shells).toHaveLength(1);
    expect(m.isRunning(ID)).toBe(false);
  });

  it("a command in a new chat can be stopped by its composer key, and blocks a second new chat there", async () => {
    const { m, runs } = setup();
    const p = m.shell({ id: null, text: "", command: "npm run dev", cwd: CWD, draftKey: `new:${CWD}` });
    await tick();
    expect(await m.send({ id: null, text: "hi", cwd: CWD })).toEqual({ ok: false, err: NEW_CHAT_STARTING });
    expect(await m.shell({ id: null, text: "", command: "ls", cwd: CWD, draftKey: `new:${CWD}` })).toEqual({ ok: false, err: SHELL_BUSY });
    m.stopDraftShell(`NEW:${CWD.toUpperCase()}`);
    expect(runs[0].stop).toHaveBeenCalled();
    expect(await p).toMatchObject({ ok: true, conversationId: NEW_ID });
  });
});

describe("the session keeps records through Stop and merged turns", () => {
  it("Stop drops queued messages but writes a queued command's record once the stopped turn has ended", async () => {
    const { s, x } = session();
    s.send("first");
    s.appendShell(record, "! ls");
    s.send("second");
    await s.interrupt();
    // Never in the middle of the turn being stopped.
    expect(x.input.items.map((i) => i.message.content)).toEqual(["first"]);
    expect(s.status.queued).toEqual(["! ls"]);
    x.handle({ type: "result", subtype: "error_during_execution", num_turns: 1 });
    expect(x.input.items.map((i) => i.message.content)).toEqual(["first", record[0], record[1]]);
    expect(s.status.queued).toEqual([]);
  });

  it("a stopped turn that reports its end late does not wipe records written after it", async () => {
    const { s, x } = session();
    const xs = x as unknown as { quietResults: number };
    s.send("first");
    s.appendShell(record, "! ls");
    await s.interrupt();
    // The stopped turn has not reported yet; closing (Open in CLI) writes the record now.
    void s.settle(10);
    expect(x.input.items.map((i) => i.message.content)).toEqual(["first", record[0], record[1]]);
    expect(xs.quietResults).toBe(2);
    x.handle({ type: "result", subtype: "success", num_turns: 1 });
    expect(xs.quietResults).toBe(2);
    x.handle({ type: "result", subtype: "success", num_turns: 0 });
    x.handle({ type: "result", subtype: "success", num_turns: 0 });
    expect(xs.quietResults).toBe(0);
    expect(s.status.state).toBe("idle");
  });

  it("a real turn clears the count of records merged into it, so a later local command still ends", () => {
    const { s, x } = session();
    const xs = x as unknown as { quietResults: number };
    s.appendShell(record, "! ls");
    s.send("question");
    // Merged: only the message's turn reports a result.
    x.handle({ type: "result", subtype: "success", num_turns: 1 });
    expect(xs.quietResults).toBe(0);
    expect(s.status.state).toBe("idle");
    s.send("/cost");
    expect(s.status.state).toBe("thinking");
    x.handle({ type: "result", subtype: "success", num_turns: 0 });
    expect(s.status.state).toBe("idle");
  });
});

describe("output and process handling", () => {
  it("counts what was left out exactly, however the output arrived", () => {
    const k = new OutputKeeper();
    for (let i = 0; i < 1000; i++) k.add(`${String(i).padStart(4, "0")}${"x".repeat(96)}`);
    const text = k.text();
    const kept = /… (\d+) characters not kept …/.exec(text);
    expect(kept).not.toBeNull();
    expect(text.startsWith("0000")).toBe(true);
    expect(text.endsWith("x".repeat(96))).toBe(true);
    expect(Number(kept![1]) + text.length - kept![0].length - 4).toBe(100_000);
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT);
    // Nothing left out: nothing said.
    const small = new OutputKeeper();
    small.add("short");
    expect(small.text()).toBe("short");
  });

  it("is done when the shell exits, even if something it started keeps running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-bg-"));
    const t0 = Date.now();
    const r = await runShell("sleep 20 & echo bg-started", dir).done;
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.stdout).toContain("bg-started");
  }, 30_000);

  it("Stop returns at once (the app's main process never waits on it)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-stop-"));
    const run = runShell("echo up; sleep 30", dir);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = performance.now();
    run.stop();
    expect(performance.now() - t0).toBeLessThan(50);
    expect((await run.done).stopped).toBe("you");
  }, 20_000);
});
