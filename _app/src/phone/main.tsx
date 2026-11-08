// The phone app: the desktop's window (the same React) on a phone, talking to a PC over the
// relay instead of to Electron. window.conversations is made here, before any of the
// window's code loads (it reads it at import), and points at the session once there is one.
import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../renderer/styles/tokens.css";
import "../renderer/styles/base.css";
import "../renderer/styles/layout.css";
import "../renderer/styles/detail.css";
import "../renderer/styles/overlays.css";
import "./phone.css";
import "./phone-app.css";
import "./phone-screens.css";
import "./phone-fixes.css";
import { makeApi } from "../shared/make-api";
import { PhoneSession, type PhoneState, type WorkspaceLink } from "./session";
import { Setup } from "./Setup";
import { closeNewest, control, setSession } from "./state";
import { App as Android } from "@capacitor/app";
import { savedToken, writeRequest } from "./github";
import { PhoneListHeader, SendsTo } from "./ui";
import { slots } from "../renderer/lib/slots";

slots.listHeader = PhoneListHeader;
slots.composerTarget = SendsTo;

let session: PhoneSession | null = null;

// Another workspace (M11): remembered, then the app starts again in it (a fresh window, list and index).
control.switchTo = (w) => {
  localStorage.setItem("conversations.phone.workspace", JSON.stringify(w));
  location.reload();
};

/** Requests the phone answers itself: there's no PC folder, file picker or window here. */
const LOCAL: Record<string, (...args: any[]) => unknown> = {
  "app:openExternal": (url: string) => void (/^https?:\/\//.test(url) ? window.open(url, "_blank") : undefined),
  "app:copyText": (text: string) => navigator.clipboard?.writeText(text),
  "app:openPath": () => "Folders open on the PC",
  "app:pickFolder": () => null,
  "app:pickFiles": () => ({ images: [], paths: [] }),
  "app:updateReady": () => null,
  "app:showSettings": () => undefined,
  "app:showMain": () => undefined,
  "app:toggleFlyout": () => undefined,
  "cli:open": () => ({ ok: false, message: "Open in CLI works on the PC" }),
  "cli:newChat": () => ({ ok: false, message: "Open in CLI works on the PC" }),
  "sync:openLog": () => undefined,
  "sync:signIn": () => ({ ok: false, err: "Sign in to GitHub on the PC" }),
};

window.conversations = makeApi({
  invoke: async (channel, ...args) => {
    const local = LOCAL[channel];
    if (local) return local(...args);
    if (!session) throw new Error("Not connected to a PC yet");
    return session.call(channel, args);
  },
  send: () => {},
  on: (event, cb) => {
    const offs: (() => void)[] = [];
    const attach = () => session && offs.push(session.on(event, cb));
    attach();
    // A listener added before the session existed joins it when it starts.
    if (!session) pendingListeners.push(attach);
    return () => offs.forEach((o) => o());
  },
  windowKind: "main",
  platform: "android",
});
const pendingListeners: (() => void)[] = [];

// Android's back gesture: closes what's open (a sheet, search, settings, a menu), then from a chat
// goes back to the list; only from the list does it leave the app (which stays running).
void Android.addListener("backButton", () => {
  if (closeNewest()) return;
  const menu = document.querySelector(".menu, .phone-sheet-scrim, .search-results");
  if (menu) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    (document.activeElement as HTMLElement | null)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return;
  }
  const back = document.querySelector<HTMLButtonElement>(".detail-toolbar.with-back button");
  if (back) return back.click();
  void Android.minimizeApp();
}).catch(() => {});

// Back in front, or the network came back: reconnect now (Android pauses a hidden app's network).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") session?.nudge();
});
window.addEventListener("online", () => session?.nudge());

document.body.dataset.window = "main";
document.body.dataset.platform = "android";

// The desktop's window, loaded only once the phone is allowed and has a PC to talk to.
const DesktopApp = lazy(async () => {
  const { installOverlayScrollbars } = await import("../renderer/lib/scrollbars");
  void installOverlayScrollbars;
  const m = await import("../renderer/App");
  return { default: m.App };
});

function Root() {
  const [ws, setWs] = useState<WorkspaceLink | null>(null);
  const [state, setState] = useState<PhoneState | null>(null);

  useEffect(() => {
    if (!ws) return;
    const s = new PhoneSession(ws, async (req) => {
      // The account that found this workspace (another one may have been added for YCS).
      const token = (ws as WorkspaceLink & { token?: string }).token ?? savedToken();
      const repo = (ws as WorkspaceLink & { repo?: string }).repo;
      // (A workspace handed over without GitHub, in development: its request is written by whoever handed it over.)
      if (token && repo && !repo.startsWith("sandbox/")) await writeRequest(token, repo, req);
    });
    session = s;
    setSession(s);
    for (const a of pendingListeners.splice(0)) a();
    const off = s.onState(setState);
    void s.start();
    return () => {
      off();
      s.stop();
      if (session === s) {
        session = null;
        setSession(null);
      }
    };
  }, [ws]);

  // Once in, the app stays: a PC going off later shows in the app, not as setup again.
  const [inside, setInside] = useState(false);
  const ready = !!state && state.pairing === "allowed" && !!session?.ready();
  useEffect(() => {
    if (ready) setInside(true);
  }, [ready]);
  if (!ws || !state || (!ready && !inside)) return <Setup workspace={ws} state={state} onWorkspace={setWs} />;
  return (
    <Suspense fallback={<div className="phone-loading" />}>
      <DesktopApp />
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
