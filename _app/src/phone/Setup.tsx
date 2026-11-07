// Setting the phone up (Figma: Mobile (for review) › M1, M2): sign in with GitHub, find the
// workspaces, and wait on the code until a PC says Allow.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../renderer/components/Icon";
import { findWorkspaces, savedToken, signOut, startDeviceFlow, waitForToken, whoAmI, type DeviceCode } from "./github";
import type { PhoneState, WorkspaceLink } from "./session";

type Found = WorkspaceLink & { repo: string };

const LINK_KEY = "conversations.phone.workspace";

const GITHUB_MARK = (
  <svg className="gh-mark" width="20" height="20" viewBox="0 0 24 24" aria-hidden>
    <path
      fill="currentColor"
      d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
    />
  </svg>
);

/** A workspace handed over in the address (development, or a link from a PC): #link=<base64 JSON>. */
function linkFromAddress(): Found | null {
  const m = /[#&]link=([^&]+)/.exec(location.hash);
  if (!m) return null;
  try {
    const w = JSON.parse(atob(decodeURIComponent(m[1]))) as Found;
    if (w.url && w.room && Array.isArray(w.pcs)) {
      localStorage.setItem(LINK_KEY, JSON.stringify(w));
      history.replaceState(null, "", location.pathname);
      return w;
    }
  } catch {}
  return null;
}

function savedLink(): Found | null {
  try {
    return JSON.parse(localStorage.getItem(LINK_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function Setup({ workspace, state, onWorkspace }: { workspace: WorkspaceLink | null; state: PhoneState | null; onWorkspace: (w: WorkspaceLink) => void }) {
  const [token, setToken] = useState<string | null>(() => savedToken());
  const [login, setLogin] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const cancelled = useRef(false);

  // A workspace from the address or from last time: straight to it.
  useEffect(() => {
    const w = linkFromAddress() ?? savedLink();
    if (w && !workspace) {
      setFound([w]);
      onWorkspace(w);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!token) return;
    let gone = false;
    (async () => {
      try {
        setLogin(await whoAmI(token));
        const ws = await findWorkspaces(token);
        if (gone) return;
        setFound(ws);
        // Refreshed from GitHub every start: a new PC's key, or a moved relay.
        const keep = savedLink();
        const pick = ws.find((w) => w.repo === keep?.repo) ?? ws[0];
        if (pick) {
          localStorage.setItem(LINK_KEY, JSON.stringify(pick));
          onWorkspace(pick);
        }
      } catch (e) {
        if ((e as Error).message === "signed-out") {
          signOut();
          setToken(null);
        } else setErr((e as Error).message);
      }
    })();
    return () => {
      gone = true;
    };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = async () => {
    setErr(null);
    cancelled.current = false;
    try {
      const c = await startDeviceFlow();
      setCode(c);
      setToken(await waitForToken(c, () => cancelled.current));
      setCode(null);
    } catch (e) {
      setCode(null);
      if ((e as Error).message !== "cancelled") setErr((e as Error).message);
    }
  };

  // M1: signing in.
  if (!token && !workspace) {
    return (
      <div className="phone-setup sign-in">
        <div className="hero">
          <div className="app-tile">
            <Icon name="message-square" size={34} />
          </div>
          <h1>Conversations</h1>
          <p>Your Claude Code chats from every PC, on your phone.</p>
        </div>
        {code ? (
          <div className="actions">
            <p className="step">Enter this code on GitHub</p>
            <button className="device-code" onClick={() => void navigator.clipboard?.writeText(code.user_code)} aria-label="Copy the code">
              {code.user_code}
            </button>
            <button className="big-button dark" onClick={() => window.open(code.verification_uri, "_blank")}>
              {GITHUB_MARK}
              Open GitHub
            </button>
            <button className="text-button" onClick={() => ((cancelled.current = true), setCode(null))}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="actions">
            <button className="big-button dark" onClick={() => void signIn()}>
              {GITHUB_MARK}
              Continue with GitHub
            </button>
            {err ? <p className="foot error">{err}</p> : <p className="foot">Use the account your chats sync through. Nothing else to set up.</p>}
          </div>
        )}
      </div>
    );
  }

  // M2: workspaces found, waiting for a PC to allow this phone.
  const asking = state?.pcs.find((p) => p.online);
  return (
    <div className="phone-setup allow">
      {login && (
        <div className="signed-in">
          {GITHUB_MARK}
          <span>Signed in as {login}</span>
        </div>
      )}
      <section>
        <h2>{found === null ? "Looking for your workspaces…" : found.length === 1 ? "Found 1 workspace" : `Found ${found.length} workspaces`}</h2>
        {found?.length ? (
          <div className="card">
            {found.map((w) => (
              <button key={w.room} className={`ws-row${workspace?.room === w.room ? " current" : ""}`} onClick={() => onWorkspace(w)}>
                <span className="tile">{w.name.slice(0, 1).toUpperCase()}</span>
                <span className="text">
                  <span className="name">{w.name}</span>
                  <span className="detail">
                    {w.repo ?? ""}
                    {w.repo ? " · " : ""}
                    {w.pcs.length} {w.pcs.length === 1 ? "PC" : "PCs"}
                  </span>
                </span>
                {workspace?.room === w.room && <span className="ready">{state?.pairing === "allowed" ? "Ready" : ""}</span>}
              </button>
            ))}
          </div>
        ) : found ? (
          <p className="body">None of your chat repositories has the phone link yet. Update Conversations on a PC and leave it open for a minute.</p>
        ) : null}
        {err && <p className="body error">{err}</p>}
      </section>
      {workspace && state && (
        <section>
          <h2>Allow this phone on a PC</h2>
          {state.pairing === "denied" ? (
            <p className="body error">The PC said no. Ask again from a PC that's on, or check the code.</p>
          ) : state.error ? (
            <p className="body error">{state.error}</p>
          ) : (
            <p className="body">On a PC that's on, Conversations is asking “Allow this phone?”. Check the code matches, then choose Allow.</p>
          )}
          <div className="code" aria-label={`Code ${state.code}`}>
            {state.code.split("").map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div className="card">
            {state.pcs.map((p) => (
              <div key={p.device} className="pc-row">
                <Icon name={/laptop/i.test(p.name) ? "laptop" : "monitor"} size={20} />
                <span className="name">{p.name}</span>
                <span className={`status${p.online ? " on" : ""}`}>
                  {p.online && p === asking ? <Icon name="loader-circle" size={16} className="spin" /> : <span className="dot" />}
                  {p.online ? (state.pairing === "allowed" ? "On" : "Asking now") : "Off"}
                </span>
              </div>
            ))}
            {state.pcs.length === 0 && <div className="pc-row muted">No PC has joined the phone link yet.</div>}
          </div>
          {state.link !== "open" && <p className="foot">{state.link === "connecting" ? "Connecting to the relay…" : "Not connected"}</p>}
        </section>
      )}
    </div>
  );
}
