// Workspaces in the window: the switcher at the top of the sidebar, and the sheet
// that adds one (or sets up on this PC one another PC already has).

import { useEffect, useRef, useState } from "react";
import type { WorkspaceInfo } from "../../shared/types";
import { Icon } from "../components/Icon";
import { Button, IconButton, Spinner } from "../components/controls";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

/** Switches, after a word when chats are running here (the switch restarts the app, which stops them). */
export async function switchWorkspace(w: WorkspaceInfo, force = false) {
  const s = useStore.getState();
  if (!w.setUp) {
    s.openAddWorkspace(w);
    return;
  }
  const r = await api.workspace.switch(w.id, force);
  if (r.ok) {
    useStore.setState({ switchingTo: w.name });
    return;
  }
  if (r.running) {
    s.toast({ text: `${r.running} chat${r.running === 1 ? " is" : "s are"} running here; switching stops ${r.running === 1 ? "it" : "them"}.`, icon: "alert", actionLabel: "Switch anyway", onAction: () => void switchWorkspace(w, true), durationMs: 10_000 });
  } else s.toast({ text: r.err ?? "Couldn't switch", icon: "alert" });
}

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

export function WorkspaceSwitcher() {
  const ws = useStore((s) => s.workspaces);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const current = ws?.workspaces.find((w) => w.id === ws.current);
  const list = ws?.workspaces ?? [];
  const setUp = list.filter((w) => w.setUp);
  const items = [...list.map((w) => ({ w })), { rename: true as const }, { add: true as const }];
  const run = (i: number) => {
    const it = items[i];
    setOpen(false);
    if ("add" in it) useStore.getState().openAddWorkspace(null);
    else if ("rename" in it) useStore.setState({ renamingWorkspace: true });
    else if (it.w.id !== ws?.current) void switchWorkspace(it.w);
  };
  return (
    <div className="ws-switcher" ref={ref}>
      <button
        type="button"
        className="ws-button no-drag"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch workspace (Ctrl+Shift+1, 2, …)"
        onClick={() => {
          setActive(Math.max(0, list.findIndex((w) => w.id === ws?.current)));
          setOpen(!open);
        }}
      >
        <span className="app-icon ws-badge" aria-hidden>
          {list.length > 1 && current ? initial(current.name) : <Icon name="message-square" size={13} strokeWidth={2} />}
        </span>
        <span className="ws-name ellipsis">{current?.name ?? "Conversations"}</span>
        <Icon name="chevrons-up-down" size={13} className="ws-chev" />
      </button>
      {open && (
        <div
          className="menu ws-menu"
          role="menu"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") setActive((a) => (a + 1) % items.length);
            if (e.key === "ArrowUp") setActive((a) => (a - 1 + items.length) % items.length);
            if (e.key === "Enter") run(active);
          }}
        >
          {list.map((w, i) => (
            <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === ws?.current} className="menu-item ws-item" data-active={active === i} onMouseEnter={() => setActive(i)} onClick={() => run(i)}>
              <span className="app-icon ws-badge small" aria-hidden>
                {initial(w.name)}
              </span>
              <span className="ws-item-text">
                <span className="ellipsis">{w.name}</span>
                {!w.setUp ? <span className="ws-sub">On another PC · set up here</span> : !w.signedIn ? <span className="ws-sub">Not signed in yet</span> : null}
              </span>
              {w.id === ws?.current ? <Icon name="check" /> : w.setUp ? <span className="shortcut">Ctrl+Shift+{setUp.indexOf(w) + 1}</span> : null}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" data-active={active === list.length} onMouseEnter={() => setActive(list.length)} onClick={() => run(list.length)}>
            <Icon name="pencil" />
            Rename {current?.name ?? "this workspace"}…
          </button>
          <button type="button" role="menuitem" className="menu-item" data-active={active === list.length + 1} onMouseEnter={() => setActive(list.length + 1)} onClick={() => run(list.length + 1)}>
            <Icon name="plus" />
            Add workspace…
          </button>
        </div>
      )}
    </div>
  );
}

/** Adds a workspace: its name and repository, then its Claude account, then a switch to it. */
export function AddWorkspaceSheet() {
  const sheet = useStore((s) => s.addWorkspace);
  const close = () => useStore.setState({ addWorkspace: null });
  const prefill = sheet?.prefill ?? null;
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [step, setStep] = useState<"form" | "working" | "signin">("form");
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [waitingSignIn, setWaitingSignIn] = useState(false);

  useEffect(() => {
    if (!sheet) return;
    setName(prefill?.name ?? "");
    setRemote(prefill?.remote ?? "");
    setStep("form");
    setError(null);
    setId(null);
    setSignedIn(false);
    setWaitingSignIn(false);
  }, [sheet, prefill]);

  // While the sheet waits on its sign-in, look every 2 s for the account to appear (not once it is closed).
  useEffect(() => {
    if (!sheet || step !== "signin" || !id || signedIn) return;
    const t = window.setInterval(async () => {
      const r = await api.workspace.list();
      if (r.workspaces.find((w) => w.id === id)?.signedIn) setSignedIn(true);
    }, 2000);
    return () => window.clearInterval(t);
  }, [sheet, step, id, signedIn]);

  if (!sheet) return null;
  const submit = async () => {
    setError(null);
    setStep("working");
    const r = await api.workspace.add({ id: prefill?.id, name, remote: remote.trim() });
    if (!r.ok || !r.id) {
      setError(r.err ?? "It couldn't be set up");
      setStep("form");
      return;
    }
    setId(r.id);
    void useStore.getState().loadWorkspaces();
    const w = (await api.workspace.list()).workspaces.find((x) => x.id === r.id);
    setSignedIn(!!w?.signedIn);
    setStep("signin");
  };
  const signIn = async () => {
    if (!id) return;
    const r = await api.workspace.signIn(id);
    if (!r.ok) setError(r.err ?? "Couldn't open the sign-in");
    else setWaitingSignIn(true);
  };
  const switchNow = async () => {
    const list = await api.workspace.list();
    const w = list.workspaces.find((x) => x.id === id);
    close();
    if (w) void switchWorkspace(w);
  };
  return (
    <div className="scrim">
      <div className="sheet ws-sheet" role="dialog" aria-modal="true" aria-labelledby="ws-title">
        {step !== "working" && <IconButton icon="x" label="Close" className="close" onClick={close} />}
        <div className="welcome-icon" aria-hidden>
          <Icon name="layers" size={30} />
        </div>
        {step !== "signin" ? (
          <>
            <h1 id="ws-title">{prefill ? `Set up ${prefill.name} on this PC` : "Add a workspace"}</h1>
            <p className="lede">{prefill ? "Its conversations come down from its repository, and you sign in to its Claude account." : "A workspace is one Claude account with its own conversations, synced through its own private GitHub repository."}</p>
            <div className="ws-form">
              <label>
                <span>Name</span>
                <input type="text" value={name} placeholder="Work" maxLength={40} disabled={!!prefill || step === "working"} onChange={(e) => setName(e.target.value)} autoFocus={!prefill} />
              </label>
              <label>
                <span>Repository</span>
                <input type="text" value={remote} placeholder="https://github.com/you/work-conversations" disabled={!!prefill || step === "working"} onChange={(e) => setRemote(e.target.value)} spellCheck={false} />
              </label>
              <p className="ws-hint">An empty private repository is fine: this sets it up. Your other workspaces don't change.</p>
            </div>
            {error && <p className="ws-error" role="alert">{error}</p>}
            <div className="row-actions">
              <Button kind="primary" disabled={step === "working" || !name.trim() || !remote.trim()} onClick={() => void submit()}>
                {step === "working" ? (
                  <>
                    <Spinner size={14} /> Setting up…
                  </>
                ) : (
                  "Set up"
                )}
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 id="ws-title">{signedIn ? `${name} is ready` : `Sign in to ${name}'s Claude account`}</h1>
            <p className="lede">
              {signedIn
                ? "Its Claude account is signed in on this PC. Switching restarts the app in it; switch back the same way."
                : "A terminal opens with Claude Code. Choose your login method and sign in with the account for this workspace; you can close the terminal afterwards."}
            </p>
            {error && <p className="ws-error" role="alert">{error}</p>}
            <div className="row-actions">
              {signedIn ? (
                <Button kind="primary" onClick={() => void switchNow()}>
                  Switch to {name}
                </Button>
              ) : (
                <>
                  <Button kind="primary" icon="square-terminal" onClick={() => void signIn()}>
                    {waitingSignIn ? "Open the sign-in again" : "Sign in"}
                  </Button>
                  <Button kind="plain" onClick={close}>
                    Later
                  </Button>
                </>
              )}
            </div>
            {waitingSignIn && !signedIn && (
              <p className="foot">
                <Spinner size={12} /> Waiting for the sign-in…
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Renames the workspace this window is in. */
export function RenameWorkspaceSheet() {
  const open = useStore((s) => s.renamingWorkspace);
  const ws = useStore((s) => s.workspaces);
  const current = ws?.workspaces.find((w) => w.id === ws.current);
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName(current?.name ?? "");
  }, [open, current?.name]);
  if (!open || !current) return null;
  const close = () => useStore.setState({ renamingWorkspace: false });
  const save = async () => {
    if (!name.trim()) return;
    await api.workspace.rename(current.id, name.trim());
    await useStore.getState().loadWorkspaces();
    close();
  };
  return (
    <div className="scrim">
      <div className="sheet ws-sheet ws-rename" role="dialog" aria-modal="true" aria-labelledby="ws-rename-title">
        <IconButton icon="x" label="Close" className="close" onClick={close} />
        <h1 id="ws-rename-title">Rename workspace</h1>
        <div className="ws-form">
          <label>
            <span>Name</span>
            <input
              type="text"
              value={name}
              maxLength={40}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") close();
              }}
            />
          </label>
        </div>
        <div className="row-actions">
          <Button kind="primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/** While the app restarts into another workspace. */
export function SwitchingOverlay() {
  const to = useStore((s) => s.switchingTo);
  if (!to) return null;
  return (
    <div className="scrim ws-switching" role="status">
      <div className="ws-switching-card">
        <Spinner size={18} /> Switching to {to}…
      </div>
    </div>
  );
}
