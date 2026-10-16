// What the composer keeps per chat: unsent messages and the model, effort and mode picked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.CONVERSATIONS_DATA_DIR = path.join(os.tmpdir(), `conversations-test-${process.pid}`);
import { ComposerStore, cleanPrefs } from "../src/main/composer-state";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "cccccccc-3333-4333-8333-cccccccccccc";
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "composer-")), "composer.json");

describe("per-chat composer state", () => {
  it("keeps each chat's draft and choices apart, and survives a restart", () => {
    const f = file();
    const s = new ComposerStore(f);
    s.save({ drafts: { [A]: "half a message", [B]: "another" }, prefs: { [A]: { model: "opus", effort: "high" }, [B]: { model: "fable", mode: "auto" } } });
    s.flush();
    const again = new ComposerStore(f).get();
    expect(again.drafts).toEqual({ [A]: "half a message", [B]: "another" });
    expect(again.prefs[A]).toEqual({ model: "opus", effort: "high" });
    expect(again.prefs[B]).toEqual({ model: "fable", mode: "auto" });
  });

  it("forgets a draft once it is sent (empty), and a choice set to null", () => {
    const s = new ComposerStore(file());
    s.save({ drafts: { [A]: "x" }, prefs: { "new:C:/p": { model: "opus" } } });
    s.save({ drafts: { [A]: "" }, prefs: { "new:C:/p": null } });
    expect(s.get()).toEqual({ drafts: {}, prefs: {} });
    s.save({ drafts: { [A]: "   " } });
    expect(s.get().drafts).toEqual({});
  });

  it("takes only choices the composer offers", () => {
    expect(cleanPrefs({ model: "claude-opus-5-5", effort: "max", mode: "plan" })).toEqual({ model: "claude-opus-5-5", effort: "max", mode: "plan" });
    expect(cleanPrefs({ model: "rm -rf /", effort: "turbo", mode: "bypassPermissions" })).toBeNull();
    expect(cleanPrefs("opus")).toBeNull();
    const s = new ComposerStore(file());
    s.save({ drafts: { "": "x", [A]: 42 }, prefs: { [B]: { mode: "dontAsk" } } });
    expect(s.get()).toEqual({ drafts: {}, prefs: {} });
  });

  it("keeps at most 400 chats, dropping the ones untouched longest", () => {
    const s = new ComposerStore(file());
    for (let i = 0; i < 410; i++) s.save({ drafts: { [`new:C:/p${i}`]: `d${i}` } });
    s.save({ drafts: { "new:C:/p5": "touched again" } });
    const keys = Object.keys(s.get().drafts);
    expect(keys).toHaveLength(400);
    expect(keys).not.toContain("new:C:/p0");
    expect(keys.at(-1)).toBe("new:C:/p5");
  });

  it("starts empty from a missing or damaged file", () => {
    const f = file();
    fs.writeFileSync(f, "{not json");
    expect(new ComposerStore(f).get()).toEqual({ drafts: {}, prefs: {} });
  });
});
