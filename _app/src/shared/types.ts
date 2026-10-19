// Data shared between the main process and the window. Everything here crosses
// the IPC boundary as plain JSON.

export type Theme = "system" | "light" | "dark";

/** A project as the sidebar shows it: one per git repository, plus folders outside git. */
export interface ProjectSummary {
  id: string; // "github.com/owner/repo" or "folder:<key>"
  label: string;
  kind: "repo" | "home" | "folder";
  count: number;
  /** Where this project lives on this PC, if it does. */
  folder: string | null;
  /** Some of its conversations are in this PC's Claude folder. */
  onThisPc?: boolean;
}

export interface DeviceSummary {
  name: string;
  isThisPc: boolean;
  /** Last time this PC synced, as far as GitHub knows. */
  lastSeenAt: string | null;
  engine: number | null;
  app: string | null;
  claudeCode: string | null;
  /** "current" | "old-sync" (needs the upgrade) | "unknown" */
  status: "current" | "old-sync" | "unknown";
  color: TileColor;
  glyph: "monitor" | "laptop";
}

export type TileColor = "blue" | "indigo" | "purple" | "pink" | "orange" | "teal" | "green" | "graphite" | "brown";

export interface ConversationRow {
  id: string;
  title: string;
  /** Last line of Claude's latest reply (or the latest prompt), for the list. */
  preview: string;
  projectId: string;
  projectLabel: string;
  /** The folder name it was filed under on GitHub (e.g. a worktree folder). */
  folderLabel: string | null;
  lastAt: string | null; // newest entry
  startedAt: string | null;
  lastPc: string | null;
  pcs: string[];
  prompts: number;
  bytes: number;
  pinned: boolean;
  archived: boolean;
  /** Changed on another PC since you last opened it. */
  updated: boolean;
  /** Written to in the last two minutes (a session is running). */
  live: boolean;
  /** Running in this app right now. */
  runningHere: boolean;
  onThisPc: boolean;
  cwd: string | null;
  /** The model the conversation last used. */
  model: string | null;
}

export type ListFilter = "all" | "updated" | "live";

export interface ListQuery {
  scope:
    | { kind: "all" }
    | { kind: "pinned" }
    | { kind: "project"; id: string }
    | { kind: "device"; name: string }
    | { kind: "archived" };
  filter: ListFilter;
}

export interface ListResult {
  rows: ConversationRow[];
  counts: { all: number; updated: number; live: number };
}

export interface SidebarData {
  total: number;
  pinned: number;
  archived: number;
  projects: ProjectSummary[];
  otherFolders: { count: number; ids: string[] };
  devices: DeviceSummary[];
  pcCount: number;
}

// ------------------------------------------------------------------ transcript

export interface ImageRef {
  /** Opaque key the main process can resolve back to the image bytes. */
  key: string;
  mediaType: string;
}

export type ToolKind =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "command"
  | "web"
  | "mcp"
  | "agent"
  | "plan"
  | "skill"
  | "question"
  | "other";

export interface ToolCall {
  id: string;
  name: string;
  kind: ToolKind;
  /** Short human label, e.g. "lib/seasons.ts" or "npm test". */
  label: string;
  /** Plain-language detail (the command, the URL, the query). */
  detail: string | null;
  /** First part of the result, for the expanded view. */
  resultPreview: string | null;
  isError: boolean;
  /** You said no to it (in the app or in Claude Code). */
  denied?: boolean;
  /** Stopped while it ran (Esc or Stop). */
  interrupted?: boolean;
  /** No result yet: waiting for approval, running, or cut off. Never shown as done. */
  pending?: boolean;
  /** Server label for MCP tools ("Figma", "PostHog"). */
  server?: string;
  diff?: DiffBlock | null;
  question?: { question: string; answer: string | null } | null;
}

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
}

export interface DiffBlock {
  path: string;
  additions: number;
  removals: number;
  lines: DiffLine[];
  /** True when lines were left out to keep the block short. */
  truncated: boolean;
  /** A new file rather than an edit. */
  created?: boolean;
}

export type TranscriptItem =
  | { kind: "day"; seq: number; date: string }
  | { kind: "user"; seq: number; uuid: string; ts: string | null; text: string; images: ImageRef[]; pc: string | null; queued?: boolean }
  | { kind: "text"; seq: number; uuid: string; ts: string | null; markdown: string }
  /** A slash command or skill you ran (/context, /mcp reconnect x, /simplify), and what Claude Code printed for it. */
  | { kind: "command"; seq: number; uuid: string; ts: string | null; name: string; args: string; output: string | null; pc: string | null }
  /** A "!" command you ran (in the app or a terminal) and what it printed. */
  | { kind: "shell"; seq: number; uuid: string; ts: string | null; command: string; stdout: string | null; stderr: string | null; pc: string | null }
  | { kind: "tools"; seq: number; uuid: string; ts: string | null; summary: string; icons: ToolKind[]; calls: ToolCall[]; diffs: DiffBlock[] }
  | { kind: "thinking"; seq: number; uuid: string; ts: string | null; durationMs: number | null }
  | { kind: "meta"; seq: number; ts: string | null; model: string | null; pc: string | null; durationMs: number | null }
  | { kind: "notice"; seq: number; ts: string | null; tone: "info" | "error"; title: string; body: string | null }
  | { kind: "compact"; seq: number; ts: string | null }
  | { kind: "parts"; seq: number; ts: string | null; label: string }
  | { kind: "part"; seq: number; ts: string | null; label: string };

export interface ConversationDetail {
  row: ConversationRow;
  /** "Last on Uni PC · website-home · 2 prompts" */
  subtitle: string;
  totalItems: number;
  /** Older items are still being read from disk. */
  partial: boolean;
  bytes: number;
  folder: string | null;
  canContinue: boolean;
  /** Another PC changed it in the last 2 minutes. */
  alsoOpenOn: { pc: string; at: string } | null;
  /** How full the context was at the last reply, when the model's window is known. */
  contextPercent: number | null;
}

export interface ItemsPage {
  items: TranscriptItem[];
  /** Sequence number of the first item returned; 0 means the start was reached. */
  firstSeq: number;
  total: number;
}

// ------------------------------------------------------------------ search

export interface SearchHit {
  id: string;
  title: string;
  projectLabel: string;
  lastPc: string | null;
  lastAt: string | null;
  /** Matched text with the match wrapped in \u0001 … \u0002. */
  snippet: string | null;
  field: "title" | "prompt" | "reply" | "tool";
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** A close spelling that has hits, when this query has none. */
  suggestion: { text: string; count: number } | null;
  searchedConversations: number;
  pcCount: number;
  tookMs: number;
}

// ------------------------------------------------------------------ sync

export type SyncPhase = "idle" | "checking" | "downloading" | "uploading" | "offline" | "attention" | "paused" | "not-set-up";

export interface SyncActivity {
  at: string;
  kind: "uploaded" | "downloaded" | "saved" | "kept-both" | "failed" | "edit";
  text: string;
}

export interface SyncStatus {
  phase: SyncPhase;
  machine: string;
  /** "2 of 3 PCs up to date" */
  headline: string;
  /** "Laptop needs the new sync" / "Last synced 14:52" */
  detail: string;
  lastSyncAt: string | null;
  nextCheckInMs: number | null;
  pendingUploads: number;
  failingSince: string | null;
  lastError: string | null;
  repoSizeBytes: number | null;
  repoWebUrl: string | null;
  /** Seconds the hooks wait after a reply before uploading; null on an older sync engine. */
  uploadQuietSeconds: number | null;
  /** The cloud folder (OneDrive or similar) this PC's ~/.claude is synced by, or null when it isn't. */
  cloudSyncedClaudeDir: string | null;
  devices: DeviceSummary[];
  recent: SyncActivity[];
  paused: boolean;
}

// ------------------------------------------------------------------ app

export interface AppInfo {
  version: string;
  machine: string;
  platform: string;
  claude: { found: boolean; version: string | null; path: string | null; signedIn: boolean | null; defaultModel: string | null };
  syncSetUp: boolean;
  repo: string | null;
  firstRun: boolean;
  windowsTerminal: boolean;
}

export interface Settings {
  theme: Theme;
  windowMaterial: "mica" | "solid";
  syncAutomatically: boolean;
  checkWhileOpenSeconds: number;
  checkFromTraySeconds: number;
  uploadDelay: "after-quiet" | "fast";
  keepResumeUpToDate: boolean;
  startAtLogin: boolean;
  showArchived: boolean;
  defaultModel: string | null;
  defaultPermissionMode: "default" | "acceptEdits" | "plan" | "auto";
  folders: Record<string, string>;
  welcomed: boolean;
}

// ------------------------------------------------------------------ chat

/** An image attached to a message: pasted, dropped or picked. Sent to Claude as an image block. */
export interface Attachment {
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64, without a data: prefix. */
  data: string;
}

export interface PermissionRequest {
  requestId: string;
  conversationId: string;
  toolName: string;
  title: string;
  /** "PowerShell · in website · Home PC" */
  context: string;
  /** Command or file contents to show in the card. */
  body: string | null;
  /** Plain-language consequence, e.g. "It can't be undone." */
  consequence: string | null;
  destructive: boolean;
  allowAlways: boolean;
  createdAt: string;
}

export type ChatState = "idle" | "starting" | "thinking" | "running-tool" | "writing" | "waiting-approval" | "stopped" | "error";

export interface ChatStatus {
  conversationId: string;
  state: ChatState;
  /** "Reading lib/seasons.ts" */
  activity: string | null;
  model: string | null;
  permissionMode: string;
  contextPercent: number | null;
  queued: string[];
  error: { title: string; body: string } | null;
  permission: PermissionRequest | null;
  /** Text Claude is writing right now (streamed). */
  streamingText: string;
  /** Tokens Claude has written so far this turn, while it runs. */
  turnTokens: number | null;
}

/** A workspace: one Claude account, with its own conversations and sync repository. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  /** Its conversations repository (none for the first workspace). */
  remote: string | null;
  /** Set up on this PC; otherwise only another PC has it (it can be set up here). */
  setUp: boolean;
  signedIn: boolean;
  /** Left out of Conversations on this PC (its Claude Code chats stay as they are). */
  disconnected: boolean;
  /** The Claude account it is signed in with, when Claude Code says. */
  account?: string | null;
  /** Open in another window on this PC (its own copy of the app). */
  openElsewhere?: boolean;
}

/** One MCP server as Claude Code reports it, for the /mcp panel. */
export interface McpServerInfo {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  /** "user", "project", "local", "claudeai", "plugin"… */
  scope: string | null;
  toolCount: number;
  error: string | null;
  /** "stdio", "http", "sse", "claudeai-proxy"...: http and sse servers (and claude.ai connectors) can use a sign-in. */
  transport: string | null;
  /** Its tools, for the server's details (connected servers only). */
  tools: { name: string; description: string | null }[];
}

/** What a /mcp panel action did. A sign-in gives the provider's page (already opened in the browser). */
export interface McpActionResult {
  ok: boolean;
  err?: string;
  servers?: McpServerInfo[];
  /** signin: the provider's sign-in page; null when the server needed nothing. */
  url?: string | null;
  /** signin: Claude Code on this PC waits for the browser to come back (otherwise the sign-in finishes on the provider's site). */
  callbackExpected?: boolean;
  /** signin: the page was opened in the browser (only secure https pages are opened by themselves). */
  opened?: boolean;
}

/** The /mcp panel's contents. `live`: the chat's Claude Code is running in the app, so servers can be reconnected. */
export interface McpPanelData {
  live: boolean;
  servers: McpServerInfo[];
  /** Why the chat's Claude Code couldn't be started (shown under the list). */
  note?: string;
}

/** The model, effort and permission mode picked for one chat. */
export interface ComposerPrefs {
  model?: string;
  effort?: Effort;
  mode?: "default" | "acceptEdits" | "plan" | "auto";
}

/** What the composer keeps per chat (conversation id, or "new:<folder or project>"). */
export interface ComposerState {
  /** Messages written and not sent yet. */
  drafts: Record<string, string>;
  prefs: Record<string, ComposerPrefs>;
}

/** One plan usage window under the sidebar, as Claude Code's /usage reports it. */
export interface UsageMeter {
  /** "session", "week", "week:fable" */
  key: string;
  /** "Current session", "Weekly · All models", "Weekly · Fable" */
  label: string;
  /** 0 to 100 */
  percent: number;
  /** ISO time the window resets, when known. */
  resetsAt: string | null;
}

/** The plan's usage meters; null when the account has no plan limits (an API key). */
export interface PlanUsage {
  /** When Claude Code reported them (ms). */
  at: number;
  plan: string | null;
  meters: UsageMeter[];
}

/** A model in the composer's menu, as Claude Code offers it to this account. */
export interface ModelChoice {
  value: string;
  label: string;
  hint: string;
  current: boolean;
  /** Effort levels the model takes; empty when it has none. */
  efforts?: Effort[];
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A slash command or skill, as Claude Code offers it in a folder. */
export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  builtin: boolean;
  /** Other names that run it ("/cost" for "/usage"). */
  aliases?: string[];
}
