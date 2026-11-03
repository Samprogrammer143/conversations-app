// A ChatSession without Claude Code behind it: the parts the app decides itself.
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStatus } from "../src/shared/types";
import { ChatSession } from "../src/main/chat/session";

process.env.CONVERSATIONS_DATA_DIR = path.join(os.tmpdir(), `conversations-test-${process.pid}`);

const CWD = "C:\\Users\\alex\\Projects\\chat-e2e";

function session() {
  const s = new ChatSession({ cwd: CWD, claudePath: "claude.exe", machine: "Home PC", permissionMode: "default" });
  const fake = { interrupt: vi.fn(async () => {}), getContextUsage: vi.fn(async () => undefined) };
  const x = s as unknown as { q: unknown; input: { items: unknown[] }; set(p: Partial<ChatStatus>): void; handle(m: unknown): void; askPermission(t: string, i: Record<string, unknown>, o: unknown): Promise<{ behavior: string; updatedPermissions?: unknown }> };
  x.q = fake;
  x.set({ state: "idle" });
  return { s, x, fake };
}

const option = (id: string, extra: object = {}) => ({ toolUseID: id, signal: new AbortController().signal, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "localSettings" }], ...extra });

afterEach(() => vi.useRealTimers());

describe("follow-ups", () => {
  it("wait in the app until the turn ends, then go one at a time", () => {
    const { s, x } = session();
    s.send("first");
    expect(x.input.items.length).toBe(1);
    expect(s.status.state).toBe("thinking");
    s.send("second");
    s.send("third");
    expect(x.input.items.length).toBe(1);
    expect(s.status.queued).toEqual(["second", "third"]);
    x.handle({ type: "user", message: { role: "user", content: [] }, parent_tool_use_id: null });
    expect(s.status.queued).toEqual(["second", "third"]);
    x.handle({ type: "result", subtype: "success" });
    expect(x.input.items.length).toBe(2);
    expect(s.status.queued).toEqual(["third"]);
    expect(s.status.state).toBe("thinking");
  });

  it("are called off by Stop, never reach Claude Code, and go back to the message box", async () => {
    const { s, x, fake } = session();
    const back: unknown[] = [];
    s.on("returned", (r) => back.push(...r));
    s.send("first");
    s.send("second");
    await s.interrupt();
    expect(fake.interrupt).toHaveBeenCalled();
    expect(s.status.queued).toEqual([]);
    expect(back).toEqual([{ text: "second", attachments: [] }]);
    x.handle({ type: "result", subtype: "success" });
    expect(x.input.items.length).toBe(1);
  });
});

describe("streamed text", () => {
  it("reaches the window at most 20 times a second", () => {
    vi.useFakeTimers();
    const { s, x } = session();
    const seen: string[] = [];
    s.on("status", (st: ChatStatus) => seen.push(st.streamingText));
    const before = seen.length;
    for (let i = 0; i < 30; i++) x.handle({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } } });
    expect(seen.length).toBe(before);
    vi.advanceTimersByTime(60);
    expect(seen.length).toBe(before + 1);
    expect(s.status.streamingText).toBe("a".repeat(30));
    x.handle({ type: "assistant", message: { content: [] } });
    expect(s.status.streamingText).toBe("");
  });
});

describe("approvals", () => {
  it("never take \"Always allow\" for a destructive request", async () => {
    const { s, x } = session();
    const answer = x.askPermission("PowerShell", { command: "Remove-Item -Force hello.txt" }, option("toolu_del"));
    const req = s.pendingRequests()[0];
    expect(req.destructive).toBe(true);
    expect(req.allowAlways).toBe(false);
    expect(req.title).toBe("Allow a command that permanently deletes files?");
    expect(req.consequence).toBe("Deletes hello.txt. It can't be undone.");
    expect(s.respond("toolu_del", "allow-always")).toBe(true);
    expect((await answer).behavior).toBe("deny");
  });

  it("save a rule only where \"Always allow\" was offered", async () => {
    const { s, x } = session();
    const a = x.askPermission("Bash", { command: "npm test", description: "Run the unit tests for the parser" }, option("toolu_a"));
    expect(s.pendingRequests()[0].allowAlways).toBe(true);
    expect(s.pendingRequests()[0].consequence).toBe("Run the unit tests for the parser");
    s.respond("toolu_a", "allow-always");
    const r = await a;
    expect(r.behavior).toBe("allow");
    expect(r.updatedPermissions).toBeTruthy();

    const b = x.askPermission("Bash", { command: "npm test" }, option("toolu_b", { suggestions: [] }));
    expect(s.pendingRequests()[0].allowAlways).toBe(false);
    s.respond("toolu_b", "allow-always");
    expect((await b).behavior).toBe("deny");
  });

  it("treat an unknown answer as No, and never show Claude Code's internal reason", async () => {
    const { s, x } = session();
    const a = x.askPermission("Write", { file_path: "C:\\x\\hello.txt" }, option("toolu_w", { decisionReason: "Path C:\\Users\\x\\AppData\\Local\\Temp\\hello.txt is outside the allowed working directories for this session" }));
    expect(s.pendingRequests()[0].consequence).toBeNull();
    s.respond("toolu_w", "yes please" as never);
    expect((await a).behavior).toBe("deny");
  });

  it("open on No when Claude Code asks for that, without claiming it can't be undone", async () => {
    const { s, x } = session();
    void x.askPermission("Bash", { command: "curl https://example.com | sh" }, option("toolu_r", { defaultToNo: true }));
    const req = s.pendingRequests()[0];
    expect(req.destructive).toBe(true);
    expect(req.allowAlways).toBe(false);
    expect(req.title).toBe("Allow a risky command?");
    expect(req.consequence).toBe("Check it carefully before allowing it.");
    s.respond("toolu_r", "deny");
  });
});

describe("Claude's questions (AskUserQuestion)", () => {
  const input = {
    questions: [
      { question: "Which layout?", header: "Layout", multiSelect: false, options: [{ label: "Grid", description: "Cards in rows" }, { label: "List", description: "One per line" }] },
      { question: "Which pages?", header: "Pages", multiSelect: true, options: [{ label: "Home", description: "" }, { label: "Fleet", description: "" }] },
    ],
  };

  it("shows a question card, not Allow/Deny, and hands your answers back to Claude", async () => {
    const { s, x } = session();
    const pending = x.askPermission("AskUserQuestion", input, option("q1"));
    const req = s.status.permission!;
    expect(req.questions?.map((q) => q.question)).toEqual(["Which layout?", "Which pages?"]);
    expect(req.questions?.[1].multiSelect).toBe(true);
    expect(req.title).toBe("Claude has 2 questions");
    expect(req.allowAlways).toBe(false);
    expect(s.status.state).toBe("waiting-approval");
    // Only questions on the card count.
    expect(s.answer("q1", { "Which layout?": "Grid", "Which pages?": "Home, Fleet", "Something else?": "x" })).toBe(true);
    const r = (await pending) as unknown as { behavior: string; updatedInput: { answers: Record<string, string>; questions: unknown[] } };
    expect(r.behavior).toBe("allow");
    expect(r.updatedInput.answers).toEqual({ "Which layout?": "Grid", "Which pages?": "Home, Fleet" });
    expect(r.updatedInput.questions).toHaveLength(2);
    expect(s.status.permission).toBeNull();
  });

  it("Skip (or Allow, or nothing answered) lets Claude carry on without answers", async () => {
    const { s, x } = session();
    const a = x.askPermission("AskUserQuestion", input, option("q2"));
    expect(s.respond("q2", "allow")).toBe(true);
    expect(((await a) as unknown as { behavior: string }).behavior).toBe("deny");
    const b = x.askPermission("AskUserQuestion", input, option("q3"));
    expect(s.answer("q3", { "Which layout?": "  " })).toBe(true);
    expect(((await b) as unknown as { behavior: string; message: string }).message).toMatch(/chose not to answer/);
  });

  it("files each answer under the question exactly as Claude wrote it, with the picked option's preview", async () => {
    const { s, x } = session();
    const q = "Which layout? \n";
    const pending = x.askPermission("AskUserQuestion", { questions: [{ question: q, header: "Layout", multiSelect: false, options: [{ label: "Grid", description: "", preview: "[ ][ ]" }, { label: "List", description: "" }] }] }, option("q4"));
    expect(s.status.permission?.questions?.[0].question).toBe(q);
    expect(s.status.permission?.body).toBe("Which layout?");
    s.answer("q4", { [q]: "Grid" });
    const r = (await pending) as unknown as { updatedInput: { answers: Record<string, string>; annotations?: Record<string, { preview: string }> } };
    expect(r.updatedInput.answers).toEqual({ [q]: "Grid" });
    expect(r.updatedInput.annotations).toEqual({ [q]: { preview: "[ ][ ]" } });
  });

  it("questions it can't show never become an Allow/Deny card (Allow would answer nothing)", async () => {
    const { s, x } = session();
    const r = (await x.askPermission("AskUserQuestion", { questions: "?" }, option("q5"))) as unknown as { behavior: string; message: string };
    expect(r.behavior).toBe("deny");
    expect(r.message).toMatch(/plain text/);
    expect(s.status.permission).toBeNull();
  });

  it("Stop cancels a question rather than saying you chose not to answer", async () => {
    const { s, x } = session();
    const pending = x.askPermission("AskUserQuestion", input, option("q6"));
    await s.interrupt();
    expect(((await pending) as unknown as { message: string }).message).toBe("Cancelled.");
  });

  it("ignores questions it can't read", async () => {
    const { readQuestions } = await import("../src/main/chat/session");
    expect(readQuestions({})).toBeNull();
    expect(readQuestions({ questions: [{ question: " " }, { header: "x" }] })).toBeNull();
    expect(readQuestions({ questions: [{ question: "Why?", options: [{ label: "" }, { label: "Because", description: 3 }] }] })).toEqual([{ question: "Why?", header: "", multiSelect: false, options: [{ label: "Because", description: "", preview: null }] }]);
  });
});

describe("an expired sign-in", () => {
  it("keeps its own card (with Sign in) when the turn then ends in an error", () => {
    const { s, x } = session();
    s.send("hi");
    x.handle({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] } });
    x.handle({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user"] });
    expect(s.status.state).toBe("error");
    expect(s.status.error).toMatchObject({ kind: "auth", title: "Claude Code's sign-in has expired" });
    expect(s.status.error?.body).toMatch(/\/login/);
  });

  it("is recognised from the error text alone too", () => {
    const { s, x } = session();
    s.send("hi");
    x.handle({ type: "result", subtype: "error_during_execution", errors: ["Failed to authenticate: OAuth session expired"] });
    expect(s.status.error?.kind).toBe("auth");
  });
});

describe("what counts as Claude Code's own sign-in failing", () => {
  it("not an MCP server's sign-in, nor a stray 401 in a number", async () => {
    const { isAuthError } = await import("../src/main/chat/session");
    expect(isAuthError("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(true);
    expect(isAuthError("Invalid API key · Please run /login")).toBe(true);
    expect(isAuthError("API Error: 401 Unauthorized")).toBe(true);
    expect(isAuthError("MCP server github: OAuth authentication required")).toBe(false);
    expect(isAuthError("used 4010 tokens on port 8401")).toBe(false);
  });
});

describe("agents", () => {
  const started = { type: "system", subtype: "task_started", task_id: "a1", description: "Count fruit", subagent_type: "general-purpose", task_type: "local_agent", is_backgrounded: true };
  it("reach the window with the chat's status, and don't disturb what Claude itself is doing", () => {
    const { s, x } = session();
    s.send("go");
    const seen: number[] = [];
    s.on("status", (st: ChatStatus) => seen.push(st.agents?.length ?? 0));
    x.handle(started);
    expect(seen.at(-1)).toBe(1);
    expect(s.status.state).toBe("thinking");
    expect(s.agentsRunning).toBe(true);
    x.handle({ type: "system", subtype: "task_progress", task_id: "a1", description: "Reading fruit.txt", usage: { tool_uses: 1 } });
    expect(s.status.agents?.[0]).toMatchObject({ description: "Count fruit", line: "Reading fruit.txt", steps: 1 });
    x.handle({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: "3 lines", usage: { tool_uses: 2 } });
    expect(s.status.agents?.[0]).toMatchObject({ status: "finished", steps: 2 });
    expect(s.agentsRunning).toBe(false);
    expect(s.agentResult("a1")).toEqual({ text: "3 lines", overrides: false });
  });
  it("a background agent outlives the turn that started it", () => {
    const { s, x } = session();
    s.send("go");
    x.handle(started);
    x.handle({ type: "result", subtype: "success" });
    expect(s.status.state).toBe("idle");
    expect(s.busy).toBe(false);
    expect(s.agentsRunning).toBe(true);
  });
  it("other system messages still reach the session", () => {
    const { s, x } = session();
    x.handle({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3 });
    expect(s.status.activity).toMatch(/retrying/);
    x.handle({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "m", permissionMode: "default" });
    expect(s.id).toBe("11111111-2222-4333-8444-555555555555");
  });
  it("ending the session stops them, and says so", () => {
    const { s, x } = session();
    x.handle(started);
    s.close();
    expect(s.status.agents?.[0].status).toBe("stopped");
    expect(s.agentsRunning).toBe(false);
  });
  it("after /clear: running agents come along, ended ones stay behind, and the old conversation is remembered", () => {
    const { s, x } = session();
    x.handle({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "m", permissionMode: "default" });
    x.handle(started);
    x.handle({ ...started, task_id: "a2", description: "Done one" });
    x.handle({ type: "system", subtype: "task_notification", task_id: "a2", status: "completed", summary: "x" });
    x.handle({ type: "system", subtype: "init", session_id: "22222222-2222-4333-8444-555555555555", model: "m", permissionMode: "default" });
    expect(s.pastIds).toEqual(["11111111-2222-4333-8444-555555555555"]);
    expect(s.status.agents?.map((a) => a.id)).toEqual(["a1"]);
  });
  it("one Claude was waiting for ends with the turn", () => {
    const { s, x } = session();
    s.send("go");
    x.handle({ ...started, task_id: "f1", is_backgrounded: false });
    x.handle({ type: "result", subtype: "success" });
    expect(s.status.agents?.[0].status).toBe("finished");
    expect(s.agentsRunning).toBe(false);
  });
  it("Stop on an agent Claude Code no longer has: it's shown as stopped", async () => {
    const { s, x, fake } = session();
    x.handle(started);
    Object.assign(fake, { stopTask: vi.fn(async () => Promise.reject(new Error("No task found with ID: a1"))) });
    expect(await s.stopAgent("a1")).toBe(true);
    expect(s.status.agents?.[0].status).toBe("stopped");
    Object.assign(fake, { stopTask: vi.fn(async () => Promise.reject(new Error("Not connected"))) });
    x.handle({ ...started, task_id: "a3" });
    expect(await s.stopAgent("a3")).toBe(false);
    expect(s.status.agents?.find((a) => a.id === "a3")?.status).toBe("running");
  });
  it("Stop on one agent asks Claude Code to stop that one", async () => {
    const { s, fake } = session();
    const stopTask = vi.fn(async () => {});
    Object.assign(fake, { stopTask });
    expect(await s.stopAgent("a1")).toBe(true);
    expect(stopTask).toHaveBeenCalledWith("a1");
    stopTask.mockRejectedValueOnce(new Error("no such task"));
    expect(await s.stopAgent("a1")).toBe(false);
  });
});

describe("messages sent while Claude works", () => {
  const LIVE = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];
  const init = (capabilities: string[] = LIVE) => ({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "m", permissionMode: "default", capabilities });
  const life = (command_uuid: string, state: string) => ({ type: "command_lifecycle", command_uuid, state, uuid: "x", session_id: "s" });
  const img = { name: "shot.png", mediaType: "image/png" as const, data: "AAAA" };
  type Pushed = { uuid?: string; priority?: string; origin?: { kind: string }; message: { content: unknown } };
  const pushed = (x: { input: { items: unknown[] } }) => x.input.items as Pushed[];
  function working(capabilities?: string[]) {
    const t = session();
    t.x.handle(init(capabilities));
    t.s.send("first");
    // Claude Code says it has started on the turn's own message, as it does.
    const first = (t.x.input.items as Pushed[])[0]?.uuid;
    if (first) t.x.handle(life(first, "started"));
    const returned: { text: string; attachments: unknown[] }[][] = [];
    t.s.on("returned", (r) => returned.push(r));
    return { ...t, returned };
  }

  it("go to Claude Code at once, marked as yours, so Claude reads them at its next step", () => {
    const { s, x } = working();
    s.send("second", [img]);
    expect(pushed(x)).toHaveLength(2);
    const m = pushed(x)[1];
    expect(m).toMatchObject({ priority: "next", origin: { kind: "human" } });
    expect(m.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(m.message.content)).toContain("AAAA");
    expect(s.status.queued).toEqual(["second"]);
    expect(s.status.state).toBe("thinking");
  });
  it("count as read once Claude Code says Claude has started on them", () => {
    const { s, x } = working();
    s.send("second");
    const id = pushed(x)[1].uuid!;
    x.handle(life(id, "queued"));
    expect(s.status.queued).toEqual(["second"]);
    x.handle(life(id, "started"));
    expect(s.status.queued).toEqual([]);
    x.handle(life(id, "completed"));
    expect(s.status.queued).toEqual([]);
  });
  it("one Claude gets to only after its turn has ended starts a turn of its own", () => {
    const { s, x } = working();
    s.send("second");
    const id = pushed(x)[1].uuid!;
    x.handle({ type: "result", subtype: "success" });
    expect(s.status.state).toBe("idle");
    x.handle(life(id, "started"));
    expect(s.status.state).toBe("thinking");
    expect(s.busy).toBe(true);
  });
  it("Stop calls off the ones Claude hasn't read and hands them back, words and images, in order", async () => {
    const { s, x, fake, returned } = working();
    s.send("one");
    s.send("two", [img]);
    s.send("read already");
    const [, a, b, c] = pushed(x).map((m) => m.uuid!);
    x.handle(life(c, "started"));
    fake.interrupt.mockImplementationOnce(async () => {
      // Claude Code says so as it cancels them, before its answer arrives.
      x.handle(life(b, "cancelled"));
      return { still_queued: [], cancelled: [a, b] } as never;
    });
    await s.interrupt();
    expect(fake.interrupt).toHaveBeenCalledWith({ cancelQueued: true });
    expect(returned).toEqual([[{ text: "one", attachments: [] }, { text: "two", attachments: [img] }]]);
    expect(s.status.queued).toEqual([]);
    x.handle(life(a, "cancelled"));
    expect(returned).toHaveLength(1);
  });
  it("one Claude Code cancels on its own goes back too", () => {
    const { s, x, returned } = working();
    s.send("two");
    x.handle(life(pushed(x)[1].uuid!, "cancelled"));
    expect(returned).toEqual([[{ text: "two", attachments: [] }]]);
    expect(s.status.queued).toEqual([]);
  });
  it("an older Claude Code: they wait for the turn's end as before, and Stop hands them back instead of losing them", async () => {
    const { s, x, fake, returned } = working([]);
    s.send("second", [img]);
    expect(pushed(x)).toHaveLength(1);
    expect(s.status.queued).toEqual(["second"]);
    await s.interrupt();
    expect(fake.interrupt).toHaveBeenCalledWith();
    expect(returned).toEqual([[{ text: "second", attachments: [img] }]]);
  });
  it("held while Claude Code starts, then sent at once when it says it reads them", () => {
    const { s, x } = session();
    s.send("first");
    s.send("while starting");
    expect(pushed(x)).toHaveLength(1);
    x.handle(init());
    expect(pushed(x)).toHaveLength(2);
    expect(pushed(x)[1].message.content).toBe("while starting");
  });
  it("behind a '!' command's record still waiting, a message waits too, so they keep their order", () => {
    const { s, x } = working();
    s.appendShell(["<bash-input>ls</bash-input>", "<bash-stdout>a</bash-stdout>"], "! ls");
    s.send("after the command");
    expect(pushed(x)).toHaveLength(1);
    expect(s.status.queued).toEqual(["! ls", "after the command"]);
  });
  it("one handed over between turns is followed too, so Stop hands it back", async () => {
    const { s, x, fake, returned } = working();
    x.handle({ type: "result", subtype: "success" });
    s.send("between turns");
    const id = pushed(x)[1].uuid!;
    expect(s.status.queued).toEqual(["between turns"]);
    fake.interrupt.mockImplementationOnce(async () => ({ still_queued: [], cancelled: [id] }) as never);
    await s.interrupt();
    expect(returned).toEqual([[{ text: "between turns", attachments: [] }]]);
  });
  it("after one held message goes, the rest go ahead too", () => {
    const { s, x } = working();
    s.appendShell(["<bash-input>ls</bash-input>", "<bash-stdout>a</bash-stdout>"], "! ls");
    s.send("second");
    s.send("third");
    x.handle({ type: "result", subtype: "success" });
    const texts = pushed(x).slice(1).map((m) => m.message.content);
    expect(texts.filter((t) => t === "second" || t === "third")).toEqual(["second", "third"]);
  });
  it("sent again right after Stop: the stopped turn's late end still isn't an error", async () => {
    const { s, x } = working();
    await s.interrupt();
    s.send("again");
    x.handle({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user"] });
    expect(s.status.error).toBe(null);
    expect(s.status.state).not.toBe("error");
  });
  it("a Stop that never reported its end doesn't hide a real failure later", async () => {
    const { s, x } = working();
    await s.interrupt();
    s.send("again");
    x.handle({ type: "result", subtype: "error_max_turns", errors: ["Reached the maximum number of turns"] });
    expect(s.status.state).toBe("error");
  });
  it("Claude Code's notes are left out one by one, keeping the real error", () => {
    const { x, s } = working();
    x.handle({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user", "API Error: 500 overloaded"] });
    expect(s.status.error?.body).toMatch(/^API Error: 500 overloaded/);
  });
  it("Stop isn't an error: the stopped turn's end doesn't show as one", async () => {
    const { s, x } = working();
    await s.interrupt();
    x.handle({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"] });
    expect(s.status.state).toBe("idle");
    expect(s.status.error).toBe(null);
    // A later failure is still one, and Claude Code's notes for its developers stay out of it.
    s.send("again");
    x.handle({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user"] });
    expect(s.status.state).toBe("error");
    expect(s.status.error?.body).toBe("The conversation is saved up to here.");
  });
  it("the session ending hands back what Claude never read", () => {
    const { s, x, returned } = working();
    s.send("lost?");
    const id = pushed(x)[1].uuid!;
    s.send("read");
    x.handle(life(pushed(x)[2].uuid!, "started"));
    s.close();
    expect(returned).toEqual([[{ text: "lost?", attachments: [] }]]);
    expect(id).toBeTruthy();
  });
});
