import { useEffect, useRef, useState } from "react";
import type { ListQuery, PlanUsage, SyncStatus } from "../../shared/types";
import { Icon } from "../components/Icon";
import { IconButton, Kbd, Spinner, Tile } from "../components/controls";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { chooseDraftFolder } from "./Detail";
import { WorkspaceSwitcher } from "./Workspaces";
import { ago, resetText, time24 } from "../lib/format";

type Scope = ListQuery["scope"];

const STALE_MS = 20 * 60_000;

/** The plan's usage windows (session, week, Fable week), as /usage shows them. */
export function UsageMeters({ usage }: { usage: PlanUsage | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (!usage?.meters.length) return null;
  const stale = now - usage.at > STALE_MS;
  const checked = stale ? ` · Last checked ${time24(new Date(usage.at).toISOString())}` : "";
  return (
    <div className={`sb-usage${stale ? " stale" : ""}`} role="group" aria-label="Plan usage">
      {usage.meters.map((m) => {
        const tone = m.percent >= 90 ? " hot" : m.percent >= 70 ? " warm" : "";
        const reset = resetText(m.resetsAt, now);
        return (
          <div key={m.key} className="usage-meter" title={`${m.label}: ${m.percent}% used${reset ? `. ${reset}` : ""}${checked}`}>
            <div className="usage-row">
              <span className="usage-label ellipsis">{m.label}</span>
              <span className="usage-pct">{m.percent}%</span>
            </div>
            <div className="usage-track" role="progressbar" aria-label={m.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.percent} aria-valuetext={`${m.percent}% used${reset ? `, ${reset.toLowerCase()}` : ""}`}>
              <div className={`usage-fill${tone}`} style={{ width: `${m.percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
const sameScope = (a: Scope, b: Scope) => JSON.stringify(a) === JSON.stringify(b);

function Item({ scope, label, lead, trail, status }: { scope: Scope; label: string; lead: React.ReactNode; trail?: React.ReactNode; status?: "warning" | "success" | null }) {
  const current = useStore((s) => sameScope(s.scope, scope));
  const setScope = useStore((s) => s.setScope);
  return (
    <button type="button" className="sb-item" aria-current={current} onClick={() => setScope(scope)}>
      {lead}
      <span className="sb-label ellipsis">{label}</span>
      {status && <span className={`status-dot ${status}`} aria-label={status === "warning" ? "Needs attention" : undefined} />}
      {trail != null && <span className="sb-trail">{trail}</span>}
    </button>
  );
}

export function SearchField() {
  const text = useStore((s) => s.search.text);
  const open = useStore((s) => s.search.open);
  const setText = useStore((s) => s.setSearchText);
  const setOpen = useStore((s) => s.setSearchOpen);
  const move = useStore((s) => s.moveSearch);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => ref.current?.focus();
    window.addEventListener("app:focus-search", focus);
    return () => window.removeEventListener("app:focus-search", focus);
  }, []);

  return (
    <div className="search-field">
      <Icon name="search" size={14} />
      <input
        ref={ref}
        type="text"
        placeholder="Search"
        aria-label="Search conversations"
        aria-expanded={open && !!text}
        aria-controls="search-results"
        role="combobox"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => text && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Escape") {
            if (text) setText("");
            setOpen(false);
            ref.current?.blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent("app:search-enter", { detail: { ctrl: e.ctrlKey } }));
          }
        }}
      />
      {text ? (
        <button type="button" className="clear" aria-label="Clear search" onClick={() => setText("")}>
          <Icon name="x" size={10} strokeWidth={2.5} />
        </button>
      ) : (
        <Kbd>Ctrl+K</Kbd>
      )}
    </div>
  );
}

export function syncGlyph(s: SyncStatus | null): { node: React.ReactNode } {
  if (!s) return { node: <Icon name="cloud" className="glyph" /> };
  if (s.phase === "checking" || s.phase === "downloading" || s.phase === "uploading") return { node: <span className="glyph"><Spinner /></span> };
  if (s.phase === "offline") return { node: <Icon name="cloud-off" className="glyph" /> };
  if (s.phase === "attention") return { node: <Icon name="cloud-off" className="glyph danger" /> };
  if (s.phase === "paused") return { node: <Icon name="circle-pause" className="glyph" /> };
  if (s.phase === "not-set-up") return { node: <Icon name="triangle-alert" className="glyph warning" /> };
  if (s.devices.some((d) => d.status === "old-sync")) return { node: <Icon name="triangle-alert" className="glyph warning" /> };
  return { node: <Icon name="cloud-check" className="glyph" /> };
}

export function Sidebar({ overlay = false }: { overlay?: boolean }) {
  const sidebar = useStore((s) => s.sidebar);
  const sync = useStore((s) => s.sync);
  const usage = useStore((s) => s.usage);
  const popover = useStore((s) => s.popover);
  const setPopover = useStore((s) => s.setPopover);
  const machine = useStore((s) => s.info?.machine);
  const glyph = syncGlyph(sync);

  return (
    <aside className={`sidebar${overlay ? " overlay" : ""}`} aria-label="Sidebar">
      <div className="sb-titlebar drag">
        <WorkspaceSwitcher />
        <span className="spacer" />
        <IconButton icon="panel-left" label="Hide sidebar (Ctrl+B)" onClick={() => window.dispatchEvent(new Event("app:toggle-sidebar"))} />
      </div>
      <div className="sb-content scroll">
        <SearchField />
        <div className="sb-header">Library</div>
        <Item scope={{ kind: "all" }} label="All Conversations" lead={<Icon name="message-square" className="lead-glyph" />} trail={sidebar?.total ?? ""} />
        <Item scope={{ kind: "pinned" }} label="Pinned" lead={<Icon name="pin" className="lead-glyph" />} trail={sidebar?.pinned || ""} />
        {!!sidebar?.archived && <Item scope={{ kind: "archived" }} label="Archived" lead={<Icon name="archive" className="lead-glyph" />} trail={sidebar.archived} />}

        <div className="sb-header with-action">
          <span>Projects</span>
          <IconButton icon="plus" label="New chat in a folder…" size={14} className="sb-header-action" onClick={() => void chooseDraftFolder()} />
        </div>
        {sidebar?.projects.map((p) => (
          <Item key={p.id} scope={{ kind: "project", id: p.id }} label={p.label} lead={<Tile size={16} glyphSize={13} glyph={p.kind === "home" ? "house" : p.folder || p.onThisPc ? "folder" : "folder-git-2"} />} trail={p.count} />
        ))}
        {!!sidebar?.otherFolders.count && <Item scope={{ kind: "project", id: "folder:*" }} label="Other folders" lead={<Tile size={16} glyphSize={13} glyph="folder" />} trail={sidebar.otherFolders.count} />}

        {!!sidebar?.devices.length && <div className="sb-header">Devices</div>}
        {sidebar?.devices.map((d) => (
          <Item
            key={d.name}
            scope={{ kind: "device", name: d.name }}
            label={d.name}
            lead={<Tile size={16} glyphSize={13} glyph={d.glyph} />}
            status={d.status === "old-sync" ? "warning" : null}
            trail={d.name === machine ? "This PC" : d.lastSeenAt ? ago(d.lastSeenAt) : ""}
          />
        ))}
      </div>
      <UsageMeters usage={usage} />
      <div className="sb-footer">
        <button type="button" className="sync-status" aria-expanded={popover === "sync"} aria-haspopup="dialog" onClick={() => setPopover(popover === "sync" ? null : "sync")}>
          {glyph.node}
          <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span className="t1 ellipsis">{sync?.headline ?? "Starting…"}</span>
            <span className="t2 ellipsis">{sync?.detail ?? ""}</span>
          </span>
        </button>
        <IconButton icon="settings" label="Settings (Ctrl+,)" onClick={() => void api.app.showSettings()} />
      </div>
    </aside>
  );
}
