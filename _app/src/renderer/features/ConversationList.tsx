import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationRow } from "../../shared/types";
import { Icon } from "../components/Icon";
import { GlassCircle, IconButton, Segmented } from "../components/controls";
import { useStore, visibleRows } from "../lib/store";
import { api } from "../lib/api";
import { SEP, groupLabel, plural, rowTime } from "../lib/format";

type Entry = { type: "header"; label: string; key: string } | { type: "row"; row: ConversationRow; key: string; last: boolean };

function scopeTitle(scope: ReturnType<typeof useStore.getState>["scope"], sidebar: ReturnType<typeof useStore.getState>["sidebar"]): string {
  if (scope.kind === "all") return "All Conversations";
  if (scope.kind === "pinned") return "Pinned";
  if (scope.kind === "archived") return "Archived";
  if (scope.kind === "device") return scope.name;
  if (scope.id === "folder:*") return "Other folders";
  return sidebar?.projects.find((p) => p.id === scope.id)?.label ?? scope.id.split("/").pop() ?? "Project";
}

const Row = memo(function Row({ row, selected, last, renaming }: { row: ConversationRow; selected: boolean; last: boolean; renaming: boolean }) {
  const select = useStore((s) => s.select);
  const openMenu = useStore((s) => s.openMenu);
  const rename = useStore((s) => s.rename);
  const thisPc = useStore((s) => s.info?.machine);
  const [draft, setDraft] = useState(row.title);
  useEffect(() => setDraft(row.title), [row.title, renaming]);
  const pc = row.lastPc ?? thisPc ?? "";
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-id={row.id}
      className={`row${row.updated ? " is-updated" : ""}${last ? " last" : ""}`}
      onClick={() => void select(row.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        void select(row.id);
        openMenu(row.id, e.clientX, e.clientY);
      }}
    >
      <span className="row-gutter">{row.updated && <span className="unread" aria-label="Updated on another PC" />}</span>
      <span className="row-main">
        <span className="row-line1">
          {renaming ? (
            <input
              className="rename-input"
              autoFocus
              value={draft}
              aria-label="Conversation name"
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename(row.id, draft);
                if (e.key === "Escape") useStore.setState({ renaming: null });
              }}
              onBlur={() => void rename(row.id, draft)}
            />
          ) : (
            <span className="row-title ellipsis">{row.title}</span>
          )}
          <span className="row-time">{rowTime(row.lastAt)}</span>
        </span>
        <span className="row-preview ellipsis">{row.preview}</span>
        <span className="row-meta">
          <span className="row-where">
            <Icon name={/laptop/i.test(pc) ? "laptop" : "monitor"} size={14} />
            <span>{pc}</span>
            <span className="dot">·</span>
            <span className="ellipsis">{row.projectLabel}</span>
          </span>
          {row.live || row.runningHere ? <span className="live">Live</span> : row.pinned ? <Icon name="pin" size={12} className="pin" label="Pinned" /> : null}
        </span>
      </span>
    </div>
  );
});

type Scope = ReturnType<typeof useStore.getState>["scope"];
type Filter = ReturnType<typeof useStore.getState>["filter"];

/** Each empty list says what would appear there and how, in one line. */
function emptyTitle(filter: Filter, scope: Scope, title: string): string {
  if (filter === "updated") return "Nothing new from other PCs";
  if (filter === "live") return "No conversation is running";
  if (scope.kind === "pinned") return "No pinned conversations";
  if (scope.kind === "archived") return "No archived conversations";
  if (scope.kind === "device") return `No conversations from ${scope.name} yet`;
  return `No conversations${scope.kind === "project" ? ` in ${title}` : ""} yet`;
}

function emptyLine(filter: Filter, scope: Scope): string {
  if (filter === "updated") return "Conversations that change on another PC show up here until you open them.";
  if (filter === "live") return "Conversations open in Claude Code on any PC show up here.";
  if (scope.kind === "pinned") return "Press Ctrl+D on a conversation to pin it.";
  if (scope.kind === "archived") return "Archived conversations stay synced and come back with Ctrl+E.";
  if (scope.kind === "device") return "They appear here after that PC uploads one.";
  if (scope.kind === "project") return "Start one here, or run claude in that folder on any PC.";
  return "Run claude in any project folder, or start a chat here with Ctrl+N.";
}

export function ConversationList({ showSidebarToggle, onOpen }: { showSidebarToggle: boolean; onOpen?: () => void }) {
  const list = useStore((s) => s.list);
  const hidden = useStore((s) => s.hidden);
  const scope = useStore((s) => s.scope);
  const sidebar = useStore((s) => s.sidebar);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const selectedId = useStore((s) => s.selectedId);
  const renaming = useStore((s) => s.renaming);
  const select = useStore((s) => s.select);
  const toast = useStore((s) => s.toast);
  const pcCount = sidebar?.devices.length ?? 0;
  const offline = useStore((s) => s.sync?.phase === "offline");
  const rows = visibleRows({ list, hidden });

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    let current = "";
    rows.forEach((row, i) => {
      const g = groupLabel(row.lastAt);
      if (g !== current) {
        current = g;
        out.push({ type: "header", label: g, key: `h:${g}` });
      }
      const next = rows[i + 1];
      out.push({ type: "row", row, key: row.id, last: !next || groupLabel(next.lastAt) !== g });
    });
    return out;
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [stickyLabel, setStickyLabel] = useState<string | null>(null);
  const v = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (entries[i].type === "header" ? 34 : 76),
    overscan: 8,
    getItemKey: (i) => entries[i].key,
  });

  // Keep the selection in view when it moves by keyboard.
  useEffect(() => {
    const i = entries.findIndex((e) => e.type === "row" && e.row.id === selectedId);
    if (i >= 0) v.scrollToIndex(i, { align: "auto" });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (delta: number) => {
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(selectedId ?? "");
    const next = ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? -1 : i) + delta))];
    if (next) void select(next);
  };

  const title = scopeTitle(scope, sidebar);
  const counts = list?.counts ?? { all: 0, updated: 0, live: 0 };

  return (
    <section className="list-col" aria-label="Conversations">
      <div className="list-toolbar drag">
        {showSidebarToggle && <IconButton icon="panel-left" label="Show sidebar (Ctrl+B)" onClick={() => window.dispatchEvent(new Event("app:toggle-sidebar"))} />}
        <div className="list-title">
          <span className="t1 ellipsis">{title}</span>
          <span className="t2 ellipsis">
            {plural(counts.all, "conversation")}
            {pcCount > 1 ? `${SEP}${pcCount} PCs` : ""}
          </span>
        </div>
        <GlassCircle
          icon="square-pen"
          label="New chat (Ctrl+N)"
          onClick={() => {
            const projectId = scope.kind === "project" && scope.id !== "folder:*" ? scope.id : useStore.getState().detail?.row.projectId ?? null;
            useStore.getState().startDraft(projectId);
          }}
        />
      </div>
      <div className="filters">
        <Segmented
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "updated", label: "Updated", count: counts.updated },
            { value: "live", label: "Live", count: counts.live },
          ]}
        />
      </div>
      {offline && (
        <div className="list-banner">
          <div className="banner">
            <Icon name="wifi-off" />
            <div className="text">
              <span className="title">You're offline</span>
              <span className="detail">Everything on this PC still works. Changes upload when you reconnect.</span>
            </div>
          </div>
        </div>
      )}
      {/* Rows slide under the filters behind a hairline, as the conversation does under its header. */}
      <div className={`list-edge${scrolled && !stickyLabel ? " on" : ""}`} aria-hidden />
      {stickyLabel && (
        <div className="sticky-anchor" aria-hidden>
          <div className="sticky-head">
            <div className="list-header">{stickyLabel}</div>
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        className="rows scroll"
        role="listbox"
        aria-label={title}
        tabIndex={-1}
        onScroll={(e) => {
          const top = (e.currentTarget as HTMLElement).scrollTop;
          setScrolled(top > 2);
          // The day group of the first row in view stays pinned above the rows.
          const first = v.getVirtualItems().find((vi) => vi.end > top + 1);
          let label: string | null = null;
          for (let i = first?.index ?? -1; i >= 0; i--) {
            const en = entries[i];
            if (en.type === "header") {
              label = en.label;
              break;
            }
          }
          setStickyLabel(top > 2 ? label : null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter") onOpen?.();
        }}
      >
        {!rows.length && list ? (
          <div className="empty">
            <span className="empty-tile" aria-hidden>
              <Icon name={filter === "live" ? "terminal" : filter === "updated" ? "cloud-download" : scope.kind === "pinned" ? "pin" : "message-square"} size={16} />
            </span>
            <div className="title">{emptyTitle(filter, scope, title)}</div>
            <div className="line">{emptyLine(filter, scope)}</div>
            {scope.kind === "project" && scope.id !== "folder:*" && filter === "all" && (
              <button type="button" className="btn btn-primary" onClick={() => useStore.getState().startDraft(scope.id)}>
                <Icon name="plus" />
                New chat in {title}
              </button>
            )}
          </div>
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const e = entries[vi.index];
              return (
                <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
                  {e.type === "header" ? <div className="list-header">{e.label}</div> : <Row row={e.row} selected={e.row.id === selectedId} last={e.last} renaming={renaming === e.row.id} />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
