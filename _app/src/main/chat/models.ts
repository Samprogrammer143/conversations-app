// The models Claude Code offers this account, for the composer's model menu.
// Asked of Claude Code itself (a short session that sends nothing), kept on disk,
// and refreshed in the background at most every 12 hours or when a live chat
// reports a newer list. The menu never waits on it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "./sdk";
import { appDataDir } from "../paths";
import { log } from "../log";

export type { ModelChoice } from "../../shared/types";
import type { Effort, ModelChoice, SlashCommandInfo } from "../../shared/types";

const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const file = () => path.join(appDataDir(), "models.json");

/** Claude Code's rows → menu choices: the aliases ("Opus 5.5") are current, pinned versions are older. */
export function toChoices(list: { value: string; displayName: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }[]): ModelChoice[] {
  return list
    .filter((m) => m.value && m.displayName)
    .map((m) => ({
      value: m.value,
      label: m.displayName,
      hint: m.description ?? "",
      current: !m.value.startsWith("claude-"),
      efforts: m.supportsEffort ? ((m.supportedEffortLevels ?? []) as Effort[]) : [],
    }));
}

export function toCommands(list: { name: string; description?: string; argumentHint?: string; builtin?: boolean; aliases?: string[] }[]): SlashCommandInfo[] {
  const seen = new Set<string>();
  const out: SlashCommandInfo[] = [];
  // Where names repeat, Claude Code runs the built-in one; list each name once.
  for (const c of [...list].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin))) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "", builtin: !!c.builtin, aliases: c.aliases ?? [] });
  }
  return out.sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
}

// Commands depend on the folder (its skills, its plugins), so they are kept per folder.
const COMMANDS_MAX_AGE_MS = 10 * 60 * 1000;
const commandCache = new Map<string, { at: number; list: SlashCommandInfo[] }>();
const commandProbes = new Map<string, Promise<SlashCommandInfo[]>>();

export function rememberCommands(cwd: string, list: SlashCommandInfo[]) {
  if (list.length) commandCache.set(cwd.toLowerCase(), { at: Date.now(), list });
}

/** The commands and skills Claude Code offers in a folder. The first ask for a folder takes about a second. */
export async function commandsFor(claudePath: string | null, cwd: string): Promise<SlashCommandInfo[]> {
  const key = cwd.toLowerCase();
  const hit = commandCache.get(key);
  if (hit && Date.now() - hit.at < COMMANDS_MAX_AGE_MS) return hit.list;
  if (!claudePath) return hit?.list ?? [];
  let probe = commandProbes.get(key);
  if (!probe) {
    probe = (async () => {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
      delete env.ELECTRON_RUN_AS_NODE;
      const q = query({ prompt: nothing(), options: { cwd, pathToClaudeCodeExecutable: claudePath, settingSources: ["user", "project", "local"], env } });
      const timer = setTimeout(() => q.close(), 30_000);
      try {
        const list = toCommands(await q.supportedCommands());
        rememberCommands(cwd, list);
        return list;
      } catch (e) {
        log("chat", `commands for ${cwd}: ${(e as Error).message}`);
        return hit?.list ?? [];
      } finally {
        clearTimeout(timer);
        q.close();
        commandProbes.delete(key);
      }
    })();
    commandProbes.set(key, probe);
  }
  return probe;
}

let cache: { at: number; models: ModelChoice[] } | null = null;
let refreshing: Promise<void> | null = null;

function load() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (Array.isArray(v.models)) cache = { at: Number(v.at) || 0, models: v.models };
  } catch {}
  return cache;
}

/** Records a list, from a probe or from a live session. */
export function remember(models: ModelChoice[]) {
  if (!models.length) return;
  cache = { at: Date.now(), models };
  try {
    fs.writeFileSync(file(), JSON.stringify(cache));
  } catch {}
}

/** The known list now (possibly empty), refreshed in the background when old. */
export function knownModels(claudePath: string | null): ModelChoice[] {
  const c = load();
  if (claudePath && (!c || Date.now() - c.at > MAX_AGE_MS)) void refresh(claudePath);
  return c?.models ?? [];
}

async function* nothing(): AsyncGenerator<never> {
  await new Promise(() => {});
}

/** Starts Claude Code just long enough to ask for its model list. Sends no message. */
export function refresh(claudePath: string): Promise<void> {
  refreshing ??= (async () => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_SYNC_DISABLE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const q = query({ prompt: nothing(), options: { cwd: os.homedir(), pathToClaudeCodeExecutable: claudePath, settingSources: ["user"], env } });
    const timer = setTimeout(() => q.close(), 30_000);
    try {
      remember(toChoices(await q.supportedModels()));
    } catch (e) {
      log("chat", `model list: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      q.close();
      refreshing = null;
    }
  })();
  return refreshing;
}
