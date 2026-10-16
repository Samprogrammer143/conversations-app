// Checks on everything the window asks of the app. The window is sandboxed, but
// the app still treats each request as untrusted input: a conversation id must be
// a UUID, a permission mode one of the three the app offers, an edit a known
// field with a value of the right kind.

import type { EditField } from "../shared/api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A conversation (session) id. */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** A permission request id: Claude Code's tool-use id ("toolu_01…") or the app's own fallback. */
export const isRequestId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);

/** A model name or alias: "opus", "sonnet[1m]", "claude-opus-5-5". */
export const isModelName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:[\]-]{1,80}$/.test(v);

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const isEffort = (v: unknown): v is EffortLevel => typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);

/** The permission modes the app offers. "auto" is Claude Code's classifier mode; never "bypassPermissions" or "dontAsk". */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const isPermissionMode = (v: unknown): v is PermissionMode => typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);

export const DECISIONS = ["allow", "allow-always", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];
export const isDecision = (v: unknown): v is Decision => typeof v === "string" && (DECISIONS as readonly string[]).includes(v);

/**
 * A valid edit, or null. Pinned, archived and deleted take true or false; the
 * title takes a short text, or null (or an empty text) for the automatic title.
 */
export function checkEdit(field: unknown, value: unknown): { field: EditField; value: boolean | string | null } | null {
  if (field === "pinned" || field === "archived" || field === "deleted") return typeof value === "boolean" ? { field, value } : null;
  if (field === "title") {
    if (value === null) return { field, value: null };
    if (typeof value !== "string") return null;
    const t = value.replace(/\s+/g, " ").trim();
    if (t.length > 200) return null;
    return { field, value: t || null };
  }
  return null;
}
