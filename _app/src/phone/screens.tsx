// The phone's own screens (Figma: Mobile (for review)): search, the workspace switcher (M11)
// and settings (M12). The chat list's header opens them.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../renderer/components/Icon";
import { useStore } from "../renderer/lib/store";
import { allTokens, findAllWorkspaces, savedWorkspaces, startDeviceFlow, waitForToken, whoAmI, type DeviceCode, type FoundWorkspace } from "./github";
import { control, usePhone } from "./state";
import { GITHUB_MARK } from "./Setup";

const pcIcon = (name: string) => (/laptop|macbook/i.test(name) ? "laptop" : "monitor");

function Sheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="phone-sheet-scrim" onClick={onClose}>
      <div className="phone-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="handle" />
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
        {children}
      </div>
    </div>
  );
}

/** A device-flow sign-in inside a sheet: the code, then GitHub. Resolves with the new token. */
function useDeviceSignIn() {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cancelled = useRef(false);
  const start = async (): Promise<string | null> => {
    setErr(null);
    cancelled.current = false;
    try {
      const c = await startDeviceFlow();
      setCode(c);
      const t = await waitForToken(c, () => cancelled.current);
      setCode(null);
      return t;
    } catch (e) {
      setCode(null);
      if ((e as Error).message !== "cancelled") setErr((e as Error).message);
      return null;
    }
  };
  const cancel = () => {
    cancelled.current = true;
    setCode(null);
  };
  return { code, err, start, cancel };
}

/** M11: the workspaces this phone found on GitHub, and signing in with another account. */
export function WorkspaceSheet({ onClose }: { onClose: () => void }) {
  const { session, state } = usePhone();
  const [found, setFound] = useState<FoundWorkspace[]>(() => savedWorkspaces());
  const [busy, setBusy] = useState(false);
  const signIn = useDeviceSignIn();
  useEffect(() => {
    void findAllWorkspaces().then(setFound, () => {});
  }, []);
  const on = state?.pcs.filter((p) => p.online).length ?? 0;
  // The workspace this phone is in always shows (also before GitHub has answered).
  const here = session?.ws as FoundWorkspace | undefined;
  const list = here && !found.some((w) => w.room === here.room) ? [here, ...found] : found;
  return (
    <Sheet title="Workspaces" onClose={onClose}>
      {list.map((w) => {
        const current = w.room === session?.ws.room;
        return (
          <button
            key={w.room}
            className={`sheet-row${current ? " selected" : ""}`}
            onClick={() => {
              if (!current) control.switchTo(w);
              onClose();
            }}
          >
            <span className={`ws-tile${current ? " current" : ""}`}>{w.name.slice(0, 1).toUpperCase()}</span>
            <span className="text">
              <span className="name">{w.name}</span>
              <span className="row-sub">
                {w.login || (w.repo ?? "").split("/")[0] || "GitHub"} · {w.pcs.length} {w.pcs.length === 1 ? "PC" : "PCs"}
                {current ? ` · ${on} on` : ""}
              </span>
            </span>
            {current && <Icon name="check" size={20} />}
          </button>
        );
      })}
      <div className="sheet-divider" />
      {signIn.code ? (
        <div className="sheet-signin">
          <p>Enter this code on GitHub, signed in as the other account</p>
          <button className="device-code" onClick={() => void navigator.clipboard?.writeText(signIn.code!.user_code)} aria-label="Copy the code">
            {signIn.code.user_code}
          </button>
          <div className="row">
            <button className="text-button" onClick={signIn.cancel}>
              Cancel
            </button>
            <button className="big-button" onClick={() => window.open(signIn.code!.verification_uri, "_blank")}>
              Open GitHub
            </button>
          </div>
        </div>
      ) : (
        <button
          className="sheet-row"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const before = allTokens().length;
            const t = await signIn.start();
            if (t && allTokens().length > before) setFound(await findAllWorkspaces().catch(() => found));
            setBusy(false);
          }}
        >
          <span className="ws-tile add">
            <Icon name="plus" size={20} />
          </span>
          <span className="text">
            <span className="name">{busy ? "Looking…" : "Sign in with another GitHub account"}</span>
          </span>
        </button>
      )}
      {signIn.err && <p className="sheet-error">{signIn.err}</p>}
    </Sheet>
  );
}

/** Search: the desktop's search (the PC searches its index), as a screen of its own. */
export function PhoneSearch({ onClose }: { onClose: () => void }) {
  const search = useStore((s) => s.search);
  const setText = useStore((s) => s.setSearchText);
  const select = useStore((s) => s.select);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    return () => useStore.getState().setSearchOpen(false);
  }, []);
  const hits = search.result?.hits ?? [];
  const mark = (s: string) =>
    s.split(/(\u0001[^\u0002]*\u0002)/).map((part, i) => (part.startsWith("\u0001") ? <mark key={i}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>));
  return (
    <div className="phone-screen phone-search" role="dialog" aria-label="Search">
      <div className="phone-screen-bar">
        <button className="icon-48" onClick={onClose} aria-label="Back">
          <Icon name="arrow-left" size={22} />
        </button>
        <input ref={input} type="search" placeholder="Search every chat" value={search.text} onChange={(e) => {
            setText(e.target.value);
            // The phone shows its own results (the desktop's floating list stays shut).
            useStore.getState().setSearchOpen(false);
          }} enterKeyHint="search" />
      </div>
      <div className="phone-screen-body">
        {search.text.trim() && search.result && !hits.length && <p className="phone-empty">No chats match “{search.text.trim()}”.</p>}
        {hits.map((h) => (
          <button
            key={`${h.id}-${h.field}`}
            className="search-hit"
            onClick={() => {
              void select(h.id);
              onClose();
              window.dispatchEvent(new Event("app:show-chat"));
            }}
          >
            <span className="title">{mark(h.title)}</span>
            {h.snippet && <span className="snippet">{mark(h.snippet)}</span>}
            <span className="meta">
              {h.lastPc ?? ""}
              {h.lastPc ? " · " : ""}
              {h.projectLabel}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const NOTIFY = [
  ["finished", "A chat finishes"],
  ["question", "Claude asks a question"],
  ["approval", "A command needs approval"],
] as const;

function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`phone-toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

/** M12: what to be told about, each PC's keep-awake switch, and this phone. */
export function PhoneSettings({ onClose }: { onClose: () => void }) {
  const { session, state } = usePhone();
  const [notify, setNotify] = useState<Record<string, boolean>>(() => {
    try {
      return { finished: true, question: true, approval: true, ...JSON.parse(localStorage.getItem("conversations.phone.notify") ?? "{}") };
    } catch {
      return { finished: true, question: true, approval: true };
    }
  });
  const [awake, setAwake] = useState<Record<string, { keepAwake: boolean; onBattery: boolean } | "error">>({});
  const [login, setLogin] = useState("");
  const [removing, setRemoving] = useState(false);
  const pcs = state?.pcs ?? [];

  useEffect(() => {
    const t = (session?.ws as { token?: string } | undefined)?.token ?? allTokens()[0];
    if (t) void whoAmI(t).then(setLogin, () => {});
  }, [session]);
  useEffect(() => {
    if (!session) return;
    for (const p of pcs) {
      if (!p.online || !p.allowed || awake[p.device]) continue;
      void session.pcCall(p.device, "status").then(
        (v) => setAwake((a) => ({ ...a, [p.device]: v as { keepAwake: boolean; onBattery: boolean } })),
        () => setAwake((a) => ({ ...a, [p.device]: "error" })),
      );
    }
  }, [session, pcs.map((p) => `${p.device}${p.online}${p.allowed}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const setN = (k: string, v: boolean) => {
    const next = { ...notify, [k]: v };
    setNotify(next);
    localStorage.setItem("conversations.phone.notify", JSON.stringify(next));
  };

  return (
    <div className="phone-screen phone-settings" role="dialog" aria-label="Settings">
      <div className="phone-screen-bar">
        <button className="icon-48" onClick={onClose} aria-label="Back">
          <Icon name="arrow-left" size={22} />
        </button>
        <h1>Settings</h1>
      </div>
      <div className="phone-screen-body">
        <div className="settings-group">
          <div className="label">Notify me when</div>
          <div className="card">
            {NOTIFY.map(([k, label]) => (
              <div key={k} className="settings-row">
                <span className="text">
                  <span className="name">{label}</span>
                </span>
                <Toggle label={label} on={notify[k]} onChange={(v) => setN(k, v)} />
              </div>
            ))}
          </div>
        </div>
        <div className="settings-group">
          <div className="label">Keep awake for my phone</div>
          <div className="card">
            {pcs.map((p) => {
              const st = awake[p.device];
              const known = st && st !== "error" ? st : null;
              const detail = !p.online ? "Off · switch it on from that PC" : !p.allowed ? "On · hasn't let this phone in yet" : st === "error" ? "On · didn't answer" : known ? (known.keepAwake ? (known.onBattery ? "On · on battery, so it may sleep" : "On · stays awake while plugged in") : "On · sleeps as usual") : "On";
              return (
                <div key={p.device} className={`settings-row${p.online ? "" : " off"}`}>
                  <Icon name={pcIcon(p.name)} size={20} />
                  <span className="text">
                    <span className="name">{p.name}</span>
                    <span className="row-sub">
                      <span className={`dot${p.online ? " on" : ""}`} />
                      {detail}
                    </span>
                  </span>
                  <Toggle
                    label={`Keep ${p.name} awake`}
                    on={!!known?.keepAwake}
                    disabled={!known}
                    onChange={(v) => {
                      setAwake((a) => ({ ...a, [p.device]: { ...(known ?? { onBattery: false }), keepAwake: v } }));
                      void session?.pcCall(p.device, "keep-awake", { on: v }).then(
                        (r) => setAwake((a) => ({ ...a, [p.device]: { ...(known ?? { onBattery: false }), ...(r as { keepAwake: boolean }) } })),
                        () => setAwake((a) => ({ ...a, [p.device]: "error" })),
                      );
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div className="settings-group">
          <div className="label">This phone</div>
          <div className="card">
            <button className="settings-row" onClick={() => window.open("https://github.com/settings/applications", "_blank")}>
              {GITHUB_MARK}
              <span className="text">
                <span className="name">Signed in as {login || "…"}</span>
                <span className="row-sub">GitHub · {session?.ws.name ?? ""}</span>
              </span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button
              className="settings-row danger"
              disabled={removing}
              onClick={async () => {
                if (!confirm("Remove this phone? It's taken off your PCs that are on, and signed out here. To cut its GitHub access too, revoke Conversations on GitHub (the row above).")) return;
                setRemoving(true);
                await session?.forgetMe();
                control.restart();
              }}
            >
              <Icon name="smartphone" size={20} />
              <span className="text">
                <span className="name">{removing ? "Removing…" : "Remove this phone"}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
