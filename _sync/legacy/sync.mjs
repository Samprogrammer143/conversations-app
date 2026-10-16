// Conversation sync's engine moved to the app's own repository
// (https://github.com/Samprogrammer143/conversations-app), of which each PC keeps one
// copy. This file stays in conversations repositories set up before the move, where
// Claude Code's hooks still name it: it runs the moved engine, and the first time
// sets that copy up and moves the hooks to it (in the background). Until then the
// engine that used to be here (sync-legacy.mjs) runs, so nothing is ever missed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
function appDir() {
  if (process.env.CONVERSATIONS_APP_HOME) return process.env.CONVERSATIONS_APP_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "conversations-app");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "conversations-app");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "conversations-app");
}
const engine = path.join(appDir(), "_sync", "sync.mjs");

if (fs.existsSync(engine)) {
  await import(pathToFileURL(engine).href);
} else {
  // The move belongs to this PC's first workspace: only its hooks start it. Another
  // workspace's hook (it names its own sync folder) just runs the old engine meanwhile.
  if (!process.argv.includes("--sync-home") && !process.env.CLAUDE_SYNC_HOME) {
    // At most one move at a time, and not again for ten minutes after one started.
    const mark = path.join(os.tmpdir(), "conversations-app-move.started");
    try {
      if (Date.now() - fs.statSync(mark).mtimeMs >= 10 * 60_000) fs.unlinkSync(mark);
    } catch {}
    let mine = false;
    try {
      fs.closeSync(fs.openSync(mark, "wx"));
      mine = true;
    } catch {}
    if (mine) {
      try {
        const child = spawn(process.execPath, [path.join(HERE, "move.mjs")], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
        child.on("error", () => {});
        child.unref();
      } catch {}
    }
  }
  await import(pathToFileURL(path.join(HERE, "sync-legacy.mjs")).href);
}
