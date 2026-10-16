// What the composer keeps for each conversation: the message you were writing and
// had not sent, and the model, effort and permission mode you picked for that chat.
// Kept in the app's data folder, so it survives switching chats, restarts and
// updates (the window's own storage changes place with each update).
//
// Keys are conversation ids, or "new:<folder or project>" for a chat not started yet.

import fs from "node:fs";
import path from "node:path";
import type { ComposerPrefs, ComposerState } from "../shared/types";
import { appDataDir } from "./paths";
import { isEffort, isModelName, isPermissionMode } from "./validate";
import { log } from "./log";

const MAX_KEYS = 400;
const MAX_DRAFT = 100_000;

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
export const isComposerKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= 600 && !/[\u0000-\u001f]/.test(k) && !RESERVED.has(k);

/** Only what the composer can choose; anything else is dropped. Null when nothing is left. */
export function cleanPrefs(v: unknown): ComposerPrefs | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: ComposerPrefs = {};
  if (isModelName(o.model)) out.model = o.model;
  if (isEffort(o.effort)) out.effort = o.effort;
  if (isPermissionMode(o.mode)) out.mode = o.mode;
  return Object.keys(out).length ? out : null;
}

/** The newest entries win: one that changes moves to the end, and the oldest go past the limit. */
function put<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const next = { ...map };
  delete next[key];
  if (value !== null) next[key] = value;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_KEYS))) delete next[k];
  return next;
}

export class ComposerStore {
  private state: ComposerState = { drafts: {}, prefs: {} };
  private timer: NodeJS.Timeout | null = null;
  private loaded = false;

  constructor(private file = path.join(appDataDir(), "composer.json")) {}

  get(): ComposerState {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<ComposerState>;
        let drafts: Record<string, string> = {};
        let prefs: Record<string, ComposerPrefs> = {};
        for (const [k, v] of Object.entries(raw.drafts ?? {})) if (isComposerKey(k) && typeof v === "string" && v) drafts = put(drafts, k, v.slice(0, MAX_DRAFT));
        for (const [k, v] of Object.entries(raw.prefs ?? {})) {
          const p = cleanPrefs(v);
          if (isComposerKey(k) && p) prefs = put(prefs, k, p);
        }
        this.state = { drafts, prefs };
      } catch {
        // None yet, or unreadable: start empty.
      }
    }
    return this.state;
  }

  /** Applies a change from the window: a draft of "" or null and prefs of null remove the entry. */
  save(patch: unknown): void {
    if (!patch || typeof patch !== "object") return;
    const p = patch as { drafts?: unknown; prefs?: unknown };
    let { drafts, prefs } = this.get();
    if (p.drafts && typeof p.drafts === "object") {
      for (const [k, v] of Object.entries(p.drafts as Record<string, unknown>)) {
        if (!isComposerKey(k)) continue;
        drafts = put(drafts, k, typeof v === "string" && v.trim() ? v.slice(0, MAX_DRAFT) : null);
      }
    }
    if (p.prefs && typeof p.prefs === "object") {
      for (const [k, v] of Object.entries(p.prefs as Record<string, unknown>)) {
        if (isComposerKey(k)) prefs = put(prefs, k, cleanPrefs(v));
      }
    }
    this.state = { drafts, prefs };
    // While the app quits, the window's last save (on unload) is written at once.
    if (this.closing) this.flush();
    else this.writeSoon();
  }

  /** Set when the app starts quitting: from then on every save is written straight away. */
  closing = false;

  private writeSoon() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
    this.timer.unref?.();
  }

  /** Writes now (also on quit, so a draft typed in the last moment is kept). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.loaded) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log("app", `could not save the composer's drafts: ${(e as Error).message}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
  }
}
