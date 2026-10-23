// The tray flyout (S7): Windows 11 shape, Acrylic, and only what needs you.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConversationRow, PermissionRequest, SyncStatus } from "../../shared/types";
import { Icon } from "../components/Icon";
import { IconButton, Tile } from "../components/controls";
import { api } from "../lib/api";
import { SEP, rowTime } from "../lib/format";

/** "Allow a command that permanently deletes files?" -> "wants to delete files". */
function wants(p: PermissionRequest): string {
  if (p.questions) return "has a question";
  if (p.destructive) return "wants to delete files";
  const m = p.title.match(/^Allow Claude to (.+?)\??$/);
  if (m) return `wants to ${m[1]}`;
  return "wants your approval";
}

function waiting(createdAt: string, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(createdAt)) / 60000);
  return min < 1 ? "waiting just now" : `waiting ${min} min`;
}

export function FlyoutApp() {
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [needs, setNeeds] = useState<PermissionRequest[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [, tick] = useState(0);
  useEffect(() => {
    // Each request shows the conversation it belongs to.
    for (const p of needs) {
      if (titles[p.conversationId]) continue;
      void api.list.detail(p.conversationId).then((d) => d && setTitles((t) => ({ ...t, [p.conversationId]: d.row.title })));
    }
    const timer = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(timer);
  }, [needs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const load = () => {
      void api.sync.status().then(setSync);
      void api.list.conversations({ scope: { kind: "all" }, filter: "updated" }).then((r) => setRows(r.rows.slice(0, 3)));
    };
    load();
    void api.chat.pending().then(setNeeds);
    const c = api.on("chat-pending", setNeeds);
    const a = api.on("sync-status", setSync);
    const b = api.on("index-changed", load);
    window.addEventListener("focus", load);
    return () => {
      a();
      b();
      c();
      window.removeEventListener("focus", load);
    };
  }, []);

  const behind = sync?.devices.some((d) => d.status === "old-sync");
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => api.window.setFlyoutHeight(Math.ceil(el.getBoundingClientRect().height));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="flyout" ref={ref}>
      <div className="fly-head">
        <span className="app-icon" aria-hidden>
          <Icon name="message-square" size={15} strokeWidth={2} />
        </span>
        <div className="fly-title">
          <div className="t1">Conversations</div>
          <div className="t2">
            <span className={`status-dot ${sync?.phase === "attention" ? "danger" : behind || sync?.phase === "offline" ? "warning" : "success"}`} />
            {sync?.headline ?? "Starting…"}
          </div>
        </div>
        <IconButton icon="settings" label="Settings" onClick={() => void api.app.showSettings()} />
      </div>
      {needs.length > 0 && (
        <>
          <div className="section-label">Needs you</div>
          {needs.map((p) => (
            <div className="fly-need" key={p.requestId}>
              <Icon name="shield-alert" className="warn" />
              <div className="text">
                <div className="t1">{titles[p.conversationId] ?? p.title}</div>
                <div className="t2">{[p.context.split("  ·  ").pop(), wants(p), waiting(p.createdAt)].filter(Boolean).join(SEP)}</div>
                <div className="fly-need-actions">
                  <button type="button" className="btn btn-primary" onClick={() => void api.app.showMain(p.conversationId)}>
                    {p.questions ? "Answer" : "Review"}
                  </button>
                  {!p.questions && (
                    <button type="button" className="btn btn-secondary" onClick={() => void api.chat.respond(p.requestId, "deny")}>
                      Deny
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </>
      )}
      {rows.length > 0 ? (
        <div className="section-label">Changed on other PCs</div>
      ) : (
        !needs.length && (
          <div className="fly-empty">
            <Icon name="cloud-check" />
            <span>Nothing new from other PCs</span>
          </div>
        )
      )}
      {rows.map((r) => (
        <button type="button" className="fly-row" key={r.id} onClick={() => void api.app.showMain(r.id)}>
          <Tile glyph={/laptop/i.test(r.lastPc ?? "") ? "laptop" : "monitor"} />
          <span className="text">
            <span className="t1 ellipsis">{r.title}</span>
            <span className="t2 ellipsis">{[r.lastPc, r.projectLabel].filter(Boolean).join(SEP)}</span>
          </span>
          <span className="when">{rowTime(r.lastAt)}</span>
        </button>
      ))}
      <div className="fly-foot">
        <button type="button" className="btn btn-secondary wide" onClick={() => void api.app.showMain()}>
          Open Conversations
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void api.sync.setPaused(!sync?.paused)}>
          {sync?.paused ? "Resume sync" : "Pause sync"}
        </button>
      </div>
    </div>
  );
}
