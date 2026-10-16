// The /mcp panel: Claude Code's MCP servers for a chat, from its running session
// when there is one (so they can be reconnected), otherwise from a short Claude Code
// that starts in the chat's folder with its settings, reports, and closes.

import os from "node:os";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { query } from "./sdk";
import type { McpServerInfo } from "../../shared/types";
import { log } from "../log";

const STATUSES = new Set(["connected", "failed", "needs-auth", "pending", "disabled"]);

/** Claude Code's report → what the panel shows, failed and waiting servers first. */
export function toMcpInfo(list: McpServerStatus[]): McpServerInfo[] {
  const order: Record<string, number> = { failed: 0, "needs-auth": 1, pending: 2, connected: 3, disabled: 4 };
  return list
    .filter((s) => s && typeof s.name === "string" && s.name)
    .map((s) => ({
      name: s.name,
      status: (STATUSES.has(s.status) ? s.status : "failed") as McpServerInfo["status"],
      scope: s.source ?? s.scope ?? null,
      toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
      error: typeof s.error === "string" && s.error.trim() ? s.error.trim().slice(0, 400) : null,
    }))
    .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
}

async function* nothing(): AsyncGenerator<never> {
  await new Promise(() => {});
}

/**
 * The servers a chat in `cwd` would have, from a Claude Code started just to ask.
 * Waits up to `waitMs` for servers still connecting, so the answer is not all "pending".
 */
export async function probeMcp(claudePath: string, cwd: string, waitMs = 8000): Promise<McpServerInfo[]> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  // The same servers a chat there gets, Claude in Chrome included.
  const q = query({ prompt: nothing(), options: { cwd: cwd || os.homedir(), pathToClaudeCodeExecutable: claudePath, settingSources: ["user", "project", "local"], extraArgs: { chrome: null }, env } });
  const timer = setTimeout(() => q.close(), waitMs + 20_000);
  try {
    const t0 = Date.now();
    let list = toMcpInfo(await q.mcpServerStatus());
    while (list.some((s) => s.status === "pending") && Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 500));
      list = toMcpInfo(await q.mcpServerStatus());
    }
    return list;
  } catch (e) {
    log("chat", `mcp status for ${cwd}: ${(e as Error).message}`);
    throw e;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
