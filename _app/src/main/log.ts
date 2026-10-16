// A small rotating log in the app's data folder. Never logs transcript content.
import fs from "node:fs";
import path from "node:path";
import { appDataDir } from "./paths";

let file: string | null = null;

export function log(scope: string, message: string) {
  try {
    file ??= path.join(appDataDir(), "app.log");
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} [${scope}] ${message}\n`);
  } catch {}
  if (process.env.CONVERSATIONS_DEBUG) console.log(`[${scope}] ${message}`);
}

export const logPath = () => path.join(appDataDir(), "app.log");
