// App settings, kept in the app's data folder (never synced: some are per PC).
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Settings } from "../shared/types";
import { appDataDir } from "./paths";
import { isModelName, isPermissionMode } from "./validate";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  windowMaterial: "mica",
  syncAutomatically: true,
  alertMode: false,
  checkWhileOpenSeconds: 30,
  checkFromTraySeconds: 300,
  uploadDelay: "after-quiet",
  keepResumeUpToDate: true,
  startAtLogin: true,
  showArchived: false,
  defaultModel: null,
  defaultPermissionMode: "default",
  folders: {},
  welcomed: false,
};

const isBool = (v: unknown) => typeof v === "boolean";
const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Project id -> absolute folder on this PC. */
function isFolders(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length <= 1000 && entries.every(([k, p]) => k.length > 0 && k.length <= 400 && typeof p === "string" && p.length <= 1000 && path.isAbsolute(p));
}

// What each setting accepts. A setting not listed here can't be set from the window.
const CHECKS: { [K in keyof Settings]: (v: unknown) => boolean } = {
  theme: (v) => v === "system" || v === "light" || v === "dark",
  windowMaterial: (v) => v === "mica" || v === "solid",
  syncAutomatically: isBool,
  checkWhileOpenSeconds: (v) => isInt(v, 10, 3600),
  checkFromTraySeconds: (v) => isInt(v, 30, 86_400),
  uploadDelay: (v) => v === "after-quiet" || v === "fast",
  keepResumeUpToDate: isBool,
  alertMode: isBool,
  startAtLogin: isBool,
  showArchived: isBool,
  defaultModel: (v) => v === null || isModelName(v),
  defaultPermissionMode: isPermissionMode,
  folders: isFolders,
  welcomed: isBool,
};

/** The known, well-formed part of a settings change from the window, and the names of what was refused. */
export function sanitizeSettingsPatch(patch: unknown): { patch: Partial<Settings>; rejected: string[] } {
  const out: Record<string, unknown> = {};
  const rejected: string[] = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { patch: {}, rejected: ["(not an object)"] };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const check = (CHECKS as Record<string, (v: unknown) => boolean>)[k];
    if (check && Object.prototype.hasOwnProperty.call(CHECKS, k) && check(v)) out[k] = k === "folders" ? { ...(v as Record<string, string>) } : v;
    else rejected.push(k);
  }
  return { patch: out as Partial<Settings>, rejected };
}

class SettingsStore extends EventEmitter {
  private value: Settings = { ...DEFAULT_SETTINGS };
  private file = "";

  load(): Settings {
    this.file = path.join(appDataDir(), "settings.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      // A hand-edited or older file keeps only what is still valid.
      this.value = { ...DEFAULT_SETTINGS, ...sanitizeSettingsPatch(raw).patch };
    } catch {
      this.value = { ...DEFAULT_SETTINGS };
    }
    return this.value;
  }

  get(): Settings {
    return this.value;
  }

  set(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit("change", this.value, patch);
    return this.value;
  }
}

export const settings = new SettingsStore();
