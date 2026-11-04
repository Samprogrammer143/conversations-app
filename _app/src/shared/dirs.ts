// The folders the app keeps for itself, one set of rules for the installed shell, the app
// and (as defaultSyncDir and defaultAppDir in _sync/engine.mjs) the sync engine: %LOCALAPPDATA%
// on Windows, Application Support on a Mac. Each has an environment override the callers
// check first (CLAUDE_SYNC_HOME, CONVERSATIONS_APP_HOME, CONVERSATIONS_DATA_DIR).

import os from "node:os";
import path from "node:path";

/** Where this user's app folders go. */
export function localBase(): string {
  const home = os.homedir();
  if (process.platform === "win32") return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  return process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
}

/** The first workspace's sync folder (its conversations repository is repo/ inside). */
export const defaultSyncHome = () => path.join(localBase(), "claude-conversation-sync");
/** This computer's copy of the app's own repository. */
export const defaultAppHome = () => path.join(localBase(), "conversations-app");
/** The app's data: settings, index, logs. */
export const defaultDataDir = () => path.join(localBase(), "Conversations");
