// /mcp in the composer: the chat's MCP servers, as the terminal's /mcp screen shows
// them. When the chat's Claude Code is running here: Sign in (in the browser, no
// terminal), Reconnect, Turn on and off, and a server's details (its tools, where it is
// set up, Sign out and Sign in again).

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

const WHERE: Record<string, string> = {
  user: "Your settings (all folders)",
  project: "This project's .mcp.json",
  local: "This folder, on this PC only",
  claudeai: "claude.ai connector",
  plugin: "A plugin",
  sdk: "The app",
  enterprise: "Your organisation",
  managed: "Your organisation",
};

const TRANSPORT: Record<string, string> = { stdio: "Runs on this PC", http: "Web (HTTP)", sse: "Web (SSE)", "claudeai-proxy": "Through claude.ai", sdk: "In the app" };

/** Servers that sign in with OAuth in the browser (Sign out only for the first two). */
const usesSignIn = (s: McpServerInfo) => s.transport === "http" || s.transport === "sse" || s.transport === "claudeai-proxy" || s.scope === "claudeai";
const canSignOut = (s: McpServerInfo) => s.transport === "http" || s.transport === "sse";

/** How often the panel looks again while a sign-in finishes in the browser, and for how long. */
const POLL_MS = 2000;
const SIGN_IN_WAIT_MS = 10 * 60 * 1000;

type Signing = {
  name: string;
  url: string;
  /** Claude Code on this PC waits for the browser (otherwise it finishes on claude.ai, then Done). */
  callbackExpected: boolean;
  /** The page opened in the browser by itself (otherwise the link is shown to open or copy). */
  opened: boolean;
  since: number;
  /** The server has been seen not connected since this sign-in began (so "connected" means it worked). */
  sawOther: boolean;
  /** Its error when the sign-in began ("Authentication cleared" after Sign in again): a new one means it failed. */
  startError: string | null;
};

/** Sign-ins still waiting, by chat: closing and reopening the panel keeps waiting for them. */
const waitingSignIns = new Map<string, Signing>();

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
  const [open, setOpen] = useState<string | null>(null);
  const [signing, setSigningState] = useState<Signing | null>(() => (id ? (waitingSignIns.get(id) ?? null) : null));
  const [pasted, setPasted] = useState("");
  const toast = useStore((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  // Only the newest answer is shown; one that comes back late is dropped.
  const asked = useRef(0);
  // Bumped by every change to the list, so a look that started before it doesn't undo it.
  const version = useRef(0);
  const busyRef = useRef<string | null>(null);
  const polling = useRef(false);
  busyRef.current = busy;

  const setSigning = useCallback(
    (v: Signing | null) => {
      if (id) {
        if (v) waitingSignIns.set(id, v);
        else waitingSignIns.delete(id);
      }
      setSigningState(v);
    },
    [id],
  );
  const showServers = (servers: McpServerInfo[] | undefined) => {
    if (!servers) return;
    version.current++;
    setData((d) => (d ? { ...d, servers } : d));
  };

  const load = useCallback(async () => {
    const n = ++asked.current;
    version.current++;
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
    // A sign-in still waiting from before: it only can finish in the Claude Code that started it.
    const waiting = id ? waitingSignIns.get(id) : undefined;
    if (!waiting || !id) return void load();
    void (async () => {
      const r = await api.chat.mcp(id, projectId, folder, { ...startWith, noStart: true }).catch(() => null);
      if (!r?.live) {
        setSigning(null);
        toast({ text: `${waiting.name}: the sign-in stopped because this chat's Claude Code closed. Try Sign in again.`, icon: "alert", durationMs: 8000 });
      }
      void load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    // Esc in the address box clears it rather than closing the panel.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLInputElement && ref.current?.contains(e.target)) && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  // While a sign-in finishes in the browser, Claude Code reconnects the server by itself:
  // look again every couple of seconds (at the Claude Code that is waiting, never a new one)
  // until it is connected.
  useEffect(() => {
    if (!signing?.callbackExpected || !id) return;
    const t = setInterval(async () => {
      if (Date.now() - signing.since > SIGN_IN_WAIT_MS) {
        setSigning(null);
        toast({ text: `${signing.name}: the sign-in timed out. Try Sign in again.`, icon: "alert" });
        return;
      }
      if (polling.current || busyRef.current) return;
      polling.current = true;
      const n = asked.current;
      const v = version.current;
      const r = await api.chat.mcp(id, projectId, folder, { ...startWith, noStart: true }).catch(() => null);
      polling.current = false;
      if (!r || !r.ok || n !== asked.current || v !== version.current) return;
      if (!r.live) {
        setSigning(null);
        toast({ text: `${signing.name}: the sign-in stopped because this chat's Claude Code closed. Try Sign in again.`, icon: "alert", durationMs: 8000 });
        return;
      }
      setData((d) => (d ? { ...d, servers: r.servers } : d));
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signing, id, projectId, folder, setSigning, toast]);
  const signingServer = signing ? data?.servers.find((x) => x.name === signing.name) : undefined;
  const signingStatus = signingServer?.status;
  const signingError = signingServer?.error ?? null;
  useEffect(() => {
    if (!signing?.callbackExpected || !signingStatus || busy) return;
    if (signingStatus === "failed" && signingError && signingError !== signing.startError) {
      setSigning(null);
      toast({ text: `${signing.name}: ${signingError}`, icon: "alert", durationMs: 8000 });
      return;
    }
    if (signingStatus !== "connected") {
      if (!signing.sawOther) setSigning({ ...signing, sawOther: true });
      return;
    }
    if (signing.sawOther) {
      setSigning(null);
      setPasted("");
      toast({ text: `${signing.name} is connected`, icon: "check" });
    }
  }, [signing, signingStatus, signingError, busy, setSigning, toast]);

  const act = async (s: McpServerInfo, action: "reconnect" | "enable" | "disable" | "signout") => {
    if (!id) return;
    setBusy(`${s.name}:${action}`);
    const n = asked.current;
    const r = await api.chat.mcpAction(id, s.name, action, startWith);
    setBusy(null);
    // Closed or asked again meanwhile: the toast still says what happened, the list is left alone.
    if (n !== asked.current) {
      toast({ text: r.ok ? `${s.name}: done` : `${s.name}: ${r.err ?? "that didn't work"}`, icon: r.ok ? "check" : "alert" });
      return;
    }
    showServers(r.servers);
    const done = r.servers?.find((x) => x.name === s.name);
    if (!r.ok) toast({ text: `${s.name}: ${r.err ?? "that didn't work"}`, icon: "alert" });
    else if (action === "reconnect") toast({ text: done?.status === "connected" ? `${s.name} is connected` : `${s.name}: ${STATUS[done?.status ?? "failed"].label.toLowerCase()}`, icon: done?.status === "connected" ? "check" : "alert" });
    else if (action === "signout") toast({ text: `Signed out of ${s.name}`, icon: "check" });
    else toast({ text: `${s.name} turned ${action === "enable" ? "on" : "off"}`, icon: "check" });
  };

  /**
   * Starts the server's sign-in: its page opens in the browser, and the panel waits here.
   * Signing in again to a web server clears its sign-in first, so the panel can tell when the new one is done.
   */
  const signIn = async (s: McpServerInfo, again = false) => {
    if (!id || busyRef.current) return;
    setBusy(`${s.name}:signin`);
    setPasted("");
    const n = asked.current;
    if (again && canSignOut(s)) {
      const out = await api.chat.mcpAction(id, s.name, "signout", startWith);
      if (!out.ok) {
        setBusy(null);
        return toast({ text: `${s.name}: ${out.err ?? "couldn't sign out first"}`, icon: "alert" });
      }
    }
    const r = await api.chat.mcpAction(id, s.name, "signin", startWith);
    setBusy(null);
    if (n === asked.current) showServers(r.servers);
    if (!r.ok) return toast({ text: `${s.name}: ${r.err ?? "couldn't start the sign-in"}`, icon: "alert" });
    if (!r.url) {
      // Nothing to do in the browser: it was signed in already.
      toast({ text: `${s.name} is signed in`, icon: "check" });
      return void load();
    }
    const now = r.servers?.find((x) => x.name === s.name);
    setSigning({ name: s.name, url: r.url, callbackExpected: !!r.callbackExpected, opened: r.opened !== false, since: Date.now(), sawOther: !!now && now.status !== "connected", startError: now?.error ?? null });
  };

  /** The browser ended on an error page: its address finishes the sign-in. */
  const finishWithAddress = async () => {
    if (!id || !signing || !pasted.trim() || busyRef.current) return;
    setBusy(`${signing.name}:callback`);
    const n = asked.current;
    const r = await api.chat.mcpAction(id, signing.name, "callback", { ...startWith, url: pasted.trim() });
    setBusy(null);
    if (n === asked.current) showServers(r.servers);
    if (!r.ok) toast({ text: r.err ?? "That address didn't finish the sign-in", icon: "alert", durationMs: 8000 });
  };

  /** A claude.ai connector is connected on claude.ai: then it reconnects here. */
  const doneOnClaudeAi = async () => {
    if (!signing) return;
    const s = data?.servers.find((x) => x.name === signing.name);
    setSigning(null);
    if (s) await act(s, "reconnect");
    else await load();
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ text: "Sign-in link copied", icon: "check" });
    } catch {
      toast({ text: "Couldn't copy the link", icon: "alert" });
    }
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
          data.servers.map((s) => {
            const expanded = open === s.name;
            const waiting = signing?.name === s.name;
            return (
              <div className="mcp-item" key={s.name} data-open={expanded || undefined}>
                <div className="mcp-row" data-status={s.status}>
                  <button type="button" className="mcp-expand" aria-expanded={expanded} aria-label={`${s.name} details`} onClick={(e) => {
                      setOpen(expanded ? null : s.name);
                      // Its details open under it: bring them into view.
                      const item = e.currentTarget.closest(".mcp-item");
                      if (!expanded) requestAnimationFrame(() => item?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
                    }}>
                    <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} className="mcp-chevron" />
                    <span className={`status-dot ${STATUS[s.status].dot}`} aria-hidden />
                    <span className="mcp-what">
                      <span className="mcp-name ellipsis">{s.name}</span>
                      <span className="mcp-sub ellipsis" title={s.error ?? undefined}>
                        {[waiting ? "Signing in…" : STATUS[s.status].label, s.status === "connected" && s.toolCount ? `${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}` : null, s.scope, s.error].filter(Boolean).join(SEP)}
                      </span>
                    </span>
                  </button>
                  {data.live && (
                    <span className="mcp-actions">
                      {s.status === "needs-auth" && !waiting && (
                        <button type="button" className="btn btn-primary btn-small" disabled={!!busy} onClick={() => void signIn(s)}>
                          {busy === `${s.name}:signin` ? <Spinner size={12} /> : <Icon name="lock" size={13} />}
                          Sign in
                        </button>
                      )}
                      {s.status !== "disabled" && s.status !== "needs-auth" && (
                        <button type="button" className={`btn btn-small ${s.status === "failed" ? "btn-primary" : "btn-secondary"}`} disabled={!!busy} onClick={() => void act(s, "reconnect")}>
                          {busy === `${s.name}:reconnect` ? <Spinner size={12} /> : null}
                          Reconnect
                        </button>
                      )}
                      <button type="button" className="btn btn-plain btn-small" disabled={!!busy} onClick={() => void act(s, s.status === "disabled" ? "enable" : "disable")}>
                        {busy === `${s.name}:enable` || busy === `${s.name}:disable` ? <Spinner size={12} /> : null}
                        {s.status === "disabled" ? "Turn on" : "Turn off"}
                      </button>
                    </span>
                  )}
                </div>
                {waiting && signing && (
                  <div className="mcp-signin" role="status">
                    {signing.callbackExpected ? (
                      <>
                        <p>
                          <Spinner size={12} /> {signing.opened ? `Finish signing in to ${s.name} in your browser. This updates by itself.` : `This sign-in page isn't secure, so it wasn't opened. Copy the link into your browser if you trust it.`}
                        </p>
                        <p className="mcp-hint">If the browser ends on an error page instead, paste its address here:</p>
                        <div className="mcp-paste">
                          <input
                            type="text"
                            value={pasted}
                            placeholder="http://localhost:…/callback?code=…"
                            spellCheck={false}
                            aria-label="The address the browser ended on"
                            disabled={busy === `${s.name}:callback`}
                            onChange={(e) => setPasted(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void finishWithAddress();
                              if (e.key === "Escape") setPasted("");
                            }}
                          />
                          <button type="button" className="btn btn-secondary btn-small" disabled={!pasted.trim() || !!busy} onClick={() => void finishWithAddress()}>
                            {busy === `${s.name}:callback` ? <Spinner size={12} /> : null}
                            Finish
                          </button>
                        </div>
                      </>
                    ) : (
                      <p>Connect {s.name} on claude.ai in your browser, then press Done.</p>
                    )}
                    <div className="mcp-signin-actions">
                      {!signing.callbackExpected && (
                        <button type="button" className="btn btn-primary btn-small" disabled={!!busy} onClick={() => void doneOnClaudeAi()}>
                          Done
                        </button>
                      )}
                      {signing.opened && (
                        <button type="button" className="link" onClick={() => void api.app.openExternal(signing.url)}>
                          Open the sign-in page again
                        </button>
                      )}
                      <button type="button" className="link" onClick={() => void copyLink(signing.url)}>
                        Copy link
                      </button>
                      <span className="spacer" />
                      <button type="button" className="btn btn-plain btn-small" onClick={() => setSigning(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {expanded && (
                  <div className="mcp-details">
                    <dl>
                      {s.scope && (
                        <>
                          <dt>Set up in</dt>
                          <dd>{WHERE[s.scope] ?? s.scope}</dd>
                        </>
                      )}
                      {s.transport && (
                        <>
                          <dt>Type</dt>
                          <dd>{TRANSPORT[s.transport] ?? s.transport}</dd>
                        </>
                      )}
                      {s.error && (
                        <>
                          <dt>Error</dt>
                          <dd className="mcp-error">{s.error}</dd>
                        </>
                      )}
                    </dl>
                    {data.live && usesSignIn(s) && s.status !== "disabled" && !waiting && (
                      <div className="mcp-detail-actions">
                        {s.status !== "needs-auth" && (
                          <button type="button" className="btn btn-secondary btn-small" disabled={!!busy} onClick={() => void signIn(s, true)}>
                            {busy === `${s.name}:signin` ? <Spinner size={12} /> : <Icon name="lock" size={13} />}
                            Sign in again
                          </button>
                        )}
                        {canSignOut(s) && s.status !== "needs-auth" && (
                          <button type="button" className="btn btn-plain btn-small" disabled={!!busy} onClick={() => void act(s, "signout")}>
                            {busy === `${s.name}:signout` ? <Spinner size={12} /> : null}
                            Sign out
                          </button>
                        )}
                      </div>
                    )}
                    {s.tools.length > 0 ? (
                      <>
                        <div className="mcp-tools-head">Tools</div>
                        <ul className="mcp-tools">
                          {s.tools.map((t) => (
                            <li key={t.name}>
                              <span className="mcp-tool-name">{t.name}</span>
                              {t.description && <span className="mcp-tool-desc">{t.description}</span>}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <div className="mcp-hint">{s.status === "connected" ? "This server has no tools." : "Its tools show here once it is connected."}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {data && !data.live && data.servers.length > 0 && <div className="mcp-foot">{data.note ? `${data.note} This is what it would have.` : "This new chat hasn’t started yet, so this is what it will have. Its servers connect when you send the first message."}</div>}
    </div>
  );
}
