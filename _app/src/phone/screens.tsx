// The phone's own screens (Figma: Mobile (for review)): search, the workspace switcher (M11)
// and settings (M12). The chat list's header opens them.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../renderer/components/Icon";
import { useStore } from "../renderer/lib/store";
import { ORG_ACCESS_URL, connection, allTokens, findAllWorkspaces, findWorkspaces, savedWorkspaces, signOut, startDeviceFlow, userOrgs, waitForToken, whoAmI, type DeviceCode, type FoundWorkspace } from "./github";
import { control, copyText, setWorkspaceName, useBack, usePhone, useWorkspaceName } from "./state";
import { CodeToCopy } from "./code";
import { useCallback } from "react";
import { GITHUB_MARK } from "./Setup";

const pcIcon = (name: string) => (/laptop|macbook/i.test(name) ? "laptop" : "monitor");

function Sheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  useBack(useCallback(onClose, [onClose]));
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

/** M11: the workspaces this phone found on GitHub, and signing in with another account. */
export function WorkspaceSheet({ onClose }: { onClose: () => void }) {
  const { session, state } = usePhone();
  const [found, setFound] = useState<FoundWorkspace[]>(() => savedWorkspaces());
  /** M11a–d: adding another GitHub account, in a sheet of its own. */
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void findAllWorkspaces().then(setFound, () => {});
  }, []);
  const on = state?.pcs.filter((p) => p.online).length ?? 0;
  const hereName = useWorkspaceName(session?.ws.room);
  const rename = async () => {
    if (!session) return;
    const was = hereName ?? session.ws.name;
    const next = window.prompt("Name this workspace", was)?.trim().slice(0, 40);
    if (!next || next === was) return;
    setWorkspaceName(session.ws.room, next);
    try {
      const r = (await session.call("workspace:list", [])) as { current: string };
      await session.call("workspace:rename", [r.current, next]);
    } catch {
      // Kept on the phone; the PC gets it next time (or keeps its own name).
    }
  };
  if (adding)
    return (
      <AddAccountSheet
        onClose={() => setAdding(false)}
        onAdded={(text) => {
          setFound(savedWorkspaces());
          setNote(text);
          setAdding(false);
        }}
      />
    );
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
              <span className="name">{current ? (hereName ?? w.name) : w.name}</span>
              <span className="row-sub">
                {w.login || (w.repo ?? "").split("/")[0] || "GitHub"} · {w.pcs.length} {w.pcs.length === 1 ? "PC" : "PCs"}
                {current ? ` · ${on} on` : ""}
              </span>
            </span>
            {current && (
              <span
                role="button"
                tabIndex={0}
                className="icon-48 rename"
                aria-label="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  void rename();
                }}
              >
                <Icon name="pencil" size={18} />
              </span>
            )}
            {current && <Icon name="check" size={20} />}
          </button>
        );
      })}
      {note && (
        <div className="sheet-added">
          <Icon name="check" size={16} />
          <span>{note}</span>
        </div>
      )}
      <button className="sheet-row" onClick={() => setAdding(true)}>
        <span className="ws-tile add">
          <Icon name="plus" size={20} />
        </span>
        <span className="text">
          <span className="name">Add another GitHub account</span>
        </span>
      </button>
    </Sheet>
  );
}

type AddPhase = "code" | "looking" | "same" | "none" | "error";

/**
 * M11a–d: adding another GitHub account (a workspace under another one, like YCS). The code to
 * paste on GitHub (hold to copy; copied as GitHub opens), then who signed in and what was found:
 * workspaces (back to the switcher, which lists them), the same account again, or nothing (most
 * likely an organisation that hasn't allowed the app yet: its page on GitHub, and "look again").
 */
function AddAccountSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (note: string) => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [phase, setPhase] = useState<AddPhase>("code");
  const [login, setLogin] = useState("");
  const [orgs, setOrgs] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [round, setRound] = useState(0);
  const token = useRef<string | null>(null);
  // "Waiting for the connection…" while GitHub can't be reached yet.
  const [waiting, setWaitingState] = useState(connection.waiting);
  useEffect(() => {
    connection.listeners.add(setWaitingState);
    return () => void connection.listeners.delete(setWaitingState);
  }, []);
  // A failed try is tried again by itself when the network comes back.
  useEffect(() => {
    if (phase !== "error") return;
    const again = () => setRound((r) => r + 1);
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [phase]);

  // Held in a ref: the switcher behind redraws (a reconnect, a PC coming on) with a new onAdded,
  // and the sign-in below must not start over for that (it would throw away the code just approved).
  const added = useRef(onAdded);
  added.current = onAdded;
  const look = useCallback(async (t: string, who: string) => {
    setPhase("looking");
    const mine = await findWorkspaces(t).catch(() => []);
    if (mine.length) {
      await findAllWorkspaces().catch(() => []);
      added.current(`Added ${mine.map((w) => w.name).join(", ")} from ${who}.`);
      return;
    }
    setOrgs(await userOrgs(t).catch(() => []));
    setPhase("none");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase("code");
    setCode(null);
    setErr("");
    (async () => {
      try {
        const known = await Promise.all(allTokens().map((t) => whoAmI(t).catch(() => "")));
        const c = await startDeviceFlow();
        if (cancelled) return;
        setCode(c);
        const t = await waitForToken(c, () => cancelled);
        const who = await whoAmI(t).catch(() => "");
        if (cancelled) return;
        setLogin(who);
        token.current = t;
        // An account signed in before (an earlier try, or the first one): looked through all the same,
        // and only "already here" when it has nothing that isn't listed yet.
        if (who && known.includes(who)) {
          const listed = new Set(savedWorkspaces().map((w) => w.room));
          const mine = await findWorkspaces(t).catch(() => []);
          if (cancelled) return;
          if (mine.length && mine.every((w) => listed.has(w.room))) {
            setPhase("same");
            return;
          }
        }
        await look(t, who);
      } catch (e) {
        if (!cancelled && (e as Error).message !== "cancelled") {
          setErr((e as Error).message);
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [round, look]);

  const signedIn = phase !== "code" && phase !== "error";
  const steps = (
    <>
      <div className="add-step">
        <span className={`num${signedIn ? " done" : ""}`}>{signedIn ? <Icon name="check" size={16} /> : "1"}</span>
        <span>{signedIn ? `Signed in as ${login || "the other account"}` : "Open GitHub and sign in as the other account"}</span>
      </div>
      {phase === "code" && (
        <div className="add-step">
          <span className="num">2</span>
          <span>Paste this code</span>
        </div>
      )}
    </>
  );

  return (
    <Sheet title="Add a GitHub account" sub={phase === "code" || phase === "looking" ? "For a workspace under another account, like YCS." : undefined} onClose={onClose}>
      {phase !== "error" && steps}
      {phase === "code" && (
        <>
          <div className="add-code">{code ? <CodeToCopy code={code.user_code} /> : <span className="device-code waiting">····-····</span>}</div>
          {waiting && !code && (
            <div className="add-status">
              <Icon name="loader-circle" size={18} className="spin" />
              <span>Waiting for the connection…</span>
            </div>
          )}
          <div className="sheet-actions">
            <button
              className="big-button"
              disabled={!code}
              onClick={async () => {
                await copyText(code!.user_code);
                window.open(code!.verification_uri, "_blank");
              }}
            >
              Open GitHub
            </button>
            <button className="text-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {phase === "looking" && (
        <>
          <div className="add-status">
            <Icon name="loader-circle" size={18} className="spin" />
            <span>{waiting ? "Waiting for the connection…" : "Looking for its workspaces…"}</span>
          </div>
          <div className="sheet-actions">
            <button className="big-button quiet" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {phase === "same" && (
        <>
          <div className="add-card">
            <div className="title">
              <Icon name="triangle-alert" size={18} />
              <span>{login}'s workspaces are already here</span>
            </div>
            <p>To add a different account, sign out of GitHub in your browser first, then try again.</p>
          </div>
          <div className="sheet-actions">
            <button className="big-button" onClick={() => setRound((r) => r + 1)}>
              Try again
            </button>
            <button className="text-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {phase === "none" && (
        <>
          <div className="add-card">
            <div className="title">
              <Icon name="triangle-alert" size={18} />
              <span>{orgs.length ? `${orgs.join(", ")} ${orgs.length === 1 ? "hasn't" : "haven't"} allowed Conversations yet` : `Nothing found on ${login || "that account"} yet`}</span>
            </div>
            <p>
              {orgs.length
                ? "GitHub hides an organisation's repositories from an app until the organisation allows it. Its owner can do it in a minute on GitHub."
                : "If the workspace belongs to an organisation (YCS is under yacht-cloud), GitHub hides it, and the organisation itself, until the organisation allows Conversations. On GitHub, press Grant (or Request) next to the organisation."}
            </p>
          </div>
          <div className="sheet-actions">
            <button className="big-button" onClick={() => window.open(ORG_ACCESS_URL, "_blank")}>
              Allow it on GitHub
            </button>
            <button className="text-button" onClick={() => token.current && void look(token.current, login)}>
              I've allowed it: look again
            </button>
          </div>
        </>
      )}
      {phase === "error" && (
        <>
          <div className="add-card">
            <div className="title">
              <Icon name="triangle-alert" size={18} />
              <span>That didn't work</span>
            </div>
            <p>{err}</p>
          </div>
          <div className="sheet-actions">
            <button className="big-button" onClick={() => setRound((r) => r + 1)}>
              Try again
            </button>
            <button className="text-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** A new chat's project (the PC's projects, from the window's sidebar data): the chat runs in its folder on the PC. */
export function ProjectSheet({ onClose }: { onClose: () => void }) {
  const sidebar = useStore((s) => s.sidebar);
  const draft = useStore((s) => s.draft);
  const projects = (sidebar?.projects ?? []).filter((p) => p.kind !== "folder" || p.folder);
  return (
    <Sheet title="Start in" sub="The project this chat runs in, on your PC." onClose={onClose}>
      <div className="sheet-list">
        {projects.map((p) => (
          <button
            key={p.id}
            className={`sheet-row${draft?.projectId === p.id ? " selected" : ""}`}
            onClick={() => {
              useStore.getState().startDraft(p.id);
              onClose();
            }}
          >
            <Icon name={p.kind === "home" ? "house" : p.kind === "repo" ? "folder-git-2" : "folder"} size={22} />
            <span className="text">
              <span className="name">{p.label}</span>
              <span className="row-sub">
                {p.count} {p.count === 1 ? "chat" : "chats"}
              </span>
            </span>
            {draft?.projectId === p.id && <Icon name="check" size={20} />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** Search: the desktop's search (the PC searches its index), as a screen of its own. */
export function PhoneSearch({ onClose }: { onClose: () => void }) {
  useBack(useCallback(onClose, [onClose]));
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
  useBack(useCallback(onClose, [onClose]));
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
