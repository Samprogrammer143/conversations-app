// Shortcuts: Ctrl on Windows, Cmd on a Mac, and each system's way of writing them. The
// window's bridge is stood in for, so the same checks run as Windows and as a Mac on any system.
import { afterAll, describe, expect, it, vi } from "vitest";

let platform = "win32";
vi.stubGlobal("window", { conversations: { app: { platform: () => platform } } });
const { ctrlLabel, isBack, isDelete, isMac, keyLabel, mod, modKey } = await import("../src/renderer/lib/keys");
const { pcWord } = await import("../src/renderer/lib/platform");

afterAll(() => {
  vi.unstubAllGlobals();
});

/** A key press as the window sees it: nothing held unless given. */
const press = (key: string, held: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held });

describe("on Windows", () => {
  it("is read when asked, not when the module loaded", () => {
    platform = "win32";
    expect(isMac()).toBe(false);
    platform = "darwin";
    expect(isMac()).toBe(true);
    platform = "win32";
  });

  it("takes Ctrl, not the Windows key, as the shortcut key", () => {
    platform = "win32";
    expect(mod(press("k", { ctrlKey: true }))).toBe(true);
    expect(mod(press("k", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(mod(press("k", { metaKey: true }))).toBe(false);
    expect(mod(press("k", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(mod(press("k"))).toBe(false);
    expect(modKey()).toBe("Control");
  });

  it("goes back with Alt+Left, and deletes with Delete only", () => {
    platform = "win32";
    expect(isBack(press("ArrowLeft", { altKey: true }))).toBe(true);
    expect(isBack(press("[", { ctrlKey: true }))).toBe(false);
    expect(isDelete(press("Delete"))).toBe(true);
    expect(isDelete(press("Backspace", { ctrlKey: true }))).toBe(false);
  });

  it("shows every label as written", () => {
    platform = "win32";
    for (const s of ["Ctrl+K", "Ctrl+Shift+O", "Ctrl+Enter", "Alt+Left", "Ctrl+,", "Del", "Ctrl+1 2 3", "Ctrl", "F2"]) expect(keyLabel(s)).toBe(s);
    expect(ctrlLabel("Ctrl+M")).toBe("Ctrl+M");
    expect(ctrlLabel("Ctrl+Shift+2")).toBe("Ctrl+Shift+2");
    expect(pcWord()).toBe("PC");
  });
});

describe("on a Mac", () => {
  it("takes Cmd, not Control, as the shortcut key", () => {
    platform = "darwin";
    expect(mod(press("k", { metaKey: true }))).toBe(true);
    expect(mod(press("o", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(mod(press("k", { ctrlKey: true }))).toBe(false);
    expect(mod(press("k", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(modKey()).toBe("Meta");
  });

  it("goes back with Cmd+[ (Option+Left moves a word), and deletes with Cmd+Backspace too", () => {
    platform = "darwin";
    expect(isBack(press("[", { metaKey: true }))).toBe(true);
    expect(isBack(press("ArrowLeft", { altKey: true }))).toBe(false);
    expect(isBack(press("[", { ctrlKey: true }))).toBe(false);
    expect(isDelete(press("Backspace", { metaKey: true }))).toBe(true);
    expect(isDelete(press("Delete"))).toBe(true);
    expect(isDelete(press("Backspace"))).toBe(false);
    expect(isDelete(press("Backspace", { ctrlKey: true }))).toBe(false);
  });

  it("writes shortcuts with Apple's symbols, in Apple's order, without plus signs", () => {
    platform = "darwin";
    expect(keyLabel("Ctrl+K")).toBe("⌘K");
    expect(keyLabel("Ctrl+Shift+O")).toBe("⇧⌘O");
    expect(keyLabel("Ctrl+Enter")).toBe("⌘↩");
    expect(keyLabel("Ctrl+↵")).toBe("⌘↩");
    expect(keyLabel("Ctrl+,")).toBe("⌘,");
    expect(keyLabel("Ctrl+1 2 3")).toBe("⌘1 2 3");
    expect(keyLabel("Shift+Enter")).toBe("⇧↩");
    expect(keyLabel("Alt+Shift+Ctrl+X")).toBe("⌥⇧⌘X");
    expect(keyLabel("Ctrl")).toBe("⌘");
    expect(keyLabel("F2")).toBe("F2");
    expect(keyLabel("Up, Down")).toBe("Up, Down");
  });

  it("writes Windows' Back and Delete as the Mac's own keys", () => {
    platform = "darwin";
    expect(keyLabel("Alt+Left")).toBe("⌘[");
    expect(keyLabel("Del")).toBe("⌘⌫");
  });

  it("keeps Control for the shortcuts where Cmd is the Mac's own", () => {
    platform = "darwin";
    expect(ctrlLabel("Ctrl+M")).toBe("⌃M");
    expect(ctrlLabel("Ctrl+Shift+2")).toBe("⌃⇧2");
    expect(ctrlLabel("Ctrl+Shift+1, 2, …")).toBe("⌃⇧1, 2, …");
    expect(ctrlLabel("Ctrl+Alt+Shift+X")).toBe("⌃⌥⇧X");
  });

  it("calls this computer a Mac", () => {
    platform = "darwin";
    expect(pcWord()).toBe("Mac");
  });
});
