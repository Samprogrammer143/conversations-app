// The phone's session, for the phone's own pieces inside the window (the PC strip, the
// "Sends to" chip, the switcher and settings): one at a time, set by main.tsx.
import { useEffect, useSyncExternalStore } from "react";
import type { PhoneSession, PhoneState, WorkspaceLink } from "./session";

let current: PhoneSession | null = null;
const listeners = new Set<() => void>();
let off: (() => void) | null = null;

export function setSession(s: PhoneSession | null) {
  off?.();
  current = s;
  off = s ? s.onState(() => listeners.forEach((l) => l())) : null;
  listeners.forEach((l) => l());
}

export function session(): PhoneSession | null {
  return current;
}

export function usePhone(): { session: PhoneSession | null; state: PhoneState | null } {
  const state = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current?.state ?? null,
  );
  return { session: current, state };
}

/** What Android's back gesture closes, newest first (sheets and screens register while open). */
const backStack: (() => void)[] = [];
export function useBack(close: () => void) {
  useEffect(() => {
    backStack.push(close);
    return () => {
      const i = backStack.lastIndexOf(close);
      if (i >= 0) backStack.splice(i, 1);
    };
  }, [close]);
}
/** Closes the newest sheet or screen; false when none is open. */
export function closeNewest(): boolean {
  const close = backStack.pop();
  if (!close) return false;
  close();
  return true;
}

/** Copies text: the clipboard API, else the old way (some WebViews refuse the API). True when it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.cssText = "position:fixed;top:-100px;opacity:0";
  document.body.appendChild(t);
  t.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  t.remove();
  return ok;
}

/** The workspace's name as the PC has it (renamed there or here), remembered for when no PC is on. */
const nameListeners = new Set<() => void>();
export function workspaceName(room: string): string | null {
  return localStorage.getItem(`conversations.phone.wsname.${room}`);
}
export function setWorkspaceName(room: string, name: string) {
  localStorage.setItem(`conversations.phone.wsname.${room}`, name);
  nameListeners.forEach((l) => l());
}
export function useWorkspaceName(room: string | undefined): string | null {
  return useSyncExternalStore(
    (cb) => {
      nameListeners.add(cb);
      return () => nameListeners.delete(cb);
    },
    () => (room ? workspaceName(room) : null),
  );
}

/** Switching workspace (M11) and starting over after "Remove this phone" (M12): set by main.tsx. */
export const control: { switchTo(w: WorkspaceLink): void; restart(): void } = {
  switchTo: () => {},
  restart: () => location.reload(),
};
