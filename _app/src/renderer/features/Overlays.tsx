import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { AppInfo, SearchHit } from "../../shared/types";
import { Icon } from "../components/Icon";
import { Button, IconButton, Kbd, Spinner, Tile } from "../components/controls";
import { api } from "../lib/api";
import { chooseDraftFolder } from "./Detail";
import { useStore } from "../lib/store";
import { SEP, agoLong, bytes, plural, rowTime, time24 } from "../lib/format";

/** Conversations shown before "Show all", as in the design: the actions stay in view. */
const TOP_HITS = 3;

// ------------------------------------------------------------------ search results

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

function titleMarks(title: string, query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return title;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return title.replace(re, "\u0001$1\u0002");
}

export function SearchResults() {
  const search = useStore((s) => s.search);
  const select = useStore((s) => s.select);
  const setOpen = useStore((s) => s.setSearchOpen);
  const setText = useStore((s) => s.setSearchText);
  const setIncludeTools = useStore((s) => s.setIncludeTools);
  const toast = useStore((s) => s.toast);
  const detail = useStore((s) => s.detail);
  const sync = useStore((s) => s.sync);
  const ref = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [search.text, search.includeTools]);
  const allHits = search.result?.hits ?? [];
  const hits = showAll ? allHits : allHits.slice(0, TOP_HITS);
  const hiddenHits = allHits.length - hits.length;
  const project = detail?.row.projectLabel;
  const folderName = detail?.folder?.split(/[\\/]/).filter(Boolean).pop() ?? project;

  const actions = useMemo(() => {
    const q = search.text.trim();
    const list: { id: string; icon: string; title: string; sub: string; key: string; run: () => void }[] = [];
    if (!hits.length && q) list.push({ id: "tools", icon: "file-code", title: "Search tool output and code too", sub: "Looks inside commands, file reads and diffs", key: "", run: () => setIncludeTools(true) });
    list.push({
      id: "new",
      icon: "plus",
      title: hits.length || !q ? `New chat${project ? ` in ${project}` : ""}` : `Start a chat about “${q}”`,
      sub: `Starts Claude Code${folderName ? ` in ${folderName}` : ""} on this PC`,
      key: "Ctrl+N",
      run: () => useStore.getState().startDraft(detail?.row.projectId ?? null),
    });
    if (detail)
      list.push({
        id: "cli",
        icon: "square-terminal",
        title: "Open selected in CLI",
        sub: "claude --resume in Windows Terminal",
        key: "Ctrl+Shift+O",
        run: async () => {
          const r = await api.cli.open(detail.row.id);
          toast({ text: r.message, icon: r.ok ? "terminal" : "alert" });
        },
      });
    list.push({ id: "folder", icon: "folder-open", title: "New chat in a folder…", sub: "Pick any folder on this PC; its project appears once the chat starts", key: "", run: () => void chooseDraftFolder() });
    list.push({ id: "sync", icon: "refresh-cw", title: "Sync now", sub: hits.length ? `Last synced ${sync?.lastSyncAt ? agoLong(sync.lastSyncAt) : "a while ago"}` : "A chat from another PC may not be here yet", key: "Ctrl+Shift+S", run: () => void api.sync.now() });
    return list;
  }, [search.text, hits.length, detail, project, folderName, sync?.lastSyncAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestion = search.result?.suggestion;
  const rows: ({ kind: "hit"; hit: SearchHit } | { kind: "more" } | { kind: "suggest" } | { kind: "action"; a: (typeof actions)[number] })[] = [
    ...hits.map((hit) => ({ kind: "hit" as const, hit })),
    ...(hiddenHits > 0 ? [{ kind: "more" as const }] : []),
    ...(suggestion && !hits.length ? [{ kind: "suggest" as const }] : []),
    ...actions.map((a) => ({ kind: "action" as const, a })),
  ];
  const active = Math.min(search.active, rows.length - 1);

  const run = (i: number, ctrl = false) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === "hit") {
      void select(r.hit.id);
      setOpen(false);
      if (ctrl)
        void api.cli.open(r.hit.id).then((res) => toast({ text: res.message, icon: res.ok ? "terminal" : "alert" }));
    } else if (r.kind === "more") setShowAll(true);
    else if (r.kind === "suggest" && suggestion) setText(suggestion.text);
    else if (r.kind === "action") {
      r.a.run();
      if (r.a.id !== "tools") setOpen(false);
    }
  };

  useEffect(() => {
    const on = (e: Event) => run(active, !!(e as CustomEvent<{ ctrl: boolean }>).detail?.ctrl);
    window.addEventListener("app:search-enter", on);
    return () => window.removeEventListener("app:search-enter", on);
  });
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest(".search-field")) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [setOpen]);
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!search.open || !search.text.trim()) return null;
  let i = -1;
  return (
    <div className="popover search-results" id="search-results" role="listbox" aria-label="Search results" ref={ref}>
      <div className="scroller">
        {hits.length > 0 && <div className="section-label">Conversations</div>}
        {!hits.length && search.result && (
          <div className="no-results">
            <div className="t1">No conversations match “{search.text.trim()}”</div>
            <div className="t2">
              Searched titles, prompts and replies{search.includeTools ? ", tool output and code" : ""} in {plural(search.result.searchedConversations, "conversation")} from {plural(search.result.pcCount, "PC")}.
            </div>
          </div>
        )}
        {rows.map((r) => {
          i++;
          const idx = i;
          const selected = idx === active;
          if (r.kind === "hit")
            return (
              <button key={r.hit.id} type="button" role="option" aria-selected={selected} className="palette-row" onMouseEnter={() => useStore.setState((s) => ({ search: { ...s.search, active: idx } }))} onClick={() => run(idx)}>
                <Tile glyph="message-square" />
                <span className="text">
                  <span className="title ellipsis">
                    <Highlighted text={titleMarks(r.hit.title, search.text)} />
                  </span>
                  <span className="sub ellipsis">
                    {r.hit.snippet ? (
                      <>
                        “<Highlighted text={r.hit.snippet} />”{SEP}
                      </>
                    ) : (
                      `${r.hit.projectLabel}${SEP}`
                    )}
                    {[r.hit.lastPc, rowTime(r.hit.lastAt)].filter(Boolean).join(SEP)}
                  </span>
                </span>
                {selected && <Kbd>↵</Kbd>}
              </button>
            );
          if (r.kind === "more")
            return (
              <button key="more" type="button" role="option" aria-selected={selected} className="palette-row more" onMouseEnter={() => useStore.setState((s) => ({ search: { ...s.search, active: idx } }))} onClick={() => run(idx)}>
                <span className="more-pad" aria-hidden />
                <span className="text">
                  <span className="title link">Show all {plural(allHits.length, "conversation")}</span>
                </span>
                {selected && <Kbd>↵</Kbd>}
              </button>
            );
          if (r.kind === "suggest" && suggestion)
            return (
              <Fragment key="suggest">
                <div className="section-label">Did you mean</div>
                <button type="button" role="option" aria-selected={selected} className="palette-row" onClick={() => run(idx)}>
                  <Tile glyph="search" />
                  <span className="text">
                    <span className="title">{suggestion.text}</span>
                    <span className="sub">{plural(suggestion.count, "conversation")}</span>
                  </span>
                  {selected && <Kbd>↵</Kbd>}
                </button>
              </Fragment>
            );
          if (r.kind === "action")
            return (
              <Fragment key={r.a.id}>
                {r.a === actions[0] && <div className="section-label">Actions</div>}
                <button type="button" role="option" aria-selected={selected} className="palette-row" onClick={() => run(idx)}>
                  <Tile glyph={r.a.icon} />
                  <span className="text">
                    <span className="title">{r.a.title}</span>
                    <span className="sub ellipsis">{r.a.sub}</span>
                  </span>
                  {r.a.key && <Kbd>{r.a.key}</Kbd>}
                </button>
              </Fragment>
            );
          return null;
        })}
      </div>
      <div className="key-hints">
        <span>
          <b>↑ ↓</b>Move
        </span>
        <span>
          <b>↵</b>Open here
        </span>
        <span>
          <b>Ctrl+↵</b>Open in CLI
        </span>
        <span>
          <b>Hold Ctrl</b>Show all shortcuts
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sync popover

export function SyncPopover() {
  const popover = useStore((s) => s.popover);
  const setPopover = useStore((s) => s.setPopover);
  const sync = useStore((s) => s.sync);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (popover !== "sync") return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest(".sync-status")) setPopover(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPopover(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [popover, setPopover]);
  if (popover !== "sync" || !sync) return null;

  const behind = sync.devices.filter((d) => d.status === "old-sync" && !d.isThisPc);
  const next = sync.nextCheckInMs != null ? Math.round(sync.nextCheckInMs / 1000) : null;
  const headIcon = sync.phase === "attention" ? "cloud-off" : sync.phase === "offline" ? "wifi-off" : "cloud";
  const iconFor = (k: string) => ({ uploaded: "cloud-upload", downloaded: "cloud-download", saved: "hard-drive", "kept-both": "git-fork", failed: "cloud-off", edit: "pencil" })[k] ?? "cloud";

  return (
    <div className="popover from-bottom sync-popover" role="dialog" aria-label="Sync" ref={ref}>
      <div className="sync-head">
        <Icon name={headIcon} />
        <div>
          <div className="t1">{sync.headline}</div>
          <div className="t2">
            {sync.phase === "attention"
              ? `Last upload ${sync.lastSyncAt ? time24(sync.lastSyncAt) : "a while ago"}${SEP}trying again${next != null ? ` in ${next} s` : ""}`
              : `This PC synced ${sync.lastSyncAt ? agoLong(sync.lastSyncAt) : "not yet"}${next != null && !sync.paused ? `${SEP}next check in ${next} s` : ""}`}
          </div>
        </div>
      </div>
      <div className="device-list">
        {sync.devices.map((d) => (
          <div className="device-row" key={d.name}>
            <Tile glyph={d.glyph} />
            <div className="text">
              <div className="t1">{d.name}</div>
              <div className="t2">
                {d.isThisPc
                  ? `This PC${SEP}${sync.pendingUploads ? `${plural(sync.pendingUploads, "change")} waiting to upload` : `synced ${sync.lastSyncAt ? agoLong(sync.lastSyncAt) : "not yet"}`}`
                  : `Seen ${agoLong(d.lastSeenAt)}`}
              </div>
            </div>
            {d.status === "old-sync" && <span className="status-dot warning" aria-label="Needs the new sync" />}
          </div>
        ))}
      </div>
      {sync.phase === "attention" || sync.phase === "offline" ? (
        <div className="sync-note">
          <Icon name="info" className="info" />
          <div className="text">
            <div className="t1">Your changes are safe on this PC</div>
            <div className="t2">They upload by themselves once GitHub answers. Nothing needs doing.</div>
          </div>
        </div>
      ) : (
        behind.length > 0 && (
          <div className="sync-note">
            <Icon name="triangle-alert" className="warn" />
            <div className="text">
              <div className="t1">{behind.length === 1 ? `${behind[0].name} still runs the old sync` : `${behind.length} PCs still run the old sync`}</div>
              <div className="t2">{behind.length === 1 ? "Run the one-line upgrade on it, or install Conversations there." : "Run the one-line upgrade on each of them, or install Conversations there."}</div>
            </div>
            <Button kind="plain" onClick={() => void api.app.openExternal("https://github.com/Samprogrammer143/conversations-app#upgrade-a-pc-that-already-has-it")}>
              How
            </Button>
          </div>
        )
      )}
      {sync.cloudSyncedClaudeDir && (
        <div className="sync-note">
          <Icon name="triangle-alert" className="warn" />
          <div className="text">
            <div className="t1">Your Claude folder is inside {cloudName(sync.cloudSyncedClaudeDir)}</div>
            <div className="t2">It copies every PC’s Claude Code files here as well. Sync only changes this PC’s own folders, but moving the Claude folder out of {cloudName(sync.cloudSyncedClaudeDir)} is safest.</div>
          </div>
        </div>
      )}
      {sync.recent.length > 0 && (
        <>
          <div className="section-label">Recent</div>
          {sync.recent.slice(0, 4).map((r, i) => (
            <div className="recent-row" key={i}>
              <Icon name={iconFor(r.kind)} size={14} />
              <span className="ellipsis">{r.text}</span>
              <span className="when">{rowTime(r.at)}</span>
            </div>
          ))}
        </>
      )}
      <div className="sync-actions">
        <Button onClick={() => void api.sync.now()}>{sync.phase === "attention" ? "Retry now" : "Sync now"}</Button>
        <Button kind="plain" onClick={() => void api.sync.setPaused(!sync.paused)}>
          {sync.paused ? "Resume" : "Pause"}
        </Button>
        {sync.phase === "attention" ? (
          <Button kind="plain" className="size" onClick={() => void api.app.openExternal("https://www.githubstatus.com")}>
            GitHub status
          </Button>
        ) : (
          sync.repoSizeBytes != null && <span className="size">Repository {bytes(sync.repoSizeBytes)}</span>
        )}
      </div>
    </div>
  );
}

/** "OneDrive", "Dropbox", "Google Drive" or "iCloud Drive", from the folder the engine reported. */
function cloudName(dir: string): string {
  if (/onedrive/i.test(dir)) return "OneDrive";
  if (/dropbox/i.test(dir)) return "Dropbox";
  if (/google ?drive|my drive/i.test(dir)) return "Google Drive";
  if (/icloud/i.test(dir)) return "iCloud Drive";
  return "a cloud folder";
}

// ------------------------------------------------------------------ context menu

export function copyResumeCommand(id: string) {
  void api.app.copyText(`claude --resume ${id}`);
  useStore.getState().toast({ text: "Copied the claude --resume command", icon: "check" });
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const close = useStore((s) => s.closeMenu);
  const rows = useStore((s) => s.list?.rows);
  const detail = useStore((s) => s.detail);
  const toast = useStore((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const row = rows?.find((r) => r.id === menu?.id) ?? (detail?.row.id === menu?.id ? detail?.row : undefined);

  useEffect(() => {
    if (!menu) return;
    setActive(0);
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", close);
    ref.current?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu || !row) return null;
  const s = useStore.getState();
  // Figma: Context Menu / Conversation.
  const items: ({ sep: true } | { label: string; icon: string; key?: string; destructive?: boolean; run: () => void })[] = [
    { label: "Open in CLI", icon: "square-terminal", key: "Ctrl+Shift+O", run: async () => { const r = await api.cli.open(row.id); toast({ text: r.message, icon: r.ok ? "terminal" : "alert" }); } },
    { label: "Copy resume command", icon: "copy", key: "Ctrl+Shift+C", run: () => copyResumeCommand(row.id) },
    { label: row.pinned ? "Unpin" : "Pin", icon: row.pinned ? "pin-off" : "pin", key: "Ctrl+D", run: () => void s.togglePin(row.id) },
    { label: "Rename…", icon: "pencil", key: "F2", run: () => useStore.setState({ renaming: row.id }) },
    { sep: true },
    ...(row.cwd
      ? [
          {
            label: "Show in folder",
            icon: "folder-open",
            run: () =>
              void api.app.openPath(row.cwd!).then((err: unknown) => {
                if (typeof err === "string" && err) toast({ text: err === "Only folders can be opened" ? "That folder isn't on this PC" : err, icon: "alert" });
              }),
          },
        ]
      : []),
    { label: row.archived ? "Unarchive" : "Archive", icon: row.archived ? "archive-restore" : "archive", key: "Ctrl+E", run: () => void s.archive(row.id, !row.archived) },
    { label: "Delete from all PCs", icon: "x", destructive: true, run: () => s.remove(row.id) },
  ];
  const actionable = items.filter((x): x is Exclude<(typeof items)[number], { sep: true }> => !("sep" in x));
  const x = Math.min(menu.x, window.innerWidth - 316);
  const y = Math.min(menu.y, window.innerHeight - (actionable.length * 28 + (items.length - actionable.length) * 9 + 16));
  return (
    <div
      className="menu context"
      role="menu"
      ref={ref}
      tabIndex={-1}
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        if (e.key === "ArrowDown") setActive((a) => (a + 1) % actionable.length);
        if (e.key === "ArrowUp") setActive((a) => (a - 1 + actionable.length) % actionable.length);
        if (e.key === "Enter") {
          actionable[active].run();
          close();
        }
      }}
    >
      {items.map((it, i) =>
        "sep" in it ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={`menu-item${it.destructive ? " destructive" : ""}`}
            data-active={actionable[active] === it}
            onMouseEnter={() => setActive(actionable.indexOf(it))}
            onClick={() => {
              it.run();
              close();
            }}
          >
            <Icon name={it.icon} />
            {it.label}
            {it.key && <span className="shortcut">{it.key}</span>}
          </button>
        ),
      )}
    </div>
  );
}

// ------------------------------------------------------------------ toasts

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <Icon name={t.icon === "terminal" ? "square-terminal" : t.icon === "alert" ? "info" : "check"} />
          <span className="label">{t.text}</span>
          {t.actionLabel && (
            <button
              type="button"
              className="action"
              onClick={() => {
                t.onAction?.();
                dismiss(t.id);
              }}
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ hold Ctrl

type Place = "left" | "right" | "below-right" | "above" | "above-right";
const BADGES: { selector: string; keys: string; label: string; place: Place }[] = [
  { selector: '.sb-titlebar [aria-label^="Hide sidebar"], .list-toolbar [aria-label^="Show sidebar"]', keys: "Ctrl+B", label: "Sidebar", place: "left" },
  { selector: ".search-field", keys: "Ctrl+K", label: "Search", place: "below-right" },
  { selector: ".focus-usage", keys: "Ctrl+F", label: "Leave focus", place: "above" },
  { selector: '.list-toolbar [aria-label^="New chat"]', keys: "Ctrl+N", label: "New chat", place: "left" },
  { selector: ".filters .segmented", keys: "Ctrl+1 2 3", label: "Filters", place: "right" },
  { selector: ".detail-title .title-text", keys: "Ctrl+D", label: "Pin", place: "right" },
  { selector: '.detail-toolbar [title^="Open in CLI"], .detail-toolbar [aria-label^="Open in CLI"]', keys: "Ctrl+Shift+O", label: "Open in CLI", place: "left" },
  { selector: ".sync-status", keys: "Ctrl+Shift+S", label: "Sync", place: "above" },
  { selector: '.sb-footer [aria-label^="Settings"]', keys: "Ctrl+,", label: "Settings", place: "above-right" },
];

/** Where each badge goes, next to the control it belongs to. */
function badgeStyle(place: Place, r: DOMRect): React.CSSProperties {
  const vw = window.innerWidth;
  // Badges above the sidebar footer share one line: the top of the sync status.
  const footerTop = document.querySelector(".sync-status")?.getBoundingClientRect().top ?? r.top;
  switch (place) {
    case "left":
      return { right: vw - r.left + 6, top: r.top + r.height / 2 - 11 };
    case "right":
      return { left: r.right + 6, top: r.top + r.height / 2 - 11 };
    case "below-right":
      return { right: vw - r.right, top: r.bottom + 6 };
    case "above":
      return { left: r.left, top: footerTop - 28 };
    case "above-right":
      return { right: vw - r.right, top: footerTop - 28 };
  }
}

/** "Release Ctrl" sits centred over the conversation, 8 px above the composer. */
function releaseHintStyle(): React.CSSProperties {
  const pane = document.querySelector(".detail")?.getBoundingClientRect();
  const composer = document.querySelector(".detail .composer")?.getBoundingClientRect();
  if (!pane || !composer) return {};
  return { left: pane.left + pane.width / 2, top: composer.top - 8 - 34, bottom: "auto" };
}

export function ShortcutOverlay() {
  const show = useStore((s) => s.showShortcuts);
  const [, force] = useState(0);
  useEffect(() => {
    if (!show) return;
    force((n) => n + 1);
    document.body.classList.add("dim-for-badges");
    return () => document.body.classList.remove("dim-for-badges");
  }, [show]);
  if (!show) return null;
  return (
    <>
      {BADGES.map((b) => {
        const el = document.querySelector(b.selector);
        if (!el) return null;
        return (
          <span key={b.keys} className="kbd-badge" style={badgeStyle(b.place, el.getBoundingClientRect())}>
            <b>{b.keys}</b> {b.label}
          </span>
        );
      })}
      <span className="release-hint" style={releaseHintStyle()}>
        Release Ctrl to hide shortcuts
      </span>
    </>
  );
}

// ------------------------------------------------------------------ welcome (S6)

/** In the main window: only if the welcome window was never shown (an older shell). */
export function Welcome() {
  const welcome = useStore((s) => s.welcome);
  const info = useStore((s) => s.info);
  const sidebar = useStore((s) => s.sidebar);
  if (!welcome || !info) return null;
  return (
    <div className="scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <WelcomeContent
          info={info}
          pcs={sidebar?.devices.length ?? 1}
          total={sidebar?.total ?? 0}
          onDone={() => {
            void api.app.finishWelcome();
            useStore.setState({ welcome: false });
          }}
        />
      </div>
    </div>
  );
}

/** The welcome window (S6): its own 560 × 643 window on first run. */
export function WelcomeApp() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [counts, setCounts] = useState<{ pcs: number; total: number }>({ pcs: 1, total: 0 });
  useEffect(() => {
    void api.app.info().then(setInfo);
    const load = () => void api.list.sidebar().then((s) => setCounts({ pcs: s.devices.length || 1, total: s.total }));
    load();
    return api.on("index-changed", load);
  }, []);
  if (!info) return <div className="welcome-window" />;
  return (
    <div className="welcome-window">
      <div className="welcome-drag drag" />
      <WelcomeContent
        info={info}
        pcs={counts.pcs}
        total={counts.total}
        onDone={() => {
          void api.app.finishWelcome().then(() => window.close());
        }}
      />
    </div>
  );
}

/** "owner/name" for GitHub; a folder name for anything else (a local stand-in). */
const repoLabel = (repo: string | null) => (!repo ? "" : /[\\:]/.test(repo) ? repo.split(/[\\/]/).filter(Boolean).pop()!.replace(/\.git$/, "") : repo);

function WelcomeContent({ info, pcs, total, onDone }: { info: AppInfo; pcs: number; total: number; onDone: () => void }) {
  const [claude, setClaude] = useState<AppInfo["claude"] | null>(info.claude);
  const [checking, setChecking] = useState(false);
  useEffect(() => setClaude(info.claude), [info]);
  const done = onDone;
  const recheck = async () => {
    setChecking(true);
    setClaude(await api.app.checkClaude());
    setChecking(false);
  };
  return (
    <>
        <IconButton icon="x" label="Close" className="close" onClick={done} />
        <div className="welcome-icon">
          <Icon name="message-square" size={36} strokeWidth={1.5} />
        </div>
        <h1 id="welcome-title">Welcome to Conversations</h1>
        <p className="lede">Every Claude Code chat from all your PCs, in one place and always in sync.</p>
        <div className="checklist">
          <div className="check-row">
            <Icon name={claude?.found ? "circle-check" : "triangle-alert"} className={claude?.found ? "ok" : "bad"} />
            <div className="text" style={{ flex: 1 }}>
              <div className="t1">{claude?.found ? `Claude Code ${claude.version ?? ""} found` : "Claude Code not found"}</div>
              <div className="t2">{claude?.found ? (claude.signedIn === false ? "Not signed in: open a terminal and run claude once" : "Signed in, so chats here use your existing plan") : "Chat and Open in CLI need it. Install it from PowerShell, then check again."}</div>
              {!claude?.found && (
                <div className="cmd">
                  <span style={{ flex: 1 }}>npm install -g @anthropic-ai/claude-code</span>
                  <IconButton icon="copy" label="Copy command" onClick={() => void api.app.copyText("npm install -g @anthropic-ai/claude-code")} />
                </div>
              )}
            </div>
          </div>
          <div className="check-row">
            <Icon name={info.syncSetUp ? "circle-check" : "triangle-alert"} className={info.syncSetUp ? "ok" : "bad"} />
            <div>
              <div className="t1">{info.syncSetUp ? "Sync repository connected" : "Sync isn't set up on this PC"}</div>
              <div className="t2">{info.syncSetUp ? `${repoLabel(info.repo)}${SEP}private` : "Run Set up Conversations on this PC, with your conversations repository"}</div>
            </div>
          </div>
          <div className="check-row">
            <Icon name="circle-check" className="ok" />
            <div>
              <div className="t1">
                {plural(total, "conversation")} from {plural(pcs, "PC")}
              </div>
              <div className="t2">Chats filed under other folder names now sit with their project</div>
            </div>
          </div>
          <div className="check-row">
            <Icon name="circle-check" className="ok" />
            <div>
              <div className="t1">This PC is “{info.machine}”</div>
              <div className="t2">Change it any time in Settings</div>
            </div>
          </div>
        </div>
        {claude?.found ? (
          <>
            <Button kind="primary" className="btn-lg" onClick={done}>
              Get started
            </Button>
            <div className="foot">Nothing new is uploaded until you start a chat.</div>
          </>
        ) : (
          <>
            <div className="row-actions">
              <Button kind="primary" className="btn-lg" icon={checking ? undefined : "refresh-cw"} onClick={() => void recheck()}>
                {checking ? <Spinner /> : null}
                Check again
              </Button>
              <Button kind="plain" onClick={done}>
                Continue without chat
              </Button>
            </div>
            <div className="foot">Reading works now. Chat and Open in CLI turn on when Claude Code is found.</div>
          </>
        )}
    </>
  );
}
