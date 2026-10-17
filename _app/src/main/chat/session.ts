// One conversation running in the app: Claude Code through the Claude Agent SDK,
// kept open in streaming-input mode so follow-ups, Stop, model and permission
// changes all apply to the same live session.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { CanUseTool, Query, SDKMessage, SDKUserMessage, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { query } from "./sdk";
import type { Attachment, ChatStatus, McpServerInfo, PermissionRequest } from "../../shared/types";
import { toMcpInfo } from "./mcp";
import { log } from "../log";
import { isDecision, type Decision, type EffortLevel, type PermissionMode } from "../validate";
import { classifyTool, destructiveFallback, serverName } from "./destructive";
import { remember, rememberCommands, toChoices, toCommands, type ModelChoice } from "./models";

/** Streamed text reaches the window at most this often (20 times a second). */
const STREAM_EMIT_MS = 50;

/** Messages typed in the app, handed to Claude Code as they arrive. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(m: SDKUserMessage) {
    this.items.push(m);
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

type FollowUp = { text: string; attachments: Attachment[] } | { shell: [string, string]; label: string };
const followLabel = (f: FollowUp) => ("shell" in f ? f.label : f.text);

export interface SessionOptions {
  /** The conversation to continue; omitted for a new chat. */
  resume?: string;
  cwd: string;
  claudePath: string;
  machine: string;
  model?: string | null;
  permissionMode: PermissionMode;
  effort?: EffortLevel | null;
}

interface Pending {
  request: PermissionRequest;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

const SHELLS: Record<string, string> = { Bash: "Bash", PowerShell: "PowerShell" };

const short = (p: string) => p.replace(/\\/g, "/").split("/").slice(-2).join("/");

/** What a tool is doing, in a few words: "Reading lib/seasons.ts". */
export function describeActivity(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (name.startsWith("mcp__")) return `Using ${serverName(name)}`;
  switch (name) {
    case "Read":
      return `Reading ${short(s("file_path"))}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${short(s("file_path"))}`;
    case "Write":
      return `Writing ${short(s("file_path"))}`;
    case "Grep":
    case "Glob":
      return "Searching code";
    case "Bash":
    case "PowerShell": {
      const c = s("command").split("\n")[0];
      return c.length <= 40 ? `Running ${c}` : s("description") || "Running a command";
    }
    case "WebFetch":
      return "Reading a web page";
    case "WebSearch":
      return "Searching the web";
    case "Agent":
    case "Task":
      return s("description") ? `Agent: ${s("description")}` : "Running an agent";
    case "TodoWrite":
      return "Updating the to-do list";
    default:
      return `Using ${name}`;
  }
}

export class ChatSession extends EventEmitter {
  id: string | null;
  readonly cwd: string;
  private q: Query | null = null;
  private input = new InputQueue();
  private pending = new Map<string, Pending>();
  private permissionQueue: string[] = [];
  private toolNames = new Map<string, string>();
  private streamText = "";
  private streamTimer: NodeJS.Timeout | null = null;
  /**
   * Follow-ups typed while Claude works. Each goes to Claude Code only when the turn
   * before it ends, so Stop can still cancel them. A "!" command's record waits its
   * turn here too, so it lands in the transcript in the order you typed it.
   */
  private followUps: FollowUp[] = [];
  /** Shell records handed over that start no turn; each still reports a result, which is not a turn's end. */
  private quietResults = 0;
  /**
   * Of those, the ones handed over before the message now running: Claude Code may
   * merge them into that message, and then they report no result of their own.
   */
  private mergeable = 0;
  /** Tokens Claude has written this turn: finished API calls, and the one in progress. */
  private turnDone = 0;
  private msgTokens = 0;
  private ended = false;
  lastActivity = Date.now();
  /** When this session last wrote to its transcript (for the single-writer check). */
  lastWriteAt = 0;
  /** Something has been handed to Claude Code (a message or a command's record). */
  used = false;
  status: ChatStatus;

  constructor(private opts: SessionOptions) {
    super();
    this.id = opts.resume ?? null;
    this.cwd = opts.cwd;
    this.status = {
      conversationId: this.id ?? "",
      state: "starting",
      activity: null,
      model: null,
      permissionMode: opts.permissionMode,
      contextPercent: null,
      queued: [],
      error: null,
      permission: null,
      streamingText: "",
      turnTokens: null,
    };
  }

  get alive() {
    return !this.ended;
  }

  get busy() {
    return ["starting", "thinking", "running-tool", "writing", "waiting-approval"].includes(this.status.state);
  }

  private set(patch: Partial<ChatStatus>) {
    this.status = { ...this.status, ...patch, conversationId: this.id ?? "" };
    this.lastActivity = Date.now();
    this.emit("status", this.status);
  }

  start(first: string, attachments: Attachment[] = []) {
    this.send(first, attachments);
    this.open();
  }

  /** Starts Claude Code with a "!" command's record and no turn: it waits for your next message. */
  startShell(record: [string, string]) {
    this.handOverShell(record);
    this.set({ state: "idle", activity: null });
    this.open();
  }

  /** Starts Claude Code with nothing to say (for /mcp): its servers connect; it waits for your next message. */
  startIdle() {
    this.set({ state: "idle", activity: null });
    this.open();
  }

  private open() {
    // CLAUDE_SYNC_IN_APP: the sync's hooks know the app brought the newest copy before
    // starting, and don't tell Claude to have you /resume (a terminal's step).
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_SYNC_INCLUDE_HEADLESS: "1", CLAUDE_SYNC_IN_APP: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        resume: this.opts.resume,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        pathToClaudeCodeExecutable: this.opts.claudePath,
        permissionMode: this.opts.permissionMode,
        model: this.opts.model ?? undefined,
        effort: this.opts.effort ?? undefined,
        // The same Claude in Chrome integration a terminal session has (`claude --chrome`).
        // When the extension isn't running, the browser tools are simply absent.
        extraArgs: { chrome: null },
        env,
        canUseTool: (toolName, input, o) => this.askPermission(toolName, input, o),
        stderr: (data: string) => log("claude", data.trim().slice(0, 400)),
      },
    });
    void this.pump();
  }

  /** A message from the composer: sent now, or kept in the app's queue until Claude finishes. */
  send(text: string, attachments: Attachment[] = []) {
    if (this.q && this.busy) {
      this.followUps.push({ text, attachments });
      this.set({ queued: this.followUps.map(followLabel) });
      return;
    }
    this.flushRecords();
    this.handOver({ text, attachments });
  }

  /** A "!" command's record: written now, or after the turn in progress, without starting one. */
  appendShell(record: [string, string], label: string) {
    if (this.q && this.busy) {
      this.followUps.push({ shell: record, label });
      this.set({ queued: this.followUps.map(followLabel) });
      return;
    }
    this.flushRecords();
    this.handOverShell(record);
  }

  /** Records still queued while no turn runs (a stopped turn that never reported its end): written now, in order. */
  private flushRecords() {
    const records = this.followUps.filter((f): f is Extract<FollowUp, { shell: [string, string] }> => "shell" in f);
    if (!records.length) return;
    this.followUps = this.followUps.filter((f) => !("shell" in f));
    for (const r of records) this.handOverShell(r.shell);
    this.set({ queued: this.followUps.map(followLabel) });
  }

  /** The command and its output, as the CLI's bash mode records them: in the transcript, for Claude's next turn. */
  private handOverShell(record: [string, string]) {
    this.used = true;
    for (const content of record) {
      this.quietResults++;
      this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, shouldQuery: false, timestamp: new Date().toISOString() } as SDKUserMessage);
    }
    this.lastWriteAt = Date.now();
    this.lastActivity = Date.now();
  }

  /** The next queued item once a turn is over: records go straight in, a message starts the next turn. */
  private nextFollowUp() {
    for (let next = this.followUps.shift(); next; next = this.followUps.shift()) {
      if ("shell" in next) {
        this.handOverShell(next.shell);
        this.set({ queued: this.followUps.map(followLabel) });
        continue;
      }
      this.handOver(next);
      return;
    }
  }

  /** Gives one message to Claude Code: its images first, then the text. */
  private handOver(item: { text: string; attachments: Attachment[] }) {
    this.used = true;
    const content = item.attachments.length
      ? [...item.attachments.map((a) => ({ type: "image" as const, source: { type: "base64" as const, media_type: a.mediaType, data: a.data } })), { type: "text" as const, text: item.text }]
      : item.text;
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content }, parent_tool_use_id: null, priority: "next", timestamp: new Date().toISOString() };
    this.turnDone = 0;
    this.msgTokens = 0;
    this.mergeable = this.quietResults;
    this.set({ state: "thinking", activity: null, error: null, turnTokens: null, queued: this.followUps.map(followLabel) });
    this.input.push(msg);
  }

  /** The streamed copy of the reply, sent to the window at most STREAM_EMIT_MS apart. */
  private queueStreamEmit() {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (this.status.streamingText !== this.streamText) this.set({ streamingText: this.streamText });
    }, STREAM_EMIT_MS);
  }

  private clearStream() {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null;
    this.streamText = "";
  }

  private async pump() {
    try {
      for await (const m of this.q!) this.handle(m);
      this.finish(null);
    } catch (e) {
      this.finish(e as Error);
    }
  }

  private finish(err: Error | null) {
    if (this.ended) return;
    this.ended = true;
    this.clearStream();
    const lostRecords = this.followUps.filter((f) => "shell" in f).length;
    if (lostRecords) log("chat", `session ${this.id} ended with ${lostRecords} command record(s) not yet written`);
    this.followUps = [];
    for (const p of this.pending.values()) p.resolve({ behavior: "deny", message: "The session ended." });
    this.pending.clear();
    if (err) {
      log("chat", `session ${this.id} ended with an error: ${err.message}`);
      this.set({ state: "error", activity: null, permission: null, streamingText: "", queued: [], error: { title: "Claude Code stopped", body: plainError(err.message) } });
    } else this.set({ state: this.status.state === "error" ? "error" : "idle", activity: null, permission: null, streamingText: "", queued: [] });
    this.emit("ended");
  }

  private handle(m: SDKMessage) {
    this.lastActivity = Date.now();
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          const isNew = !this.id;
          const before = this.id;
          this.id = m.session_id;
          this.set({ model: m.model, permissionMode: m.permissionMode });
          if (isNew) this.emit("created", this.id);
          // Claude Code moved to another conversation (/clear and its aliases do): the app follows it.
          else if (before && before !== m.session_id) this.emit("rekeyed", before, m.session_id);
        } else if (m.subtype === "commands_changed") {
          rememberCommands(this.cwd, toCommands((m as { commands: { name: string; description?: string; argumentHint?: string; builtin?: boolean }[] }).commands));
        } else if (m.subtype === "api_retry") {
          this.set({ activity: `Anthropic's API is busy · retrying (${m.attempt} of ${m.max_retries})` });
        } else if (m.subtype === "status" && m.permissionMode) {
          this.set({ permissionMode: m.permissionMode });
        }
        return;
      case "stream_event": {
        const ev = m.event as { type: string; content_block?: { type: string; name?: string; id?: string }; delta?: { type: string; text?: string } };
        if (ev.type === "content_block_start") {
          const t = ev.content_block?.type;
          if (t === "thinking" || t === "redacted_thinking") this.set({ state: "thinking", activity: null });
          else if (t === "text") this.set({ state: "writing", activity: null });
          else if (t === "tool_use" && ev.content_block?.name) {
            this.toolNames.set(ev.content_block.id ?? "", ev.content_block.name);
            this.set({ state: "running-tool", activity: describeActivity(ev.content_block.name, {}) });
          }
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.streamText += ev.delta.text;
          this.queueStreamEmit();
        } else if (ev.type === "message_start") {
          this.clearStream();
          // Each API call in a turn starts its own count; the turn's total adds them up.
          this.turnDone += this.msgTokens;
          this.msgTokens = 0;
        } else if (ev.type === "message_delta") {
          const out = (m.event as { usage?: { output_tokens?: number } }).usage?.output_tokens;
          if (typeof out === "number") {
            this.msgTokens = out;
            this.set({ turnTokens: this.turnDone + this.msgTokens });
          }
        }
        return;
      }
      case "assistant": {
        this.lastWriteAt = Date.now();
        // The finished message is now in the transcript; stop showing the streamed copy.
        this.clearStream();
        if (this.status.streamingText) this.set({ streamingText: "" });
        if (m.context_usage?.percentage != null) this.set({ contextPercent: Math.round(m.context_usage.percentage) });
        if (m.error) this.set({ error: { title: assistantErrorTitle(m.error), body: assistantErrorBody(m.error) } });
        const blocks = (m.message?.content ?? []) as { type: string; name?: string; input?: Record<string, unknown> }[];
        const tool = [...blocks].reverse().find((b) => b.type === "tool_use");
        if (tool?.name) this.set({ state: "running-tool", activity: describeActivity(tool.name, tool.input ?? {}) });
        return;
      }
      case "user":
        // Tool results and the messages handed over: the queue only changes in handOver().
        this.lastWriteAt = Date.now();
        return;
      case "result": {
        this.lastWriteAt = Date.now();
        // A shell record taking its place in the transcript: no turn ran, nothing ends.
        if (this.quietResults > 0 && m.subtype === "success" && m.num_turns === 0) {
          this.quietResults--;
          if (this.mergeable > 0) this.mergeable--;
          return;
        }
        // A turn ended: records handed over before its message and still unreported were
        // merged into it. Records handed over after it (say, after a Stop) still report.
        this.quietResults = Math.max(0, this.quietResults - this.mergeable);
        this.mergeable = 0;
        this.clearStream();
        if (m.subtype === "success") this.set({ state: "idle", activity: null, streamingText: "" });
        else {
          const errors = "errors" in m && Array.isArray(m.errors) ? m.errors.join(" ") : "";
          this.set({ state: "error", activity: null, streamingText: "", error: { title: "Claude stopped before finishing", body: plainError(errors || m.subtype) } });
        }
        // The turn is over: the next follow-up, if any, goes to Claude Code now.
        this.nextFollowUp();
        void this.refreshContext();
        return;
      }
      default:
        return;
    }
  }

  private async refreshContext() {
    try {
      const u = await this.q?.getContextUsage();
      if (u && typeof u.percentage === "number") this.set({ contextPercent: Math.round(u.percentage) });
    } catch {}
  }

  // ------------------------------------------------------------ permissions

  private askPermission(toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const requestId = o.toolUseID || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const command = typeof input.command === "string" ? input.command : null;
    // Destructive: what the command or tool would destroy can be read from it, or
    // Claude Code itself asks for a prompt that opens on No (defaultToNo).
    // Writing over a file only counts when there is a file there to lose.
    const verdict = classifyTool(toolName, input, this.cwd, { exists: (p) => fs.existsSync(p) });
    const destructive = verdict.destructive || !!o.defaultToNo;
    const folder = path.basename(this.cwd);
    const shell = SHELLS[toolName];
    const file = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    let title = o.title || `Allow ${o.displayName ?? toolName}?`;
    let what = o.displayName || toolName;
    let body: string | null = command;
    if (shell) title = verdict.deletesFiles ? "Allow a command that permanently deletes files?" : verdict.destructive ? "Allow a command that can't be undone?" : destructive ? "Allow a risky command?" : "Allow Claude to run a command?";
    else if (toolName === "Read" || toolName === "NotebookRead") {
      title = `Allow Claude to read ${short(file || "a file")}?`;
      what = "Read file";
      body = file || null;
    } else if (toolName === "Grep" || toolName === "Glob") {
      title = `Allow Claude to search ${file ? short(file) : "outside this folder"}?`;
      what = "Search";
      body = [String(input.pattern ?? ""), file].filter(Boolean).join("\n") || null;
    } else if (toolName === "Write") {
      title = `Allow Claude to write ${short(file || "a file")}?`;
      what = "Write file";
      body = file || null;
    } else if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
      title = `Allow Claude to edit ${short(file || "a file")}?`;
      what = "Edit file";
      body = file || null;
    } else if (toolName === "WebFetch") {
      const url = String(input.url ?? "");
      title = `Allow Claude to open ${url.replace(/^https?:\/\//, "").split("/")[0] || "a web page"}?`;
      what = "Web page";
      body = url || null;
    } else if (toolName.startsWith("mcp__")) {
      title = `Allow Claude to use ${serverName(toolName)}?`;
      what = serverName(toolName);
      body = `${toolName.split("__")[2] ?? toolName}\n${JSON.stringify(input, null, 2).slice(0, 1200)}`;
    }
    // Only a real sentence is worth showing under the request. decisionReason is
    // Claude Code's internal explanation (raw paths, rule names): never shown.
    const sentence = (t: unknown) => (typeof t === "string" && /\s/.test(t.trim()) && t.trim().length > 12 && t.trim().length <= 300 ? t.trim() : null);
    const consequence = verdict.consequence ?? (verdict.destructive ? destructiveFallback(input.description) : (sentence(input.description) ?? sentence(o.description) ?? (destructive ? "Check it carefully before allowing it." : null)));
    const request: PermissionRequest = {
      requestId,
      conversationId: this.id ?? "",
      toolName,
      title,
      context: [shell ?? what, `in ${folder}`, this.opts.machine].join("  ·  "),
      body,
      consequence,
      destructive,
      allowAlways: !destructive && !o.suppressAlwaysAllowRule && !!o.suggestions?.length,
      createdAt: new Date().toISOString(),
    };
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { request, input, suggestions: o.suggestions ?? [], resolve });
      this.permissionQueue.push(requestId);
      o.signal.addEventListener("abort", () => this.respond(requestId, "deny", true));
      this.showNextPermission();
    });
  }

  private showNextPermission() {
    const next = this.permissionQueue.find((id) => this.pending.has(id));
    const p = next ? this.pending.get(next)! : null;
    this.set({ permission: p?.request ?? null, state: p ? "waiting-approval" : this.status.state === "waiting-approval" ? "running-tool" : this.status.state });
    if (p) this.emit("permission", p.request);
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  respond(requestId: string, answer: Decision, aborted = false): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    // The window can only ask for what the card offered: "Always allow" exists only
    // where it was shown (never on a destructive request); anything else is a No.
    let decision: Decision = isDecision(answer) ? answer : "deny";
    if (decision === "allow-always" && (!p.request.allowAlways || p.request.destructive)) {
      log("chat", `"Always allow" was not offered for ${p.request.toolName}; treated as Deny`);
      decision = "deny";
    }
    this.pending.delete(requestId);
    this.permissionQueue = this.permissionQueue.filter((id) => id !== requestId);
    if (decision === "deny") p.resolve({ behavior: "deny", message: aborted ? "Cancelled." : "The user denied this in the Conversations app.", decisionClassification: "user_reject" });
    else
      p.resolve({
        behavior: "allow",
        updatedInput: p.input,
        updatedPermissions: decision === "allow-always" ? p.suggestions : undefined,
        decisionClassification: decision === "allow-always" ? "user_permanent" : "user_temporary",
      });
    this.showNextPermission();
    return true;
  }

  // ------------------------------------------------------------ controls

  async interrupt() {
    // Follow-ups never reached Claude Code (see send), so Stop cancels them too. A
    // command's record is not a request: the command has run, so it stays queued
    // and is written once the stopped turn has ended (never in the middle of it).
    this.followUps = this.followUps.filter((f) => "shell" in f);
    this.clearStream();
    this.set({ queued: this.followUps.map(followLabel) });
    try {
      for (const id of [...this.pending.keys()]) this.respond(id, "deny");
      await this.q?.interrupt();
      this.set({ state: "idle", activity: null, streamingText: "", queued: this.followUps.map(followLabel) });
    } catch (e) {
      log("chat", `interrupt failed: ${(e as Error).message}`);
    }
  }

  /** Waits (up to `ms`) until the command records handed over are in the transcript, before the session is closed. */
  async settle(ms = 3000) {
    if (!this.busy) this.flushRecords();
    const t0 = Date.now();
    while (this.quietResults > 0 && !this.ended && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  }

  async setModel(model: string) {
    try {
      await this.q?.setModel(model);
      this.set({ model });
    } catch (e) {
      log("chat", `setModel failed: ${(e as Error).message}`);
    }
  }

  /** A new effort level for the rest of the session, as /effort sets it. */
  async setEffort(level: EffortLevel) {
    try {
      await this.q?.applyFlagSettings({ effortLevel: level });
      this.opts.effort = level;
    } catch (e) {
      log("chat", `setEffort failed: ${(e as Error).message}`);
    }
  }

  async commands() {
    try {
      const list = toCommands((await this.q?.supportedCommands()) ?? []);
      rememberCommands(this.cwd, list);
      return list;
    } catch {
      return [];
    }
  }

  async setPermissionMode(mode: PermissionMode) {
    try {
      await this.q?.setPermissionMode(mode);
      this.set({ permissionMode: mode });
    } catch (e) {
      log("chat", `setPermissionMode failed: ${(e as Error).message}`);
    }
  }

  /** The MCP servers this session has, as /mcp would list them. */
  async mcpStatus(): Promise<McpServerInfo[]> {
    return toMcpInfo((await this.q?.mcpServerStatus()) ?? []);
  }

  /** Reconnects one MCP server in this session (throws with Claude Code's reason when it can't). */
  async mcpReconnect(name: string): Promise<void> {
    this.lastActivity = Date.now();
    await this.q?.reconnectMcpServer(name);
  }

  /** Turns one MCP server on or off, as /mcp enable and disable do. */
  async mcpToggle(name: string, enabled: boolean): Promise<void> {
    this.lastActivity = Date.now();
    await this.q?.toggleMcpServer(name, enabled);
  }

  async models(): Promise<ModelChoice[]> {
    try {
      const list = toChoices((await this.q?.supportedModels()) ?? []);
      remember(list);
      return list;
    } catch {
      return [];
    }
  }

  close() {
    if (this.ended) return;
    this.input.close();
    try {
      this.q?.close();
    } catch {}
    this.finish(null);
  }
}

function assistantErrorTitle(e: string): string {
  return (
    {
      authentication_failed: "Claude Code isn't signed in on this PC",
      rate_limit: "You've reached your usage limit for now",
      overloaded: "Claude stopped before running anything",
      server_error: "Claude stopped before finishing",
      billing_error: "Claude Code can't bill this account",
    }[e] ?? "Claude stopped before finishing"
  );
}

function assistantErrorBody(e: string): string {
  return (
    {
      authentication_failed: "Open a terminal, run claude and sign in, then try again. The conversation is saved up to here.",
      rate_limit: "The conversation is saved up to here. Try again when your limit resets.",
      overloaded: "Anthropic's API was overloaded and Claude Code's automatic retries ran out. The conversation is saved up to here.",
      server_error: "Anthropic's API returned an error. The conversation is saved up to here.",
    }[e] ?? "The conversation is saved up to here."
  );
}

function plainError(msg: string): string {
  const m = msg.trim();
  if (/ENOENT|not found|spawn/i.test(m)) return "Claude Code could not be started on this PC. Check that it is installed, then try again.";
  if (/auth|login|401/i.test(m)) return "Claude Code isn't signed in. Open a terminal, run claude and sign in.";
  return `${m.slice(0, 280)}${m.length > 280 ? "…" : ""} The conversation is saved up to here.`;
}
