#!/usr/bin/env node
// Conversation sync's installer moved to the app's own repository
// (https://github.com/Samprogrammer143/conversations-app). This forwarder stays in
// conversations repositories set up before the move: it makes sure this PC has a
// copy of the app's repository, then runs the installer there for this repository.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_REPO_URL = process.env.CONVERSATIONS_APP_REPO_URL || "https://github.com/Samprogrammer143/conversations-app.git";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
function appDir() {
  if (process.env.CONVERSATIONS_APP_HOME) return process.env.CONVERSATIONS_APP_HOME;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "conversations-app");
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "conversations-app");
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "conversations-app");
}
const APP = appDir();
if (!fs.existsSync(path.join(APP, ".git"))) {
  console.log(`Getting the app's repository into ${APP} ...`);
  fs.mkdirSync(path.dirname(APP), { recursive: true });
  const c = spawnSync("git", ["-c", "core.longpaths=true", "clone", APP_REPO_URL, APP], { stdio: "inherit" });
  if (c.status !== 0) process.exit(c.status ?? 1);
}
const args = process.argv.slice(2);
// This repository is the one to set up, unless another was named.
if (!args.includes("--remote")) {
  const origin = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: path.resolve(HERE, ".."), encoding: "utf8" }).stdout.trim();
  if (origin) args.push("--remote", origin);
}
const r = spawnSync(process.execPath, [path.join(APP, "_sync", "install.mjs"), ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
