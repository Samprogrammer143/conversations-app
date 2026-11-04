// Where everything lives. The sync engine's folders follow the same rules as
// _sync/engine.mjs (including its environment overrides), so the app and the
// hooks always look at the same working copy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultAppHome, defaultDataDir, defaultSyncHome } from "../shared/dirs";

const HOME = os.homedir();

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
}

export function projectsDir(): string {
  return path.join(claudeDir(), "projects");
}

function defaultSyncDir(): string {
  return process.env.CLAUDE_SYNC_HOME || defaultSyncHome();
}

export function syncDir(): string {
  const fresh = defaultSyncDir();
  const legacy = path.join(claudeDir(), "conversation-sync");
  if (fs.existsSync(path.join(fresh, "config.json"))) return fresh;
  if (fs.existsSync(path.join(legacy, "config.json"))) return legacy;
  return fresh;
}

export function repoDir(): string {
  return path.join(syncDir(), "repo");
}

/**
 * This PC's copy of the app's own repository (the app and the sync engine, code only),
 * shared by every workspace. Same rules as defaultAppDir() in _sync/engine.mjs.
 */
export function appRepoDir(): string {
  return process.env.CONVERSATIONS_APP_HOME || defaultAppHome();
}

/**
 * The sync engine this app runs: CONVERSATIONS_ENGINE (development, tests), else the one
 * in the app's repository, else (a PC still on the old layout) the one inside the
 * conversations repository.
 */
export function engineScriptPath(): string {
  if (process.env.CONVERSATIONS_ENGINE) return process.env.CONVERSATIONS_ENGINE;
  const app = path.join(appRepoDir(), "_sync", "sync.mjs");
  if (fs.existsSync(app)) return app;
  return path.join(repoDir(), "_sync", "sync.mjs");
}

/** The app's own data: index, settings, logs. Never inside OneDrive or the repo. */
export function appDataDir(): string {
  const base = process.env.CONVERSATIONS_DATA_DIR || defaultDataDir();
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export function readSyncConfig(): { remote?: string; machine?: string; folders?: Record<string, string>; appVersion?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(syncDir(), "config.json"), "utf8"));
  } catch {
    return null;
  }
}

export function thisMachine(): string {
  return readSyncConfig()?.machine || os.hostname();
}

export const HOME_DIR = HOME;
