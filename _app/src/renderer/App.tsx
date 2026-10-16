import { useEffect, useState } from "react";
import { Sidebar } from "./features/Sidebar";
import { ConversationList } from "./features/ConversationList";
import { Detail } from "./features/Detail";
import { ContextMenu, SearchResults, ShortcutOverlay, SyncPopover, Toasts, Welcome, copyResumeCommand } from "./features/Overlays";
import { AddWorkspaceSheet, RenameWorkspaceSheet, SwitchingOverlay, switchWorkspace } from "./features/Workspaces";
import { useStore } from "./lib/store";
import { api } from "./lib/api";

/** Full three panes from 1100 px; the sidebar folds away below that; list and conversation stack below 900 px. */
function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function App() {
  const width = useWidth();
  const init = useStore((s) => s.init);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const settings = useStore((s) => s.settings);
  const [hidden, setHidden] = useState(false); // sidebar hidden by choice at full width
  const [showDetail, setShowDetail] = useState(false); // stacked layout: which pane

  const wide = width >= 1100;
  const stacked = width < 900;
  const sidebarInline = wide && !hidden;

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.body.classList.toggle("solid", settings?.windowMaterial === "solid");
  }, [settings?.windowMaterial]);

  // Sidebar toggle: inline at full width, as an overlay when the window is narrow.
  useEffect(() => {
    const toggle = () => {
      if (wide) setHidden((h) => !h);
      else useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen }));
    };
    window.addEventListener("app:toggle-sidebar", toggle);
    return () => window.removeEventListener("app:toggle-sidebar", toggle);
  }, [wide]);

  // Keyboard: every action has a shortcut; holding Ctrl shows them all.
  useEffect(() => {
    let holdTimer: number | undefined;
    const s = () => useStore.getState();
    const onDown = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]");
      if (e.key === "Control" && !e.repeat) {
        holdTimer = window.setTimeout(() => useStore.setState({ showShortcuts: true }), 650);
        return;
      }
      window.clearTimeout(holdTimer);
      if (s().showShortcuts) useStore.setState({ showShortcuts: false });
      const id = s().selectedId;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && !e.shiftKey && key === "k") {
        e.preventDefault();
        if (!wide && !s().sidebarOpen) useStore.setState({ sidebarOpen: true });
        window.setTimeout(() => window.dispatchEvent(new Event("app:focus-search")), 0);
      } else if (e.ctrlKey && !e.shiftKey && key === "n") {
        e.preventDefault();
        s().startDraft(s().detail?.row.projectId ?? null);
      } else if (e.ctrlKey && key === "b") {
        e.preventDefault();
        window.dispatchEvent(new Event("app:toggle-sidebar"));
      } else if (e.ctrlKey && e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        // Ctrl+Shift+1, 2, …: the workspaces set up on this PC, in the switcher's order.
        e.preventDefault();
        const ws = s().workspaces;
        const w = ws?.workspaces.filter((x) => x.setUp)[Number(e.code.slice(5)) - 1];
        if (w && w.id !== ws?.current) void switchWorkspace(w);
      } else if (e.ctrlKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        s().setFilter((["all", "updated", "live"] as const)[Number(e.key) - 1]);
      } else if (e.ctrlKey && !e.shiftKey && key === "d" && id) {
        e.preventDefault();
        void s().togglePin(id);
      } else if (e.ctrlKey && !e.shiftKey && key === "e" && id) {
        e.preventDefault();
        void s().archive(id, true);
      } else if (e.ctrlKey && e.shiftKey && key === "o" && id) {
        e.preventDefault();
        void api.cli.open(id).then((r) => s().toast({ text: r.message, icon: r.ok ? "terminal" : "alert" }));
      } else if (e.ctrlKey && e.shiftKey && key === "c" && id && !typing) {
        e.preventDefault();
        copyResumeCommand(id);
      } else if (e.ctrlKey && e.shiftKey && key === "s") {
        e.preventDefault();
        void api.sync.now();
      } else if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        void api.app.showSettings();
      } else if (!typing && e.key === "F2" && id) {
        e.preventDefault();
        useStore.setState({ renaming: id });
      } else if (!typing && e.key === "Delete" && id) {
        e.preventDefault();
        s().remove(id);
      } else if ((e.altKey && e.key === "ArrowLeft") || (!typing && e.key === "Escape" && stacked && showDetail)) {
        if (stacked) setShowDetail(false);
      } else if (!typing && (e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey) {
        const rows = s().list?.rows.filter((r) => !s().hidden.has(r.id)) ?? [];
        const i = rows.findIndex((r) => r.id === id);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next && !(e.target as HTMLElement)?.closest(".transcript, .menu, .popover")) {
          e.preventDefault();
          void s().select(next.id);
        }
      } else if (!typing && e.key === "Enter" && id && !(e.target as HTMLElement)?.closest("button, .menu")) {
        if (stacked) setShowDetail(true);
        window.dispatchEvent(new Event("app:focus-composer"));
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Control") {
        window.clearTimeout(holdTimer);
        useStore.setState({ showShortcuts: false });
      }
    };
    const onBlur = () => {
      window.clearTimeout(holdTimer);
      useStore.setState({ showShortcuts: false });
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [wide, stacked, showDetail]);

  // Stacked layout: choosing a conversation moves to it.
  const selectedId = useStore((s) => s.selectedId);
  useEffect(() => {
    if (stacked && selectedId && document.activeElement?.closest(".list-col")) setShowDetail(true);
  }, [selectedId, stacked]);

  return (
    <>
      <div className={`app${sidebarInline ? "" : " collapsed"}`}>
        {sidebarInline && <Sidebar />}
        <main className={`content${stacked ? " stacked" : ""}`}>
          {(!stacked || !showDetail) && <ConversationList showSidebarToggle={!sidebarInline} onOpen={() => stacked && setShowDetail(true)} />}
          {(!stacked || showDetail) && <Detail narrow={!wide} onBack={stacked ? () => setShowDetail(false) : undefined} />}
        </main>
        {!sidebarInline && sidebarOpen && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onMouseDown={() => useStore.setState({ sidebarOpen: false })} />
            <Sidebar overlay />
          </>
        )}
      </div>
      <SearchResults />
      <SyncPopover />
      <ContextMenu />
      <Toasts />
      <AddWorkspaceSheet />
      <RenameWorkspaceSheet />
      <SwitchingOverlay />
      <ShortcutOverlay />
      <Welcome />
    </>
  );
}
