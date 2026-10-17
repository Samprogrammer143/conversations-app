// In-app chat: one ChatSession per conversation, plus the rules around them.
// - One writer at a time. A conversation is never started twice (a start is
//   registered before anything is awaited), never sent to while a Claude Code
//   terminal on this PC has it open (checked before every start and every send),
//   and the newest copy is fetched before resuming.
// - A start in flight can be called off: Stop, and handing the conversation to a
//   terminal (release), cancel it, and no session is created afterwards.
// - Approvals while the window is closed: the request is pinned in the tray,
//   the tray icon gets a badge, and one Windows notification is raised.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { Attachment, ChatStatus, McpPanelData, McpServerInfo, PermissionRequest, SlashCommandInfo } from "../../shared/types";
import { probeMcp } from "./mcp";
import { commandsFor, knownModels, type ModelChoice } from "./models";
import type { Decision, EffortLevel, PermissionMode } from "../validate";
import { ChatSession, type SessionOptions } from "./session";
import { runShell, shellMessages, type RunningShell } from "./shell";
import { log } from "../log";

export interface ChatManagerLike extends EventEmitter {
  isRunning(id: string): boolean;
  runningIds(): Set<string>;
  stop(id: string): Promise<void>;
  status(id: string): ChatStatus | null;
  pendingPermissions(): PermissionRequest[];
}

export interface StartArgs {
  /** Existing conversation id, or null for a new chat. */
  id: string | null;
  text: string;
  cwd: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  effort?: EffortLevel | null;
  attachments?: Attachment[];
  /** A "!" command's record (input, output) to write instead of a message: no turn starts. */
  shell?: [string, string];
  /** Start Claude Code with nothing to send (for /mcp): no turn starts. */
  idle?: boolean;
}

/** What the manager needs from a session: a ChatSession, or a stand-in in tests. */
export interface SessionLike extends EventEmitter {
  id: string | null;
  readonly cwd: string;
  status: ChatStatus;
  readonly alive: boolean;
  readonly busy: boolean;
  lastActivity: number;
  lastWriteAt: number;
  /** Something has been handed to it (a message or a command's record), not just started for /mcp. */
  readonly used?: boolean;
  start(first: string, attachments?: Attachment[]): void;
  startShell?(record: [string, string]): void;
  startIdle?(): void;
  send(text: string, attachments?: Attachment[]): void;
  appendShell?(record: [string, string], label: string): void;
  /** Waits until the records handed over are written (before a close). */
  settle?(ms?: number): Promise<void>;
  mcpStatus?(): Promise<McpServerInfo[]>;
  mcpReconnect?(name: string): Promise<void>;
  mcpToggle?(name: string, enabled: boolean): Promise<void>;
  pendingRequests(): PermissionRequest[];
  respond(requestId: string, decision: Decision): boolean;
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setEffort?(level: EffortLevel): Promise<void>;
  commands?(): Promise<SlashCommandInfo[]>;
  models(): Promise<ModelChoice[]>;
  close(): void;
}

/** What preparing a resume decided: the folder Claude Code must start in to find the transcript, or why it can't go ahead. */
export type ResumePrep = void | { cwd?: string; refuse?: string };

export interface ManagerDeps {
  claudePath: () => string | null;
  machine: () => string;
  /** The conversation's transcript on this PC, if there is one. */
  localTranscript: (id: string) => string | null;
  /** Brings the newest copy from GitHub before continuing, and says where Claude Code must start to find it. */
  syncBeforeResume: (id: string, cwd: string) => Promise<ResumePrep>;
  /** Claude Code's registry of open sessions: is a terminal on this PC in it? null when there is no registry. */
  terminalHas?: (id: string) => Promise<boolean | null>;
  createSession?: (opts: SessionOptions) => SessionLike;
  /** Runs a "!" command (tests use a stand-in). */
  runShell?: (command: string, cwd: string) => RunningShell;
  /** The MCP servers a chat in a folder would have (tests use a stand-in). */
  probeMcp?: (claudePath: string, cwd: string) => Promise<McpServerInfo[]>;
}

/** `ran`: a "!" command ran, so the window must not offer it to run again. */
export type SendResult = { ok: boolean; conversationId?: string; err?: string; ran?: boolean };

export const OPEN_IN_TERMINAL = "This conversation is open in a terminal on this PC. Carry on there, or close it first.";
export const STILL_STARTING = "Claude Code is still starting for this conversation. Send it again in a moment.";
export const STOPPED_BEFORE_START = "Stopped before Claude Code started.";

const LIVE_MS = 2 * 60 * 1000;
const IDLE_CLOSE_MS = 15 * 60 * 1000;
/**
 * A Claude Code started only for /mcp and never used closes sooner: while it is open,
 * sync leaves the conversation alone, so it should not hold it for long.
 */
const UNUSED_CLOSE_MS = 2 * 60 * 1000;

/** A start in flight: shown as "starting", and called off by Stop or release. */
interface Start {
  status: ChatStatus;
  cancelled: boolean;
  done: Promise<SendResult>;
}

export const NEW_CHAT_STARTING = "A new chat is already starting in this folder. Send it again in a moment.";
export const SHELL_BUSY = "A command is already running in this conversation. Stop it or wait for it to finish.";
export const SHELL_WHILE_WORKING = "Claude is working in this conversation. Run the command when it finishes, or press Stop first.";
export const SHELL_RUNNING = "A command is running in this conversation. Send your message when it finishes, or press Stop.";

/** A "!" command running now. */
interface ShellRun {
  run: RunningShell;
  /** The folder asked for (a new chat's, for the one-new-chat-per-folder rule). */
  cwd: string;
  id: string | null;
  status: ChatStatus;
  /** Why its record will not be written (handed to a terminal, the app quitting). */
  cancelled: string | null;
}

const draftShellKey = (draftKey: string) => `shell:${draftKey.toLowerCase()}`;

/** "! gcloud auth login": how a command shows in the activity line and the queue. */
const shellLabel = (command: string) => {
  const one = command.trim().split("\n")[0];
  return `! ${one.length > 60 ? `${one.slice(0, 59)}…` : one}`;
};

export class ChatManager extends EventEmitter implements ChatManagerLike {
  private sessions = new Map<string, SessionLike>();
  /** Conversations whose Claude Code is starting: registered before any await. */
  private starting = new Map<string, Start>();
  /**
   * New chats that have no conversation id yet (Claude Code gives one with its
   * first message, up to 60 s in): tracked under a draft id so Stop, release,
   * quit, approvals and the sync skip list all see them, and a second new chat
   * in the same folder waits.
   */
  private drafts = new Map<string, { session: SessionLike; cwd: string }>();
  private draftSeq = 0;
  /** When the app last wrote each conversation, kept after its session ends. */
  private lastWrites = new Map<string, number>();
  /** /mcp looks in progress, by folder. */
  private mcpProbes = new Map<string, Promise<McpServerInfo[]>>();
  /** "!" commands running now, by conversation id (or a new chat's draft key). */
  private shells = new Map<string, ShellRun>();
  private reaper: NodeJS.Timeout;

  constructor(private deps: ManagerDeps) {
    super();
    // Sessions that sit idle are closed; continuing later resumes them.
    this.reaper = setInterval(() => {
      for (const [id, s] of this.sessions) {
        if (!s.busy && Date.now() - s.lastActivity > (s.used === false ? UNUSED_CLOSE_MS : IDLE_CLOSE_MS)) {
          s.close();
          this.sessions.delete(id);
        }
      }
    }, 60_000);
    this.reaper.unref?.();
  }

  isRunning(id: string) {
    if (this.starting.has(id) || this.shells.has(id)) return true;
    const s = this.sessions.get(id) ?? this.drafts.get(id)?.session;
    return !!s && s.alive && s.busy;
  }

  runningIds() {
    const busy = [...this.sessions].filter(([, s]) => s.alive && s.busy).map(([id]) => id);
    const draftsBusy = [...this.drafts].filter(([, d]) => d.session.alive && d.session.busy).map(([id]) => id);
    return new Set([...busy, ...draftsBusy, ...this.starting.keys(), ...this.shells.keys()]);
  }

  /** Conversations the app has a Claude Code session for (running or idle), or is starting one for. Draft ids stand for new chats without an id yet. */
  openIds(): Set<string> {
    const alive = [...this.sessions].filter(([, s]) => s.alive).map(([id]) => id);
    const drafts = [...this.drafts].filter(([, d]) => d.session.alive).map(([id]) => id);
    return new Set([...alive, ...drafts, ...this.starting.keys()]);
  }

  /** New chats that are starting (no conversation id yet) in this folder. */
  draftsIn(cwd: string): string[] {
    const k = cwd.toLowerCase();
    return [...this.drafts].filter(([, d]) => d.session.alive && d.cwd.toLowerCase() === k).map(([id]) => id);
  }

  /** Is the app's own session for it alive (running or idle)? */
  isOpenInApp(id: string): boolean {
    return this.starting.has(id) || !!this.sessions.get(id)?.alive || !!this.drafts.get(id)?.session.alive;
  }

  /** When the app's own session last wrote this conversation, or ended (0 if it never had one). */
  lastAppWriteAt(id: string): number {
    return Math.max(this.lastWrites.get(id) ?? 0, this.sessions.get(id)?.lastWriteAt ?? 0);
  }

  status(id: string) {
    return this.shells.get(id)?.status ?? this.starting.get(id)?.status ?? this.sessions.get(id)?.status ?? this.drafts.get(id)?.session.status ?? null;
  }

  /**
   * "!" in the composer: runs the command in the conversation's folder now, then
   * writes it and its output into the conversation the way the CLI's bash mode
   * does. No turn starts; Claude sees it with your next message. A new chat
   * (no id) is started with the record.
   */
  async shell(args: StartArgs & { command: string; draftKey?: string }): Promise<SendResult> {
    const claudePath = this.deps.claudePath();
    if (!claudePath) return { ok: false, err: "Chat needs Claude Code on this PC" };
    const id = args.id;
    const key = id ?? draftShellKey(args.draftKey ?? args.cwd);
    // Checked before and after the await, and the command registered before the next one.
    const refuse = (): string | null => {
      if (this.shells.has(key)) return SHELL_BUSY;
      if (id && this.starting.has(id)) return STILL_STARTING;
      if (id && this.isRunning(id)) return SHELL_WHILE_WORKING;
      if (!id && (this.draftsIn(args.cwd).length || this.draftShellIn(args.cwd))) return NEW_CHAT_STARTING;
      return null;
    };
    const early = refuse();
    if (early) return { ok: false, err: early };
    // A terminal writing it would make two writers.
    if (id && (await this.openInTerminal(id))) return { ok: false, err: OPEN_IN_TERMINAL };
    const late = refuse();
    if (late) return { ok: false, err: late };
    const live = id ? this.sessions.get(id) : undefined;
    const cwd = live?.alive ? live.cwd : args.cwd;
    const label = shellLabel(args.command);
    const base: ChatStatus = live?.alive
      ? live.status
      : { conversationId: id ?? "", state: "idle", activity: null, model: null, permissionMode: args.permissionMode ?? "default", contextPercent: null, queued: [], error: null, permission: null, streamingText: "", turnTokens: null };
    const run = this.deps.runShell ? this.deps.runShell(args.command, cwd) : runShell(args.command, cwd);
    const entry: ShellRun = { run, cwd: args.cwd, id, cancelled: null, status: { ...base, conversationId: id ?? "", state: "running-tool", activity: `Running ${label}`, error: null } };
    this.shells.set(key, entry);
    if (id) this.emit("status", entry.status);
    // The command counts as running until its record is written: a message sent
    // in between would otherwise reach Claude ahead of it, or start a session
    // that the record then can't join.
    const ran = (err: string): SendResult => ({ ok: false, ran: true, err: `The command ran, but what it printed couldn't be added to the conversation: ${err}` });
    try {
      const r = await run.done;
      // From here the command has run: a failure must never offer it to run again.
      if (entry.cancelled) return ran(entry.cancelled);
      const record = shellMessages(args.command, r);
      entry.status = { ...entry.status, activity: "Adding the output to the conversation" };
      if (id) this.emit("status", entry.status);
      const res = id ? await this.deliverShell(id, record, label, args, claudePath, entry) : await this.startNew({ ...args, text: "", shell: record }, claudePath);
      return res.ok ? res : ran(res.err ?? "Claude Code didn't start.");
    } finally {
      this.shells.delete(key);
      if (id) this.emit("status", this.status(id) ?? { ...base, state: "idle", activity: null });
    }
  }

  /** Writes a command's record into a conversation: the open session, one starting now, or one resumed for it. */
  private async deliverShell(id: string, record: [string, string], label: string, args: StartArgs, claudePath: string, entry: ShellRun): Promise<SendResult> {
    // A start already under way (a resume that began before the command): let it finish first.
    const start = this.starting.get(id);
    if (start) await start.done;
    if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
    if (entry.cancelled) return { ok: false, err: entry.cancelled };
    // Looked up after the awaits: the session may have ended meanwhile.
    const s = this.sessions.get(id);
    if (s?.alive && s.appendShell) {
      s.appendShell(record, label);
      this.emit("owned", id, s.cwd);
      return { ok: true, conversationId: id };
    }
    if (this.starting.has(id)) return { ok: false, err: STILL_STARTING };
    return this.resume(id, { ...args, text: "", shell: record }, claudePath);
  }

  /** A command running for a new chat (no conversation yet) in this folder. */
  private draftShellIn(cwd: string): boolean {
    const k = cwd.toLowerCase();
    return [...this.shells.values()].some((e) => !e.id && e.cwd.toLowerCase() === k);
  }

  /**
   * The /mcp panel: the running session's servers when the chat is open in the app
   * (they can be reconnected there), otherwise what a chat in its folder would have.
   */
  async mcp(id: string | null, cwd: string, opts: Pick<StartArgs, "model" | "effort" | "permissionMode"> = {}): Promise<McpPanelData> {
    const claudePath = this.deps.claudePath();
    if (!claudePath) throw new Error("Claude Code isn't installed on this PC");
    let note: string | undefined;
    if (id) {
      // As in a terminal, /mcp works on the chat's running Claude Code: it is started
      // (nothing is sent, no turn runs) so its servers can be reconnected and turned off.
      const live = await this.ensureLive(id, cwd, opts, claudePath);
      if (live.s?.mcpStatus) return { live: true, servers: await this.settledStatus(live.s, live.fresh) };
      note = live.err;
    }
    // One look per folder at a time: asking again while it runs gets the same answer.
    const k = cwd.toLowerCase();
    let p = this.mcpProbes.get(k);
    if (!p) {
      p = (this.deps.probeMcp ?? probeMcp)(claudePath, cwd).finally(() => this.mcpProbes.delete(k));
      this.mcpProbes.set(k, p);
    }
    return { live: false, servers: await p, note };
  }

  /** The chat's Claude Code, running: the one open now, one starting, or one started now with nothing to send. */
  private async ensureLive(id: string, cwd: string, opts: Pick<StartArgs, "model" | "effort" | "permissionMode">, claudePath: string): Promise<{ s?: SessionLike; fresh?: boolean; err?: string }> {
    const open = this.sessions.get(id);
    if (open?.alive) return { s: open };
    const start = this.starting.get(id);
    if (start) await start.done;
    else {
      const r = await this.resume(id, { id, text: "", cwd, idle: true, model: opts.model ?? null, effort: opts.effort ?? null, permissionMode: opts.permissionMode ?? "default" }, claudePath);
      if (!r.ok) return { err: r.err === OPEN_IN_TERMINAL ? "This chat is open in a terminal on this PC: use /mcp there, or close it first." : r.err };
    }
    const s = this.sessions.get(id);
    return s?.alive ? { s, fresh: !start } : { err: "Claude Code didn't start for this chat." };
  }

  /** Right after a start most servers are still connecting: wait a little for them to settle. */
  private async settledStatus(s: SessionLike, fresh?: boolean, waitMs = 10_000): Promise<McpServerInfo[]> {
    let list = await s.mcpStatus!();
    const t0 = Date.now();
    while (fresh && list.some((x) => x.status === "pending") && Date.now() - t0 < waitMs && s.alive) {
      await new Promise((r) => setTimeout(r, 500));
      list = await s.mcpStatus!();
    }
    return list;
  }

  /** Reconnect, enable or disable one MCP server in the chat's running session. */
  async mcpAction(id: string, name: string, action: "reconnect" | "enable" | "disable", cwd = "", opts: Pick<StartArgs, "model" | "effort" | "permissionMode"> = {}): Promise<{ ok: boolean; err?: string; servers?: McpServerInfo[] }> {
    let s = this.sessions.get(id);
    if (!s?.alive) {
      // It stopped since the panel opened (idle for a while): start it again for this.
      const claudePath = this.deps.claudePath();
      if (!claudePath) return { ok: false, err: "Chat needs Claude Code on this PC" };
      const live = await this.ensureLive(id, s?.cwd ?? cwd, opts, claudePath);
      if (!live.s) return { ok: false, err: live.err ?? "Claude Code didn't start for this chat." };
      s = live.s;
    }
    if (!s.mcpReconnect || !s.mcpToggle || !s.mcpStatus) return { ok: false, err: "This chat's Claude Code can't change its servers." };
    try {
      if (action === "reconnect") await s.mcpReconnect(name);
      else await s.mcpToggle(name, action === "enable");
      return { ok: true, servers: await s.mcpStatus() };
    } catch (e) {
      const why = (e as Error).message.replace(/\s+/g, " ").trim().slice(0, 300);
      return { ok: false, err: why || `Couldn't ${action} ${name}`, servers: await s.mcpStatus().catch(() => undefined) };
    }
  }

  /** Stop for a command running in a new chat, which has no conversation id to stop by. */
  stopDraftShell(draftKey: string) {
    this.shells.get(draftShellKey(draftKey))?.run.stop();
  }

  pendingPermissions(): PermissionRequest[] {
    return [...this.sessions.values(), ...[...this.drafts.values()].map((d) => d.session)].flatMap((s) => s.pendingRequests());
  }

  /** Is a Claude Code terminal on this PC using it (not this app)? */
  async openInTerminal(id: string): Promise<boolean> {
    try {
      const fromRegistry = this.deps.terminalHas ? await this.deps.terminalHas(id) : null;
      if (fromRegistry !== null) return fromRegistry;
    } catch (e) {
      log("chat", `session registry unreadable: ${(e as Error).message}`);
    }
    // No registry (older Claude Code): a transcript written in the last two
    // minutes, and not by this app, counts as open.
    const p = this.deps.localTranscript(id);
    if (!p) return false;
    try {
      const mtime = fs.statSync(p).mtimeMs;
      const ours = this.sessions.get(id)?.lastWriteAt ?? 0;
      return Date.now() - mtime < LIVE_MS && mtime > ours + 3000;
    } catch {
      return false;
    }
  }

  async send(args: StartArgs): Promise<SendResult> {
    const claudePath = this.deps.claudePath();
    if (!claudePath) return { ok: false, err: "Chat needs Claude Code on this PC" };
    if (!args.id) return this.startNew(args, claudePath);
    const id = args.id;
    // While a "!" command runs here, a message would race its record into the conversation.
    if (this.shells.has(id)) return { ok: false, err: SHELL_RUNNING };
    if (this.starting.has(id)) return { ok: false, err: STILL_STARTING };
    if (this.sessions.get(id)?.alive) {
      // Someone may have resumed it in a terminal since the app started its session.
      if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
      const s = this.sessions.get(id);
      if (s?.alive) {
        s.send(args.text, args.attachments ?? []);
        this.emit("owned", id, s.cwd);
        return { ok: true, conversationId: id };
      }
      // It ended while we looked: start it again below.
    }
    return this.resume(id, args, claudePath);
  }

  private resume(id: string, args: StartArgs, claudePath: string): Promise<SendResult> {
    // Registered before anything is awaited: a second send while this one is
    // starting is refused instead of starting a second Claude Code.
    if (this.starting.has(id)) return Promise.resolve({ ok: false, err: STILL_STARTING });
    if (this.sessions.get(id)?.alive) return this.send(args);
    const start: Start = {
      status: {
        conversationId: id,
        state: "starting",
        activity: "Starting Claude Code",
        model: null,
        permissionMode: args.permissionMode ?? "default",
        contextPercent: null,
        queued: [],
        error: null,
        permission: null,
        streamingText: "",
        turnTokens: null,
      },
      cancelled: false,
      done: Promise.resolve({ ok: false }),
    };
    this.starting.set(id, start);
    this.emit("status", start.status);
    start.done = this.runStart(id, args, claudePath, start);
    return start.done;
  }

  private async runStart(id: string, args: StartArgs, claudePath: string, start: Start): Promise<SendResult> {
    let started = false;
    try {
      if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
      if (start.cancelled) return { ok: false, err: STOPPED_BEFORE_START };
      let cwd = args.cwd;
      try {
        const prep = await this.deps.syncBeforeResume(id, args.cwd);
        if (prep?.refuse) return { ok: false, err: prep.refuse };
        if (prep?.cwd) cwd = prep.cwd;
      } catch (e) {
        log("chat", `sync before resume failed: ${(e as Error).message}`);
      }
      if (start.cancelled) return { ok: false, err: STOPPED_BEFORE_START };
      // The download can take a while: look again before Claude Code starts writing.
      if (await this.openInTerminal(id)) return { ok: false, err: OPEN_IN_TERMINAL };
      // Nothing is awaited from here on, so a Stop or release can no longer slip in.
      if (start.cancelled) return { ok: false, err: STOPPED_BEFORE_START };
      const s = this.create({ resume: id, cwd, claudePath, machine: this.deps.machine(), model: args.model ?? null, permissionMode: args.permissionMode ?? "default", effort: args.effort ?? null });
      this.attach(s);
      this.sessions.set(id, s);
      this.starting.delete(id);
      if (args.shell && s.startShell) s.startShell(args.shell);
      // Nothing to send: never an empty message.
      else if (args.idle) s.startIdle?.();
      else s.start(args.text, args.attachments ?? []);
      started = true;
      // Started only to look at its servers: it becomes the app's chat when something is sent.
      if (!args.idle) this.emit("owned", id, cwd);
      return { ok: true, conversationId: id };
    } finally {
      if (!started) {
        if (this.starting.get(id) === start) this.starting.delete(id);
        // The start is over: the window's composer comes back.
        this.emit("status", { ...start.status, state: "idle", activity: null } satisfies ChatStatus);
        this.emit("changed");
        this.emit("closed", id);
      }
    }
  }

  private async startNew(args: StartArgs, claudePath: string): Promise<SendResult> {
    // One new chat at a time per folder: a second Enter during the start would
    // otherwise start a second Claude Code in the same place.
    // A command running for a new chat here becomes that chat: this message would start a second one.
    if (this.draftsIn(args.cwd).length || (!args.shell && this.draftShellIn(args.cwd))) return { ok: false, err: NEW_CHAT_STARTING };
    const draftId = `draft:${++this.draftSeq}`;
    const s = this.create({ cwd: args.cwd, claudePath, machine: this.deps.machine(), model: args.model ?? null, permissionMode: args.permissionMode ?? "default", effort: args.effort ?? null });
    // Tracked from before the first await, under a draft id until Claude Code names it.
    this.drafts.set(draftId, { session: s, cwd: args.cwd });
    this.attach(s);
    if (args.shell && s.startShell) s.startShell(args.shell);
    else s.start(args.text, args.attachments ?? []);
    // A new chat gets its id from Claude Code's first message.
    const id = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 60_000);
      s.once("created", (newId: string) => {
        clearTimeout(timer);
        resolve(newId);
      });
      s.once("ended", () => {
        clearTimeout(timer);
        resolve(s.id);
      });
    });
    this.drafts.delete(draftId);
    if (!id || !s.alive) {
      s.close();
      return { ok: false, err: s.status.error?.body ?? "Claude Code didn't start" };
    }
    this.sessions.set(id, s);
    this.emit("created", id, args.cwd);
    this.emit("owned", id, args.cwd);
    return { ok: true, conversationId: id };
  }

  /** The session behind a conversation id or a draft id. */
  private sessionFor(id: string): SessionLike | undefined {
    return this.sessions.get(id) ?? this.drafts.get(id)?.session;
  }

  private create(opts: SessionOptions): SessionLike {
    return this.deps.createSession ? this.deps.createSession(opts) : new ChatSession(opts);
  }

  private attach(s: SessionLike) {
    s.on("status", (st: ChatStatus) => {
      // While a "!" command runs, the window keeps showing it (with the session's other details).
      const sh = st.conversationId ? this.shells.get(st.conversationId) : undefined;
      if (sh) {
        sh.status = { ...st, state: "running-tool", activity: sh.status.activity, error: null };
        this.emit("status", sh.status);
      } else this.emit("status", st);
    });
    s.on("permission", (p: PermissionRequest) => this.emit("permission", p));
    // Claude Code moved the session to a new conversation: the app keeps writing where it writes.
    s.on("rekeyed", (before: string, after: string) => {
      if (this.sessions.get(before) === s) {
        this.sessions.delete(before);
        this.sessions.set(after, s);
      }
      this.lastWrites.set(before, Date.now());
      this.emit("owned", after, s.cwd);
      this.emit("rekeyed", before, after);
      this.emit("changed");
    });
    s.on("ended", () => {
      if (s.id) this.lastWrites.set(s.id, Math.max(s.lastWriteAt, Date.now()));
      if (s.id && this.sessions.get(s.id) === s && s.status.state !== "error") this.sessions.delete(s.id);
      this.emit("changed");
      // Sync left it alone while the app had it open: it can be brought up to date now.
      if (s.id) this.emit("closed", s.id);
    });
  }

  /** Calls off a start in flight and waits until it has given up. */
  private async cancelStart(id: string): Promise<boolean> {
    const start = this.starting.get(id);
    if (!start) return false;
    start.cancelled = true;
    await start.done;
    return true;
  }

  /** Stop: interrupts Claude, or calls off a start that hasn't reached Claude Code yet. A new chat without an id yet is closed. */
  async stop(id: string) {
    // A "!" command running now: it ends, and what it printed so far is kept.
    const sh = this.shells.get(id);
    if (sh) {
      sh.run.stop();
      return;
    }
    if (await this.cancelStart(id)) return;
    const draft = this.drafts.get(id);
    if (draft) {
      draft.session.close();
      return;
    }
    const s = this.sessions.get(id);
    if (!s) return;
    await s.interrupt();
  }

  /**
   * Ends the app's session entirely (Open in CLI hands the conversation over;
   * delete needs no writer). A start in flight is called off first, so when this
   * returns the app has no session for it and won't start one.
   */
  async release(id: string, opts: { onlyIdle?: boolean } = {}) {
    // A command running here stops, and its record is not written: the terminal has the conversation now.
    const sh = this.shells.get(id);
    if (sh) {
      sh.cancelled = "it was opened in a terminal, so the command was stopped.";
      sh.run.stop();
      await sh.run.done.catch(() => {});
      // A record already on its way is called off with the start below, or written before the close.
    }
    await this.cancelStart(id);
    // Only an idle one (after a sign-in): something sent meanwhile keeps it going.
    if (opts.onlyIdle && this.isRunning(id)) return;
    const s = this.sessionFor(id);
    if (!s) return;
    if (s.busy) await s.interrupt();
    // Records handed over (a command that finished just now) are written before the session closes.
    await s.settle?.();
    s.close();
    this.sessions.delete(id);
    this.drafts.delete(id);
  }

  /** Ends every session that isn't working on something (after a sign-in: they start again with it). */
  async releaseIdle() {
    // Not one working on something: a turn, a start, a "!" command, a permission question.
    for (const id of [...this.sessions.keys()]) if (!this.isRunning(id)) await this.release(id, { onlyIdle: true });
  }

  respond(requestId: string, decision: Decision): boolean {
    for (const s of this.sessions.values()) if (s.respond(requestId, decision)) return true;
    for (const d of this.drafts.values()) if (d.session.respond(requestId, decision)) return true;
    return false;
  }

  async setModel(id: string, model: string) {
    await this.sessions.get(id)?.setModel(model);
  }

  async setEffort(id: string, level: EffortLevel) {
    await this.sessions.get(id)?.setEffort?.(level);
  }

  /** The commands of a live session in that folder when there is one; otherwise asked of Claude Code. */
  async commands(id: string | null, cwd: string): Promise<SlashCommandInfo[]> {
    const live = id ? this.sessions.get(id) : undefined;
    if (live?.alive && live.commands) {
      const list = await live.commands();
      if (list.length) return list;
    }
    return commandsFor(this.deps.claudePath(), cwd);
  }

  async setPermissionMode(id: string, mode: PermissionMode) {
    await this.sessions.get(id)?.setPermissionMode(mode);
  }

  /** A live session's list when there is one; otherwise the list kept on disk (refreshed in the background). */
  async models(): Promise<ModelChoice[]> {
    for (const s of this.sessions.values()) {
      const list = await s.models();
      if (list.length) return list;
    }
    return knownModels(this.deps.claudePath());
  }

  closeAll() {
    clearInterval(this.reaper);
    for (const sh of this.shells.values()) {
      sh.cancelled = "the app was closing.";
      sh.run.stop();
    }
    for (const start of this.starting.values()) start.cancelled = true;
    for (const s of this.sessions.values()) s.close();
    for (const d of this.drafts.values()) d.session.close();
    this.sessions.clear();
    this.drafts.clear();
  }
}

/** Used until Claude Code is found on this PC. */
export class NoChat extends EventEmitter implements ChatManagerLike {
  isRunning() {
    return false;
  }
  runningIds() {
    return new Set<string>();
  }
  async stop() {}
  status() {
    return null;
  }
  pendingPermissions() {
    return [];
  }
}
