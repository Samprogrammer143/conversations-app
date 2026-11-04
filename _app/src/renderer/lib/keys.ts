// Shortcuts: Ctrl on Windows, Cmd on a Mac. Labels are written the Windows way ("Ctrl+Shift+O")
// and shown as each system writes them ("⇧⌘O" on a Mac). The platform is read at call time.

import { isMac } from "./platform";

export { isMac };

/** What a shortcut check reads: a DOM KeyboardEvent and React's both have these. */
type Keys = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** The main modifier is held: Cmd (and not Control) on a Mac, Ctrl (and not the Windows key) on Windows. */
export function mod(e: Pick<Keys, "ctrlKey" | "metaKey">): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** The key held to show every shortcut, as KeyboardEvent.key names it. */
export function modKey(): string {
  return isMac() ? "Meta" : "Control";
}

/** Back to the list: Alt+Left on Windows, Cmd+[ on a Mac (Option+Left moves a word there). */
export function isBack(e: Keys): boolean {
  return isMac() ? mod(e) && e.key === "[" : e.altKey && e.key === "ArrowLeft";
}

/** Delete the selected chat: the Delete key, and on a Mac also Cmd+Backspace, as in the Finder. */
export function isDelete(e: Keys): boolean {
  return e.key === "Delete" || (isMac() && mod(e) && e.key === "Backspace");
}

// The Mac's symbols for keys that have one.
const SYMBOLS: Record<string, string> = { Enter: "↩", "↵": "↩", Backspace: "⌫", Tab: "⇥", Left: "←", Right: "→", Up: "↑", Down: "↓" };

/** A Windows label in the Mac's form: modifiers as ⌃ ⌥ ⇧ ⌘ in Apple's order, no plus signs. */
function macLabel(s: string, ctrlIsControl: boolean): string {
  // Windows' Back and Delete are other keys on a Mac (isBack, isDelete).
  if (s === "Alt+Left") return "⌘[";
  if (s === "Del" || s === "Delete") return "⌘⌫";
  const held = new Set<string>();
  let rest = s;
  let m: RegExpExecArray | null;
  while ((m = /^(Ctrl|Alt|Shift)(\+|$)/.exec(rest))) {
    held.add(m[1]);
    rest = rest.slice(m[0].length);
  }
  const ctrl = held.has("Ctrl");
  const marks = `${ctrl && ctrlIsControl ? "⌃" : ""}${held.has("Alt") ? "⌥" : ""}${held.has("Shift") ? "⇧" : ""}${ctrl && !ctrlIsControl ? "⌘" : ""}`;
  return marks + (SYMBOLS[rest] ?? rest);
}

/** "Ctrl+Shift+O" as this system shows it: unchanged on Windows, "⇧⌘O" on a Mac ("Ctrl" alone is "⌘"). */
export function keyLabel(s: string): string {
  return isMac() ? macLabel(s, false) : s;
}

/** For shortcuts that stay on Control on a Mac, where Cmd is the system's (Cmd+M minimises): "Ctrl+M" is "⌃M" there. */
export function ctrlLabel(s: string): string {
  return isMac() ? macLabel(s, true) : s;
}
