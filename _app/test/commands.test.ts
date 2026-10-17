// Slash commands and skills in the app: how they show in the conversation, the /mcp
// panel's two sources, and following Claude Code when it moves to a new conversation.
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStatus, McpServerInfo } from "../src/shared/types";

process.env.CONVERSATIONS_DATA_DIR = path.join(os.tmpdir(), `conversations-test-${process.pid}`);

import { localOutput, parseTranscript, slashRecord } from "../src/main/index/parse";
import { toMcpInfo } from "../src/main/chat/mcp";
import { ChatManager, type ManagerDeps, type SessionLike } from "../src/main/chat/manager";
import { ChatSession, type SessionOptions } from "../src/main/chat/session";

const CWD = "C:\\Users\\alex\\Projects\\website";
const ID = "cccccccc-3333-4333-8333-cccccccccccc";
const NEXT = "44330273-0000-4000-8000-000000000000";

describe("reading what Claude Code records", () => {
  it("reads a command in either order, with its arguments", () => {
    expect(slashRecord("<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args>reconnect analytics</command-args>")).toEqual({ name: "mcp", args: "reconnect analytics" });
    expect(slashRecord("<command-message>debug</command-message>\n<command-name>/debug</command-name>")).toEqual({ name: "debug", args: "" });
    expect(slashRecord("<command-name>/rename</command-name><command-args>Ads &amp; site</command-args>")).toEqual({ name: "rename", args: "Ads & site" });
    expect(slashRecord("What does <command-name> mean?")).toBeNull();
    expect(slashRecord("/mcp")).toBeNull();
  });

  it("reads what a local command printed, both streams, without colour codes", () => {
    expect(localOutput("<local-command-stdout>12 MCP server(s): 9 connected</local-command-stdout>")).toBe("12 MCP server(s): 9 connected");
    expect(localOutput("<local-command-stdout>\u001b[1mBold\u001b[22m ok</local-command-stdout><local-command-stderr>warn</local-command-stderr>")).toBe("Bold ok\nwarn");
    expect(localOutput("<local-command-stdout></local-command-stdout>")).toBe("");
    expect(localOutput("hello")).toBeNull();
  });
});

const ctx = { sourcePath: "C:/t.jsonl", machineForCwd: () => "Uni PC" };
let n = 0;
// Each entry follows the one before, as in a real transcript (the app shows the branch ending in the newest).
let parent: string | null = null;
const ts = (min: number) => new Date(Date.UTC(2026, 9, 14, 11, min)).toISOString();
const entry = (type: string, content: unknown, min: number, extra: object = {}) => {
  const uuid = `c-${++n}`;
  const e = { type, uuid, parentUuid: parent, isSidechain: false, message: type === "assistant" ? { role: "assistant", model: "claude-opus-5-5", content } : { role: "user", content }, timestamp: ts(min), cwd: CWD, ...extra };
  parent = uuid;
  return e;
};
const sys = (subtype: string, content: string, min: number) => {
  const uuid = `c-${++n}`;
  const e = { type: "system", subtype, uuid, parentUuid: parent, content, timestamp: ts(min), cwd: CWD };
  parent = uuid;
  return e;
};
const jsonl = (lines: object[]) => {
  parent = null;
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const CAVEAT = "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>";

describe("in the conversation", () => {
  it("shows a local command as what you typed, with what it printed under it", () => {
    const r = parseTranscript(
      jsonl([
        entry("user", "Is posthog connected?", 0),
        entry("assistant", [{ type: "text", text: "It timed out. Type /mcp." }], 1),
        entry("user", CAVEAT, 2, { isMeta: true }),
        entry("user", "<command-name>/mcp</command-name>\n<command-message>mcp</command-message>\n<command-args></command-args>", 2),
        sys("local_command", "<local-command-stdout>18 MCP server(s): 7 connected, 8 connecting, 3 not connected, 0 disabled.</local-command-stdout>", 2),
      ]),
      ctx,
    );
    const visible = r.items.filter((i) => i.kind !== "meta" && i.kind !== "day");
    expect(visible.map((i) => i.kind)).toEqual(["user", "text", "command"]);
    expect(visible[2]).toMatchObject({ name: "mcp", args: "", output: "18 MCP server(s): 7 connected, 8 connecting, 3 not connected, 0 disabled." });
    // Shown and the list's last line, but not a prompt.
    expect(r.info.prompts).toBe(1);
    expect(r.info.lastPrompt).toBe("/mcp");
  });

  it("keeps a chat titled by what you first asked, even when it began with /model", () => {
    const r = parseTranscript(
      jsonl([
        entry("user", "<command-name>/model</command-name><command-args>opus</command-args>", 0),
        sys("local_command", "<local-command-stdout>Set model to `opus (claude-opus-5-5)`</local-command-stdout>", 0),
        entry("user", "Check the enquiry numbers", 1),
        entry("assistant", [{ type: "text", text: "Two this week." }], 2),
      ]),
      ctx,
    );
    expect(r.info.title).toBe("Check the enquiry numbers");
    expect(r.info.prompts).toBe(1);
  });

  it("a terminal session of only /usage has no prompts, so the index leaves it out as before", () => {
    const r = parseTranscript(jsonl([entry("user", CAVEAT, 0, { isMeta: true }), entry("user", "<command-name>/usage</command-name><command-args></command-args>", 0), sys("local_command", "<local-command-stdout>Current session: 9% used</local-command-stdout>", 0)]), ctx);
    expect(r.info.prompts).toBe(0);
    expect(r.items.find((i) => i.kind === "command")).toMatchObject({ name: "usage", output: "Current session: 9% used" });
  });

  it("shows a skill as what you typed, then Claude's reply; its instructions stay hidden", () => {
    const r = parseTranscript(
      jsonl([
        entry("user", "<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n<command-args>src/app.ts</command-args>", 0),
        entry("user", [{ type: "text", text: "# Simplify\n\nReview the changed code..." }], 0, { isMeta: true }),
        entry("assistant", [{ type: "text", text: "Two cleanups applied." }], 1),
      ]),
      ctx,
    );
    const visible = r.items.filter((i) => i.kind !== "meta" && i.kind !== "day");
    expect(visible.map((i) => i.kind)).toEqual(["command", "text"]);
    expect(visible[0]).toMatchObject({ name: "simplify", args: "src/app.ts", output: null });
    expect(JSON.stringify(r.items)).not.toContain("Review the changed code");
  });

  it("takes /compact's output from the user entry it is written as (in the order Claude Code writes them)", () => {
    const r = parseTranscript(
      jsonl([
        entry("user", "Earlier work", 0),
        sys("compact_boundary", "Conversation compacted", 1),
        entry("user", "This session is being continued from a previous conversation...", 1, { isCompactSummary: true }),
        entry("user", CAVEAT, 1, { isMeta: true }),
        entry("user", "<command-name>/compact</command-name><command-args></command-args>", 1),
        entry("user", "<local-command-stdout>Compacted </local-command-stdout>", 1),
      ]),
      ctx,
    );
    expect(r.items.find((i) => i.kind === "command")).toMatchObject({ name: "compact", output: "Compacted" });
  });

  it("puts each output on its own command, also in the record that names the command in a system entry", () => {
    // A skill, Claude's reply, a typed prompt and reply, then /login recorded the other way.
    const r = parseTranscript(
      jsonl([
        entry("user", "<command-message>simplify</command-message><command-name>/simplify</command-name>", 0),
        entry("assistant", [{ type: "text", text: "Done." }], 1),
        entry("user", "Thanks, now the ads", 2),
        entry("assistant", [{ type: "text", text: "Checking." }], 3),
        sys("local_command", "<command-name>/login</command-name>\n<command-message>login</command-message>\n<command-args></command-args>", 4),
        sys("local_command", "<local-command-stdout>Login successful</local-command-stdout>", 4),
      ]),
      ctx,
    );
    const cmds = r.items.filter((i) => i.kind === "command") as { name: string; output: string | null }[];
    expect(cmds.map((c) => [c.name, c.output])).toEqual([
      ["simplify", null],
      ["login", "Login successful"],
    ]);
    expect(r.items.some((i) => i.kind === "notice")).toBe(false);
  });

  it("never attaches output that comes after Claude has replied", () => {
    const r = parseTranscript(jsonl([entry("user", "<command-message>debug</command-message><command-name>/debug</command-name>", 0), entry("assistant", [{ type: "text", text: "Logging on." }], 1), sys("local_command", "<local-command-stdout>stray</local-command-stdout>", 2)]), ctx);
    expect(r.items.find((i) => i.kind === "command")).toMatchObject({ name: "debug", output: null });
  });
});

describe("the /mcp panel", () => {
  it("lists servers that need attention first", () => {
    const list = toMcpInfo([
      { name: "figma", status: "connected", tools: [{ name: "a" }, { name: "b" }], scope: "user" },
      { name: "analytics", status: "failed", error: "Connection timed out after 30s", scope: "project" },
      { name: "mailer", status: "needs-auth", scope: "claudeai" },
      { name: "slow", status: "pending" },
      { name: "", status: "connected" },
    ] as never);
    expect(list.map((s) => [s.name, s.status, s.toolCount])).toEqual([
      ["analytics", "failed", 0],
      ["mailer", "needs-auth", 0],
      ["slow", "pending", 0],
      ["figma", "connected", 2],
    ]);
    expect(list[0].error).toBe("Connection timed out after 30s");
  });

  it("gives each server's type and tools for its details", () => {
    const [s] = toMcpInfo([{ name: "crm", status: "connected", scope: "user", config: { type: "http", url: "https://mcp.example.com/mcp" }, tools: [{ name: "list_tables", description: "  Lists\n tables  " }, { name: "run_sql" }, { bad: 1 }] }] as never);
    expect(s.transport).toBe("http");
    expect(s.tools).toEqual([
      { name: "list_tables", description: "Lists tables" },
      { name: "run_sql", description: null },
    ]);
    // Nothing of its settings (the address, headers) reaches the panel but the type.
    expect(JSON.stringify(s)).not.toContain("example.com");
    expect(toMcpInfo([{ name: "x", status: "failed" }] as never)[0]).toMatchObject({ transport: null, tools: [] });
  });

  class Live extends EventEmitter implements SessionLike {
    id: string | null = ID;
    cwd = CWD;
    status = { conversationId: ID, state: "idle" } as ChatStatus;
    alive = true;
    busy = false;
    lastActivity = Date.now();
    lastWriteAt = 0;
    reconnected: string[] = [];
    started: string[] = [];
    idle = 0;
    used = false;
    model: string | null;
    mode: string;
    constructor(o: SessionOptions) {
      super();
      this.model = o.model ?? null;
      this.mode = o.permissionMode;
    }
    start(first: string) {
      this.started.push(first);
      this.used = true;
    }
    startIdle() {
      this.idle++;
    }
    send() {
      this.used = true;
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
    auth: string[] = [];
    signInUrl: string | null = "https://auth.example.com/authorize?state=s1";
    async mcpStatus(): Promise<McpServerInfo[]> {
      return [
        { name: "analytics", status: this.reconnected.length ? "connected" : "failed", scope: "project", toolCount: this.reconnected.length ? 3 : 0, error: null, transport: "stdio", tools: [] },
        { name: "crm", status: this.auth.at(-1)?.startsWith("callback") ? "connected" : "needs-auth", scope: "user", toolCount: 0, error: null, transport: "http", tools: [] },
      ];
    }
    async mcpReconnect(name: string) {
      this.reconnected.push(name);
    }
    async mcpToggle() {}
    async mcpSignIn(name: string) {
      this.auth.push(`signin ${name}`);
      return { url: this.signInUrl, callbackExpected: true };
    }
    async mcpSignInCallback(name: string, url: string) {
      if (!url.includes("code=")) throw new Error("Invalid callback URL: missing authorization code.");
      this.auth.push(`callback ${name} ${url}`);
    }
    async mcpSignOut(name: string) {
      this.auth.push(`signout ${name}`);
    }
  }

  let managers: ChatManager[] = [];
  afterEach(() => {
    for (const m of managers) m.closeAll();
    managers = [];
  });
  const setup = (over: Partial<ManagerDeps> = {}) => {
    const sessions: Live[] = [];
    const probed: string[] = [];
    const m = new ChatManager({
      claudePath: () => "claude.exe",
      machine: () => "Uni PC",
      localTranscript: () => null,
      syncBeforeResume: async () => {},
      terminalHas: async () => false,
      createSession: (o) => {
        const s = new Live(o);
        sessions.push(s);
        return s;
      },
      probeMcp: async (_c, cwd) => {
        probed.push(cwd);
        return [{ name: "analytics", status: "connected", scope: "project", toolCount: 3, error: null, transport: "stdio", tools: [] }];
      },
      ...over,
    });
    managers.push(m);
    return { m, sessions, probed };
  };

  it("uses the chat's running session when there is one, and reconnects there", async () => {
    const { m, sessions, probed } = setup();
    await m.send({ id: ID, text: "hi", cwd: CWD });
    expect(await m.mcp(ID, CWD)).toMatchObject({ live: true, servers: expect.arrayContaining([expect.objectContaining({ name: "analytics", status: "failed" })]) });
    const r = await m.mcpAction(ID, "analytics", "reconnect");
    expect(r.ok).toBe(true);
    expect(r.servers?.[0]).toMatchObject({ status: "connected", toolCount: 3 });
    expect(sessions[0].reconnected).toEqual(["analytics"]);
    expect(probed).toEqual([]);
  });

  it("starts the chat's Claude Code when nothing runs (nothing sent, no turn), as /mcp in a terminal works on a running one", async () => {
    const { m, sessions, probed } = setup();
    expect(await m.mcp(ID, CWD, { model: "opus", permissionMode: "default" })).toMatchObject({ live: true, servers: expect.arrayContaining([expect.objectContaining({ name: "analytics", status: "failed" })]) });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].idle).toBe(1);
    expect(sessions[0].started).toEqual([]);
    expect(sessions[0].model).toBe("opus");
    expect(probed).toEqual([]);
    const r = await m.mcpAction(ID, "analytics", "reconnect", CWD);
    expect(r).toMatchObject({ ok: true, servers: expect.arrayContaining([expect.objectContaining({ name: "analytics", status: "connected" })]) });
    // Your next message goes to that same Claude Code.
    await m.send({ id: ID, text: "now check the numbers", cwd: CWD });
    expect(sessions).toHaveLength(1);
  });

  it("a Claude Code started only for /mcp is not the app's chat until something is sent, and closes after two minutes unused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const { m, sessions } = setup();
      const owned: string[] = [];
      m.on("owned", (id: string) => owned.push(id));
      await m.mcp(ID, CWD);
      expect(owned).toEqual([]);
      expect(m.isOpenInApp(ID)).toBe(true);
      vi.advanceTimersByTime(3 * 60_000);
      expect(m.isOpenInApp(ID)).toBe(false);
      expect(sessions[0].alive).toBe(false);
      // A used one keeps the usual fifteen minutes, and sending makes it the app's.
      await m.mcp(ID, CWD);
      await m.send({ id: ID, text: "hello", cwd: CWD });
      expect(owned).toEqual([ID]);
      vi.advanceTimersByTime(3 * 60_000);
      expect(m.isOpenInApp(ID)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs in to a server in the chat's session: the provider's page, then the address the browser ended on", async () => {
    const { m, sessions } = setup();
    await m.mcp(ID, CWD);
    const r = await m.mcpAction(ID, "crm", "signin", CWD);
    expect(r).toMatchObject({ ok: true, url: "https://auth.example.com/authorize?state=s1", callbackExpected: true });
    expect(r.servers?.find((s) => s.name === "crm")?.status).toBe("needs-auth");
    // The browser couldn't hand it back: its address finishes it.
    expect(await m.mcpAction(ID, "crm", "callback", CWD, {}, "http://localhost:47534/callback?state=s1")).toMatchObject({ ok: false, err: expect.stringMatching(/missing authorization code/) });
    const done = await m.mcpAction(ID, "crm", "callback", CWD, {}, "http://localhost:47534/callback?code=abc&state=s1");
    expect(done.ok).toBe(true);
    expect(done.servers?.find((s) => s.name === "crm")?.status).toBe("connected");
    expect(await m.mcpAction(ID, "crm", "callback", CWD)).toMatchObject({ ok: false });
    expect((await m.mcpAction(ID, "crm", "signout", CWD)).ok).toBe(true);
    expect(sessions[0].auth).toEqual(["signin crm", "callback crm http://localhost:47534/callback?code=abc&state=s1", "signout crm"]);
    // Nothing was sent to Claude for any of it.
    expect(sessions[0].started).toEqual([]);
  });

  it("looking again while a sign-in waits never starts a Claude Code (a new one wouldn't be waiting)", async () => {
    const { m, sessions, probed } = setup();
    expect(await m.mcp(ID, CWD, {}, { noStart: true })).toMatchObject({ live: false, servers: [] });
    expect(sessions).toHaveLength(0);
    expect(probed).toEqual([]);
    await m.mcp(ID, CWD);
    expect(await m.mcp(ID, CWD, {}, { noStart: true })).toMatchObject({ live: true });
    sessions[0].close();
    expect(await m.mcp(ID, CWD, {}, { noStart: true })).toMatchObject({ live: false });
    expect(sessions).toHaveLength(1);
  });

  it("says what failed in words", async () => {
    const { m, sessions } = setup();
    await m.mcp(ID, CWD);
    sessions[0].mcpSignOut = async () => {
      throw new Error("");
    };
    expect(await m.mcpAction(ID, "crm", "signout", CWD)).toMatchObject({ ok: false, err: "Couldn't sign out of crm" });
  });

  it("a server that needs nothing in the browser gives no page", async () => {
    const { m, sessions } = setup();
    await m.mcp(ID, CWD);
    sessions[0].signInUrl = null;
    expect(await m.mcpAction(ID, "crm", "signin", CWD)).toMatchObject({ ok: true, url: null });
  });

  it("a restart from a panel button starts with the chat's model and mode", async () => {
    const { m, sessions } = setup();
    await m.mcp(ID, CWD, { model: "fable", permissionMode: "plan" });
    sessions[0].close();
    const r = await m.mcpAction(ID, "analytics", "reconnect", CWD, { model: "fable", permissionMode: "plan" });
    expect(r.ok).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].model).toBe("fable");
    expect(sessions[1].mode).toBe("plan");
  });

  it("shows what a chat open in a terminal would have, read-only, and says why", async () => {
    const { m, sessions, probed } = setup({ terminalHas: async () => true });
    const r = await m.mcp(ID, CWD);
    expect(r).toMatchObject({ live: false, servers: [{ name: "analytics" }] });
    expect(r.note).toMatch(/open in a terminal/);
    expect(sessions).toHaveLength(0);
    expect(probed).toEqual([CWD]);
  });

  it("a new chat (no conversation yet) is asked about read-only, with no Claude Code started for it", async () => {
    const { m, sessions, probed } = setup();
    expect(await m.mcp(null, CWD)).toMatchObject({ live: false });
    expect(sessions).toHaveLength(0);
    expect(probed).toEqual([CWD]);
  });
});

describe("MCP sign-in in a session", () => {
  it("keeps the session open while you sign in, and later use never shortens that", async () => {
    const s = new ChatSession({ cwd: CWD, claudePath: "claude.exe", machine: "Uni PC", permissionMode: "default" });
    const calls: string[] = [];
    (s as unknown as { q: unknown }).q = {
      mcpAuthenticate: async (n: string) => (calls.push(`auth ${n}`), { authUrl: "https://auth.example.com/a", requiresUserAction: true, callbackExpected: true }),
      mcpSubmitOAuthCallbackUrl: async (n: string, u: string) => void calls.push(`cb ${n} ${u}`),
      mcpClearAuth: async (n: string) => void calls.push(`clear ${n}`),
    };
    expect(await s.mcpSignIn("crm")).toEqual({ url: "https://auth.example.com/a", callbackExpected: true });
    const held = s.lastActivity;
    expect(held - Date.now()).toBeGreaterThan(9 * 60_000);
    await s.mcpSignInCallback("crm", "http://localhost:1/callback?code=x");
    await s.mcpSignOut("crm");
    expect(s.lastActivity).toBe(held);
    expect(calls).toEqual(["auth crm", "cb crm http://localhost:1/callback?code=x", "clear crm"]);
  });

  it("says so when this Claude Code can't sign in from the app", async () => {
    const s = new ChatSession({ cwd: CWD, claudePath: "claude.exe", machine: "Uni PC", permissionMode: "default" });
    (s as unknown as { q: unknown }).q = {};
    await expect(s.mcpSignIn("crm")).rejects.toThrow(/can't sign in/);
    await expect(s.mcpSignOut("crm")).rejects.toThrow(/can't sign out/);
  });
});

describe("following Claude Code to a new conversation", () => {
  it("the session reports the move, and the manager keeps writing where it writes", async () => {
    const s = new ChatSession({ resume: ID, cwd: CWD, claudePath: "claude.exe", machine: "Uni PC", permissionMode: "default" });
    const x = s as unknown as { handle(m: unknown): void };
    const moves: string[][] = [];
    s.on("rekeyed", (a: string, b: string) => moves.push([a, b]));
    x.handle({ type: "system", subtype: "init", session_id: ID, model: "opus", permissionMode: "default" });
    x.handle({ type: "system", subtype: "init", session_id: NEXT, model: "opus", permissionMode: "default" });
    expect(moves).toEqual([[ID, NEXT]]);
    expect(s.id).toBe(NEXT);
  });

  it("the manager files the session under the new id and marks it the app's", async () => {
    let made: EventEmitter & SessionLike;
    const m = new ChatManager({
      claudePath: () => "claude.exe",
      machine: () => "Uni PC",
      localTranscript: () => null,
      syncBeforeResume: async () => {},
      terminalHas: async () => false,
      createSession: (o) => {
        const e = new EventEmitter() as EventEmitter & SessionLike;
        Object.assign(e, { id: o.resume, cwd: o.cwd, status: { conversationId: o.resume, state: "idle" }, alive: true, busy: false, lastActivity: 0, lastWriteAt: 0, start() {}, send() {}, pendingRequests: () => [], respond: () => false, interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, models: async () => [], close() {} });
        made = e;
        return e;
      },
    });
    const owned: string[] = [];
    const rekeyed: string[][] = [];
    m.on("owned", (id: string) => owned.push(id));
    m.on("rekeyed", (a: string, b: string) => rekeyed.push([a, b]));
    await m.send({ id: ID, text: "hi", cwd: CWD });
    made!.emit("rekeyed", ID, NEXT);
    expect(rekeyed).toEqual([[ID, NEXT]]);
    expect(owned).toContain(NEXT);
    expect(m.isOpenInApp(NEXT)).toBe(true);
    expect(m.isOpenInApp(ID)).toBe(false);
    m.closeAll();
  });
});
