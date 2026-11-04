// The installed app's entry point. Conversations updates through the app's own
// repository (code only), of which every PC keeps a copy: a PC that pulls a newer
// _app/dist gets the new app on its next start. The shell only runs app code that
// is committed in that repository and unmodified; otherwise it runs the copy the
// installer brought (see choose.ts).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { chooseApp } from "./choose";
import { defaultAppHome, defaultDataDir, defaultSyncHome } from "../shared/dirs";
import { useLoginShellPath } from "../shared/login-path";

// 2: the app comes from the app's own repository (1 took it from the conversations repository).
const SHELL_VERSION = "2.0.0";

const appRepo = () => process.env.CONVERSATIONS_APP_HOME || defaultAppHome();
// A PC that was reinstalled before its sync moved: the app is still in its conversations repository.
const oldRepo = () => path.join(process.env.CLAUDE_SYNC_HOME || defaultSyncHome(), "repo");
const dataDir = () => process.env.CONVERSATIONS_DATA_DIR || defaultDataDir();

// A Mac app started from the Finder or the Dock gets only the system's own folders on
// PATH: git from Homebrew, Claude Code's hooks and its MCP servers need the user's. (In the
// background: the start doesn't wait for the shell.)
void useLoginShellPath(path.join(dataDir(), "login-path.json"));

function log(msg: string) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(path.join(dataDir(), "app.log"), `${new Date().toISOString()} [shell] ${msg}\n`);
  } catch {}
}

const bundled = path.join(app.getAppPath(), "dist");
let dist: string;
try {
  dist = chooseApp({ repos: [appRepo(), oldRepo()], bundled, shellVersion: SHELL_VERSION, stageRoot: path.join(dataDir(), "app"), log });
} catch (e) {
  log(`could not choose the app code: ${(e as Error).message}`);
  dist = bundled;
}
process.env.CONVERSATIONS_SHELL_VERSION = SHELL_VERSION;
// Where the app code runs from, and where staged copies live: the app records the
// first in the second once it is the primary instance, and tidies old copies.
process.env.CONVERSATIONS_APP_DIST = dist;
process.env.CONVERSATIONS_STAGE_ROOT = path.join(dataDir(), "app");
await import(pathToFileURL(path.join(dist, "main", "main.mjs")).href);
