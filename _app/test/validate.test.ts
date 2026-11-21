// What the main process accepts from the window.
import { describe, expect, it } from "vitest";
import { checkEdit, openableSignIn, isDecision, isModelName, isPermissionMode, isRequestId, isUuid } from "../src/main/validate";
import { DEFAULT_SETTINGS, sanitizeSettingsPatch } from "../src/main/settings";

describe("ids and names", () => {
  it("accepts conversation ids only as UUIDs", () => {
    expect(isUuid("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa")).toBe(true);
    for (const bad of ["../../history", "aaaaaaaa", "", 42, null, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/../x"]) expect(isUuid(bad), String(bad)).toBe(false);
  });

  it("accepts tool-use ids as request ids", () => {
    expect(isRequestId("toolu_01AbCdEf")).toBe(true);
    expect(isRequestId("a b")).toBe(false);
    expect(isRequestId("x".repeat(200))).toBe(false);
  });

  it("allows only the app's three permission modes", () => {
    for (const ok of ["default", "acceptEdits", "plan"]) expect(isPermissionMode(ok)).toBe(true);
    expect(isPermissionMode("auto")).toBe(true);
    for (const bad of ["bypassPermissions", "dontAsk", "", null]) expect(isPermissionMode(bad), String(bad)).toBe(false);
  });

  it("knows the three answers to an approval", () => {
    for (const ok of ["allow", "allow-always", "deny"]) expect(isDecision(ok)).toBe(true);
    expect(isDecision("yes")).toBe(false);
  });

  it("accepts model names and aliases", () => {
    for (const ok of ["opus", "sonnet[1m]", "claude-opus-5-5", "claude-haiku-4-5-20251001"]) expect(isModelName(ok), ok).toBe(true);
    for (const bad of ["--dangerously-skip-permissions x", "a;b", "", "x".repeat(100)]) expect(isModelName(bad), bad).toBe(false);
  });
});

describe("edits", () => {
  it("take the right kind of value for each field", () => {
    expect(checkEdit("pinned", true)).toEqual({ field: "pinned", value: true });
    expect(checkEdit("deleted", "yes")).toBeNull();
    expect(checkEdit("archived", 1)).toBeNull();
    expect(checkEdit("title", "  New   name ")).toEqual({ field: "title", value: "New name" });
    expect(checkEdit("title", "   ")).toEqual({ field: "title", value: null });
    expect(checkEdit("title", null)).toEqual({ field: "title", value: null });
    expect(checkEdit("title", "x".repeat(201))).toBeNull();
    expect(checkEdit("app", true)).toBeNull();
    expect(checkEdit("__proto__", true)).toBeNull();
  });
});

describe("settings from the window", () => {
  it("keeps known settings with valid values and refuses the rest", () => {
    // (A full path on the system the test runs on.)
    const folder = process.platform === "win32" ? "C:\\Users\\me\\y" : "/Users/me/y";
    const { patch, rejected } = sanitizeSettingsPatch({
      theme: "dark",
      checkWhileOpenSeconds: 60,
      defaultPermissionMode: "bypassPermissions",
      defaultModel: "opus",
      folders: { "github.com/x/y": folder },
      startAtLogin: "yes",
      unknown: 1,
    });
    expect(patch).toEqual({ theme: "dark", checkWhileOpenSeconds: 60, defaultModel: "opus", folders: { "github.com/x/y": folder } });
    expect(rejected.sort()).toEqual(["defaultPermissionMode", "startAtLogin", "unknown"]);
  });

  it("refuses relative folders, silly intervals and non-objects", () => {
    expect(sanitizeSettingsPatch({ folders: { a: "relative\\path" } }).patch).toEqual({});
    expect(sanitizeSettingsPatch({ checkWhileOpenSeconds: 1 }).patch).toEqual({});
    expect(sanitizeSettingsPatch({ checkFromTraySeconds: 1.5 }).patch).toEqual({});
    expect(sanitizeSettingsPatch(null).patch).toEqual({});
    expect(sanitizeSettingsPatch(["theme"]).patch).toEqual({});
  });

  it("accepts every default", () => {
    expect(sanitizeSettingsPatch(DEFAULT_SETTINGS)).toEqual({ patch: DEFAULT_SETTINGS, rejected: [] });
  });
});

describe("sign-in pages the app opens", () => {
  it("opens https pages, and plain http only on this PC", () => {
    expect(openableSignIn("https://accounts.google.com/o/oauth2/auth?x=1")).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
    expect(openableSignIn("http://localhost:8080/authorize?client_id=a")).toBe("http://localhost:8080/authorize?client_id=a");
    expect(openableSignIn(" HTTP://LOCALHOST:8080/a")).toBe("http://localhost:8080/a");
    expect(openableSignIn("http://localhost@evil.com/a")).toBeNull();
    expect(openableSignIn("http://0.0.0.0:8080/a")).toBeNull();
    expect(openableSignIn("http://127.0.0.1:8080/authorize")).not.toBeNull();
    expect(openableSignIn("http://[::1]:8080/authorize")).not.toBeNull();
    expect(openableSignIn("http://example.com/authorize")).toBeNull();
    expect(openableSignIn("http://localhost.evil.com/authorize")).toBeNull();
    expect(openableSignIn("file:///C:/x")).toBeNull();
    expect(openableSignIn("javascript:alert(1)")).toBeNull();
  });
});
