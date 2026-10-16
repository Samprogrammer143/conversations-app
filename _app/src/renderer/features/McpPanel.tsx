// /mcp in the composer: the chat's MCP servers, as the terminal's /mcp screen shows
// them, with Reconnect, Enable and Disable when the chat's Claude Code is running here.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Effort, McpServerInfo } from "../../shared/types";
import { Icon } from "../components/Icon";
import { IconButton, Spinner } from "../components/controls";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { SEP } from "../lib/format";

const STATUS: Record<McpServerInfo["status"], { label: string; dot: string }> = {
  connected: { label: "Connected", dot: "success" },
  pending: { label: "Connecting", dot: "warning" },
  failed: { label: "Failed", dot: "danger" },
  "needs-auth": { label: "Needs sign-in", dot: "warning" },
  disabled: { label: "Off", dot: "neutral" },
};

export function McpPanel({
  id,
  projectId,
  folder,
  startWith,
  onClose,
}: {
  id: string | null;
  projectId: string | null;
  folder: string | null;
  /** The chat's model, effort and mode: what its Claude Code starts with, if /mcp has to start it. */
  startWith: { model: string | null; effort: Effort | null; permissionMode: string };
  onClose: () => void;
}) {
  const [data, setData] = useState<{ live: boolean; servers: McpServerInfo[]; note?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useStore((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  // Only the newest answer is shown; one that comes back late is dropped.
  const asked = useRef(0);

  const load = useCallback(async () => {
    const n = ++asked.current;
    setLoading(true);
    setError(null);
    const r = await api.chat.mcp(id, projectId, folder, startWith);
    if (n !== asked.current) return;
    setLoading(false);
    if (!r.ok) setError(r.err ?? "Claude Code couldn't list the servers");
    setData({ live: r.live, servers: r.servers, note: r.note });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, projectId, folder]);
  useEffect(
    () => () => {
      asked.current++;
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const act = async (s: McpServerInfo, action: "reconnect" | "enable" | "disable") => {
    if (!id) return;
    setBusy(`${s.name}:${action}`);
    const n = asked.current;
    const r = await api.chat.mcpAction(id, s.name, action, startWith);
    setBusy(null);
    // Closed or asked again meanwhile: the toast still says what happened, the list is left alone.
    if (n !== asked.current) {
      toast({ text: r.ok ? `${s.name}: done` : `${s.name}: ${r.err ?? `couldn't ${action}`}`, icon: r.ok ? "check" : "alert" });
      return;
    }
    if (r.servers) setData((d) => (d ? { ...d, servers: r.servers! } : d));
    const done = r.servers?.find((x) => x.name === s.name);
    if (!r.ok) toast({ text: `${s.name}: ${r.err ?? `couldn't ${action}`}`, icon: "alert" });
    else if (action === "reconnect") toast({ text: done?.status === "connected" ? `${s.name} is connected` : `${s.name}: ${STATUS[done?.status ?? "failed"].label.toLowerCase()}`, icon: done?.status === "connected" ? "check" : "alert" });
    else toast({ text: `${s.name} turned ${action === "enable" ? "on" : "off"}`, icon: "check" });
  };

  const signIn = async (s: McpServerInfo) => {
    if (!id) return;
    const r = await api.cli.open(id);
    toast({ text: r.ok ? `In the terminal, type /mcp and choose ${s.name} to sign in` : r.message, icon: r.ok ? "terminal" : "alert", durationMs: 10_000 });
    onClose();
  };

  const counts = data ? `${data.servers.filter((s) => s.status === "connected").length} of ${data.servers.length} connected` : "";
  return (
    <div className="mcp-panel" role="dialog" aria-label="MCP servers" ref={ref}>
      <div className="mcp-head">
        <span className="mcp-title">MCP servers</span>
        <span className="mcp-count">{counts}</span>
        <span className="spacer" />
        {loading && data ? <Spinner size={14} /> : <IconButton icon="refresh-cw" label="Check again" disabled={loading || !!busy} onClick={() => void load()} />}
        <IconButton icon="x" label="Close (Esc)" onClick={onClose} />
      </div>
      <div className="mcp-list scroll">
        {!data ? (
          <div className="mcp-empty">
            <Spinner size={14} /> {id ? "Starting this chat’s Claude Code and its servers…" : "Asking Claude Code…"}
          </div>
        ) : error ? (
          <div className="mcp-empty">{error}</div>
        ) : data.servers.length === 0 ? (
          <div className="mcp-empty">No MCP servers are set up for this folder.</div>
        ) : (
          data.servers.map((s) => (
            <div className="mcp-row" key={s.name} data-status={s.status}>
              <span className={`status-dot ${STATUS[s.status].dot}`} aria-hidden />
              <div className="mcp-what">
                <div className="mcp-name ellipsis">{s.name}</div>
                <div className="mcp-sub ellipsis" title={s.error ?? undefined}>
                  {[STATUS[s.status].label, s.status === "connected" && s.toolCount ? `${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}` : null, s.scope, s.error].filter(Boolean).join(SEP)}
                </div>
              </div>
              {data.live && s.status === "needs-auth" && (
                <button type="button" className="btn btn-secondary btn-small" onClick={() => void signIn(s)}>
                  <Icon name="square-terminal" size={13} />
                  Sign in
                </button>
              )}
              {data.live && s.status !== "disabled" && s.status !== "needs-auth" && (
                <button type="button" className={`btn btn-small ${s.status === "failed" ? "btn-primary" : "btn-secondary"}`} disabled={!!busy} onClick={() => void act(s, "reconnect")}>
                  {busy === `${s.name}:reconnect` ? <Spinner size={12} /> : null}
                  Reconnect
                </button>
              )}
              {data.live && (
                <button type="button" className="btn btn-plain btn-small" disabled={!!busy} onClick={() => void act(s, s.status === "disabled" ? "enable" : "disable")}>
                  {busy?.startsWith(`${s.name}:`) && !busy.endsWith("reconnect") ? <Spinner size={12} /> : null}
                  {s.status === "disabled" ? "Turn on" : "Turn off"}
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {data && !data.live && data.servers.length > 0 && <div className="mcp-foot">{data.note ? `${data.note} This is what it would have.` : "This new chat hasn’t started yet, so this is what it will have. Its servers connect when you send the first message."}</div>}
    </div>
  );
}
