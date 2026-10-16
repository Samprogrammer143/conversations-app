// Read-only view of the sync repository's working copy, matching the rules in
// _sync/engine.mjs (version 3). The engine is the only writer; the app reads
// the same files directly so opening and listing never wait for a process.
// test/repo-read.test.ts checks these against the engine's own output.

import fs from "node:fs";
import path from "node:path";

export interface RemoteSession {
  sessionId: string;
  key: string;
  dir: string;
  projectId: string;
  projectLabel: string;
  title?: string;
  firstPrompt?: string;
  prompts?: number;
  startedAt?: string;
  lastMessageAt?: string;
  bytes?: number;
  sha256?: string;
  gitRemote?: string | null;
  updatedAt?: string;
  lastPushedFrom?: string;
  machines?: Record<string, { cwd?: string; lastPushAt?: string }>;
}

const NOT_PROJECTS = new Set(["_sync", "_app", "_devices", "_state", "_tools"]);
export const isProjectFolder = (name: string) => !name.startsWith(".") && !name.startsWith("C--") && !name.startsWith("-") && !NOT_PROJECTS.has(name);

// Session ids from files are only trusted when they are UUIDs (the engine's rule too).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

/**
 * One spelling per repository, whatever the URL form: "host/owner/repo" (lower case).
 * https and ssh URLs (ports and user names dropped), scp-style "git@host:path", GitLab
 * subgroups and Azure DevOps's three URL forms. Anything else is lower-cased as it is.
 */
export function normaliseRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  let host: string | null = null;
  let rest: string | null = null;
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (scheme && scheme[1].toLowerCase() !== "file") {
    const m = scheme[2].match(/^(?:[^@/]*@)?([^/:?#]+)(?::\d+)?(\/[^?#]*)?/);
    if (m) {
      host = m[1];
      rest = m[2] || "";
    }
  } else if (!scheme) {
    const m = s.match(/^(?:[^@/\\\s]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9-]{2,}):(?!\\|\/\/)(.+)$/);
    if (m && !/^[A-Za-z]$/.test(m[1])) {
      host = m[1];
      rest = m[2];
    }
  }
  if (host === null) return s.toLowerCase();
  host = host.toLowerCase().replace(/^www\./, "");
  let parts = String(rest).split("/").filter(Boolean);
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, "");
  parts = parts.filter(Boolean);
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    host = "dev.azure.com";
    if (parts[0]?.toLowerCase() === "v3") parts = parts.slice(1);
  } else if (host.endsWith(".visualstudio.com")) {
    parts = [host.slice(0, -".visualstudio.com".length), ...parts.filter((p) => p.toLowerCase() !== "defaultcollection")];
    host = "dev.azure.com";
  }
  if (host === "dev.azure.com") parts = parts.filter((p) => p.toLowerCase() !== "_git");
  if (!parts.length) return host;
  return `${host}/${parts.join("/")}`.toLowerCase();
}

export function projectLabel(projectId: string): string {
  if (projectId === "folder:_home") return "Home folder";
  if (projectId.startsWith("folder:")) return projectId.slice("folder:".length);
  return projectId.split("/").pop() || projectId;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// "PC|working folder" pairs a conversation was uploaded from, from its meta.json.
const placesOf = (meta: RemoteSession) => Object.entries(meta.machines || {}).map(([pc, v]) => `${pc}|${String(v?.cwd ?? "").toLowerCase()}`);

/**
 * Every conversation in the working copy, with version 3 project ids. A conversation
 * uploaded without a git remote joins a repository only when another conversation
 * uploaded from the same PC and working folder names it (the newest such one); a
 * folder name alone proves nothing.
 */
export function listRemoteSessions(repoDir: string): RemoteSession[] {
  const out: RemoteSession[] = [];
  let keys: fs.Dirent[] = [];
  try {
    keys = fs.readdirSync(repoDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const placeRemote = new Map<string, { remote: string; at: string }>();
  for (const d of keys) {
    if (!d.isDirectory() || !isProjectFolder(d.name)) continue;
    const kdir = path.join(repoDir, d.name);
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(kdir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!isUuid(id)) continue;
      const meta = readJson<RemoteSession>(path.join(kdir, id, "meta.json"));
      if (!meta || meta.sessionId !== id) continue;
      const remote = normaliseRemote(meta.gitRemote);
      if (remote) {
        const at = String(meta.updatedAt ?? "");
        for (const p of placesOf(meta)) {
          const cur = placeRemote.get(p);
          if (!cur || at > cur.at || (at === cur.at && remote < cur.remote)) placeRemote.set(p, { remote, at });
        }
      }
      out.push({ ...meta, key: d.name, dir: path.join(kdir, id), projectId: "", projectLabel: "" });
    }
  }
  for (const s of out) {
    const inherited = placesOf(s).map((p) => placeRemote.get(p)?.remote).filter((r): r is string => !!r).sort()[0];
    s.projectId = normaliseRemote(s.gitRemote) ?? inherited ?? `folder:${s.key}`;
    s.projectLabel = projectLabel(s.projectId);
  }
  return out;
}

export interface DeviceRecord {
  name: string;
  slug: string;
  pcId?: string | null;
  engine?: number;
  app?: string | null;
  claudeCode?: string | null;
  lastPushAt?: string | null;
  lastPullAt?: string | null;
  lastSeenAt?: string | null;
}

export function readDevices(repoDir: string): DeviceRecord[] {
  const dir = path.join(repoDir, "_devices");
  const out: DeviceRecord[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const d = readJson<DeviceRecord>(path.join(dir, f));
      if (d?.name) out.push({ ...d, slug: f.replace(/\.json$/, "") });
    }
  } catch {}
  return out;
}

export interface Edits {
  pinned?: boolean;
  title?: string | null;
  archived?: boolean;
  deleted?: boolean;
  /** Started or carried on in the Conversations app (shown although Claude Code ran it through the SDK). */
  app?: boolean;
}

const FIELDS = new Set(["pinned", "title", "archived", "deleted", "app"]);
const validValue = (field: string, v: unknown) => v === null || (field === "title" ? typeof v === "string" && v.length <= 500 : typeof v === "boolean");

/** Merges every PC's _state log: per conversation and field, the highest hybrid clock wins. */
export function readEdits(repoDir: string): Map<string, Edits> {
  const best = new Map<string, Record<string, { value: unknown; hlc: string }>>();
  const dir = path.join(repoDir, "_state");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {}
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let op: { session?: string; field?: string; value?: unknown; hlc?: string };
      try {
        op = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isUuid(op?.session) || !op.field || !FIELDS.has(op.field) || typeof op.hlc !== "string" || !validValue(op.field, op.value ?? null)) continue;
      const cur = best.get(op.session) ?? {};
      if (!cur[op.field] || op.hlc > cur[op.field].hlc) cur[op.field] = { value: op.value, hlc: op.hlc };
      best.set(op.session, cur);
    }
  }
  const out = new Map<string, Edits>();
  for (const [id, fields] of best) {
    const e: Edits = {};
    for (const [k, v] of Object.entries(fields)) (e as Record<string, unknown>)[k] = v.value;
    out.set(id, e);
  }
  return out;
}

// ------------------------------------------------------------ local git, no spawning

/** The git folder for a working folder (handles worktrees and submodules, whose .git is a file). */
function gitDirOf(dir: string): string | null {
  const dotgit = path.join(dir, ".git");
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    const m = fs.readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
    if (m) return path.resolve(dir, m[1].trim());
  } catch {}
  return null;
}

/** Top of the repository a folder is in, and its origin URL, by reading .git directly. */
export function gitInfo(start: string): { top: string; remote: string | null } | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    const gd = gitDirOf(dir);
    if (gd) {
      let configDir = gd;
      try {
        // Worktrees keep their config in the main repository: <gitdir>/commondir points there.
        const common = fs.readFileSync(path.join(gd, "commondir"), "utf8").trim();
        if (common) configDir = path.resolve(gd, common);
      } catch {}
      let remote: string | null = null;
      try {
        const cfg = fs.readFileSync(path.join(configDir, "config"), "utf8");
        const sec = cfg.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/);
        const url = sec?.[1].match(/^\s*url\s*=\s*(.+?)\s*$/m);
        remote = url ? url[1] : null;
      } catch {}
      return { top: dir, remote };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Version 3 project id for a local working folder (no git process). */
export function projectIdForCwd(cwd: string, home: string): { projectId: string; folderKey: string; top: string } {
  const g = gitInfo(cwd);
  const top = g?.top ?? path.resolve(cwd);
  const key = path.resolve(top).toLowerCase() === path.resolve(home).toLowerCase()
    ? "_home"
    : path.basename(top).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "_root";
  const remote = normaliseRemote(g?.remote);
  return { projectId: remote ?? `folder:${key}`, folderKey: key, top };
}

/** Claude Code's folder name for a working folder under ~/.claude/projects. */
export const encodeCwd = (cwd: string) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
