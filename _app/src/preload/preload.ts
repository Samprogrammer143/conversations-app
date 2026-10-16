// The only bridge between the window (sandboxed, no Node) and the app.
import { contextBridge, ipcRenderer } from "electron";
import type { ConversationsApi } from "../shared/api";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const kindArg = process.argv.find((a) => a.startsWith("--window-kind="));
const windowKind = kindArg ? kindArg.slice("--window-kind=".length) : "main";

const api: ConversationsApi = {
  app: {
    info: () => invoke("app:info"),
    openExternal: (url) => invoke("app:openExternal", url),
    openPath: (p) => invoke("app:openPath", p),
    pickFiles: () => invoke("app:pickFiles"),
    pickFolder: () => invoke("app:pickFolder"),
    updateReady: () => invoke("app:updateReady"),
    restart: () => invoke("app:restart"),
    showSettings: (section) => invoke("app:showSettings", section),
    showMain: (conversationId) => invoke("app:showMain", conversationId),
    toggleFlyout: () => invoke("app:toggleFlyout"),
    copyText: (text) => invoke("app:copyText", text),
    checkClaude: () => invoke("app:checkClaude"),
    finishWelcome: () => invoke("app:finishWelcome"),
    windowKind: () => windowKind,
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggleMaximize"),
    close: () => ipcRenderer.send("window:close"),
    setTitleBarColors: (colors) => ipcRenderer.send("window:titleBarColors", colors),
    setFlyoutHeight: (height) => ipcRenderer.send("window:flyoutHeight", height),
  },
  list: {
    sidebar: () => invoke("list:sidebar"),
    conversations: (q) => invoke("list:conversations", q),
    detail: (id) => invoke("list:detail", id),
    items: (id, beforeSeq, limit) => invoke("list:items", id, beforeSeq, limit),
    markSeen: (id) => invoke("list:markSeen", id),
    search: (text, opts) => invoke("list:search", text, opts),
    image: (key) => invoke("list:image", key),
  },
  edit: {
    apply: (id, field, value) => invoke("edit:apply", id, field, value),
  },
  sync: {
    status: () => invoke("sync:status"),
    now: () => invoke("sync:now"),
    setPaused: (paused) => invoke("sync:setPaused", paused),
    openLog: () => invoke("sync:openLog"),
    setUploadQuiet: (seconds) => invoke("sync:setUploadQuiet", seconds),
  },
  cli: {
    open: (id) => invoke("cli:open", id),
    newChat: (projectId) => invoke("cli:newChat", projectId),
  },
  chat: {
    send: (id, text, opts) => invoke("chat:send", id, text, opts),
    stop: (id) => invoke("chat:stop", id),
    stopShell: (key) => invoke("chat:stopShell", key),
    mcp: (id, projectId, folder, opts) => invoke("chat:mcp", id, projectId, folder, opts ?? {}),
    mcpAction: (id, name, action, opts) => invoke("chat:mcpAction", id, name, action, opts ?? {}),
    respond: (requestId, decision) => invoke("chat:respond", requestId, decision),
    setModel: (id, model) => invoke("chat:setModel", id, model),
    setEffort: (id, level) => invoke("chat:setEffort", id, level),
    commands: (id, projectId, folder) => invoke("chat:commands", id, projectId, folder ?? null),
    setPermissionMode: (id, mode) => invoke("chat:setPermissionMode", id, mode),
    status: (id) => invoke("chat:status", id),
    models: () => invoke("chat:models"),
    pending: () => invoke("chat:pending"),
    usage: () => invoke("chat:usage"),
  },
  settings: {
    get: () => invoke("settings:get"),
    set: (patch) => invoke("settings:set", patch),
  },
  workspace: {
    list: () => invoke("workspace:list"),
    switch: (id, force) => invoke("workspace:switch", id, force === true),
    add: (input) => invoke("workspace:add", input),
    signIn: (id) => invoke("workspace:signIn", id),
    rename: (id, name) => invoke("workspace:rename", id, name),
  },
  composer: {
    load: () => invoke("composer:load"),
    save: (patch) => invoke("composer:save", patch),
  },
  on: ((event: string, cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(`event:${event}`, listener);
    return () => ipcRenderer.removeListener(`event:${event}`, listener);
  }) as ConversationsApi["on"],
};

contextBridge.exposeInMainWorld("conversations", api);
