// The window's whole view of the app: window.conversations, exposed by the
// preload script. Requests go through ipcRenderer.invoke; pushes arrive as events.

import type {
  Attachment,
  Effort,
  SlashCommandInfo,
  ModelChoice,
  AppInfo,
  ChatStatus,
  ConversationDetail,
  ItemsPage,
  ListQuery,
  ListResult,
  PermissionRequest,
  PlanUsage,
  ComposerPrefs,
  ComposerState,
  WorkspaceInfo,
  McpPanelData,
  McpServerInfo,
  SearchResult,
  Settings,
  SidebarData,
  SyncStatus,
} from "./types";

export type EditField = "pinned" | "title" | "archived" | "deleted";

export interface ConversationsApi {
  app: {
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
    /** "" when the folder opened, otherwise why it didn't. */
    openPath(p: string): Promise<string>;
    /** The Attach button: images come back as attachments, other files as paths to mention. */
    pickFiles(): Promise<{ images: Attachment[]; paths: string[] }>;
    /** "New chat in a folder…": a folder picker. Null when cancelled. */
    pickFolder(): Promise<string | null>;
    /** A newer app version waiting for the next start, if any. */
    updateReady(): Promise<string | null>;
    /** Restarts into the newer version. Chats running in the app end and can be carried on afterwards. */
    restart(): Promise<void>;
    showSettings(section?: string): Promise<void>;
    showMain(conversationId?: string): Promise<void>;
    toggleFlyout(): Promise<void>;
    copyText(text: string): Promise<void>;
    checkClaude(): Promise<AppInfo["claude"]>;
    finishWelcome(): Promise<void>;
    /** Window kind this page was opened as: "main" | "settings" | "flyout". */
    windowKind(): string;
  };
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    setTitleBarColors(colors: { background: string; symbols: string }): void;
    setFlyoutHeight(height: number): void;
  };
  list: {
    sidebar(): Promise<SidebarData>;
    conversations(q: ListQuery): Promise<ListResult>;
    detail(id: string): Promise<ConversationDetail | null>;
    items(id: string, beforeSeq: number | null, limit: number): Promise<ItemsPage>;
    markSeen(id: string): Promise<void>;
    search(text: string, opts?: { includeTools?: boolean }): Promise<SearchResult>;
    image(key: string): Promise<string | null>;
  };
  edit: {
    apply(id: string, field: EditField, value: boolean | string | null): Promise<{ ok: boolean; queued?: boolean; err?: string }>;
  };
  sync: {
    status(): Promise<SyncStatus>;
    now(): Promise<void>;
    setPaused(paused: boolean): Promise<void>;
    openLog(): Promise<void>;
    setUploadQuiet(seconds: number): Promise<{ ok: boolean; err?: string }>;
  };
  cli: {
    open(id: string): Promise<{ ok: boolean; message: string }>;
    newChat(projectId: string | null): Promise<{ ok: boolean; message: string }>;
  };
  chat: {
    send(id: string | null, text: string, opts: { projectId?: string | null; folder?: string | null; asBranch?: boolean; model?: string | null; permissionMode?: string; effort?: Effort | null; attachments?: Attachment[]; /** The text is a "!" shell command. */ shell?: boolean; /** A new chat's composer key, to stop its command by. */ draftKey?: string }): Promise<{ ok: boolean; conversationId?: string; err?: string; /** A "!" command ran: never offer it to run again. */ ran?: boolean }>;
    /** Stops a "!" command running in a new chat (by its composer key). */
    stopShell(key: string): Promise<void>;
    /** /mcp: the chat's MCP servers (from its running session when there is one). */
    mcp(id: string | null, projectId: string | null, folder: string | null, opts?: { model?: string | null; effort?: Effort | null; permissionMode?: string }): Promise<McpPanelData & { ok: boolean; err?: string }>;
    /** Reconnect, enable or disable a server in the chat's running session. */
    mcpAction(id: string, name: string, action: "reconnect" | "enable" | "disable", opts?: { model?: string | null; effort?: Effort | null; permissionMode?: string }): Promise<{ ok: boolean; err?: string; servers?: McpServerInfo[] }>;
    stop(id: string): Promise<void>;
    respond(requestId: string, decision: "allow" | "allow-always" | "deny"): Promise<void>;
    setModel(id: string, model: string): Promise<void>;
    setEffort(id: string, level: Effort): Promise<void>;
    /** Slash commands and skills for a conversation's folder, or a new chat's project. */
    commands(id: string | null, projectId: string | null, folder?: string | null): Promise<SlashCommandInfo[]>;
    setPermissionMode(id: string, mode: string): Promise<void>;
    status(id: string): Promise<ChatStatus | null>;
    models(): Promise<ModelChoice[]>;
    pending(): Promise<PermissionRequest[]>;
    /** The plan usage meters (the last reading; a fresh one follows as a "usage" event). */
    usage(): Promise<PlanUsage | null>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };
  /** Workspaces: one Claude account each. Switching restarts the app into the other one. */
  workspace: {
    list(): Promise<{ current: string; workspaces: WorkspaceInfo[] }>;
    /** `running`: chats still running here, which a switch would stop (switch again with force). */
    switch(id: string, force?: boolean): Promise<{ ok: boolean; err?: string; running?: number }>;
    /** Sets up a workspace on this PC (a new one, or one another PC has: pass its id). */
    add(input: { id?: string; name: string; remote: string }): Promise<{ ok: boolean; id?: string; err?: string }>;
    /** Opens a terminal where Claude Code asks to sign in to the workspace's account. */
    /** No id: the workspace this window is in. */
    signIn(id: string | null): Promise<{ ok: boolean; err?: string }>;
    disconnect(id: string, force?: boolean): Promise<{ ok: boolean; err?: string; running?: number; switchedTo?: string }>;
    reconnect(id: string): Promise<{ ok: boolean; err?: string; synced?: boolean }>;
    rename(id: string, name: string): Promise<void>;
  };
  /** Unsent messages and per-chat model, effort and mode, kept by the app. */
  composer: {
    load(): Promise<ComposerState>;
    /** A draft of "" and prefs of null remove the entry. */
    save(patch: { drafts?: Record<string, string>; prefs?: Record<string, ComposerPrefs | null> }): Promise<void>;
  };
  on(event: "index-changed", cb: (ids: string[]) => void): () => void;
  on(event: "update-ready", cb: (version: string) => void): () => void;
  on(event: "sync-status", cb: (s: SyncStatus) => void): () => void;
  on(event: "usage", cb: (u: PlanUsage | null) => void): () => void;
  on(event: "workspaces-changed", cb: () => void): () => void;
  on(event: "chat-status", cb: (s: ChatStatus) => void): () => void;
  on(event: "open-conversation", cb: (id: string) => void): () => void;
  on(event: "settings-changed", cb: (s: Settings) => void): () => void;
  on(event: "toast", cb: (t: { text: string; action?: string }) => void): () => void;
  on(event: "window-state", cb: (s: { maximized: boolean; focused: boolean }) => void): () => void;
  on(event: "chat-pending", cb: (p: PermissionRequest[]) => void): () => void;
}

export const CHANNELS = [
  "app:info",
  "app:openExternal",
  "app:openPath",
  "app:pickFiles",
  "app:pickFolder",
  "app:updateReady",
  "app:restart",
  "app:showSettings",
  "app:showMain",
  "app:toggleFlyout",
  "app:copyText",
  "app:checkClaude",
  "app:finishWelcome",
  "list:sidebar",
  "list:conversations",
  "list:detail",
  "list:items",
  "list:markSeen",
  "list:search",
  "list:image",
  "edit:apply",
  "sync:status",
  "sync:now",
  "sync:setPaused",
  "sync:openLog",
  "sync:setUploadQuiet",
  "cli:open",
  "cli:newChat",
  "chat:send",
  "chat:stop",
  "chat:stopShell",
  "chat:mcp",
  "chat:mcpAction",
  "chat:respond",
  "chat:setModel",
  "chat:setEffort",
  "chat:commands",
  "chat:setPermissionMode",
  "chat:status",
  "chat:models",
  "chat:pending",
  "chat:usage",
  "settings:get",
  "settings:set",
  "workspace:list",
  "workspace:switch",
  "workspace:add",
  "workspace:signIn",
  "workspace:rename",
  "workspace:disconnect",
  "workspace:reconnect",
  "composer:load",
  "composer:save",
] as const;

export type Channel = (typeof CHANNELS)[number];

export const EVENTS = ["index-changed", "sync-status", "chat-status", "open-conversation", "settings-changed", "toast", "window-state", "chat-pending", "update-ready", "usage", "workspaces-changed"] as const;
