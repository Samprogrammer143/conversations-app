// What older installs (shell 1) find in the conversations repository, where the app
// used to be: it runs the app from the app's own repository instead, so those PCs
// move over without a reinstall. The first time, before this PC has a copy of the
// app's repository, it starts the move (the conversations repository's move.mjs) and
// runs the installed copy meanwhile.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app } from "electron";
import { chooseApp } from "./choose";

const local = () => process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const appRepo = () => process.env.CONVERSATIONS_APP_HOME || path.join(local(), "conversations-app");
const dataDir = () => process.env.CONVERSATIONS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "Conversations");
/** This PC's conversations repository, where the engine's rules put it (the older place inside ~/.claude too). */
function syncRepo(): string {
  const fresh = path.join(process.env.CLAUDE_SYNC_HOME || path.join(local(), "claude-conversation-sync"), "repo");
  const older = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "conversation-sync", "repo");
  return fs.existsSync(path.join(fresh, ".git")) || !fs.existsSync(path.join(older, ".git")) ? fresh : older;
}

function log(msg: string) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(path.join(dataDir(), "app.log"), `${new Date().toISOString()} [forwarder] ${msg}\n`);
  } catch {}
}

// This forwarder's own staged copy (<stage>/main/main.mjs): the app keeps it when it tidies.
process.env.CONVERSATIONS_FORWARDER_STAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bundled = path.join(app.getAppPath(), "dist");
let dist = bundled;
try {
  if (!fs.existsSync(path.join(appRepo(), ".git"))) {
    const move = path.join(syncRepo(), "_sync", "move.mjs");
    if (fs.existsSync(move)) {
      const child = spawn(process.execPath, [move], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, windowsHide: true, stdio: "ignore" });
      child.on("error", (e) => log(`could not start the move to the app's repository: ${e.message}`));
      child.unref();
      log("moving to the app's repository; this start runs the installed copy");
    }
  } else {
    dist = chooseApp({ repos: [appRepo()], bundled, shellVersion: process.env.CONVERSATIONS_SHELL_VERSION || "1.0.0", stageRoot: path.join(dataDir(), "app"), log });
  }
} catch (e) {
  log(`could not choose the app code: ${(e as Error).message}`);
}
process.env.CONVERSATIONS_APP_DIST = dist;
await import(pathToFileURL(path.join(dist, "main", "main.mjs")).href);
