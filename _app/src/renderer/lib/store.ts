// The window's state. Everything here is a view over the local index, so each
// action shows its result immediately; sync happens behind it.

import { create } from "zustand";
import type { WorkspaceInfo } from "../../shared/types";
import type { AppInfo, ComposerPrefs, ComposerState, ConversationDetail, ConversationRow, ListFilter, ListQuery, ListResult, PlanUsage, SearchResult, Settings, SidebarData, SyncStatus } from "../../shared/types";
import { api } from "./api";

export interface Toast {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onExpire?: () => void;
  icon?: "check" | "terminal" | "alert";
  durationMs: number;
}

type Scope = ListQuery["scope"];

interface State {
  info: AppInfo | null;
  settings: Settings | null;
  sidebar: SidebarData | null;
  scope: Scope;
  filter: ListFilter;
  list: ListResult | null;
  selectedId: string | null;
  detail: ConversationDetail | null;
  sync: SyncStatus | null;
  /** The plan usage meters under the sidebar. */
  usage: PlanUsage | null;
  /**
   * Until when Enter and Esc do nothing, and no card takes the keyboard: alert mode has just
   * brought a chat forward and you may still be typing what you meant for another program.
   */
  alertGuardUntil: number;
  /** Focus mode (Ctrl+F): only the chat, with the usage meters under it. */
  focus: boolean;
  /** Workspaces (one Claude account each), and which one this window is. */
  workspaces: { current: string; workspaces: WorkspaceInfo[] } | null;
  loadWorkspaces(): Promise<void>;
  /** The Add workspace sheet: open (for a new one, or one another PC has), or closed. */
  addWorkspace: { prefill: WorkspaceInfo | null } | null;
  openAddWorkspace(prefill: WorkspaceInfo | null): void;
  /** Set while the app restarts into another workspace. */
  switchingTo: string | null;
  renamingWorkspace: boolean;
  /** The workspace the Sign in sheet signs in (id null: the one this window is in). */
  signingIn: { id: string | null; name: string } | null;
  /** The workspace the Disconnect sheet asks about. */
  disconnectingWorkspace: WorkspaceInfo | null;
  /** Unsent messages and per-chat model, effort and mode (kept by the app across restarts). */
  composer: ComposerState;
  setDraft(key: string, text: string): void;
  setPrefs(key: string, patch: ComposerPrefs): void;
  /** A new chat got its id: what was picked for it moves to the conversation. */
  adoptComposer(fromKey: string, toId: string): void;
  /** Chats (composer keys) with a "!" command running, so every composer for them knows. */
  runningShells: Record<string, true>;
  setShellRunning(key: string, on: boolean): void;
  hidden: Set<string>; // deleted in this window, waiting out the Undo toast
  search: { open: boolean; text: string; result: SearchResult | null; active: number; includeTools: boolean };
  toasts: Toast[];
  popover: "sync" | null;
  sidebarOpen: boolean; // only used when the window is too narrow for the sidebar
  showShortcuts: boolean;
  renaming: string | null;
  menu: { x: number; y: number; id: string } | null;
  welcome: boolean;
  /** A new chat being written, before Claude Code has given it an id. */
  draft: { projectId: string | null; label: string; folder?: string | null } | null;
  /** Prompts sent from this window that the transcript hasn't caught up with yet. */
  sent: Record<string, string[]>;
  startDraft(projectId: string | null, folder?: string | null): void;
  noteSent(id: string, text: string): void;
  clearSent(id: string, texts: string[]): void;

  init(): Promise<void>;
  refresh(ids?: string[]): Promise<void>;
  setScope(scope: Scope): void;
  setFilter(filter: ListFilter): void;
  select(id: string | null): Promise<void>;
  setSearchText(text: string): void;
  setSearchOpen(open: boolean): void;
  moveSearch(delta: number): void;
  setIncludeTools(v: boolean): void;
  toast(t: Omit<Toast, "id" | "durationMs"> & { durationMs?: number }): number;
  dismissToast(id: number): void;
  togglePin(id: string): Promise<void>;
  archive(id: string, archived?: boolean): Promise<void>;
  remove(id: string): void;
  rename(id: string, title: string): Promise<void>;
  setPopover(p: "sync" | null): void;
  openMenu(id: string, x: number, y: number): void;
  closeMenu(): void;
}

let toastSeq = 1;
let searchTimer: number | undefined;
let refreshTimer: number | undefined;

// Drafts go to the app half a second after you stop typing (and when the window
// loses focus or closes), not on every key.
let unsavedDrafts: Record<string, string> = {};
let draftTimer: number | undefined;
function flushDrafts() {
  window.clearTimeout(draftTimer);
  if (!Object.keys(unsavedDrafts).length) return;
  const drafts = unsavedDrafts;
  unsavedDrafts = {};
  void api.composer.save({ drafts }).catch(() => {});
}

const rowsOf = (s: State) => s.list?.rows ?? [];

export const useStore = create<State>((set, get) => ({
  info: null,
  settings: null,
  sidebar: null,
  scope: { kind: "all" },
  filter: "all",
  list: null,
  selectedId: null,
  detail: null,
  sync: null,
  usage: null,
  composer: { drafts: {}, prefs: {} },
  workspaces: null,
  addWorkspace: null,
  switchingTo: null,
  alertGuardUntil: 0,
  focus: false,
  renamingWorkspace: false,
  disconnectingWorkspace: null,
  signingIn: null,
  async loadWorkspaces() {
    try {
      set({ workspaces: await api.workspace.list() });
    } catch {}
  },
  openAddWorkspace(prefill) {
    set({ addWorkspace: { prefill } });
  },
  runningShells: {},
  hidden: new Set(),
  search: { open: false, text: "", result: null, active: 0, includeTools: false },
  toasts: [],
  popover: null,
  sidebarOpen: false,
  showShortcuts: false,
  renaming: null,
  menu: null,
  welcome: false,
  draft: null,
  sent: {},

  startDraft(projectId, folder = null) {
    const s = get();
    const label = folder
      ? folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
      : projectId
        ? s.sidebar?.projects.find((p) => p.id === projectId)?.label ?? projectId.split("/").pop() ?? "this project"
        : "your Home folder";
    set({ draft: { projectId, label, folder }, selectedId: null, detail: null });
    window.setTimeout(() => window.dispatchEvent(new Event("app:focus-composer")), 50);
  },

  noteSent(id, text) {
    set((s) => ({ sent: { ...s.sent, [id]: [...(s.sent[id] ?? []), text] } }));
  },

  clearSent(id, texts) {
    set((s) => {
      const left = (s.sent[id] ?? []).filter((t) => !texts.includes(t));
      return { sent: { ...s.sent, [id]: left } };
    });
  },

  setDraft(key, text) {
    const c = get().composer;
    const keep = text.trim() ? text : "";
    if ((c.drafts[key] ?? "") === keep) return;
    const drafts = { ...c.drafts };
    if (keep) drafts[key] = keep;
    else delete drafts[key];
    set({ composer: { ...c, drafts } });
    unsavedDrafts[key] = keep;
    window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(flushDrafts, 500);
  },

  setPrefs(key, patch) {
    const c = get().composer;
    const next: ComposerPrefs = { ...c.prefs[key], ...patch };
    set({ composer: { ...c, prefs: { ...c.prefs, [key]: next } } });
    void api.composer.save({ prefs: { [key]: next } }).catch(() => {});
  },

  setShellRunning(key, on) {
    const cur = get().runningShells;
    if (!!cur[key] === on) return;
    const next = { ...cur };
    if (on) next[key] = true;
    else delete next[key];
    set({ runningShells: next });
  },

  adoptComposer(fromKey, toId) {
    const c = get().composer;
    const picked = c.prefs[fromKey];
    if (!picked) return;
    const prefs = { ...c.prefs, [toId]: { ...picked, ...c.prefs[toId] } };
    delete prefs[fromKey];
    set({ composer: { ...c, prefs } });
    void api.composer.save({ prefs: { [toId]: prefs[toId], [fromKey]: null } }).catch(() => {});
  },

  async init() {
    const [info, settings, sidebar, sync, composer] = await Promise.all([api.app.info(), api.settings.get(), api.list.sidebar(), api.sync.status(), api.composer.load().catch(() => ({ drafts: {}, prefs: {} }))]);
    set({ info, settings, sidebar, sync, welcome: info.firstRun, composer: { drafts: { ...composer.drafts, ...get().composer.drafts }, prefs: { ...composer.prefs, ...get().composer.prefs } } });
    window.addEventListener("beforeunload", flushDrafts);
    void get().loadWorkspaces();
    api.on("workspaces-changed", () => void get().loadWorkspaces());
    window.addEventListener("blur", flushDrafts);
    const list = await api.list.conversations({ scope: get().scope, filter: get().filter });
    set({ list });
    if (list.rows[0] && !get().selectedId) void get().select(list.rows[0].id);
    api.on("index-changed", (ids) => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void get().refresh(ids), 60);
    });
    api.on("sync-status", (s) => set({ sync: s }));
    api.on("usage", (u) => set({ usage: u }));
    void api.chat.usage().then((u) => {
      if (u && (!get().usage || u.at > get().usage!.at)) set({ usage: u });
    });
    api.on("settings-changed", (s) => set({ settings: s }));
    api.on("open-conversation", (id) => void get().select(id));
    // Keys in the first moments after alert mode took the window change nothing that matters.
    window.addEventListener(
      "keydown",
      (e) => {
        if ((e.key === "Enter" || e.key === "Escape") && Date.now() < get().alertGuardUntil) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    window.addEventListener("focus", () => {
      if (Date.now() < get().alertGuardUntil) set({ alertGuardUntil: Date.now() + 3000 });
    });
    api.on("alert", ({ id, raised, text, why }) => {
      const tell = () => get().toast({ text, icon: why === "finished" ? "check" : "alert", actionLabel: "Open", onAction: () => void get().select(id), durationMs: 15_000 });
      // A sheet is open, or a chat is being renamed: that isn't taken away from you.
      const busy = !!document.querySelector(".scrim") || !!get().renaming;
      // Into the message box, never onto a card's Allow button: a stray key must not approve anything.
      if (raised) set({ alertGuardUntil: Date.now() + 20_000 });
      if (!raised || busy) {
        if (get().selectedId !== id) tell();
        return;
      }
      (document.activeElement as HTMLElement | null)?.blur();
      void Promise.resolve(get().select(id)).finally(() => {
        window.dispatchEvent(new Event("app:show-chat"));
        for (const ms of [0, 300, 900]) window.setTimeout(() => window.dispatchEvent(new Event("app:focus-composer")), ms);
      });
    });
    api.on("toast", (t) => void get().toast({ text: t.text }));
    // An update stays on screen until you act on it.
    const offerUpdate = (v: string | null) => {
      if (!v || get().toasts.some((t) => t.text.startsWith("Conversations "))) return;
      get().toast({ text: `Conversations ${v} is ready to install`, icon: "check", actionLabel: "Restart", onAction: () => void api.app.restart(), durationMs: 24 * 60 * 60 * 1000 });
    };
    api.on("update-ready", offerUpdate);
    void api.app.updateReady().then(offerUpdate);
  },

  async refresh(ids) {
    const { scope, filter, selectedId } = get();
    const [sidebar, list] = await Promise.all([api.list.sidebar(), api.list.conversations({ scope, filter })]);
    set({ sidebar, list });
    if (selectedId && (!ids || ids.includes(selectedId))) {
      const detail = await api.list.detail(selectedId);
      if (get().selectedId === selectedId) set({ detail });
    }
    if (get().search.open && get().search.text) get().setSearchText(get().search.text);
  },

  setScope(scope) {
    set({ scope, sidebarOpen: false });
    void api.list.conversations({ scope, filter: get().filter }).then((list) => {
      set({ list });
      const sel = get().selectedId;
      if (!sel || !list.rows.some((r) => r.id === sel)) void get().select(list.rows[0]?.id ?? null);
    });
  },

  setFilter(filter) {
    set({ filter });
    void api.list.conversations({ scope: get().scope, filter }).then((list) => set({ list }));
  },

  async select(id) {
    set({ selectedId: id, renaming: null, draft: id ? null : get().draft });
    if (!id) {
      set({ detail: null });
      return;
    }
    const detail = await api.list.detail(id);
    if (get().selectedId !== id) return;
    set({ detail });
    if (detail?.row.updated) void api.list.markSeen(id);
  },

  setSearchText(text) {
    set((s) => ({ search: { ...s.search, text, open: true, active: 0 } }));
    window.clearTimeout(searchTimer);
    if (!text.trim()) {
      set((s) => ({ search: { ...s.search, result: null } }));
      return;
    }
    // Titles answer as you type; the debounce only keeps up with fast typists.
    searchTimer = window.setTimeout(async () => {
      const result = await api.list.search(text, { includeTools: get().search.includeTools });
      if (get().search.text === text) set((s) => ({ search: { ...s.search, result } }));
    }, 40);
  },

  setSearchOpen(open) {
    set((s) => ({ search: { ...s.search, open } }));
  },

  moveSearch(delta) {
    set((s) => ({ search: { ...s.search, active: Math.max(0, s.search.active + delta) } }));
  },

  setIncludeTools(v) {
    set((s) => ({ search: { ...s.search, includeTools: v } }));
    get().setSearchText(get().search.text);
  },

  toast(t) {
    const id = toastSeq++;
    const toast: Toast = { durationMs: t.actionLabel ? 6000 : 3500, ...t, id };
    set((s) => ({ toasts: [...s.toasts.filter((x) => !x.onExpire), toast].slice(-3) }));
    window.setTimeout(() => {
      const still = get().toasts.find((x) => x.id === id);
      if (!still) return;
      still.onExpire?.();
      get().dismissToast(id);
    }, toast.durationMs);
    return id;
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  async togglePin(id) {
    const row = rowsOf(get()).find((r) => r.id === id) ?? get().detail?.row;
    if (!row) return;
    const r = await api.edit.apply(id, "pinned", !row.pinned);
    if (!r.ok) {
      get().toast({ text: r.err ?? "Couldn't change the pin", icon: "alert" });
      return;
    }
    get().toast({ text: row.pinned ? `Unpinned “${row.title}”` : `Pinned “${row.title}”`, icon: "check" });
  },

  async archive(id, archived = true) {
    const row = rowsOf(get()).find((r) => r.id === id) ?? get().detail?.row;
    if (!row) return;
    if (archived && get().selectedId === id) selectNeighbour(get(), id);
    const r = await api.edit.apply(id, "archived", archived);
    if (!r.ok) {
      get().toast({ text: r.err ?? "Couldn't archive it", icon: "alert" });
      return;
    }
    if (archived)
      get().toast({
        text: `Archived “${row.title}”`,
        icon: "check",
        actionLabel: "Undo",
        onAction: () => void api.edit.apply(id, "archived", false),
      });
  },

  remove(id) {
    // Delete waits out the Undo toast before anything leaves this PC.
    const row = rowsOf(get()).find((r) => r.id === id) ?? get().detail?.row;
    if (!row) return;
    // Never two writers: a conversation still open here is left alone (the main
    // process checks again before anything is deleted).
    if (row.runningHere) {
      get().toast({ text: "It's open in Claude Code on this PC. Close it there first, then delete.", icon: "alert" });
      return;
    }
    if (get().selectedId === id) selectNeighbour(get(), id);
    set((s) => ({ hidden: new Set([...s.hidden, id]) }));
    let undone = false;
    get().toast({
      text: `Deleted “${row.title}”`,
      icon: "check",
      actionLabel: "Undo",
      onAction: () => {
        undone = true;
        set((s) => {
          const hidden = new Set(s.hidden);
          hidden.delete(id);
          return { hidden };
        });
      },
      onExpire: () => {
        if (undone) return;
        void api.edit.apply(id, "deleted", true).then((r) => {
          set((s) => {
            const hidden = new Set(s.hidden);
            hidden.delete(id);
            return { hidden };
          });
          if (!r.ok) get().toast({ text: r.err ?? `Couldn't delete “${row.title}”`, icon: "alert" });
        });
      },
    });
  },

  async rename(id, title) {
    set({ renaming: null });
    const clean = title.trim();
    const row = rowsOf(get()).find((r) => r.id === id) ?? get().detail?.row;
    if (!row || !clean || clean === row.title) return;
    const r = await api.edit.apply(id, "title", clean);
    if (!r.ok) get().toast({ text: r.err ?? "Couldn't rename it", icon: "alert" });
  },

  setPopover(popover) {
    set({ popover });
  },

  openMenu(id, x, y) {
    set({ menu: { id, x, y } });
  },

  closeMenu() {
    set({ menu: null });
  },
}));

function selectNeighbour(s: State, id: string) {
  const rows = rowsOf(s).filter((r) => !s.hidden.has(r.id));
  const i = rows.findIndex((r) => r.id === id);
  const next = rows[i + 1] ?? rows[i - 1] ?? null;
  void s.select(next?.id ?? null);
}

export const visibleRows = (s: { list: ListResult | null; hidden: Set<string> }): ConversationRow[] => (s.list?.rows ?? []).filter((r) => !s.hidden.has(r.id));
