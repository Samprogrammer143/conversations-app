// The phone's session, for the phone's own pieces inside the window (the PC strip, the
// "Sends to" chip): one at a time, set by main.tsx.
import { useSyncExternalStore } from "react";
import type { PhoneSession, PhoneState } from "./session";

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
