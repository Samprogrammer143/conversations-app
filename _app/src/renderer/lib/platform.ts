// Words that differ on a Mac. Read at call time: modules load before main.tsx marks the platform.

import { api } from "./api";

export function isMac(): boolean {
  return api.app.platform() === "darwin";
}

/** "Mac" on a Mac, "PC" on Windows: for "this PC", the computer the app runs on. */
export function pcWord(): string {
  return isMac() ? "Mac" : "PC";
}

/** Claude Code's install command: Anthropic's installer on a Mac (which needs no Node), npm on Windows (its set-up installs Node). */
export function installClaudeCommand(): string {
  return isMac() ? "curl -fsSL https://claude.ai/install.sh | bash" : "npm install -g @anthropic-ai/claude-code";
}

/** For computers in general ("all your PCs", "3 PCs"): on a Mac "computer", as the others may be PCs. */
export function computerWord(): string {
  return isMac() ? "computer" : "PC";
}
